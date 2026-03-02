import RagPlugin from './main';
import { DEFAULT_SETTINGS } from './settings';
import { ProviderError } from './providers/types';

// Mock all service modules to avoid actual I/O
jest.mock('./providers/factory');
jest.mock('./store/VectorStore');
jest.mock('./indexer/ChunkingService');
jest.mock('./rag/EmbeddingService');
jest.mock('./rag/CitationService');
jest.mock('./rag/QueryService');
jest.mock('./indexer/IndexManager');
jest.mock('./ui/RagModal');
jest.mock('./ui/IndexProgressModal');

// Pull in mocked constructors for assertion
import { VectorStore } from './store/VectorStore';
import { IndexManager } from './indexer/IndexManager';
import { IndexProgressModal } from './ui/IndexProgressModal';
import { RagModal } from './ui/RagModal';
import { Notice } from 'obsidian';

const MockVectorStore = VectorStore as jest.MockedClass<typeof VectorStore>;
const MockIndexManager = IndexManager as jest.MockedClass<typeof IndexManager>;
const MockIndexProgressModal = IndexProgressModal as jest.MockedClass<typeof IndexProgressModal>;
const MockRagModal = RagModal as jest.MockedClass<typeof RagModal>;
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

// ---------------------------------------------------------------------------
// Setup — reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Ensure real timers between tests (in case a test used fake timers)
  jest.useRealTimers();

  // Default VectorStore mock: ensureLoaded resolves, exists returns true
  (MockVectorStore as jest.Mock).mockImplementation(function(this: any) {
    this.ensureLoaded = jest.fn().mockResolvedValue(undefined);
    this.exists = jest.fn().mockResolvedValue(true);
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

  // IndexProgressModal open is a no-op
  MockIndexProgressModal.mockImplementation(() => {
    return { open: jest.fn() } as any;
  });

  MockRagModal.mockImplementation(() => {
    return { open: jest.fn() } as any;
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
    expect(MockVectorStore).toHaveBeenCalledTimes(1);
  });

  test('registers exactly 3 commands', async () => {
    const plugin = makePlugin();
    await plugin.onload();

    expect(plugin.addCommand).toHaveBeenCalledTimes(3);
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

  test('dimension mismatch error shows re-index Notice', async () => {
    const app = makeApp();
    const plugin = makePlugin({}, app);

    (MockVectorStore as jest.Mock).mockImplementationOnce(function(this: any) {
      this.ensureLoaded = jest.fn().mockRejectedValue(
        new ProviderError('model changed', 'DIMENSION_MISMATCH')
      );
      this.exists = jest.fn().mockResolvedValue(true);
    });

    await plugin.onload();
    // Allow microtasks to settle
    await new Promise(resolve => process.nextTick(resolve));
    await new Promise(resolve => process.nextTick(resolve));

    expect(MockNotice).toHaveBeenCalledWith(
      expect.stringContaining('re-index'),
      10000
    );
  });

  test('no index found shows first-run guidance Notice', async () => {
    const app = makeApp();
    const plugin = makePlugin({}, app);

    (MockVectorStore as jest.Mock).mockImplementationOnce(function(this: any) {
      this.ensureLoaded = jest.fn().mockResolvedValue(undefined);
      this.exists = jest.fn().mockResolvedValue(false);
    });

    await plugin.onload();
    await new Promise(resolve => process.nextTick(resolve));
    await new Promise(resolve => process.nextTick(resolve));

    expect(MockNotice).toHaveBeenCalledWith(
      expect.stringContaining('No index found'),
      8000
    );
  });

  test('index exists — no first-run Notice shown', async () => {
    const app = makeApp();
    const plugin = makePlugin({}, app);

    // Default mock already has exists returning true

    await plugin.onload();
    await new Promise(resolve => process.nextTick(resolve));
    await new Promise(resolve => process.nextTick(resolve));

    expect(MockNotice).not.toHaveBeenCalled();
  });

  test('autoIndexOnStartup=false: setTimeout not called with 5000ms delay', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const plugin = makePlugin({ autoIndexOnStartup: false });
    await plugin.onload();

    const autoIndexCalls = setTimeoutSpy.mock.calls.filter(
      call => call[1] === 5000
    );
    expect(autoIndexCalls).toHaveLength(0);

    jest.useRealTimers();
    setTimeoutSpy.mockRestore();
  });

  test('autoIndexOnStartup=true: setTimeout called with 5000ms delay', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const plugin = makePlugin({ autoIndexOnStartup: true });
    await plugin.onload();

    const autoIndexCalls = setTimeoutSpy.mock.calls.filter(
      call => call[1] === 5000
    );
    expect(autoIndexCalls).toHaveLength(1);

    jest.useRealTimers();
    setTimeoutSpy.mockRestore();
  });
});

