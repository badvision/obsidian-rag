import * as fs from 'fs';
import { App, DataAdapter } from 'obsidian';
import { GenericStreamEncoder } from '@blackwell-systems/gcf';
import { Chunk } from './types';
import { ProviderError } from '../providers/types';
import {
  INDEX_FORMAT_VERSION,
  CHUNKS_FIELDS,
  IndexMeta,
  FileRecord,
  ChunkRecord,
  DecodedIndex,
  encodeIndexDocument,
  encodeFileRow,
  documentHeader,
  FILES_SECTION_HEADER,
  CHUNKS_SECTION_HEADER,
  readMeta,
  decodeIndexDocument,
  emptyMeta,
} from './gcfIndex';
import { encodeVector } from './vectorCodec';
import {
  appendRows,
  committedChunkRows,
  readHeadScalars,
  readTailTrailer,
  resolvePhysicalPath,
  scanIndexDocumentStream,
  stagedChunkRows,
  writeText,
} from './streamGcf';
import type { StreamScan } from './streamGcf';
function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0, normA = 0, normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}


interface IndexingSession {
  /** Model the run is indexing with. */
  model: string;
  /** True when the committed GCF document on disk is readable (a corrupt one must be rebuilt, not merged). */
  baseReadable: boolean;
  /** True when the committed index was for a different model: all old rows are stale and must be dropped. */
  replaceAll: boolean;
  /** Files whose chunk rows are fully staged on disk. */
  upserted: Set<string>;
  /** Files removed during this session (subtracted from upserted). */
  removed: Set<string>;
  /** Staging-document row index where each file's LATEST upsert block starts (latest-wins on re-upsert). */
  rowStart: Map<string, number>;
  /** Total staging rows confirmed on disk so far. */
  stagedRowCount: number;
  /** True once finishIndexing has started: no further staging is accepted. */
  closing: boolean;
  /** Official streaming generic encoder for the staging document. */
  encoder: GenericStreamEncoder;
  /** Serial append chain to the staging file; stays rejected once a write fails. */
  appendChain: Promise<void>;
}

/**
 * Vector index persisted as a GCF generic-profile document (`index/index.gcf`).
 *
 * Memory model:
 * - The query state (chunks + vectors) is loaded on demand by `ensureLoaded`
 *   and dropped by `unload` / `prepareForIndexing`; the lightweight file table
 *   (mtimes, counts) stays resident so `getStats`/`getFileMtime` work unloaded.
 * - Indexing runs disk-backed: `prepareForIndexing` opens a staging file that
 *   receives one file's rows at a time (bounded memory), and `finishIndexing`
 *   streams the committed document — copying unaffected row bytes verbatim —
 *   into an atomic tmp+rename publication. A failed write never touches the
 *   committed index.
 */
/** rename() error codes that mean "destination exists and cannot be replaced" (Windows). */
const REPLACE_ERR_CODES: Record<string, true> = { EPERM: true, EACCES: true, EBUSY: true };

export class VectorStore {

  private meta: IndexMeta;
  private metaKnown = false;
  private files = new Map<string, FileRecord>();
  private chunks: ChunkRecord[] | null = null;
  private loadedModel: string | null = null;
  private loadedEpoch = -1;
  private epoch = 0;
  private session: IndexingSession | null = null;
  private loadPromise: Promise<void> | null = null;

  private indexDir: string;
  private indexPath: string;
  private tmpPath: string;
  private asidePath: string;
  private stagingPath: string;
  constructor(private pluginDir: string, private app: App) {
    this.indexDir = pluginDir + '/index';
    this.indexPath = this.indexDir + '/index.gcf';
    this.tmpPath = this.indexPath + '.tmp';
    this.asidePath = this.indexPath + '.swap';
    this.stagingPath = this.indexDir + '/.staging.gcf';
    this.meta = emptyMeta('');
  }

  // ── Query path (lazy load) ────────────────────────────────────────────────

  /**
   * Load the committed index (metadata, file table, chunks, vectors) on demand.
   * No-op when a current cache for `embeddingModel` exists. Throws
   * ProviderError DIMENSION_MISMATCH when the committed index was built with a
   * different model. Works while an indexing session is open (loads the last
   * published snapshot, which is never taken offline during indexing).
   */
  async ensureLoaded(embeddingModel: string): Promise<void> {
    if (this.chunks !== null && this.loadedEpoch === this.epoch && this.loadedModel === embeddingModel) return;
    const pending = this.loadPromise;
    if (pending) {
      await pending;
      if (this.chunks !== null && this.loadedEpoch === this.epoch && this.loadedModel === embeddingModel) return;
    }
    const p = this.doLoad(embeddingModel).finally(() => { this.loadPromise = null; });
    this.loadPromise = p;
    await p;
  }

