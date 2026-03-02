import { CitationService } from './CitationService';
import { Chunk } from '../store/types';
import { CitationSource } from './types';

const pdfChunk: Chunk = {
  id: 'papers/quantum.pdf::p3::c0',
  text: 'Quantum entanglement is a phenomenon...',
  embedding: [0.1, 0.2],
  sourceType: 'pdf',
  vaultPath: 'papers/quantum.pdf',
  page: 3,
  chunkIndex: 0,
};

const noteChunk: Chunk = {
  id: 'notes/meeting.md::p0::c0',
  text: 'Meeting discussed quantum topics...',
  embedding: [0.3, 0.4],
  sourceType: 'note',
  vaultPath: 'notes/meeting.md',
  page: 0,
  chunkIndex: 0,
};

describe('CitationService.buildCitationSource', () => {
  const service = new CitationService();

  test('PDF chunk: obsidianLink and displayLabel are correct', () => {
    const source = service.buildCitationSource(pdfChunk, 0.9);

    expect(source.obsidianLink).toBe('papers/quantum.pdf#page=3');
    expect(source.displayLabel).toBe('quantum.pdf p.3');
  });

  test('note chunk: obsidianLink is vaultPath and displayLabel strips .md', () => {
    const source = service.buildCitationSource(noteChunk, 0.75);

    expect(source.obsidianLink).toBe('notes/meeting.md');
    expect(source.displayLabel).toBe('meeting');
  });

  test('score is preserved on returned CitationSource', () => {
    const source = service.buildCitationSource(pdfChunk, 0.42);

    expect(source.score).toBe(0.42);
  });
});

describe('CitationService.formatContext', () => {
  const service = new CitationService();

  test('PDF source: contains correct header with filename, page, and citation marker', () => {
    const source = service.buildCitationSource(pdfChunk, 0.9);
    const context = service.formatContext([source]);

    expect(context).toContain('[Source 1] FROM quantum.pdf - Page 3 (cite as: [1])');
    expect(context).toContain(pdfChunk.text);
  });

  test('note source: contains header without Page segment', () => {
    const source = service.buildCitationSource(noteChunk, 0.75);
    const context = service.formatContext([source]);

    expect(context).toContain('[Source 1] FROM meeting.md (cite as: [1])');
    expect(context).not.toContain('Page');
    expect(context).toContain(noteChunk.text);
  });

  test('multiple sources: contains [Source 1] and [Source 2]', () => {
    const s1 = service.buildCitationSource(pdfChunk, 0.9);
    const s2 = service.buildCitationSource(noteChunk, 0.75);
    const context = service.formatContext([s1, s2]);

    expect(context).toContain('[Source 1]');
    expect(context).toContain('[Source 2]');
  });
});

describe('CitationService.buildMessages', () => {
  const service = new CitationService();

  test('returns array of exactly 2 messages with correct roles', () => {
    const messages = service.buildMessages('some context', 'what is X?');

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  test('user message content contains both context and question', () => {
    const context = 'SOURCE CONTEXT HERE';
    const question = 'What is entanglement?';
    const messages = service.buildMessages(context, question);

    expect(messages[1].content).toContain(context);
    expect(messages[1].content).toContain(question);
  });
});

describe('CitationService.validateCitations', () => {
  const service = new CitationService();

  const twoSources: CitationSource[] = [
    service.buildCitationSource(pdfChunk, 0.9),
    service.buildCitationSource(noteChunk, 0.75),
  ];

  test('valid citations within range are kept unchanged', () => {
    const answer = 'According to [1] and [2], this is true.';
    const result = service.validateCitations(answer, twoSources);

    expect(result).toBe(answer);
  });

  test('citation number exceeding sources.length is removed', () => {
    const answer = 'According to [1] and [3], this is true.';
    const result = service.validateCitations(answer, twoSources);

    expect(result).not.toContain('[3]');
    expect(result).toContain('[1]');
  });

  test('citation [0] is removed (below valid range)', () => {
    const answer = 'See [0] for more information.';
    const result = service.validateCitations(answer, twoSources);

    expect(result).not.toContain('[0]');
  });

  test('answer with no citations is returned unchanged', () => {
    const answer = 'There are no citations in this answer.';
    const result = service.validateCitations(answer, twoSources);

    expect(result).toBe(answer);
  });
});

describe('CitationService.assessConfidence', () => {
  const service = new CitationService();

  const threeSources: CitationSource[] = [
    service.buildCitationSource(pdfChunk, 0.9),
    service.buildCitationSource(noteChunk, 0.8),
    service.buildCitationSource(pdfChunk, 0.7),
  ];

  const oneSource: CitationSource[] = [
    service.buildCitationSource(pdfChunk, 0.9),
  ];

  test('uncertainty phrase yields insufficient', () => {
    const result = service.assessConfidence(
      "I don't have enough information to answer.",
      threeSources
    );

    expect(result).toBe('insufficient');
  });

  test('3+ citations with 3+ sources yields high', () => {
    const result = service.assessConfidence(
      '[1] shows that [2] confirms and [3] supports this.',
      threeSources
    );

    expect(result).toBe('high');
  });

  test('1 citation with 1 source yields medium', () => {
    const result = service.assessConfidence(
      '[1] says that quantum entanglement is real.',
      oneSource
    );

    expect(result).toBe('medium');
  });

  test('no citations and no uncertainty yields low', () => {
    const result = service.assessConfidence(
      'This answer has no citation markers at all.',
      oneSource
    );

    expect(result).toBe('low');
  });
});