describe('RagPlugin vault event handlers', () => {
  test('vault delete event calls indexManager.removeFile with file path', async () => {
    const vaultEventMap: VaultEventMap = {};
    const app = makeApp(vaultEventMap);
    const plugin = makePlugin({}, app);
    await plugin.onload();

    // Grab the IndexManager instance created during onload
    const indexManagerInstance = MockIndexManager.mock.instances[0];
    const removeFileSpy = indexManagerInstance.removeFile as jest.MockedFunction<any>;

    // Simulate vault 'delete' event
    const fakeFile = {
      path: 'notes/deleted.md',
      name: 'deleted.md',
      extension: 'md',
      basename: 'deleted',
      stat: { mtime: 0, size: 0, ctime: 0 },
    };
    vaultEventMap['delete']?.(fakeFile);
    await new Promise(resolve => process.nextTick(resolve));

    expect(removeFileSpy).toHaveBeenCalledWith('notes/deleted.md');
  });

  test('vault rename event calls indexManager.removeFile with old path', async () => {
    const vaultEventMap: VaultEventMap = {};
    const app = makeApp(vaultEventMap);
    const plugin = makePlugin({}, app);
    await plugin.onload();

    const indexManagerInstance = MockIndexManager.mock.instances[0];
    const removeFileSpy = indexManagerInstance.removeFile as jest.MockedFunction<any>;

    const fakeFile = {
      path: 'notes/new-name.md',
      name: 'new-name.md',
      extension: 'md',
      basename: 'new-name',
      stat: { mtime: 0, size: 0, ctime: 0 },
    };
    vaultEventMap['rename']?.(fakeFile, 'notes/old-name.md');
    await new Promise(resolve => process.nextTick(resolve));

    expect(removeFileSpy).toHaveBeenCalledWith('notes/old-name.md');
  });

  test('vault modify event does NOT call indexCurrentFile when autoIndexOnStartup=false', async () => {
    const vaultEventMap: VaultEventMap = {};
    const app = makeApp(vaultEventMap);
    const plugin = makePlugin({ autoIndexOnStartup: false }, app);
    await plugin.onload();

    const indexManagerInstance = MockIndexManager.mock.instances[0];
    const indexCurrentFileSpy = indexManagerInstance.indexCurrentFile as jest.MockedFunction<any>;

    const fakeFile = {
      path: 'notes/changed.md',
      name: 'changed.md',
      extension: 'md',
      basename: 'changed',
      stat: { mtime: 1000, size: 100, ctime: 0 },
    };
    vaultEventMap['modify']?.(fakeFile);
    await new Promise(resolve => process.nextTick(resolve));

    expect(indexCurrentFileSpy).not.toHaveBeenCalled();
  });

  test('vault modify event calls indexCurrentFile when autoIndexOnStartup=true and file is md', async () => {
    const vaultEventMap: VaultEventMap = {};
    const app = makeApp(vaultEventMap);
    const plugin = makePlugin({ autoIndexOnStartup: true }, app);
    await plugin.onload();

    const indexManagerInstance = MockIndexManager.mock.instances[0];
    const indexCurrentFileSpy = indexManagerInstance.indexCurrentFile as jest.MockedFunction<any>;

    const fakeFile = {
      path: 'notes/changed.md',
      name: 'changed.md',
      extension: 'md',
      basename: 'changed',
      stat: { mtime: 1000, size: 100, ctime: 0 },
    };
    vaultEventMap['modify']?.(fakeFile);
    await new Promise(resolve => process.nextTick(resolve));

    expect(indexCurrentFileSpy).toHaveBeenCalledWith(
      fakeFile,
      expect.objectContaining({ autoIndexOnStartup: true })
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
    expect(plugin.settings.provider).toBe(DEFAULT_SETTINGS.provider);
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
