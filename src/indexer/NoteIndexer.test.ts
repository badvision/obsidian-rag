import { App, TFile } from 'obsidian';
import { NoteIndexer } from './NoteIndexer';
import { ChunkingService } from './ChunkingService';
import { EmbeddingService } from '../rag/EmbeddingService';
import { VectorStore } from '../store/VectorStore';

function makeApp(readResult = ''): App {
  return {
    vault: {
      read: jest.fn().mockResolvedValue(readResult),
      readBinary: jest.fn(),
      getFiles: jest.fn().mockReturnValue([]),
      adapter: {
        read: jest.fn(),
        write: jest.fn().mockResolvedValue(undefined),
        exists: jest.fn().mockResolvedValue(false),
        mkdir: jest.fn().mockResolvedValue(undefined),
        getBasePath: jest.fn().mockReturnValue('/vault'),
      },
      on: jest.fn(),
    },
    workspace: {
      openLinkText: jest.fn(),
      on: jest.fn(),
    },
  } as unknown as App;
}

function makeTFile(overrides: Partial<TFile> = {}): TFile {
  return {
    path: 'notes/test.md',
    name: 'test.md',
    basename: 'test',
    extension: 'md',
    stat: { mtime: 2000, size: 200, ctime: 1000 },
    ...overrides,
  } as unknown as TFile;
}

function makeVectorStore(): jest.Mocked<VectorStore> {
  return {
    getFileMtime: jest.fn().mockReturnValue(null),
    upsertFile: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    removeFile: jest.fn(),
  } as unknown as jest.Mocked<VectorStore>;
}

function makeChunkingService(): jest.Mocked<ChunkingService> {
  return {
    chunkText: jest.fn().mockImplementation((text: string) => [text]),
  } as unknown as jest.Mocked<ChunkingService>;
}

function makeEmbeddingService(): jest.Mocked<EmbeddingService> {
  return {
    embedBatch: jest.fn().mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => [0.1, 0.2]))
    ),
  } as unknown as jest.Mocked<EmbeddingService>;
}

const SETTINGS = { chunkSize: 500, chunkOverlap: 50 };

describe('NoteIndexer', () => {
  let chunkingService: jest.Mocked<ChunkingService>;
  let embeddingService: jest.Mocked<EmbeddingService>;
  let vectorStore: jest.Mocked<VectorStore>;

  beforeEach(() => {
    jest.clearAllMocks();
    chunkingService = makeChunkingService();
    embeddingService = makeEmbeddingService();
    vectorStore = makeVectorStore();
  });

  test('fingerprint match → skipped, vault.read NOT called', async () => {
    const file = makeTFile({ stat: { mtime: 2000, size: 200, ctime: 1000 } });
    const app = makeApp('some content');
    vectorStore.getFileMtime.mockReturnValue(2000);
    const indexer = new NoteIndexer(app, chunkingService, embeddingService, vectorStore);

    const result = await indexer.indexFile(file, SETTINGS);

    expect(result.skipped).toBe(true);
    expect(result.vaultPath).toBe('notes/test.md');
    expect(app.vault.read).not.toHaveBeenCalled();
  });

  test('note with frontmatter: frontmatter stripped, only body content chunked', async () => {
    const raw = '---\ntitle: Test Note\nauthor: Jane\n---\n# Heading\n\nBody content here.';
    const app = makeApp(raw);
    const file = makeTFile();
    const indexer = new NoteIndexer(app, chunkingService, embeddingService, vectorStore);

    await indexer.indexFile(file, SETTINGS);

    const chunkTextCall = chunkingService.chunkText.mock.calls[0];
    const textPassedToChunker = chunkTextCall[0] as string;
    expect(textPassedToChunker).not.toContain('title: Test Note');
    expect(textPassedToChunker).not.toContain('author: Jane');
    expect(textPassedToChunker).toContain('Body content here.');
  });

  test('note without frontmatter: full content chunked', async () => {
    const raw = '# My Note\n\nAll the content without any frontmatter block.';
    const app = makeApp(raw);
    const file = makeTFile();
    const indexer = new NoteIndexer(app, chunkingService, embeddingService, vectorStore);

    await indexer.indexFile(file, SETTINGS);

    const chunkTextCall = chunkingService.chunkText.mock.calls[0];
    const textPassedToChunker = chunkTextCall[0] as string;
    expect(textPassedToChunker).toContain('My Note');
    expect(textPassedToChunker).toContain('All the content');
  });

  test('empty note: chunkCount 0, upsertFile called with empty array', async () => {
    const app = makeApp('');
    const file = makeTFile();
    const indexer = new NoteIndexer(app, chunkingService, embeddingService, vectorStore);

    const result = await indexer.indexFile(file, SETTINGS);

    expect(result.chunkCount).toBe(0);
    expect(result.skipped).toBe(false);
    expect(vectorStore.upsertFile).toHaveBeenCalledWith(
      file.path,
      file.stat.mtime,
      []
    );
  });

  test('page=0 for note chunks: all chunks have page 0 and sourceType note', async () => {
    const app = makeApp('Some note content to chunk into pieces.');
    const file = makeTFile();
    // Return multiple chunks
    chunkingService.chunkText.mockReturnValue(['chunk one', 'chunk two']);
    const indexer = new NoteIndexer(app, chunkingService, embeddingService, vectorStore);

    await indexer.indexFile(file, SETTINGS);

    const upsertCall = vectorStore.upsertFile.mock.calls[0];
    const chunks = upsertCall[2] as Array<{ page: number; sourceType: string }>;
    expect(chunks.length).toBe(2);
    chunks.forEach(c => {
      expect(c.page).toBe(0);
      expect(c.sourceType).toBe('note');
    });
  });

  test('abort signal: signal aborted before embed step → throws', async () => {
    const app = makeApp('Note content that would normally be embedded.');
    const file = makeTFile();
    const controller = new AbortController();

    // Abort before indexFile is called
    controller.abort();

    const indexer = new NoteIndexer(app, chunkingService, embeddingService, vectorStore);

    await expect(indexer.indexFile(file, SETTINGS, controller.signal))
      .rejects.toThrow('Indexing aborted');
  });

  test('successful indexing: result has correct chunkCount and pageCount 0', async () => {
    const app = makeApp('Real note content for testing purposes here.');
    const file = makeTFile();
    chunkingService.chunkText.mockReturnValue(['chunk one', 'chunk two', 'chunk three']);
    const indexer = new NoteIndexer(app, chunkingService, embeddingService, vectorStore);

    const result = await indexer.indexFile(file, SETTINGS);

    expect(result.skipped).toBe(false);
    expect(result.chunkCount).toBe(3);
    expect(result.pageCount).toBe(0);
    expect(result.vaultPath).toBe('notes/test.md');
  });
});
