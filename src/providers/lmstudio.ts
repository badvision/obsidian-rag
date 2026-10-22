import { requestUrl } from 'obsidian';
import { ChatMessage, EmbedResult, IChatProvider, IEmbedder, PingResult, ProviderError } from './types';
import { nodeStreamPost } from './nodeHttp';

export class LMStudioEmbedder implements IEmbedder {
  constructor(
    private baseUrl: string,
    private embeddingModel: string
  ) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/v1/embeddings`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embeddingModel, input: texts }),
        throw: false,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new ProviderError(
          `LM Studio embeddings failed: ${response.status}`,
          'UNEXPECTED_RESPONSE'
        );
      }

      const data = response.json;
      const embeddings: number[][] = (data.data as Array<{ embedding: number[] }>).map(
        (item) => item.embedding
      );
      return { embeddings, dimension: embeddings[0].length };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Cannot connect to LM Studio at ${this.baseUrl}`,
        'CONNECTION_REFUSED',
        err as Error
      );
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/v1/models`,
        method: 'GET',
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) return [];
      const models: Array<{ id: string }> = response.json.data ?? [];
      return models.map(m => m.id).sort();
    } catch {
      return [];
    }
  }

  async ping(): Promise<PingResult> {
    const start = Date.now();
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/v1/models`,
        method: 'GET',
        throw: false,
      });
      const latencyMs = Date.now() - start;
      if (response.status >= 200 && response.status < 300) {
        return { reachable: true, latencyMs };
      }
      return { reachable: false, latencyMs, errorMessage: `HTTP ${response.status}` };
    } catch (err) {
      return { reachable: false, latencyMs: 0, errorMessage: (err as Error).message };
    }
  }
}

export class LMStudioChatProvider implements IChatProvider {
  constructor(
    private baseUrl: string,
    private chatModel: string
  ) {}

  async chat(
    messages: ChatMessage[],
    signal: AbortSignal,
    onToken?: (token: string) => void
  ): Promise<string> {
    const body = JSON.stringify({ model: this.chatModel, messages, stream: true });
    let accumulated = '';
    let done = false;

    try {
      await nodeStreamPost({
        url: `${this.baseUrl}/v1/chat/completions`,
        body,
        signal,
        onLine: (line) => {
          if (done) return;
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) return;
          const payload = trimmed.slice('data: '.length);
          if (payload === '[DONE]') { done = true; return; }
          try {
            const obj = JSON.parse(payload);
            const content: string = obj.choices?.[0]?.delta?.content ?? '';
            if (content) {
              onToken?.(content);
              accumulated += content;
            }
          } catch { /* skip malformed lines */ }
        },
      });
    } catch (err) {
      const error = err as Error;
      if (error.name === 'AbortError' || signal.aborted) {
        throw new ProviderError('Stream aborted', 'STREAM_ABORTED', error);
      }
      throw new ProviderError(
        `Cannot connect to LM Studio at ${this.baseUrl}`,
        'CONNECTION_REFUSED',
        error
      );
    }

    return accumulated;
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/v1/models`,
        method: 'GET',
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) return [];
      const models: Array<{ id: string }> = response.json.data ?? [];
      return models.map(m => m.id).sort();
    } catch {
      return [];
    }
  }

  async ping(): Promise<PingResult> {
    const start = Date.now();
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/v1/models`,
        method: 'GET',
        throw: false,
      });
      const latencyMs = Date.now() - start;
      if (response.status >= 200 && response.status < 300) {
        return { reachable: true, latencyMs };
      }
      return { reachable: false, latencyMs, errorMessage: `HTTP ${response.status}` };
    } catch (err) {
      return { reachable: false, latencyMs: 0, errorMessage: (err as Error).message };
    }
  }
}
