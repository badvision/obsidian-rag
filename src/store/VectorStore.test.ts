import { App } from 'obsidian';
import { VectorStore } from './VectorStore';
import { Chunk } from './types';
import { ProviderError } from '../providers/types';

// Helper to build a mock App with controllable vault adapter
function makeMockApp(overrides: Partial<{
  existsResult: boolean | Promise<boolean>;
  readResult: string | Promise<string>;
}>): App {
  const {
    existsResult = false,
    readResult = '{}',
  } = overrides;

  return {
    vault: {
      adapter: {
        exists: jest.fn().mockResolvedValue(existsResult),
        read: jest.fn().mockResolvedValue(readResult),
        write: jest.fn().mockResolvedValue(undefined),
        mkdir: jest.fn().mockResolvedValue(undefined),
        getBasePath: jest.fn().mockReturnValue('/vault'),
      },
      getFiles: jest.fn().mockReturnValue([]),
      read: jest.fn(),
      readBinary: jest.fn(),
      on: jest.fn(),
    },
    workspace: {
      openLinkText: jest.fn(),
      on: jest.fn(),
    },
  } as unknown as App;
}

function makeChunk(vaultPath: string, index: number, embedding: number[]): Chunk {
  return {
    id: `${vaultPath}::p1::c${index}`,
    text: `chunk text ${index}`,
    embedding,
    sourceType: 'pdf',
    vaultPath,
    page: 1,
    chunkIndex: index,
  };
}

const PLUGIN_DIR = '.obsidian/plugins/obsidian-rag';
const INDEX_PATH = `${PLUGIN_DIR}/index/index.json`;

