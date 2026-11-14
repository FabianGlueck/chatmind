import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Spec vault-switcher §3: UI-chosen vault folder + recent list; lives next to the key file, never in the vault. */
export interface Settings { dataDir?: string; recent: string[] }

export const RECENT_MAX = 8;

export function settingsFile(): string {
  return path.join(os.homedir(), '.config', 'chatmind', 'settings.json');
}

/** `~` / `~/x` expanded, then absolute; null for empty or relative input (spec §2, §4 `400`). */
export function normalizeDir(input: string): string | null {
  const s = input.trim();
  if (s === '') return null;
  const expanded = s === '~' ? os.homedir() : s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : null;
}

/** A missing or unparsable file counts as empty — never an error (spec §3). */
export async function loadSettings(file: string = settingsFile()): Promise<Settings> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { dataDir?: unknown; recent?: unknown };
    const recent = Array.isArray(raw.recent) ? raw.recent.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)) : [];
    return { ...(typeof raw.dataDir === 'string' && path.isAbsolute(raw.dataDir) ? { dataDir: raw.dataDir } : {}), recent: [...new Set(recent)].slice(0, RECENT_MAX) };
  } catch {
    return { recent: [] };
  }
}

/** Makes `dir` the chosen folder and the most recent entry; atomic write (temp file + rename). */
export async function rememberDataDir(dir: string, file: string = settingsFile()): Promise<Settings> {
  const cur = await loadSettings(file);
  const next: Settings = { dataDir: dir, recent: [dir, ...cur.recent.filter((p) => p !== dir)].slice(0, RECENT_MAX) };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await fs.rename(tmp, file);
  return next;
}
