import type { TFile, TAbstractFile } from 'obsidian';
import { ProviderError } from './providers/types';
import type { RagPluginSettings } from './settings';
import type { IndexManager } from './indexer/IndexManager';
import type { IndexAllResult } from './indexer/types';
import type { EmbeddingService } from './rag/EmbeddingService';
import type { VectorStore } from './store/VectorStore';

/**
 * Default quiet window: automatic indexing work only starts this long after
 * the last relevant activity (vault change OR chat activity).
 */
export const DEFAULT_QUIET_MS = 3 * 60 * 1000;

/**
 * Chat activity lease. `acquireChatLease()` resolves only once it is safe to
 * read the index for queries — i.e. after any in-flight index run has stopped
 * at a file boundary and published. `end()` must be called exactly once when
 * the whole chat turn (send/stream/cancel/error) finishes, even on failure.
 */
export interface ChatLease {
  end(): void;
}

/** Outcome of one completed index run, kept for the settings status summary. */
export interface IndexRunSummary {
  kind: 'auto' | 'manual' | 'file';
  indexed: number;
  skipped: number;
  failed: number;
  /** Vault path, for kind 'file'. */
  path?: string;
  /** Set when the run ended in an error. */
  error?: string;
  finishedAt: number;
}

/** Snapshot of the scheduler's queue state for display. */
export interface IndexSchedulerStatus {
  indexing: boolean;
  queued: {
    changes: number;
    removals: number;
    fullPass: boolean;
    clear: boolean;
  };
  lastRun: IndexRunSummary | null;
}

interface ProgressNotice {
  setMessage(message: string): void;
  hide(): void;
}

export interface IndexSchedulerDeps {
  indexManager: IndexManager;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
  getSettings: () => RagPluginSettings;
  /** Resolve a vault path to a file at run time (null if deleted in the meantime). */
  resolveFile: (path: string) => TFile | null;
  notify: (message: string, timeoutMs: number) => void;
  /** Persistent progress notice for an index pass (updated per file, hidden on end). */
  createProgressNotice: () => ProgressNotice | null;
  quietMs?: number;
}

/**
 * Serializes every DB-writing operation (index passes, file removals, clears)
 * on one queue, gates automatic work behind a trailing-edge quiet window that
 * resets on each vault change and on chat activity, and lets an active chat
 * preempt an in-flight index at a file boundary.
 */
export class IndexScheduler {
  private readonly quietMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private activeChats = 0;
  private lastActivity = 0;
  private lastChatEnd = 0;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  /** Vault paths changed since the last pass (coalesced; deletions remove them). */
  private pendingChanged = new Set<string>();
  /** Vault paths deleted/renamed away, processed after vault+chat quiet (never mid-chat). */
  private pendingRemovals = new Set<string>();
  /** A full index pass was requested (manual click, startup, or preemption resume). */
  private pendingPass = false;
  /** A full pass is enqueued but has not started yet (display-only; pendingPass covers quiet-gated waits). */
  private passQueued = false;
  /** An explicit index clear (settings) is waiting for the quiet window. */
  private pendingClear = false;
  /** Waiters for deferred clearIndex() calls — resolved when the clear runs. */
  private clearWaiters: Array<() => void> = [];
  private runController: AbortController | null = null;
  private indexing = false;
  private runAbortedForChat = false;
  private runCancelled = false;
  /** Runs not yet started stop at their start while a chat is active. */
  private stopQueuedRuns = false;
  private disposed = false;
  /** The most recent COMPLETED run (aborted runs are not recorded). */
  private lastRun: IndexRunSummary | null = null;

  constructor(private readonly deps: IndexSchedulerDeps) {
    this.quietMs = deps.quietMs ?? DEFAULT_QUIET_MS;
  }

  get isIndexing(): boolean {
    return this.indexing;
  }

  /** Queue snapshot for display (settings status). */
  getStatus(): IndexSchedulerStatus {
    return {
      indexing: this.indexing,
      queued: {
        changes: this.pendingChanged.size,
        removals: this.pendingRemovals.size,
        fullPass: this.pendingPass || this.passQueued,
        clear: this.pendingClear,
      },
      lastRun: this.lastRun,
    };
  }

