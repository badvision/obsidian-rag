/**
 * Process-isolated ONNX embedding pipeline.
 *
 * Why: Obsidian runs plugin code in the renderer, which shares one OS
 * process with the entire UI. ONNX Runtime's CPU arena (BFCArena) extends in
 * powers of two; on large models the next aligned allocation trap crashes the
 * whole app (SIGTRAP on the renderer main thread — three macOS .ips reports).
 * Containment: every transformers.js / ONNX load and forward call runs in a
 * disposable child process. If the child dies, in-flight inference rejects,
 * the app survives, and the caller recreates the pipeline on next use.
 * There is no renderer-side ONNX fallback and no automatic retry.
 *
 * How: the worker is a self-contained CJS bootstrap serialized with
 * `fn.toString()` — no extra bundle entry or install artifact. It requires
 * '@huggingface/transformers' via createRequire rooted at
 * <pluginDir>/main.js so it resolves the same installed-plugin node_modules
 * as the renderer.
 *
 * - Obsidian/Electron: forked with
 *   `remote.require('electron').utilityProcess` — a real separate OS process.
 *   The Obsidian build has the RunAsNode fuse disabled (verified by inspecting
 *   the framework fuses), so process.execPath + ELECTRON_RUN_AS_NODE is
 *   deliberately NOT used.
 * - Plain Node (unit tests only): child_process.fork with IPC.
 *
 * Before the child starts, model resources that transformers.js v4 cached in
 * the renderer's Chromium CacheStorage ("transformers-cache") are streamed
 * into the node filesystem cache layout (<pluginDir>/models/<repo>/<file>,
 * matching FileCache for the default `main` revision) so offline users keep
 * working without re-downloading.
 */
import { dirname, join } from 'path';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { fork } from 'child_process';

/** transformers.js v4 browser cache name (`env.cacheKey`). */
const TRANSFORMERS_CACHE_KEY = 'transformers-cache';
/** How much of the child's stderr the host retains for error messages. */
const STDERR_TAIL = 8192;
/** Grace period before SIGKILL when disposing. */
const DISPOSE_TIMEOUT_MS = 5000;
/** Final grace period after a forced kill. */
const KILL_TIMEOUT_MS = 2000;
/** Guard against a child that never signals ready. */
const READY_TIMEOUT_MS = 15000;

/** Failure of the isolated ONNX child process (spawn, load, infer, exit). */
export class OnnxProcessError extends Error {
  constructor(
    message: string,
    public readonly code: number | null = null,
    public readonly signal: string | null = null,
    /**
     * True when the child process is gone or the pipeline is otherwise
     * unusable and the caller must start a fresh one. False for a
     * well-formed per-inference error reported by a still-running child —
     * the pipeline stays reusable.
     */
    public readonly childDead = true
  ) {
    super(message);
    this.name = 'OnnxProcessError';
  }
}

/**
 * Creation was cancelled via the AbortSignal (e.g. provider dispose).
 * Distinct from a load failure: callers must NOT fall back to another
 * device/dtype variant for a cancellation.
 */
export class OnnxCreateCancelledError extends OnnxProcessError {
  constructor() {
    super('ONNX pipeline creation was cancelled', null, null, false);
  }
}

export interface OnnxProcessPipelineOptions {
  /** Installed plugin directory (contains main.js + node_modules). */
  pluginDir: string;
  /** Hugging Face repo id of the embedding model. */
  model: string;
  /** ONNX execution device, e.g. 'cpu' or 'coreml'. One variant only — the
   * dtype/device fallback ladder stays with the caller. */
  device: string;
  /** ONNX dtype variant, e.g. 'q8' or 'fp32'. */
  dtype: string;
  /** Non-standard file layout overrides, passed through to transformers.js. */
  subfolder?: string;
  model_file_name?: string;
  /** Optional: surface download/progress messages from the child. */
  onProgress?: (message: string) => void;
  /**
   * Cancels creation when aborted: cache seeding is stopped and any spawned
   * child is terminated (bounded). Deliberately the only interrupt of the
   * load phase — no download timeout is implied.
   */
  signal?: AbortSignal;
  /**
   * Advanced (tests only): replace the worker script with a custom
   * protocol-speaking script. Defaults to the bundled bootstrap
   * (see buildOnnxWorkerSource).
   */
  workerSource?: string;
}

