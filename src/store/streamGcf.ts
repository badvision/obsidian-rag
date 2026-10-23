import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';
import { Transform } from 'stream';
import type { Readable, Writable } from 'stream';
import { StringDecoder } from 'string_decoder';
import { parseScalar } from '@blackwell-systems/gcf';
import {
  CHUNKS_FIELDS,
  FILES_FIELDS,
  VAULT_PATH_COLUMN,
  INDEX_FORMAT_VERSION,
  extractCell,
  readMeta,
  splitRow,
} from './gcfIndex';
import type { FileRecord, IndexMeta } from './gcfIndex';
import { decodeVector } from './vectorCodec';

/**
 * Physical-filesystem row streaming for the GCF index.
 *
 * The committed document can be hundreds of MB; publication and preparation
 * must never materialize it (or all of its vectors) in renderer memory.
 * Rows are streamed line-by-line from the physical file (the vault adapter's
 * base directory resolves to a real path on desktop) with pipe backpressure,
 * and only lightweight file-table metadata is retained in memory.
 */

/** Resolve a vault-relative path to its physical path under the adapter base. */
export function resolvePhysicalPath(base: string, vaultPath: string): string {
  return base.endsWith('/') ? base + vaultPath : base + '/' + vaultPath;
}

/**
 * Stream a UTF-8 file as lines. A StringDecoder is required so multibyte
 * characters split across read chunks are never corrupted. Rows are complete
 * on a line: the GCF generic profile escapes newlines inside cells.
 */
export function openLines(file: string): Readable {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return fs
    .createReadStream(file, { encoding: 'utf8' })
    .pipe(
      new Transform({ readableObjectMode: true,
        transform(chunk: string, _enc, cb) {
          const lines = (pending + decoder.write(chunk)).split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) this.push(line);
          cb();
        },
        flush(cb) {
          const tail = pending + decoder.end();
          if (tail !== '') this.push(tail);
          cb();
        },
      })
    );
}

/** Resolve when `w` drains (after a write returned false); reject on stream error. */
function writeDrained(w: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    w.once('drain', resolve);
    w.once('error', reject);
  });
}

/** Write text (expected to end with '\n') honoring the stream's backpressure. */
export function writeText(w: Writable, text: string): Promise<void> {
  if (w.write(text)) return Promise.resolve();
  return writeDrained(w);
}

/**
 * Stream `rows` onto `w` (without ending it). Each row is written with an
 * explicit write/drain pump rather than pipe(): a pipe's source 'end' fires
 * when the reader is exhausted, but rows can still be in flight inside the
 * pipe at that moment — a summary trailer written right after would then
 * land BEFORE unflushed rows (observed on a 77 MB / 12k-row publish). The
 * pump guarantees every accepted row is queued on `w` before this resolves,
 * and the Writable's ordered buffer guarantees the trailer written next
 * lands after them. Backpressure still flows: a slow disk pauses the source.
 * Emitted lines are counted on `counter` for the summary trailer.
 */
export async function appendRows(
  w: Writable,
  rows: Readable,
  counter: { count: number }
): Promise<void> {
  try {
    for await (const line of rows) {
      counter.count++;
      // Row streams emit bare lines; document rows are newline-terminated.
      if (!w.write(line + '\n')) {
        await writeDrained(w);
      }
    }
  } catch (err) {
    rows.destroy(); // release the source read on failure
    throw err;
  }
}

