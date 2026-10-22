import { QueryService } from './QueryService';
import { EmbeddingService } from './EmbeddingService';
import { CitationService } from './CitationService';
import { VectorStore } from '../store/VectorStore';
import { ProviderError } from '../providers/types';
import type { IChatProvider } from '../providers/types';
import { Chunk } from '../store/types';
import { CitationSource } from './types';
import { RagPluginSettings, DEFAULT_SETTINGS } from '../settings';

const pdfChunk: Chunk = {
  id: 'papers/quantum.pdf::p3::c0',
  text: 'Quantum entanglement is a phenomenon...',
  embedding: [0.1, 0.2],
  sourceType: 'pdf',
  vaultPath: 'papers/quantum.pdf',
  page: 3,
  chunkIndex: 0,
};

const mockCitationSource: CitationSource = {
  chunk: pdfChunk,
  score: 0.9,
  obsidianLink: 'papers/quantum.pdf#page=3',
  displayLabel: 'quantum.pdf p.3',
};

const mockSettings: RagPluginSettings = { ...DEFAULT_SETTINGS, topK: 5 };

function makeQueryService(overrides: {
  provider?: Partial<IChatProvider>;
  vectorStore?: Partial<VectorStore>;
  embeddingService?: Partial<EmbeddingService>;
  citationService?: Partial<CitationService>;
  settings?: Partial<RagPluginSettings>;
} = {}): QueryService {
  const provider = {
    chat: jest.fn(),
    ping: jest.fn(),
    listModels: jest.fn(),
    ...overrides.provider,
  } as IChatProvider;

  const vectorStore = {
    ensureLoaded: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(),
    upsertFile: jest.fn(),
    removeFile: jest.fn(),
    getIndexData: jest.fn(),
    clear: jest.fn(),
    ...overrides.vectorStore,
  } as unknown as VectorStore;

  const embeddingService = {
    embedQuery: jest.fn(),
    embedBatch: jest.fn(),
    ...overrides.embeddingService,
  } as unknown as EmbeddingService;

  const citationService = {
    buildCitationSource: jest.fn(),
    formatContext: jest.fn(),
    buildMessages: jest.fn(),
    validateCitations: jest.fn((s: string) => s),
    assessConfidence: jest.fn().mockReturnValue('high'),
    ...overrides.citationService,
  } as unknown as CitationService;

  const settings = { ...mockSettings, ...overrides.settings };

  return new QueryService(provider, vectorStore, embeddingService, citationService, settings);
}

describe('QueryService.query', () => {
  test('happy path: full pipeline returns correct RagAnswer', async () => {
    const contextString = '\n[Source 1] FROM quantum.pdf - Page 3 (cite as: [1])\nsome text\n';
    const messages = [
      { role: 'system' as const, content: 'You are a precise research assistant.' },
      { role: 'user' as const, content: 'QUESTION: what is entanglement?' },
    ];
    const rawAnswer = '[1] The answer is quantum entanglement.';

    const service = makeQueryService({
      embeddingService: {
        embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]),
        embedBatch: jest.fn(),
      },
      vectorStore: {
        query: jest.fn().mockReturnValue([{ chunk: pdfChunk, score: 0.9 }]),
      },
      citationService: {
        buildCitationSource: jest.fn().mockReturnValue(mockCitationSource),
        formatContext: jest.fn().mockReturnValue(contextString),
        buildMessages: jest.fn().mockReturnValue(messages),
        validateCitations: jest.fn().mockReturnValue(rawAnswer),
        assessConfidence: jest.fn().mockReturnValue('high'),
      },
      provider: {
        chat: jest.fn().mockResolvedValue(rawAnswer),
        ping: jest.fn(),
      },
    });

    const signal = new AbortController().signal;
    const result = await service.query('what is entanglement?', signal);

    expect(result.question).toBe('what is entanglement?');
    expect(result.answer).toBe(rawAnswer);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toBe(mockCitationSource);
    expect(result.confidence).toBe('high');
    expect(typeof result.durationMs).toBe('number');
  });

  test('empty results: returns insufficient answer without calling provider.chat', async () => {
    const mockChat = jest.fn();

    const service = makeQueryService({
      embeddingService: {
        embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]),
        embedBatch: jest.fn(),
      },
      vectorStore: {
        query: jest.fn().mockReturnValue([]),
      },
      provider: {
        chat: mockChat,
        ping: jest.fn(),
      },
    });

    const signal = new AbortController().signal;
    const result = await service.query('what is entanglement?', signal);

    expect(mockChat).not.toHaveBeenCalled();
    expect(result.confidence).toBe('insufficient');
    expect(result.answer).toContain("couldn't find");
    expect(result.sources).toEqual([]);
  });

  test('signal aborted: error from embedQuery propagates', async () => {
    const abortError = new ProviderError('stream aborted', 'STREAM_ABORTED');

    const service = makeQueryService({
      embeddingService: {
        embedQuery: jest.fn().mockRejectedValue(abortError),
        embedBatch: jest.fn(),
      },
    });

    const signal = new AbortController().signal;

    await expect(service.query('what is entanglement?', signal)).rejects.toMatchObject({
      code: 'STREAM_ABORTED',
    });
  });

  test('streaming: onToken callback is passed through to provider.chat', async () => {
    const contextString = 'context';
    const messages = [{ role: 'user' as const, content: 'question' }];
    const capturedOnToken: Array<((token: string) => void) | undefined> = [];
    const mockChat = jest.fn().mockImplementation(
      (_msgs: unknown, _signal: unknown, onToken?: (token: string) => void) => {
        capturedOnToken.push(onToken);
        return Promise.resolve('[1] answer');
      }
    );

    const service = makeQueryService({
      embeddingService: {
        embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]),
        embedBatch: jest.fn(),
      },
      vectorStore: {
        query: jest.fn().mockReturnValue([{ chunk: pdfChunk, score: 0.9 }]),
      },
      citationService: {
        buildCitationSource: jest.fn().mockReturnValue(mockCitationSource),
        formatContext: jest.fn().mockReturnValue(contextString),
        buildMessages: jest.fn().mockReturnValue(messages),
        validateCitations: jest.fn().mockReturnValue('[1] answer'),
        assessConfidence: jest.fn().mockReturnValue('high'),
      },
      provider: {
        chat: mockChat,
        ping: jest.fn(),
      },
    });

    const signal = new AbortController().signal;
    const onToken = jest.fn();
    await service.query('what is X?', signal, onToken);

    expect(capturedOnToken[0]).toBe(onToken);
  });

  test('durationMs: result contains a non-negative number', async () => {
    const service = makeQueryService({
      embeddingService: {
        embedQuery: jest.fn().mockResolvedValue([0.1, 0.2]),
        embedBatch: jest.fn(),
      },
      vectorStore: {
        query: jest.fn().mockReturnValue([{ chunk: pdfChunk, score: 0.9 }]),
      },
      citationService: {
        buildCitationSource: jest.fn().mockReturnValue(mockCitationSource),
        formatContext: jest.fn().mockReturnValue('ctx'),
        buildMessages: jest.fn().mockReturnValue([{ role: 'user' as const, content: 'q' }]),
        validateCitations: jest.fn().mockReturnValue('[1] answer'),
        assessConfidence: jest.fn().mockReturnValue('medium'),
      },
      provider: {
        chat: jest.fn().mockResolvedValue('[1] answer'),
        ping: jest.fn(),
      },
    });

    const signal = new AbortController().signal;
    const result = await service.query('test?', signal);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });
});
