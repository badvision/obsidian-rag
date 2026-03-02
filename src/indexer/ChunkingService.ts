export class ChunkingService {
  /**
   * Approximate token count using word count * 1.3 multiplier.
   */
  countTokensApprox(text: string): number {
    return Math.floor(text.split(/\s+/).filter(t => t.length > 0).length * 1.3);
  }

  /**
   * Sentence-aware sliding window chunker.
   * Splits text into chunks of approximately chunkSize tokens with chunkOverlap
   * tokens of overlap between consecutive chunks.
   */
  chunkText(text: string, chunkSize: number, chunkOverlap: number): string[] {
    if (text.trim().length === 0) return [];

    // Split into sentences using lookbehind for sentence-ending punctuation
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);

    const chunks: string[] = [];
    let currentChunk = '';

    for (const sentence of sentences) {
      const sentenceTokens = this.countTokensApprox(sentence);

      // If the sentence itself exceeds chunkSize, split it at word level
      if (sentenceTokens > chunkSize) {
        // Flush current chunk first if non-empty
        if (currentChunk.trim().length > 0) {
          chunks.push(currentChunk.trim());
        }
        const wordChunks = this.splitLongSentence(sentence, chunkSize, chunkOverlap);
        for (const wc of wordChunks) {
          chunks.push(wc.trim());
        }
        currentChunk = this.buildOverlapPrefix(chunks[chunks.length - 1] ?? '', chunkOverlap);
        continue;
      }

      // Would adding this sentence exceed chunkSize?
      const candidate = currentChunk.length > 0
        ? currentChunk + ' ' + sentence
        : sentence;

      if (this.countTokensApprox(candidate) > chunkSize && currentChunk.trim().length > 0) {
        // Save current chunk
        chunks.push(currentChunk.trim());
        // Start new chunk with overlap from previous chunk
        const overlapPrefix = this.buildOverlapPrefix(currentChunk, chunkOverlap);
        currentChunk = overlapPrefix.length > 0
          ? overlapPrefix + ' ' + sentence
          : sentence;
      } else {
        currentChunk = candidate;
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Build an overlap prefix of approximately chunkOverlap tokens
   * from the tail of the previous chunk.
   */
  private buildOverlapPrefix(prevChunk: string, chunkOverlap: number): string {
    const words = prevChunk.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return '';

    // Take approximately chunkOverlap tokens worth of words from the end.
    // Since countTokensApprox multiplies by 1.3, we need roughly chunkOverlap/1.3 words.
    const wordCount = Math.max(1, Math.ceil(chunkOverlap / 1.3));
    const overlapWords = words.slice(-wordCount);
    return overlapWords.join(' ');
  }

  /**
   * Split a single long sentence into word-level chunks with overlap.
   */
  private splitLongSentence(sentence: string, chunkSize: number, chunkOverlap: number): string[] {
    const words = sentence.split(/\s+/).filter(w => w.length > 0);
    const chunks: string[] = [];
    let currentWords: string[] = [];

    for (const word of words) {
      const candidate = [...currentWords, word];
      if (this.countTokensApprox(candidate.join(' ')) > chunkSize && currentWords.length > 0) {
        chunks.push(currentWords.join(' '));
        // Start new word chunk with overlap
        const wordCount = Math.max(1, Math.ceil(chunkOverlap / 1.3));
        currentWords = currentWords.slice(-wordCount);
        currentWords.push(word);
      } else {
        currentWords.push(word);
      }
    }

    if (currentWords.length > 0) {
      chunks.push(currentWords.join(' '));
    }

    return chunks;
  }
}
