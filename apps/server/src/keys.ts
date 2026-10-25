import { defaultEnvFile, loadEnv } from '@chatmind/index';

// Spec M5 §2: reading the key file lives in @chatmind/index so the server and the CLI resolve CHATMIND_*
// identically — a dry run that disagreed with the indexer would mis-report the thresholds it calibrates.
export { parseEnvFile, loadEnv, defaultEnvFile } from '@chatmind/index';

export interface Keys { anthropic?: string; openai?: string; openrouter?: string }

const VARS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as const;

/** Environment first, then the key file; empty strings count as unset. Never throws for a missing file. */
export async function loadKeys(env: NodeJS.ProcessEnv = process.env, filePath: string = defaultEnvFile()): Promise<Keys> {
  const all = await loadEnv(env, filePath);
  const keys: Keys = {};
  for (const [provider, name] of Object.entries(VARS) as [keyof Keys, string][]) {
    if (all[name]) keys[provider] = all[name];
  }
  return keys;
}
