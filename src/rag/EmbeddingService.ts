import type { EmbedResult, IEmbedder } from '../providers/types';

export class EmbeddingService {
  /** Embed calls currently in flight — dispose must not tear the model down mid-inference. */
  private inFlight = 0;
  /** Explicit "keep the model alive" scopes (e.g. a full index run holding the worker across files). */
  private sessionCount = 0;
  /** Single-flight guard: concurrent dispose() calls share one provider.dispose() invocation. */
  private disposePromise: Promise<void> | null = null;

  constructor(private provider: IEmbedder) {}

  async embedBatch(texts: string[], batchSize = 20): Promise<number[][]> {
    if (texts.length === 0) return [];

    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const result = await this.callEmbed(batch);
      allEmbeddings.push(...result.embeddings);
    }

    return allEmbeddings;
  }

  async embedQuery(text: string): Promise<number[]> {
    const result = await this.callEmbed([text]);
    return result.embeddings[0];
  }

  /**
   * Hold the model across a sequence of embedding calls so dispose() does
   * not tear it down between files. Pairs with endSession().
   */
  beginSession(): void {
    this.sessionCount++;
  }

  endSession(): void {
    if (this.sessionCount > 0) this.sessionCount--;
  }

  /**
   * Release the underlying model / inference process when idle.
   * No-op while an embed is in flight or a session is held; single-flight,
   * and safe to call repeatedly (a provider reloads lazily on next use).
   */
  dispose(): Promise<void> {
    if (this.inFlight > 0 || this.sessionCount > 0) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;
    const base = this.provider.dispose ? this.provider.dispose() : Promise.resolve();
    this.disposePromise = base.finally(() => {
      this.disposePromise = null;
    });
    return this.disposePromise;
  }

  /**
   * Unconditional release for plugin unload. Bypasses the in-flight/session
   * guards and invokes provider.dispose() immediately; the provider is
   * contractually cancel-safe and bounded (kills its worker rather than
   * waiting for a hung inference). Single-flights with dispose(), so a
   * normal release already running is reused, never doubled.
   */
  forceDispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    const base = this.provider.dispose ? this.provider.dispose() : Promise.resolve();
    this.disposePromise = base.finally(() => {
      this.disposePromise = null;
    });
    return this.disposePromise;
  }

  private async callEmbed(texts: string[]): Promise<EmbedResult> {
    this.inFlight++;
    try {
      return await this.provider.embed(texts);
    } finally {
      this.inFlight--;
    }
  }
}
