import { config } from '../../common/config.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { MockProvider } from './providers/mock.js';
import type { AiGateway } from './types.js';

let instance: AiGateway | undefined;

export function getAiGateway(): AiGateway {
  instance ??= config.AI_PROVIDER === 'anthropic' ? new AnthropicProvider() : new MockProvider();
  return instance;
}

/** Test hook: swap the provider. */
export function setAiGateway(gateway: AiGateway): void {
  instance = gateway;
}
