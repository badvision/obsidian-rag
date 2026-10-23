import RagPlugin from './main';
import { DEFAULT_SETTINGS } from './settings';

// Mock all service modules to avoid actual I/O
jest.mock('./providers/factory');
jest.mock('./store/VectorStore');
jest.mock('./indexer/ChunkingService');
jest.mock('./rag/EmbeddingService');
jest.mock('./rag/CitationService');
jest.mock('./indexer/IndexManager');

// Pull in mocked constructors for assertion
import { VectorStore } from './store/VectorStore';
import { IndexManager } from './indexer/IndexManager';
import { Notice } from 'obsidian';

const MockVectorStore = VectorStore as jest.MockedClass<typeof VectorStore>;
const MockIndexManager = IndexManager as jest.MockedClass<typeof IndexManager>;
const MockNotice = Notice as jest.MockedClass<typeof Notice>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map from vault event name → registered callbacks, so tests can trigger them.
 */
type VaultEventName = 'modify' | 'delete' | 'rename';
type VaultEventMap = Partial<Record<VaultEventName, (...args: any[]) => any>>;

function makeApp(vaultEventMap: VaultEventMap = {}): any {
  return {
    vault: {
      on: jest.fn((event: string, cb: (...args: any[]) => any) => {
        (vaultEventMap as any)[event] = cb;
        return {};
      }),
      adapter: {
        exists: jest.fn().mockResolvedValue(true),
        read: jest.fn().mockResolvedValue('{}'),
        write: jest.fn().mockResolvedValue(undefined),
        mkdir: jest.fn().mockResolvedValue(undefined),
        getBasePath: jest.fn().mockReturnValue('/vault'),
      },
      getFiles: jest.fn().mockReturnValue([]),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
    },
    workspace: {
      openLinkText: jest.fn().mockResolvedValue(undefined),
      getActiveFile: jest.fn().mockReturnValue(null),
      on: jest.fn().mockReturnValue({}),
    },
  };
}

import { RagPluginSettings } from './settings';

function makePlugin(overrides: Partial<RagPluginSettings> = {}, app?: any): RagPlugin {
  const resolvedApp = app ?? makeApp();
  const manifest = {
    dir: '.obsidian/plugins/obsidian-rag',
    id: 'obsidian-rag',
    name: 'RAG',
    author: 'test',
    version: '0.1.0',
    minAppVersion: '0.15.0',
    description: 'Test',
  };
  const plugin = new RagPlugin(resolvedApp, manifest) as RagPlugin;

  // Spy on Plugin base methods so we can assert call counts
  jest.spyOn(plugin, 'addCommand').mockReturnValue({} as any);
  jest.spyOn(plugin, 'addSettingTab').mockReturnValue(undefined);
  jest.spyOn(plugin, 'registerEvent').mockReturnValue({} as any);
  jest.spyOn(plugin, 'loadData').mockResolvedValue(overrides);
  jest.spyOn(plugin, 'saveData').mockResolvedValue(undefined);

  return plugin;
}

