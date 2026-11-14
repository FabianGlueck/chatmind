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

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

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
    if (KEY_RE.test(key)) out[key] = value;
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

/**
 * Desktop spec §1: apply `changes` to the text of a key file — a string sets the key (its first line is
 * replaced in place, later duplicates dropped, a new key appended), `null` removes every line of it.
 * Comments, blank lines and other keys stay as they are. A value `parseEnvFile` would trim or unquote is
 * written in double quotes, so it reads back unchanged.
 */
export function updateEnvFile(text: string, changes: Record<string, string | null>): string {
  for (const [key, value] of Object.entries(changes)) {
    if (!KEY_RE.test(key)) throw new Error(`invalid key "${key}"`);
    if (value !== null && /[\r\n]/.test(value)) throw new Error(`value of ${key} must be a single line`);
  }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf('=');
    const key = eq > 0 && !line.trim().startsWith('#') ? line.slice(0, eq).trim() : '';
    if (!(key in changes)) {
      out.push(line);
      continue;
    }
    const value = changes[key]!;
    if (value === null || done.has(key)) continue;
    out.push(`${key}=${quoteEnvValue(value)}`);
    done.add(key);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== null && !done.has(key)) out.push(`${key}=${quoteEnvValue(value)}`);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

function quoteEnvValue(value: string): string {
  const plain = value === value.trim() && !/^["']/.test(value);
  return plain ? value : `"${value}"`;
}

/** Read-modify-write of the key file (desktop spec §1): folder created if missing, file mode 0600. */
export async function writeEnvFile(changes: Record<string, string | null>, filePath: string = defaultEnvFile()): Promise<void> {
  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, updateEnvFile(text, changes), { mode: 0o600 });
  await fs.chmod(filePath, 0o600); // `mode` applies only when the file is created
}
