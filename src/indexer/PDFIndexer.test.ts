import { App, TFile, loadPdfJs } from 'obsidian';
import { PDFIndexer } from './PDFIndexer';
import { ChunkingService } from './ChunkingService';
import { EmbeddingService } from '../rag/EmbeddingService';
import { VectorStore } from '../store/VectorStore';

jest.mock('obsidian', () => ({
  ...jest.requireActual('../__mocks__/obsidian'),
  loadPdfJs: jest.fn(),
}));

const mockLoadPdfJs = loadPdfJs as jest.MockedFunction<typeof loadPdfJs>;

function makeApp(readBinaryResult: ArrayBuffer = new ArrayBuffer(0)): App {
  return {
    vault: {
      readBinary: jest.fn().mockResolvedValue(readBinaryResult),
      read: jest.fn(),
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
    path: 'papers/test.pdf',
    name: 'test.pdf',
    basename: 'test',
    extension: 'pdf',
    stat: { mtime: 1000, size: 100, ctime: 500 },
    ...overrides,
  } as unknown as TFile;
}

function makePdfJsLib(pages: Array<{ items: Array<{ str: string } | Record<string, never>> }>) {
  return {
    getDocument: jest.fn().mockReturnValue({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: jest.fn().mockImplementation((pageNum: number) => {
          const pageData = pages[pageNum - 1];
          return Promise.resolve({
            getTextContent: jest.fn().mockResolvedValue({
              items: pageData.items,
            }),
          });
        }),
      }),
    }),
  };
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

describe('PDFIndexer', () => {
  let app: App;
  let chunkingService: jest.Mocked<ChunkingService>;
  let embeddingService: jest.Mocked<EmbeddingService>;
  let vectorStore: jest.Mocked<VectorStore>;
  let indexer: PDFIndexer;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
    chunkingService = makeChunkingService();
    embeddingService = makeEmbeddingService();
    vectorStore = makeVectorStore();
    indexer = new PDFIndexer(app, chunkingService, embeddingService, vectorStore);
  });

  test('fingerprint match → skipped, loadPdfJs NOT called', async () => {
    const file = makeTFile({ stat: { mtime: 1000, size: 100, ctime: 500 } });
    vectorStore.getFileMtime.mockReturnValue(1000);

    const result = await indexer.indexFile(file, SETTINGS);

    expect(result.skipped).toBe(true);
    expect(result.vaultPath).toBe('papers/test.pdf');
    expect(result.chunkCount).toBe(0);
    expect(result.pageCount).toBe(0);
    expect(mockLoadPdfJs).not.toHaveBeenCalled();
  });

  test('new file → indexed: chunkText, embedBatch, and upsertFile called correctly', async () => {
    const file = makeTFile();
    vectorStore.getFileMtime.mockReturnValue(null);

    const pdfLib = makePdfJsLib([
      { items: [{ str: 'Hello world from page one.' }] },
      { items: [{ str: 'Second page content here.' }] },
    ]);
    mockLoadPdfJs.mockResolvedValue(pdfLib);

    const result = await indexer.indexFile(file, SETTINGS);

    expect(result.skipped).toBe(false);
    expect(result.pageCount).toBe(2);
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(chunkingService.chunkText).toHaveBeenCalledTimes(2);
    expect(embeddingService.embedBatch).toHaveBeenCalledTimes(1);
    expect(vectorStore.upsertFile).toHaveBeenCalledWith(
      file.path,
      file.stat.mtime,
      expect.any(Array)
    );
  });

  test('scanned PDF detection: >30% empty pages → warningScannedPdf true', async () => {
    const file = makeTFile();
    vectorStore.getFileMtime.mockReturnValue(null);

    // 4 pages: 3 with very short text (<10 chars), 1 with real text
    const pdfLib = makePdfJsLib([
      { items: [{ str: 'Hi' }] },        // short, < 10 chars
      { items: [{ str: 'Ok' }] },        // short, < 10 chars
      { items: [{ str: 'Y' }] },         // short, < 10 chars
      { items: [{ str: 'This is a full page of meaningful text content here.' }] },
    ]);
    mockLoadPdfJs.mockResolvedValue(pdfLib);

    const result = await indexer.indexFile(file, SETTINGS);

    expect(result.warningScannedPdf).toBe(true);
  });

  test('no scanned PDF warning when ≤30% empty pages', async () => {
    const file = makeTFile();
    vectorStore.getFileMtime.mockReturnValue(null);

    // 4 pages: 1 empty, 3 with real content → 25% empty → no warning
    const pdfLib = makePdfJsLib([
      { items: [{ str: 'Hi' }] },
      { items: [{ str: 'Real content on page two for testing.' }] },
      { items: [{ str: 'Real content on page three for testing.' }] },
      { items: [{ str: 'Real content on page four for testing.' }] },
    ]);
    mockLoadPdfJs.mockResolvedValue(pdfLib);

    const result = await indexer.indexFile(file, SETTINGS);

    expect(result.warningScannedPdf).toBe(false);
  });

  test('abort signal: aborted before first page → throws aborted error', async () => {
    const file = makeTFile();
    vectorStore.getFileMtime.mockReturnValue(null);

    const pdfLib = makePdfJsLib([
      { items: [{ str: 'Some content on page one.' }] },
      { items: [{ str: 'Some content on page two.' }] },
    ]);
    mockLoadPdfJs.mockResolvedValue(pdfLib);

    const controller = new AbortController();
    controller.abort();

    await expect(indexer.indexFile(file, SETTINGS, undefined, controller.signal))
      .rejects.toThrow('Indexing aborted');
  });

  test('page text assembly: items without str property are excluded', async () => {
    const file = makeTFile();
    vectorStore.getFileMtime.mockReturnValue(null);

    // Mix of items with and without 'str'
    const pdfLib = makePdfJsLib([
      { items: [{ str: 'Valid text ' }, {}, { str: 'more text' }] },
    ]);
    mockLoadPdfJs.mockResolvedValue(pdfLib);

    await indexer.indexFile(file, SETTINGS);

    const chunkTextCall = chunkingService.chunkText.mock.calls[0];
    expect(chunkTextCall[0]).toContain('Valid text');
    expect(chunkTextCall[0]).toContain('more text');
  });

  test('page numbering is 1-based: first page chunk has page: 1', async () => {
    const file = makeTFile();
    vectorStore.getFileMtime.mockReturnValue(null);

    const pdfLib = makePdfJsLib([
      { items: [{ str: 'Page one content here for testing.' }] },
    ]);
    mockLoadPdfJs.mockResolvedValue(pdfLib);

    await indexer.indexFile(file, SETTINGS);

    const upsertCall = vectorStore.upsertFile.mock.calls[0];
    const chunks = upsertCall[2] as Array<{ page: number }>;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].page).toBe(1);
  });

  test('empty pages skipped: page with empty text produces 0 chunks', async () => {
    const file = makeTFile();
    vectorStore.getFileMtime.mockReturnValue(null);

    // Page 1 empty, page 2 has real content
    const pdfLib = makePdfJsLib([
      { items: [] },
      { items: [{ str: 'Real content on the second page here.' }] },
    ]);
    mockLoadPdfJs.mockResolvedValue(pdfLib);

    await indexer.indexFile(file, SETTINGS);

    // chunkText only called once (for the non-empty page)
    expect(chunkingService.chunkText).toHaveBeenCalledTimes(1);

    const upsertCall = vectorStore.upsertFile.mock.calls[0];
    const chunks = upsertCall[2] as Array<{ page: number }>;
    // All chunks belong to page 2
    chunks.forEach(c => expect(c.page).toBe(2));
  });
});