  /**
   * Chat activity lease. Preempts any in-flight index pass at a file boundary
   * and waits for all DB-writing work already in flight or queued to settle,
   * so the index is stable and queryable when this resolves. Beginning and
   * ending a chat both count as "activity" for the quiet window.
   */
  async acquireChatLease(): Promise<ChatLease> {
    this.activeChats++;
    this.noteActivity();

    // A queued-but-not-started run stops at its own start while a chat is
    // active (see runPass / runFile); an in-flight run stops at its next
    // file boundary.
    this.stopQueuedRuns = true;
    if (this.indexing) {
      this.runAbortedForChat = true;
      this.runController?.abort();
    }

    // `this.queue` is the chained tail of every enqueued DB write, so awaiting
    // it guarantees no in-flight or queued write overlaps the caller's load.
    await this.queue;

    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        this.activeChats = Math.max(0, this.activeChats - 1);
        this.lastChatEnd = Date.now();
        if (this.runAbortedForChat) {
          this.runAbortedForChat = false;
          // Resume the interrupted pass as a normal (quiet-gated) full pass.
          this.pendingPass = true;
        }
        this.noteActivity();
      },
    };
  }

  // ---- vault events -------------------------------------------------------

  onVaultModify(file: TFile): void {
    if (this.disposed) return;
    if (file.extension !== 'md' && file.extension !== 'pdf') return;
    // A re-created path cancels a stale pending removal for the same path.
    this.pendingRemovals.delete(file.path);
    this.pendingChanged.add(file.path);
    this.noteActivity();
  }

  onVaultDelete(file: TAbstractFile): void {
    if (this.disposed) return;
    this.pendingChanged.delete(file.path);
    this.pendingRemovals.add(file.path);
    this.noteActivity();
  }

  onVaultRename(file: TAbstractFile, oldPath: string): void {
    if (this.disposed) return;
    const f = file as TFile;
    this.pendingChanged.delete(oldPath);
    this.pendingRemovals.add(oldPath);
    if (f.extension === 'md' || f.extension === 'pdf') this.pendingChanged.add(f.path);
    this.noteActivity();
  }

  // ---- manual triggers ----------------------------------------------------

  /** Full index pass — command palette "Index all files" / settings Re-index. */
  requestManualIndex(): void {
    if (this.disposed) return;
    if (this.chatGated()) {
      this.deps.notify(
        'RAG: Chat is active or recent — indexing will start automatically once it settles.',
        5000
      );
      this.pendingPass = true;
      return;
    }
    if (this.indexing) {
      this.deps.notify(
        'RAG: Indexing already in progress — another pass will run when it finishes.',
        3000
      );
    }
    this.passQueued = true;
    this.enqueue(() => this.runPass('manual'));
  }

  /** Single file — command palette "Index current file". */
  indexFile(file: TFile): void {
    if (this.disposed) return;
    if (file.extension !== 'md' && file.extension !== 'pdf') return;
    if (this.chatGated()) {
      this.deps.notify(
        'RAG: Chat is active or recent — the file will be indexed once it settles.',
        5000
      );
      this.pendingPass = true;
      return;
    }
    if (this.indexing) {
      this.deps.notify(
        'RAG: Indexing in progress — the file will be indexed after the current pass.',
        3000
      );
    }
    const path = file.path;
    void this.enqueue(() => this.runFile(path)).catch(
      err => console.error('RAG: File index error:', err)
    );
  }

  /** User-initiated cancel of the current run. True if a run was in progress. */
  cancelIndex(): boolean {
    if (!this.indexing) return false;
    this.runCancelled = true;
    this.runController?.abort();
    return true;
  }

  /**
   * Clear the index (settings). Deferred while chat is active or recent —
   * clearing unloads the query DB, which must never overlap a chat. The
   * returned promise resolves once the clear has actually run.
   */
  clearIndex(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.chatGated()) {
      this.pendingClear = true;
      this.deps.notify(
        'RAG: Index clear queued — it will run once chat settles.',
        5000
      );
      return new Promise<void>(resolve => this.clearWaiters.push(resolve));
    }
    return this.enqueue(() =>
      this.deps.vectorStore.clear(this.deps.getSettings().embeddingModel)
    );
  }

  /** Startup hook: run a pass once the quiet window elapses (auto-index only). */
  markStartup(): void {
    if (this.disposed) return;
    if (!this.deps.getSettings().autoIndexOnStartup) return;
    this.pendingPass = true;
    this.noteActivity();
  }

  /** Plugin unload: stop pending work and force-release the embedder. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    this.pendingChanged.clear();
    this.pendingRemovals.clear();
    this.pendingPass = false;
    this.pendingClear = false;
    this.clearWaiters.splice(0).forEach(w => w());
    this.runController?.abort();
    // Unload must cancel a hung load/infer, not wait for it: force-release
    // bypasses the in-flight/session guards and the provider is contractually
    // cancel-safe and bounded (kills its worker, leaves none behind).
    void this.deps.embeddingService
      .forceDispose()
      .catch(err => console.error('RAG: Embedder dispose failed:', err));
  }

  // ---- internals ----------------------------------------------------------

  private noteActivity(): void {
    if (this.disposed) return;
    this.lastActivity = Date.now();
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined;
      this.maybeRunPass();
    }, this.quietMs);
  }

  /**
   * Quiet window elapsed (or a run just finished): run any queued work.
   * Removals and an explicit clear are disk-backed; the index pass embeds.
   * Nothing here runs while a chat is active — the window includes chat activity.
   */
  private maybeRunPass(): void {
    if (this.disposed || this.indexing || this.activeChats > 0) return;
    if (Date.now() - this.lastActivity < this.quietMs) return;
    if (
      this.pendingRemovals.size === 0 &&
      !this.pendingPass &&
      this.pendingChanged.size === 0 &&
      !this.pendingClear
    ) {
      return;
    }
    const manual = this.pendingPass;
    const hadChanged = this.pendingChanged.size > 0;
    this.pendingPass = false;
    this.pendingChanged.clear();
    if (this.pendingRemovals.size > 0) {
      void this.enqueue(() => this.runRemovals()).catch(
        err => console.error('RAG: Remove file error:', err)
      );
    }
    if (this.pendingClear) {
      this.pendingClear = false;
      const waiters = this.clearWaiters;
      this.clearWaiters = [];
      void this.enqueue(() => this.runClear(waiters)).catch(
        err => console.error('RAG: Index clear error:', err)
      );
    }
    // A removal/clear-only quiet fire must not trigger a full re-scan.
    if (manual || (this.deps.getSettings().autoIndexOnStartup && hadChanged)) {
      this.passQueued = true;
      this.enqueue(() => this.runPass(manual ? 'manual' : 'auto'));
    }
  }

  /** True while chat is active or within the recent-chat quiet window. */
  private chatGated(): boolean {
    return this.activeChats > 0 || Date.now() - this.lastChatEnd < this.quietMs;
  }

  /** Append work to the single serial DB-write queue. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }


  private async runPass(kind: 'auto' | 'manual'): Promise<void> {
    if (this.disposed) return;
    this.indexing = true;
    this.passQueued = false;
    this.runAbortedForChat = false;
    this.runCancelled = false;
    const controller = new AbortController();
    this.runController = controller;
    // A chat arrived while this run was still queued: stop before the first file.
    if (this.stopQueuedRuns && this.activeChats > 0) {
      this.runAbortedForChat = true;
      controller.abort();
    }
    const progress = this.deps.createProgressNotice();
    try {
      // Keep the embedding worker alive across files for the whole pass.
      this.deps.embeddingService.beginSession();
      const result = await this.deps.indexManager.indexAll(
        this.deps.getSettings(),
        (current, total, filename) => {
          progress?.setMessage?.(`RAG: Indexing… ${current} / ${total}  —  ${filename}`);
        },
        controller.signal
      );
      this.finishPass(kind, result, null);
    } catch (err) {
      this.finishPass(kind, null, err);
    } finally {
      this.afterRun();
      progress?.hide?.();
    }
  }

  private async runFile(path: string): Promise<void> {
    if (this.disposed) return;
    const file = this.deps.resolveFile(path);
    if (!file) return; // deleted in the meantime
    if (file.extension !== 'md' && file.extension !== 'pdf') return;
    this.indexing = true;
    this.runAbortedForChat = false;
    this.runCancelled = false;
    const controller = new AbortController();
    this.runController = controller;
    try {
      // A chat arrived while this run was still queued: defer the file to the resume pass.
      if (this.stopQueuedRuns && this.activeChats > 0) {
        this.runAbortedForChat = true;
        this.pendingChanged.add(path);
        this.deps.notify('RAG: Chat in progress — the file index was deferred.', 3000);
        return;
      }
      this.deps.embeddingService.beginSession();
      const result = await this.deps.indexManager.indexCurrentFile(
        file,
        this.deps.getSettings()
      );
      if (!this.runAbortedForChat && !this.runCancelled) {
        this.lastRun = {
          kind: 'file',
          indexed: result.indexed,
          skipped: result.skipped,
          failed: result.failed,
          path: file.path,
          finishedAt: Date.now(),
        };
      }
      if (!result.skipped && !this.runAbortedForChat && !this.runCancelled) {
        this.deps.notify(`RAG: Indexed ${file.name}.`, 3000);
      }
    } catch (err) {
      if (this.runAbortedForChat || this.runCancelled) return;
      if (err instanceof ProviderError && err.code === 'DIMENSION_MISMATCH') {
        this.deps.notify(
          'RAG: Embedding model changed — run "RAG: Index all files" to re-index.',
          10000
        );
      } else if (this.isDesktopAdapterError(err)) {
        this.deps.notify(
          'RAG: Indexing requires a desktop vault (physical file paths). It is not supported on mobile.',
          10000
        );
      } else {
        this.deps.notify(
          `RAG: Index failed — ${(err as Error).message ?? 'unknown error'}`,
          8000
        );
      }
    } finally {
      this.afterRun();
    }
  }

  /** Remove queued paths, one at a time (serialized). Re-created paths are skipped. */
  private async runRemovals(): Promise<void> {
    if (this.disposed) return;
    for (const path of [...this.pendingRemovals]) {
      if (this.pendingChanged.has(path)) {
        // The path was re-created since the delete — index it instead.
        this.pendingRemovals.delete(path);
        continue;
      }
      await this.deps.indexManager.removeFile(path);
      this.pendingRemovals.delete(path);
    }
  }

  private async runClear(waiters: Array<() => void>): Promise<void> {
    try {
      await this.deps.vectorStore.clear(this.deps.getSettings().embeddingModel);
    } finally {
      waiters.forEach(w => w());
    }
  }

  private finishPass(
    kind: 'auto' | 'manual',
    result: IndexAllResult | null,
    err: unknown
  ): void {
    if (this.wasAborted(err)) {
      // The run may end via abort either by throwing or by returning a
      // partial result — both paths classify the same.
      // Chat preemption resumes silently after the quiet window.
      if (this.runCancelled) this.deps.notify('RAG: Indexing cancelled.', 4000);
      return;
    }
    if (err !== null) {
      if (err instanceof ProviderError && err.code === 'DIMENSION_MISMATCH') {
        this.deps.notify(
          'RAG: Embedding model changed — run "RAG: Index all files" to re-index.',
          10000
        );
      } else if (this.isDesktopAdapterError(err)) {
        this.deps.notify(
          'RAG: Indexing requires a desktop vault (physical file paths). It is not supported on mobile.',
          10000
        );
      } else {
        this.deps.notify(
          `RAG: Indexing failed — ${(err as Error).message ?? 'unknown error'}`,
          8000
        );
      }
      this.lastRun = {
        kind,
        indexed: 0,
        skipped: 0,
        failed: 0,
        error: (err as Error).message ?? 'unknown error',
        finishedAt: Date.now(),
      };
      return;
    }
    if (!result) return;
    this.lastRun = {
      kind,
      indexed: result.indexed,
      skipped: result.skipped,
      failed: result.failed,
      finishedAt: Date.now(),
    };
    const parts: string[] = [`${result.indexed} indexed`];
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
    if (result.failed > 0) parts.push(`${result.failed} failed`);
    this.deps.notify(
      kind === 'auto'
        ? `RAG: Auto index done — ${parts.join(', ')}.`
        : `RAG: Done — ${parts.join(', ')}.`,
      5000
    );
    if (result.warnings.length > 0) {
      this.deps.notify(`RAG warnings: ${result.warnings.join('; ')}`, 8000);
    }
  }

  private wasAborted(err: unknown): boolean {
    if (this.runAbortedForChat || this.runCancelled) return true;
    return err instanceof Error && err.message === 'Indexing aborted';
  }

  /** The GCF index needs physical file paths — unavailable on non-desktop vaults. */
  private isDesktopAdapterError(err: unknown): boolean {
    return (
      err instanceof Error &&
      err.message.startsWith('GCF index requires a desktop vault adapter')
    );
  }

  /** Common run teardown: DB is safe for queries again, release the model. */
  private afterRun(): void {
    this.indexing = false;
    this.runController = null;
    this.deps.embeddingService.endSession();
    void this.deps.embeddingService
      .dispose()
      .catch(err => console.error('RAG: Embedder dispose failed:', err));
    // Work queued while this run held the queue can proceed if the quiet window passed.
    this.maybeRunPass();
  }
}
