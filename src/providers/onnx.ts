/**
 * Self-hosted embedding provider.
 *
 * Runs a small ONNX embedding model via transformers.js + onnxruntime.
 * Production loads and forwards run in a disposable child process
 * (see onnx-process.ts) so a native ONNX fault can only take down that child,
 * never the Obsidian renderer. The model is downloaded from Hugging Face once
 * (or streamed from the renderer's CacheStorage into the disk cache), then
 * cached in <pluginDir>/models — no network at query time.
 *
 * The `loader` option remains for deterministic unit tests: an injected
 * transformers.js module runs in-process. The production path never loads
 * ONNX in the renderer.
 */
import { join } from 'path';
import { EmbedResult, IEmbedder, PingResult, ProviderError } from './types';
import {
  OnnxCreateCancelledError,
  OnnxProcessError,
  OnnxProcessPipeline,
  createOnnxProcessPipeline,
} from './onnx-process';

/** Curated models known to ship ONNX variants. Values drive the settings dropdown. */
export interface OnnxModelInfo {
  label: string;
  dimension: number;
  /**
   * Explicit file layout for repos that don't follow the Xenova `onnx/`
   * convention (file at repo root, non-standard variant name). When present,
   * the dtype fallback ladder is skipped — the repo ships exactly this file.
   */
  load?: { subfolder?: string; model_file_name?: string; dtype?: string };
}

export const ONNX_MODELS: Record<string, OnnxModelInfo> = {
  'Xenova/all-MiniLM-L6-v2': { label: 'all-MiniLM-L6-v2 (384d, fast, English)', dimension: 384 },
  'Xenova/all-mpnet-base-v2': { label: 'all-mpnet-base-v2 (768d, strong, English)', dimension: 768 },
  'Xenova/bge-small-en-v1.5': { label: 'bge-small-en-v1.5 (384d, strong, English)', dimension: 384 },
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': { label: 'paraphrase-multilingual-MiniLM-L12-v2 (384d, multilingual)', dimension: 384 },
  'keisuke-miyako/nomic-embed-text-v1.5-onnx-int8': {
    label: 'nomic-embed-text-v1.5 int8 (768d — same family as LM Studio nomic)',
    dimension: 768,
    load: { subfolder: '', model_file_name: 'model_quantized', dtype: 'fp32' },
  },
};

export const DEFAULT_ONNX_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Minimal surface of the transformers.js module the provider needs. */
export interface TransformersModule {
  env: { cacheDir: string };
  pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>
  ): Promise<FeatureExtractionPipeline>;
}

export interface FeatureExtractionPipeline {
  (text: string, options?: Record<string, unknown>): Promise<{ data: ArrayLike<number> }>;
}

export interface OnnxEmbedderOptions {
  /** Hugging Face repo id of the embedding model. */
  model: string;
  /** Directory of the plugin (where `models/` cache lives). */
  pluginDir: string;
  /** Optional: lets the UI surface download progress. */
  onProgress?: (message: string) => void;
  /** Execution device. 'coreml' (Apple Silicon) falls back to 'cpu' if unsupported. */
  device?: 'cpu' | 'coreml';
  /** Optional: inject a fake transformers.js module for deterministic unit
   * tests (in-process pipeline). Omit in production — loads then run in the
   * isolated child process. */
  loader?: () => Promise<TransformersModule>;
}

export class OnnxEmbedder implements IEmbedder {
  private pipePromise: Promise<FeatureExtractionPipeline> | null = null;
  private processPipe: OnnxProcessPipeline | null = null;
  /** Cancels the in-flight pipeline creation (bounded) when dispose() runs. */
  private creationController: AbortController | null = null;
  /**
   * Monotonic generation. Each load captures it; only the current generation
   * may install `processPipe`, so a load that settles after a dispose (or a
   * newer load) cannot orphan a child or steal ownership of a live one.
   */
  private generation = 0;

  constructor(private readonly options: OnnxEmbedderOptions) {}

