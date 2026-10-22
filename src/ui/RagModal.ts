import { App, Modal } from 'obsidian';
import { QueryService } from '../rag/QueryService';
import { RagPluginSettings } from '../settings';
import { RagAnswer } from '../rag/types';
import { ProviderError } from '../providers/types';

export class RagModal extends Modal {
  private abortController: AbortController | null = null;

  constructor(
    app: App,
    private queryService: QueryService,
    private settings: RagPluginSettings
  ) {
    super(app);
  }

  onOpen(): void {
    const container = this.contentEl.createEl('div', { cls: 'rag-modal' });

    const heading = container.createEl('h2');
    heading.textContent = 'Ask a question';

    const inputRow = container.createEl('div', { cls: 'rag-input-row' });

    const input = inputRow.createEl('input', { cls: 'rag-question-input' }) as HTMLInputElement;
    input.type = 'text';
    input.placeholder = 'Ask a question about your documents...';

    const submitBtn = inputRow.createEl('button', { cls: 'rag-submit-btn' }) as HTMLButtonElement;
    submitBtn.textContent = 'Ask';

    const cancelBtn = inputRow.createEl('button', { cls: 'rag-cancel-btn' }) as HTMLButtonElement;
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.display = 'none';

    container.createEl('div', { cls: 'rag-status' });
    container.createEl('div', { cls: 'rag-answer-container' });
    container.createEl('div', { cls: 'rag-sources-container' });

    const handleSubmit = () => {
      const question = input.value.trim();
      this.setLoadingState(true);
      this.submitQuery(question).finally(() => {
        this.setLoadingState(false);
      });
    };

    submitBtn.addEventListener('click', handleSubmit);

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSubmit();
      }
    });

    cancelBtn.addEventListener('click', () => {
      this.abortController?.abort();
    });
  }

  onClose(): void {
    this.abortController?.abort();
    this.contentEl.empty();
  }

  async submitQuery(question: string): Promise<void> {
    if (!question) return;

    this.clearResults();

    this.abortController = new AbortController();

    let tokenBuffer = '';
    let rafScheduled = false;
    const answerContainer = this.contentEl.querySelector('.rag-answer-container') as HTMLElement;

    const onToken = this.settings.streamingEnabled ? (token: string) => {
      tokenBuffer += token;
      if (!rafScheduled) {
        rafScheduled = true;
        setTimeout(() => {
          answerContainer.textContent = tokenBuffer;
          rafScheduled = false;
        }, 50);
      }
    } : undefined;

    try {
      const answer = await this.queryService.query(
        question,
        this.abortController.signal,
        onToken
      );
      this.renderAnswer(answer);
    } catch (err) {
      const errorMsg = this.getErrorMessage(err);
      if (errorMsg) this.renderError(errorMsg);
    }
  }

  private renderAnswer(answer: RagAnswer): void {
    const answerContainer = this.contentEl.querySelector('.rag-answer-container') as HTMLElement;
    const sourcesContainer = this.contentEl.querySelector('.rag-sources-container') as HTMLElement;
    answerContainer.empty();
    sourcesContainer.empty();

    const parts = answer.answer.split(/\[(\d+)\]/);
    parts.forEach((part, idx) => {
      if (idx % 2 === 0) {
        if (part) {
          const span = answerContainer.createEl('span');
          span.textContent = part;
        }
      } else {
        const n = parseInt(part, 10);
        const source = answer.sources[n - 1];
        if (source) {
          const a = answerContainer.createEl('a', { cls: 'rag-citation-link' });
          a.textContent = `[${n}]`;
          a.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            this.app.workspace.openLinkText(source.obsidianLink, '');
            this.close();
          });
        } else {
          const span = answerContainer.createEl('span');
          span.textContent = `[${n}]`;
        }
      }
    });

    if (answer.sources.length > 0) {
      const heading = sourcesContainer.createEl('h4');
      heading.textContent = 'Sources:';
      const list = sourcesContainer.createEl('ul', { cls: 'rag-sources-list' });
      answer.sources.forEach((source, idx) => {
        const item = list.createEl('li');
        const link = item.createEl('a', { cls: 'rag-source-link' });
        link.textContent = `[${idx + 1}] ${source.displayLabel}`;
        link.addEventListener('click', (e: MouseEvent) => {
          e.preventDefault();
          this.app.workspace.openLinkText(source.obsidianLink, '');
          this.close();
        });
      });
    }

    const confidenceEl = sourcesContainer.createEl('div', { cls: `rag-confidence rag-confidence-${answer.confidence}` });
    confidenceEl.textContent = `Confidence: ${answer.confidence}`;
  }

  private renderError(message: string): void {
    if (!message) return;
    const statusEl = this.contentEl.querySelector('.rag-status') as HTMLElement;
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = 'rag-status rag-status-error';
    }
  }

  getErrorMessage(err: unknown): string {
    if (err instanceof ProviderError) {
      switch (err.code) {
        case 'CONNECTION_REFUSED':
          if (this.settings.chatProvider === 'cli') {
            return 'CLI command failed — check the CLI Command template in settings and use Test Connection to debug it.';
          }
          return `Cannot connect to provider at ${this.settings.chatBaseUrl}. Make sure Ollama or LM Studio is running.`;
        case 'MODEL_NOT_FOUND':
          return `Model '${this.settings.chatModel}' not found. Check your settings.`;
        case 'STREAM_ABORTED':
          return '';
        case 'REQUEST_TIMEOUT':
          return 'Request timed out. The model may be slow or unavailable.';
        default:
          return `Provider error: ${(err as Error).message}`;
      }
    }
    if ((err as Error).message === 'Indexing aborted') return '';
    return `Unexpected error: ${(err as Error).message ?? 'Unknown error'}`;
  }

  private setLoadingState(loading: boolean): void {
    const submitBtn = this.contentEl.querySelector('.rag-submit-btn') as HTMLButtonElement;
    const cancelBtn = this.contentEl.querySelector('.rag-cancel-btn') as HTMLButtonElement;
    const input = this.contentEl.querySelector('.rag-question-input') as HTMLInputElement;
    if (submitBtn) submitBtn.disabled = loading;
    if (input) input.disabled = loading;
    if (cancelBtn) cancelBtn.style.display = loading ? 'inline' : 'none';
  }

  private clearResults(): void {
    const answerContainer = this.contentEl.querySelector('.rag-answer-container') as HTMLElement;
    const sourcesContainer = this.contentEl.querySelector('.rag-sources-container') as HTMLElement;
    const statusEl = this.contentEl.querySelector('.rag-status') as HTMLElement;
    if (answerContainer) answerContainer.empty();
    if (sourcesContainer) sourcesContainer.empty();
    if (statusEl) statusEl.textContent = '';
  }
}
