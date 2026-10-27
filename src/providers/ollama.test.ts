import { OllamaEmbedder, OllamaChatProvider } from './ollama';
import { ProviderError } from './types';
import { createEmbedder, createChatProvider } from './factory';
import { RagPluginSettings, DEFAULT_SETTINGS } from '../settings';
import { LMStudioEmbedder, LMStudioChatProvider } from './lmstudio';
import { CliChatProvider } from './cli';

jest.mock('./nodeHttp');
import { nodeStreamPost } from './nodeHttp';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

const mockNodeStreamPost = nodeStreamPost as jest.MockedFunction<typeof nodeStreamPost>;

describe('OllamaEmbedder', () => {
  let embedder: OllamaEmbedder;

  beforeEach(() => {
    embedder = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    jest.clearAllMocks();
  });

  test('embed: happy path returns embeddings and dimension', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { embeddings: [[0.1, 0.2, 0.3]] }));

    const result = await embedder.embed(['hello']);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.dimension).toBe(3);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('embed: 404 on /api/embed falls back to /api/embeddings', async () => {
    globalThis.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(200, { embedding: [0.1, 0.2] }));

    const result = await embedder.embed(['hello']);

    expect(result.embeddings).toEqual([[0.1, 0.2]]);
    expect(result.dimension).toBe(2);
    expect((globalThis.fetch as jest.Mock).mock.calls[1][0]).toBe(
      'http://localhost:11434/api/embeddings'
    );
  });

  test('embed: CONNECTION_REFUSED when fetch throws TypeError', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(embedder.embed(['hello'])).rejects.toThrow(ProviderError);
    await expect(embedder.embed(['hello'])).rejects.toMatchObject({
      code: 'CONNECTION_REFUSED',
    });
  });

  test('embed: MODEL_NOT_FOUND when both endpoints return 404', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(404, { error: 'not found' }));

    await expect(embedder.embed(['hello'])).rejects.toThrow(ProviderError);
    await expect(embedder.embed(['hello'])).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  test('embed: multiple texts returns all embeddings', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] })
    );

    const result = await embedder.embed(['hello', 'world']);

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.embeddings[1]).toEqual([0.4, 0.5, 0.6]);
    expect(result.dimension).toBe(3);
  });

  test('listModels: returns sorted model names from /api/tags', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { models: [{ name: 'zeta' }, { name: 'alpha' }] })
    );

    await expect(embedder.listModels()).resolves.toEqual(['alpha', 'zeta']);
  });

  test('ping: reachable returns true with latency', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { version: '0.5.0' }));

    const result = await embedder.ping();

    expect(result.reachable).toBe(true);
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  test('ping: unreachable returns false and never throws', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await embedder.ping();

    expect(result.reachable).toBe(false);
    expect(result.latencyMs).toBe(0);
    expect(result.errorMessage).toBeDefined();
  });

  test('embed: sends Authorization Bearer header when an API key is set', async () => {
    const keyed = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text', 'sekret');
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { embeddings: [[0.1, 0.2, 0.3]] }));

    await keyed.embed(['hello']);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekret' } })
    );
  });

  test('embed: no Authorization header when no API key is set', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { embeddings: [[0.1, 0.2, 0.3]] }));

    await embedder.embed(['hello']);

    const [, opts] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
  });
});

describe('OllamaChatProvider', () => {
  let provider: OllamaChatProvider;

  beforeEach(() => {
    provider = new OllamaChatProvider('http://localhost:11434', 'llama3.2');
    jest.clearAllMocks();
  });

  test('chat: NDJSON stream calls onToken per chunk and returns accumulated string', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'Hello' }, done: false }),
      JSON.stringify({ message: { content: ' world' }, done: false }),
      JSON.stringify({ message: { content: '' }, done: true }),
    ];
    mockNodeStreamPost.mockImplementation(async (opts) => {
      for (const line of lines) opts.onLine(line);
    });

    const tokens: string[] = [];
    const result = await provider.chat(
      [{ role: 'user', content: 'hi' }],
      new AbortController().signal,
      (token) => tokens.push(token)
    );

    expect(tokens).toEqual(['Hello', ' world']);
    expect(result).toBe('Hello world');
    expect(mockNodeStreamPost).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:11434/api/chat' })
    );
  });

  test('chat: sends Authorization Bearer header through the stream when an API key is set', async () => {
    const keyed = new OllamaChatProvider('http://localhost:11434', 'llama3.2', 'sekret');
    mockNodeStreamPost.mockImplementation(async (opts) => {
      opts.onLine(JSON.stringify({ message: { content: 'hi' }, done: true }));
    });

    await keyed.chat([{ role: 'user', content: 'hi' }], new AbortController().signal);

    expect(mockNodeStreamPost).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:11434/api/chat',
        headers: { Authorization: 'Bearer sekret' },
      })
    );
  });

  test('chat: AbortError throws ProviderError with STREAM_ABORTED', async () => {
    mockNodeStreamPost.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'STREAM_ABORTED' });
  });

  test('chat: connection error throws ProviderError with CONNECTION_REFUSED', async () => {
    mockNodeStreamPost.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], new AbortController().signal)
    ).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
  });

  test('listModels: returns sorted model names from /api/tags', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { models: [{ name: 'b' }, { name: 'a' }] })
    );

    await expect(provider.listModels()).resolves.toEqual(['a', 'b']);
  });

  test('ping: reachable returns true with latency', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { version: '0.5.0' }));

    const result = await provider.ping();

    expect(result.reachable).toBe(true);
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  test('ping: unreachable returns false and never throws', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await provider.ping();

    expect(result.reachable).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });
});

// --- factory tests ---

describe('createEmbedder / createChatProvider', () => {
  const base: RagPluginSettings = { ...DEFAULT_SETTINGS };

  test('createEmbedder: returns OllamaEmbedder for ollama', () => {
    expect(createEmbedder({ ...base, embeddingProvider: 'ollama' }))
      .toBeInstanceOf(OllamaEmbedder);
  });

  test('createEmbedder: returns LMStudioEmbedder for lmstudio', () => {
    expect(createEmbedder({ ...base, embeddingProvider: 'lmstudio' }))
      .toBeInstanceOf(LMStudioEmbedder);
  });

  test('createChatProvider: returns OllamaChatProvider for ollama', () => {
    expect(createChatProvider({ ...base, chatProvider: 'ollama' }))
      .toBeInstanceOf(OllamaChatProvider);
  });

  test('createChatProvider: returns LMStudioChatProvider for lmstudio', () => {
    expect(createChatProvider({ ...base, chatProvider: 'lmstudio' }))
      .toBeInstanceOf(LMStudioChatProvider);
  });

  test('createChatProvider: returns CliChatProvider for cli', () => {
    expect(createChatProvider({ ...base, chatProvider: 'cli' }))
      .toBeInstanceOf(CliChatProvider);
  });
});
