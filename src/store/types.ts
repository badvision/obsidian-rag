export interface Chunk {
  id: string;           // `${vaultPath}::p${page}::c${chunkIndex}`
  text: string;
  embedding: number[];
  sourceType: 'pdf' | 'note';
  vaultPath: string;
  page: number;         // 1-based for PDFs; 0 for markdown notes
  chunkIndex: number;
}