/** Drain queued microtasks (serial scheduler queue) without touching timers. */
async function flushMicrotasks(hops = 12): Promise<void> {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

const QUIET_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Setup — reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Ensure real timers between tests (in case a test used fake timers)
  jest.useRealTimers();

  // Default VectorStore mock: metadata checks resolve; no full index load
  (MockVectorStore as jest.Mock).mockImplementation(function(this: any) {
    this.ensureLoaded = jest.fn().mockResolvedValue(undefined);
    this.exists = jest.fn().mockResolvedValue(true);
    this.peekModel = jest.fn().mockResolvedValue(null);
    this.save = jest.fn().mockResolvedValue(undefined);
    this.query = jest.fn().mockReturnValue([]);
    this.upsertFile = jest.fn();
    this.removeFile = jest.fn();
    this.clear = jest.fn().mockResolvedValue(undefined);
    this.getFileMtime = jest.fn().mockReturnValue(null);
    this.getStats = jest.fn().mockReturnValue({ fileCount: 0, chunkCount: 0, embeddingModel: '', updatedAt: '' });
  });

  // Default IndexManager mock: assign methods to `this` so mock.instances[0] has them
  (MockIndexManager as jest.Mock).mockImplementation(function(this: any) {
    this.indexAll = jest.fn().mockResolvedValue({ indexed: 0, skipped: 0, failed: 0, warnings: [] });
    this.indexCurrentFile = jest.fn().mockResolvedValue({ indexed: 1, skipped: 0, failed: 0, warnings: [] });
    this.removeFile = jest.fn().mockResolvedValue(undefined);
    this.getFilesToIndex = jest.fn().mockReturnValue([]);
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RagPlugin.onload', () => {
  test('services are constructed after onload', async () => {
    const plugin = makePlugin();
    await plugin.onload();

    expect(plugin.vectorStore).toBeDefined();
    expect(plugin.indexScheduler).toBeDefined();
    expect(MockVectorStore).toHaveBeenCalledTimes(1);
  });

  test('does NOT eagerly load the index on startup', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    await flushMicrotasks();

    const storeInstance = (MockVectorStore as jest.Mock).mock.instances[0];
    expect(storeInstance.ensureLoaded).not.toHaveBeenCalled();
  });

  test('registers exactly 4 commands', async () => {
    const plugin = makePlugin();
    await plugin.onload();

    expect(plugin.addCommand).toHaveBeenCalledTimes(4);
  });

  test('registers settings tab once', async () => {
    const plugin = makePlugin();
    await plugin.onload();

    expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
  });

  test('registers exactly 3 vault events', async () => {
    const plugin = makePlugin();
    await plugin.onload();

    expect(plugin.registerEvent).toHaveBeenCalledTimes(3);
  });

  test('no index found shows first-run guidance Notice without loading the index', async () => {
    const app = makeApp();
    const plugin = makePlugin({}, app);

    (MockVectorStore as jest.Mock).mockImplementationOnce(function(this: any) {
      this.ensureLoaded = jest.fn().mockResolvedValue(undefined);
      this.exists = jest.fn().mockResolvedValue(false);
    });

    await plugin.onload();
    await flushMicrotasks();

    expect(MockNotice).toHaveBeenCalledWith(
      expect.stringContaining('No index found'),
      8000
    );
    const storeInstance = (MockVectorStore as jest.Mock).mock.instances[0];
    expect(storeInstance.ensureLoaded).not.toHaveBeenCalled();
  });

  test('index stored with a different model shows re-index Notice via metadata only', async () => {
    const app = makeApp();
    const plugin = makePlugin({}, app);

    (MockVectorStore as jest.Mock).mockImplementationOnce(function(this: any) {
      this.ensureLoaded = jest.fn().mockResolvedValue(undefined);
      this.exists = jest.fn().mockResolvedValue(true);
      this.peekModel = jest.fn().mockResolvedValue('old-model');
    });

    await plugin.onload();
    await flushMicrotasks();

    expect(MockNotice).toHaveBeenCalledWith(
      expect.stringContaining('Embedding model changed'),
      10000
    );
    const storeInstance = (MockVectorStore as jest.Mock).mock.instances[0];
    expect(storeInstance.ensureLoaded).not.toHaveBeenCalled();
  });

  test('index exists with the same model — no Notice shown', async () => {
    const plugin = makePlugin();
    await plugin.onload();
    await flushMicrotasks();

    expect(MockNotice).not.toHaveBeenCalled();
  });

});

