// No imports: the settings window's browser bundle uses this too.

/** Desktop spec §1: the provider keys the settings window edits, as named in the key file. */
export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY' },
  { id: 'mistral', label: 'Mistral', env: 'MISTRAL_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
] as const;
export type ProviderId = (typeof PROVIDERS)[number]['id'];
