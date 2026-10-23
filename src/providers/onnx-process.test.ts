import {
  OnnxProcessError,
  OnnxProcessPipeline,
  createOnnxProcessPipeline,
  seedModelFilesFromBrowserCache,
} from './onnx-process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Stub worker speaking the real wire protocol (ready/load/infer/dispose) so
 * process-lifecycle behavior can be tested deterministically without a real
 * model or network. Behavior is driven by the requested model id:
 *  - 'boom/load'    -> stderr flood + IPC load error + exit(1)
 *  - 'silent/exit'  -> stderr flood then hard exit(3), no IPC error (crash)
 *  - 'crash-now'    (text) -> SIGKILL during inference
 *  - 'slow-infer'   (text) -> 300ms inference
 *  - 'fail-infer'   (text) -> per-inference error
 *  - anything else          -> [text.length, 0.5, -2.25]
 */
const STUB_WORKER = `
'use strict';
let queue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function reply(msg, vals) {
  const f = Float32Array.from(vals);
  process.send({ t: 'result', id: msg.id, b64: Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64') });
}
function handleInfer(msg) {
  if (msg.text === 'crash-now') {
    process.kill(process.pid, 'SIGKILL');
    return sleep(60000);
  }
  if (msg.text === 'slow-infer') {
    // Signal the host that inference has begun so tests can await a real
    // condition (this runs in the child process; its clock can't be faked).
    process.send({ t: 'progress', message: 'slow-infer-started' });
    return sleep(300).then(() => reply(msg, [1, 2, 3]));
  }
  if (msg.text === 'fail-infer') {
    process.send({ t: 'error', id: msg.id, message: 'stub infer failure' });
    return Promise.resolve();
  }
  reply(msg, [msg.text.length, 0.5, -2.25]);
  return Promise.resolve();
}
process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'load') {
    queue = queue.then(() => {
      if (msg.model === 'boom/load') {
        for (let i = 0; i < 200; i++) process.stderr.write('BOOM-STDERR-' + i + '\\n');
        process.send({ t: 'error', message: 'stub model missing' });
        process.exit(1);
        return Promise.resolve();
      }
      if (msg.model === 'silent/exit') {
        for (let i = 0; i < 500; i++) process.stderr.write('FILLER-' + i + '-'.repeat(100) + '\\n');
        process.stderr.write('SILENT-TAIL-END\\n');
        setTimeout(() => process.exit(3), 200);
        return Promise.resolve();
      }
      process.send({ t: 'loaded' });
      return Promise.resolve();
    });
  } else if (msg.t === 'infer') {
    queue = queue.then(() => handleInfer(msg));
  } else if (msg.t === 'dispose') {
    queue = queue.then(() => {
      process.send({ t: 'disposed' });
      process.exit(0);
    });
  }
});
process.send({ t: 'ready' });
`;

let dir: string;
const pipelines: OnnxProcessPipeline[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'onnx-process-'));
});

afterEach(async () => {
  for (const pipe of pipelines.splice(0)) {
    try {
      await pipe.dispose();
    } catch (err) {
      // already gone
    }
  }
  if ((globalThis as { caches?: unknown }).caches) {
    delete (globalThis as { caches?: unknown }).caches;
  }
  rmSync(dir, { recursive: true, force: true });
});

function make(opts: Record<string, unknown> = {}): Promise<OnnxProcessPipeline> {
  const pipe = createOnnxProcessPipeline({
    pluginDir: dir,
    model: 'stub/model',
    device: 'cpu',
    dtype: 'q8',
    workerSource: STUB_WORKER,
    ...opts,
  });
  pipe.then((p) => pipelines.push(p), () => {});
  return pipe;
}

function workerFileLeftovers(): string[] {
  const models = join(dir, 'models');
  if (!existsSync(models)) return [];
  return readdirSync(models).filter((f) => f.startsWith('.onnx-worker'));
}

