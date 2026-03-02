import { EmbeddingService } from './EmbeddingService';
import { IProvider, EmbedResult, ProviderError } from '../providers/types';

const mockProvider: IProvider = {
  embed: jest.fn(),
  chat: jest.fn(),
  ping: jest.fn(),
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