describe('RagPlugin startup auto-index (quiet window)', () => {
  test('autoIndexOnStartup=true: index runs only after the quiet window elapses', async () => {
    jest.useFakeTimers();
    const plugin = makePlugin({ autoIndexOnStartup: true });
    await plugin.onload();
    const indexAllSpy = (MockIndexManager as jest.Mock).mock.instances[0].indexAll as jest.MockedFunction<any>;

    jest.advanceTimersByTime(QUIET_MS - 60 * 1000);
    await flushMicrotasks();
    expect(indexAllSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60 * 1000 + 1);
    await flushMicrotasks();
    expect(indexAllSpy).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  test('autoIndexOnStartup=false: no auto index after the quiet window', async () => {
    jest.useFakeTimers();
    const plugin = makePlugin({ autoIndexOnStartup: false });
    await plugin.onload();
    const indexAllSpy = (MockIndexManager as jest.Mock).mock.instances[0].indexAll as jest.MockedFunction<any>;

    jest.advanceTimersByTime(QUIET_MS + 60 * 1000);
    await flushMicrotasks();
    expect(indexAllSpy).not.toHaveBeenCalled();

    jest.useRealTimers();
  });
});

describe('RagPlugin vault event handlers', () => {
  test('vault delete defers indexManager.removeFile until the quiet window', async () => {
    jest.useFakeTimers();
    const vaultEventMap: VaultEventMap = {};
    const app = makeApp(vaultEventMap);
    const plugin = makePlugin({}, app);
    await plugin.onload();

    const removeFileSpy = (MockIndexManager as jest.Mock).mock.instances[0].removeFile as jest.MockedFunction<any>;

    const fakeFile = {
      path: 'notes/deleted.md',
      name: 'deleted.md',
      extension: 'md',
      basename: 'deleted',
      stat: { mtime: 0, size: 0, ctime: 0 },
    };
    vaultEventMap['delete']?.(fakeFile);
    await flushMicrotasks();
    expect(removeFileSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUIET_MS);
    await flushMicrotasks();
    expect(removeFileSpy).toHaveBeenCalledWith('notes/deleted.md');

    jest.useRealTimers();
  });

  test('vault rename defers old-path removal until the quiet window', async () => {
    jest.useFakeTimers();
    const vaultEventMap: VaultEventMap = {};
    const app = makeApp(vaultEventMap);
    const plugin = makePlugin({}, app);
    await plugin.onload();

    const removeFileSpy = (MockIndexManager as jest.Mock).mock.instances[0].removeFile as jest.MockedFunction<any>;

    const fakeFile = {
      path: 'notes/new-name.md',
      name: 'new-name.md',
      extension: 'md',
      basename: 'new-name',
      stat: { mtime: 0, size: 0, ctime: 0 },
    };
    vaultEventMap['rename']?.(fakeFile, 'notes/old-name.md');
    await flushMicrotasks();
    expect(removeFileSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUIET_MS);
    await flushMicrotasks();
    expect(removeFileSpy).toHaveBeenCalledWith('notes/old-name.md');

    jest.useRealTimers();
  });

  test('vault modify queues an auto index pass that runs after the quiet window', async () => {
    jest.useFakeTimers();
    const vaultEventMap: VaultEventMap = {};
    const app = makeApp(vaultEventMap);
    const plugin = makePlugin({ autoIndexOnStartup: true }, app);
    await plugin.onload();

    const indexAllSpy = (MockIndexManager as jest.Mock).mock.instances[0].indexAll as jest.MockedFunction<any>;

    const fakeFile = {
      path: 'notes/changed.md',
      name: 'changed.md',
      extension: 'md',
      basename: 'changed',
      stat: { mtime: 1000, size: 100, ctime: 0 },
    };
    vaultEventMap['modify']?.(fakeFile);
    await flushMicrotasks();
    expect(indexAllSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUIET_MS);
    await flushMicrotasks();
    expect(indexAllSpy).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  test('vault modify does NOT auto-index when autoIndexOnStartup=false', async () => {
    jest.useFakeTimers();
    const vaultEventMap: VaultEventMap = {};
    const app = makeApp(vaultEventMap);
    const plugin = makePlugin({ autoIndexOnStartup: false }, app);
    await plugin.onload();

    const indexAllSpy = (MockIndexManager as jest.Mock).mock.instances[0].indexAll as jest.MockedFunction<any>;

    const fakeFile = {
      path: 'notes/changed.md',
      name: 'changed.md',
      extension: 'md',
      basename: 'changed',
      stat: { mtime: 1000, size: 100, ctime: 0 },
    };
    vaultEventMap['modify']?.(fakeFile);

    jest.advanceTimersByTime(QUIET_MS + 60 * 1000);
    await flushMicrotasks();
    expect(indexAllSpy).not.toHaveBeenCalled();

    jest.useRealTimers();
  });
});

describe('RagPlugin manual index', () => {
  test('indexAll() runs a full pass immediately when no chat is active or recent', async () => {
    const plugin = makePlugin();
    await plugin.onload();

    const indexAllSpy = (MockIndexManager as jest.Mock).mock.instances[0].indexAll as jest.MockedFunction<any>;

    await plugin.indexAll();
    await flushMicrotasks();

    expect(indexAllSpy).toHaveBeenCalledTimes(1);
    expect(MockNotice).toHaveBeenCalledWith(
      expect.stringContaining('Done'),
      5000
    );
  });
});

describe('RagPlugin settings', () => {
  test('loadSettings merges loaded data with DEFAULT_SETTINGS', async () => {
    const plugin = makePlugin({ topK: 10, chatModel: 'custom-model' });
    await plugin.loadSettings();

    expect(plugin.settings.topK).toBe(10);
    expect(plugin.settings.chatModel).toBe('custom-model');
    // Fields not in the loaded data remain at defaults
    expect(plugin.settings.chatProvider).toBe(DEFAULT_SETTINGS.chatProvider);
    expect(plugin.settings.chunkSize).toBe(DEFAULT_SETTINGS.chunkSize);
  });

  test('saveSettings calls saveData with current settings', async () => {
    const plugin = makePlugin();
    await plugin.onload();

    plugin.settings.topK = 15;
    await plugin.saveSettings();

    expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ topK: 15 }));
  });
});
