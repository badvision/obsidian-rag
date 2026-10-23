import type { TFile, TAbstractFile } from 'obsidian';
import type { RagPluginSettings } from './settings';
import { ProviderError } from './providers/types';
import { IndexScheduler, DEFAULT_QUIET_MS } from './indexScheduler';
import type { IndexSchedulerDeps } from './indexScheduler';

const QUIET = DEFAULT_QUIET_MS;

interface VaultFileStub {
  path: string;
  name: string;
  extension: string;
}

function file(path: string): VaultFileStub {
  const name = path.split('/').pop() ?? path;
  return { path, name, extension: path.split('.').pop() ?? '' };
}

const asTFile = (f: VaultFileStub) => f as unknown as TFile;
const asAbstract = (f: VaultFileStub) => f as unknown as TAbstractFile;

const DONE = { indexed: 0, skipped: 0, failed: 0, warnings: [] };

function makeScheduler(overrides: { autoIndex?: boolean } = {}) {
  const indexManager = {
    indexAll: jest.fn().mockResolvedValue({ ...DONE, indexed: 1 }),
    indexCurrentFile: jest.fn().mockResolvedValue({ ...DONE, indexed: 1 }),
    removeFile: jest.fn().mockResolvedValue(undefined),
  };
  const embeddingService = {
    beginSession: jest.fn(),
    endSession: jest.fn(),
    dispose: jest.fn().mockResolvedValue(undefined),
    forceDispose: jest.fn().mockResolvedValue(undefined),
  };
  const vectorStore = {
    clear: jest.fn().mockResolvedValue(undefined),
  };
  const settings: Record<string, unknown> = {
    autoIndexOnStartup: overrides.autoIndex ?? true,
    embeddingModel: 'nomic',
  };
  const deps = {
    indexManager,
    embeddingService,
    vectorStore,
    getSettings: () => settings as unknown as RagPluginSettings,
    resolveFile: jest.fn().mockReturnValue(null),
    notify: jest.fn(),
    createProgressNotice: jest.fn().mockReturnValue(null),
  };
  const scheduler = new IndexScheduler(deps as unknown as IndexSchedulerDeps);
  return {
    scheduler,
    indexManager,
    embeddingService,
    vectorStore,
    resolveFile: deps.resolveFile as jest.MockedFunction<(p: string) => TFile | null>,
    notify: deps.notify as jest.MockedFunction<(m: string, t: number) => void>,
  };
}

async function flush(hops = 12): Promise<void> {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

/** indexAll mock that completes only when its signal is aborted. */
function blockerIndexAll() {
  return jest.fn(
    (_settings: unknown, _progress?: unknown, signal?: AbortSignal) =>
      new Promise(resolve => {
        signal?.addEventListener('abort', () =>
          resolve({ ...DONE })
        );
      })
  );
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('IndexScheduler: quiet window and coalescing', () => {
  test('changed files trigger one coalesced pass only after the quiet window', async () => {
    const { scheduler, indexManager, notify } = makeScheduler();

    scheduler.onVaultModify(asTFile(file('a.md')));
    scheduler.onVaultModify(asTFile(file('b.pdf')));
    await flush();
    expect(indexManager.indexAll).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUIET - 1000);
    await flush();
    expect(indexManager.indexAll).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1001);
    await flush();
    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Auto index done'), 5000);
  });

  test('every activity resets the trailing window (not a per-file throttle)', async () => {
    const { scheduler, indexManager } = makeScheduler();
    const f = asTFile(file('a.md'));

    scheduler.onVaultModify(f);
    jest.advanceTimersByTime(2 * 60 * 1000);
    scheduler.onVaultModify(f);
    jest.advanceTimersByTime(2 * 60 * 1000);
    await flush();
    expect(indexManager.indexAll).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60 * 1000 + 1); // last edit + 3 min
    await flush();
    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
  });

  test('non-indexed extensions are ignored', async () => {
    const { scheduler, indexManager } = makeScheduler();
    scheduler.onVaultModify(asTFile(file('notes/todo.txt')));

    jest.advanceTimersByTime(QUIET + 1000);
    await flush();
    expect(indexManager.indexAll).not.toHaveBeenCalled();
  });
});

