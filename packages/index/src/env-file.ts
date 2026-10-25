import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Spec M5 §2 / M6 §4: the one place settings and keys may live outside the environment — never in the data
 * folder, never in the repo. Resolved per call so a test can point HOME somewhere harmless.
 */
export function defaultEnvFile(): string {
  return path.join(os.homedir(), '.config', 'chatmind', 'env');
}

/** KEY=VALUE per line; `#` comments and blank lines ignored; surrounding single/double quotes stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/**
 * Process env first, then the key file; empty strings count as unset. Never throws for a missing file.
 * Shared by the server and the CLI so both resolve CHATMIND_* the same way (a dry run that disagreed with
 * the indexer would mis-report the very thresholds it exists to calibrate).
 */
export async function loadEnv(env: NodeJS.ProcessEnv = process.env, filePath: string = defaultEnvFile()): Promise<Record<string, string>> {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnvFile(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fromFile)) if (v) out[k] = v;
  for (const [k, v] of Object.entries(env)) if (v) out[k] = v;
  return out;
}
