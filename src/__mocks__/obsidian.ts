// Minimal mock of Obsidian APIs used by this plugin

function makeMockElement(): any {
  const el: any = {
    createEl: jest.fn((_tag: string, _opts?: any) => makeMockElement()),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    querySelector: jest.fn((_selector: string) => makeMockElement()),
    empty: jest.fn(),
    setText: jest.fn(),
    appendChild: jest.fn(),
    textContent: '',
    style: { display: '', width: '' },
    disabled: false,
    value: '',
    className: '',
    classes: [] as string[],
    addClass(cls: string) {
      this.classes.push(cls);
    },
  };
  return el;
}

export class Plugin {
  app: App;
  manifest: any;
  constructor(app: App, manifest: any) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData(): Promise<any> { return {}; }
  async saveData(_data: any): Promise<void> {}
  addCommand(command: any): any { return command; }
  addSettingTab(_tab: any): void {}
  addRibbonIcon(_icon: string, _title: string, _cb: () => void): any { return {}; }
  registerView(_type: string, _factory: any): any { return { id: _type }; }
  registerEvent(event: any): any { return event; }
}

export class Modal {
  app: App;
  contentEl: any;
  constructor(app: App) {
    this.app = app;
    this.contentEl = makeMockElement();
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class ItemView {
  leaf: any;
  containerEl: any;
  constructor(leaf: any) {
    this.leaf = leaf;
    this.containerEl = makeMockElement();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class PluginSettingTab {
  app: App;
  plugin: any;
  containerEl: any;
  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeMockElement();
  }
  display(): void {}
}

export class Setting {
  controlEl: any;
  settingEl: any;
  constructor(_containerEl: HTMLElement) { this.controlEl = makeMockElement(); this.settingEl = makeMockElement(); }
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(cb: (text: any) => any): this { cb({ setValue: jest.fn().mockReturnThis(), setPlaceholder: jest.fn().mockReturnThis(), onChange: jest.fn().mockReturnThis(), inputEl: {} }); return this; }
  addDropdown(cb: (dd: any) => any): this { cb({ addOption: jest.fn().mockReturnThis(), setValue: jest.fn().mockReturnThis(), onChange: jest.fn().mockReturnThis() }); return this; }
  addToggle(cb: (t: any) => any): this { cb({ setValue: jest.fn().mockReturnThis(), onChange: jest.fn().mockReturnThis() }); return this; }
  addSlider(cb: (s: any) => any): this { cb({ setLimits: jest.fn().mockReturnThis(), setValue: jest.fn().mockReturnThis(), onChange: jest.fn().mockReturnThis(), setDynamicTooltip: jest.fn().mockReturnThis() }); return this; }
  addButton(cb: (b: any) => any): this { cb({ setButtonText: jest.fn().mockReturnThis(), onClick: jest.fn().mockReturnThis(), setCta: jest.fn().mockReturnThis(), disabled: false }); return this; }
  addTextArea(cb: (t: any) => any): this { cb({ setValue: jest.fn().mockReturnThis(), onChange: jest.fn().mockReturnThis() }); return this; }
}

export const Notice = jest.fn().mockImplementation((_message: string, _duration?: number) => {});

export interface App {
  vault: Vault;
  workspace: Workspace;
}

export interface Vault {
  getFiles(): TFile[];
  read(file: TFile): Promise<string>;
  readBinary(file: TFile): Promise<ArrayBuffer>;
  adapter: {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    getBasePath(): string;
  };
  on(event: string, callback: (...args: any[]) => any): any;
}

export interface Workspace {
  openLinkText(linkText: string, sourcePath: string, newLeaf?: boolean): Promise<void>;
  getActiveFile(): TFile | null;
  on(event: string, callback: (...args: any[]) => any): any;
}

export interface TAbstractFile {
  path: string;
  name: string;
}

export interface TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };
}

export function loadPdfJs(): Promise<any> {
  return Promise.resolve({});
}

export interface RequestUrlOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}

export interface RequestUrlResponse {
  data: string;
  json: unknown;
  text: string;
  status: number;
}

/**
 * Delegates to globalThis.fetch so tests can mock the network layer there.
 * Mirrors Obsidian semantics: non-2xx throws unless throw:false.
 */
export async function requestUrl(opts: RequestUrlOptions): Promise<RequestUrlResponse> {
  const res = await fetch(opts.url, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok && opts.throw !== false) {
    throw new Error(`Request to ${opts.url} failed with status ${res.status}`);
  }
  return { data: text, json, text, status: res.status };
}
