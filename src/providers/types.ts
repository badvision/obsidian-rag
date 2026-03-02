export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EmbedResult {
  embeddings: number[][];
  dimension: number;
}

export interface PingResult {
  reachable: boolean;
  latencyMs: number;
  errorMessage?: string;
}

export type ProviderErrorCode =
  | 'CONNECTION_REFUSED'
  | 'MODEL_NOT_FOUND'
  | 'EMBEDDING_NOT_SUPPORTED'
  | 'REQUEST_TIMEOUT'
  | 'STREAM_ABORTED'
  | 'UNEXPECTED_RESPONSE'
  | 'DIMENSION_MISMATCH';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: ProviderErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface IProvider {
  embed(texts: string[]): Promise<EmbedResult>;
  chat(
    messages: ChatMessage[],
    signal: AbortSignal,
    onToken?: (token: string) => void
  ): Promise<string>;
  ping(): Promise<PingResult>;
  listModels(): Promise<string[]>;
}
