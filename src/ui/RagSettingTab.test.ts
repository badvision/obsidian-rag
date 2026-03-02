import { App, Setting } from 'obsidian';
import { RagSettingTab, DEFAULT_SETTINGS, RagPluginSettings } from '../settings';
import { createProvider } from '../providers/factory';

jest.mock('../providers/factory');

const mockCreateProvider = createProvider as jest.MockedFunction<typeof createProvider>;

function makeApp(): App {
  return {
    workspace: { openLinkText: jest.fn() },
    vault: {},
  } as any;
}

function makeMockPlugin(settingOverrides: Partial<RagPluginSettings> = {}) {
  return {
    settings: { ...DEFAULT_SETTINGS, ...settingOverrides },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    manifest: { dir: '.obsidian/plugins/obsidian-rag' },
    vectorStore: { clear: jest.fn().mockResolvedValue(undefined) },
  };
}

/**
 * Captures all Setting callbacks from a display() call.
 * Each entry records name + handlers for dropdowns, text fields, toggles, buttons.
 */
interface CapturedSetting {
  onChangeText?: (value: string) => Promise<void>;
  onChangeToggle?: (value: boolean) => Promise<void>;
  onChangeDropdown?: (value: string) => Promise<void>;
  onClickButton?: () => Promise<void>;
}

function captureSettingCallbacks(tab: RagSettingTab): CapturedSetting[] {
  const captured: CapturedSetting[] = [];

  const origAddDropdown = Setting.prototype.addDropdown;
  const origAddText = Setting.prototype.addText;
  const origAddToggle = Setting.prototype.addToggle;
  const origAddButton = Setting.prototype.addButton;

  Setting.prototype.addDropdown = function(cb: any): any {
    const current: CapturedSetting = {};
    captured.push(current);
    const dd: any = {
      addOption: () => dd,
      setValue: () => dd,
      onChange: (fn: (v: string) => Promise<void>) => {
        current.onChangeDropdown = fn;
        return dd;
      },
    };
    cb(dd);
    return this;
  };

  Setting.prototype.addText = function(cb: any): any {
    const current: CapturedSetting = {};
    captured.push(current);
    const text: any = {
      setValue: () => text,
      onChange: (fn: (v: string) => Promise<void>) => {
        current.onChangeText = fn;
        return text;
      },
    };
    cb(text);
    return this;
  };

  Setting.prototype.addToggle = function(cb: any): any {
    const current: CapturedSetting = {};
    captured.push(current);
    const toggle: any = {
      setValue: () => toggle,
      onChange: (fn: (v: boolean) => Promise<void>) => {
        current.onChangeToggle = fn;
        return toggle;
      },
    };
    cb(toggle);
    return this;
  };

  Setting.prototype.addButton = function(cb: any): any {
    const current: CapturedSetting = {};
    captured.push(current);
    const btn: any = {
      setButtonText: () => btn,
      onClick: (fn: () => Promise<void>) => {
        current.onClickButton = fn;
        return btn;
      },
      disabled: false,
    };
    cb(btn);
    return this;
  };

  tab.display();

  Setting.prototype.addDropdown = origAddDropdown;
  Setting.prototype.addText = origAddText;
  Setting.prototype.addToggle = origAddToggle;
  Setting.prototype.addButton = origAddButton;

  return captured;
}