describe('createOnnxProcessPipeline', () => {
  test('round-trips inferences through the isolated child process', async () => {
    const pipe = await make();
    expect(pipe.pid).toEqual(expect.any(Number));

    const out = await pipe('hello', { pooling: 'mean' });
    expect(Array.from(out.data)).toEqual([5, 0.5, -2.25]);

    const again = await pipe('hi');
    expect(Array.from(again.data)).toEqual([2, 0.5, -2.25]);

    await pipe.dispose();
  }, 20000);

  test('killing the child rejects the in-flight infer; the host stays alive and later calls fail cleanly', async () => {
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });
    const pipe = await make({
      onProgress: (m: string) => {
        if (m === 'slow-infer-started') resolveStarted();
      },
    });
    const inflight = pipe('slow-infer');
    // Await the child's real "in-flight" signal rather than guessing a duration.
    await started;
    process.kill(pipe.pid as number, 'SIGKILL');

    await expect(inflight).rejects.toBeInstanceOf(OnnxProcessError);
    await expect(inflight).rejects.toThrow(/exited unexpectedly/);
    await expect(pipe('x')).rejects.toThrow('is not running');
    await expect(pipe('y')).rejects.toBeInstanceOf(OnnxProcessError);
    // Disposing after death is a no-op that still resolves.
    await expect(pipe.dispose()).resolves;
  }, 20000);

  test('dispose terminates the child, removes the worker file, and is idempotent', async () => {
    const pipe = await make();
    await pipe('a');

    await pipe.dispose();
    await pipe.dispose();
    await expect(pipe('a')).rejects.toThrow('disposed');
    expect(workerFileLeftovers()).toEqual([]);
  }, 20000);

  test('dispose while an inference is running waits for it to finish, then exits', async () => {
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });
    const pipe = await make({
      onProgress: (m: string) => {
        if (m === 'slow-infer-started') resolveStarted();
      },
    });
    const inflight = pipe('slow-infer');
    // Await the child's real "in-flight" signal rather than guessing a duration.
    await started;

    const disposed = pipe.dispose();
    const out = await inflight; // completes before the child exits
    expect(Array.from(out.data)).toEqual([1, 2, 3]);
    await disposed;
    await expect(pipe('x')).rejects.toBeInstanceOf(OnnxProcessError);
    expect(workerFileLeftovers()).toEqual([]);
  }, 20000);

  test('inferences are serialized in the child', async () => {
    const pipe = await make();
    const [a, b] = await Promise.all([pipe('slow-infer'), pipe('slow-infer')]);
    expect(Array.from(a.data)).toEqual([1, 2, 3]);
    expect(Array.from(b.data)).toEqual([1, 2, 3]);
    await pipe.dispose();
  }, 20000);

  test('a per-inference error rejects only that request; the pipeline stays usable', async () => {
    const pipe = await make();
    await expect(pipe('fail-infer')).rejects.toThrow('stub infer failure');
    const out = await pipe('ok');
    expect(Array.from(out.data)).toEqual([2, 0.5, -2.25]);
    await pipe.dispose();
  }, 20000);

  test('load failure rejects the factory with the child error and cleans up the worker file', async () => {
    await expect(make({ model: 'boom/load' })).rejects.toThrow('stub model missing');
    expect(workerFileLeftovers()).toEqual([]);
  }, 20000);

  test('hard child exit without an IPC error rejects the load with bounded stderr', async () => {
    const p = make({ model: 'silent/exit' });
    await expect(p).rejects.toThrow(/exited unexpectedly/);
    // The tail marker (last line written) proves stderr capture; the length
    // bound proves the host does not buffer unbounded output.
    await expect(p).rejects.toThrow('SILENT-TAIL-END');
    try {
      await p;
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(16384);
    }
    expect(workerFileLeftovers()).toEqual([]);
  }, 20000);
});

describe('real worker bootstrap', () => {
  test('a missing transformers dependency surfaces the actual module error', async () => {
    // No workerSource override: the real bundled bootstrap runs in a forked
    // child and createRequire (rooted at <pluginDir>/main.js) cannot find the
    // dependency from an empty temp plugin dir.
    await expect(
      createOnnxProcessPipeline({
        pluginDir: dir,
        model: 'Xenova/all-MiniLM-L6-v2',
        device: 'cpu',
        dtype: 'q8',
      })
    ).rejects.toThrow(/Cannot find module '@huggingface\/transformers'/);
  }, 20000);
});

