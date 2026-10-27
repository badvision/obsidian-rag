import { RagPluginSettings } from '../settings';
import { IChatProvider, IEmbedder } from './types';
import { OllamaEmbedder, OllamaChatProvider } from './ollama';
import { LMStudioEmbedder, LMStudioChatProvider } from './lmstudio';
import { CliChatProvider } from './cli';
import { OnnxEmbedder } from './onnx';

export function createEmbedder(
  settings: RagPluginSettings,
  pluginDir?: string,
  onProgress?: (message: string) => void
): IEmbedder {
  if (settings.embeddingProvider === 'lmstudio') {
    return new LMStudioEmbedder(settings.embeddingBaseUrl, settings.embeddingModel, settings.embeddingApiKey);
  }
  if (settings.embeddingProvider === 'onnx') {
    return new OnnxEmbedder({
      model: settings.embeddingModel,
      pluginDir: pluginDir ?? '',
      onProgress,
      device: settings.onnxDevice,
    });
  }
  return new OllamaEmbedder(settings.embeddingBaseUrl, settings.embeddingModel, settings.embeddingApiKey);
}

export function createChatProvider(settings: RagPluginSettings): IChatProvider {
  if (settings.chatProvider === 'lmstudio') {
    return new LMStudioChatProvider(settings.chatBaseUrl, settings.chatModel, settings.chatApiKey);
  }
  if (settings.chatProvider === 'cli') {
    return new CliChatProvider(settings.cliTemplate);
  }
  return new OllamaChatProvider(settings.chatBaseUrl, settings.chatModel, settings.chatApiKey);
}
