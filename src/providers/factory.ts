import { RagPluginSettings } from '../settings';
import { IProvider } from './types';
import { OllamaProvider } from './ollama';
import { LMStudioProvider } from './lmstudio';

export function createProvider(settings: RagPluginSettings): IProvider {
  if (settings.provider === 'ollama') {
    return new OllamaProvider(
      settings.baseUrl,
      settings.chatModel,
      settings.embeddingModel,
      settings.streamingEnabled
    );
  } else {
    return new LMStudioProvider(
      settings.baseUrl,
      settings.chatModel,
      settings.embeddingModel,
      settings.streamingEnabled
    );
  }
}
