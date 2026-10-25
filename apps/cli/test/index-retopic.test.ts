import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { VaultLock, linearGraph, readVault, writeCanvas } from '@chatmind/core';
import { IndexDb, reconcile } from '@chatmind/index';
import { indexRetopic } from '../src/index-retopic';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  return { lines, restore: () => spy.mockRestore() };
}

const embedder = { model: 'fake/e', dim: 4, embed: async (t: string[]) => t.map((s) => { const v = new Float32Array(4); v[0] = 1; v[3] = s.length / 1000; return v; }) };

/** A canvas whose topics the indexer wrote, plus one the user set by hand afterwards. */
async function indexedVault(): Promise<{ root: string; ids: string[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
  dirs.push(root);
  const graph = linearGraph('m', [
    { role: 'user', content: 'Erste Frage\nzweite Zeile' },
    { role: 'assistant', content: 'Erste Antwort darauf\nzweite Zeile', model: 'x' },
    { role: 'user', content: 'Zweite Frage dazu noch\nzweite Zeile' },
  ]);
  await writeCanvas(graph, root);
  const db = IndexDb.open(path.join(root, '.app', 'index.db'), embedder);
  await reconcile({
    dataDir: root, db, embedder,
    summarizer: async ({ body }) => `T ${body.slice(0, 10)}`,
    namer: async () => 'Thema',
    lock: new VaultLock(),
    now: () => Date.now() + 200_000,
  });
  db.close();
  return { root, ids: [...graph.nodes.keys()] };
}

async function topicsOnDisk(root: string): Promise<Map<string, string[]>> {
  const { canvases } = await readVault(root);
  return new Map([...canvases.find((c) => c.slug === 'm')!.nodes.values()].map((n) => [n.id, n.topics]));
}

describe('chatmind index retopic (spec M6 §4)', () => {
  it('clears only the topics the indexer wrote and leaves the user\'s own alone', async () => {
    const { root, ids } = await indexedVault();
    const before = await topicsOnDisk(root);
    expect([...before.values()].every((t) => t[0] === 'Thema')).toBe(true);

    // The user renames one node's topic in Obsidian — it no longer matches what we recorded.
    const { canvases } = await readVault(root);
    const mine = canvases[0]!.paths.get(ids[1]!)!;
    const file = path.join(root, mine);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('topics: [Thema]', 'topics: [Von Hand]'));

    const { lines, restore } = capture();
    expect(await indexRetopic('m', root)).toBe(0);
    restore();

    const after = await topicsOnDisk(root);
    expect(after.get(ids[0]!)).toEqual([]);
    expect(after.get(ids[2]!)).toEqual([]);
    expect(after.get(ids[1]!)).toEqual(['Von Hand']); // the user's, untouched
    expect(lines.join('\n')).toMatch(/canvas m: cleared 2, kept 1/);
  });

  it('keeps summaries and bodies intact while clearing', async () => {
    const { root, ids } = await indexedVault();
    const { canvases: before } = await readVault(root);
    const node = before[0]!.nodes.get(ids[0]!)!;
    const { restore } = capture();
    await indexRetopic('m', root);
    restore();
    const { canvases: after } = await readVault(root);
    const now = after[0]!.nodes.get(ids[0]!)!;
    expect(now.summary).toBe(node.summary);
    expect(now.body).toBe(node.body);
    expect(now.topics).toEqual([]);
  });

  it('reports an unknown canvas and names the ones that exist', async () => {
    const { root } = await indexedVault();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await indexRetopic('gibtsnicht', root)).toBe(2);
    const out = err.mock.calls.flat().join(' ');
    expect(out).toMatch(/gibtsnicht/);
    expect(out).toMatch(/canvases in this vault: m/); // a typo must not send the user hunting for the right slug
    err.mockRestore();
  });

  it('says so when there is no index, and changes nothing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
    dirs.push(root);
    await writeCanvas(linearGraph('m', [{ role: 'user', content: 'Frage' }]), root);
    const { lines, restore } = capture();
    expect(await indexRetopic('m', root)).toBe(0);
    restore();
    expect(lines.join('\n')).toMatch(/no index/);
  });
});
