import type { IChatProvider } from '../providers/types';
import { VectorStore } from '../store/VectorStore';
import { EmbeddingService } from './EmbeddingService';
import { CitationService } from './CitationService';
import { RagPluginSettings } from '../settings';
import { RagAnswer } from './types';

export class QueryService {
  constructor(
    private provider: IChatProvider,
    private vectorStore: VectorStore,
    private embeddingService: EmbeddingService,
    private citationService: CitationService,
    private settings: RagPluginSettings
  ) {}

  async query(
    question: string,
    signal: AbortSignal,
    onToken?: (token: string) => void
  ): Promise<RagAnswer> {
    const startTime = Date.now();

    await this.vectorStore.ensureLoaded(this.settings.embeddingModel);
    const queryEmbedding = await this.embeddingService.embedQuery(question);

    const results = this.vectorStore.query(queryEmbedding, this.settings.topK);

    const sources = results.map(r =>
      this.citationService.buildCitationSource(r.chunk, r.score)
    );

    if (sources.length === 0) {
      return {
        question,
        answer: "I couldn't find relevant information in the indexed documents.",
        sources: [],
        confidence: 'insufficient',
        durationMs: Date.now() - startTime,
      };
    }

    const context = this.citationService.formatContext(sources);
    const messages = this.citationService.buildMessages(context, question);
    const rawAnswer = await this.provider.chat(messages, signal, onToken);
    const validatedAnswer = this.citationService.validateCitations(rawAnswer, sources);
    const confidence = this.citationService.assessConfidence(validatedAnswer, sources);

    return {
      question,
      answer: validatedAnswer,
      sources,
      confidence,
      durationMs: Date.now() - startTime,
    };
  }
}
