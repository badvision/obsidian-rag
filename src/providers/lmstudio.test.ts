import { LMStudioEmbedder, LMStudioChatProvider } from './lmstudio';
import { ProviderError } from './types';

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

describe('LMStudioEmbedder', () => {
  let embedder: LMStudioEmbedder;

  beforeEach(() => {
    embedder = new LMStudioEmbedder('http://localhost:1234', 'nomic-embed-text');
    jest.clearAllMocks();
  });

  test('embed: happy path returns embeddings and dimension', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ embedding: [0.1, 0.2, 0.3] }] })
    );

    const result = await embedder.embed(['hello']);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.dimension).toBe(3);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:1234/v1/embeddings',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('embed: multiple texts returns all embeddings', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ embedding: [0.1] }, { embedding: [0.2] }] })
    );

    const result = await embedder.embed(['hello', 'world']);

    expect(result.embeddings).toHaveLength(2);
    expect(result.dimension).toBe(1);
  });

  test('embed: CONNECTION_REFUSED when fetch throws TypeError', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(embedder.embed(['hello'])).rejects.toThrow(ProviderError);
    await expect(embedder.embed(['hello'])).rejects.toMatchObject({
      code: 'CONNECTION_REFUSED',
    });
  });

  test('embed: UNEXPECTED_RESPONSE on non-OK response', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' }));

    await expect(embedder.embed(['hello'])).rejects.toThrow(ProviderError);
    await expect(embedder.embed(['hello'])).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  test('listModels: returns sorted model ids from /v1/models', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ id: 'z-model' }, { id: 'a-model' }] })
    );

    await expect(embedder.listModels()).resolves.toEqual(['a-model', 'z-model']);
  });

  test('ping: reachable returns true with latency', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { data: [] }));

    const result = await embedder.ping();

    expect(result.reachable).toBe(true);
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  test('ping: unreachable returns false and never throws', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await embedder.ping();

    expect(result.reachable).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });
});

describe('LMStudioChatProvider', () => {
  let provider: LMStudioChatProvider;

  beforeEach(() => {
    provider = new LMStudioChatProvider('http://localhost:1234', 'llama3.2');
    jest.clearAllMocks();
  });

  test('chat: SSE stream calls onToken per chunk and returns accumulated string', async () => {
    const lines = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
      'data: [DONE]',
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
      expect.objectContaining({ url: 'http://localhost:1234/v1/chat/completions' })
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

  test('listModels: returns sorted model ids from /v1/models', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ id: 'b' }, { id: 'a' }] })
    );

    await expect(provider.listModels()).resolves.toEqual(['a', 'b']);
  });

  test('ping: reachable returns true with latency', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { data: [] }));

    const result = await provider.ping();

    expect(result.reachable).toBe(true);
  });

  test('ping: unreachable returns false and never throws', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await provider.ping();

    expect(result.reachable).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });
});
