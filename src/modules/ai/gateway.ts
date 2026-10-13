import { config } from '../../common/config.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { MockProvider } from './providers/mock.js';
import { OllamaProvider } from './providers/ollama.js';
import type { AiGateway } from './types.js';

let instance: AiGateway | undefined;

function createGateway(): AiGateway {
  switch (config.AI_PROVIDER) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.OLLAMA_URL,
        apiKey: config.OLLAMA_API_KEY,
        models: {
          small: config.OLLAMA_MODEL_SMALL ?? config.OLLAMA_MODEL,
          mid: config.OLLAMA_MODEL_MID ?? config.OLLAMA_MODEL,
          large: config.OLLAMA_MODEL_LARGE ?? config.OLLAMA_MODEL,
        },
        numCtx: config.OLLAMA_NUM_CTX,
        timeoutMs: config.OLLAMA_TIMEOUT_MS,
      });
    default:
      return new MockProvider();
  }
}

export function getAiGateway(): AiGateway {
  instance ??= createGateway();
  return instance;
}

/** Test hook: swap the provider. */
export function setAiGateway(gateway: AiGateway): void {
  instance = gateway;
}