  private async doLoad(model: string, attempt = 0): Promise<void> {
    const adapter = this.app.vault.adapter;
    // Snapshot the publication epoch and session state before the slow disk
    // I/O. A concurrent publication/unload moves the epoch while we read; a
    // snapshot read before it must not be stamped with the new epoch (that
    // would pin a stale index forever), so the load is retried.
    const startEpoch = this.epoch;
    const hadSession = this.session !== null;

    let committed: DecodedIndex | null = null;
    let unreadable = false;

    if (await adapter.exists(this.indexPath)) {
      try {
        committed = decodeIndexDocument(await adapter.read(this.indexPath));
      } catch {
        unreadable = true; // foreign/corrupt document: keep on disk, index behaves as empty
      }
    }

    if (this.epoch !== startEpoch || (this.session !== null) !== hadSession) {
      // A publication (or unload) landed while we were reading: this snapshot
      // is stale by definition. Retry on the new state; after a few attempts
      // (a genuinely slow disk) install what we read.
      if (attempt < 3) return this.doLoad(model, attempt + 1);
    }

    if (unreadable) {
      this.metaKnown = true;
      if (!this.session) {
        this.meta = emptyMeta(model);
        this.files = new Map();
      }
      this.chunks = [];
      this.loadedModel = model;
      this.loadedEpoch = this.epoch;
      return;
    }

    if (committed === null) {
      // No index on disk yet: adopt the requested model.
      this.metaKnown = true;
      if (!this.session) {
        this.meta = emptyMeta(model);
        this.files = new Map();
      }
      this.chunks = [];
      this.loadedModel = model;
      this.loadedEpoch = this.epoch;
      return;
    }

    const c = committed!;
    const committedModel = c.meta.embeddingModel;
    if (committedModel !== '' && committedModel !== model) {
      throw new ProviderError(
        `Embedding model changed from '${committedModel}' to '${model}'. Re-index required.`,
        'DIMENSION_MISMATCH'
      );
    }
    this.metaKnown = true;
    if (!this.session) {
      this.meta = c.meta;
      // Index saved before embeddingModel was stamped — adopt current model.
      this.meta.embeddingModel = committedModel === '' ? model : committedModel;
      this.files = new Map(c.fileRecords.map(f => [f.vaultPath, f]));
    }
    this.chunks = c.chunkRecords;
    this.loadedModel = committedModel === '' ? model : committedModel;
    this.loadedEpoch = this.epoch;
  }

  /** Drop query chunk/vector memory. Lightweight stats/mtimes are retained. */
  unload(): void {
    this.chunks = null;
    this.loadedModel = null;
    this.loadedEpoch = -1;
    // Move the epoch so any in-flight query load re-validates against the
    // new state instead of stamping the current epoch with a stale read.
    this.epoch++;
  }

  /** True when a current (post-publication) query cache is resident. */
  isLoaded(): boolean {
    return this.chunks !== null && this.loadedEpoch === this.epoch && this.loadedModel !== null;
  }

