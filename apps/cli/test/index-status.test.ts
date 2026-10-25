import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { VaultLock, linearGraph, writeCanvas } from '@chatmind/core';
import { IndexDb, reconcile } from '@chatmind/index';
import { indexStatus } from '../src/index-status';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

async function vault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
  dirs.push(root);
  await writeCanvas(linearGraph('m', [{ role: 'user', content: 'Eine längere Frage, die keinen Shortcut bekommt, weil sie mehr als achtzig Zeichen hat, ganz sicher.' }, { role: 'user', content: 'Kurz' }]), root);
  return root;
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  return { lines, restore: () => spy.mockRestore() };
}

describe('chatmind index status', () => {
  it('reports "no index" when index.db is missing', async () => {
    const root = await vault();
    const { lines, restore } = capture();
    expect(await indexStatus(root)).toBe(0);
    restore();
    expect(lines.join('\n')).toMatch(/no index/);
    expect(lines.join('\n')).toMatch(/canvas m: 2 nodes, 0 embedded, 0 summarized, 0 topics, pending embed 2, pending summary 2, pending topics 0/);
  });

  it('counts embedded, summarized and pending per canvas after a reconcile', async () => {
    const root = await vault();
    const embedder = { model: 'openai/text-embedding-3-small', dim: 1536, embed: async (t: string[]) => t.map(() => new Float32Array(1536)) };
    const db = IndexDb.open(path.join(root, '.app', 'index.db'), embedder);
    // The clock runs ahead of USER_WAIT_MS so the young user nodes are judged, not deferred (spec M6 §4).
    await reconcile({ dataDir: root, db, embedder, summarizer: async ({ body }) => `T ${body.slice(0, 10)}`, namer: async () => 'Thema', now: () => Date.now() + 200_000, lock: new VaultLock() });
    db.close();
    const { lines, restore } = capture();
    await indexStatus(root);
    restore();
    const out = lines.join('\n');
    expect(out).toMatch(/canvas m: 2 nodes, 2 embedded, 2 summarized, 2 topics, pending embed 0, pending summary 0, pending topics 0/);
    expect(out).toMatch(/embed model: openai\/text-embedding-3-small \(dim 1536\) — matches default/);
  });
});
