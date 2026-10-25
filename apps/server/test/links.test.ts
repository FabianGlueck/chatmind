import path from 'node:path';
import { linearGraph, writeCanvas, type CanvasGraph, type LinksDto } from '@chatmind/core';
import { IndexDb } from '@chatmind/index';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { LinkService } from '../src/links';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

const EMBED = { model: 'test/embed', dim: 3 };
const v = (...xs: number[]): Float32Array => Float32Array.from(xs);
const ids = (g: CanvasGraph): string[] => [...g.nodes.keys()];

/**
 * Canvas `a`: U1 → A1 → U2 → A2 (A2 is A1's descendant). Canvas `b`: V1 → B1. Canvas `c`: W1 → C1 → W2 (C1 without
 * a vector, W2 without a reply). A1 ≈ A2 ≈ B1; fewer than MIN_CENTER vectors, so no centring.
 */
async function fixture() {
  const root = await tmpDir();
  const a = linearGraph('a', [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1 body', summary: 'Antwort A1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2 body' },
  ]);
  const b = linearGraph('b', [{ role: 'user', content: 'v1' }, { role: 'assistant', content: 'b1', summary: 'Antwort B1' }]);
  const c = linearGraph('c', [{ role: 'user', content: 'w1' }, { role: 'assistant', content: 'c1' }, { role: 'user', content: 'w2' }]);
  for (const g of [a, b, c]) await writeCanvas(g, root);
  const [U1, A1, U2, A2] = ids(a) as [string, string, string, string];
  const [, B1] = ids(b) as [string, string];
  const [, C1, W2] = ids(c) as [string, string, string];
  const dbFile = path.join(root, '.app', 'index.db');
  const db = IndexDb.open(dbFile, EMBED);
  const put = (id: string, canvas: string, vec: Float32Array): void => {
    db.upsertNode(id, canvas, 'h');
    db.setEmbedded(id, 'h', vec);
  };
  put(A1, 'a', v(1, 0, 0));
  put(A2, 'a', v(1, 0.3, 0));
  put(B1, 'b', v(1, 0.05, 0));
  const links = new LinkService({ dbFile, settings: { k: 5, tMin: -1 } }); // plain mutual kNN here; the hub correction is tested in @chatmind/index
  const app = createApp({ dataDir: root, links });
  const get = async (slug: string, id: string) => app.request(`/api/canvases/${slug}/nodes/${id}/links`);
  const body = async (slug: string, id: string) => (await (await get(slug, id)).json()) as LinksDto;
  return { root, db, put, links, get, body, U1, A1, U2, A2, B1, C1, W2 };
}

describe('GET /api/canvases/:slug/nodes/:id/links (spec M7 §5)', () => {
  it('links across canvases, never to structural neighbours', async () => {
    const f = await fixture();
    const r = await f.body('a', f.A1);
    expect(r.from).toBe(f.A1);
    expect(r.reason).toBeUndefined();
    expect(r.links).toEqual([{ id: f.B1, canvas: 'b', summary: 'Antwort B1', similarity: 1, score: expect.any(Number) }]); // A2 is A1's descendant
    const rb = await f.body('b', f.B1);
    expect(rb.links.map((l) => l.id)).toEqual([f.A1, f.A2]);
    expect(rb.links[1]!.summary).toBe('a2 body'); // no summary: the body start
  });

  it('a user node shows the links of its reply', async () => {
    const f = await fixture();
    const r = await f.body('a', f.U2);
    expect(r.from).toBe(f.A2);
    expect(r.links.map((l) => l.id)).toEqual([f.B1]);
  });

  it('names why the list is empty', async () => {
    const f = await fixture();
    expect(await f.body('c', f.C1)).toEqual({ from: f.C1, links: [], reason: 'no-vector' });
    expect(await f.body('c', f.W2)).toEqual({ from: null, links: [], reason: 'no-answer' });
    const bare = createApp({ dataDir: f.root });
    expect(await (await bare.request(`/api/canvases/a/nodes/${f.A1}/links`)).json()).toEqual({ from: null, links: [], reason: 'no-index' });
    const missing = createApp({ dataDir: f.root, links: new LinkService({ dbFile: path.join(f.root, 'nope.db'), settings: { k: 5, tMin: 0.3 } }) });
    expect(await (await missing.request(`/api/canvases/a/nodes/${f.A1}/links`)).json()).toEqual({ from: null, links: [], reason: 'no-index' });
  });

  it('404 for an unknown canvas or node', async () => {
    const f = await fixture();
    expect((await f.get('nope', f.A1)).status).toBe(404);
    expect((await f.get('b', f.A1)).status).toBe(404); // A1 lives in `a`
  });

  it('reloads the vectors after the indexer wrote', async () => {
    const f = await fixture();
    expect((await f.body('c', f.C1)).reason).toBe('no-vector');
    f.put(f.C1, 'c', v(1, 0.02, 0));
    const r = await f.body('c', f.C1);
    expect(r.reason).toBeUndefined();
    expect(r.links.map((l) => l.id)).toContain(f.A1);
  });
});
