import { App, Modal } from 'obsidian';
import { IndexManager } from '../indexer/IndexManager';
import { RagPluginSettings } from '../settings';
import { IndexAllResult } from '../indexer/types';

export class IndexProgressModal extends Modal {
  private abortController: AbortController | null = null;

  constructor(
    app: App,
    private indexManager: IndexManager,
    private settings: RagPluginSettings
  ) {
    super(app);
  }

  onOpen(): void {
    const container = this.contentEl.createEl('div', { cls: 'rag-index-modal' });

    const heading = container.createEl('h2', { cls: 'rag-index-heading' });
    heading.textContent = 'Indexing Documents...';

    const progressContainer = container.createEl('div', { cls: 'rag-progress-container' });
    const progressBar = progressContainer.createEl('div', { cls: 'rag-progress-bar' });
    const progressFill = progressBar.createEl('div', { cls: 'rag-progress-fill' });
    progressFill.style.width = '0%';

    const progressText = progressContainer.createEl('div', { cls: 'rag-progress-text' });
    progressText.textContent = 'Preparing...';

    const currentFile = container.createEl('div', { cls: 'rag-current-file' });

    const stats = container.createEl('div', { cls: 'rag-index-stats' });
    stats.style.display = 'none';

    const cancelBtn = container.createEl('button', { cls: 'rag-cancel-index-btn' }) as HTMLButtonElement;
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.abortController?.abort());

    this.abortController = new AbortController();

    const onProgress = (current: number, total: number, filename: string) => {
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      const fill = this.contentEl.querySelector('.rag-progress-fill') as HTMLElement;
      const text = this.contentEl.querySelector('.rag-progress-text') as HTMLElement;
      const currentFileEl = this.contentEl.querySelector('.rag-current-file') as HTMLElement;
      if (fill) fill.style.width = `${pct}%`;
      if (text) text.textContent = `${current} / ${total}`;
      if (currentFileEl) currentFileEl.textContent = filename;
    };

    this.indexManager.indexAll(this.settings, onProgress, this.abortController.signal)
      .then(result => this.showCompletion(result))
      .catch(err => this.showError(err));
  }

  private showCompletion(result: IndexAllResult): void {
    const heading = this.contentEl.querySelector('.rag-index-heading') as HTMLElement;
    const stats = this.contentEl.querySelector('.rag-index-stats') as HTMLElement;
    const cancelBtn = this.contentEl.querySelector('.rag-cancel-index-btn') as HTMLButtonElement;
    const fill = this.contentEl.querySelector('.rag-progress-fill') as HTMLElement;

    if (heading) heading.textContent = 'Indexing Complete';
    if (fill) fill.style.width = '100%';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (stats) {
      stats.style.display = 'block';
      stats.textContent = `Indexed: ${result.indexed}, Skipped: ${result.skipped}, Failed: ${result.failed}`;
      if (result.warnings.length > 0) {
        stats.textContent += `\nWarnings: ${result.warnings.join('; ')}`;
      }
    }

    if (result.warnings.length === 0 && result.failed === 0) {
      setTimeout(() => this.close(), 3000);
    }
  }

  private showError(err: unknown): void {
    const heading = this.contentEl.querySelector('.rag-index-heading') as HTMLElement;
    const cancelBtn = this.contentEl.querySelector('.rag-cancel-index-btn') as HTMLButtonElement;
    if (heading) heading.textContent = 'Indexing Failed';
    if (cancelBtn) {
      cancelBtn.textContent = 'Close';
      cancelBtn.style.display = 'inline';
    }
    const stats = this.contentEl.querySelector('.rag-index-stats') as HTMLElement;
    if (stats) {
      stats.style.display = 'block';
      stats.textContent = `Error: ${(err as Error).message ?? 'Unknown error'}`;
    }
  }

  onClose(): void {
    this.abortController?.abort();
    this.contentEl.empty();
  }
}
