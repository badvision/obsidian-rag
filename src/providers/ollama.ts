import { requestUrl } from 'obsidian';
import { ChatMessage, EmbedResult, IProvider, PingResult, ProviderError } from './types';
import { nodeStreamPost } from './nodeHttp';

export class OllamaProvider implements IProvider {
  constructor(
    private baseUrl: string,
    private chatModel: string,
    private embeddingModel: string,
    private streamingEnabled: boolean
  ) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/api/embed`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embeddingModel, input: texts }),
        throw: false,
      });

      if (response.status === 404) {
        return this.embedFallback(texts);
      }

      const data = response.json;
      const embeddings: number[][] = data.embeddings;
      return { embeddings, dimension: embeddings[0].length };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Cannot connect to Ollama at ${this.baseUrl}`,
        'CONNECTION_REFUSED',
        err as Error
      );
    }
  }

  private async embedFallback(texts: string[]): Promise<EmbedResult> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      try {
        const response = await requestUrl({
          url: `${this.baseUrl}/api/embeddings`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.embeddingModel, prompt: text }),
          throw: false,
        });

        if (response.status === 404) {
          throw new ProviderError(
            `Embedding model '${this.embeddingModel}' not found in Ollama`,
            'MODEL_NOT_FOUND'
          );
        }

        embeddings.push(response.json.embedding as number[]);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(
          `Cannot connect to Ollama at ${this.baseUrl}`,
          'CONNECTION_REFUSED',
          err as Error
        );
      }
    }

    return { embeddings, dimension: embeddings[0].length };
  }

  async chat(
    messages: ChatMessage[],
    signal: AbortSignal,
    onToken?: (token: string) => void
  ): Promise<string> {
    const body = JSON.stringify({ model: this.chatModel, messages, stream: true });
    let accumulated = '';

    try {
      await nodeStreamPost({
        url: `${this.baseUrl}/api/chat`,
        body,
        signal,
        onLine: (line) => {
          try {
            const obj = JSON.parse(line);
            const content: string = obj.message?.content ?? '';
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
        `Cannot connect to Ollama at ${this.baseUrl}`,
        'CONNECTION_REFUSED',
        error
      );
    }

    return accumulated;
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/api/tags`,
        method: 'GET',
        throw: false,
      });
      if (response.status < 200 || response.status >= 300) return [];
      const models: Array<{ name: string }> = response.json.models ?? [];
      return models.map(m => m.name).sort();
    } catch {
      return [];
    }
  }

  async ping(): Promise<PingResult> {
    const start = Date.now();
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/api/version`,
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