  private loadPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipePromise) {
      const gen = this.generation;
      const controller = new AbortController();
      this.creationController = controller;
      const promise = this.load(controller.signal, gen)
        .then(pipe => {
          this.options.onProgress?.(`Embedding model ready (${this.options.model})`);
          return pipe;
        })
        .catch(err => {
          // Allow a retry after a failed load, but only if this load is still
          // the current one (a dispose + newer load has already taken over).
          if (this.pipePromise === promise) {
            this.pipePromise = null;
            this.processPipe = null;
          }
          throw err;
        });
      this.pipePromise = promise;
    }
    return this.pipePromise;
  }

  private async load(signal: AbortSignal, gen: number): Promise<FeatureExtractionPipeline> {
    const load = ONNX_MODELS[this.options.model]?.load;
    const dtypes: string[] = load?.dtype ? [load.dtype] : ['q8', 'fp32'];
    const preferred = this.options.device ?? 'cpu';
    const devices: string[] = preferred === 'coreml' ? ['coreml', 'cpu'] : ['cpu'];
    const fileOpts = this.fileOptions();

    if (this.options.loader) {
      // Unit-test path: an injected transformers.js module runs in-process.
      let tf: TransformersModule;
      try {
        tf = await this.options.loader();
        tf.env.cacheDir = join(this.options.pluginDir, 'models');
      } catch (err) {
        throw this.wrapLoadError(err);
      }

      let lastErr: unknown = null;
      for (const device of devices) {
        for (const dtype of dtypes) {
          try {
            return await this.buildPipeline(tf, { device, dtype, ...fileOpts });
          } catch (err) {
            lastErr = err;
            this.options.onProgress?.(
              `ONNX load failed (${device}/${dtype}), trying next variant: ${(err as Error).message}`
            );
          }
        }
      }
      throw this.wrapLoadError(lastErr);
    }

    // Production path: each variant attempt loads in a fresh disposable child
    // process; a failed attempt's child is cleaned up by the helper.
    let lastErr: unknown = null;
    for (const device of devices) {
      for (const dtype of dtypes) {
        try {
          const pipe = await createOnnxProcessPipeline({
            pluginDir: this.options.pluginDir,
            model: this.options.model,
            device,
            dtype,
            ...fileOpts,
            onProgress: this.options.onProgress,
            signal,
          });
          if (gen === this.generation) {
            this.processPipe = pipe;
          } else {
            // Superseded (a dispose or newer load raced us): release the child
            // we just created instead of leaking it.
            await pipe.dispose().catch(() => {});
          }
          return pipe;
        } catch (err) {
          // Cancellation (a concurrent dispose) is not a variant failure —
          // do not fall through to the next device/dtype.
          if (err instanceof OnnxCreateCancelledError) throw err;
          lastErr = err;
          this.options.onProgress?.(
            `ONNX load failed (${device}/${dtype}), trying next variant: ${(err as Error).message}`
          );
        }
      }
    }
    throw this.wrapLoadError(lastErr);
  }

  /** File-layout overrides for repos with a non-standard ONNX layout. */
  private fileOptions(): { subfolder?: string; model_file_name?: string } {
    const load = ONNX_MODELS[this.options.model]?.load;
    return load?.subfolder !== undefined || load?.model_file_name !== undefined
      ? { subfolder: load?.subfolder, model_file_name: load?.model_file_name }
      : {};
  }

  private async buildPipeline(
    tf: TransformersModule,
    opts: { device: string; dtype: string; subfolder?: string; model_file_name?: string }
  ): Promise<FeatureExtractionPipeline> {
    const progress = this.options.onProgress;
    return await tf.pipeline('feature-extraction', this.options.model, {
      ...opts,
      progress_callback: (p: Record<string, unknown>) => {
        const file = typeof p.file === 'string' ? p.file : '';
        if (p.status === 'progress' && file) {
          const pct = typeof p.progress === 'number' ? Math.round(p.progress) : 0;
          progress?.(`Downloading ${file} for ${this.options.model}: ${pct}%`);
        }
      },
    });
  }

  /** Maps raw load/loader failures to actionable ProviderErrors. */
  private wrapLoadError(err: unknown): ProviderError {
    const message = err instanceof Error ? err.message : String(err);
    return new ProviderError(
      `Failed to load embedding model '${this.options.model}': ${message}`,
      'MODEL_NOT_FOUND',
      err as Error
    );
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const gen = this.generation;
    let pipe: FeatureExtractionPipeline;
    try {
      pipe = await this.loadPipeline();
    } catch (err) {
      if (err instanceof OnnxCreateCancelledError) {
        throw new ProviderError('Embedding model load was cancelled', 'STREAM_ABORTED', err);
      }
      throw err;
    }
    const embeddings: number[][] = [];
    for (const text of texts) {
      let out: { data: ArrayLike<number> };
      try {
        out = await pipe(text, { pooling: 'mean', normalize: true });
      } catch (err) {
        if (err instanceof OnnxProcessError && err.childDead && gen === this.generation) {
          // The child died mid-batch (crash/kill/dispose): drop the dead
          // pipeline so the next call spawns a fresh one. A well-formed
          // per-inference error (childDead=false) leaves the pipeline reusable.
          this.pipePromise = null;
          this.processPipe = null;
        }
        throw new ProviderError(
          `ONNX inference failed: ${(err as Error).message ?? String(err)}`,
          'UNEXPECTED_RESPONSE',
          err as Error
        );
      }
      embeddings.push(Array.from(out.data));
    }
    return { embeddings, dimension: embeddings[0].length };
  }

  /**
   * Release the embedding pipeline: terminates the isolated child process and
   * frees the loaded model. Idempotent; a later embed()/ping() starts a fresh
   * pipeline.
   */
  async dispose(): Promise<void> {
    this.generation += 1;
    const controller = this.creationController;
    this.creationController = null;
    const inFlight = this.pipePromise;
    this.pipePromise = null;
    const pipe = this.processPipe;
    this.processPipe = null;
    // Cancel an in-flight creation FIRST: abort the cache-seeding streams and
    // terminate any spawned child (bounded), without waiting for a hung load
    // (download / native session creation) to settle.
    controller?.abort();
    if (pipe) {
      try {
        await pipe.dispose();
      } catch (err) {
        // child already gone
      }
    }
    // Bounded settle: a normal creation finishes quickly; the bound keeps an
    // unload from blocking on a pathologically hung load. The abort above
    // already bounded that child's own disposal (5s grace + 2s force).
    if (inFlight) {
      await Promise.race([inFlight, delayMs(8000)]).catch(() => {});
    }
  }

  /**
   * Full round-trip: loads (and on first run downloads) the model, then embeds
   * a sample. Doubles as the "Test Connection" probe for this provider.
   */
  async ping(): Promise<PingResult> {
    const start = Date.now();
    try {
      const result = await this.embed(['round-trip probe']);
      return {
        reachable: true,
        latencyMs: Date.now() - start,
        sampleResponse: `${result.dimension}-dim vector`,
      };
    } catch (err) {
      return {
        reachable: false,
        latencyMs: Date.now() - start,
        errorMessage: err instanceof ProviderError ? err.message : (err as Error).message,
      };
    }
  }

  async listModels(): Promise<string[]> {
    return Object.keys(ONNX_MODELS);
  }
}

/** Unref'd bounded delay so a pending settle timer never keeps the process alive. */
function delayMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && timer !== null) {
      (timer as { unref?: () => void }).unref?.();
    }
  });
}