describe('RagSettingTab', () => {
  let mockApp: App;
  let mockPlugin: ReturnType<typeof makeMockPlugin>;
  let tab: RagSettingTab;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = makeApp();
    mockPlugin = makeMockPlugin();
    tab = new RagSettingTab(mockApp, mockPlugin);
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

  test('provider dropdown onChange with "lmstudio": updates provider and baseUrl', async () => {
    const settings = captureSettingCallbacks(tab);
    const dropdowns = settings.filter(s => s.onChangeDropdown !== undefined);
    expect(dropdowns.length).toBeGreaterThan(0);

    await dropdowns[0].onChangeDropdown!('lmstudio');

    expect(mockPlugin.settings.provider).toBe('lmstudio');
    expect(mockPlugin.settings.baseUrl).toBe('http://localhost:1234');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('provider dropdown onChange with "ollama": updates baseUrl to 11434', async () => {
    mockPlugin.settings.provider = 'lmstudio';
    mockPlugin.settings.baseUrl = 'http://localhost:1234';

    const settings = captureSettingCallbacks(tab);
    const dropdowns = settings.filter(s => s.onChangeDropdown !== undefined);

    await dropdowns[0].onChangeDropdown!('ollama');

    expect(mockPlugin.settings.provider).toBe('ollama');
    expect(mockPlugin.settings.baseUrl).toBe('http://localhost:11434');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('Test Connection button: calls provider.ping() and provider.embed()', async () => {
    const mockProvider = {
      ping: jest.fn().mockResolvedValue({ reachable: true, latencyMs: 42 }),
      embed: jest.fn().mockResolvedValue({ embeddings: [[0.1, 0.2]], dimension: 768 }),
    };
    mockCreateProvider.mockReturnValue(mockProvider as any);

    const settings = captureSettingCallbacks(tab);
    const buttons = settings.filter(s => s.onClickButton !== undefined);
    expect(buttons.length).toBeGreaterThan(0);

    await buttons[0].onClickButton!();

    expect(mockCreateProvider).toHaveBeenCalledWith(mockPlugin.settings);
    expect(mockProvider.ping).toHaveBeenCalledTimes(1);
    expect(mockProvider.embed).toHaveBeenCalledWith(['test']);
  });

  test('Test Connection button: does not call embed when ping not reachable', async () => {
    const mockProvider = {
      ping: jest.fn().mockResolvedValue({ reachable: false, latencyMs: 0, errorMessage: 'refused' }),
      embed: jest.fn(),
    };
    mockCreateProvider.mockReturnValue(mockProvider as any);

    const settings = captureSettingCallbacks(tab);
    const buttons = settings.filter(s => s.onClickButton !== undefined);

    await buttons[0].onClickButton!();

    expect(mockProvider.embed).not.toHaveBeenCalled();
  });

  test('base URL text onChange: updates settings.baseUrl and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    // Text fields in display order: baseUrl(0), chatModel(1), embeddingModel(2), topK(3), chunkSize(4)
    const texts = settings.filter(s => s.onChangeText !== undefined);
    expect(texts.length).toBeGreaterThanOrEqual(1);

    await texts[0].onChangeText!('http://localhost:8080');

    expect(mockPlugin.settings.baseUrl).toBe('http://localhost:8080');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('chatModel text onChange: updates settings.chatModel and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const texts = settings.filter(s => s.onChangeText !== undefined);

    await texts[1].onChangeText!('mistral');

    expect(mockPlugin.settings.chatModel).toBe('mistral');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('embeddingModel text onChange: updates settings.embeddingModel and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const texts = settings.filter(s => s.onChangeText !== undefined);

    await texts[2].onChangeText!('mxbai-embed-large');

    expect(mockPlugin.settings.embeddingModel).toBe('mxbai-embed-large');
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('streaming toggle onChange: updates settings.streamingEnabled and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const toggles = settings.filter(s => s.onChangeToggle !== undefined);
    expect(toggles.length).toBeGreaterThan(0);

    await toggles[0].onChangeToggle!(false);

    expect(mockPlugin.settings.streamingEnabled).toBe(false);
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('autoIndex toggle onChange: updates settings.autoIndexOnStartup and saves', async () => {
    const settings = captureSettingCallbacks(tab);
    const toggles = settings.filter(s => s.onChangeToggle !== undefined);
    expect(toggles.length).toBeGreaterThanOrEqual(2);

    await toggles[1].onChangeToggle!(true);

    expect(mockPlugin.settings.autoIndexOnStartup).toBe(true);
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('topK text onChange: updates settings.topK for valid number', async () => {
    const settings = captureSettingCallbacks(tab);
    // Text fields: baseUrl(0), chatModel(1), embeddingModel(2), topK(3), chunkSize(4)
    const texts = settings.filter(s => s.onChangeText !== undefined);

    await texts[3].onChangeText!('10');

    expect(mockPlugin.settings.topK).toBe(10);
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });

  test('topK text onChange: ignores invalid value (NaN), does not save', async () => {
    const settings = captureSettingCallbacks(tab);
    const texts = settings.filter(s => s.onChangeText !== undefined);
    const originalTopK = mockPlugin.settings.topK;

    await texts[3].onChangeText!('abc');

    expect(mockPlugin.settings.topK).toBe(originalTopK);
    expect(mockPlugin.saveSettings).not.toHaveBeenCalled();
  });

  test('chunkSize text onChange: updates settings.chunkSize for valid number', async () => {
    const settings = captureSettingCallbacks(tab);
    const texts = settings.filter(s => s.onChangeText !== undefined);

    await texts[4].onChangeText!('750');

    expect(mockPlugin.settings.chunkSize).toBe(750);
    expect(mockPlugin.saveSettings).toHaveBeenCalled();
  });
});
