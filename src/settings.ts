import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { createProvider } from './providers/factory';

export interface RagPluginSettings {
  provider: 'ollama' | 'lmstudio';
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
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
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  chatModel: 'llama3.2',
  embeddingModel: 'nomic-embed-text',
  topK: 20,
  chunkSize: 500,
  chunkOverlap: 50,
  indexScope: 'pdfs-and-notes',
  streamingEnabled: true,
  autoIndexOnStartup: false,
  indexVersion: 1,
  embeddingDimension: 0,
};

export class RagSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: any) {
    super(app, plugin);
  }

  private addModelDropdown(
    containerEl: HTMLElement,
    name: string,
    desc: string,
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

    const provider = createProvider(this.plugin.settings);
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

    // Provider section
    containerEl.createEl('h3', { text: 'LLM Provider' });

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Local LLM provider to use for embeddings and chat')
      .addDropdown(dd => dd
        .addOption('ollama', 'Ollama')
        .addOption('lmstudio', 'LM Studio / MLX')
        .setValue(this.plugin.settings.provider)
        .onChange(async (value: string) => {
          this.plugin.settings.provider = value as 'ollama' | 'lmstudio';
          this.plugin.settings.baseUrl = value === 'ollama'
            ? 'http://localhost:11434'
            : 'http://localhost:1234';
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('Provider endpoint URL')
      .addText(text => text
        .setValue(this.plugin.settings.baseUrl)
        .onChange(async (value: string) => {
          this.plugin.settings.baseUrl = value;
          await this.plugin.saveSettings();
        })
      );

    this.addModelDropdown(
      containerEl,
      'Chat Model',
      'Model for answer generation',
      () => this.plugin.settings.chatModel,
      async (v) => { this.plugin.settings.chatModel = v; await this.plugin.saveSettings(); }
    );

    this.addModelDropdown(
      containerEl,
      'Embedding Model',
      'Model for embeddings — changing this requires a full re-index',
      () => this.plugin.settings.embeddingModel,
      async (v) => { this.plugin.settings.embeddingModel = v; await this.plugin.saveSettings(); }
    );

    // Test connectivity button
    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Verify provider is reachable and embedding model is loaded')
      .addButton(btn => btn
        .setButtonText('Test')
        .onClick(async () => {
          btn.setButtonText('Testing...');
          btn.disabled = true;
          try {
            const provider = createProvider(this.plugin.settings);
            const pingResult = await provider.ping();
            if (!pingResult.reachable) {
              new Notice(`❌ Provider not reachable: ${pingResult.errorMessage ?? 'connection failed'}`);
              return;
            }
            const embedResult = await provider.embed(['test']);
            new Notice(`✓ Connected — ${this.plugin.settings.embeddingModel} returns ${embedResult.dimension}-dim embeddings (${pingResult.latencyMs}ms)`);
          } catch (err) {
            new Notice(`❌ ${(err as Error).message}`);
          } finally {
            btn.setButtonText('Test');
            btn.disabled = false;
          }
        })
      );

    // Retrieval section
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

    // Streaming toggle
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

    // Index management section
    containerEl.createEl('h3', { text: 'Index Management' });

    new Setting(containerEl)
      .setName('Index Location')
      .setDesc(`Stored at: ${this.plugin.manifest?.dir ?? '.obsidian/plugins/obsidian-rag'}/index/index.json`);

    new Setting(containerEl)
      .setName('Clear Index')
      .setDesc('Delete all indexed data. You will need to re-index your documents.')
      .addButton(btn => btn
        .setButtonText('Clear')
        .onClick(async () => {
          if (confirm('Clear the entire document index? This cannot be undone.')) {
            await this.plugin.vectorStore?.clear(this.plugin.settings.embeddingModel);
            new Notice('Index cleared. Run "RAG: Index all files" to re-index.');
          }
        })
      );
  }
}