describe('IndexScheduler: chat lease', () => {
  test('chat preempts an in-flight pass at a file boundary and the pass resumes after quiet', async () => {
    const { scheduler, indexManager, embeddingService } = makeScheduler();

    indexManager.indexAll
      .mockImplementationOnce(blockerIndexAll())
      .mockResolvedValue({ ...DONE, indexed: 1 });

    scheduler.requestManualIndex();
    await flush();
    expect(scheduler.isIndexing).toBe(true);

    const leaseP = scheduler.acquireChatLease();
    await flush();
    // The run was aborted so the lease can proceed with a published index.
    await leaseP;
    expect(scheduler.isIndexing).toBe(false);
    // Run teardown released the embedder even for a preempted pass.
    expect(embeddingService.dispose).toHaveBeenCalled();

    const lease = await leaseP;
    lease.end();
    await flush();

    jest.advanceTimersByTime(QUIET); // resume after quiet window
    await flush();
    expect(indexManager.indexAll).toHaveBeenCalledTimes(2);
  });

  test('manual index is queued with a notice while chat is active', async () => {
    const { scheduler, indexManager, notify } = makeScheduler();

    const lease = await scheduler.acquireChatLease();
    scheduler.requestManualIndex();
    await flush();
    expect(indexManager.indexAll).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Chat is active or recent'),
      5000
    );

    lease.end();
    jest.advanceTimersByTime(QUIET);
    await flush();
    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
  });

  test('manual index is queued while chat is recent (ended within quiet window)', async () => {
    const { scheduler, indexManager } = makeScheduler();

    const lease = await scheduler.acquireChatLease();
    lease.end();

    scheduler.requestManualIndex();
    await flush();
    expect(indexManager.indexAll).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUIET);
    await flush();
    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
  });

  test('a queued pass that has not started is stopped at its boundary while chat is active', async () => {
    const { scheduler, indexManager, resolveFile } = makeScheduler();

    let releaseFile!: () => void;
    indexManager.indexCurrentFile.mockImplementationOnce(
      () =>
        new Promise((resolve: (v: { indexed: number; skipped: number; failed: number; warnings: string[] }) => void) => {
          releaseFile = () => resolve({ ...DONE, indexed: 1 });
        })
    );
    let passSignal: AbortSignal | null = null as AbortSignal | null;
    indexManager.indexAll.mockImplementationOnce(
      (_s: unknown, _p?: unknown, signal?: AbortSignal) => {
        passSignal = signal ?? null;
        return Promise.resolve({ ...DONE, skipped: 3 });
      }
    );
    resolveFile.mockReturnValue(asTFile(file('a.md')));

    scheduler.indexFile(file('a.md') as unknown as TFile); // occupies the queue
    scheduler.requestManualIndex(); // queued behind the file run
    await flush();
    expect(indexManager.indexAll).not.toHaveBeenCalled();

    // The lease waits for all DB writes to settle, including the in-flight
    // file run (the real embed honors the abort signal; this mock ends on
    // release), so it must not be awaited before the file run is released.
    const leasePromise = scheduler.acquireChatLease();
    releaseFile(); // ends the file run; the queued pass then stops at its boundary
    const lease = await leasePromise;
    await flush();

    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
    expect(passSignal?.aborted).toBe(true); // stopped before indexing any file

    lease.end();
    jest.advanceTimersByTime(QUIET); // resumed after quiet window
    await flush();
    expect(indexManager.indexAll).toHaveBeenCalledTimes(2);
  });

  test('an active chat blocks the quiet fire; the pass runs 3 min after chat ends', async () => {
    const { scheduler, indexManager } = makeScheduler();

    scheduler.onVaultModify(asTFile(file('a.md')));
    jest.advanceTimersByTime(QUIET - 60 * 1000);

    const lease = await scheduler.acquireChatLease(); // chat starts at t+2min
    jest.advanceTimersByTime(QUIET - 60 * 1000); // t+4min: quiet since edit, but not since chat
    await flush();
    expect(indexManager.indexAll).not.toHaveBeenCalled();

    lease.end(); // t+4min
    jest.advanceTimersByTime(QUIET); // t+7min: 3 min after chat end
    await flush();
    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
  });

  test('a failed chat (lease) cannot hang: end releases exactly once and re-end is a no-op', async () => {
    const { scheduler } = makeScheduler();
    const lease = await scheduler.acquireChatLease();
    lease.end();
    lease.end(); // double end must not underflow activeChats
    jest.advanceTimersByTime(QUIET);
    await flush();
    expect(scheduler.isIndexing).toBe(false);
  });
});

