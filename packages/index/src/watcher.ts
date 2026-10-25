import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';

export interface VaultWatcher {
  onChange(listener: (slugs: string[]) => void): () => void;
  close(): Promise<void>;
}

/** Canvas slug for a path under the vault, or null when the path is nothing we watch (spec M5 §5). */
export function slugOf(dataDir: string, file: string): string | null {
  const rel = path.relative(dataDir, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.some((p) => p.startsWith('.')) || rel.endsWith('.tmp')) return null;
  const last = parts[parts.length - 1]!;
  if (parts.length > 1 && !last.endsWith('.md') && last !== 'graph.canvas') return null;
  return parts[0]!;
}

/**
 * chokidar 5 has no glob support: watch the whole data dir, ignore dot-entries at any depth, and let
 * `slugOf` filter. Events are collected for `debounceMs` after the last one and emitted as one batch.
 */
export function watchVault(dataDir: string, opts: { debounceMs?: number; stabilityMs?: number } = {}): VaultWatcher {
  const listeners = new Set<(slugs: string[]) => void>();
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    timer = null;
    const slugs = [...pending].sort();
    pending.clear();
    for (const l of listeners) l(slugs);
  };
  const watcher: FSWatcher = watch(dataDir, {
    ignoreInitial: true,
    ignored: (p) => path.relative(dataDir, p).split(path.sep).some((seg) => seg.startsWith('.')),
    awaitWriteFinish: { stabilityThreshold: opts.stabilityMs ?? 300, pollInterval: 50 },
  });
  watcher.on('all', (_event, file) => {
    const slug = slugOf(dataDir, file);
    if (slug === null) return;
    pending.add(slug);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, opts.debounceMs ?? 300);
  });
  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (timer !== null) clearTimeout(timer);
      await watcher.close();
    },
  };
}
