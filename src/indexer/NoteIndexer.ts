import { App, TFile } from 'obsidian';
import { ChunkingService } from './ChunkingService';
import { EmbeddingService } from '../rag/EmbeddingService';
import { VectorStore } from '../store/VectorStore';
import { Chunk } from '../store/types';
import { IndexFileResult } from './types';

// ── Markdown → plain text ─────────────────────────────────────────────────────

/**
 * Strip markdown syntax so the embedding model sees clean prose instead of
 * formatting noise. Called on the *content* of each section after the
 * section title has already been extracted.
 */
export function markdownToPlainText(markdown: string): string {
  let text = markdown;
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/~~~[\s\S]*?~~~/g, '');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1.');       // residual headings
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');            // horizontal rules
  text = text.replace(/^([\t ]*[-*+]\s+)\[[ xX]\]\s*/gm, '$1'); // checkboxes
  text = text.replace(/^[\t ]*[-*+]\s+(.+)$/gm, '$1.');   // unordered list items
  text = text.replace(/^[\t ]*\d+[.)]\s+(.+)$/gm, '$1.'); // ordered list items
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');     // [[target|alias]]
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');                // [[target]]
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');           // [text](url)
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');          // images
  text = text.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1');
  text = text.replace(/_{1,3}([^_\n]+)_{1,3}/g, '$1');
  text = text.replace(/~~([^~\n]+)~~/g, '$1');
  text = text.replace(/`([^`\n]+)`/g, '$1');
  text = text.replace(/^>\s*/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  // Join lines within a paragraph so the sentence chunker sees prose
  text = text.replace(/([^\n])\n([^\n])/g, '$1 $2');
  return text.trim();
}

// ── Section-aware chunking ────────────────────────────────────────────────────

interface Section {
  title: string;   // header text, without # markers
  content: string; // raw markdown content under this header
}

/** Split text on ## headers (but not ###). */
function splitByH2(text: string): Section[] {
  const parts = text.split(/^(?=##(?!#)\s)/m);
  return parts
    .map(part => {
      // (.+) must be greedy so the full header title is captured, not just one char
      const m = part.match(/^##(?!#)\s+(.+)\s*\n([\s\S]*)$/);
      if (m) return { title: m[1].trim(), content: m[2].trim() };
      const trimmed = part.trim();
      return trimmed ? { title: '', content: trimmed } : null;
    })
    .filter((s): s is Section => s !== null && (!!s.title || !!s.content));
}

/** Split text on ### headers (but not ####). */
function splitByH3(text: string): Section[] {
  const parts = text.split(/^(?=###(?!#)\s)/m);
  return parts
    .map(part => {
      // (.+) must be greedy so the full header title is captured, not just one char
      const m = part.match(/^###(?!#)\s+(.+)\s*\n([\s\S]*)$/);
      if (m) return { title: m[1].trim(), content: m[2].trim() };
      const trimmed = part.trim();
      return trimmed ? { title: '', content: trimmed } : null;
    })
    .filter((s): s is Section => s !== null && (!!s.title || !!s.content));
}

/**
 * Chunk a markdown note by section headers, preserving section context on
 * every chunk so that embeddings remain semantically anchored.
 *
 * Strategy:
 *   1. Split on ## headers.
 *   2. If a section fits within chunkSize → one chunk with title prepended.
 *   3. If too long → split on ### sub-headers; each sub-chunk gets
 *      "H2 title > H3 title." as a prefix.
 *   4. If still too long (or no ### found) → sentence chunking, with the
 *      section title prepended to *every* resulting chunk so context is never
 *      lost across chunk boundaries.
 *   5. If there are no ## headers at all → plain sentence chunking.
 */
export function chunkMarkdownBySections(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  chunkingService: ChunkingService
): string[] {
  const h2Sections = splitByH2(text);

  // No ## structure — fall back to plain sentence chunking
  if (h2Sections.length === 0 || (h2Sections.length === 1 && !h2Sections[0].title)) {
    const cleaned = markdownToPlainText(text);
    return chunkingService.chunkText(cleaned, chunkSize, chunkOverlap);
  }

  const result: string[] = [];

  // Sections whose content is thinner than this aren't worth indexing — they
  // would produce near-meaningless chunks that crowd out real results in topK.
  const MIN_CONTENT_TOKENS = 10;

  for (const h2 of h2Sections) {
    const cleanedContent = markdownToPlainText(h2.content);
    if (chunkingService.countTokensApprox(cleanedContent) < MIN_CONTENT_TOKENS) continue;

    // Build the candidate text for this whole section
    const sectionText = h2.title ? `${h2.title}. ${cleanedContent}` : cleanedContent;

    if (chunkingService.countTokensApprox(sectionText) <= chunkSize) {
      // Whole section fits — emit as a single chunk
      result.push(sectionText.trim());
      continue;
    }

    // Section too long — try ### subsections
    const h3Sections = splitByH3(h2.content);
    const hasH3 = h3Sections.some(s => s.title);

    if (hasH3) {
      for (const h3 of h3Sections) {
        const cleanedH3 = markdownToPlainText(h3.content);
        if (chunkingService.countTokensApprox(cleanedH3) < MIN_CONTENT_TOKENS) continue;

        const titleParts = [h2.title, h3.title].filter(Boolean);
        const prefix = titleParts.join(' > ');
        const chunkText = prefix ? `${prefix}. ${cleanedH3}` : cleanedH3;

        if (chunkingService.countTokensApprox(chunkText) <= chunkSize) {
          result.push(chunkText.trim());
        } else {
          // Still too long — sentence-chunk but keep the prefix on every chunk
          const subChunks = chunkingService.chunkText(cleanedH3, chunkSize, chunkOverlap);
          for (const chunk of subChunks) {
            result.push(prefix ? `${prefix}. ${chunk}` : chunk);
          }
        }
      }
    } else {
      // No ### — sentence-chunk with h2 title on every chunk
      const subChunks = chunkingService.chunkText(cleanedContent, chunkSize, chunkOverlap);
      for (const chunk of subChunks) {
        result.push(h2.title ? `${h2.title}. ${chunk}` : chunk);
      }
    }
  }

  return result.filter(c => c.trim().length > 0);
}

// ── NoteIndexer ───────────────────────────────────────────────────────────────

export class NoteIndexer {
  constructor(
    private app: App,
    private chunkingService: ChunkingService,
    private embeddingService: EmbeddingService,
    private vectorStore: VectorStore
  ) {}

  async indexFile(
    file: TFile,
    settings: { chunkSize: number; chunkOverlap: number },
    signal?: AbortSignal
  ): Promise<IndexFileResult> {
    // Fingerprint check
    const storedMtime = this.vectorStore.getFileMtime(file.path);
    if (storedMtime === file.stat.mtime) {
      return { vaultPath: file.path, skipped: true, chunkCount: 0, pageCount: 0 };
    }

    const raw = await this.app.vault.read(file);

    // Strip YAML frontmatter
    const withoutFrontmatter = raw.replace(/^---[\s\S]*?---\n?/, '').trim();

    if (!withoutFrontmatter) {
      this.vectorStore.upsertFile(file.path, file.stat.mtime, []);
      return { vaultPath: file.path, skipped: false, chunkCount: 0, pageCount: 0 };
    }

    // Section-aware chunking: respects ## / ### structure and preserves context
    const chunkTexts = chunkMarkdownBySections(
      withoutFrontmatter,
      settings.chunkSize,
      settings.chunkOverlap,
      this.chunkingService
    );

    const chunks: Chunk[] = chunkTexts.map((text, idx) => ({
      id: `${file.path}::p0::c${idx}`,
      text,
      embedding: [],
      sourceType: 'note',
      vaultPath: file.path,
      page: 0,
      chunkIndex: idx,
    }));

    if (signal?.aborted) throw new Error('Indexing aborted');
    if (chunks.length > 0) {
      const embeddings = await this.embeddingService.embedBatch(chunks.map(c => c.text));
      chunks.forEach((c, i) => { c.embedding = embeddings[i]; });
    }

    this.vectorStore.upsertFile(file.path, file.stat.mtime, chunks);
    return { vaultPath: file.path, skipped: false, chunkCount: chunks.length, pageCount: 0 };
  }
}
