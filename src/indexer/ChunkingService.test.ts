import { ChunkingService } from './ChunkingService';

describe('ChunkingService', () => {
  let svc: ChunkingService;

  beforeEach(() => {
    svc = new ChunkingService();
  });

  // ---- countTokensApprox ----

  test('countTokensApprox: "hello world" → 2', () => {
    // 2 words * 1.3 = 2.6 → Math.floor = 2
    expect(svc.countTokensApprox('hello world')).toBe(2);
  });

  test('countTokensApprox: empty string → 0', () => {
    expect(svc.countTokensApprox('')).toBe(0);
  });

  test('countTokensApprox: multiple spaces and newlines treated as single separator', () => {
    // "a  b\nc" → 3 tokens * 1.3 = 3.9 → 3
    expect(svc.countTokensApprox('a  b\nc')).toBe(3);
  });

  test('countTokensApprox: single word → 1', () => {
    // 1 * 1.3 = 1.3 → 1
    expect(svc.countTokensApprox('hello')).toBe(1);
  });

  // ---- chunkText edge cases ----

  test('chunkText: empty string → []', () => {
    expect(svc.chunkText('', 500, 50)).toEqual([]);
  });

  test('chunkText: whitespace-only → []', () => {
    expect(svc.chunkText('   \n  \t  ', 500, 50)).toEqual([]);
  });

  test('chunkText: text shorter than chunkSize → single chunk', () => {
    const result = svc.chunkText('Short text.', 500, 50);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Short text.');
  });

  test('chunkText: text well under limit returns single chunk without modification', () => {
    const text = 'Hello world. How are you?';
    const result = svc.chunkText(text, 500, 50);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  // ---- chunkText multi-chunk ----

  test('chunkText: long text produces multiple chunks within token limit', () => {
    // Build text with many short sentences; chunkSize=20 forces splits
    const sentences: string[] = [];
    for (let i = 0; i < 20; i++) {
      sentences.push(`This is sentence number ${i} with some words.`);
    }
    const text = sentences.join(' ');

    const result = svc.chunkText(text, 20, 5);

    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(svc.countTokensApprox(chunk)).toBeLessThanOrEqual(30); // allow some headroom for overlap
    }
  });

  test('chunkText: consecutive chunks share overlap words', () => {
    const sentences: string[] = [];
    for (let i = 0; i < 20; i++) {
      sentences.push(`Sentence ${i} has several words here today.`);
    }
    const text = sentences.join(' ');

    const result = svc.chunkText(text, 20, 5);

    expect(result.length).toBeGreaterThan(1);
    // The end of chunk[0] and start of chunk[1] should share some words
    const wordsEnd0 = result[0].trim().split(/\s+/).slice(-3);
    const wordsStart1 = result[1].trim().split(/\s+/).slice(0, 6);
    const hasOverlap = wordsEnd0.some((w: string) => wordsStart1.includes(w));
    expect(hasOverlap).toBe(true);
  });

  // ---- chunkText: single very long sentence ----

  test('chunkText: single very long sentence splits into multiple word-level chunks', () => {
    // Build a single sentence of ~100 tokens (no sentence-ending punctuation until the end)
    const words: string[] = [];
    for (let i = 0; i < 80; i++) {
      words.push(`word${i}`);
    }
    const text = words.join(' ') + '.';

    const result = svc.chunkText(text, 20, 5);

    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(svc.countTokensApprox(chunk)).toBeLessThanOrEqual(30);
    }
  });

  // ---- chunkText: sentence boundary respect ----

  test('chunkText: sentence boundaries respected where possible', () => {
    // Use clearly separated sentences; with enough room per chunk, each sentence
    // should stay whole (not split mid-sentence)
    const text =
      'First sentence ends here. Second sentence is here. Third one is this.';

    // Large chunk size so all fit in one chunk
    const result = svc.chunkText(text, 500, 50);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  test('chunkText: sentence-ending punctuation triggers correct splitting', () => {
    // Build two groups with sentence boundaries
    const part1Words = Array.from({ length: 10 }, (_, i) => `wordA${i}`).join(' ');
    const part2Words = Array.from({ length: 10 }, (_, i) => `wordB${i}`).join(' ');
    const text = `${part1Words}. ${part2Words}.`;

    // chunkSize = 15 forces a split roughly at the sentence boundary
    const result = svc.chunkText(text, 15, 3);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  // ---- return type ----

  test('chunkText: each result is a trimmed string', () => {
    const sentences: string[] = [];
    for (let i = 0; i < 15; i++) {
      sentences.push(`Chunk test sentence ${i} with padding words here.`);
    }
    const text = sentences.join(' ');

    const result = svc.chunkText(text, 20, 5);
    for (const chunk of result) {
      expect(typeof chunk).toBe('string');
      expect(chunk).toBe(chunk.trim());
      expect(chunk.length).toBeGreaterThan(0);
    }
  });
});
