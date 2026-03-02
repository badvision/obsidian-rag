import { Chunk } from '../store/types';

export interface CitationSource {
  chunk: Chunk;
  score: number;
  obsidianLink: string;   // e.g. "Papers/quantum.pdf#page=42" — no brackets
  displayLabel: string;   // e.g. "quantum.pdf p.42" or "Meeting Notes"
}

export interface RagAnswer {
  question: string;
  answer: string;
  sources: CitationSource[];
  confidence: 'high' | 'medium' | 'low' | 'insufficient';
  durationMs: number;
}
