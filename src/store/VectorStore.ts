import { App } from 'obsidian';
import { Chunk, FileEntry, VectorIndexData } from './types';
import { ProviderError } from '../providers/types';

// Bump this whenever the chunking algorithm changes in a way that makes
// existing index entries semantically incompatible with new ones.
// Version 2: fixed section-aware chunking regex; notes must be re-indexed.
const CURRENT_SCHEMA_VERSION = 2;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class VectorStore {
  private data: VectorIndexData;
  private loaded = false;
  private indexPath: string;
  schemaUpgraded = false;

  constructor(private pluginDir: string, private app: App) {
    this.indexPath = pluginDir + '/index/index.json';
    this.data = this.emptyIndex('');
  }

  private emptyIndex(embeddingModel: string): VectorIndexData {
    const now = new Date().toISOString();
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      embeddingModel,
      embeddingDimension: 0,
      createdAt: now,
      updatedAt: now,
      files: {},
      chunks: [],
    };
  }

  async ensureLoaded(embeddingModel: string): Promise<void> {
    if (this.loaded) return;

    const exists = await this.app.vault.adapter.exists(this.indexPath);
    if (!exists) {
      this.data = this.emptyIndex(embeddingModel);
      this.loaded = true;
      return;
    }

    const raw = await this.app.vault.adapter.read(this.indexPath);
    const parsed = JSON.parse(raw) as VectorIndexData;

    if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      this.schemaUpgraded = true;
      this.data = this.emptyIndex(embeddingModel);
      this.loaded = true;
      return;
    }

    if (parsed.embeddingModel === '') {
      // Index was saved before embeddingModel was stamped — adopt current model.
      parsed.embeddingModel = embeddingModel;
    } else if (parsed.embeddingModel !== embeddingModel) {
      throw new ProviderError(
        `Embedding model changed from '${parsed.embeddingModel}' to '${embeddingModel}'. Re-index required.`,
        'DIMENSION_MISMATCH'
      );
    }

    this.data = parsed;
    this.loaded = true;
  }

  async save(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    await this.app.vault.adapter.mkdir(this.pluginDir + '/index');
    await this.app.vault.adapter.write(this.indexPath, JSON.stringify(this.data, null, 2));
  }

  upsertFile(vaultPath: string, mtime: number, chunks: Chunk[]): void {
    this.data.chunks = this.data.chunks.filter(c => c.vaultPath !== vaultPath);
    this.data.chunks.push(...chunks);
    // Record embedding dimension from the first real embedding we see
    if (this.data.embeddingDimension === 0 && chunks.length > 0 && chunks[0].embedding.length > 0) {
      this.data.embeddingDimension = chunks[0].embedding.length;
    }
    const entry: FileEntry = {
      vaultPath,
      mtime,
      chunkIds: chunks.map(c => c.id),
    };
    this.data.files[vaultPath] = entry;
  }

  removeFile(vaultPath: string): void {
    this.data.chunks = this.data.chunks.filter(c => c.vaultPath !== vaultPath);
    delete this.data.files[vaultPath];
  }

  getFileMtime(vaultPath: string): number | null {
    return this.data.files[vaultPath]?.mtime ?? null;
  }

  query(queryEmbedding: number[], topK: number): Array<{ chunk: Chunk; score: number }> {
    if (this.data.chunks.length === 0) return [];

    const scored = this.data.chunks.map(chunk => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async clear(embeddingModel: string): Promise<void> {
    this.data = this.emptyIndex(embeddingModel);
    await this.save();
  }

  async exists(): Promise<boolean> {
    return this.app.vault.adapter.exists(this.indexPath);
  }

  getStats(): { fileCount: number; chunkCount: number; embeddingModel: string; updatedAt: string } {
    return {
      fileCount: Object.keys(this.data.files).length,
      chunkCount: this.data.chunks.length,
      embeddingModel: this.data.embeddingModel,
      updatedAt: this.data.updatedAt,
    };
  }
}
