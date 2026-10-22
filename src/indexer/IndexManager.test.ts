import { App, TFile } from 'obsidian';
import { IndexManager } from './IndexManager';
import { ChunkingService } from './ChunkingService';
import { EmbeddingService } from '../rag/EmbeddingService';
import { VectorStore } from '../store/VectorStore';
import { PDFIndexer } from './PDFIndexer';
import { NoteIndexer } from './NoteIndexer';
import { IndexFileResult } from './types';
import { RagPluginSettings, DEFAULT_SETTINGS } from '../settings';

function makeApp(files: TFile[] = []): App {
  return {
    vault: {
      getFiles: jest.fn().mockReturnValue(files),
      read: jest.fn(),
      readBinary: jest.fn(),
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

function makeTFile(path: string, extension: string, mtime = 1000): TFile {
  return {
    path,
    name: path.split('/').pop() ?? path,
    basename: (path.split('/').pop() ?? path).replace(`.${extension}`, ''),
    extension,
    stat: { mtime, size: 100, ctime: 500 },
  } as unknown as TFile;
}

function makeSettings(overrides: Partial<RagPluginSettings> = {}): RagPluginSettings {
  return { ...DEFAULT_SETTINGS, topK: 5, ...overrides };
}

function makeVectorStore(): jest.Mocked<VectorStore> {
  return {
    ensureLoaded: jest.fn().mockResolvedValue(undefined),
    getFileMtime: jest.fn().mockReturnValue(null),
    upsertFile: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    removeFile: jest.fn(),
  } as unknown as jest.Mocked<VectorStore>;
}

function makeIndexFileResult(overrides: Partial<IndexFileResult> = {}): IndexFileResult {
  return {
    vaultPath: 'test.pdf',
    skipped: false,
    chunkCount: 3,
    pageCount: 2,
    ...overrides,
  };
}

describe('IndexManager', () => {
  let app: App;
  let vectorStore: jest.Mocked<VectorStore>;
  let mockPdfIndexer: jest.Mocked<PDFIndexer>;
  let mockNoteIndexer: jest.Mocked<NoteIndexer>;
  let indexManager: IndexManager;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
    vectorStore = makeVectorStore();

    mockPdfIndexer = {
      indexFile: jest.fn().mockResolvedValue(makeIndexFileResult()),
    } as unknown as jest.Mocked<PDFIndexer>;

    mockNoteIndexer = {
      indexFile: jest.fn().mockResolvedValue(makeIndexFileResult({ pageCount: 0, vaultPath: 'test.md' })),
    } as unknown as jest.Mocked<NoteIndexer>;

    const chunkingService = {} as ChunkingService;
    const embeddingService = {} as EmbeddingService;

    indexManager = new IndexManager(
      app,
      chunkingService,
      embeddingService,
      vectorStore,
      mockPdfIndexer,
      mockNoteIndexer
    );
  });

  // ---- getFilesToIndex ----

  test('getFilesToIndex pdfs-only: returns only pdf files', () => {
    const files = [
      makeTFile('foo.pdf', 'pdf'),
      makeTFile('bar.md', 'md'),
      makeTFile('baz.pdf', 'pdf'),
    ];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    const result = indexManager.getFilesToIndex('pdfs-only');

    expect(result).toHaveLength(2);
    expect(result.every((f: TFile) => f.extension === 'pdf')).toBe(true);
  });

  test('getFilesToIndex pdfs-and-notes: returns pdf and md files', () => {
    const files = [
      makeTFile('foo.pdf', 'pdf'),
      makeTFile('bar.md', 'md'),
      makeTFile('baz.pdf', 'pdf'),
    ];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    const result = indexManager.getFilesToIndex('pdfs-and-notes');

    expect(result).toHaveLength(3);
  });

  // ---- indexAll ----

  test('indexAll: progress callback called for each file', async () => {
    const files = [
      makeTFile('a.pdf', 'pdf'),
      makeTFile('b.md', 'md'),
    ];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);
    const onProgress = jest.fn();

    await indexManager.indexAll(makeSettings(), onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, 'a.pdf');
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, 'b.md');
  });

  test('indexAll: save called at every 10th file and once at end', async () => {
    // Create 11 files: save should be called after file 10 and at the end
    const files = Array.from({ length: 11 }, (_, i) =>
      makeTFile(`file${i}.pdf`, 'pdf')
    );
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    await indexManager.indexAll(makeSettings());

    // save called at least twice: once at file 10, once at end
    expect(vectorStore.save).toHaveBeenCalledTimes(2);
  });

  test('indexAll: per-file error → failed++ and continues to next file', async () => {
    const files = [
      makeTFile('error.pdf', 'pdf'),
      makeTFile('success.pdf', 'pdf'),
    ];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    mockPdfIndexer.indexFile
      .mockRejectedValueOnce(new Error('Read failed'))
      .mockResolvedValueOnce(makeIndexFileResult({ vaultPath: 'success.pdf' }));

    const result = await indexManager.indexAll(makeSettings());

    expect(result.failed).toBe(1);
    expect(result.indexed).toBe(1);
  });

  test('indexAll: abort before first file → returns 0 indexed/skipped/failed', async () => {
    const files = [
      makeTFile('a.pdf', 'pdf'),
      makeTFile('b.pdf', 'pdf'),
    ];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    const controller = new AbortController();
    controller.abort();

    const result = await indexManager.indexAll(makeSettings(), undefined, controller.signal);

    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  test('indexAll: skipped file increments skipped count', async () => {
    const files = [makeTFile('cached.pdf', 'pdf')];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    mockPdfIndexer.indexFile.mockResolvedValue(
      makeIndexFileResult({ skipped: true, chunkCount: 0, pageCount: 0 })
    );

    const result = await indexManager.indexAll(makeSettings());

    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(0);
  });

  test('indexAll: warningScannedPdf → warning added to result.warnings', async () => {
    const files = [makeTFile('scanned.pdf', 'pdf')];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    mockPdfIndexer.indexFile.mockResolvedValue(
      makeIndexFileResult({ vaultPath: 'scanned.pdf', warningScannedPdf: true })
    );

    const result = await indexManager.indexAll(makeSettings());

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('scanned.pdf');
  });

  test('indexAll: routes pdf files to pdfIndexer and md files to noteIndexer', async () => {
    const files = [
      makeTFile('doc.pdf', 'pdf'),
      makeTFile('note.md', 'md'),
    ];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    await indexManager.indexAll(makeSettings());

    expect(mockPdfIndexer.indexFile).toHaveBeenCalledTimes(1);
    expect(mockNoteIndexer.indexFile).toHaveBeenCalledTimes(1);
  });

  // ---- indexCurrentFile ----

  test('indexCurrentFile: indexes a pdf file and saves', async () => {
    const file = makeTFile('single.pdf', 'pdf');

    const result = await indexManager.indexCurrentFile(file, makeSettings());

    expect(mockPdfIndexer.indexFile).toHaveBeenCalledWith(file, makeSettings());
    expect(vectorStore.save).toHaveBeenCalledTimes(1);
    expect(result.indexed).toBe(1);
  });

  test('indexCurrentFile: indexes an md file and saves', async () => {
    const file = makeTFile('single.md', 'md');
    mockNoteIndexer.indexFile.mockResolvedValue(
      makeIndexFileResult({ vaultPath: 'single.md', pageCount: 0 })
    );

    const result = await indexManager.indexCurrentFile(file, makeSettings());

    expect(mockNoteIndexer.indexFile).toHaveBeenCalledWith(file, makeSettings());
    expect(vectorStore.save).toHaveBeenCalledTimes(1);
    expect(result.indexed).toBe(1);
  });

  test('indexCurrentFile: error → failed=1 and still saves', async () => {
    const file = makeTFile('bad.pdf', 'pdf');
    mockPdfIndexer.indexFile.mockRejectedValue(new Error('Read error'));

    const result = await indexManager.indexCurrentFile(file, makeSettings());

    expect(result.failed).toBe(1);
    expect(vectorStore.save).toHaveBeenCalled();
  });

  // ---- removeFile ----

  test('removeFile: delegates to vectorStore.removeFile and calls save', async () => {
    await indexManager.removeFile('papers/foo.pdf');

    expect(vectorStore.removeFile).toHaveBeenCalledWith('papers/foo.pdf');
    expect(vectorStore.save).toHaveBeenCalledTimes(1);
  });
});
