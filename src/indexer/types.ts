export interface IndexFileResult {
  vaultPath: string;
  skipped: boolean;
  chunkCount: number;
  pageCount: number;
  warningScannedPdf?: boolean;
  error?: Error;
}

export interface IndexAllResult {
  indexed: number;
  skipped: number;
  failed: number;
  warnings: string[];
}
