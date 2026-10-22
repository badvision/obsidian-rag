import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import { join } from 'path';
import type { FileSystemAdapter } from 'obsidian';
import { createEmbedder, createChatProvider } from './providers/factory';
import {
  CliPreset,
  CLI_PRESETS,
  CLI_TOKENS,
  applyCliPreset,
} from './providers/cli';
import { ONNX_MODELS, DEFAULT_ONNX_MODEL } from './providers/onnx';

export type EmbeddingProviderName = 'ollama' | 'lmstudio' | 'onnx';
export type ChatProviderName = 'ollama' | 'lmstudio' | 'cli';

export interface RagPluginSettings {
  // Embedding role — powers indexing and semantic search
  embeddingProvider: EmbeddingProviderName;
  embeddingBaseUrl: string;
  embeddingModel: string;
  onnxDevice: 'cpu' | 'coreml';
  // Chat role — generates answers
  chatProvider: ChatProviderName;
  chatBaseUrl: string;
  chatModel: string;
  cliPreset: CliPreset;
  cliTemplate: string;
  // Retrieval / index
  topK: number;
  chunkSize: number;
  chunkOverlap: number;
  indexScope: 'pdfs-only' | 'pdfs-and-notes';
  streamingEnabled: boolean;
  autoIndexOnStartup: boolean;
  indexVersion: number;
  embeddingDimension: number;
}

export const DEFAULT_SETTINGS: RagPluginSettings = {
  embeddingProvider: 'ollama',
  embeddingBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  onnxDevice: 'cpu',
  chatProvider: 'ollama',
  chatBaseUrl: 'http://localhost:11434',
  chatModel: 'llama3.2',
  cliPreset: 'opencode',
  cliTemplate: CLI_PRESETS.opencode,
  topK: 20,
  chunkSize: 500,
  chunkOverlap: 50,
  indexScope: 'pdfs-and-notes',
  streamingEnabled: true,
  autoIndexOnStartup: false,
  indexVersion: 1,
  embeddingDimension: 0,
};

/**
 * Migrate settings saved by 0.1.x, which used a single provider for both
 * roles ({ provider, baseUrl }). Both roles now select independently.
 */
export function migrateLegacySettings(raw: Record<string, unknown> | null): Record<string, unknown> {
  if (!raw) return {};
  const result: Record<string, unknown> = { ...raw };
  if (raw.provider !== undefined && raw.embeddingProvider === undefined && raw.chatProvider === undefined) {
    result.embeddingProvider = raw.provider;
    result.chatProvider = raw.provider;
    if (raw.baseUrl !== undefined) {
      if (result.embeddingBaseUrl === undefined) result.embeddingBaseUrl = raw.baseUrl;
      if (result.chatBaseUrl === undefined) result.chatBaseUrl = raw.baseUrl;
    }
    delete result.provider;
    delete result.baseUrl;
  }
  return result;
}

const EMBEDDER_DEFAULT_URL: Record<EmbeddingProviderName, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  onnx: '',
};

const CHATTER_DEFAULT_URL: Record<Exclude<ChatProviderName, 'cli'>, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
};

/** Minimal surface of the plugin the settings tab needs. */
export interface SettingTabPlugin {
  settings: RagPluginSettings;
  saveSettings: () => Promise<void>;
  indexAll: () => Promise<void>;
  manifest: { dir?: string };
  vectorStore?: { clear: (embeddingModel: string) => Promise<void> };
}