describe('IndexScheduler: deletions and renames', () => {
  test('deletions run serialized after the quiet window (no concurrent DB writes)', async () => {
    const { scheduler, indexManager } = makeScheduler({ autoIndex: false });

    let inflight = 0;
    let maxInflight = 0;
    indexManager.removeFile.mockImplementation(() => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise<void>(r => setTimeout(() => { inflight--; r(); }, 10));
    });

    scheduler.onVaultDelete(asAbstract(file('a.md')));
    scheduler.onVaultDelete(asAbstract(file('b.md')));
    await flush();
    jest.advanceTimersByTime(QUIET - 1000);
    await flush();
    expect(indexManager.removeFile).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1100); // quiet window elapses
    await flush();
    jest.advanceTimersByTime(50);
    await flush();

    expect(indexManager.removeFile).toHaveBeenCalledTimes(2);
    expect(maxInflight).toBe(1);
  });

  test('a delete coalesces the path out of the pending changed set', async () => {
    const { scheduler, indexManager } = makeScheduler();

    scheduler.onVaultModify(asTFile(file('x.md')));
    scheduler.onVaultDelete(asAbstract(file('x.md')));

    jest.advanceTimersByTime(QUIET + 1000);
    await flush();

    expect(indexManager.removeFile).toHaveBeenCalledWith('x.md');
    expect(indexManager.indexAll).not.toHaveBeenCalled(); // nothing left to index
  });

  test('rename defers old-path removal to the quiet window and re-indexes the new path', async () => {
    const { scheduler, indexManager } = makeScheduler();

    scheduler.onVaultRename(asAbstract(file('notes/new.md')), 'notes/old.md');
    await flush();
    expect(indexManager.removeFile).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUIET);
    await flush();
    expect(indexManager.removeFile).toHaveBeenCalledWith('notes/old.md');
    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
  });

  test('a deletion during an active chat does not touch the DB until both vault and chat are quiet', async () => {
    const { scheduler, indexManager } = makeScheduler({ autoIndex: false });

    const lease = await scheduler.acquireChatLease();
    scheduler.onVaultDelete(asAbstract(file('a.md')));
    await flush();
    jest.advanceTimersByTime(QUIET);
    await flush();
    expect(indexManager.removeFile).not.toHaveBeenCalled(); // chat still active

    lease.end();
    jest.advanceTimersByTime(QUIET); // quiet since chat end too
    await flush();
    expect(indexManager.removeFile).toHaveBeenCalledWith('a.md');
  });

  test('a deletion during the recent-chat window is deferred until the window expires', async () => {
    const { scheduler, indexManager } = makeScheduler({ autoIndex: false });

    const lease = await scheduler.acquireChatLease();
    lease.end(); // chat ended just now — inside the recent window
    scheduler.onVaultDelete(asAbstract(file('a.md')));
    await flush();
    jest.advanceTimersByTime(QUIET - 1000);
    await flush();
    expect(indexManager.removeFile).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1100);
    await flush();
    expect(indexManager.removeFile).toHaveBeenCalledWith('a.md');
  });

  test('re-creating a path cancels the pending removal for it', async () => {
    const { scheduler, indexManager } = makeScheduler();

    scheduler.onVaultDelete(asAbstract(file('x.md')));
    scheduler.onVaultModify(asTFile(file('x.md'))); // re-created

    jest.advanceTimersByTime(QUIET);
    await flush();

    expect(indexManager.removeFile).not.toHaveBeenCalled(); // no stale removal
    expect(indexManager.indexAll).toHaveBeenCalledTimes(1); // re-indexed instead
  });
});

