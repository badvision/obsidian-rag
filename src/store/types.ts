export interface Chunk {
  id: string;           // `${vaultPath}::p${page}::c${chunkIndex}`
  text: string;
  embedding: number[];
  sourceType: 'pdf' | 'note';
  vaultPath: string;
  page: number;         // 1-based for PDFs; 0 for markdown notes
  chunkIndex: number;
}

export interface FileEntry {
  vaultPath: string;
  mtime: number;
  chunkIds: string[];
}

export interface VectorIndexData {
  schemaVersion: number;
  embeddingModel: string;
  embeddingDimension: number;
  createdAt: string;
  updatedAt: string;
  files: Record<string, FileEntry>;
  chunks: Chunk[];
}
