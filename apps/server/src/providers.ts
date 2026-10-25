import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { Keys } from './keys';
import type { ModelSpec } from './models';

export type ModelFactory = (spec: ModelSpec) => LanguageModel;

/** Lazily builds provider clients from the loaded keys. Throws if the provider's key is missing. */
export function createModelFactory(keys: Keys): ModelFactory {
  return (spec) => {
    const apiKey = keys[spec.provider];
    if (!apiKey) throw new Error(`no API key for provider ${spec.provider}`);
    switch (spec.provider) {
      case 'anthropic':
        return createAnthropic({ apiKey })(spec.id);
      case 'openai':
        return createOpenAI({ apiKey })(spec.id);
      case 'openrouter':
        return createOpenRouter({ apiKey })(spec.id);
    }
  };
}
