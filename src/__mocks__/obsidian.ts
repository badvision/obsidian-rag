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
  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(cb: (text: any) => any): this { cb({ setValue: jest.fn().mockReturnThis(), onChange: jest.fn().mockReturnThis(), inputEl: {} }); return this; }
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