describe('IndexScheduler: manual triggers, cancel, errors', () => {
  test('manual index runs immediately when no chat is active or recent (even with autoIndex off)', async () => {
    const { scheduler, indexManager } = makeScheduler({ autoIndex: false });
    scheduler.requestManualIndex();
    await flush();
    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
  });

  test('manual single-file index runs only that file', async () => {
    const { scheduler, indexManager, resolveFile, notify } = makeScheduler();
    const stub = file('notes/a.md');
    resolveFile.mockReturnValue(asTFile(stub));

    scheduler.indexFile(asTFile(stub));
    await flush();

    expect(indexManager.indexCurrentFile).toHaveBeenCalledWith(
      asTFile(stub),
      expect.objectContaining({ embeddingModel: 'nomic' })
    );
    expect(indexManager.indexAll).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('RAG: Indexed a.md.', 3000);
  });

  test('manual single-file index for a file deleted in the meantime is a silent no-op', async () => {
    const { scheduler, indexManager, resolveFile, notify } = makeScheduler();
    const stub = file('notes/a.md');
    resolveFile.mockReturnValue(null);

    scheduler.indexFile(asTFile(stub));
    await flush();

    expect(indexManager.indexCurrentFile).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('cancelIndex stops the current run and notifies; queued leases unblock', async () => {
    const { scheduler, indexManager, notify } = makeScheduler();
    indexManager.indexAll.mockImplementationOnce(
      (_s: unknown, _p?: unknown, sig?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          sig?.addEventListener('abort', () => reject(new Error('Indexing aborted')));
        })
    );

    scheduler.requestManualIndex();
    await flush();
    expect(scheduler.isIndexing).toBe(true);
    expect(scheduler.cancelIndex()).toBe(true);
    await flush();

    expect(notify).toHaveBeenCalledWith('RAG: Indexing cancelled.', 4000);
    expect(scheduler.isIndexing).toBe(false);

    // A chat arriving right after cancel must not hang.
    const lease = await scheduler.acquireChatLease();
    lease.end();
    await flush();
  });

  test('a failed pass shows an error notice; a previous committed index is untouched by the scheduler', async () => {
    const { scheduler, indexManager, notify } = makeScheduler();
    indexManager.indexAll.mockRejectedValueOnce(new Error('boom'));

    scheduler.requestManualIndex();
    await flush();

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Indexing failed — boom'),
      8000
    );
    expect(scheduler.isIndexing).toBe(false);
  });

  test('a model-mismatch failure shows the re-index notice', async () => {
    const { scheduler, indexManager, notify } = makeScheduler();
    indexManager.indexAll.mockRejectedValueOnce(
      new ProviderError('model changed', 'DIMENSION_MISMATCH')
    );

    scheduler.requestManualIndex();
    await flush();

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Embedding model changed'),
      10000
    );
  });

  test('a non-desktop (mobile) vault adapter failure shows the friendly notice, not the raw error', async () => {
    const { scheduler, indexManager, notify } = makeScheduler();
    indexManager.indexAll.mockRejectedValueOnce(
      new Error('GCF index requires a desktop vault adapter (physical file paths)')
    );

    scheduler.requestManualIndex();
    await flush();

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('requires a desktop vault'),
      10000
    );
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining('Indexing failed'),
      expect.anything()
    );
  });

  test('clearIndex is serialized behind a running pass', async () => {
    const { scheduler, indexManager, vectorStore } = makeScheduler();

    let release!: () => void;
    indexManager.indexAll.mockImplementationOnce(
      () => new Promise<void>(r => { release = r; })
    );

    scheduler.requestManualIndex();
    await flush();

    const clearP = scheduler.clearIndex();
    await flush();
    expect(vectorStore.clear).not.toHaveBeenCalled();

    release();
    await clearP;
    await flush();
    expect(vectorStore.clear).toHaveBeenCalledWith('nomic');
  });

  test('clearIndex during an active chat is deferred until the chat settles', async () => {
    const { scheduler, vectorStore, notify } = makeScheduler();

    const lease = await scheduler.acquireChatLease();
    const clearP = scheduler.clearIndex();
    await flush();
    expect(vectorStore.clear).not.toHaveBeenCalled(); // never mid-chat
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Index clear queued'),
      5000
    );

    lease.end();
    await flush();
    expect(vectorStore.clear).not.toHaveBeenCalled(); // still inside the recent window

    jest.advanceTimersByTime(QUIET);
    await clearP; // resolves once the clear has actually run
    expect(vectorStore.clear).toHaveBeenCalledWith('nomic');
  });

  test('clearIndex is a no-op promise after dispose', async () => {
    const { scheduler, vectorStore } = makeScheduler();

    scheduler.dispose();
    await scheduler.clearIndex();
    expect(vectorStore.clear).not.toHaveBeenCalled();
  });
});

