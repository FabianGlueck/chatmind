import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { slugOf, watchVault } from '../src/watcher';
import { cleanupTmpDirs, tmpDir } from './helpers';

afterAll(cleanupTmpDirs);

describe('slugOf', () => {
  it('maps vault files to their canvas slug and ignores the rest', () => {
    const root = '/v';
    expect(slugOf(root, '/v/masterarbeit/nodes/01J.md')).toBe('masterarbeit');
    expect(slugOf(root, '/v/masterarbeit/graph.canvas')).toBe('masterarbeit');
    expect(slugOf(root, '/v/masterarbeit')).toBe('masterarbeit'); // folder add/unlink
    expect(slugOf(root, '/v/.app/index.db')).toBeNull();
    expect(slugOf(root, '/v/masterarbeit/nodes/.01J.md.abc.tmp')).toBeNull();
    expect(slugOf(root, '/v/masterarbeit/notes.txt')).toBeNull();
    expect(slugOf(root, '/v')).toBeNull();
    expect(slugOf(root, '/elsewhere/x.md')).toBeNull();
  });
});

describe('watchVault', () => {
  it('emits the affected slugs once per debounced batch and ignores .app', async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, 'm', 'nodes'), { recursive: true });
    await fs.mkdir(path.join(root, '.app'), { recursive: true });
    const w = watchVault(root, { debounceMs: 250, stabilityMs: 100 });
    const batches: string[][] = [];
    w.onChange((slugs) => batches.push(slugs));
    await new Promise((r) => setTimeout(r, 300)); // chokidar ready
    await fs.writeFile(path.join(root, 'm', 'nodes', 'a.md'), 'x');
    await fs.writeFile(path.join(root, 'm', 'nodes', 'b.md'), 'y');
    await fs.writeFile(path.join(root, '.app', 'index.db'), 'z');
    await new Promise((r) => setTimeout(r, 900));
    expect(batches).toEqual([['m']]);
    await fs.mkdir(path.join(root, 'n'));
    await fs.writeFile(path.join(root, 'n', 'graph.canvas'), '{}');
    await new Promise((r) => setTimeout(r, 900));
    expect(batches).toEqual([['m'], ['n']]);
    await w.close();
  }, 10_000);
});
