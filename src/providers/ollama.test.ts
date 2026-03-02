import { OllamaProvider } from './ollama';
import { ProviderError } from './types';
import { createProvider } from './factory';
import { RagPluginSettings } from '../settings';
import { OllamaProvider as OllamaProviderImport } from './ollama';
import { LMStudioProvider } from './lmstudio';

// Helper to build a minimal ReadableStream from NDJSON lines
function makeNdJsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'));
      }
      controller.close();
    },
  });
}

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider(
      'http://localhost:11434',
      'llama3.2',
      'nomic-embed-text',
      false
    );
    jest.resetAllMocks();
  });

  // --- embed tests ---

  test('embed: happy path returns embeddings and dimension', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    } as Response);

    const result = await provider.embed(['hello']);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.dimension).toBe(3);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('embed: 404 on /api/embed falls back to /api/embeddings', async () => {
    globalThis.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ embedding: [0.1, 0.2] }),
      } as Response);

    const result = await provider.embed(['hello']);

    expect(result.embeddings).toEqual([[0.1, 0.2]]);
    expect(result.dimension).toBe(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((globalThis.fetch as jest.Mock).mock.calls[1][0]).toBe(
      'http://localhost:11434/api/embeddings'
    );
  });

  test('embed: CONNECTION_REFUSED when fetch throws TypeError', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(
      new TypeError('Failed to fetch')
    );

    await expect(provider.embed(['hello'])).rejects.toThrow(ProviderError);
    await expect(provider.embed(['hello'])).rejects.toMatchObject({
      code: 'CONNECTION_REFUSED',
    });
  });

  test('embed: MODEL_NOT_FOUND when both endpoints return 404', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    await expect(provider.embed(['hello'])).rejects.toThrow(ProviderError);
    await expect(provider.embed(['hello'])).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  test('embed: multiple texts returns all embeddings', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      }),
    } as Response);

    const result = await provider.embed(['hello', 'world']);

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.embeddings[1]).toEqual([0.4, 0.5, 0.6]);
    expect(result.dimension).toBe(3);
  });

  // --- chat tests ---

  test('chat: non-streaming returns message content', async () => {
    provider = new OllamaProvider(
      'http://localhost:11434',
      'llama3.2',
      'nomic-embed-text',
      false
    );

    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: 'hello world' },
        done: true,
      }),
    } as Response);

    const signal = new AbortController().signal;
    const result = await provider.chat(
      [{ role: 'user', content: 'hi' }],
      signal
    );

    expect(result).toBe('hello world');
  });

  test('chat: streaming calls onToken and returns accumulated string', async () => {
    provider = new OllamaProvider(
      'http://localhost:11434',
      'llama3.2',
      'nomic-embed-text',
      true
    );

    const lines = [
      JSON.stringify({ message: { content: 'Hello' }, done: false }),
      JSON.stringify({ message: { content: ' world' }, done: false }),
      JSON.stringify({ message: { content: '' }, done: true }),
    ];

    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: makeNdJsonStream(lines),
    } as unknown as Response);

    const tokens: string[] = [];
    const signal = new AbortController().signal;
    const result = await provider.chat(
      [{ role: 'user', content: 'hi' }],
      signal,
      (token: string) => tokens.push(token)
    );

    expect(tokens).toEqual(['Hello', ' world']);
    expect(result).toBe('Hello world');
  });

  test('chat: AbortError throws ProviderError with STREAM_ABORTED', async () => {
    provider = new OllamaProvider(
      'http://localhost:11434',
      'llama3.2',
      'nomic-embed-text',
      true
    );

    const abortErr = new DOMException('aborted', 'AbortError');
    globalThis.fetch = jest.fn().mockRejectedValue(abortErr);

    const signal = new AbortController().signal;
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], signal)
    ).rejects.toMatchObject({ code: 'STREAM_ABORTED' });
  });

  // --- ping tests ---

  test('ping: reachable returns true with latency', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const result = await provider.ping();

    expect(result.reachable).toBe(true);
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  test('ping: unreachable returns false and never throws', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await provider.ping();

    expect(result.reachable).toBe(false);
    expect(result.latencyMs).toBe(0);
    expect(result.errorMessage).toBeDefined();
  });
});

// --- factory tests ---

describe('createProvider', () => {
  const base: RagPluginSettings = {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    chatModel: 'llama3.2',
    embeddingModel: 'nomic-embed-text',
    topK: 5,
    chunkSize: 500,
    chunkOverlap: 50,
    indexScope: 'pdfs-and-notes',
    streamingEnabled: true,
    autoIndexOnStartup: false,
    indexVersion: 1,
    embeddingDimension: 0,
  };

  test('returns OllamaProvider for provider=ollama', () => {
    const p = createProvider({ ...base, provider: 'ollama' });
    expect(p).toBeInstanceOf(OllamaProviderImport);
  });

  test('returns LMStudioProvider for provider=lmstudio', () => {
    const p = createProvider({ ...base, provider: 'lmstudio' });
    expect(p).toBeInstanceOf(LMStudioProvider);
  });
});
