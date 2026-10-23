import { Plugin, Notice, TFile, TAbstractFile } from 'obsidian';
import { join } from 'path';
import type { FileSystemAdapter } from 'obsidian';
import { RagPluginSettings, DEFAULT_SETTINGS, RagSettingTab, migrateLegacySettings } from './settings';
import { createEmbedder, createChatProvider } from './providers/factory';
import { VectorStore } from './store/VectorStore';
import { ChunkingService } from './indexer/ChunkingService';
import { EmbeddingService } from './rag/EmbeddingService';
import { CitationService } from './rag/CitationService';
import { IndexManager } from './indexer/IndexManager';
import { IndexScheduler } from './indexScheduler';
import { RagView, VIEW_TYPE_RAG_CHAT } from './ui/RagView';
import { ChatService } from './ui/ChatService';

export default class RagPlugin extends Plugin {
  settings: RagPluginSettings = { ...DEFAULT_SETTINGS };

  vectorStore!: VectorStore;
  indexScheduler!: IndexScheduler;
  private indexManager!: IndexManager;
  private embeddingService!: EmbeddingService;
  private chatService!: ChatService;

  async onload(): Promise<void> {
    await this.loadSettings();

    const embedder = createEmbedder(this.settings, join(
      (this.app.vault.adapter as FileSystemAdapter).getBasePath(), this.manifest.dir ?? ''
    ));
    const chatProvider = createChatProvider(this.settings);
    this.vectorStore = new VectorStore(this.manifest.dir ?? '', this.app);
    const chunkingService = new ChunkingService();
    this.embeddingService = new EmbeddingService(embedder);
    const citationService = new CitationService();
    this.indexManager = new IndexManager(
      this.app,
      chunkingService,
      this.embeddingService,
      this.vectorStore
    );

    this.indexScheduler = new IndexScheduler({
      indexManager: this.indexManager,
      embeddingService: this.embeddingService,
      vectorStore: this.vectorStore,
      getSettings: () => this.settings,
      resolveFile: (path: string) =>
        (this.app.vault.getAbstractFileByPath(path) as TFile | null) ?? null,
      notify: (message, timeoutMs) => new Notice(message, timeoutMs),
      createProgressNotice: () => new Notice('RAG: Indexing… 0 / ?', 0),
    });

    this.chatService = new ChatService(
      chatProvider,
      this.vectorStore,
      this.embeddingService,
      citationService,
      this.settings,
      () => this.indexScheduler.acquireChatLease()
    );

    this.registerView(
      VIEW_TYPE_RAG_CHAT,
      (leaf) => new RagView(leaf, this.chatService, this.settings)
    );

    this.addRibbonIcon(
      'message-square',
      'RAG: Open chat',
      () => this.openChatView()
    );

    // No eager index load: the index is loaded on demand for chat and stays
    // disk-backed during index runs. These are cheap metadata checks only.
    this.vectorStore.exists()
      .then(async exists => {
        if (!exists) {
          new Notice('RAG: No index found. Run "RAG: Index all files" to get started.', 8000);
          return;
        }
        const indexedModel = await this.vectorStore.peekModel();
        if (indexedModel && indexedModel !== this.settings.embeddingModel) {
          new Notice('RAG: Embedding model changed — run "RAG: Index all files" to re-index.', 10000);
        }
      })
      .catch(err => console.error('RAG Plugin: Failed to check index:', err));

    this.addCommand({
      id: 'rag-index-current-file',
      name: 'Index current file',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (file.extension !== 'pdf' && file.extension !== 'md') return false;
        if (!checking) this.indexScheduler.indexFile(file);
        return true;
      },
    });

    this.addCommand({
      id: 'rag-index-all',
      name: 'Index all files',
      callback: () => this.indexAll(),
    });

    this.addCommand({
      id: 'rag-cancel-index',
      name: 'Cancel indexing',
      callback: () => {
        this.indexScheduler.cancelIndex();
      },
    });

    this.addCommand({
      id: 'rag-ask-question',
      name: 'Ask a question',
      callback: () => this.openChatView(),
    });

    this.addSettingTab(new RagSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on('modify', (abstractFile: TAbstractFile) => {
        this.indexScheduler.onVaultModify(abstractFile as TFile);
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (abstractFile: TAbstractFile) => {
        this.indexScheduler.onVaultDelete(abstractFile);
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (abstractFile: TAbstractFile, oldPath: string) => {
        this.indexScheduler.onVaultRename(abstractFile, oldPath);
      })
    );

    if (this.settings.autoIndexOnStartup) {
      // Runs after the quiet window elapses — never eagerly on startup.
      this.indexScheduler.markStartup();
    }
  }

  onunload(): void {
    // Aborts any in-flight run, stops pending quiet work, releases the embedder.
    this.indexScheduler.dispose();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_CHAT);
  }

  async indexAll(): Promise<void> {
    this.indexScheduler.requestManualIndex();
  }

  async clearIndex(): Promise<void> {
    return this.indexScheduler.clearIndex();
  }

  private async openChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_RAG_CHAT, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrateLegacySettings((await this.loadData()) as Record<string, unknown> | null));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
