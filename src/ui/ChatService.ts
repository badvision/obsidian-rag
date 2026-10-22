import { VectorStore } from '../store/VectorStore';
import { EmbeddingService } from '../rag/EmbeddingService';
import { CitationService } from '../rag/CitationService';
import { ChatMessage, ProviderError } from '../providers/types';
import type { IChatProvider } from '../providers/types';
import { RagPluginSettings } from '../settings';
import { CitationSource } from '../rag/types';

export interface ChatResult {
  displayContent: string;
  sources: CitationSource[];
}

/**
 * 'thinking'  — tokens arriving but all inside a <think> block (chain-of-thought hidden)
 * 'responding' — visible answer content is flowing
 */
export type StreamState = 'thinking' | 'responding';

/** Remove completed <think>…</think> blocks from text. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Returns the currently visible portion of a streaming buffer:
 * - Completed <think>…</think> blocks are removed.
 * - An open (unclosed) <think> block in progress is also hidden.
 */
export function visibleContent(accumulated: string): string {
  let result = accumulated.replace(/<think>[\s\S]*?<\/think>/gi, '');
  result = result.replace(/<think>[\s\S]*$/i, '');
  return result.trim();
}

export class ChatService {
  /**
   * Conversation history for the LLM (user + assistant turns only).
   * The system message is regenerated on each turn with fresh RAG context.
   */
  private conversationHistory: ChatMessage[] = [];

  constructor(
    private provider: IChatProvider,
    private vectorStore: VectorStore,
    private embeddingService: EmbeddingService,
    private citationService: CitationService,
    private settings: RagPluginSettings
  ) {}

  hasIndexedContent(): boolean {
    return this.vectorStore.getStats().chunkCount > 0;
  }

  async ask(
    question: string,
    signal: AbortSignal,
    onToken?: (visible: string, state: StreamState) => void
  ): Promise<ChatResult> {
    await this.vectorStore.ensureLoaded(this.settings.embeddingModel);

    if (!this.hasIndexedContent()) {
      return {
        displayContent:
          'You have no indexed information.\n\n' +
          'To get started, open the command palette and run "RAG: Index all files" to index your PDFs and notes.',
        sources: [],
      };
    }

    // RAG lookup fresh for this question
    const queryEmbedding = await this.embeddingService.embedQuery(question);
    const results = this.vectorStore.query(queryEmbedding, this.settings.topK);
    const sources = results.map(r => this.citationService.buildCitationSource(r.chunk, r.score));
    const context = this.citationService.formatContext(sources);

    // System message is rebuilt each turn with current RAG context
    const systemMsg: ChatMessage = {
      role: 'system',
      content:
        'You are a precise research assistant. Answer questions based ONLY on the provided source documents.\n' +
        'Always cite your sources using [N] notation where N is the source number.\n' +
        'If information is not in the provided sources, say so clearly.\n' +
        'Be concise and accurate.\n\n' +
        `SOURCE DOCUMENTS:\n${context}`,
    };

    const userMsg: ChatMessage = { role: 'user', content: question };
    const messages: ChatMessage[] = [systemMsg, ...this.conversationHistory, userMsg];

    // Collect the raw streamed response
    let rawAccumulated = '';
    const wrappedOnToken = onToken
      ? (token: string) => {
          rawAccumulated += token;
          const visible = visibleContent(rawAccumulated);
          const state: StreamState = visible.length > 0 ? 'responding' : 'thinking';
          onToken(visible, state);
        }
      : undefined;

    const rawFull = await this.provider.chat(messages, signal, wrappedOnToken);

    // An empty response usually means the context exceeded the model's window.
    if (!rawFull && !signal.aborted) {
      throw new ProviderError(
        `Model returned an empty response. The context built from ${sources.length} sources may be too large. ` +
        `Try reducing Top K in settings.`,
        'UNEXPECTED_RESPONSE'
      );
    }

    const validated = this.citationService.validateCitations(rawFull, sources);
    const displayContent = stripThinking(validated);

    // Append exchange to history (without system message — it's regenerated each turn)
    this.conversationHistory.push(userMsg, { role: 'assistant', content: rawFull });

    return { displayContent, sources };
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }
}
