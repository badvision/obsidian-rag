import { ChatService } from './ChatService';
import type { IChatProvider } from '../providers/types';
import { ProviderError } from '../providers/types';
import type { VectorStore } from '../store/VectorStore';
import type { EmbeddingService } from '../rag/EmbeddingService';
import type { CitationService } from '../rag/CitationService';
import type { RagPluginSettings } from '../settings';

function makeChatService(opts: {
  chat?: (messages: unknown, signal: AbortSignal, onToken?: (t: string) => void) => Promise<string>;
  lease?: { end: () => void };
  withIndex?: boolean;
}) {
  const vectorStore = {
    ensureLoaded: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockReturnValue([]),
    getStats: jest.fn().mockReturnValue({
      fileCount: opts.withIndex ? 1 : 0,
      chunkCount: opts.withIndex ? 3 : 0,
      embeddingModel: '',
      updatedAt: '',
    }),
  } as unknown as VectorStore;

  const embeddingService = {
    embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]),
    dispose: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmbeddingService;

  const citationService = {
    buildCitationSource: jest.fn().mockReturnValue({}),
    formatContext: jest.fn().mockReturnValue('ctx'),
    validateCitations: jest.fn().mockImplementation((raw: string) => raw),
  } as unknown as CitationService;

  const provider = {
    chat: opts.chat ?? (jest.fn().mockResolvedValue('answer') as jest.Mock),
    ping: jest.fn(),
    listModels: jest.fn(),
  } as unknown as IChatProvider;

  const settings = { topK: 5, embeddingModel: 'nomic' } as unknown as RagPluginSettings;

  const leaseEnd = opts.lease?.end ?? jest.fn();
  const acquireLease = jest.fn().mockResolvedValue(opts.lease ?? { end: leaseEnd });

  const service = new ChatService(
    provider,
    vectorStore,
    embeddingService,
    citationService,
    settings,
    acquireLease
  );

  return { service, provider, vectorStore, embeddingService, acquireLease, leaseEnd };
}

describe('ChatService chat lease', () => {
  test('ask: lease is held for the whole turn and released after success', async () => {
    const { service, acquireLease, leaseEnd } = makeChatService({ withIndex: true });

    await service.ask('q', new AbortController().signal);

    expect(acquireLease).toHaveBeenCalledTimes(1);
    expect(leaseEnd).toHaveBeenCalledTimes(1);
  });

  test('ask: lease is released even when the chat provider fails', async () => {
    const { service, leaseEnd } = makeChatService({
      withIndex: true,
      chat: jest.fn().mockRejectedValue(new Error('provider down')) as never,
    });

    await expect(service.ask('q', new AbortController().signal)).rejects.toThrow('provider down');

    expect(leaseEnd).toHaveBeenCalledTimes(1);
  });

  test('ask: lease is released when the no-index early return path is taken', async () => {
    const { service, leaseEnd } = makeChatService({ withIndex: false });

    const result = await service.ask('q', new AbortController().signal);

    expect(result.displayContent).toContain('no indexed information');
    expect(leaseEnd).toHaveBeenCalledTimes(1);
  });

  test('ask: embedding model is released after the query, before answer generation', async () => {
    const callOrder: string[] = [];
    const { service, embeddingService, provider } = makeChatService({
      withIndex: true,
      chat: jest.fn(() => {
        callOrder.push('chat');
        return Promise.resolve('answer');
      }) as never,
    });
    (embeddingService.dispose as jest.Mock).mockImplementation(() => {
      callOrder.push('dispose');
      return Promise.resolve();
    });
    (embeddingService.embedQuery as jest.Mock).mockImplementation(async () => {
      callOrder.push('embed');
      return [0.1];
    });

    await service.ask('q', new AbortController().signal);

    expect(callOrder).toEqual(['embed', 'dispose', 'chat']);
    expect(embeddingService.dispose).toHaveBeenCalledTimes(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  test('ask: a stale-model index throws the reindex prompt, not the raw store error', async () => {
    const { service, vectorStore, leaseEnd } = makeChatService({ withIndex: true });
    (vectorStore.ensureLoaded as jest.Mock).mockRejectedValue(
      new ProviderError('embedding dimension mismatch', 'DIMENSION_MISMATCH')
    );

    await expect(service.ask('q', new AbortController().signal)).rejects.toThrow(
      /rebuild the index/
    );
    expect(leaseEnd).toHaveBeenCalledTimes(1); // lease released on the fault path
  });
});