describe('seedModelFilesFromBrowserCache', () => {
  const repo = 'keisuke-miyako/nomic-embed-text-v1.5-onnx-int8';
  const base = `https://huggingface.co/${repo}/resolve/main`;

  interface CacheEntry {
    url: string;
    bytes: Uint8Array;
  }

  function installCaches(entries: CacheEntry[]) {
    const store = new Map<string, Uint8Array>(entries.map((e) => [e.url, e.bytes]));
    const opened: string[] = [];
    const matched: string[] = [];
    const cache = {
      keys: async (): Promise<Request[]> => [...store.keys()].map((u) => new Request(u)),
      match: async (req: Request): Promise<Response | undefined> => {
        matched.push(req.url);
        const bytes = store.get(req.url);
        if (!bytes) return undefined;
        // lib.dom BodyInit generics reject Uint8Array<ArrayBufferLike>; runtime accepts it
        return new Response(bytes as unknown as BodyInit, { headers: { 'content-length': String(bytes.length) } });
      },
    };
    (globalThis as { caches?: unknown }).caches = {
      open: async (name: string): Promise<unknown> => {
        opened.push(name);
        return cache;
      },
    };
    return { opened, matched };
  }

  test('streams matching CacheStorage bodies into the node FS cache layout', async () => {
    const onnxBody = new Uint8Array(2048).map((_, i) => (i * 7) % 251);
    const { opened, matched } = installCaches([
      { url: `${base}/config.json`, bytes: new TextEncoder().encode('{"model_type":"nomic"}') },
      { url: `${base}/model_quantized.onnx`, bytes: onnxBody },
      {
        url: 'https://huggingface.co/other-repo/resolve/main/config.json',
        bytes: new TextEncoder().encode('other'),
      },
    ]);

    await seedModelFilesFromBrowserCache(dir, repo);

    expect(opened).toEqual(['transformers-cache']);
    // Only the requested model's keys are fetched.
    expect(matched).toHaveLength(2);
    for (const u of matched) {
      expect(u.startsWith(`${base}/`)).toBe(true);
    }
    const models = join(dir, 'models');
    expect(readFileSync(join(models, repo, 'config.json'), 'utf8')).toBe(
      '{"model_type":"nomic"}'
    );
    expect(readFileSync(join(models, repo, 'model_quantized.onnx')).equals(Buffer.from(onnxBody))).toBe(
      true
    );
    // Other repos are never copied; no temp files remain.
    expect(existsSync(join(models, 'other-repo'))).toBe(false);
    expect(readdirSync(join(models, repo)).filter((f) => f.includes('.part-'))).toEqual([]);
  });

  test('skips files whose size already matches and rewrites truncated ones', async () => {
    const full = new Uint8Array(1024).fill(7);
    const modelsRepo = join(dir, 'models', repo);
    mkdirSync(modelsRepo, { recursive: true });
    writeFileSync(join(modelsRepo, 'config.json'), 'X'.repeat(1024));
    writeFileSync(join(modelsRepo, 'model.onnx'), 'short');

    installCaches([
      { url: `${base}/config.json`, bytes: full },
      { url: `${base}/model.onnx`, bytes: full },
    ]);
    await seedModelFilesFromBrowserCache(dir, repo);

    // Same size -> untouched (no rewrite).
    expect(readFileSync(join(modelsRepo, 'config.json'), 'utf8')).toBe('X'.repeat(1024));
    // Size mismatch -> rewritten with the full body.
    expect(readFileSync(join(modelsRepo, 'model.onnx')).equals(Buffer.from(full))).toBe(true);
    expect(readdirSync(modelsRepo).filter((f) => f.includes('.part-'))).toEqual([]);
  });

  test('is a no-op outside a DOM environment (plain node)', async () => {
    await expect(seedModelFilesFromBrowserCache(dir, repo)).resolves;
    expect(existsSync(join(dir, 'models'))).toBe(false);
  });

  test('is a no-op when the model has no cached keys', async () => {
    installCaches([
      {
        url: 'https://huggingface.co/another/repo/resolve/main/config.json',
        bytes: new TextEncoder().encode('{}'),
      },
    ]);
    await seedModelFilesFromBrowserCache(dir, repo);
    expect(existsSync(join(dir, 'models'))).toBe(false);
  });
});
