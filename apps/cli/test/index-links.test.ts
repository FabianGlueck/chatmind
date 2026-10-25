import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { linearGraph, readVault, writeCanvas } from '@chatmind/core';
import { IndexDb } from '@chatmind/index';
import { indexLinksDryRun } from '../src/index-links';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  return { lines, restore: () => spy.mockRestore() };
}

const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

/** Canvas `a`: A1 → A2 (a chain), canvas `b`: B1, canvas `c`: C1 far away. A1 ≈ B1, A2 halfway. */
async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
  dirs.push(root);
  await writeCanvas(linearGraph('a', [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a1', summary: 'Erste' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2', summary: 'Zweite' }]), root);
  await writeCanvas(linearGraph('b', [{ role: 'user', content: 'v' }, { role: 'assistant', content: 'b1', summary: 'Drüben' }]), root);
  await writeCanvas(linearGraph('c', [{ role: 'user', content: 'w' }, { role: 'assistant', content: 'c1', summary: 'Fern' }]), root);
  const { canvases } = await readVault(root);
  const idOf = (slug: string, summary: string): string => [...canvases.find((g) => g.slug === slug)!.nodes.values()].find((n) => n.summary === summary)!.id;
  const db = IndexDb.open(path.join(root, '.app', 'index.db'), { model: 'fake/e', dim: 3 });
  for (const [slug, summary, vec] of [['a', 'Erste', v(1, 0, 0)], ['a', 'Zweite', v(1, 1, 0)], ['b', 'Drüben', v(1, 0.1, 0)], ['c', 'Fern', v(0, 0, 1)]] as const) {
    const id = idOf(slug, summary);
    db.upsertNode(id, slug, 'h');
    db.setEmbedded(id, 'h', vec);
  }
  db.close();
  return root;
}

describe('chatmind index links --dry-run (spec M7 §5)', () => {
  it('prints every link once per canvas and the totals', async () => {
    const root = await fixture();
    const { lines, restore } = capture();
    expect(await indexLinksDryRun(root, {}, {})).toBe(0);
    restore();
    const out = lines.join('\n');
    expect(out).toMatch(/4 vectors, dim 3, centring off, 4 participants/);
    expect(out).toMatch(/settings: defaults \(k 5, min 0\.3\)/);
    expect(out).toMatch(/canvas a: 2 links/);
    // Both links cross canvases, so the score is the raw similarity (spec M7 §4, amended 2026-09-24).
    expect(out).toMatch(/1\.00 \(cos 1\.00\) {2}Erste ↔ Drüben \[b\]/);
    expect(out).toMatch(/0\.77 \(cos 0\.77\) {2}Zweite ↔ Drüben \[b\]/);
    expect(out).not.toMatch(/Erste ↔ Zweite/); // a chain: structural
    expect(out).toMatch(/canvas b: 0 links/); // each link is printed under its first canvas only
    expect(out).toMatch(/totals: 2 links, 4 participants, 1 without a link, per participant mean 1\.00 max 2/);
  });

  it('--k and --min override the settings', async () => {
    const root = await fixture();
    const { lines, restore } = capture();
    await indexLinksDryRun(root, { k: '1', min: '-1' }, {});
    restore();
    const out = lines.join('\n');
    expect(out).toMatch(/settings: k 1 \(default 5\), tMin -1 \(default 0\.3\)/);
    expect(out).toMatch(/totals: 1 link, 4 participants, 2 without a link/);
  });

  it('says so when there is no index', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
    dirs.push(root);
    const { lines, restore } = capture();
    expect(await indexLinksDryRun(root, {}, {})).toBe(0);
    restore();
    expect(lines.join('\n')).toMatch(/no index/);
  });
});