  query(queryEmbedding: number[], topK: number): Array<{ chunk: Chunk; score: number }> {
    if (!this.chunks || this.chunks.length === 0) return [];
    const q = Float64Array.from(queryEmbedding);
    const scored = this.chunks.map(chunk => ({
      chunk,
      score: cosineSimilarity(q, chunk.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(r => ({
      score: r.score,
      chunk: {
        id: r.chunk.id,
        text: r.chunk.text,
        embedding: Array.from(r.chunk.embedding),
        sourceType: r.chunk.sourceType,
        vaultPath: r.chunk.vaultPath,
        page: r.chunk.page,
        chunkIndex: r.chunk.chunkIndex,
      },
    }));
  }

  // ── Indexing session (disk-backed) ────────────────────────────────────────

  /**
   * Open a disk-backed indexing session for `embeddingModel`: unloads the query
   * vector cache, loads only metadata + file table from the committed GCF,
   * and opens the staging file. Vector data stays on disk for the whole run.
   * A model change resets
   * the file table so every file is re-embedded (the old-model vectors are
   * dropped at publication).
   */
  async prepareForIndexing(embeddingModel: string): Promise<void> {
    if (this.session) return;
    // Row streaming reads/writes the physical file; adapters without
    // physical paths (non-desktop) cannot back the GCF index.
    if (this.physicalBase() === null) {
      throw new Error('GCF index requires a desktop vault adapter (physical file paths)');
    }
    const adapter = this.app.vault.adapter;
    await adapter.mkdir(this.indexDir);
    // Repair a crash inside the cross-platform swap window (committed index
    // possibly missing, documents split across tmp/aside), then discard
    // plain crashed-run leftovers, which never touch the committed index.
    await this.recoverCrashedSwap();
    await this.removeIfExists(this.tmpPath);
    await this.removeIfExists(this.stagingPath);

    let committedMeta: IndexMeta | null = null;
    let committedFiles: FileRecord[] = [];
    let baseReadable = true;

    const hasGcf = await adapter.exists(this.indexPath);
    if (hasGcf) {
      // Stream-scan the committed document row by row from the physical file
      // (adapter base path): header + file table are retained (lightweight
      // metadata), and every chunk row is validated in place — columns, ids,
      // and its compressed vector payload — before its mtime may be trusted.
      // No row text or whole document is materialized in memory.
      const physical = resolvePhysicalPath(this.physicalBase()!, this.indexPath);
      let scanned: StreamScan | null = null;
      try {
        scanned = await scanIndexDocumentStream(physical);
      } catch {
        // The file vanished or is unreadable: rebuild from scratch.
      }
      if (scanned !== null && scanned.complete && scanned.meta.formatVersion === INDEX_FORMAT_VERSION) {
        committedMeta = scanned.meta;
        committedFiles = scanned.fileRecords;
      } else {
        // Foreign, malformed, or missing-summary document: do NOT trust its
        // file table — a corrupt base must be rebuilt, not merged, and its
        // rows must not be copied.
        baseReadable = false;
      }
    }

    const baseMeta = committedMeta ?? emptyMeta(embeddingModel);
    const committedModel = committedMeta?.embeddingModel ?? '';
    // A caller without a model ('') is doing a file-table-only operation
    // (e.g. a delete); it must not be treated as a model switch.
    const model = embeddingModel !== '' ? embeddingModel : committedModel;
    const replaceAll = model !== '' && committedModel !== '' && committedModel !== model;

    this.metaKnown = true;
    this.meta = { ...baseMeta, embeddingModel: model };
    this.files = new Map((replaceAll ? [] : committedFiles).map(f => [f.vaultPath, f]));
    this.chunks = null; // no query DB resident while indexing
    this.loadedModel = null;
    this.loadedEpoch = -1;

    const session: IndexingSession = {
      model,
      replaceAll,
      baseReadable,
      upserted: new Set(),
      removed: new Set(),
      rowStart: new Map(),
      stagedRowCount: 0,
      closing: false,
      encoder: undefined as unknown as GenericStreamEncoder, // assigned below, before first write
      appendChain: Promise.resolve(),
    };
    // The encoder emits its header lines at construction/beginArray, so the
    // session must be reachable from stageAppend before they run.
    this.session = session;
    session.encoder = new GenericStreamEncoder({ write: (s: string) => this.stageAppend(s) });
    // Official streaming generic profile: deferred-count section, rows appended
    // as files complete.
    session.encoder.beginArray('upserts', [...CHUNKS_FIELDS]);
    await this.flushStaging(); // header + section header on disk before first upsert
  }

  /** Stage one file's chunk rows; the file counts as upserted only after the append is confirmed. */
  async upsertFile(vaultPath: string, mtime: number, chunks: Chunk[]): Promise<void> {
    const session = this.session;
    if (!session || session.closing) {
      throw new Error('upsertFile requires an active indexing session (call prepareForIndexing first; none is open while a publication is in flight)');
    }
    // Latest-wins: a re-upsert of a path supersedes its earlier staged block.
    session.rowStart.set(vaultPath, session.stagedRowCount);
    for (const c of chunks) {
      session.encoder.writeRow([c.id, c.vaultPath, c.page, c.chunkIndex, c.sourceType, c.text, encodeVector(c.embedding)]);
    }
    await this.flushStaging(); // throws on disk failure → file is NOT staged
    session.upserted.add(vaultPath);
    session.removed.delete(vaultPath);
    session.stagedRowCount += chunks.length;
    if (this.meta.embeddingDimension === 0 && chunks.length > 0 && chunks[0].embedding.length > 0) {
      this.meta.embeddingDimension = chunks[0].embedding.length;
    }
    this.files.set(vaultPath, { vaultPath, mtime, chunkCount: chunks.length });
  }
  /**
   * Remove a file's entries. Works with the query DB unloaded (disk-backed).
   * No-op when the path has no entries. Self-contained when no session is
   * open (opens and publishes one); applies to the open session otherwise.
   */
  async removeFile(vaultPath: string): Promise<void> {
    const hadSession = this.session !== null;
    if (!hadSession) {
      await this.prepareForIndexing(this.meta.embeddingModel || '');
    }
    const session = this.session!;
    if (this.files.has(vaultPath) || session.upserted.has(vaultPath)) {
      session.removed.add(vaultPath);
      session.upserted.delete(vaultPath);
      this.files.delete(vaultPath);
    }
    if (!hadSession) await this.finishIndexing();
  }

  private stageAppend(s: string): void {
    const session = this.session;
    if (!session) return;
    session.appendChain = session.appendChain.then(() => this.app.vault.adapter.append(this.stagingPath, s));
  }

  private async flushStaging(): Promise<void> {
    const session = this.session;
    if (!session) return;
    await session.appendChain; // a failure stays recorded: later flushes keep rejecting
  }


  /**
   * Install the tmp document as the committed index. A direct `fs.rename`
   * replaces an existing file in one step on POSIX, which is the atomic
   * publication this design needs. Obsidian's `adapter.rename` refuses to
   * overwrite on every platform ("Destination file already exists!"), and
   * on Windows `fs.rename` cannot replace an existing destination either —
   * in that case fall back to a two-step swap through the aside file:
   * commit aside -> new in place -> aside removed. If the swap itself fails,
   * the previous committed document is restored, so a failed publish never
   * leaves the index missing. A crash inside the swap window is repaired by
   * `recoverCrashedSwap` before the index is trusted again.
   */
  private async publishSwap(): Promise<void> {
    const physical = this.physicalBase()!;
    const tmp = resolvePhysicalPath(physical, this.tmpPath);
    const index = resolvePhysicalPath(physical, this.indexPath);
    try {
      await fs.promises.rename(tmp, index);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !REPLACE_ERR_CODES[code]) throw err;
    }
    const aside = resolvePhysicalPath(physical, this.asidePath);
    try {
      await fs.promises.rename(index, aside);
      await fs.promises.rename(tmp, index);
      await fs.promises.rm(aside, { force: true });
    } catch (swapErr) {
      // Failed mid-swap: put the previous committed document back.
      try {
        if (fs.existsSync(aside)) await fs.promises.rename(aside, index);
      } catch {
        // Left for recoverCrashedSwap; the error below still propagates.
      }
      throw swapErr;
    }
  }

  /**
   * Repair the state a crash inside the Windows two-step swap can leave:
   * committed missing + fully-written new document in tmp -> commit the new
   * one; committed missing + previous document set aside -> restore it;
   * committed present -> the aside is a stale duplicate, discard it.
   */
  private async recoverCrashedSwap(): Promise<void> {
    const physical = this.physicalBase()!;
    const index = resolvePhysicalPath(physical, this.indexPath);
    const tmp = resolvePhysicalPath(physical, this.tmpPath);
    const aside = resolvePhysicalPath(physical, this.asidePath);
    if (!fs.existsSync(aside)) return;
    let hasIndex = false;
    let hasTmp = false;
    try {
      hasIndex = fs.existsSync(index);
      hasTmp = fs.existsSync(tmp);
    } catch {
      return;
    }
    if (hasIndex) {
      await fs.promises.rm(aside, { force: true });
    } else if (hasTmp) {
      await fs.promises.rename(tmp, index);
      await fs.promises.rm(aside, { force: true });
    } else {
      await fs.promises.rename(aside, index);
    }
  }

  /**
   * Publish the committed index + staged updates atomically (tmp write +
   * rename) and close the session. Unaffected chunk rows are STREAMED
   * verbatim from the committed document (line by line, pipe backpressure,
   * no vector decoding, no whole-document materialization); staged rows are
   * filtered to confirmed upserts. The session stays installed through the
   * async publication so a concurrent query cannot overwrite the staged file
   * table, and upserts are rejected while it runs. On any failure the
   * committed index, if it existed, is unchanged (staging is discarded; a
   * partial re-index simply re-runs on demand).
   */
  async finishIndexing(): Promise<void> {
    const session = this.session;
    if (!session) return;
    // Immutable publication snapshot, captured while the session still owns
    // the staged state.
    const publishedMeta = { ...this.meta, updatedAt: new Date().toISOString() };
    const fileRecords = [...this.files.values()].sort((a, b) =>
      a.vaultPath < b.vaultPath ? -1 : a.vaultPath > b.vaultPath ? 1 : 0
    );
    const affected = new Set<string>([...session.upserted, ...session.removed]);
    const upserted = session.upserted;
    session.closing = true; // no staging accepted after this point

    // A session only exists after prepareForIndexing, which requires a
    // physical base; the streaming publish depends on it.
    const adapter = this.app.vault.adapter;
    const physical = this.physicalBase()!;

    try {
      // Finalize the staging document (official summary trailer) so it is a
      // complete decodable GCF payload before it is consumed or discarded.
      session.encoder.close();
      await this.flushStaging();

      const hasCommitted = await adapter.exists(this.indexPath);
      const noOp = !session.replaceAll && session.upserted.size === 0 &&
        session.removed.size === 0 && hasCommitted;
      if (!noOp) {
        // Stream into the tmp document: header + file table (lightweight),
        // then the unaffected committed rows and the staged rows. Memory is
        // O(one line) regardless of index size.
        const tmpFile = resolvePhysicalPath(physical, this.tmpPath);
        const out = fs.createWriteStream(tmpFile, { encoding: 'utf8' });
        // A stream error (e.g. EISDIR if the tmp path is a directory) can surface
        // before the first awaited write returns, so a persistent listener + race
        // guarantees the failure rejects the publication instead of becoming an
        // uncaught 'error' event.
        const outFailed = new Promise<Error>(res => { out.once('error', res); });
        // Source streams are tracked so the failure path can release them.
        const sources: Array<{ destroy: () => void }> = [];
        const write = async () => {
        try {
          await writeText(out, documentHeader(publishedMeta));
          await writeText(out, `${FILES_SECTION_HEADER}\n`);
          for (const f of fileRecords) {
            await writeText(out, encodeFileRow(f) + '\n');
          }
          await writeText(out, `${CHUNKS_SECTION_HEADER}\n`);

          const retained = { count: 0 };
          if (hasCommitted && session.baseReadable && !session.replaceAll) {
            const committedFile = resolvePhysicalPath(physical, this.indexPath);
            const committedRows = committedChunkRows(committedFile, affected);
            sources.push(committedRows);
            await appendRows(out, committedRows, retained);
          }
          const staged = { count: 0 };
          if (await adapter.exists(this.stagingPath)) {
            const stagingFile = resolvePhysicalPath(physical, this.stagingPath);
            const stagedRows = stagedChunkRows(stagingFile, upserted, session.rowStart);
            sources.push(stagedRows);
            await appendRows(out, stagedRows, staged);
          }
          await writeText(out, `##! summary counts=${fileRecords.length},${retained.count + staged.count}\n`);

          await new Promise<void>((resolve, reject) => {
            out.once('error', reject);
            out.end(() => resolve());
          });
        } catch (err) {
          out.destroy();
          throw err;
        }
        };
        try {
          await Promise.race([write(), outFailed.then(e => { throw e; })]);
        } catch (err) {
          for (const s of sources) s.destroy();
          out.destroy();
          throw err;
        }

        await this.publishSwap(); // atomic publication
        this.epoch++;

        // A query cache loaded before this publication is stale: drop it. A
        // load that completes after the rename installs the new document (its
        // epoch guard accepts it); one that read the old document is retried.
        if (this.loadedEpoch !== this.epoch) {
          this.chunks = null;
          this.loadedModel = null;
          this.loadedEpoch = -1;
        }
      }
    } finally {
      // Close the session only after publication (or its failure) is fully
      // settled, so no concurrent load can clobber staged state mid-publish.
      this.session = null;
      await this.removeIfExists(this.stagingPath);
      await this.removeIfExists(this.tmpPath);
    }
  }

  /**
   * Persist current in-flight work. Indexing runs publish exactly once, in
   * `finishIndexing`; this is a no-op when no session is open (the committed
   * index is already current).
   */
  async save(): Promise<void> {
    if (this.session) await this.finishIndexing();
  }

  /**
   * Delete the entire index: discards any open session's staged work and
   * atomically publishes an empty index document.
   */
  async clear(embeddingModel: string): Promise<void> {
    if (this.session) {
      this.session = null;
      await this.removeIfExists(this.stagingPath);
    }
    const adapter = this.app.vault.adapter;
    await adapter.mkdir(this.indexDir);
    const meta = emptyMeta(embeddingModel);
    await adapter.write(this.tmpPath, encodeIndexDocument(meta, [], []));
    await this.publishSwap();
    this.epoch++;
    this.meta = meta;
    this.metaKnown = true;
    this.files = new Map();
    this.chunks = [];
    this.loadedModel = embeddingModel;
    this.loadedEpoch = this.epoch;
  }

  // ── Lightweight state (valid while the query DB is unloaded) ──────────────

  async exists(): Promise<boolean> {
    return this.app.vault.adapter.exists(this.indexPath);
  }

  /**
   * Returns null when there is no readable GCF index.
   */
  async peekModel(): Promise<string | null> {
    if (!this.metaKnown) {
      if (await this.app.vault.adapter.exists(this.indexPath)) {
        const base = this.physicalBase();
        if (base === null) return null; // non-desktop adapter: no physical peek
        // Read only the header scalar lines (the stream stops at the first
        // section line) — a lightweight peek must never load a large document.
        const head = await readHeadScalars(resolvePhysicalPath(base, this.indexPath));
        if (head) {
          try {
            const meta = readMeta(head);
            if (meta.formatVersion === INDEX_FORMAT_VERSION) {
              this.meta = meta;
              this.metaKnown = true;
            }
          } catch {
            // Foreign or corrupt header: meta stays unknown (no index).
          }
        }
      }
    }
    return this.metaKnown && this.meta.embeddingModel !== '' ? this.meta.embeddingModel : null;
  }

  /**
   * Lightweight stats for display (settings status) without loading the
   * query DB: uses the in-memory file table when hydrated, otherwise reads
   * the document's header scalars + summary trailer (bounded reads).
   * Returns null when there is no committed GCF index on disk.
   */
  async peekStats(): Promise<{
    fileCount: number;
    chunkCount: number;
    embeddingModel: string;
    updatedAt: string;
  } | null> {
    if (!this.metaKnown) await this.peekModel(); // hydrate meta from the header
    if (!this.metaKnown) return null;
    const stats = this.getStats();
    if (stats.fileCount > 0 || this.session !== null) return stats;
    // meta is known but the file table is not hydrated (fresh start): get
    // the declared counts from the trailer without loading the document.
    // A genuinely empty index (cleared) reports 0,0 from the trailer too.
    const base = this.physicalBase();
    if (base === null) return stats;
    const trailer = await readTailTrailer(resolvePhysicalPath(base, this.indexPath));
    if (trailer === null) return stats; // unreadable: report the in-memory view
    return { ...stats, fileCount: trailer.fileCount, chunkCount: trailer.chunkCount };
  }

  getFileMtime(vaultPath: string): number | null {
    return this.files.get(vaultPath)?.mtime ?? null;
  }

  getIndexedPaths(): string[] {
    return [...this.files.keys()];
  }

  getStats(): { fileCount: number; chunkCount: number; embeddingModel: string; updatedAt: string } {
    let chunkCount = 0;
    if (this.chunks) {
      chunkCount = this.chunks.length;
    } else {
      for (const f of this.files.values()) chunkCount += f.chunkCount;
    }
    return {
      fileCount: this.files.size,
      chunkCount,
      embeddingModel: this.meta.embeddingModel,
      updatedAt: this.meta.updatedAt,
    };
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.app.vault.adapter.exists(path)) {
      try {
        await this.app.vault.adapter.remove(path);
      } catch {
        // Best effort: a leftover staging/tmp file is reaped on the next prepare.
      }
    }
  }

  /**
   * Physical base directory of the vault (desktop `FileSystemAdapter`
   * exposes `getBasePath`), or null on adapters without physical paths.
   * Row streaming requires a physical file; a null base means this adapter
   * cannot back the streaming index.
   */
  private physicalBase(): string | null {
    const adapter = this.app.vault.adapter as DataAdapter & {
      getBasePath?: () => string;
    };
    return typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : null;
  }
}
