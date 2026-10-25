import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_DATA_DIR, exists, listCanvasFolders, resolveDataDir, toVaultPath, walkMarkdownFiles } from '../src/vault/paths';
import { cleanupTmpDirs, tmpDir } from './helpers';

afterAll(cleanupTmpDirs);

describe('resolveDataDir', () => {
  it('prefers the explicit path, then the env var, then the default', () => {
    expect(resolveDataDir('/x', { CHATMIND_DATA_DIR: '/y' })).toBe('/x');
    expect(resolveDataDir(undefined, { CHATMIND_DATA_DIR: '/y' })).toBe('/y');
    expect(resolveDataDir(undefined, {})).toBe(DEFAULT_DATA_DIR);
    expect(DEFAULT_DATA_DIR).toBe(path.join(os.homedir(), 'Documents', 'chatmind'));
  });
  it('expands a leading ~', () => {
    expect(resolveDataDir('~/foo', {})).toBe(path.join(os.homedir(), 'foo'));
  });
});

describe('listCanvasFolders', () => {
  it('lists folders with a canvas file or a nodes dir, sorted, skipping dot-folders', async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, 'zeta', 'nodes'), { recursive: true });
    await fs.mkdir(path.join(root, 'alpha'));
    await fs.writeFile(path.join(root, 'alpha', 'graph.canvas'), '{}');
    await fs.mkdir(path.join(root, 'empty'));
    await fs.mkdir(path.join(root, '.app'));
    await fs.writeFile(path.join(root, '.app', 'graph.canvas'), '{}');
    await fs.writeFile(path.join(root, 'stray.md'), '');
    expect(await listCanvasFolders(root)).toEqual(['alpha', 'zeta']);
  });
});

describe('walkMarkdownFiles', () => {
  it('finds .md files recursively, sorted, skipping dot-entries and other extensions', async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, 'nodes', 'sub'), { recursive: true });
    await fs.mkdir(path.join(root, '.obsidian'));
    await fs.writeFile(path.join(root, 'nodes', 'b.md'), '');
    await fs.writeFile(path.join(root, 'nodes', 'sub', 'a.md'), '');
    await fs.writeFile(path.join(root, 'nodes', '.hidden.md'), '');
    await fs.writeFile(path.join(root, '.obsidian', 'x.md'), '');
    await fs.writeFile(path.join(root, 'graph.canvas'), '{}');
    await fs.writeFile(path.join(root, 'top.md'), '');
    expect(await walkMarkdownFiles(root)).toEqual([path.join(root, 'nodes', 'b.md'), path.join(root, 'nodes', 'sub', 'a.md'), path.join(root, 'top.md')]);
  });
});

describe('toVaultPath / exists', () => {
  it('produces posix-relative paths', () => {
    expect(toVaultPath('/v', path.join('/v', 'm', 'nodes', 'a.md'))).toBe('m/nodes/a.md');
  });
  it('exists', async () => {
    const root = await tmpDir();
    expect(await exists(root)).toBe(true);
    expect(await exists(path.join(root, 'nope'))).toBe(false);
  });
});