/** A feature-extraction pipeline backed by an isolated child process. */
export interface OnnxProcessPipeline {
  (text: string, options?: Record<string, unknown>): Promise<{ data: ArrayLike<number> }>;
  /**
   * Terminate the child process and release the model. Idempotent. Waits for
   * a running inference to finish (bounded), then force-kills if needed.
   */
  dispose(): Promise<void>;
  /** Child OS pid, once spawned. */
  readonly pid?: number;
}

// --- Wire protocol types (shared shape; values cross a process boundary) ---

type WireRecord = Record<string, unknown>;

interface LoadRequest {
  t: 'load';
  pluginDir: string;
  cacheDir: string;
  model: string;
  device: string;
  dtype: string;
  subfolder?: string;
  model_file_name?: string;
}
interface InferRequest {
  t: 'infer';
  id: number;
  text: string;
  options?: Record<string, unknown>;
}
type ChildRequest = LoadRequest | InferRequest | { t: 'dispose' };

interface ParentPortLike {
  postMessage(msg: unknown): void;
  on(type: 'message', cb: (e: { data: unknown }) => void): void;
}
interface PipelineFn {
  (text: string, options: Record<string, unknown>): Promise<{ data: unknown }>;
}
interface TransformersLike {
  env: { cacheDir: string };
  pipeline(task: string, model: string, options: Record<string, unknown>): Promise<PipelineFn>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The self-contained worker bootstrap, serialized for a .cjs worker file.
 *
 * Wire protocol (JSON on Node fork IPC / structured clone on utilityProcess):
 *   host -> child: {t:'load', pluginDir, cacheDir, model, device, dtype,
 *                   subfolder?, model_file_name?}
 *                  {t:'infer', id, text, options}
 *                  {t:'dispose'}
 *   child -> host: {t:'ready'}
 *                  {t:'loaded'}
 *                  {t:'progress', message}
 *                  {t:'result', id, data?: Float32Array, b64?: string}
 *                  {t:'error', id?, message}
 *                  {t:'disposed'}
 *
 * `data` (Float32Array) is used on Electron utility processes (structured
 * clone keeps typed arrays); `b64` on plain Node fork IPC (JSON channel).
 *
 * The function body references only require/process globals — no runtime
 * closure captures (type references are erased) — so `fn.toString()` emits a
 * script that runs verbatim in both child runtimes.
 */
export function buildOnnxWorkerSource(): string {
  const worker = function onnxWorkerMain() {
    'use strict';

    // IPC transport: Obsidian's Electron utility-process child exposes the
    // port as process.parentPort (a MessagePort); stock Electron exposes it
    // on require('electron'); a plain Node fork uses process.send. (In plain
    // Node require('electron') yields a path string, hence the object check.)
    // Note: Obsidian's child has NO parentPort on the electron module —
    // falling back to it first would silently drop every worker message.
    let parentPort: ParentPortLike | null = null;
    try {
      // Obsidian's utility-process child type lacks this member; runtime shape verified by the smoke probe.
      const proc = process as unknown as { parentPort?: ParentPortLike };
      if (proc.parentPort) parentPort = proc.parentPort;
    } catch (err) {
      parentPort = null;
    }
    if (parentPort === null) {
      try {
        // External module boundary: shape fixed by Electron's utilityProcess docs.
        const electron = require('electron') as { parentPort?: ParentPortLike } | null;
        if (electron && typeof electron === 'object' && electron.parentPort) {
          parentPort = electron.parentPort;
        }
      } catch (err) {
        parentPort = null; // plain Node fork
      }
    }
    const send = (msg: unknown): void => {
      if (parentPort) parentPort.postMessage(msg);
      else if (typeof process.send === 'function') process.send(msg);
    };
    const onMessage = (cb: (raw: unknown) => void): void => {
      if (parentPort) parentPort.on('message', (e) => cb(e.data));
      else process.on('message', (raw) => cb(raw));
    };
    // Local (not the module-level helper): the worker is serialized via
    // toString() and runs in another process, so it must be self-contained.
    const failMessage = (e: unknown): string =>
      e instanceof Error ? e.message : String(e);
    let pipe: PipelineFn | null = null;
    let loaded = false;
    let shuttingDown = false;
    let inflight = 0;
    // Serial queue: load, every infer, and dispose run strictly in order.
    let queue: Promise<unknown> = Promise.resolve();

    const finishIfIdle = (): void => {
      if (shuttingDown && inflight === 0) {
        send({ t: 'disposed' });
        process.exit(0);
      }
    };

    const runLoad = (msg: LoadRequest): Promise<unknown> => {
      // Same installed-plugin resolution the renderer used to perform.
      const tfRequire = require('module').createRequire(
        require('path').join(msg.pluginDir, 'main.js')
      );
      return Promise.resolve()
        .then(() => tfRequire('@huggingface/transformers'))
        .then((tf) => {
          // External module boundary: the transformers.js v4 surface this worker needs.
          const mod = tf as TransformersLike;
          mod.env.cacheDir = msg.cacheDir;
          const opts: Record<string, unknown> = {
            device: msg.device,
            dtype: msg.dtype,
            progress_callback: (p: unknown) => {
              const event = p as WireRecord;
              if (
                event &&
                event.status === 'progress' &&
                typeof event.file === 'string' &&
                event.file
              ) {
                const pct =
                  typeof event.progress === 'number' ? Math.round(event.progress) : 0;
                send({
                  t: 'progress',
                  message: `Downloading ${event.file} for ${msg.model}: ${pct}%`,
                });
              }
            },
          };
          // BFCArena power-of-two over-extension was the allocator path in
          // the renderer crash stacks; keep the CPU arena off.
          if (msg.device === 'cpu') opts.session_options = { enableCpuMemArena: false };
          if (msg.subfolder !== undefined) opts.subfolder = msg.subfolder;
          if (msg.model_file_name !== undefined) opts.model_file_name = msg.model_file_name;
          return mod.pipeline('feature-extraction', msg.model, opts);
        })
        .then((pl) => {
          pipe = pl;
          loaded = true;
          send({ t: 'loaded' });
          finishIfIdle();
        })
        .catch((err) => {
          // Report the error and stay idle: the host rejects the load and
          // disposes us (exit on process.exit() right after send could drop
          // the IPC message before it is flushed).
          send({ t: 'error', message: failMessage(err) });
        });
    };

    const runInfer = (msg: InferRequest): Promise<unknown> => {
      inflight += 1;
      return Promise.resolve()
        .then(() => {
          if (!pipe || !loaded) throw new Error('Model not loaded');
          return pipe(msg.text, msg.options ?? {});
        })
        .then((out) => {
          const arr: unknown = out && out.data;
          if (!arr || (typeof arr !== 'object' && typeof arr !== 'function')) {
            throw new Error('Pipeline returned no data');
          }
          const f32 =
            arr instanceof Float32Array
              ? arr
              : // Tensor-backed ArrayLike coming back from transformers.js.
                Float32Array.from(arr as ArrayLike<number>);
          if (parentPort) {
            send({ t: 'result', id: msg.id, data: f32 });
          } else {
            send({
              t: 'result',
              id: msg.id,
              b64: Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64'),
            });
          }
        })
        .catch((err) => {
          send({ t: 'error', id: msg.id, message: failMessage(err) });
        })
        .then(() => {
          inflight -= 1;
          finishIfIdle();
        });
    };

    onMessage((raw) => {
      if (!raw || typeof raw !== 'object') return;
      // Wire-protocol boundary: messages are produced by the host side of this
      // module; the shape is fixed by the protocol documented above.
      const msg = raw as ChildRequest;
      if (msg.t === 'load') {
        queue = queue.then(() => runLoad(msg));
      } else if (msg.t === 'infer') {
        queue = queue.then(() => runInfer(msg));
      } else if (msg.t === 'dispose') {
        shuttingDown = true;
        queue = queue.then(() => {
          send({ t: 'disposed' });
          process.exit(0);
        });
      }
    });

    send({ t: 'ready' });
  };

  // Parenthesized so the emitted script is an invoked function expression:
  // `function onnxWorkerMain() {...}` in statement position would be a
  // declaration, and the trailing `();` after it would be a syntax error.
  return `('use strict');\n(${worker.toString()})();\n`;
}

/**
 * Copy model resources that transformers.js v4 cached in the renderer's
 * Chromium CacheStorage into the node filesystem cache layout, so the child
 * process works fully offline.
 *
 * Mapping: CacheStorage key `https://huggingface.co/<repo>/resolve/<rev>/<file>`
 * -> `<pluginDir>/models/<repo>/<file>` for the default `main` revision
 * (exactly what transformers.js FileCache reads/writes); other revisions map
 * to `<repo>/<rev>/<file>`. Only keys for the requested model are copied.
 *
 * Bodies are streamed (no whole-response arrayBuffer), existing files whose
 * size matches are skipped, and writes are atomic (temp file + rename) so a
 * partially written file can never masquerade as a complete model file.
 * No-op outside a DOM environment (plain Node tests).
 */
export async function seedModelFilesFromBrowserCache(
  pluginDir: string,
  model: string,
  signal?: AbortSignal
): Promise<void> {
  // DOM Cache API exists only in the renderer; read it behind a guard.
  const globalWithCaches = globalThis as {
    caches?: { open(name: string): Promise<Cache> };
  };
  const cachesGlobal = globalWithCaches.caches;
  if (!cachesGlobal) return;

  if (signal?.aborted) {
    throw new OnnxProcessError('Model cache seeding was cancelled');
  }

  const cacheDir = join(pluginDir, 'models');
  let cache: Cache;
  try {
    cache = await cachesGlobal.open(TRANSFORMERS_CACHE_KEY);
  } catch (err) {
    return; // CacheStorage unavailable; the FS cache is complete or the child will download.
  }

  const prefix = `/${model}/resolve/`;
  const keys = await cache.keys();
  for (const key of keys) {
    if (signal?.aborted) {
      throw new OnnxProcessError('Model cache seeding was cancelled');
    }
    let rel: string;
    try {
      const url = new URL(key.url);
      if (!url.pathname.startsWith(prefix)) continue;
      const rest = url.pathname.slice(prefix.length); // <rev>/<file>
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const revision = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      if (!file || file.includes('\0')) continue;
      // FileCache layout: <repo>/<file> for the main revision,
      // <repo>/<revision>/<file> otherwise.
      rel = revision === 'main' ? file : `${revision}/${file}`;
    } catch (err) {
      continue; // non-HTTP key; not a model resource
    }
    if (rel.includes('\0') || rel.includes('..')) continue;
    const dest = join(cacheDir, model, rel);

    let resp: Response | undefined;
    try {
      resp = await cache.match(key);
    } catch (err) {
      continue;
    }
    if (!resp) continue;

    const expected = Number(resp.headers.get('content-length') ?? -1);
    try {
      if (expected >= 0 && existsSync(dest) && statSync(dest).size === expected) continue;
    } catch (err) {
      // stat failed; fall through and rewrite.
    }

    const tmp = `${dest}.part-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      await streamToFile(resp.body, tmp, signal);
      renameSync(tmp, dest);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch (cleanupErr) {
        // best effort
      }
      throw new OnnxProcessError(
        `Failed to seed cached model file '${rel}' for '${model}': ${errorMessage(err)}`
      );
    }
  }
}

async function streamToFile(
  body: ReadableStream<Uint8Array> | null,
  dest: string,
  signal?: AbortSignal
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(dest);
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(err);
    };
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    if (!body) {
      out.end();
      return;
    }
    const reader = body.getReader();
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          if (signal?.aborted) {
            throw new OnnxProcessError('Model cache seeding was cancelled');
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (!out.write(value)) {
            // Settle on drain OR error so a destroyed stream can't stall the
            // back-pressure wait.
            await new Promise<void>((r) => {
              out.once('drain', () => r());
              out.once('error', () => r());
            });
          }
        }
        out.end();
      } catch (err) {
        fail(err as Error);
      } finally {
        // Always stop the body stream and release the CacheStorage reader,
        // even when the writer fails mid-file.
        reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    };
    void pump();
  });
}

function writeWorkerFile(cacheDir: string, source: string): string {
  mkdirSync(cacheDir, { recursive: true });
  const name = `.onnx-worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.cjs`;
  const workerPath = join(cacheDir, name);
  writeFileSync(workerPath, source, 'utf8');
  return workerPath;
}

/** Minimal structural surface shared by utilityProcess children and fork(). */
interface SpawnHandle {
  postMessage(msg: unknown): void;
  on(type: 'message' | 'exit' | 'error', cb: (...args: unknown[]) => void): unknown;
  stdout?: { on(type: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(type: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: string): boolean | undefined;
  removeAllListeners?(): unknown;
  readonly pid?: number;
}

interface UtilityProcessApi {
  fork(file: string, args: string[], options: Record<string, unknown>): unknown;
}

function resolveUtilityProcess(): UtilityProcessApi | null {
  try {
    // Obsidian's renderer exposes the main-process module via `remote`
    // (proven on the current Obsidian build); shape per Electron docs.
    const electron = require('electron') as {
      remote?: { require(id: string): { utilityProcess?: UtilityProcessApi } };
    } | null;
    const up = electron?.remote?.require?.('electron')?.utilityProcess;
    if (up) return up;
  } catch (err) {
    // not Electron / no remote
  }
  try {
    // Non-literal require: the package is not a build-time dependency; it is
    // resolved at runtime when present (also provided by Obsidian).
    const remote = require('@electron/' + 'remote') as {
      require?: (id: string) => { utilityProcess?: UtilityProcessApi };
      utilityProcess?: UtilityProcessApi;
    } | null;
    const up = remote?.require?.('electron')?.utilityProcess ?? remote?.utilityProcess;
    if (up) return up;
  } catch (err) {
    // not installed
  }
  return null;
}

function spawnWorker(workerPath: string): SpawnHandle {
  if (process.versions.electron) {
    const up = resolveUtilityProcess();
    if (!up) {
      throw new OnnxProcessError(
        'Cannot isolate ONNX inference: Electron utilityProcess is unavailable ' +
          '(require("electron").remote). A child process is required; refusing to ' +
          'run ONNX in the renderer.'
      );
    }
    // The utilityProcess child implements the EventEmitter surface above.
    // (Per Electron docs, its 'message' event delivers the raw message on the
    // parent side; only the child's parentPort wraps payloads in an event.)
    return up.fork(workerPath, [], {
      stdio: 'pipe',
      serviceName: 'Obsidian RAG embeddings',
      allowLoadingUnsignedLibraries: true,
    }) as unknown as SpawnHandle;
  }
  // Plain Node (unit tests only): fork with an IPC channel. Deliberately NOT
  // used inside Electron — the Obsidian build has the RunAsNode fuse disabled,
  // so process.execPath does not run Node there. ChildProcess.send is the
  // fork equivalent of the utilityProcess parent's postMessage, so adapt the
  // handle to the shared SpawnHandle surface.
  const child = fork(workerPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  return {
    postMessage: (msg: unknown) => {
      // Pinned @types/node narrows ChildProcess.send to Serializable; the
      // wire records are plain JSON-safe protocol objects.
      child.send(msg as object);
    },
    on: (type, cb) => child.on(type, cb),
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal?: string) => child.kill(signal as NodeJS.Signals | undefined),
    removeAllListeners: () => child.removeAllListeners(),
    get pid() {
      return child.pid;
    },
  };
}

interface Pending {
  resolve(data: { data: ArrayLike<number> }): void;
  reject(err: Error): void;
}

class ProcessPipelineHost {
  private child: SpawnHandle | null = null;
  private workerPath: string | null = null;
  private onProgress: ((message: string) => void) | null;
  private disposed = false;
  private dead = false;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private stderrTail = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readySettled = false;
  private loadSettled = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private loadResolve: (() => void) | null = null;
  private loadReject: ((err: Error) => void) | null = null;
  private exitWaiters: Array<() => void> = [];
  private readyPromise: Promise<void> | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(onProgress?: (message: string) => void) {
    this.onProgress = onProgress ?? null;
  }

  /** Live child pid. For utilityProcess it is undefined until 'spawn'. */
  get pid(): number | undefined {
    return this.child ? this.child.pid : undefined;
  }

  /**
   * Resolves when the child signals ready (bootstrap + IPC handshake only —
   * no model work). Rejects if the child dies or fails to start.
   */
  waitForReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }
    return this.readyPromise;
  }

  /**
   * Resolves when the model is loaded in the child. Deliberately no hard
   * timeout: first-use downloads and session creation can legitimately run
   * for a long time. Rejects only on child death or a reported load error.
   */
  waitForLoad(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = new Promise<void>((resolve, reject) => {
        this.loadResolve = resolve;
        this.loadReject = reject;
      });
    }
    return this.loadPromise;
  }

  attach(child: SpawnHandle, workerPath: string): void {
    this.child = child;
    this.workerPath = workerPath;
    // Both transports deliver the raw message on the host's 'message' event
    // (fork IPC and utilityProcess per Electron docs).
    child.on('message', (raw) => {
      this.handleMessage(raw);
    });
    child.on('exit', (code, signal) => this.onExit(toNullableNumber(code), toSignal(signal)));
    // 'error' shape differs by transport: fork emits an Error on spawn failure;
    // utilityProcess (experimental) emits (type, location, report) on a V8
    // fatal. Either way the child is dying, so fail() everything.
    child.on('error', (first, ...rest) => {
      const detail = first instanceof Error ? first.message : [first, ...rest].map(String).filter(Boolean).join(' | ');
      this.fail(new OnnxProcessError(`Embedding child process error: ${detail || 'unknown'}`));
    });
    // stdout is drained (never stored) to keep the pipe from stalling the child.
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk: Buffer | string) => this.tail(chunk));
  }

  infer(text: string, options?: Record<string, unknown>): Promise<{ data: ArrayLike<number> }> {
    if (this.disposed) {
      return Promise.reject(new OnnxProcessError('Embedding pipeline has been disposed'));
    }
    if (this.dead) {
      return Promise.reject(
        new OnnxProcessError(
          `Embedding child process is not running (code=${this.exitInfo?.code ?? 'null'}, signal=${this.exitInfo?.signal ?? 'null'})`,
          this.exitInfo?.code ?? null,
          this.exitInfo?.signal ?? null
        )
      );
    }
    const id = this.nextId++;
    return new Promise<{ data: ArrayLike<number> }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child!.postMessage({ t: 'infer', id, text, options: options ?? {} });
      } catch (err) {
        this.pending.delete(id);
        reject(new OnnxProcessError(`Failed to send inference request: ${errorMessage(err)}`));
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (!child || this.dead) {
      this.dead = true;
      this.cleanup();
      return;
    }
    try {
      child.postMessage({ t: 'dispose' });
    } catch (err) {
      // channel already closing; exit handling continues
    }
    await Promise.race([this.waitForExit(), delay(DISPOSE_TIMEOUT_MS)]);
    if (!this.dead) {
      // utilityProcess.kill() takes no signal (always SIGTERM), which a stuck
      // native call may not answer — escalate to an OS-level SIGKILL by pid,
      // then fall back to the handle's own kill() (SIGTERM for utility).
      const pid = child.pid;
      if (typeof pid === 'number') {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err) {
          // already gone or not permitted; handle fallback still runs
        }
      }
      try {
        child.kill('SIGKILL');
      } catch (err) {
        // already gone
      }
      await Promise.race([this.waitForExit(), delay(KILL_TIMEOUT_MS)]);
    }
    this.dead = true;
    this.cleanup();
  }

  /** Reject ready/load and every pending infer (first failure wins). */
  fail(err: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyReject?.(err);
    }
    if (!this.loadSettled) {
      this.loadSettled = true;
      this.loadReject?.(err);
    }
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err);
    }
  }

  private onExit(code: number | null, signal: string | null): void {
    this.exitInfo = { code, signal };
    if (!this.disposed && (code !== 0 || signal !== null)) {
      const tail = this.stderrTail.trim();
      this.fail(
        new OnnxProcessError(
          `Embedding child process exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})${
            tail ? `. Last stderr: ${tail}` : ''
          }`,
          code,
          signal
        )
      );
    }
    // The child is gone: its worker file is no longer needed regardless of
    // whether the caller disposes.
    this.removeWorkerFile();
    this.dead = true;
    this.child = null;
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    // Wire-protocol boundary: messages are produced by the worker side of this
    // module; the shape is fixed by the protocol documented above.
    const msg = raw as WireRecord;
    if (msg.t === 'ready') {
      if (!this.readySettled) {
        this.readySettled = true;
        this.readyResolve?.();
      }
    } else if (msg.t === 'loaded') {
      if (!this.loadSettled) {
        this.loadSettled = true;
        this.loadResolve?.();
      }
    } else if (msg.t === 'progress') {
      if (typeof msg.message === 'string') this.onProgress?.(msg.message);
    } else if (msg.t === 'result') {
      const id = msg.id;
      if (typeof id !== 'number') return;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      p.resolve({ data: decodeVector(msg) });
    } else if (msg.t === 'error') {
      const message = typeof msg.message === 'string' ? msg.message : 'unknown child error';
      const id = msg.id;
      if (typeof id === 'number') {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          // Well-formed per-inference error: the child reported it and is
          // still running, so the pipeline stays reusable (childDead=false).
          p.reject(new OnnxProcessError(message, null, null, false));
        }
      } else if (!this.loadSettled) {
        this.loadSettled = true;
        this.loadReject?.(new OnnxProcessError(message));
      }
    } else if (msg.t === 'disposed') {
      this.dead = true;
    }
  }

  private tail(chunk: Buffer | string): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
  }

  private waitForExit(): Promise<void> {
    if (this.dead) return Promise.resolve();
    return new Promise<void>((resolve) => this.exitWaiters.push(resolve));
  }

  /** Remove the worker script; idempotent. Called on every child exit. */
  private removeWorkerFile(): void {
    if (!this.workerPath) return;
    const workerPath = this.workerPath;
    this.workerPath = null;
    try {
      if (existsSync(workerPath)) unlinkSync(workerPath);
    } catch (err) {
      // best effort
    }
  }

  private cleanup(): void {
    try {
      this.child?.removeAllListeners?.();
    } catch (err) {
      // ignore
    }
    this.child = null;
    this.removeWorkerFile();
    for (const [, p] of this.pending) {
      p.reject(new OnnxProcessError('Embedding pipeline disposed before the request completed'));
    }
    this.pending.clear();
  }
}


function toNullableNumber(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function toSignal(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function decodeVector(msg: WireRecord): ArrayLike<number> {
  const { data, b64 } = msg;
  if (data instanceof Float32Array) return data;
  if (typeof b64 === 'string') {
    const buf = Buffer.from(b64, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  }
  if (!data) {
    throw new OnnxProcessError('Malformed inference result from child process');
  }
  // Fallback: tensor-backed ArrayLike serialized as a plain array.
  return Float32Array.from(data as ArrayLike<number>);
}

function delay(ms: number): Promise<void> {
  // Promise.withResolvers is unavailable on the Electron 30 (Node 20) runtime.
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Node's Timeout has unref(); the DOM type is a number.
    if (typeof timer === 'object' && timer !== null) {
      const nodeTimer = timer as { unref?: () => void };
      nodeTimer.unref?.();
    }
  });
}

function withTimeout(promise: Promise<void>, ms: number, message: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OnnxProcessError(message)), ms);
    if (typeof timer === 'object' && timer !== null) {
      const nodeTimer = timer as { unref?: () => void };
      nodeTimer.unref?.();
    }
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Rejects the moment `signal` aborts (never settles without a signal).
 * Makes the creation phase cancellable without imposing an arbitrary timeout
 * on a legitimate model download.
 */
function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!signal) return;
    const fail = (): void =>
      reject(new OnnxCreateCancelledError());
    if (signal.aborted) {
      queueMicrotask(fail);
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

/** `promise`, unless `signal` aborts first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return Promise.race([promise, aborted(signal)]);
}

/**
 * Create a feature-extraction pipeline that runs entirely in a disposable
 * child process. Resolves after the model is loaded in the child; rejects
 * (with the child's own error message preserved, e.g. a missing
 * '@huggingface/transformers' dependency) if spawn or load fails.
 */
export async function createOnnxProcessPipeline(
  opts: OnnxProcessPipelineOptions
): Promise<OnnxProcessPipeline> {
  if (!opts.pluginDir) {
    throw new OnnxProcessError(
      'pluginDir is required to locate the model cache and worker dependencies'
    );
  }
  const cacheDir = join(opts.pluginDir, 'models');
  if (opts.signal?.aborted) {
    throw new OnnxCreateCancelledError();
  }

  // Offline support: stream renderer-side CacheStorage resources into the
  // node FS cache layout before the child starts.
  await seedModelFilesFromBrowserCache(opts.pluginDir, opts.model, opts.signal);

  let workerPath: string;
  try {
    workerPath = writeWorkerFile(cacheDir, opts.workerSource ?? buildOnnxWorkerSource());
  } catch (err) {
    throw new OnnxProcessError(
      `Failed to write ONNX worker script: ${errorMessage(err)}`
    );
  }

  let spawned: SpawnHandle;
  try {
    spawned = spawnWorker(workerPath);
  } catch (err) {
    try {
      unlinkSync(workerPath);
    } catch (cleanupErr) {
      // best effort
    }
    throw err instanceof OnnxProcessError
      ? err
      : new OnnxProcessError(
          `Failed to start embedding child process: ${errorMessage(err)}`
        );
  }

  const host = new ProcessPipelineHost(opts.onProgress);
  host.attach(spawned, workerPath);

  try {
    // The ready timeout bounds bootstrap + IPC handshake only; no model work
    // has started yet.
    await raceAbort(
      withTimeout(host.waitForReady(), READY_TIMEOUT_MS, 'Embedding child process did not become ready'),
      opts.signal
    );
    const loadMsg: LoadRequest = {
      t: 'load',
      pluginDir: opts.pluginDir,
      cacheDir,
      model: opts.model,
      device: opts.device,
      dtype: opts.dtype,
    };
    if (opts.subfolder !== undefined) loadMsg.subfolder = opts.subfolder;
    if (opts.model_file_name !== undefined) loadMsg.model_file_name = opts.model_file_name;
    spawned.postMessage(loadMsg);
    // The load promise is created only after the handshake so a child that
    // dies in bootstrap cannot leave an unhandled rejected promise. No hard
    // timeout: first-use downloads may run for a long time; only explicit
    // cancellation (opts.signal) interrupts them.
    await raceAbort(host.waitForLoad(), opts.signal);
  } catch (err) {
    await host.dispose().catch(() => {});
    throw err instanceof OnnxProcessError
      ? err
      : new OnnxProcessError(
          `Failed to load ONNX model in child process: ${errorMessage(err)}`
        );
  }

  const callable = (text: string, options?: Record<string, unknown>) =>
    host.infer(text, options);
  return Object.assign(callable, {
    dispose: () => host.dispose(),
    // Read live: a utilityProcess pid is only set after the 'spawn' event.
    get pid() {
      return host.pid;
    },
  }) as OnnxProcessPipeline;
}
