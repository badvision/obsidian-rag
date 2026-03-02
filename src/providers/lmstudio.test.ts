import { LMStudioProvider } from './lmstudio';
import { ProviderError } from './types';

// Helper to build a minimal ReadableStream from SSE lines
function makeSseStream(lines: string[]): ReadableStream<Uint8Array> {
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

describe('LMStudioProvider', () => {
  let provider: LMStudioProvider;

  beforeEach(() => {
    provider = new LMStudioProvider(
      'http://localhost:1234',
      'lmstudio-community/Meta-Llama-3-8B',
      'text-embedding-nomic-embed-text-v1.5',
      false
    );
    jest.resetAllMocks();
  });

  // --- embed tests ---

  test('embed: happy path returns embeddings and dimension', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
      }),
    } as Response);

    const result = await provider.embed(['hello']);

    expect(result.embeddings).toEqual([[0.1, 0.2]]);
    expect(result.dimension).toBe(2);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:1234/v1/embeddings',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('embed: multiple texts returns all embeddings', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { embedding: [0.1, 0.2] },
          { embedding: [0.3, 0.4] },
          { embedding: [0.5, 0.6] },
        ],
      }),
    } as Response);

    const result = await provider.embed(['a', 'b', 'c']);

    expect(result.embeddings).toHaveLength(3);
    expect(result.embeddings[0]).toEqual([0.1, 0.2]);
    expect(result.embeddings[2]).toEqual([0.5, 0.6]);
    expect(result.dimension).toBe(2);
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

  test('embed: UNEXPECTED_RESPONSE on non-OK response', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    await expect(provider.embed(['hello'])).rejects.toThrow(ProviderError);
    await expect(provider.embed(['hello'])).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  // --- chat tests ---

  test('chat: non-streaming returns message content', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'answer' } }],
      }),
    } as Response);

    const signal = new AbortController().signal;
    const result = await provider.chat(
      [{ role: 'user', content: 'question' }],
      signal
    );

    expect(result).toBe('answer');
  });

  test('chat: SSE streaming calls onToken and returns accumulated string', async () => {
    provider = new LMStudioProvider(
      'http://localhost:1234',
      'lmstudio-community/Meta-Llama-3-8B',
      'text-embedding-nomic-embed-text-v1.5',
      true
    );

    const lines = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
      'data: [DONE]',
    ];

    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSseStream(lines),
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
    provider = new LMStudioProvider(
      'http://localhost:1234',
      'lmstudio-community/Meta-Llama-3-8B',
      'text-embedding-nomic-embed-text-v1.5',
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
