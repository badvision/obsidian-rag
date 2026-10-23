import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { App } from 'obsidian';
import { decodeGeneric } from '@blackwell-systems/gcf';
import { VectorStore } from './VectorStore';
import { Chunk } from './types';
import { ProviderError } from '../providers/types';
import { encodeVector, decodeVector } from './vectorCodec';

// ── Real temp-filesystem vault adapter ─────────────────────────────────────
//
// The streaming publication/scan paths resolve physical file paths via the
// adapter's getBasePath, so the suite runs against a real directory on disk
// (not an in-memory map): it exercises the actual streaming behavior.

type VaultAdapter = ReturnType<typeof makeAdapter>;

function makeAdapter(root: string, spyReads = false) {
  const readImpl = async (p: string) => fsp.readFile(path.join(root, p), 'utf8');
  return {
    root,
    read: spyReads ? jest.fn(readImpl) : readImpl,
    write: async (p: string, d: string) => fsp.writeFile(path.join(root, p), d, 'utf8'),
    append: async (p: string, d: string) => fsp.appendFile(path.join(root, p), d, 'utf8'),
    remove: async (p: string) => fsp.unlink(path.join(root, p)),
    // Emulates Obsidian's FileSystemAdapter.rename, which refuses to overwrite
    // an existing destination ("Destination file already exists!"). The
    // publication path must swap through physical paths, never adapter.rename.
    rename: async (p: string, np: string) => {
      const dst = path.join(root, np);
      await fsp.access(dst).then(
        () => { throw new Error('Destination file already exists!'); },
        () => undefined
      );
      await fsp.rename(path.join(root, p), dst);
    },
    exists: async (p: string) => fsp.access(path.join(root, p)).then(() => true, () => false),
    getBasePath: () => root,
    mkdir: async (p: string) => fsp.mkdir(path.join(root, p), { recursive: true }),
  };
}

function makeApp(root: string, spyReads = false): App {
  return {
    vault: {
      adapter: makeAdapter(root, spyReads),
      getFiles: () => [],
      read: async () => '',
      readBinary: async () => new ArrayBuffer(0),
      on: () => {},
    },
    workspace: { openLinkText: async () => {}, on: () => {} },
  } as unknown as App;
}

function makeChunk(vaultPath: string, index: number, embedding: number[], text?: string): Chunk {
  return {
    id: `${vaultPath}::p1::c${index}`,
    text: text ?? `chunk text ${index}`,
    embedding,
    sourceType: 'pdf',
    vaultPath,
    page: 1,
    chunkIndex: index,
  };
}

const PLUGIN_DIR = '.obsidian/plugins/obsidian-rag';
const GCF_PATH = `${PLUGIN_DIR}/index/index.gcf`;
const STAGING_PATH = `${PLUGIN_DIR}/index/.staging.gcf`;
const MODEL = 'nomic-embed-text';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rag-store-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const readVault = (p: string) => fsp.readFile(path.join(root, p), 'utf8');
const existsVault = (p: string) => fsp.access(path.join(root, p)).then(() => true, () => false);


// Index files into a fresh store through one full prepare/upsert/finish run.
async function indexFiles(
  entries: Array<{ path: string; mtime: number; chunks: Chunk[] }>,
  spyReads = false
): Promise<{ store: VectorStore; app: App }> {
  const app = makeApp(root, spyReads);
  const store = new VectorStore(PLUGIN_DIR, app);
  await store.prepareForIndexing(MODEL);
  for (const e of entries) await store.upsertFile(e.path, e.mtime, e.chunks);
  await store.finishIndexing();
  return { store, app };
}

