import { App, Notice, Setting } from 'obsidian';
import { RagSettingTab, DEFAULT_SETTINGS, RagPluginSettings } from '../settings';
import { createEmbedder, createChatProvider } from '../providers/factory';

jest.mock('../providers/factory');

const mockCreateEmbedder = createEmbedder as jest.MockedFunction<typeof createEmbedder>;
const mockCreateChatProvider = createChatProvider as jest.MockedFunction<typeof createChatProvider>;

function makeApp(): App {
  return {
    workspace: { openLinkText: jest.fn() },
    vault: { adapter: { getBasePath: () => '/vault' } },
  } as any;
}
interface MockPlugin {
  settings: RagPluginSettings;
  saveSettings: () => Promise<void>;
  indexAll: () => Promise<void>;
  clearIndex: () => Promise<void>;
  manifest: { dir: string };
  indexScheduler: {
    getStatus: () => {
      indexing: boolean;
      queued: { changes: number; removals: number; fullPass: boolean; clear: boolean };
      lastRun: {
        kind: 'auto' | 'manual' | 'file';
        indexed: number;
        skipped: number;
        failed: number;
        path?: string;
        error?: string;
        finishedAt: number;
      } | null;
    };
  };
  vectorStore: {
    peekStats: () => Promise<{ fileCount: number; chunkCount: number; embeddingModel: string; updatedAt: string } | null>;
  };
}

function makeMockPlugin(settingOverrides: Partial<RagPluginSettings> = {}): MockPlugin {
  return {
    settings: { ...DEFAULT_SETTINGS, ...settingOverrides },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    indexAll: jest.fn().mockResolvedValue(undefined),
    clearIndex: jest.fn().mockResolvedValue(undefined),
    manifest: { dir: '.obsidian/plugins/obsidian-rag' },
    indexScheduler: {
      getStatus: () => ({
        indexing: false,
        queued: { changes: 0, removals: 0, fullPass: false, clear: false },
        lastRun: null,
      }),
    },
    vectorStore: {
      peekStats: () => Promise.resolve({ fileCount: 10, chunkCount: 55, embeddingModel: 'm', updatedAt: new Date().toISOString() }),
    },
  };
}

const mockListModels = () => Promise.resolve([]);

/**
 * Captures all Setting callbacks from a display() call.
 * Each entry records name + handlers for dropdowns, text fields, toggles, buttons.
 */
interface CapturedSetting {
  name?: string;
  onChangeText?: (value: string) => Promise<void>;
  onChangeToggle?: (value: boolean) => Promise<void>;
  onChangeDropdown?: (value: string) => Promise<void>;
  onClickButton?: () => Promise<void>;
}

function captureSettingCallbacks(tab: RagSettingTab): CapturedSetting[] {
  const captured: CapturedSetting[] = [];

  const origSetName = Setting.prototype.setName;
  const origAddDropdown = Setting.prototype.addDropdown;
  const origAddText = Setting.prototype.addText;
  const origAddToggle = Setting.prototype.addToggle;
  const origAddButton = Setting.prototype.addButton;

  const names = new Map<Setting, string>();

  Setting.prototype.setName = function (name: string): any {
    names.set(this, name);
    return this;
  };

  const nameOf = (setting: Setting): string | undefined => names.get(setting);

  Setting.prototype.addDropdown = function (cb: any): any {
    const dropdown = origAddDropdown.call(this, cb);
    cb({ addOption: jest.fn().mockReturnThis(), setValue: jest.fn().mockReturnThis(), onChange: (h: any) => { captured.push({ name: nameOf(this), onChangeDropdown: h }); return this; } } as any);
    return dropdown;
  };

  Setting.prototype.addText = function (cb: any): any {
    const text = origAddText.call(this, cb);
    cb({ setValue: jest.fn().mockReturnThis(), setPlaceholder: jest.fn().mockReturnThis(), onChange: (h: any) => { captured.push({ name: nameOf(this), onChangeText: h }); return this; } } as any);
    return text;
  };

  Setting.prototype.addToggle = function (cb: any): any {
    const toggle = origAddToggle.call(this, cb);
    cb({ setValue: jest.fn().mockReturnThis(), onChange: (h: any) => { captured.push({ name: nameOf(this), onChangeToggle: h }); return this; } } as any);
    return toggle;
  };

  Setting.prototype.addButton = function (cb: any): any {
    const btn = origAddButton.call(this, cb);
    cb({ setButtonText: jest.fn().mockReturnThis(), onClick: (h: any) => { captured.push({ name: nameOf(this), onClickButton: h }); return this; } } as any);
    return btn;
  };

  tab.display();

  Setting.prototype.setName = origSetName;
  Setting.prototype.addDropdown = origAddDropdown;
  Setting.prototype.addText = origAddText;
  Setting.prototype.addToggle = origAddToggle;
  Setting.prototype.addButton = origAddButton;

  return captured;
}