describe('IndexScheduler: embedder lifecycle', () => {
  test('session is held across the whole pass and the model is released after', async () => {
    const { scheduler, indexManager, embeddingService, notify } = makeScheduler();

    let sessionHeldDuringRun = false;
    let endedDuringRun = false;
    indexManager.indexAll.mockImplementationOnce(() => {
      sessionHeldDuringRun = embeddingService.beginSession.mock.calls.length > 0;
      endedDuringRun = embeddingService.endSession.mock.calls.length > 0;
      return Promise.resolve({ indexed: 2, skipped: 1, failed: 0, warnings: [] });
    });

    scheduler.requestManualIndex();
    await flush();

    expect(sessionHeldDuringRun).toBe(true);
    expect(endedDuringRun).toBe(false);
    expect(embeddingService.beginSession).toHaveBeenCalledTimes(1);
    expect(embeddingService.endSession).toHaveBeenCalledTimes(1);
    expect(embeddingService.dispose).toHaveBeenCalled(); // model released after the run
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('2 indexed'), 5000);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('1 skipped'), 5000);
  });

  test('dispose() cancels pending quiet work, aborts a running pass, and releases the model', async () => {
    const { scheduler, indexManager, embeddingService } = makeScheduler();

    indexManager.indexAll.mockImplementationOnce(blockerIndexAll());
    scheduler.requestManualIndex();
    await flush();
    expect(scheduler.isIndexing).toBe(true);

    scheduler.dispose();
    await flush();

    expect(scheduler.isIndexing).toBe(false); // aborted
    // Unload takes the force path (cancels a hung load/infer), not the
    // session-gated dispose that would no-op while a run held the session.
    expect(embeddingService.forceDispose).toHaveBeenCalledTimes(1);

    // Nothing scheduled anymore survives.
    jest.advanceTimersByTime(QUIET * 2);
    await flush();
    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
  });
});

describe('IndexScheduler: status summary', () => {
  test('getStatus(): reports queued vault changes and a pending full pass', () => {
    const { scheduler } = makeScheduler();
    scheduler.onVaultModify(asTFile(file('a.md')));
    scheduler.onVaultModify(asTFile(file('b.pdf')));
    scheduler.onVaultDelete(asAbstract(file('gone.md')));
    scheduler.requestManualIndex();

    const status = scheduler.getStatus();
    expect(status.indexing).toBe(false);
    expect(status.queued).toEqual({ changes: 2, removals: 1, fullPass: true, clear: false });
    expect(status.lastRun).toBeNull();
  });

  test('getStatus(): records the last completed pass for the settings summary', async () => {
    const { scheduler, indexManager } = makeScheduler();
    indexManager.indexAll.mockResolvedValueOnce({ indexed: 2, skipped: 5, failed: 1, warnings: [] });

    scheduler.requestManualIndex();
    await flush();

    expect(indexManager.indexAll).toHaveBeenCalledTimes(1);
    const status = scheduler.getStatus();
    expect(status.lastRun?.kind).toBe('manual');
    expect(status.lastRun?.indexed).toBe(2);
    expect(status.lastRun?.skipped).toBe(5);
    expect(status.lastRun?.failed).toBe(1);
    expect(typeof status.lastRun?.finishedAt).toBe('number');
  });

  test('getStatus(): records a failed pass with its error, not as a completed run', async () => {
    const { scheduler, indexManager } = makeScheduler();
    indexManager.indexAll.mockRejectedValueOnce(new Error('boom'));

    scheduler.requestManualIndex();
    await flush();

    const status = scheduler.getStatus();
    expect(status.lastRun?.kind).toBe('manual');
    expect(status.lastRun?.error).toBe('boom');
    expect(status.lastRun?.indexed).toBe(0);
  });

  test('getStatus(): a single-file index is recorded with its path', async () => {
    const { scheduler, indexManager, resolveFile } = makeScheduler();
    const target = file('Work/notes.md');
    resolveFile.mockReturnValue(target as unknown as TFile);
    indexManager.indexCurrentFile.mockResolvedValueOnce({ indexed: 1, skipped: 0, failed: 0, warnings: [] });

    scheduler.indexFile(target as unknown as TFile);
    await flush();

    const status = scheduler.getStatus();
    expect(status.lastRun?.kind).toBe('file');
    expect(status.lastRun?.path).toBe('Work/notes.md');
    expect(status.lastRun?.indexed).toBe(1);
  });

  test('getStatus(): an aborted pass is NOT recorded as the last run', async () => {
    const { scheduler, indexManager } = makeScheduler();
    indexManager.indexAll.mockImplementationOnce(blockerIndexAll());
    scheduler.requestManualIndex();
    await flush();
    scheduler.cancelIndex();
    await flush();

    expect(scheduler.getStatus().lastRun).toBeNull();
  });
});
