import { EmbeddingService } from './EmbeddingService';
import { EmbedResult, ProviderError } from '../providers/types';
import type { IEmbedder } from '../providers/types';

const mockProvider: IEmbedder = {
  embed: jest.fn(),
  ping: jest.fn(),
  listModels: jest.fn(),
};

function makeEmbedResult(embeddings: number[][]): EmbedResult {
  return { embeddings, dimension: embeddings[0]?.length ?? 0 };
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('EmbeddingService.embedBatch', () => {
  test('single batch: 5 texts with batchSize=20 calls provider.embed once with all 5', async () => {
    const texts = ['a', 'b', 'c', 'd', 'e'];
    const embeddings = texts.map((_, i) => [i * 0.1]);
    (mockProvider.embed as jest.Mock).mockResolvedValueOnce(makeEmbedResult(embeddings));

    const service = new EmbeddingService(mockProvider);
    const result = await service.embedBatch(texts, 20);

    expect(mockProvider.embed).toHaveBeenCalledTimes(1);
    expect(mockProvider.embed).toHaveBeenCalledWith(texts);
    expect(result).toEqual(embeddings);
  });

  test('multiple batches: 25 texts with batchSize=20 calls provider.embed twice', async () => {
    const texts = Array.from({ length: 25 }, (_, i) => `text${i}`);
    const batch1Embeddings = Array.from({ length: 20 }, (_, i) => [i * 0.1]);
    const batch2Embeddings = Array.from({ length: 5 }, (_, i) => [(20 + i) * 0.1]);

    (mockProvider.embed as jest.Mock)
      .mockResolvedValueOnce(makeEmbedResult(batch1Embeddings))
      .mockResolvedValueOnce(makeEmbedResult(batch2Embeddings));

    const service = new EmbeddingService(mockProvider);
    const result = await service.embedBatch(texts, 20);

    expect(mockProvider.embed).toHaveBeenCalledTimes(2);
    expect((mockProvider.embed as jest.Mock).mock.calls[0][0]).toHaveLength(20);
    expect((mockProvider.embed as jest.Mock).mock.calls[1][0]).toHaveLength(5);
    expect(result).toHaveLength(25);
    expect(result).toEqual([...batch1Embeddings, ...batch2Embeddings]);
  });

  test('empty array returns []', async () => {
    const service = new EmbeddingService(mockProvider);
    const result = await service.embedBatch([], 20);

    expect(mockProvider.embed).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  test('error propagates: provider.embed throws ProviderError', async () => {
    const error = new ProviderError('connection refused', 'CONNECTION_REFUSED');
    (mockProvider.embed as jest.Mock).mockRejectedValue(error);

    const service = new EmbeddingService(mockProvider);

    await expect(service.embedBatch(['text'], 20)).rejects.toThrow(ProviderError);
    await expect(service.embedBatch(['text'], 20)).rejects.toMatchObject({
      code: 'CONNECTION_REFUSED',
    });
  });
});

describe('EmbeddingService.embedQuery', () => {
  test('calls provider.embed with single-element array and returns first embedding', async () => {
    const embedding = [0.1, 0.2, 0.3];
    (mockProvider.embed as jest.Mock).mockResolvedValueOnce(
      makeEmbedResult([embedding])
    );

    const service = new EmbeddingService(mockProvider);
    const result = await service.embedQuery('what is quantum?');

    expect(mockProvider.embed).toHaveBeenCalledWith(['what is quantum?']);
    expect(result).toEqual(embedding);
  });
});

describe('EmbeddingService lifecycle (dispose / session guards)', () => {
  function makeProviderWithDispose() {
    return {
      embed: jest.fn(),
      ping: jest.fn(),
      listModels: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
  }

  test('dispose: single-flight — concurrent calls invoke provider.dispose once', async () => {
    const provider = makeProviderWithDispose();
    const service = new EmbeddingService(provider);

    await Promise.all([service.dispose(), service.dispose(), service.dispose()]);

    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });

  test('dispose: no-op while an embed is in flight; works once it finishes', async () => {
    const provider = makeProviderWithDispose();
    let releaseEmbed!: (r: EmbedResult) => void;
    (provider.embed as jest.Mock).mockImplementation(
      () => new Promise<EmbedResult>(resolve => { releaseEmbed = resolve; })
    );
    const service = new EmbeddingService(provider);

    const pending = service.embedQuery('q');
    await Promise.resolve();
    await service.dispose();
    expect(provider.dispose).not.toHaveBeenCalled(); // never dispose mid-inference

    releaseEmbed(makeEmbedResult([[0.1]]));
    await pending;
    await service.dispose();
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });

  test('dispose: no-op while a session is held (index run keeps worker across files)', async () => {
    const provider = makeProviderWithDispose();
    const service = new EmbeddingService(provider);

    service.beginSession();
    await service.dispose();
    expect(provider.dispose).not.toHaveBeenCalled();

    service.endSession();
    await service.dispose();
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });

  test('dispose: without provider.dispose (stateless HTTP providers) resolves as a no-op', async () => {
    const provider = { embed: jest.fn(), ping: jest.fn(), listModels: jest.fn() };
    const service = new EmbeddingService(provider);
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  test('dispose: a rejected provider.dispose is swallowed into the promise and re-arms', async () => {
    const provider = makeProviderWithDispose();
    (provider.dispose as jest.Mock)
      .mockRejectedValueOnce(new Error('worker gone'))
      .mockResolvedValueOnce(undefined);
    const service = new EmbeddingService(provider);

    await expect(service.dispose()).rejects.toThrow('worker gone');
    await expect(service.dispose()).resolves.toBeUndefined();
    expect(provider.dispose).toHaveBeenCalledTimes(2);
  });

  test('forceDispose: unload cancels a pending embed that never settles (bounded, no wait)', async () => {
    const provider = makeProviderWithDispose();
    let releaseEmbed!: (r: EmbedResult) => void;
    (provider.embed as jest.Mock).mockImplementation(
      () => new Promise<EmbedResult>(resolve => { releaseEmbed = resolve; })
    );
    const service = new EmbeddingService(provider);

    const pending = service.embedQuery('q'); // in flight, never settles in this test
    await Promise.resolve();

    // Unload must NOT wait for the in-flight infer — the provider dispose is
    // invoked immediately and the provider is contractually cancel-safe.
    await service.forceDispose();
    expect(provider.dispose).toHaveBeenCalledTimes(1);

    // Re-arming after the (eventual) settle stays single-call.
    releaseEmbed(makeEmbedResult([[0.1]]));
    await pending;
    await service.forceDispose();
    expect(provider.dispose).toHaveBeenCalledTimes(2);
  });

  test('forceDispose: works while a session is held (unload mid index run)', async () => {
    const provider = makeProviderWithDispose();
    const service = new EmbeddingService(provider);

    service.beginSession();
    await service.dispose();
    expect(provider.dispose).not.toHaveBeenCalled(); // session-gated no-op

    await service.forceDispose();
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });

  test('forceDispose: reuses an in-flight normal dispose (one provider call)', async () => {
    const provider = makeProviderWithDispose();
    let releaseDispose!: () => void;
    (provider.dispose as jest.Mock).mockImplementationOnce(
      () => new Promise<void>(r => { releaseDispose = r; })
    );
    const service = new EmbeddingService(provider);

    const a = service.dispose();
    const b = service.forceDispose();
    await Promise.resolve();
    expect(provider.dispose).toHaveBeenCalledTimes(1);

    releaseDispose();
    await Promise.all([a, b]);
    expect(provider.dispose).toHaveBeenCalledTimes(1);
  });
});
