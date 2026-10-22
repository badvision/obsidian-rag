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
import { RagView, VIEW_TYPE_RAG_CHAT } from './ui/RagView';
import { ChatService } from './ui/ChatService';
import { ProviderError } from './providers/types';

export default class RagPlugin extends Plugin {
  settings: RagPluginSettings = { ...DEFAULT_SETTINGS };

  vectorStore!: VectorStore;
  private indexManager!: IndexManager;
  private chatService!: ChatService;

  private indexAbortController: AbortController | null = null;
  private isIndexing = false;
  private fileIndexDebounce = new Map<string, number>();
  private static readonly INDEX_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

  async onload(): Promise<void> {
    await this.loadSettings();

    const embedder = createEmbedder(this.settings, join(
      (this.app.vault.adapter as FileSystemAdapter).getBasePath(), this.manifest.dir ?? ''
    ));
    const chatProvider = createChatProvider(this.settings);
    this.vectorStore = new VectorStore(this.manifest.dir ?? '', this.app);
    const chunkingService = new ChunkingService();
    const embeddingService = new EmbeddingService(embedder);
    const citationService = new CitationService();

    this.chatService = new ChatService(
      chatProvider,
      this.vectorStore,
      embeddingService,
      citationService,
      this.settings
    );

    this.indexManager = new IndexManager(
      this.app,
      chunkingService,
      embeddingService,
      this.vectorStore
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

    this.vectorStore.ensureLoaded(this.settings.embeddingModel)
      .then(() => {
        if (this.vectorStore.schemaUpgraded) {
          new Notice(
            'RAG: Index format was updated — please run "RAG: Index all files" to re-index your documents.',
            0  // stays until dismissed
          );
          return;
        }
        return this.vectorStore.exists().then(exists => {
          if (!exists) {
            new Notice('RAG: No index found. Run "RAG: Index all files" to get started.', 8000);
          }
        });
      })
      .catch((err: unknown) => {
        if (err instanceof ProviderError && err.code === 'DIMENSION_MISMATCH') {
          new Notice('RAG: Embedding model changed — run "RAG: Index all files" to re-index.', 10000);
        } else {
          console.error('RAG Plugin: Failed to load index:', err);
        }
      });

    this.addCommand({
      id: 'rag-index-current-file',
      name: 'Index current file',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (file.extension !== 'pdf' && file.extension !== 'md') return false;
        if (!checking) this.indexCurrentFile(file);
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
        if (this.isIndexing) {
          this.indexAbortController?.abort();
          new Notice('RAG: Indexing cancelled.', 4000);
        }
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
        const file = abstractFile as TFile;
        if (!this.settings.autoIndexOnStartup) return;
        if (file.extension !== 'pdf' && file.extension !== 'md') return;
        const now = Date.now();
        const last = this.fileIndexDebounce.get(file.path) ?? 0;
        if (now - last < RagPlugin.INDEX_DEBOUNCE_MS) return;
        this.fileIndexDebounce.set(file.path, now);
        this.indexCurrentFile(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (abstractFile: TAbstractFile) => {
        this.indexManager.removeFile(abstractFile.path)
          .catch(err => console.error('RAG: Remove file error:', err));
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (abstractFile: TAbstractFile, oldPath: string) => {
        this.indexManager.removeFile(oldPath)
          .catch(err => console.error('RAG: Rename cleanup error:', err));
      })
    );

    if (this.settings.autoIndexOnStartup) {
      setTimeout(() => this.indexAll(), 5000);
    }
  }

  onunload(): void {
    this.indexAbortController?.abort();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_CHAT);
  }

  async indexAll(): Promise<void> {
    if (this.isIndexing) {
      new Notice('RAG: Indexing already in progress.', 3000);
      return;
    }

    this.isIndexing = true;
    this.indexAbortController = new AbortController();

    const notice = new Notice('RAG: Indexing… 0 / ?', 0);

    try {
      const result = await this.indexManager.indexAll(
        this.settings,
        (current, total, filename) => {
          notice.setMessage(`RAG: Indexing… ${current} / ${total}  —  ${filename}`);
        },
        this.indexAbortController.signal
      );

      notice.hide();

      const parts: string[] = [`${result.indexed} indexed`];
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      new Notice(`RAG: Done — ${parts.join(', ')}.`, 5000);

      if (result.warnings.length > 0) {
        new Notice(`RAG warnings: ${result.warnings.join('; ')}`, 8000);
      }
    } catch (err) {
      notice.hide();
      const msg = (err as Error).message ?? '';
      if (msg !== 'Indexing aborted') {
        new Notice(`RAG: Indexing failed — ${msg}`, 8000);
      }
    } finally {
      this.isIndexing = false;
      this.indexAbortController = null;
    }
  }

  private async indexCurrentFile(file: TFile): Promise<void> {
    try {
      const result = await this.indexManager.indexCurrentFile(file, this.settings);
      if (!result.skipped) {
        new Notice(`RAG: Indexed ${file.name}.`, 3000);
      }
    } catch (err) {
      console.error('RAG: Index error:', err);
    }
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
