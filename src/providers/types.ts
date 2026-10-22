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
  /**
   * Optional parsed sample response returned by a round-trip probe.
   * Set by CLI providers so the settings Test button can show the user
   * exactly what was extracted from the tool's output.
   */
  sampleResponse?: string;
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

/**
 * Embedding role — powers indexing and semantic search.
 * Selected independently of the chat provider.
 */
export interface IEmbedder {
  embed(texts: string[]): Promise<EmbedResult>;
  ping(): Promise<PingResult>;
  listModels(): Promise<string[]>;
}

/**
 * Chat role — generates answers.
 * Selected independently of the embedding provider.
 */
export interface IChatProvider {
  chat(
    messages: ChatMessage[],
    signal: AbortSignal,
    onToken?: (token: string) => void
  ): Promise<string>;
  ping(): Promise<PingResult>;
  listModels(): Promise<string[]>;
}
