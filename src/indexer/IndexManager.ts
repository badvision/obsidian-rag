import { App, TFile } from 'obsidian';
import { ChunkingService } from './ChunkingService';
import { EmbeddingService } from '../rag/EmbeddingService';
import { VectorStore } from '../store/VectorStore';
import { PDFIndexer } from './PDFIndexer';
import { NoteIndexer } from './NoteIndexer';
import { RagPluginSettings } from '../settings';
import { IndexAllResult } from './types';

export class IndexManager {
  private pdfIndexer: PDFIndexer;
  private noteIndexer: NoteIndexer;

  constructor(
    private app: App,
    private chunkingService: ChunkingService,
    private embeddingService: EmbeddingService,
    private vectorStore: VectorStore,
    pdfIndexer?: PDFIndexer,
    noteIndexer?: NoteIndexer
  ) {
    this.pdfIndexer = pdfIndexer ?? new PDFIndexer(app, chunkingService, embeddingService, vectorStore);
    this.noteIndexer = noteIndexer ?? new NoteIndexer(app, chunkingService, embeddingService, vectorStore);
  }

  getFilesToIndex(scope: RagPluginSettings['indexScope']): TFile[] {
    const files = this.app.vault.getFiles();
    if (scope === 'pdfs-only') {
      return files.filter(f => f.extension === 'pdf');
    }
    return files.filter(f => f.extension === 'pdf' || f.extension === 'md');
  }

  async indexAll(
    settings: RagPluginSettings,
    onProgress?: (current: number, total: number, filename: string) => void,
    signal?: AbortSignal
  ): Promise<IndexAllResult> {
    await this.vectorStore.ensureLoaded(settings.embeddingModel);
    const files = this.getFilesToIndex(settings.indexScope);
    const result: IndexAllResult = { indexed: 0, skipped: 0, failed: 0, warnings: [] };
    let saveCounter = 0;

    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) break;
      const file = files[i];
      onProgress?.(i + 1, files.length, file.name);

      try {
        let fileResult;
        if (file.extension === 'pdf') {
          fileResult = await this.pdfIndexer.indexFile(file, settings, undefined, signal);
        } else {
          fileResult = await this.noteIndexer.indexFile(file, settings, signal);
        }

        if (fileResult.skipped) {
          result.skipped++;
        } else {
          result.indexed++;
          if (fileResult.warningScannedPdf) {
            result.warnings.push(`'${file.name}' may be scanned — no text layer found on most pages.`);
          }
        }
      } catch (err) {
        if ((err as Error).message === 'Indexing aborted') break;
        console.error(`Failed to index ${file.path}:`, err);
        result.failed++;
      }

      saveCounter++;
      if (saveCounter % 10 === 0) {
        await this.vectorStore.save();
      }
    }

    await this.vectorStore.save();
    return result;
  }

  async indexCurrentFile(file: TFile, settings: RagPluginSettings): Promise<IndexAllResult> {
    await this.vectorStore.ensureLoaded(settings.embeddingModel);
    const result: IndexAllResult = { indexed: 0, skipped: 0, failed: 0, warnings: [] };
    try {
      let fileResult;
      if (file.extension === 'pdf') {
        fileResult = await this.pdfIndexer.indexFile(file, settings);
      } else {
        fileResult = await this.noteIndexer.indexFile(file, settings);
      }
      if (fileResult.skipped) result.skipped++;
      else result.indexed++;
      if (fileResult.warningScannedPdf) result.warnings.push(`'${file.name}' may be scanned.`);
    } catch (err) {
      result.failed++;
    }
    await this.vectorStore.save();
    return result;
  }

  async removeFile(vaultPath: string): Promise<void> {
    this.vectorStore.removeFile(vaultPath);
    await this.vectorStore.save();
  }
}
