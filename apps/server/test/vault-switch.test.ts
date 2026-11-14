import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linearGraph, VaultLock, writeCanvas } from '@chatmind/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type VaultHost } from '../src/app';
import type { VaultSession } from '../src/session';
import { loadSettings, normalizeDir, rememberDataDir, RECENT_MAX } from '../src/settings';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

const session = (dataDir: string, closed: string[] = []): VaultSession => ({ dataDir, describe: [], start: () => undefined, close: async () => void closed.push(dataDir) });

async function host(dir: string, closed: string[]): Promise<{ host: VaultHost; remembered: string[] }> {
  const remembered: string[] = [];
  return {
    remembered,
    host: {
      current: session(dir, closed),
      overridden: false,
      open: async (d) => {
        if (d.includes('bad')) throw new Error('EACCES');
        await fs.mkdir(d, { recursive: true });
        return session(d, closed);
      },
      recent: async () => remembered,
      remember: async (d) => (remembered.unshift(d), remembered),
    },
  };
}

const put = (app: ReturnType<typeof createApp>, body: unknown) => app.request('/api/vault', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('settings', () => {
  it('normalizes ~ and rejects relative or empty paths', () => {
    expect(normalizeDir('~/x')).toBe(path.join(os.homedir(), 'x'));
    expect(normalizeDir('  /a/b/../c ')).toBe('/a/c');
    expect(normalizeDir('rel/dir')).toBeNull();
    expect(normalizeDir('  ')).toBeNull();
  });

  it('treats a missing or broken file as empty, and keeps recent deduped, capped, most recent first', async () => {
    const file = path.join(await tmpDir(), 'settings.json');
    expect(await loadSettings(file)).toEqual({ recent: [] });
    await fs.writeFile(file, '{ not json');
    expect(await loadSettings(file)).toEqual({ recent: [] });
    for (let i = 0; i < RECENT_MAX + 3; i++) await rememberDataDir(`/v/${i}`, file);
    const s = await rememberDataDir('/v/5', file);
    expect(s.dataDir).toBe('/v/5');
    expect(s.recent[0]).toBe('/v/5');
    expect(s.recent).toHaveLength(RECENT_MAX);
    expect(new Set(s.recent).size).toBe(RECENT_MAX);
  });
});

describe('/api/vault', () => {
  it('GET reports the live folder', async () => {
    const dir = await tmpDir();
    const { host: h } = await host(dir, []);
    const app = createApp({ dataDir: dir, vault: h });
    expect(await (await app.request('/api/vault')).json()).toEqual({ dataDir: dir, recent: [], overridden: false, canPick: false });
  });

  it('PUT switches: the new folder is served, the old session is closed, recent is updated', async () => {
    const a = await vaultWithCanvas('alpha');
    const b = await vaultWithCanvas('beta');
    const closed: string[] = [];
    const { host: h, remembered } = await host(a, closed);
    const app = createApp({ dataDir: a, vault: h, lock: new VaultLock() });
    expect((await (await app.request('/api/canvases')).json() as { slug: string }[]).map((c) => c.slug)).toEqual(['alpha']);
    const res = await put(app, { dataDir: b });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dataDir: b, recent: [b] });
    expect((await (await app.request('/api/canvases')).json() as { slug: string }[]).map((c) => c.slug)).toEqual(['beta']);
    expect(closed).toEqual([a]);
    expect(h.current.dataDir).toBe(b);
    expect(remembered).toEqual([b]);
  });

  it('PUT rejects a relative path and keeps the old vault when opening fails', async () => {
    const a = await vaultWithCanvas('alpha');
    const closed: string[] = [];
    const { host: h } = await host(a, closed);
    const app = createApp({ dataDir: a, vault: h });
    expect((await put(app, { dataDir: 'rel' })).status).toBe(400);
    const bad = await put(app, { dataDir: '/tmp/bad-folder' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('EACCES');
    expect(closed).toEqual([]);
    expect(h.current.dataDir).toBe(a);
    expect((await (await app.request('/api/canvases')).json() as { slug: string }[]).map((c) => c.slug)).toEqual(['alpha']);
  });

  it('POST /pick returns the chosen folder or null, and 404 without a dialog', async () => {
    const dir = await tmpDir();
    const { host: h } = await host(dir, []);
    const answers: (string | null)[] = ['/chosen', null];
    const app = createApp({ dataDir: dir, vault: { ...h, pick: async () => answers.shift() ?? null } });
    expect(((await (await app.request('/api/vault')).json()) as { canPick: boolean }).canPick).toBe(true);
    const pick = () => app.request('/api/vault/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(await (await pick()).json()).toEqual({ dataDir: '/chosen' });
    expect(await (await pick()).json()).toEqual({ dataDir: null });
    const none = createApp({ dataDir: dir, vault: h });
    expect((await none.request('/api/vault/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });

  it('PUT answers 404 without a host', async () => {
    const app = createApp({ dataDir: await tmpDir() });
    expect((await put(app, { dataDir: '/x' })).status).toBe(404);
  });
});

async function vaultWithCanvas(slug: string): Promise<string> {
  const root = await tmpDir();
  await writeCanvas(linearGraph(slug, [{ role: 'user', content: 'Frage' }, { role: 'assistant', content: 'Antwort', model: 'm' }]), root);
  return root;
}