describe('vector codec (f64le-deflate-base64)', () => {
  test('roundtrips every double bit-exactly, including -0, denormals, extremes, 0.1', () => {
    const values = [
      -0, 0, 0.1, -0.1, 1e-300, 1.7976931348623157e308, -1.7976931348623157e308,
      2.2250738585072014e-308, 5e-324, Number.EPSILON, 123456789.123456789,
      2 ** 53 + 1, -(2 ** 53) - 1, 1 / 3, Math.PI, 0.30000000000000004,
    ];
    const decoded = decodeVector(encodeVector(values));
    values.forEach((v, i) => expect(Object.is(decoded[i], v)).toBe(true));
    expect(decoded.length).toBe(values.length);
  });

  test('no f32 cast/rounding: a non-f32 double survives the roundtrip', () => {
    const v = 1.0000000000000002; // not representable in f32
    const decoded = decodeVector(encodeVector([v]));
    expect(Object.is(decoded[0], v)).toBe(true);
  });

  test('empty vector encodes to empty cell and decodes to zero-length', () => {
    expect(encodeVector([])).toBe('');
    expect(decodeVector('').length).toBe(0);
  });

  test('base64 cell contains no GCF special characters (stays unquoted on the wire)', () => {
    for (let i = 0; i < 200; i++) {
      const vec = Array.from({ length: 768 }, () => Math.sin(i * 0.001 + 7) * 1.37);
      const cell = encodeVector(vec);
      expect(cell).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(cell).not.toMatch(/[|"\n]/);
    }
  });
});

describe('VectorStore', () => {
  test('ensureLoaded: no index → empty state, model adopted, nothing read', async () => {
    const app = makeApp(root, true);
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded(MODEL);
    expect(store.isLoaded()).toBe(true);
    expect(store.getStats().fileCount).toBe(0);
    expect(store.getStats().embeddingModel).toBe(MODEL);
    expect(store.query([1, 0], 5)).toEqual([]);
  });

  test('ensureLoaded: already loaded → no re-read', async () => {
    const { app } = await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }], true);
    const adapter = app.vault.adapter as unknown as VaultAdapter;
    const readsAfterIndex = (adapter.read as jest.Mock).mock.calls.length;

    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded(MODEL);
    const readsAfterFirst = (adapter.read as jest.Mock).mock.calls.length;
    expect(readsAfterFirst).toBe(readsAfterIndex + 1);
    await store.ensureLoaded(MODEL);
    expect((adapter.read as jest.Mock).mock.calls.length).toBe(readsAfterFirst);
  });

  test('full index persists to .gcf, staging and tmp are cleaned up', async () => {
    await indexFiles([
      { path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0]), makeChunk('a.pdf', 1, [0, 1])] },
      { path: 'b.md', mtime: 2, chunks: [makeChunk('b.md', 0, [1, 1])] },
    ]);
    const doc = await readVault(GCF_PATH);
    expect(doc.startsWith('GCF profile=generic\n')).toBe(true);
    expect(doc).toContain('## files [?]{vaultPath,mtime,chunkCount}');
    expect(doc).toContain('## chunks [?]{id,vaultPath,page,chunkIndex,sourceType,text,embedding}');
    expect(doc).toContain('##! summary counts=2,3');
    expect(await existsVault(`${GCF_PATH}.tmp`)).toBe(false);
    expect(await existsVault(STAGING_PATH)).toBe(false);
  });

  test('no JSON persistence: document is GCF generic profile, not a JSON document', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const doc = await readVault(GCF_PATH);
    expect(doc.startsWith('GCF profile=generic\n')).toBe(true);
    expect(doc).not.toContain('"embedding"');
    expect(doc).not.toContain('"chunks"');
    expect(doc.endsWith('\n')).toBe(true);
  });

  test('query after restart (fresh store, same disk) returns bit-exact vectors and correct scores', async () => {
    await indexFiles([
      { path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] },
      { path: 'b.pdf', mtime: 2, chunks: [makeChunk('b.pdf', 0, [0, 1])] },
    ]);
    const reloaded = new VectorStore(PLUGIN_DIR, makeApp(root));
    await reloaded.ensureLoaded(MODEL);
    const results = reloaded.query([1, 0], 2);
    expect(results.map(r => r.chunk.vaultPath)).toEqual(['a.pdf', 'b.pdf']);
    expect(results[0].score).toBeCloseTo(1.0, 10);
    expect(Object.is(results[0].chunk.embedding[0], 1)).toBe(true);
  });

  test('precision: non-f32 doubles and -0 survive a full index/reload cycle bit-exactly', async () => {
    // MAX_VALUE omitted: squaring it in the cosine score would overflow to
    // Infinity; the codec-level roundtrip test above still covers it bit-exactly.
    const tricky = [-0, 0.1, 1e-300, 5e-324, Number.EPSILON, 2 ** 53 + 1];
    await indexFiles([{ path: 'prec.pdf', mtime: 1, chunks: [makeChunk('prec.pdf', 0, tricky)] }]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.ensureLoaded(MODEL);
    const [r] = store.query(tricky, 1);
    expect(r.score).toBeCloseTo(1.0, 10);
    r.chunk.embedding.forEach((v, i) => expect(Object.is(v, tricky[i])).toBe(true));
  });

  test('official GCF decoder accepts the produced index and roundtrips all fields', async () => {
    const text = 'line one\nline two | with pipe\n"quoted" cell';
    await indexFiles([
      { path: 'docs|dir/a|1.pdf', mtime: 123, chunks: [makeChunk('docs|dir/a|1.pdf', 0, [0.5, -0.25], text)] },
    ]);
    const decoded = decodeGeneric(await readVault(GCF_PATH));
    expect(decoded.get('embeddingModel')).toBe(MODEL);
    expect(decoded.get('vectorCodec')).toBe('f64le-deflate-base64');
    const files = decoded.get('files') as Array<Map<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].get('vaultPath')).toBe('docs|dir/a|1.pdf');
    expect(files[0].get('mtime')).toBe(123);
    const chunks = decoded.get('chunks') as Array<Map<string, unknown>>;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].get('text')).toBe(text);
    const embedding = decodeVector(chunks[0].get('embedding') as string);
    expect(Object.is(embedding[0], 0.5)).toBe(true);
    expect(Object.is(embedding[1], -0.25)).toBe(true);
  });

  test('escaping: hostile paths and texts roundtrip exactly through the index', async () => {
    const hostile = [
      'pipe|and|pipes.md',
      'quote"double.md',
      'back\\slash.md',
      'new\nline.md',
      'space and = equals.md',
    ];
    await indexFiles(hostile.map((p, i) => ({
      path: p,
      mtime: i + 1,
        chunks: [makeChunk(p, 0, [i + 1, (i + 1) * (i + 1), (i + 1) * (i + 1) * (i + 1)], `text with | pipe and " quotes and \\ backslash and new\nline`)],
    })));
    const reloaded = new VectorStore(PLUGIN_DIR, makeApp(root));
    await reloaded.ensureLoaded(MODEL);
    expect(reloaded.getStats().fileCount).toBe(hostile.length);
    hostile.forEach((p, i) => {
      expect(reloaded.getFileMtime(p)).toBe(i + 1);
      const [r] = reloaded.query([i + 1, (i + 1) * (i + 1), (i + 1) * (i + 1) * (i + 1)], 1);
      expect(r.chunk.vaultPath).toBe(p);
      expect(r.chunk.text).toBe(`text with | pipe and " quotes and \\ backslash and new\nline`);
    });
  });

  test('incremental update: re-embedding a file replaces its old chunks; delete removes its rows', async () => {
    await indexFiles([
      { path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0]), makeChunk('a.pdf', 1, [0, 1])] },
      { path: 'b.pdf', mtime: 2, chunks: [makeChunk('b.pdf', 0, [1, 1])] },
    ]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.prepareForIndexing(MODEL);
    await store.upsertFile('a.pdf', 10, [makeChunk('a.pdf', 0, [0, 1])]);
    await store.removeFile('b.pdf');
    await store.finishIndexing();

    const reloaded = new VectorStore(PLUGIN_DIR, makeApp(root));
    await reloaded.ensureLoaded(MODEL);
    expect(reloaded.getStats().fileCount).toBe(1);
    expect(reloaded.getStats().chunkCount).toBe(1);
    expect(reloaded.getFileMtime('a.pdf')).toBe(10);
    expect(reloaded.getFileMtime('b.pdf')).toBeNull();
    const results = reloaded.query([1, 1], 10);
    expect(results.map(r => r.chunk.id)).toEqual(['a.pdf::p1::c0']);
  });

  test('removeFile works with the query DB unloaded (disk-backed file-table update)', async () => {
    await indexFiles([
      { path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] },
      { path: 'b.pdf', mtime: 2, chunks: [makeChunk('b.pdf', 0, [0, 1])] },
    ]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    expect(store.isLoaded()).toBe(false);
    await store.removeFile('b.pdf');
    expect(store.isLoaded()).toBe(false); // query DB never loaded
    expect(store.getFileMtime('b.pdf')).toBeNull();
    expect(store.getFileMtime('a.pdf')).toBe(1);

    const reloaded = new VectorStore(PLUGIN_DIR, makeApp(root));
    await reloaded.ensureLoaded(MODEL);
    expect(reloaded.getStats().fileCount).toBe(1);
    expect(reloaded.getFileMtime('b.pdf')).toBeNull();
  });

  test('chat during indexing queries the last published snapshot; publication invalidates the cache', async () => {
    await indexFiles([{ path: 'old.pdf', mtime: 1, chunks: [makeChunk('old.pdf', 0, [1, 0])] }]);
    const app = makeApp(root);
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.ensureLoaded(MODEL); // query DB resident
    await store.prepareForIndexing(MODEL); // session opens, query cache dropped
    await store.upsertFile('new.pdf', 2, [makeChunk('new.pdf', 0, [0, 1])]);

    // Mid-session: the committed (pre-publication) document is what a concurrent
    // fresh load sees.
    const chat = new VectorStore(PLUGIN_DIR, makeApp(root));
    await chat.ensureLoaded(MODEL);
    expect(chat.query([1, 0], 10).map(r => r.chunk.vaultPath)).toEqual(['old.pdf']);

    await store.finishIndexing();
    // The indexer store's cache is stale after publication; reload sees the new index.
    await store.ensureLoaded(MODEL);
    expect(store.query([0, 1], 1).map(r => r.chunk.vaultPath)).toEqual(['new.pdf']);
  });

  test('unload() drops vectors but keeps mtimes; ensureLoaded reloads on demand', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.ensureLoaded(MODEL);
    expect(store.isLoaded()).toBe(true);
    expect(store.query([1, 0], 5)).toHaveLength(1);
    store.unload();
    expect(store.isLoaded()).toBe(false);
    expect(store.getFileMtime('a.pdf')).toBe(1);
    expect(store.query([1, 0], 5)).toEqual([]);
    await store.ensureLoaded(MODEL);
    expect(store.isLoaded()).toBe(true);
    expect(store.query([1, 0], 5)).toHaveLength(1);
  });

  // ---- atomic publication: failed writes never corrupt the committed index ----

  test('failed publication (write error) leaves the committed index byte-identical and cleans up', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const committed = await readVault(GCF_PATH);

    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.prepareForIndexing(MODEL);
    await store.upsertFile('b.pdf', 2, [makeChunk('b.pdf', 0, [0, 1])]);
    // Block the tmp path as a directory: the streaming write cannot succeed.
    await fsp.mkdir(path.join(root, GCF_PATH + '.tmp'));
    await expect(store.finishIndexing()).rejects.toThrow();
    expect(await readVault(GCF_PATH)).toBe(committed); // byte-identical
    expect(await existsVault(STAGING_PATH)).toBe(false); // staging cleaned
    // The blocker directory remains (unlink on a dir is not possible); operator
    // (or next-prepare cleanup of a file) handles it. Simulate that, then re-run.
    await fsp.rmdir(path.join(root, GCF_PATH + '.tmp'));
    const retried = new VectorStore(PLUGIN_DIR, makeApp(root));
    await retried.prepareForIndexing(MODEL);
    await retried.upsertFile('b.pdf', 2, [makeChunk('b.pdf', 0, [0, 1])]);
    await retried.finishIndexing();
    expect(await readVault(GCF_PATH)).toContain('b.pdf');
  });

  test('second publish replaces the committed index (adapter.rename cannot overwrite)', async () => {
    // The test adapter mirrors Obsidian: adapter.rename onto an existing file
    // throws. Any republish (incremental index, remove, clear) must still
    // install the new document atomically via the physical swap.
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.prepareForIndexing(MODEL);
    await store.upsertFile('b.pdf', 2, [makeChunk('b.pdf', 0, [0, 1])]);
    await store.finishIndexing();

    const doc = await readVault(GCF_PATH);
    const lines = doc.split('\n');
    expect(lines[lines.length - 2]).toBe('##! summary counts=2,2');
    expect(doc).toContain('a.pdf|1|1');
    expect(doc).toContain('b.pdf|2|1');
    // No swap residue left behind.
    expect(await existsVault(`${GCF_PATH}.swap`)).toBe(false);
    expect(await existsVault(`${GCF_PATH}.tmp`)).toBe(false);
  });

  test('crashed swap-window states are repaired before the index is trusted', async () => {
    const { store } = await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const gcf = path.join(root, GCF_PATH);
    const aside = path.join(root, `${GCF_PATH}.swap`);
    const tmp = path.join(root, `${GCF_PATH}.tmp`);
    const committed = await readVault(GCF_PATH);

    // (1) crash after commit-aside, before new-in-place: the fully-written
    // new document in tmp wins; the aside is discarded.
    await fsp.rename(gcf, aside);
    await fsp.writeFile(tmp, 'complete new document\n', 'utf8');
    await store.prepareForIndexing(MODEL);
    expect(await readVault(GCF_PATH)).toBe('complete new document\n');
    expect(await existsVault(`${GCF_PATH}.swap`)).toBe(false);

    // (2) committed missing + aside only: restore the previous document.
    const second = new VectorStore(PLUGIN_DIR, makeApp(root));
    await fsp.rm(gcf);
    await fsp.writeFile(aside, committed, 'utf8');
    await second.prepareForIndexing(MODEL);
    expect(await readVault(GCF_PATH)).toBe(committed);
    expect(await existsVault(`${GCF_PATH}.swap`)).toBe(false);

    // (3) committed present + stale aside: the duplicate is discarded, the
    // committed document untouched.
    await fsp.writeFile(aside, 'stale duplicate\n', 'utf8');
    const third = new VectorStore(PLUGIN_DIR, makeApp(root));
    await third.prepareForIndexing(MODEL);
    expect(await readVault(GCF_PATH)).toBe(committed);
    expect(await existsVault(`${GCF_PATH}.swap`)).toBe(false);
  });

  test('aborted run (partial upserts) publishes the completed files; prior entries survive', async () => {
    await indexFiles([
      { path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] },
      { path: 'b.pdf', mtime: 2, chunks: [makeChunk('b.pdf', 0, [0, 1])] },
    ]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.prepareForIndexing(MODEL);
    await store.upsertFile('a.pdf', 11, [makeChunk('a.pdf', 0, [1, 0])]);
    // "crash" before b.pdf is upserted: finish still publishes what completed.
    await store.finishIndexing();

    const reloaded = new VectorStore(PLUGIN_DIR, makeApp(root));
    await reloaded.ensureLoaded(MODEL);
    expect(reloaded.getStats().fileCount).toBe(2); // a (updated) + b (untouched)
    expect(reloaded.getFileMtime('a.pdf')).toBe(11);
    expect(reloaded.getFileMtime('b.pdf')).toBe(2);
  });

  // ---- model change handling ----

  test('query path: committed index from another model → ProviderError DIMENSION_MISMATCH', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await expect(store.ensureLoaded('model-b')).rejects.toThrow(ProviderError);
    try {
      await store.ensureLoaded('model-b');
    } catch (e) {
      expect((e as ProviderError).code).toBe('DIMENSION_MISMATCH');
    }
  });

  test('index path: model change resets the file table (full rebuild) without throwing', async () => {
    await indexFiles([{ path: 'old.pdf', mtime: 1, chunks: [makeChunk('old.pdf', 0, [1, 0])] }]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.prepareForIndexing('model-b'); // committed was 'model-a' (MODEL)
    expect(store.getIndexedPaths()).toEqual([]); // force full re-embed
    await store.upsertFile('new.pdf', 5, [makeChunk('new.pdf', 0, [0, 1])]);
    await store.finishIndexing();

    const reloaded = new VectorStore(PLUGIN_DIR, makeApp(root));
    await reloaded.ensureLoaded('model-b');
    expect(reloaded.getStats().fileCount).toBe(1);
    expect(reloaded.getFileMtime('new.pdf')).toBe(5);
    expect(reloaded.getFileMtime('old.pdf')).toBeNull();
  });

  // ---- corrupt / foreign / torn index documents ----

  test('corrupt committed document (summary mismatch) → query path degrades to empty, no throw', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const doc = await readVault(GCF_PATH);
    await fsp.writeFile(path.join(root, GCF_PATH), doc.replace(/counts=(\d+),(\d+)\n$/, 'counts=999,999\n'));

    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.ensureLoaded(MODEL);
    expect(store.query([1, 0], 5)).toEqual([]);
  });

  test('rebuild over a corrupt committed document replaces it with a valid one', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const doc = await readVault(GCF_PATH);
    await fsp.writeFile(path.join(root, GCF_PATH), doc.replace(/counts=(\d+),(\d+)\n$/, 'counts=999,999\n'));

    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.prepareForIndexing(MODEL);
    expect(store.getIndexedPaths()).toEqual([]);
    await store.upsertFile('b.pdf', 2, [makeChunk('b.pdf', 0, [0, 1])]);
    await store.finishIndexing();

    const reloaded = new VectorStore(PLUGIN_DIR, makeApp(root));
    await reloaded.ensureLoaded(MODEL);
    expect(reloaded.getStats().fileCount).toBe(1);
  });

  test('torn document at a complete row boundary (missing trailer) is rejected by the query path but accepted by the official decoder alone', async () => {
    await indexFiles([
      { path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] },
      { path: 'b.pdf', mtime: 2, chunks: [makeChunk('b.pdf', 0, [0, 1])] },
    ]);
    const doc = await readVault(GCF_PATH);
    // Tear after the first complete chunk row: drop the second row + trailer.
    const torn = doc.replace(/(## chunks [^\n]*\n[^\n]+\n)[^\n]*\n##! summary[^\n]*\n$/, '$1');
    expect(torn).not.toContain('##! summary');
    await fsp.writeFile(path.join(root, GCF_PATH), torn);

    // The gap this closes: the official decoder alone accepts the torn document.
    expect(() => decodeGeneric(torn)).not.toThrow();

    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.ensureLoaded(MODEL);
    expect(store.query([1, 0], 5)).toEqual([]);
  });

  test('corrupt chunk vector row: prepare discards the base file table (no mtime trust) and rebuilds', async () => {
    await indexFiles([
      { path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] },
      { path: 'b.pdf', mtime: 2, chunks: [makeChunk('b.pdf', 0, [0, 1])] },
    ]);
    // Corrupt one chunk row's compressed vector cell.
    const lines = (await readVault(GCF_PATH)).split('\n');
    const i = lines.findIndex(l => l.startsWith('b.pdf::p1::c0|'));
    expect(i).toBeGreaterThan(0);
    const cells = lines[i].split('|');
    cells[cells.length - 1] = '!!!corrupt-payload';
    lines[i] = cells.join('|');
    await fsp.writeFile(path.join(root, GCF_PATH), lines.join('\n'));

    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.prepareForIndexing(MODEL);
    expect(store.getIndexedPaths()).toEqual([]); // base NOT trusted: full rebuild

    await store.upsertFile('c.pdf', 3, [makeChunk('c.pdf', 0, [1, 0])]);
    await store.finishIndexing();

    const reloaded = new VectorStore(PLUGIN_DIR, makeApp(root));
    await reloaded.ensureLoaded(MODEL);
    expect(reloaded.getStats().fileCount).toBe(1);
    expect(reloaded.getFileMtime('c.pdf')).toBe(3);
  });

  // ---- publication / query overlap (same instance) ----

  test('stale read that lands after a publication is retried, not installed (epoch guard)', async () => {
    // Seed a committed index (v1) so the pre-publication document exists to read.
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const app = makeApp(root);
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.prepareForIndexing(MODEL);
    await store.upsertFile('b.pdf', 2, [makeChunk('b.pdf', 0, [0, 1])]);

    // A query load on the SAME instance whose read resolves the pre-publication
    // document only after the publication commits.
    const v1 = await readVault(GCF_PATH);
    let releaseRead: () => void = () => {};
    const readOld = new Promise<string>(res => { releaseRead = () => res(v1); });
    let first = true;
    const adapter = app.vault.adapter as unknown as VaultAdapter;
    adapter.read = async (p: string) => {
      if (first) { first = false; return readOld; }
      return fsp.readFile(path.join(root, p), 'utf8');
    };
    const loadPromise = store.ensureLoaded(MODEL);
    await store.finishIndexing(); // publish a+b; epoch advances
    releaseRead();                // the stale v1 read now completes
    await loadPromise;

    // The installed state must be the NEW index, not the stale snapshot.
    expect(store.getStats().fileCount).toBe(2);
    expect(store.getFileMtime('b.pdf')).toBe(2);
    expect(store.query([0, 1], 10).map(r => r.chunk.vaultPath)).toContain('b.pdf');
  });

  test('publication is isolated from concurrent loads: snapshot file table wins, staged rows preserved', async () => {
    // Seed a committed index (v1) so the pre-publication document exists to read.
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const app = makeApp(root);
    const store = new VectorStore(PLUGIN_DIR, app);
    await store.prepareForIndexing(MODEL);
    await store.upsertFile('b.pdf', 2, [makeChunk('b.pdf', 0, [0, 1])]);

    // A same-instance load reading the pre-publication document, whose install
    // lands inside/after the publication window. With the session held through
    // publication it must not clobber the staged file table.
    const v1 = await readVault(GCF_PATH);
    let release: () => void = () => {};
    const gate = new Promise<string>(res => { release = () => res(v1); });
    let first = true;
    const adapter = app.vault.adapter as unknown as VaultAdapter;
    adapter.read = async (p: string) => {
      if (first) { first = false; return gate; }
      return fsp.readFile(path.join(root, p), 'utf8');
    };
    const loadPromise = store.ensureLoaded(MODEL);
    await store.finishIndexing(); // publish; session released in finally
    release();
    await loadPromise;

    const published = await readVault(GCF_PATH);
    // The committed document carries the full staged file table (a AND b) and
    // both chunk rows, regardless of when the overlapping load installed.
    expect(published).toContain('a.pdf|');
    expect(published).toContain('b.pdf|');
    expect(published).toContain('b.pdf::p1::c0|');
    expect(store.getStats().fileCount).toBe(2);
  });

  // ---- clear / exists / peekModel / stale tmp ----

  test('clear: publishes an empty index the official decoder accepts', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.clear(MODEL);

    const doc = await readVault(GCF_PATH);
    const decoded = decodeGeneric(doc);
    expect((decoded.get('files') as unknown[]).length).toBe(0);
    expect((decoded.get('chunks') as unknown[]).length).toBe(0);
    expect(store.getStats().fileCount).toBe(0);
  });

  test('exists: true for a committed .gcf, false otherwise', async () => {
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    expect(await store.exists()).toBe(false);
    await fsp.mkdir(path.join(root, PLUGIN_DIR, 'index'), { recursive: true });
    await fsp.writeFile(path.join(root, GCF_PATH), 'GCF profile=generic\n');
    expect(await store.exists()).toBe(true);
  });

  test('peekModel: reads only the header (no whole-document load) and returns the model', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    expect(await store.peekModel()).toBe(MODEL);
  });

  test('stale tmp/staging leftovers from a crashed run are reaped on prepare', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    await fsp.writeFile(path.join(root, `${GCF_PATH}.tmp`), 'garbage');
    await fsp.writeFile(path.join(root, STAGING_PATH), 'garbage');

    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.prepareForIndexing(MODEL);
    expect(await existsVault(`${GCF_PATH}.tmp`)).toBe(false);
    // prepare reopens staging: the crashed garbage is replaced by a fresh header
    expect((await readVault(STAGING_PATH)).startsWith('GCF profile=generic\n')).toBe(true);
    await store.finishIndexing();
    expect(await existsVault(`${GCF_PATH}.tmp`)).toBe(false);
    expect(await existsVault(STAGING_PATH)).toBe(false);
  });

  test('getStats: valid while the query DB is unloaded, reflects in-progress session state', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0]), makeChunk('a.pdf', 1, [0, 1])] }]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    expect(store.isLoaded()).toBe(false);
    await store.prepareForIndexing(MODEL); // hydrates meta + file table, no vectors
    expect(store.getStats().fileCount).toBe(1);
    expect(store.getStats().chunkCount).toBe(2); // from file table while unloaded

    await store.prepareForIndexing(MODEL);
    await store.upsertFile('b.pdf', 2, [makeChunk('b.pdf', 0, [1, 1])]);
    const mid = store.getStats();
    expect(mid.fileCount).toBe(2);
    expect(mid.chunkCount).toBe(3); // in-progress staged state
    await store.finishIndexing();
    expect(store.isLoaded()).toBe(false);
  });

  test('upsert without an open session throws (indexers must run inside prepare/finish)', async () => {
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await expect(store.upsertFile('x.pdf', 1, [makeChunk('x.pdf', 0, [1, 0])])).rejects.toThrow();
  });

  test('prepareForIndexing unloads the query vector cache but retains lightweight stats/mtimes', async () => {
    await indexFiles([{ path: 'a.pdf', mtime: 1, chunks: [makeChunk('a.pdf', 0, [1, 0])] }]);
    const store = new VectorStore(PLUGIN_DIR, makeApp(root));
    await store.ensureLoaded(MODEL);
    expect(store.isLoaded()).toBe(true);
    await store.prepareForIndexing(MODEL);
    expect(store.isLoaded()).toBe(false); // no query DB resident while indexing
    expect(store.getFileMtime('a.pdf')).toBe(1); // mtime retained
    await store.finishIndexing();
  });
});