describe('VectorStore', () => {

  // ---- ensureLoaded: file absent ----

  test('ensureLoaded: file absent → empty index, loaded=true', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);

    await store.ensureLoaded('nomic-embed-text');

    const stats = store.getStats();
    expect(stats.fileCount).toBe(0);
    expect(stats.chunkCount).toBe(0);
    expect(stats.embeddingModel).toBe('nomic-embed-text');
    expect(app.vault.adapter.read).not.toHaveBeenCalled();
  });

  test('ensureLoaded: already loaded → adapter.read NOT called second time', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);

    await store.ensureLoaded('nomic-embed-text');
    await store.ensureLoaded('nomic-embed-text');

    expect(app.vault.adapter.exists).toHaveBeenCalledTimes(1);
  });

  // ---- ensureLoaded: valid index.json ----

  test('ensureLoaded: valid index.json with correct model → data loaded', async () => {
    const validIndex = JSON.stringify({
      schemaVersion: 1,
      embeddingModel: 'nomic-embed-text',
      embeddingDimension: 768,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      files: {
        'papers/foo.pdf': {
          vaultPath: 'papers/foo.pdf',
          mtime: 12345,
          chunkIds: ['papers/foo.pdf::p1::c0'],
        },
      },
      chunks: [
        {
          id: 'papers/foo.pdf::p1::c0',
          text: 'some chunk',
          embedding: [0.1, 0.2],
          sourceType: 'pdf',
          vaultPath: 'papers/foo.pdf',
          page: 1,
          chunkIndex: 0,
        },
      ],
    });

    const app = makeMockApp({ existsResult: true, readResult: validIndex });
    const store = new VectorStore(PLUGIN_DIR, app);

    await store.ensureLoaded('nomic-embed-text');

    const stats = store.getStats();
    expect(stats.fileCount).toBe(1);
    expect(stats.chunkCount).toBe(1);
    expect(stats.embeddingModel).toBe('nomic-embed-text');
    expect(app.vault.adapter.read).toHaveBeenCalledWith(INDEX_PATH);
  });

  // ---- ensureLoaded: wrong schemaVersion ----

  test('ensureLoaded: wrong schemaVersion → empty index, console.warn called', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const badSchema = JSON.stringify({
      schemaVersion: 99,
      embeddingModel: 'nomic-embed-text',
      embeddingDimension: 768,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      files: {},
      chunks: [],
    });

    const app = makeMockApp({ existsResult: true, readResult: badSchema });
    const store = new VectorStore(PLUGIN_DIR, app);

    await store.ensureLoaded('nomic-embed-text');

    const stats = store.getStats();
    expect(stats.chunkCount).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('schema version'));

    warnSpy.mockRestore();
  });

  // ---- ensureLoaded: embedding model mismatch ----

  test('ensureLoaded: model mismatch → throws ProviderError DIMENSION_MISMATCH', async () => {
    const indexWithOtherModel = JSON.stringify({
      schemaVersion: 1,
      embeddingModel: 'nomic-embed-text',
      embeddingDimension: 768,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      files: {},
      chunks: [],
    });

    const app = makeMockApp({ existsResult: true, readResult: indexWithOtherModel });
    const store = new VectorStore(PLUGIN_DIR, app);

    await expect(store.ensureLoaded('mxbai-embed-large')).rejects.toThrow(ProviderError);
    await expect(
      new VectorStore(PLUGIN_DIR, app).ensureLoaded('mxbai-embed-large')
    ).rejects.toMatchObject({ code: 'DIMENSION_MISMATCH' });
  });

  // ---- upsertFile ----

  test('upsertFile: inserts chunks and updates files record', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    const chunk1 = makeChunk('papers/foo.pdf', 0, [1, 0]);
    const chunk2 = makeChunk('papers/foo.pdf', 1, [0, 1]);

    store.upsertFile('papers/foo.pdf', 12345, [chunk1, chunk2]);

    const stats = store.getStats();
    expect(stats.chunkCount).toBe(2);
    expect(store.getFileMtime('papers/foo.pdf')).toBe(12345);
  });

  test('upsertFile: second call for same path removes old chunks, inserts new', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    const chunk1 = makeChunk('papers/foo.pdf', 0, [1, 0]);
    const chunk2 = makeChunk('papers/foo.pdf', 1, [0, 1]);
    const chunk3 = makeChunk('papers/foo.pdf', 2, [0.5, 0.5]);

    store.upsertFile('papers/foo.pdf', 12345, [chunk1]);
    store.upsertFile('papers/foo.pdf', 99999, [chunk2, chunk3]);

    const stats = store.getStats();
    expect(stats.chunkCount).toBe(2);
    expect(store.getFileMtime('papers/foo.pdf')).toBe(99999);
  });

  // ---- removeFile ----

  test('removeFile: removes chunks and files record', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    const chunk1 = makeChunk('papers/foo.pdf', 0, [1, 0]);
    store.upsertFile('papers/foo.pdf', 12345, [chunk1]);

    store.removeFile('papers/foo.pdf');

    const stats = store.getStats();
    expect(stats.chunkCount).toBe(0);
    expect(store.getFileMtime('papers/foo.pdf')).toBeNull();
  });

  // ---- getFileMtime ----

  test('getFileMtime: returns mtime for indexed file, null for non-indexed', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    const chunk1 = makeChunk('papers/foo.pdf', 0, [1, 0]);
    store.upsertFile('papers/foo.pdf', 12345, [chunk1]);

    expect(store.getFileMtime('papers/foo.pdf')).toBe(12345);
    expect(store.getFileMtime('nonexistent.pdf')).toBeNull();
  });

  // ---- query ----

  test('query: returns top-K by cosine similarity sorted descending', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    // Three chunks with known embeddings
    const chunkA = makeChunk('test.pdf', 0, [1, 0]);         // identical to query
    const chunkB = makeChunk('test.pdf', 1, [0, 1]);         // orthogonal to query
    const chunkC = makeChunk('test.pdf', 2, [0.707, 0.707]); // 45 degrees from query

    store.upsertFile('test.pdf', 100, [chunkA, chunkB, chunkC]);

    const results = store.query([1, 0], 2);

    expect(results).toHaveLength(2);
    // First result: chunkA (identical direction) → score ≈ 1.0
    expect(results[0].chunk.id).toBe(chunkA.id);
    expect(results[0].score).toBeCloseTo(1.0, 5);
    // Second result: chunkC (45 degrees) → score ≈ 0.707
    expect(results[1].chunk.id).toBe(chunkC.id);
    expect(results[1].score).toBeCloseTo(0.707, 2);
    // chunkB excluded from top-2
    const ids = results.map(r => r.chunk.id);
    expect(ids).not.toContain(chunkB.id);
  });

  test('query: empty store → returns []', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    const results = store.query([1, 0], 5);
    expect(results).toEqual([]);
  });

  test('query: cosine similarity — identical vectors → score ~1.0', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    store.upsertFile('test.pdf', 1, [makeChunk('test.pdf', 0, [0.5, 0.5])]);
    const results = store.query([0.5, 0.5], 1);
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });

  test('query: cosine similarity — orthogonal vectors → score ~0.0', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    store.upsertFile('test.pdf', 1, [makeChunk('test.pdf', 0, [0, 1])]);
    const results = store.query([1, 0], 1);
    expect(results[0].score).toBeCloseTo(0.0, 5);
  });

  test('query: cosine similarity — zero vector → score 0.0 (no crash)', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    store.upsertFile('test.pdf', 1, [makeChunk('test.pdf', 0, [0, 0])]);
    const results = store.query([1, 0], 1);
    expect(results[0].score).toBe(0);
  });

  // ---- save ----

  test('save: adapter.write called with correct path and valid JSON', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    store.upsertFile('papers/foo.pdf', 12345, [makeChunk('papers/foo.pdf', 0, [1, 0])]);
    await store.save();

    expect(app.vault.adapter.write).toHaveBeenCalledWith(
      INDEX_PATH,
      expect.stringContaining('chunks')
    );

    // Also verify the written JSON is valid
    const writeCall = (app.vault.adapter.write as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(writeCall[1]);
    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.schemaVersion).toBe(1);
  });

  // ---- clear ----

  test('clear: resets data to empty and calls save', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    store.upsertFile('papers/foo.pdf', 12345, [makeChunk('papers/foo.pdf', 0, [1, 0])]);
    await store.clear('nomic-embed-text');

    const stats = store.getStats();
    expect(stats.chunkCount).toBe(0);
    expect(stats.fileCount).toBe(0);
    // save was called (write was invoked)
    expect(app.vault.adapter.write).toHaveBeenCalled();
  });

  // ---- exists ----

  test('exists: delegates to adapter.exists', async () => {
    const app = makeMockApp({ existsResult: true });
    const store = new VectorStore(PLUGIN_DIR, app);

    const result = await store.exists();

    expect(result).toBe(true);
    expect(app.vault.adapter.exists).toHaveBeenCalledWith(INDEX_PATH);
  });

  test('exists: returns false when adapter.exists returns false', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);

    const result = await store.exists();

    expect(result).toBe(false);
  });

  // ---- getStats ----

  test('getStats: returns correct counts after operations', async () => {
    const app = makeMockApp({ existsResult: false });
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded('nomic-embed-text');

    store.upsertFile('a.pdf', 1, [makeChunk('a.pdf', 0, [1, 0])]);
    store.upsertFile('b.pdf', 2, [makeChunk('b.pdf', 0, [0, 1]), makeChunk('b.pdf', 1, [0.5, 0.5])]);

    const stats = store.getStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.chunkCount).toBe(3);
    expect(stats.embeddingModel).toBe('nomic-embed-text');
    expect(typeof stats.updatedAt).toBe('string');
  });
});
