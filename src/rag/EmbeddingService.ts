import { IProvider } from '../providers/types';

export class EmbeddingService {
  constructor(private provider: IProvider) {}

  async embedBatch(texts: string[], batchSize = 20): Promise<number[][]> {
    if (texts.length === 0) return [];

    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const result = await this.provider.embed(batch);
      allEmbeddings.push(...result.embeddings);
    }

    return allEmbeddings;
  }

  async embedQuery(text: string): Promise<number[]> {
    const result = await this.provider.embed([text]);
    return result.embeddings[0];
  }
}
