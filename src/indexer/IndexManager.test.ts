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
    prepareForIndexing: jest.fn().mockResolvedValue(undefined),
    finishIndexing: jest.fn().mockResolvedValue(undefined),
    getFileMtime: jest.fn().mockReturnValue(null),
    upsertFile: jest.fn().mockResolvedValue(undefined),
    removeFile: jest.fn().mockResolvedValue(undefined),
    getIndexedPaths: jest.fn().mockReturnValue([]),
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

  test('indexAll: one atomic publication per run (prepare + finish exactly once, no per-file saves)', async () => {
    const files = Array.from({ length: 11 }, (_, i) => makeTFile(`file${i}.pdf`, 'pdf'));
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    await indexManager.indexAll(makeSettings());

    expect(vectorStore.prepareForIndexing).toHaveBeenCalledTimes(1);
    expect(vectorStore.prepareForIndexing).toHaveBeenCalledWith(makeSettings().embeddingModel);
    expect(vectorStore.finishIndexing).toHaveBeenCalledTimes(1);
  });

  test('indexAll: sweeps stale entries whose source file is gone from the vault', async () => {
    const files = [makeTFile('kept.pdf', 'pdf')];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);
    vectorStore.getIndexedPaths.mockReturnValue(['kept.pdf', 'gone.pdf', 'renamed-away.md']);

    await indexManager.indexAll(makeSettings());

    expect(vectorStore.removeFile).toHaveBeenCalledTimes(2);
    expect(vectorStore.removeFile).toHaveBeenCalledWith('gone.pdf');
    expect(vectorStore.removeFile).toHaveBeenCalledWith('renamed-away.md');
    expect(vectorStore.removeFile).not.toHaveBeenCalledWith('kept.pdf');
  });

  test('indexAll: stale sweep respects files present in the vault regardless of scope', async () => {
    const files = [makeTFile('a.pdf', 'pdf'), makeTFile('notes/alive.md', 'md')];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);
    // an md entry whose note still exists must NOT be swept in pdfs-only scope
    vectorStore.getIndexedPaths.mockReturnValue(['notes/alive.md']);

    const result = await indexManager.indexAll(makeSettings({ indexScope: 'pdfs-only' }));

    expect(result.indexed).toBe(1);
    expect(vectorStore.removeFile).not.toHaveBeenCalledWith('notes/alive.md');
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
    expect(vectorStore.finishIndexing).toHaveBeenCalledTimes(1); // partial work still published
  });

  test('indexAll: abort before first file → returns 0 indexed/skipped/failed and still publishes', async () => {
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
    expect(vectorStore.finishIndexing).toHaveBeenCalledTimes(1); // DB left in a published state
  });

  test('indexAll: abort mid-run stops at the file boundary and publishes completed files', async () => {
    const files = [
      makeTFile('a.pdf', 'pdf'),
      makeTFile('b.pdf', 'pdf'),
    ];
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    const controller = new AbortController();
    mockPdfIndexer.indexFile
      .mockResolvedValueOnce(makeIndexFileResult({ vaultPath: 'a.pdf' }))
      .mockImplementationOnce(async (_file: unknown, _settings: unknown, _progress: unknown, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error('Indexing aborted');
        controller.abort(); // simulate cancel arriving during the second file
        if (signal?.aborted) throw new Error('Indexing aborted');
        return makeIndexFileResult({ vaultPath: 'b.pdf' });
      });

    const result = await indexManager.indexAll(makeSettings(), undefined, controller.signal);

    expect(result.indexed).toBe(1); // only file a completed
    expect(vectorStore.finishIndexing).toHaveBeenCalledTimes(1);
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

  test('indexCurrentFile: indexes a pdf file with one prepare/finish run', async () => {
    const file = makeTFile('single.pdf', 'pdf');

    const result = await indexManager.indexCurrentFile(file, makeSettings());

    expect(mockPdfIndexer.indexFile).toHaveBeenCalledWith(file, makeSettings());
    expect(vectorStore.prepareForIndexing).toHaveBeenCalledTimes(1);
    expect(vectorStore.finishIndexing).toHaveBeenCalledTimes(1);
    expect(result.indexed).toBe(1);
  });

  test('indexCurrentFile: indexes an md file with one prepare/finish run', async () => {
    const file = makeTFile('single.md', 'md');
    mockNoteIndexer.indexFile.mockResolvedValue(
      makeIndexFileResult({ vaultPath: 'single.md', pageCount: 0 })
    );

    const result = await indexManager.indexCurrentFile(file, makeSettings());

    expect(mockNoteIndexer.indexFile).toHaveBeenCalledWith(file, makeSettings());
    expect(vectorStore.finishIndexing).toHaveBeenCalledTimes(1);
    expect(result.indexed).toBe(1);
  });

  test('indexCurrentFile: error → failed=1 and the run is still closed (finishIndexing)', async () => {
    const file = makeTFile('bad.pdf', 'pdf');
    mockPdfIndexer.indexFile.mockRejectedValue(new Error('Read error'));

    const result = await indexManager.indexCurrentFile(file, makeSettings());

    expect(result.failed).toBe(1);
    expect(vectorStore.finishIndexing).toHaveBeenCalledTimes(1);
  });

  // ---- removeFile ----

  test('removeFile: delegates to the store (store owns the disk-backed publish)', async () => {
    await indexManager.removeFile('papers/foo.pdf');

    expect(vectorStore.removeFile).toHaveBeenCalledWith('papers/foo.pdf');
  });
});