function byName(captured: CapturedSetting[], name: string): CapturedSetting {
  const found = captured.find(c => c.name === name);
  if (!found) throw new Error(`Setting '${name}' not found`);
  return found;
}

describe('RagSettingTab', () => {
  let mockApp: App;
  let mockPlugin: MockPlugin;
  let tab: RagSettingTab;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = makeApp();
    mockPlugin = makeMockPlugin();
    tab = new RagSettingTab(mockApp, mockPlugin);
    mockCreateEmbedder.mockReturnValue({ listModels: mockListModels } as any);
    mockCreateChatProvider.mockReturnValue({ listModels: mockListModels } as any);
  });

  test('display: renders without throwing', () => {
    expect(() => tab.display()).not.toThrow();
  });

  test('display: calls containerEl.empty() to clear before rendering', () => {
    tab.display();
    expect(tab.containerEl.empty).toHaveBeenCalled();
  });

  test('display: calls containerEl.createEl to build headings', () => {
    tab.display();
    expect(tab.containerEl.createEl).toHaveBeenCalled();
  });

  test('embedding provider dropdown onChange with "lmstudio": updates provider and base URL', async () => {
    const settings = captureSettingCallbacks(tab);
    const dd = byName(settings, 'Embedding Provider');

    await dd.onChangeDropdown!('lmstudio');

    expect(mockPlugin.settings.embeddingProvider).toBe('lmstudio');
    expect(mockPlugin.settings.embeddingBaseUrl).toBe('http://localhost:1234');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('embedding provider dropdown onChange with "onnx": switches provider and resets a server model to the default ONNX model', async () => {
    mockPlugin.settings.embeddingModel = 'nomic-embed-text';
    const settings = captureSettingCallbacks(tab);
    const dd = byName(settings, 'Embedding Provider');

    await dd.onChangeDropdown!('onnx');

    expect(mockPlugin.settings.embeddingProvider).toBe('onnx');
    expect(mockPlugin.settings.embeddingModel).toBe('Xenova/all-MiniLM-L6-v2');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('embedding provider dropdown onChange with "onnx": keeps an already-curated ONNX model', async () => {
    mockPlugin.settings.embeddingModel = 'Xenova/bge-small-en-v1.5';
    const settings = captureSettingCallbacks(tab);
    const dd = byName(settings, 'Embedding Provider');

    await dd.onChangeDropdown!('onnx');

    expect(mockPlugin.settings.embeddingModel).toBe('Xenova/bge-small-en-v1.5');
  });

  test('embedding base URL is hidden and ONNX info shown when the provider is onnx', () => {
    mockPlugin.settings.embeddingProvider = 'onnx';
    const names = new Set<string>();
    const origSetName = Setting.prototype.setName;
    (Setting.prototype as any).setName = function (name: string): any {
      names.add(name);
      return origSetName.call(this, name);
    };
    tab.display();
    (Setting.prototype as any).setName = origSetName;

    expect(names.has('Embedding Base URL')).toBe(false);
    expect(names.has('ONNX Model Info')).toBe(true);
    expect(names.has('Embedding Model')).toBe(true);
  });

  test('ONNX device dropdown onChange: updates settings.onnxDevice and saves', async () => {
    mockPlugin.settings.embeddingProvider = 'onnx';
    const settings = captureSettingCallbacks(tab);
    const dd = byName(settings, 'ONNX Device');

    await dd.onChangeDropdown!('coreml');

    expect(mockPlugin.settings.onnxDevice).toBe('coreml');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('chat provider dropdown onChange with "cli": switches chat role only', async () => {
    const settings = captureSettingCallbacks(tab);
    const dd = byName(settings, 'Chat Provider');

    await dd.onChangeDropdown!('cli');

    expect(mockPlugin.settings.chatProvider).toBe('cli');
    expect(mockPlugin.settings.embeddingProvider).toBe('ollama');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('CLI preset dropdown onChange with "omp": fills the command template with omp flags', async () => {
    mockPlugin.settings.chatProvider = 'cli';
    const settings = captureSettingCallbacks(tab);
    const dd = byName(settings, 'CLI Preset');

    await dd.onChangeDropdown!('omp');

    expect(mockPlugin.settings.cliPreset).toBe('omp');
    expect(mockPlugin.settings.cliTemplate).toContain('-p');
    expect(mockPlugin.settings.cliTemplate).toContain('{prompt}');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('CLI command: rendered as a multi-line textarea, not a single-line text input', () => {
    mockPlugin.settings.chatProvider = 'cli';
    const settingsByName = new Map<string, any>();
    const origSetName = Setting.prototype.setName;
    (Setting.prototype as any).setName = function (name: string): any {
      settingsByName.set(name, this);
      return origSetName.call(this, name);
    };
    tab.display();
    (Setting.prototype as any).setName = origSetName;

    const cliSetting = settingsByName.get('CLI Command');
    expect(cliSetting).toBeDefined();
    const createElCalls: Array<[string, any]> = cliSetting.controlEl.createEl.mock.calls;
    const textareaCall = createElCalls.find(([tag]) => tag === 'textarea');
    const inputCall = createElCalls.find(([tag]) => tag === 'input');
    expect(textareaCall).toBeDefined();
    expect(textareaCall![1].cls).toContain('rag-cli-template');
    expect(inputCall).toBeUndefined();
    // The field is stacked on its own row — as a flex-row child, Obsidian's
    // settings layout collapses a bare textarea to min-content (~1 char).
    expect(cliSetting.settingEl.classes).toContain('rag-cli-row');
    // The saved template is loaded into the field
    const textareaEl = cliSetting.controlEl.createEl.mock.results.find(
      (r: any, i: number) => createElCalls[i][0] === 'textarea'
    )!.value;
    expect(textareaEl.value).toBe(mockPlugin.settings.cliTemplate);
  });

  test('CLI command textarea: change event updates cliTemplate and saves', async () => {
    mockPlugin.settings.chatProvider = 'cli';
    const settingsByName = new Map<string, any>();
    const origSetName = Setting.prototype.setName;
    (Setting.prototype as any).setName = function (name: string): any {
      settingsByName.set(name, this);
      return origSetName.call(this, name);
    };
    tab.display();
    (Setting.prototype as any).setName = origSetName;

    const cliSetting = settingsByName.get('CLI Command');
    const createElCalls: Array<[string, any]> = cliSetting.controlEl.createEl.mock.calls;
    const idx = createElCalls.findIndex(([tag]) => tag === 'textarea');
    const textareaEl = cliSetting.controlEl.createEl.mock.results[idx].value;

    textareaEl.value = 'omp -p --mode json --no-session --model gpt5 {prompt}';
    const changeHandler = textareaEl.addEventListener.mock.calls.find(
      (c: any[]) => c[0] === 'change'
    )![1];
    await changeHandler();

    expect(mockPlugin.settings.cliTemplate).toBe('omp -p --mode json --no-session --model gpt5 {prompt}');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('CLI command is hidden when chat provider is not cli', () => {
    const settings = captureSettingCallbacks(tab);
    expect(byName(settings, 'Chat Base URL').onChangeText).toBeDefined();
    expect(settings.some(c => c.name === 'CLI Command')).toBe(false);
  });

  test('Test Connection: pings and embeds with the embedder, pings the chat provider', async () => {
    const mockEmbedder = {
      ping: jest.fn().mockResolvedValue({ reachable: true, latencyMs: 10 }),
      embed: jest.fn().mockResolvedValue({ embeddings: [[0.1, 0.2]], dimension: 2 }),
      listModels: mockListModels,
    };
    const mockChat = {
      ping: jest.fn().mockResolvedValue({ reachable: true, latencyMs: 20 }),
      listModels: mockListModels,
    };
    mockCreateEmbedder.mockReturnValue(mockEmbedder as any);
    mockCreateChatProvider.mockReturnValue(mockChat as any);

    const settings = captureSettingCallbacks(tab);
    const btn = byName(settings, 'Test Connection');

    await btn.onClickButton!();

    expect(mockEmbedder.ping).toHaveBeenCalledTimes(1);
    expect(mockEmbedder.embed).toHaveBeenCalledWith(['test']);
    expect(mockChat.ping).toHaveBeenCalledTimes(1);
  });

  test('Test Connection: surfaces the parsed CLI round-trip reply', async () => {
    const mockEmbedder = {
      ping: jest.fn().mockResolvedValue({ reachable: false, latencyMs: 0, errorMessage: 'down' }),
      embed: jest.fn(),
      listModels: mockListModels,
    };
    const mockChat = {
      ping: jest.fn().mockResolvedValue({ reachable: true, latencyMs: 55, sampleResponse: 'PONG' }),
      listModels: mockListModels,
    };
    mockCreateEmbedder.mockReturnValue(mockEmbedder as any);
    mockCreateChatProvider.mockReturnValue(mockChat as any);

    const settings = captureSettingCallbacks(tab);
    const btn = byName(settings, 'Test Connection');

    await btn.onClickButton!();

    const messages = (Notice as unknown as jest.Mock).mock.calls
      .map((c: unknown[]) => c[0] as string);
    expect(messages.some(m => m.includes('parsed reply: PONG'))).toBe(true);
    expect(messages.some(m => m.includes('Embeddings: provider not reachable'))).toBe(true);
  });

  test('embedding base URL text onChange: updates settings.embeddingBaseUrl and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const text = byName(settings, 'Embedding Base URL');

    await text.onChangeText!('http://localhost:8080');

    expect(mockPlugin.settings.embeddingBaseUrl).toBe('http://localhost:8080');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('embedding API key text onChange: updates settings.embeddingApiKey and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const text = byName(settings, 'Embedding API Key');

    await text.onChangeText!('sk-embed-123');

    expect(mockPlugin.settings.embeddingApiKey).toBe('sk-embed-123');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('chat base URL text onChange: updates settings.chatBaseUrl and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const text = byName(settings, 'Chat Base URL');

    await text.onChangeText!('http://localhost:9999');

    expect(mockPlugin.settings.chatBaseUrl).toBe('http://localhost:9999');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('chat API key text onChange: updates settings.chatApiKey and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const text = byName(settings, 'Chat API Key');

    await text.onChangeText!('sk-chat-456');

    expect(mockPlugin.settings.chatApiKey).toBe('sk-chat-456');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('streaming toggle onChange: updates settings.streamingEnabled and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const toggle = byName(settings, 'Enable Streaming');

    await toggle.onChangeToggle!(false);

    expect(mockPlugin.settings.streamingEnabled).toBe(false);
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('autoIndex toggle onChange: updates settings.autoIndexOnStartup and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const toggle = byName(settings, 'Auto-index on Startup');

    await toggle.onChangeToggle!(true);

    expect(mockPlugin.settings.autoIndexOnStartup).toBe(true);
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('topK text onChange: updates settings.topK for valid number', async () => {
    const settings = captureSettingCallbacks(tab);
    const text = byName(settings, 'Top K Results');

    await text.onChangeText!('10');

    expect(mockPlugin.settings.topK).toBe(10);
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('topK text onChange: ignores invalid value (NaN), does not save', async () => {
    const settings = captureSettingCallbacks(tab);
    const text = byName(settings, 'Top K Results');
    const originalTopK = mockPlugin.settings.topK;

    await text.onChangeText!('abc');

    expect(mockPlugin.settings.topK).toBe(originalTopK);
    expect(mockPlugin.saveSettings).not.toHaveBeenCalled();
  });

  test('chunkSize text onChange: updates settings.chunkSize for valid number', async () => {
    const settings = captureSettingCallbacks(tab);
    const text = byName(settings, 'Chunk Size');

    await text.onChangeText!('750');

    expect(mockPlugin.settings.chunkSize).toBe(750);
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('Test Connection: releases the embedder worker after the round-trip', async () => {
    const dispose = jest.fn().mockResolvedValue(undefined);
    const mockEmbedder = {
      ping: jest.fn().mockResolvedValue({ reachable: true, latencyMs: 10 }),
      embed: jest.fn().mockResolvedValue({ embeddings: [[0.1]], dimension: 1 }),
      listModels: mockListModels,
      dispose,
    };
    // First call = embedding model dropdown; second = the Test button's embedder.
    mockCreateEmbedder.mockReturnValueOnce({ listModels: mockListModels } as any);
    mockCreateEmbedder.mockReturnValue(mockEmbedder as any);

    const settings = captureSettingCallbacks(tab);
    const btn = byName(settings, 'Test Connection');

    await btn.onClickButton!();

    expect(mockEmbedder.embed).toHaveBeenCalledWith(['test']);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('Test Connection: releases the embedder worker even when the round-trip fails', async () => {
    const dispose = jest.fn().mockResolvedValue(undefined);
    const mockEmbedder = {
      ping: jest.fn().mockResolvedValue({ reachable: true, latencyMs: 10 }),
      embed: jest.fn().mockRejectedValue(new Error('boom')),
      listModels: mockListModels,
      dispose,
    };
    mockCreateEmbedder.mockReturnValueOnce({ listModels: mockListModels } as any);
    mockCreateEmbedder.mockReturnValue(mockEmbedder as any);

    const settings = captureSettingCallbacks(tab);
    const btn = byName(settings, 'Test Connection');

    await btn.onClickButton!();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('Index Status: Clear button routes through plugin.clearIndex (serial queue), not the store directly', async () => {
    const originalConfirm = (globalThis as any).confirm;
    (globalThis as any).confirm = jest.fn().mockReturnValue(true);
    try {
      const settings = captureSettingCallbacks(tab);
      const btn = byName(settings, 'Index Status');

      await btn.onClickButton!();

      expect(mockPlugin.clearIndex).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as any).confirm = originalConfirm;
    }
  });

  const summary = () => (tab as any).indexStatusSummary() as Promise<string>;

  test('Index Status: summary shows an in-flight run first', async () => {
    mockPlugin.indexScheduler = {
      getStatus: () => ({
        indexing: true,
        queued: { changes: 0, removals: 0, fullPass: false, clear: false },
        lastRun: null,
      }),
    };
    expect(await summary()).toContain('Indexing in progress');
  });

  test('Index Status: summary lists queued work when nothing is running', async () => {
    mockPlugin.indexScheduler = {
      getStatus: () => ({
        indexing: false,
        queued: { changes: 3, removals: 1, fullPass: true, clear: false },
        lastRun: null,
      }),
    };
    expect(await summary()).toBe(
      'Queued (runs after the quiet window): full re-index, 3 changed files, 1 removal.'
    );
  });

  test('Index Status: summary reports up-to-date with the last completed run', async () => {
    mockPlugin.indexScheduler = {
      getStatus: () => ({
        indexing: false,
        queued: { changes: 0, removals: 0, fullPass: false, clear: false },
        lastRun: { kind: 'manual', indexed: 2, skipped: 5, failed: 0, finishedAt: Date.now() - 60000 },
      }),
    };
    const text = await summary();
    expect(text).toContain('Index is up to date — 10 files, 55 chunks');
    expect(text).toContain('2 indexed, 5 skipped');
  });

  test('Index Status: summary reports a failed last run', async () => {
    mockPlugin.indexScheduler = {
      getStatus: () => ({
        indexing: false,
        queued: { changes: 0, removals: 0, fullPass: false, clear: false },
        lastRun: { kind: 'auto', indexed: 0, skipped: 0, failed: 0, error: 'boom', finishedAt: Date.now() - 60000 },
      }),
    };
    const text = await summary();
    expect(text).toContain('Index is up to date — 10 files, 55 chunks');
    expect(text).toContain('failed: boom');
  });

  test('Index Status: summary offers Re-index when no index exists', async () => {
    mockPlugin.vectorStore = {
      peekStats: () => Promise.resolve(null),
    };
    expect(await summary()).toBe('No index yet — run Re-index to build one.');
  });

  test('Index Status: summary treats an empty index as no index', async () => {
    mockPlugin.vectorStore = {
      peekStats: () => Promise.resolve({ fileCount: 0, chunkCount: 0, embeddingModel: 'm', updatedAt: new Date().toISOString() }),
    };
    expect(await summary()).toBe('No index yet — run Re-index to build one.');
  });

});