function vaultPathOf(line: string): string | null {
  try {
    const v = parseScalar(extractCell(line, VAULT_PATH_COLUMN), true);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Stream the committed document's `## chunks` rows, dropping the rows of
 * `skipVaultPaths` (affected files are replaced by staged rows). All other
 * sections (header, files, summary) are filtered out.
 */
export function committedChunkRows(file: string, skipVaultPaths: ReadonlySet<string>): Readable {
  let section = 'none';
  return openLines(file).pipe(
    new Transform({
      objectMode: true,
      transform(line: string, _enc, cb) {
        if (line.startsWith('## ')) {
          section = line.startsWith('## chunks ') ? 'chunks' : 'other';
          cb();
          return;
        }
        if (line.startsWith('##!')) {
          cb(); // summary trailer: rewritten by the publisher
          return;
        }
        if (section !== 'chunks') {
          cb();
          return;
        }
        const p = vaultPathOf(line);
        if (p !== null && skipVaultPaths.has(p)) {
          cb();
        } else {
          cb(null, line); // row of an unaffected file: copy verbatim, undecoded
        }
      },
    })
  );
}

/** Stream the staging document's rows, keeping only the latest block of each confirmed upsert. */
export function stagedChunkRows(
  file: string,
  upserted: ReadonlySet<string>,
  rowStarts: ReadonlyMap<string, number>
): Readable {
  let section = 'none';
  let rowIdx = 0;
  return openLines(file).pipe(
    new Transform({
      objectMode: true,
      transform(line: string, _enc, cb) {
        if (line.startsWith('## ')) {
          section = line.startsWith('## upserts ') ? 'upserts' : 'other';
          rowIdx = 0;
          cb();
          return;
        }
        if (line.startsWith('##!')) {
          cb();
          return;
        }
        if (section !== 'upserts') {
          cb();
          return;
        }
        const idx = rowIdx++;
        const p = vaultPathOf(line);
        const start = p !== null ? rowStarts.get(p) : undefined;
        // Keep a row only if its file is confirmed upserted AND the row belongs
        // to that file's latest staged block (a re-upsert supersedes earlier rows).
        if (p !== null && upserted.has(p) && idx >= (start ?? 0)) cb(null, line);
        else cb(); // unconfirmed upsert (flush failed) or superseded block: never published
      },
    })
  );
}

/** Validate a `## files` row; returns the record or null when malformed. */
export function parseFileRow(line: string): FileRecord | null {
  const cells = splitRow(line);
  if (cells.length !== FILES_FIELDS.length) return null;
  const vaultPath = parseScalar(cells[0], true);
  const mtime = parseScalar(cells[1], true);
  const chunkCount = parseScalar(cells[2], true);
  if (typeof vaultPath !== 'string' || vaultPath === '') return null;
  if (typeof mtime !== 'number' || !Number.isFinite(mtime)) return null;
  if (typeof chunkCount !== 'number' || !Number.isInteger(chunkCount) || chunkCount < 0) return null;
  return { vaultPath, mtime, chunkCount };
}

/**
 * Validate a `## chunks` row: full column width, well-formed scalars, and a
 * vector payload that decodes to exactly the document's embedding dimension
 * (compressed vectors are inflated one row at a time, so a corrupt cell is
 * caught before its file's mtime is trusted).
 */
export function validateChunkRow(line: string, embeddingDimension: number): boolean {
  const cells = splitRow(line);
  if (cells.length !== CHUNKS_FIELDS.length) return false;
  const id = parseScalar(cells[0], true);
  const vaultPath = parseScalar(cells[1], true);
  const page = parseScalar(cells[2], true);
  const chunkIndex = parseScalar(cells[3], true);
  const sourceType = parseScalar(cells[4], true);
  const text = parseScalar(cells[5], true);
  if (typeof id !== 'string' || id === '') return false;
  if (typeof vaultPath !== 'string' || vaultPath === '') return false;
  if (typeof page !== 'number' || typeof chunkIndex !== 'number') return false;
  if (sourceType !== 'pdf' && sourceType !== 'note') return false;
  if (typeof text !== 'string') return false;
  if (cells[6] === '') return embeddingDimension === 0;
  let decoded: Float64Array;
  try {
    decoded = decodeVector(cells[6]);
  } catch {
    return false; // undecodable compressed payload
  }
  return decoded.length === embeddingDimension;
}

export interface StreamScan {
  meta: IndexMeta;
  fileRecords: FileRecord[];
  chunkRowCount: number;
  /**
   * false when the document is not fully trusted: missing/mismatched summary
   * trailer, unexpected section layout, or any malformed row. The caller
   * must then rebuild from scratch instead of preserving the file table.
   */
  complete: boolean;
}

function expectedSectionFields(headerLine: string, fields: readonly string[]): boolean {
  const braceStart = headerLine.indexOf('{');
  const braceEnd = headerLine.indexOf('}', braceStart);
  if (braceStart < 0 || braceEnd < 0) return false;
  return headerLine.slice(braceStart + 1, braceEnd).split(',').join(',') === fields.join(',');
}

/**
 * Stream-scan a committed index document: metadata + file table into memory
 * (lightweight), every chunk row validated in place (no row text retained,
 * no vectors materialized beyond one inflating payload at a time).
 * Throws only on I/O failure (e.g. the file vanished); a malformed document
 * resolves with `complete: false`.
 */
export async function scanIndexDocumentStream(file: string): Promise<StreamScan> {
  const metaMap = new Map<string, unknown>();
  const fileRecords: FileRecord[] = [];
  let section: 'meta' | 'files' | 'chunks' | 'other' = 'meta';
  let chunkRowCount = 0;
  let complete = true;
  let summaryCounts: [number, number] | null = null;
  let sawSummary = false;
  /** Header dimension once the meta scalars are complete (null before, -1 when unreadable). */
  let dimension: number | null = null;

  for await (const raw of openLines(file)) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;

    if (line.startsWith('##! ')) {
      if (sawSummary) {
        complete = false;
        continue;
      }
      sawSummary = true;
      const m = line.match(/^##! summary counts=(\d+),(\d+)$/);
      if (!m) {
        complete = false;
      } else {
        summaryCounts = [Number(m[1]), Number(m[2])];
      }
      continue;
    }

    if (line.startsWith('## ')) {
      const name = line.slice(3, line.indexOf(' ['));
      if (dimension === null) {
        // Header scalars precede every section in our documents: by the first
        // section line the dimension is knowable for row validation.
        try {
          dimension = readMeta(metaMap).embeddingDimension;
        } catch {
          dimension = -1; // torn header: the final readMeta fails as well
        }
      }
      if (name === 'files') {
        if (section === 'chunks') complete = false; // out of order
        if (!expectedSectionFields(line, FILES_FIELDS)) complete = false;
        section = 'files';
      } else if (name === 'chunks') {
        if (section === 'chunks') complete = false; // duplicate section
        if (!expectedSectionFields(line, CHUNKS_FIELDS)) complete = false;
        section = 'chunks';
      } else {
        complete = false; // foreign section: the base is not ours to trust
        section = 'other';
      }
      continue;
    }

    if (section === 'meta') {
      const eq = line.indexOf('=');
      if (eq <= 0 || metaMap.has(line.slice(0, eq))) {
        complete = false;
        continue;
      }
      metaMap.set(line.slice(0, eq), parseScalar(line.slice(eq + 1), false));
      continue;
    }

    if (section === 'files') {
      const record = parseFileRow(line);
      if (record === null) complete = false;
      else fileRecords.push(record);
      continue;
    }

    if (section === 'chunks') {
      chunkRowCount++;
      if (dimension === -1 || !validateChunkRow(line, dimension ?? 0)) {
        complete = false; // malformed row or corrupt vector payload: base is not trusted
      }
    }
  }

  let meta: IndexMeta;
  try {
    meta = readMeta(metaMap);
  } catch {
    return { meta: { formatVersion: -1, schemaVersion: 0, embeddingModel: '', embeddingDimension: 0, vectorCodec: '', createdAt: '', updatedAt: '' }, fileRecords: [], chunkRowCount: 0, complete: false };
  }
  if (meta.formatVersion !== INDEX_FORMAT_VERSION) {
    return { meta, fileRecords, chunkRowCount, complete: false };
  }

  if (!sawSummary || summaryCounts === null ||
      summaryCounts[0] !== fileRecords.length || summaryCounts[1] !== chunkRowCount) {
    return { meta, fileRecords, chunkRowCount, complete: false };
  }
  return { meta, fileRecords, chunkRowCount, complete };
}

/**
 * Read only the document's header scalar lines (bounded: stops at the first
 * `##` section line). Used for cheap metadata peeks that must not load a
 * large document. Returns null when the file cannot be read.
 */
export async function readHeadScalars(file: string): Promise<Map<string, unknown> | null> {
  const metaMap = new Map<string, unknown>();
  try {
    for await (const raw of openLines(file)) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('##') || line === '') break;
      const eq = line.indexOf('=');
      if (eq <= 0) break; // malformed header: treat as unpeekable
      metaMap.set(line.slice(0, eq), parseScalar(line.slice(eq + 1), false));
    }
  } catch {
    return null;
  }
  return metaMap;
}

/**
 * Read only the document's final summary trailer line by seeking to the file
 * tail (bounded read, never loads the document). Returns the declared
 * (fileCount, chunkCount) or null when no complete trailer is present.
 */
export async function readTailTrailer(
  file: string
): Promise<{ fileCount: number; chunkCount: number } | null> {
  let handle: FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size < 4) return null;
    const bytes = Math.min(size, 256); // the trailer line is well under 256 B
    const buf = Buffer.allocUnsafe(bytes);
    await handle.read(buf, 0, bytes, size - bytes);
    const lines = buf.toString('utf8').split('\n').filter(l => l !== '');
    const m = (lines[lines.length - 1] ?? '').match(
      /^##! summary counts=(\d+),(\d+)$/
    );
    return m
      ? { fileCount: Number(m[1]), chunkCount: Number(m[2]) }
      : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
