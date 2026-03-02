import { App, TFile, loadPdfJs } from 'obsidian';
import { ChunkingService } from './ChunkingService';
import { EmbeddingService } from '../rag/EmbeddingService';
import { VectorStore } from '../store/VectorStore';
import { Chunk } from '../store/types';
import { IndexFileResult } from './types';

export class PDFIndexer {
  constructor(
    private app: App,
    private chunkingService: ChunkingService,
    private embeddingService: EmbeddingService,
    private vectorStore: VectorStore
  ) {}

  async indexFile(
    file: TFile,
    settings: { chunkSize: number; chunkOverlap: number },
    onProgress?: (page: number, totalPages: number) => void,
    signal?: AbortSignal
  ): Promise<IndexFileResult> {
    // Step 1: Fingerprint check
    const storedMtime = this.vectorStore.getFileMtime(file.path);
    if (storedMtime === file.stat.mtime) {
      return { vaultPath: file.path, skipped: true, chunkCount: 0, pageCount: 0 };
    }

    // Step 2: Load PDF
    const pdfjsLib = await loadPdfJs();
    const arrayBuffer = await this.app.vault.readBinary(file);
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;

    // Step 3: Extract text per page (1-based page numbers)
    const pageTexts: Array<{ page: number; text: string }> = [];
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (signal?.aborted) throw new Error('Indexing aborted');
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item: any) => ('str' in item ? item.str : ''))
        .join(' ')
        .trim();
      pageTexts.push({ page: pageNum, text });
      onProgress?.(pageNum, totalPages);
    }

    // Step 4: Detect scanned PDF
    const emptyPages = pageTexts.filter(p => p.text.length < 10).length;
    const warningScannedPdf = emptyPages / totalPages > 0.3;

    // Step 5: Chunk per page
    const allChunks: Chunk[] = [];
    for (const { page, text } of pageTexts) {
      if (!text) continue;
      const chunkTexts = this.chunkingService.chunkText(text, settings.chunkSize, settings.chunkOverlap);
      chunkTexts.forEach((chunkText, idx) => {
        allChunks.push({
          id: `${file.path}::p${page}::c${idx}`,
          text: chunkText,
          embedding: [],
          sourceType: 'pdf',
          vaultPath: file.path,
          page,
          chunkIndex: idx,
        });
      });
    }

    // Step 6: Embed chunks
    if (allChunks.length > 0) {
      const texts = allChunks.map(c => c.text);
      const embeddings = await this.embeddingService.embedBatch(texts);
      allChunks.forEach((c, i) => { c.embedding = embeddings[i]; });
    }

    // Step 7: Upsert to store
    this.vectorStore.upsertFile(file.path, file.stat.mtime, allChunks);

    // Step 8: Return result
    return {
      vaultPath: file.path,
      skipped: false,
      chunkCount: allChunks.length,
      pageCount: totalPages,
      warningScannedPdf,
    };
  }
}
