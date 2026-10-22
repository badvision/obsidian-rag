import {
  OnnxEmbedder,
  OnnxEmbedderOptions,
  ONNX_MODELS,
  DEFAULT_ONNX_MODEL,
  TransformersModule,
} from './onnx';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';


/**
 * Fake transformers.js module. `pipeline` resolves to a fake feature-extraction
 * pipeline; both are jest mocks so tests can assert on calls.
 */
function makeFakeTf(dims = 3): {
  mod: TransformersModule;
  loader: () => Promise<TransformersModule>;
  pipeline: jest.Mock;
  pipe: jest.Mock;
} {
  // Deterministic vector content: index-based, so callers can assert exact values
  const pipe = jest.fn().mockImplementation(async () => {
    const arr = new Float32Array(dims);
    for (let i = 0; i < dims; i++) arr[i] = 0.5 * i;
    return { data: arr };
  });
  const pipeline = jest.fn().mockImplementation(async (_task: string, _model: string, options?: Record<string, unknown>) => {
    // Simulate a download progress event so tests can verify the callback wiring
    const cb = options?.progress_callback;
    if (typeof cb === 'function') {
      cb({ status: 'progress', file: 'model_quantized.onnx', progress: 50 });
    }
    return pipe;
  });
  const mod = { env: { cacheDir: '' }, pipeline } as unknown as TransformersModule;
  const loader = async () => mod;
  return { mod, loader, pipeline, pipe };
}

function makeEmbedder(options: Partial<OnnxEmbedderOptions> = {}): OnnxEmbedder {
  return new OnnxEmbedder({
    model: DEFAULT_ONNX_MODEL,
    pluginDir: '/tmp/plugin',
    ...options,
  });
}

describe('OnnxEmbedder', () => {
  test('embed: loads the pipeline with feature-extraction task and model id', async () => {
    const { pipeline, loader } = makeFakeTf();
    const embedder = makeEmbedder({ loader });

    await embedder.embed(['hello']);

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(pipeline).toHaveBeenCalledWith(
      'feature-extraction',
      DEFAULT_ONNX_MODEL,
      expect.objectContaining({ dtype: 'q8' })
    );
  });

  test('embed: returns plain arrays with the model dimension', async () => {
    const { loader, pipe } = makeFakeTf(3);
    const embedder = makeEmbedder({ loader });

    const result = await embedder.embed(['a', 'b']);

    expect(result.dimension).toBe(3);
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0, 0.5, 1]);
    expect(Array.isArray(result.embeddings[0])).toBe(true);
    expect(pipe).toHaveBeenCalledTimes(2);
  });

  test('embed: passes mean pooling and normalization to the pipeline', async () => {
    const { loader, pipe } = makeFakeTf();
    const embedder = makeEmbedder({ loader });

    await embedder.embed(['hello']);

    expect(pipe).toHaveBeenCalledWith('hello', { pooling: 'mean', normalize: true });
  });

  test('caches the loaded pipeline across embed calls', async () => {
    const { pipeline, loader } = makeFakeTf();
    const embedder = makeEmbedder({ loader });

    await embedder.embed(['a']);
    await embedder.embed(['b']);
    await embedder.embed(['c']);

    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  test('retries loading after a failed load', async () => {
    const good = makeFakeTf();
    const failFirst = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(good.mod) as jest.Mock;

    const embedder = makeEmbedder({ loader: failFirst as never, model: 'org/model' });
    await expect(embedder.embed(['x'])).rejects.toThrow('Failed to load embedding model');

    // Second attempt uses the good loader result
    const result = await embedder.embed(['x']);
    expect(result.dimension).toBe(3);
    expect(failFirst).toHaveBeenCalledTimes(2);
  });

  test('falls back from q8 to fp32 when the quantized variant is unavailable', async () => {
    const { pipeline, loader, pipe } = makeFakeTf(3);
    pipeline.mockRejectedValueOnce(new Error('404: no q8 variant'));

    const embedder = makeEmbedder({ loader });
    const result = await embedder.embed(['x']);

    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(pipeline).toHaveBeenNthCalledWith(
      1,
      'feature-extraction',
      DEFAULT_ONNX_MODEL,
      expect.objectContaining({ dtype: 'q8' })
    );
    expect(pipeline).toHaveBeenNthCalledWith(
      2,
      'feature-extraction',
      DEFAULT_ONNX_MODEL,
      expect.objectContaining({ dtype: 'fp32' })
    );
    expect(result.dimension).toBe(3);
    expect(pipe).toHaveBeenCalled();
  });

  test('surfaces download progress via onProgress', async () => {
    const { loader } = makeFakeTf();
    const onProgress = jest.fn();
    const embedder = makeEmbedder({ loader, onProgress });

    await embedder.embed(['x']);

    expect(onProgress).toHaveBeenCalledWith(
      'Downloading model_quantized.onnx for Xenova/all-MiniLM-L6-v2: 50%'
    );
    expect(onProgress).toHaveBeenCalledWith(`Embedding model ready (Xenova/all-MiniLM-L6-v2)`);
  });

  test('ping: reachable with dimension sample after a successful round-trip', async () => {
    const { loader } = makeFakeTf(384);
    const embedder = makeEmbedder({ loader });

    const result = await embedder.ping();

    expect(result.reachable).toBe(true);
    expect(result.sampleResponse).toBe('384-dim vector');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test.each(['onnxruntime-node', '@huggingface/transformers', 'sharp'])('ping preserves the actual missing dependency: %s', async dependency => {
    const loader = async () => { throw new Error(`Cannot find module '${dependency}'`); };
    const result = await makeEmbedder({ loader }).ping();
    expect(result.reachable).toBe(false);
    expect(result.errorMessage).toContain(`Cannot find module '${dependency}'`);
  });

  test('ping: maps a model load failure to a readable error', async () => {
    const { pipeline, loader } = makeFakeTf();
    pipeline.mockRejectedValue(new Error('ENOTFOUND huggingface.co'));

    const embedder = makeEmbedder({ loader, model: 'org/missing' });
    const result = await embedder.ping();

    expect(result.reachable).toBe(false);
    expect(result.errorMessage).toContain("'org/missing'");
    expect(result.errorMessage).toContain('ENOTFOUND');
  });

  test('embed: wraps inference failures in a ProviderError', async () => {
    const { loader, pipe } = makeFakeTf();
    pipe.mockRejectedValueOnce(new Error('session crashed'));

    const embedder = makeEmbedder({ loader });
    await expect(embedder.embed(['x'])).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      message: expect.stringContaining('ONNX inference failed'),
    });
  });

  test('listModels: returns the curated model ids', async () => {
    const embedder = makeEmbedder();

    const models = await embedder.listModels();

    expect(models).toEqual(Object.keys(ONNX_MODELS));
    expect(models).toContain(DEFAULT_ONNX_MODEL);
  });

  test('falls back from CoreML to CPU when the CoreML session fails', async () => {
    const { pipeline, loader, pipe } = makeFakeTf(3);
    pipeline
      .mockRejectedValueOnce(new Error('CoreML: unsupported operator MatMulInteger'))
      .mockRejectedValueOnce(new Error('CoreML: unsupported operator MatMulInteger'));

    const embedder = makeEmbedder({ loader, device: 'coreml' });
    const result = await embedder.embed(['x']);

    expect(pipeline).toHaveBeenCalledTimes(3);
    const devices = (pipeline.mock.calls as any[]).slice(0, 3).map(c => c[2].device);
    expect(devices).toEqual(['coreml', 'coreml', 'cpu']);
    expect(result.dimension).toBe(3);
  });

  test('uses the per-model file layout for nomic (root-level int8 file, no dtype ladder)', async () => {
    const { pipeline, loader, pipe } = makeFakeTf(3);

    const embedder = makeEmbedder({
      loader,
      model: 'keisuke-miyako/nomic-embed-text-v1.5-onnx-int8',
    });
    await embedder.embed(['x']);

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(pipeline).toHaveBeenCalledWith(
      'feature-extraction',
      'keisuke-miyako/nomic-embed-text-v1.5-onnx-int8',
      expect.objectContaining({
        subfolder: '',
        model_file_name: 'model_quantized',
        dtype: 'fp32',
        device: 'cpu',
      })
    );
  });

  test('nomic with CoreML: single dtype per device, device ladder still applies', async () => {
    const { pipeline, loader } = makeFakeTf(3);
    pipeline.mockRejectedValueOnce(new Error('CoreML failed'));

    const embedder = makeEmbedder({
      loader,
      model: 'keisuke-miyako/nomic-embed-text-v1.5-onnx-int8',
      device: 'coreml',
    });
    await embedder.embed(['x']);

    expect(pipeline).toHaveBeenCalledTimes(2);
    const calls = pipeline.mock.calls as any[];
    const devices = calls.map(c => c[2].device);
    const dtypes = calls.map(c => c[2].dtype);
    expect(devices).toEqual(['coreml', 'cpu']);
    expect(dtypes).toEqual(['fp32', 'fp32']);
  });
});

