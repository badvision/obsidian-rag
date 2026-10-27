import { ItemView, WorkspaceLeaf, MarkdownRenderer } from 'obsidian';
import { ChatService, StreamState } from './ChatService';
import { RagPluginSettings } from '../settings';
import { CitationSource } from '../rag/types';
import { ProviderError } from '../providers/types';

export const VIEW_TYPE_RAG_CHAT = 'rag-chat';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  displayContent: string;
  sources: CitationSource[];
  isStreaming?: boolean;
}

export class RagView extends ItemView {
  private turns: ChatTurn[] = [];
  private abortController: AbortController | null = null;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    private chatService: ChatService,
    private settings: RagPluginSettings
  ) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_RAG_CHAT; }
  getDisplayText(): string { return 'RAG Chat'; }
  getIcon(): string { return 'message-square'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('rag-view');

    this.messagesEl = container.createEl('div', { cls: 'rag-messages' });

    const inputArea = container.createEl('div', { cls: 'rag-input-area' });
    this.inputEl = inputArea.createEl('textarea', {
      cls: 'rag-chat-input',
      attr: { placeholder: 'Ask a question… (Shift+Enter for new line)', rows: '3' },
    }) as HTMLTextAreaElement;

    const btnRow = inputArea.createEl('div', { cls: 'rag-btn-row' });
    this.sendBtn = btnRow.createEl('button', { cls: 'rag-send-btn', text: 'Send' }) as HTMLButtonElement;
    const clearBtn = btnRow.createEl('button', { cls: 'rag-clear-btn', text: 'Clear chat' });

    this.sendBtn.addEventListener('click', () => this.handleSend());
    clearBtn.addEventListener('click', () => this.clearChat());
    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // Re-render persisted turns when the view is reopened
    for (const turn of this.turns) {
      await this.renderTurn(turn);
    }
    this.scrollToBottom();
    this.inputEl.focus();
  }

  async onClose(): Promise<void> {
    this.abortController?.abort();
  }

  private async handleSend(): Promise<void> {
    const question = this.inputEl.value.trim();
    if (!question || this.sendBtn.disabled) return;

    this.inputEl.value = '';
    this.setLoading(true);

    // User bubble
    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      displayContent: question,
      sources: [],
    };
    this.turns.push(userTurn);
    await this.renderTurn(userTurn);

    // Assistant streaming placeholder
    const assistantTurn: ChatTurn = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      displayContent: '',
      sources: [],
      isStreaming: true,
    };
    this.turns.push(assistantTurn);
    const assistantEl = this.messagesEl.createEl('div', {
      cls: 'rag-message rag-message-assistant rag-message-streaming',
    });
    const statusEl = assistantEl.createEl('div', { cls: 'rag-stream-status is-waiting' });
    statusEl.textContent = 'Waiting for response…';
    const contentEl = assistantEl.createEl('div', { cls: 'rag-message-content' });

    this.abortController = new AbortController();

    try {
      const result = await this.chatService.ask(
        question,
        this.abortController.signal,
        this.settings.streamingEnabled
          ? (visible: string, state: StreamState) => {
              if (state === 'thinking') {
                statusEl.textContent = 'Thinking…';
                statusEl.className = 'rag-stream-status is-thinking';
                contentEl.textContent = '';
              } else {
                statusEl.className = 'rag-stream-status is-responding';
                statusEl.textContent = '';
                contentEl.textContent = visible;
              }
              this.scrollToBottom();
            }
          : undefined
      );

      assistantTurn.displayContent = result.displayContent;
      assistantTurn.sources = result.sources;
      assistantTurn.isStreaming = false;

      // Replace streaming placeholder with fully rendered markdown turn
      assistantEl.remove();
      await this.renderTurn(assistantTurn);
    } catch (err) {
      assistantTurn.isStreaming = false;
      const msg = this.getErrorMessage(err);
      if (msg) {
        assistantTurn.displayContent = msg;
        assistantEl.classList.remove('rag-message-streaming');
        assistantEl.classList.add('rag-message-error');
        statusEl.remove();
        contentEl.textContent = msg;
      } else {
        this.turns.pop();
        assistantEl.remove();
      }
    } finally {
      this.setLoading(false);
      this.inputEl.focus();
    }
  }

  private async renderTurn(turn: ChatTurn): Promise<HTMLElement> {
    const el = this.messagesEl.createEl('div', {
      cls: `rag-message rag-message-${turn.role}`,
    });

    if (turn.role === 'user') {
      el.createEl('div', { cls: 'rag-message-content', text: turn.displayContent });
    } else {
      const content = el.createEl('div', { cls: 'rag-message-content' });
      await MarkdownRenderer.renderMarkdown(turn.displayContent, content, '', this);
      this.injectCitationLinks(content, turn.sources);
      if (turn.sources.length > 0) {
        this.renderSources(el, turn.sources);
      }
    }

    this.scrollToBottom();
    return el;
  }

  /**
   * After MarkdownRenderer produces HTML, walk text nodes and replace
   * [N] citation markers with clickable links (without closing the view).
   */
  private injectCitationLinks(container: HTMLElement, sources: CitationSource[]): void {
    if (sources.length === 0) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) textNodes.push(node as Text);

    for (const textNode of textNodes) {
      const text = textNode.textContent ?? '';
      if (!/\[\d+\]/.test(text)) continue;

      const parts = text.split(/\[(\d+)\]/);
      const frag = document.createDocumentFragment();
      parts.forEach((part, idx) => {
        if (idx % 2 === 0) {
          if (part) frag.appendChild(document.createTextNode(part));
        } else {
          const n = parseInt(part, 10);
          const source = sources[n - 1];
          if (source) {
            const a = document.createElement('a');
            a.className = 'rag-citation-link';
            a.textContent = `[${n}]`;
            a.addEventListener('click', (e: MouseEvent) => {
              e.preventDefault();
              this.app.workspace.openLinkText(source.obsidianLink, '');
            });
            frag.appendChild(a);
          } else {
            frag.appendChild(document.createTextNode(`[${n}]`));
          }
        }
      });
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }

  private renderSources(container: HTMLElement, sources: CitationSource[]): void {
    const details = container.createEl('details', { cls: 'rag-sources-details' });
    details.createEl('summary').textContent =
      `${sources.length} source${sources.length !== 1 ? 's' : ''}`;
    const list = details.createEl('ul', { cls: 'rag-sources-list' });
    sources.forEach((source, idx) => {
      const link = list.createEl('li').createEl('a', { cls: 'rag-source-link' });
      link.textContent = `[${idx + 1}] ${source.displayLabel}`;
      link.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        this.app.workspace.openLinkText(source.obsidianLink, '');
      });
    });
  }

  private clearChat(): void {
    this.turns = [];
    this.messagesEl.empty();
    this.chatService.clearHistory();
  }

  private setLoading(loading: boolean): void {
    this.sendBtn.disabled = loading;
    this.inputEl.disabled = loading;
    this.sendBtn.textContent = loading ? '…' : 'Send';
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof ProviderError) {
      switch (err.code) {
        case 'CONNECTION_REFUSED':
          if (this.settings.chatProvider === 'cli') {
            return `CLI command failed: ${(err as Error).message} — check the CLI Command template in settings and use Test Connection to debug.`;
          }
          return `Cannot connect to ${this.settings.chatBaseUrl}. Is Ollama / LM Studio running?`;
        case 'MODEL_NOT_FOUND':
          return `Model '${this.settings.chatModel}' not found — check settings.`;
        case 'STREAM_ABORTED':
          return '';
        default:
          return `Provider error: ${(err as Error).message}`;
      }
    }
    if ((err as Error).name === 'AbortError') return '';
    return `Error: ${(err as Error).message ?? 'Unknown'}`;
  }
}