export class RagSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SettingTabPlugin) {
    super(app, plugin as unknown as Plugin); // base class requires Plugin; tab only uses the SettingTabPlugin surface
  }

  private addModelDropdown(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    provider: { listModels(): Promise<string[]> },
    getValue: () => string,
    setValue: (v: string) => Promise<void>
  ): void {
    const setting = new Setting(containerEl).setName(name).setDesc(desc);

    const select = setting.controlEl.createEl('select', { cls: 'dropdown' });
    const loadingOpt = select.createEl('option', { text: 'Loading models…', value: '' });
    loadingOpt.disabled = true;
    // Show current saved value immediately while loading
    const currentOpt = select.createEl('option', { text: getValue(), value: getValue() });
    currentOpt.selected = true;

    select.addEventListener('change', async () => {
      if (select.value) await setValue(select.value);
    });

    provider.listModels().then(models => {
      select.empty();
      if (models.length === 0) {
        select.createEl('option', { text: '(provider unreachable — type manually)', value: getValue() }).selected = true;
        select.disabled = true;
        // Fall back to a text input
        const input = setting.controlEl.createEl('input', { type: 'text', cls: 'rag-model-text-input' });
        input.value = getValue();
        input.addEventListener('change', async () => { await setValue(input.value.trim()); });
        select.style.display = 'none';
        return;
      }
      // Ensure current value is in list (user may have a custom/unlisted model)
      const allModels = models.includes(getValue()) ? models : [getValue(), ...models];
      allModels.forEach(m => {
        const opt = select.createEl('option', { text: m, value: m });
        if (m === getValue()) opt.selected = true;
      });
    }).catch(() => {
      select.empty();
      select.createEl('option', { text: getValue(), value: getValue() }).selected = true;
    });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'RAG Plugin Settings' });

    // --- Embedding provider ---
    containerEl.createEl('h3', { text: 'Embeddings' });

    new Setting(containerEl)
      .setName('Embedding Provider')
      .setDesc('Provider used to build the semantic index')
      .addDropdown(dd => dd
        .addOption('ollama', 'Ollama')
        .addOption('lmstudio', 'LM Studio / MLX')
        .addOption('onnx', 'Self-hosted ONNX (in-process, no server)')
        .setValue(this.plugin.settings.embeddingProvider)
        .onChange(async (value: string) => {
          this.plugin.settings.embeddingProvider = value as EmbeddingProviderName;
          this.plugin.settings.embeddingBaseUrl = EMBEDDER_DEFAULT_URL[value as EmbeddingProviderName];
          if (value === 'onnx' && !ONNX_MODELS[this.plugin.settings.embeddingModel]) {
            this.plugin.settings.embeddingModel = DEFAULT_ONNX_MODEL;
          }
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.embeddingProvider !== 'onnx') {
      new Setting(containerEl)
        .setName('Embedding Base URL')
        .setDesc('Embedding provider endpoint URL')
        .addText(text => text
          .setValue(this.plugin.settings.embeddingBaseUrl)
          .onChange(async (value: string) => {
            this.plugin.settings.embeddingBaseUrl = value;
            await this.plugin.saveSettings();
          })
        );
    }

    this.addModelDropdown(
      containerEl,
      'Embedding Model',
      'Model for embeddings — changing this requires a full re-index',
      createEmbedder(this.plugin.settings, join(
        (this.app.vault.adapter as FileSystemAdapter).getBasePath(), this.plugin.manifest?.dir ?? ''
      )),
      () => this.plugin.settings.embeddingModel,
      async (v) => { this.plugin.settings.embeddingModel = v; await this.plugin.saveSettings(); }
    );

    if (this.plugin.settings.embeddingProvider === 'onnx') {
      new Setting(containerEl)
        .setName('ONNX Model Info')
        .setDesc(
          `Model downloads on first use (~20-130 MB) and is cached at ` +
          `${this.plugin.manifest?.dir ?? '.obsidian/plugins/obsidian-rag'}/models/. ` +
          'No server or network needed afterwards. Runs inside Obsidian — first use of a model takes a few seconds.'
        );
      new Setting(containerEl)
        .setName('ONNX Device')
        .setDesc(
          'Where inference runs. CoreML uses Apple Silicon (GPU/ANE) and is much faster; ' +
          'if a model is unsupported there it automatically falls back to CPU.'
        )
        .addDropdown(dd => dd
          .addOption('cpu', 'CPU (safe, portable)')
          .addOption('coreml', 'CoreML — Apple GPU/ANE (faster)')
          .setValue(this.plugin.settings.onnxDevice)
          .onChange(async (value: string) => {
            this.plugin.settings.onnxDevice = value as 'cpu' | 'coreml';
            await this.plugin.saveSettings();
          })
        );
    }

    // --- Chat provider ---
    containerEl.createEl('h3', { text: 'Chat' });

    new Setting(containerEl)
      .setName('Chat Provider')
      .setDesc('Provider used to generate answers')
      .addDropdown(dd => dd
        .addOption('ollama', 'Ollama')
        .addOption('lmstudio', 'LM Studio / MLX')
        .addOption('cli', 'CLI (OpenCode / OMP / custom)')
        .setValue(this.plugin.settings.chatProvider)
        .onChange(async (value: string) => {
          const provider = value as ChatProviderName;
          this.plugin.settings.chatProvider = provider;
          if (provider !== 'cli') {
            this.plugin.settings.chatBaseUrl = CHATTER_DEFAULT_URL[provider];
          } else if (this.plugin.settings.cliTemplate === CLI_PRESETS[this.plugin.settings.cliPreset]) {
            // Only re-apply the preset when the user hasn't customized it
            this.plugin.settings.cliTemplate = applyCliPreset(this.plugin.settings.cliPreset);
          }
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.chatProvider !== 'cli') {
      new Setting(containerEl)
        .setName('Chat Base URL')
        .setDesc('Chat provider endpoint URL')
        .addText(text => text
          .setValue(this.plugin.settings.chatBaseUrl)
          .onChange(async (value: string) => {
            this.plugin.settings.chatBaseUrl = value;
            await this.plugin.saveSettings();
          })
        );

      this.addModelDropdown(
        containerEl,
        'Chat Model',
        'Model for answer generation',
        createChatProvider(this.plugin.settings),
        () => this.plugin.settings.chatModel,
        async (v) => { this.plugin.settings.chatModel = v; await this.plugin.saveSettings(); }
      );

      new Setting(containerEl)
        .setName('Enable Streaming')
        .setDesc('Stream answer tokens as they are generated')
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.streamingEnabled)
          .onChange(async (value: boolean) => {
            this.plugin.settings.streamingEnabled = value;
            await this.plugin.saveSettings();
          })
        );
    } else {
      new Setting(containerEl)
        .setName('CLI Preset')
        .setDesc(
          'Starting point for the command line. ' +
          'OpenCode/OMP use their one-shot modes; Custom starts as a bare {prompt}.'
        )
        .addDropdown(dd => dd
          .addOption('opencode', 'OpenCode')
          .addOption('omp', 'OMP')
          .addOption('custom', 'Custom')
          .setValue(this.plugin.settings.cliPreset)
          .onChange(async (value: string) => {
            this.plugin.settings.cliPreset = value as CliPreset;
            this.plugin.settings.cliTemplate = applyCliPreset(value as CliPreset);
            await this.plugin.saveSettings();
            this.display();
          })
        );

      const cliSetting = new Setting(containerEl)
        .setName('CLI Command')
        .setDesc(
          `Full command line. Tokens: ${CLI_TOKENS.join(', ')}. ` +
          '{prompt} = the whole RAG conversation, {system} = system prompt, ' +
          '{question} = the current question, {tmpdir} = a throwaway working directory. ' +
          'Add your own flags (model, agent, …) freely. Saves when you leave the field.'
        );

      // Own row: as a flex-row child, Obsidian's settings layout collapses a
      // bare textarea to min-content width (~1 char) — styles.css stacks it.
      cliSetting.settingEl.addClass('rag-cli-row');
      const cliInput = cliSetting.controlEl.createEl('textarea', {
        cls: 'text-input rag-cli-template',
        attr: { spellcheck: 'false', rows: '4' },
      });
      cliInput.value = this.plugin.settings.cliTemplate;
      cliInput.addEventListener('change', async () => {
        this.plugin.settings.cliTemplate = cliInput.value;
        await this.plugin.saveSettings();
      });
    }

    // --- Test connection ---
    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Verify both providers: embedding round-trip, and a real chat round-trip for CLI')
      .addButton(btn => btn
        .setButtonText('Test')
        .onClick(async () => {
          btn.setButtonText('Testing...');
          btn.disabled = true;
          try {
            const embedder = createEmbedder(
              this.plugin.settings,
              join((this.app.vault.adapter as FileSystemAdapter).getBasePath(), this.plugin.manifest?.dir ?? ''),
              message => new Notice(message, 3000)
            );
            const embedPing = await embedder.ping();
            if (!embedPing.reachable) {
              new Notice(
                `❌ Embeddings: provider not reachable: ${embedPing.errorMessage ?? 'connection failed'}`,
                10000
              );
            } else {
              const embedResult = await embedder.embed(['test']);
              new Notice(
                `✓ Embeddings: ${this.plugin.settings.embeddingModel} returns ${embedResult.dimension}-dim vectors (${embedPing.latencyMs}ms)`,
                10000
              );
            }

            const chat = createChatProvider(this.plugin.settings);
            const chatPing = await chat.ping();
            if (!chatPing.reachable) {
              new Notice(
                `❌ Chat: not reachable: ${chatPing.errorMessage ?? 'connection failed'}`,
                10000
              );
            } else if (chatPing.sampleResponse !== undefined) {
              const sample = chatPing.sampleResponse.length > 120
                ? chatPing.sampleResponse.slice(0, 117) + '…'
                : chatPing.sampleResponse;
              new Notice(
                `✓ Chat: round-trip OK in ${chatPing.latencyMs}ms — parsed reply: ${sample}`,
                10000
              );
            } else {
              new Notice(`✓ Chat: provider reachable (${chatPing.latencyMs}ms)`, 10000);
            }
          } catch (err) {
            new Notice(`❌ ${(err as Error).message}`, 10000);
          } finally {
            btn.setButtonText('Test');
            btn.disabled = false;
          }
        })
      );

    // --- Retrieval ---
    containerEl.createEl('h3', { text: 'Retrieval' });

    new Setting(containerEl)
      .setName('Top K Results')
      .setDesc('Number of document chunks to retrieve per query (1-50). Use 20+ when searching a large vault with many notes.')
      .addText(text => text
        .setValue(String(this.plugin.settings.topK))
        .onChange(async (value: string) => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n > 0 && n <= 50) {
            this.plugin.settings.topK = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Chunk Size')
      .setDesc('Approximate token size per chunk (100-2000)')
      .addText(text => text
        .setValue(String(this.plugin.settings.chunkSize))
        .onChange(async (value: string) => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n >= 100 && n <= 2000) {
            this.plugin.settings.chunkSize = n;
            await this.plugin.saveSettings();
          }
        })
      );

    // Index scope
    new Setting(containerEl)
      .setName('Index Scope')
      .setDesc('Which files to include when indexing')
      .addDropdown(dd => dd
        .addOption('pdfs-and-notes', 'PDFs and Markdown notes')
        .addOption('pdfs-only', 'PDFs only')
        .setValue(this.plugin.settings.indexScope)
        .onChange(async (value: string) => {
          this.plugin.settings.indexScope = value as 'pdfs-only' | 'pdfs-and-notes';
          await this.plugin.saveSettings();
        })
      );

    // Auto-index toggle
    new Setting(containerEl)
      .setName('Auto-index on Startup')
      .setDesc('Automatically re-index changed files when Obsidian starts')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoIndexOnStartup)
        .onChange(async (value: boolean) => {
          this.plugin.settings.autoIndexOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    // --- Index management ---
    containerEl.createEl('h3', { text: 'Index Management' });

    new Setting(containerEl)
      .setName('Index Location')
      .setDesc(`Stored at: ${this.plugin.manifest?.dir ?? '.obsidian/plugins/obsidian-rag'}/index/index.json`);

    new Setting(containerEl)
      .setName('Clear Index')
      .setDesc('Clear indexed data, or re-index files using the current embedding settings. Unchanged files are skipped.')
      .addButton(btn => btn
        .setButtonText('Clear')
        .onClick(async () => {
          if (confirm('Clear the entire document index? This cannot be undone.')) {
            await this.plugin.vectorStore?.clear(this.plugin.settings.embeddingModel);
            new Notice('Index cleared. Run "RAG: Index all files" to re-index.');
          }
        })
      )
      .addButton(btn => btn
        .setButtonText('Re-index')
        .onClick(async () => {
          btn.disabled = true;
          try {
            await this.plugin.indexAll();
          } finally {
            btn.disabled = false;
          }
        })
      );
  }
}
