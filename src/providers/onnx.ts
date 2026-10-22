/**
 * Self-hosted (in-process) embedding provider.
 *
 * Runs a small ONNX embedding model inside Obsidian's Node process via
 * transformers.js + onnxruntime-node (N-API native binding, ABI-stable across
 * Electron). No external server, no network at query time: the model is
 * downloaded from Hugging Face once, then cached in <pluginDir>/models.
 *
 * The transformers.js module is loaded lazily (CJS require, executed only on
 * first use) so the native binding only loads when this provider is selected.
 */
import { join } from 'path';
import { createRequire } from 'module';
import { EmbedResult, IEmbedder, PingResult, ProviderError } from './types';

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
  /** Optional: inject a fake module in tests. */
  loader?: () => Promise<TransformersModule>;
}

export class OnnxEmbedder implements IEmbedder {
  private pipePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(private readonly options: OnnxEmbedderOptions) {}

  private defaultLoader(): () => Promise<TransformersModule> {
    return async () => {
      // Obsidian's require is renderer-rooted. Resolve external dependencies
      // explicitly from the installed plugin; keep native loading lazy.
      const requireFromPlugin = createRequire(join(this.options.pluginDir, 'main.js'));
      const tf = requireFromPlugin('@huggingface/transformers') as TransformersModule;
      tf.env.cacheDir = join(this.options.pluginDir, 'models');
      return tf;
    };
  }

  private loadPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipePromise) {
      this.pipePromise = this.load()
        .then(pipe => {
          this.options.onProgress?.(`Embedding model ready (${this.options.model})`);
          return pipe;
        })
        .catch(err => {
          // Allow a retry after a failed load (e.g. interrupted download)
          this.pipePromise = null;
          throw err;
        });
    }
    return this.pipePromise;
  }

  private async load(): Promise<FeatureExtractionPipeline> {
    let tf: TransformersModule;
    try {
      tf = await (this.options.loader ?? this.defaultLoader())();
    } catch (err) {
      throw this.wrapLoadError(err);
    }

    const load = ONNX_MODELS[this.options.model]?.load;
    const dtypes: string[] = load?.dtype ? [load.dtype] : ['q8', 'fp32'];
    const preferred = this.options.device ?? 'cpu';
    const devices: string[] = preferred === 'coreml' ? ['coreml', 'cpu'] : ['cpu'];

    let lastErr: unknown = null;
    for (const device of devices) {
      for (const dtype of dtypes) {
        try {
          return await this.createPipeline(tf, { device, dtype, ...this.fileOptions() });
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

  /** File-layout overrides for repos with a non-standard ONNX layout. */
  private fileOptions(): { subfolder?: string; model_file_name?: string } {
    const load = ONNX_MODELS[this.options.model]?.load;
    return load?.subfolder !== undefined || load?.model_file_name !== undefined
      ? { subfolder: load?.subfolder, model_file_name: load?.model_file_name }
      : {};
  }

  private async createPipeline(
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
    const pipe = await this.loadPipeline();
    const embeddings: number[][] = [];
    for (const text of texts) {
      let out: { data: ArrayLike<number> };
      try {
        out = await pipe(text, { pooling: 'mean', normalize: true });
      } catch (err) {
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
