import type { ModelDto, Provider } from '@chatmind/core';
import type { Keys } from './keys';

export interface ModelSpec { id: string; provider: Provider; label: string; contextTokens: number }

// Anthropic ids from the Claude API reference (2026-09) and cross-checked against the AnthropicModelId union
// in the installed @ai-sdk/anthropic@4.0.52 (node_modules/@ai-sdk/anthropic/dist/index.d.ts).
// OpenAI-direct and OpenRouter ids verified 2026-09-12:
//   - https://openrouter.ai/api/v1/models (curl) confirmed anthropic/claude-opus-5, anthropic/claude-sonnet-5,
//     openai/gpt-6-astra and google/gemini-3.8-flash (the newest non-preview google -flash entry by `created`).
//   - No OPENAI_API_KEY was available in this shell, so OpenAI-direct ids were verified via WebFetch of
//     https://developers.openai.com/api/docs/models (platform.openai.com/docs/models redirects there), which
//     names "GPT-6 Astra" (id gpt-6-astra) as the current flagship. OpenAI has moved to codenames and no
//     longer ships a literal "-mini" sibling for the flagship family; "GPT-5.6 Luna" (id gpt-5.6-luna) is its
//     documented cost-optimized variant, used here as the closest analogue to a mini tier. Both ids are also
//     present in the OpenAIResponsesModelId union in @ai-sdk/openai@4.0.65 and in the OpenRouter catalog.
// contextTokens verified 2026-09-13 via https://openrouter.ai/api/v1/models (`context_length`): anthropic/
// claude-opus-5 = 1000000, anthropic/claude-sonnet-5 = 1000000, openai/gpt-6-astra = 1050000,
// openai/gpt-5.6-luna = 1050000, google/gemini-3.8-flash = 1048576. Direct-provider ids use the same number
// as their OpenRouter counterpart (claude-opus-5 = anthropic/claude-opus-5, etc.).
export const MODELS: readonly ModelSpec[] = [
  { id: 'claude-opus-5', provider: 'anthropic', label: 'Claude Opus 5', contextTokens: 1_000_000 },
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5', contextTokens: 1_000_000 },
  { id: 'gpt-6-astra', provider: 'openai', label: 'GPT-6 Astra', contextTokens: 1_050_000 },
  { id: 'gpt-5.6-luna', provider: 'openai', label: 'GPT-5.6 Luna', contextTokens: 1_050_000 },
  { id: 'anthropic/claude-opus-5', provider: 'openrouter', label: 'Claude Opus 5 (OpenRouter)', contextTokens: 1_000_000 },
  { id: 'anthropic/claude-sonnet-5', provider: 'openrouter', label: 'Claude Sonnet 5 (OpenRouter)', contextTokens: 1_000_000 },
  { id: 'openai/gpt-6-astra', provider: 'openrouter', label: 'GPT-6 Astra (OpenRouter)', contextTokens: 1_050_000 },
  { id: 'google/gemini-3.8-flash', provider: 'openrouter', label: 'Gemini 3.8 Flash (OpenRouter)', contextTokens: 1_048_576 },
];
export const DEFAULT_MODEL = 'claude-opus-5';

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}
export function isAvailable(spec: ModelSpec, keys: Keys): boolean {
  return keys[spec.provider] !== undefined;
}
export function modelDtos(keys: Keys): ModelDto[] {
  return MODELS.map((m) => ({ ...m, available: isAvailable(m, keys) }));
}
