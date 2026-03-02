import { Chunk } from '../store/types';
import { CitationSource, RagAnswer } from './types';
import { ChatMessage } from '../providers/types';

const UNCERTAINTY_PHRASES = [
  "don't have",
  'insufficient',
  'not found',
  'not clear',
  'cannot find',
  'no information',
  'unable to find',
  'not available',
];

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

export class CitationService {
  buildCitationSource(chunk: Chunk, score: number): CitationSource {
    if (chunk.sourceType === 'pdf') {
      return {
        chunk,
        score,
        obsidianLink: `${chunk.vaultPath}#page=${chunk.page}`,
        displayLabel: `${basename(chunk.vaultPath)} p.${chunk.page}`,
      };
    }

    const filename = basename(chunk.vaultPath);
    const displayLabel = filename.replace(/\.md$/i, '');

    return {
      chunk,
      score,
      obsidianLink: chunk.vaultPath,
      displayLabel,
    };
  }

  formatContext(sources: CitationSource[]): string {
    return sources
      .map((source, index) => {
        const i = index + 1;
        const filename = basename(source.chunk.vaultPath);

        if (source.chunk.sourceType === 'pdf') {
          return `\n[Source ${i}] FROM ${filename} - Page ${source.chunk.page} (cite as: [${i}])\n${source.chunk.text}\n`;
        }

        return `\n[Source ${i}] FROM ${filename} (cite as: [${i}])\n${source.chunk.text}\n`;
      })
      .join('');
  }

  buildMessages(context: string, question: string): ChatMessage[] {
    return [
      {
        role: 'system',
        content: `You are a precise research assistant. Answer questions based ONLY on the provided source documents.
Always cite your sources using [N] notation where N is the source number.
If information is not in the provided sources, say so clearly.
Be concise and accurate.`,
      },
      {
        role: 'user',
        content: `SOURCE DOCUMENTS:\n${context}\n\nQUESTION: ${question}\n\nAnswer based on the sources above, using [N] citation numbers.`,
      },
    ];
  }

  validateCitations(answer: string, sources: CitationSource[]): string {
    return answer.replace(/\[(\d+)\]/g, (match, numStr) => {
      const n = parseInt(numStr, 10);
      if (n < 1 || n > sources.length) return '';
      return match;
    });
  }

  assessConfidence(answer: string, sources: CitationSource[]): RagAnswer['confidence'] {
    const lower = answer.toLowerCase();
    if (UNCERTAINTY_PHRASES.some(p => lower.includes(p))) {
      return 'insufficient';
    }

    const citationCount = (answer.match(/\[\d+\]/g) || []).length;

    if (citationCount >= 3 && sources.length >= 3) {
      return 'high';
    }

    if (citationCount >= 1) {
      return 'medium';
    }

    return 'low';
  }
}
