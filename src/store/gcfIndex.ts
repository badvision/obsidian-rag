import { decodeGeneric, formatScalar, parseScalar } from '@blackwell-systems/gcf';
import { VECTOR_CODEC, decodeVector, encodeVector } from './vectorCodec';

/**
 * GCF (generic profile) wire format for the vector index.
 *
 * The document is a single GCF generic-profile payload (see gcformat.com and
 * @blackwell-systems/gcf): a `GCF profile=generic` header, key=value scalar
 * metadata lines, two deferred-count tabular sections
 * (`## files [?]{...}` and `## chunks [?]{...}`) with pipe-delimited rows,
 * and a `##! summary counts=F,C` trailer. Every cell is formatted with the
 * official `formatScalar` (JSON-compatible quoting per SPEC 2.4); decoding
 * goes through the official `decodeGeneric`.
 *
 * Rows are plain lines, so the update merge can stream the committed file
 * and copy unaffected row bytes verbatim — vector cells are base64 strings
 * that never need to be decoded or re-encoded.
 */

export const INDEX_FORMAT_VERSION = 1;

// Bump this whenever the chunking algorithm changes in a way that makes
// existing index entries semantically incompatible with new ones.
// Version 2: fixed section-aware chunking regex; notes must be re-indexed.
export const CURRENT_SCHEMA_VERSION = 2;

export const FILES_FIELDS = ['vaultPath', 'mtime', 'chunkCount'] as const;
export const CHUNKS_FIELDS = ['id', 'vaultPath', 'page', 'chunkIndex', 'sourceType', 'text', 'embedding'] as const;
/** Position of the vaultPath column inside CHUNKS_FIELDS (merge scanner). */
export const VAULT_PATH_COLUMN = 1;

export interface IndexMeta {
  formatVersion: number;
  schemaVersion: number;
  embeddingModel: string;
  embeddingDimension: number;
  vectorCodec: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  vaultPath: string;
  mtime: number;
  chunkCount: number;
}

export interface ChunkRecord {
  id: string;
  vaultPath: string;
  page: number;
  chunkIndex: number;
  sourceType: 'pdf' | 'note';
  text: string;
  embedding: Float64Array;
}

function metaOf(embeddingModel: string, createdAt: string, updatedAt: string): IndexMeta {
  return {
    formatVersion: INDEX_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    embeddingModel,
    embeddingDimension: 0,
    vectorCodec: VECTOR_CODEC,
    createdAt,
    updatedAt,
  };
}

export function emptyMeta(embeddingModel: string): IndexMeta {
  const now = new Date().toISOString();
  return metaOf(embeddingModel, now, now);
}

// ── Encoding ────────────────────────────────────────────────────────────────

function formatCell(value: unknown): string {
  return formatScalar(value, 0x7c); // '|' context: quote when the cell contains the row delimiter
}

export function encodeFileRow(f: FileRecord): string {
  return [f.vaultPath, f.mtime, f.chunkCount].map(formatCell).join('|');
}

export function encodeChunkRow(c: {
  id: string;
  vaultPath: string;
  page: number;
  chunkIndex: number;
  sourceType: 'pdf' | 'note';
  text: string;
  embedding: ArrayLike<number>;
}): string {
  return [c.id, c.vaultPath, c.page, c.chunkIndex, c.sourceType, c.text, encodeVector(c.embedding)]
    .map(formatCell)
    .join('|');
}

/**
 * Assemble a complete index document. `chunkRowTexts` are already-encoded
 * row lines (verbatim from staging or re-encoded rows); they are written
 * through untouched.
 */
export const FILES_SECTION_HEADER = `## files [?]{${FILES_FIELDS.join(',')}}`;
export const CHUNKS_SECTION_HEADER = `## chunks [?]{${CHUNKS_FIELDS.join(',')}}`;

/** Header block (profile line + scalar metadata), byte-identical in every document. */
export function documentHeader(meta: IndexMeta): string {
  const lines: string[] = ['GCF profile=generic'];
  const kv = (key: string, value: unknown) => lines.push(`${key}=${formatCell(value)}`);
  kv('formatVersion', meta.formatVersion);
  kv('schemaVersion', meta.schemaVersion);
  kv('embeddingModel', meta.embeddingModel);
  kv('embeddingDimension', meta.embeddingDimension);
  kv('vectorCodec', meta.vectorCodec);
  kv('createdAt', meta.createdAt);
  kv('updatedAt', meta.updatedAt);
  return lines.join('\n') + '\n';
}

export function encodeIndexDocument(meta: IndexMeta, fileRecords: FileRecord[], chunkRowTexts: string[]): string {
  return (
    documentHeader(meta) +
    `${FILES_SECTION_HEADER}\n` +
    (fileRecords.length > 0 ? fileRecords.map(encodeFileRow).join('\n') + '\n' : '') +
    `${CHUNKS_SECTION_HEADER}\n` +
    (chunkRowTexts.length > 0 ? chunkRowTexts.join('\n') + '\n' : '') +
    `##! summary counts=${fileRecords.length},${chunkRowTexts.length}\n`
  );
}

// ── Line-level scanning (no whole-document object tree) ─────────────────────
//
// Mirrors the official quote state machine of @blackwell-systems/gcf
// (splitRespectingQuotes semantics: a backslash escapes the next char inside
// a quoted cell) so raw rows can be split/copied without decoding them.

