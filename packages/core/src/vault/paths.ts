import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CANVAS_FILE = 'graph.canvas';
export const NODES_DIR = 'nodes';
export const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Documents', 'chatmind');

/** `--data-dir` → `CHATMIND_DATA_DIR` → `~/Documents/chatmind` (spec §11). */
export function resolveDataDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = explicit ?? env.CHATMIND_DATA_DIR ?? DEFAULT_DATA_DIR;
  return chosen.startsWith('~/') ? path.join(os.homedir(), chosen.slice(2)) : chosen;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Canvas slugs: direct child folders that have a graph.canvas or a nodes/ dir. Dot-folders (.app, .obsidian) are skipped. */
export async function listCanvasFolders(root: string): Promise<string[]> {
  const slugs: string[] = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(root, e.name);
    if ((await exists(path.join(dir, CANVAS_FILE))) || (await exists(path.join(dir, NODES_DIR)))) slugs.push(e.name);
  }
  return slugs.sort();
}

/** Absolute paths of every .md under dir, recursively, sorted; dot-entries skipped. */
export async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMarkdownFiles(abs)));
    else if (e.name.endsWith('.md')) out.push(abs);
  }
  return out.sort();
}

export function toVaultPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