describe('ONNX_MODELS', () => {
  test('default model is curated and all curated models declare a dimension and label', () => {
    expect(ONNX_MODELS[DEFAULT_ONNX_MODEL]).toBeDefined();
    for (const entry of Object.values(ONNX_MODELS)) {
      expect(entry.dimension).toBeGreaterThan(0);
      expect(entry.label).toContain(entry.dimension + 'd');
      if (entry.load) {
        expect(entry.load.dtype).toBeDefined();
      }
    }
  });

  test('mpnet and nomic are curated for users switching off server providers', () => {
    expect(ONNX_MODELS['Xenova/all-mpnet-base-v2']?.dimension).toBe(768);
    const nomic = ONNX_MODELS['keisuke-miyako/nomic-embed-text-v1.5-onnx-int8'];
    expect(nomic?.dimension).toBe(768);
    expect(nomic?.load).toMatchObject({ subfolder: '', model_file_name: 'model_quantized' });
  });
});

describe('installed plugin module resolution', () => {
  test('default loader resolves dependencies from the installed plugin, not the renderer or project', async () => {
    const pluginDir = mkdtempSync(join(tmpdir(), 'rag-loader-'));
    const packageDir = join(pluginDir, 'node_modules', '@huggingface', 'transformers');
    mkdirSync(packageDir, { recursive: true });
    // A package available only inside the installed plugin. A renderer-rooted
    // require would instead fail or load the project's real transformers.js.
    writeFileSync(join(packageDir, 'index.js'), `
      exports.env = {};
      exports.pipeline = async () => async () => ({ data: [0.6, 0.8] });
    `);
    try {
      const result = await makeEmbedder({ pluginDir }).embed(['probe']);
      expect(result).toEqual({ embeddings: [[0.6, 0.8]], dimension: 2 });
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});