/** Split a row line on top-level '|' respecting quoted cells (official grammar). */
export function splitRow(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) { current += c; escaped = false; continue; }
    if (c === '\\' && inQuote) { current += c; escaped = true; continue; }
    if (c === '"') { inQuote = !inQuote; current += c; continue; }
    if (c === '|' && !inQuote) { parts.push(current); current = ''; continue; }
    current += c;
  }
  parts.push(current);
  return parts;
}
/** Extract one cell from a row line without materializing the other cells. */
export function extractCell(line: string, index: number): string {
  let inQuote = false;
  let escaped = false;
  let cell = 0;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) { escaped = false; continue; }
    if (inQuote) {
      if (c === '\\') escaped = true;
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') { inQuote = true; if (start < 0) start = i; continue; }
    if (c === '|') {
      if (cell === index) return line.slice(start === -1 ? i : start, i);
      cell++;
      start = -1;
      continue;
    }
    if (start < 0) start = i;
  }
  if (cell === index) return line.slice(start === -1 ? 0 : start);
  throw new Error(`invalid_index: row has no cell ${index}`);
}

/** Decode the document's scalar header metadata; throws on a missing/foreign field. */
export function readMeta(metaMap: Map<string, unknown>): IndexMeta {
  const str = (k: string): string => {
    const v = metaMap.get(k);
    if (typeof v !== 'string') throw new Error(`invalid_index: missing or non-string metadata ${k}`);
    return v;
  };
  const num = (k: string): number => {
    const v = metaMap.get(k);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`invalid_index: missing or non-numeric metadata ${k}`);
    return v;
  };
  return {
    formatVersion: num('formatVersion'),
    schemaVersion: num('schemaVersion'),
    embeddingModel: str('embeddingModel'),
    embeddingDimension: num('embeddingDimension'),
    vectorCodec: str('vectorCodec'),
    createdAt: str('createdAt'),
    updatedAt: str('updatedAt'),
  };
}
// ── Full decode (query path) ────────────────────────────────────────────────

export interface DecodedIndex {
  meta: IndexMeta;
  fileRecords: FileRecord[];
  chunkRecords: ChunkRecord[];
}

/**
 * Decode a committed index document with the official GCF generic decoder.
 * Throws on malformed documents (including summary count mismatches).
 */
export function decodeIndexDocument(text: string): DecodedIndex {
  const root = decodeGeneric(text);
  if (!(root instanceof Map)) throw new Error('invalid_index: document is not an object');
  const meta = readMeta(root);
  if (meta.formatVersion !== INDEX_FORMAT_VERSION) {
    throw new Error(`invalid_index: unsupported format version ${meta.formatVersion}`);
  }

  const filesRaw = root.get('files');
  if (!Array.isArray(filesRaw)) throw new Error('invalid_index: missing files section');
  const fileRecords: FileRecord[] = filesRaw.map((r: unknown) => {
    if (!(r instanceof Map)) throw new Error('invalid_index: file row is not an object');
    const f = {
      vaultPath: r.get('vaultPath'),
      mtime: r.get('mtime'),
      chunkCount: r.get('chunkCount'),
    };
    if (typeof f.vaultPath !== 'string' || typeof f.mtime !== 'number' || typeof f.chunkCount !== 'number') {
      throw new Error('invalid_index: file row has non-scalar cells');
    }
    return f;
  });

  const chunksRaw = root.get('chunks');
  if (!Array.isArray(chunksRaw)) throw new Error('invalid_index: missing chunks section');
  const chunkRecords: ChunkRecord[] = chunksRaw.map((r: unknown) => {
    if (!(r instanceof Map)) throw new Error('invalid_index: chunk row is not an object');
    const c = {
      id: r.get('id'),
      vaultPath: r.get('vaultPath'),
      page: r.get('page'),
      chunkIndex: r.get('chunkIndex'),
      sourceType: r.get('sourceType'),
      text: r.get('text'),
      embedding: r.get('embedding'),
    };
    if (
      typeof c.id !== 'string' || typeof c.vaultPath !== 'string' || typeof c.page !== 'number' ||
      typeof c.chunkIndex !== 'number' || typeof c.text !== 'string' || typeof c.embedding !== 'string'
    ) {
      throw new Error('invalid_index: chunk row has non-scalar cells');
    }
    if (c.sourceType !== 'pdf' && c.sourceType !== 'note') {
      throw new Error(`invalid_index: unknown sourceType ${JSON.stringify(c.sourceType)}`);
    }
    return { ...c, sourceType: c.sourceType as 'pdf' | 'note', embedding: decodeVector(c.embedding) };
  });
  // The official decoder only validates summary counts when a summary is
  // present — a document torn at a complete row boundary still decodes as a
  // valid partial index. Our writer always ends with the trailer, so require
  // it explicitly and check it against the decoded tables.
  const trailer = /(?:^|\n)##! summary counts=(\d+),(\d+)\n$/.exec(text);
  if (!trailer) throw new Error('invalid_index: missing summary trailer (truncated file?)');
  if (Number(trailer[1]) !== fileRecords.length || Number(trailer[2]) !== chunkRecords.length) {
    throw new Error('invalid_index: summary counts do not match index tables');
  }

  return { meta, fileRecords, chunkRecords };
}
