import path from 'node:path';
import { linearGraph, NODE_GAP, placeChild, readVault, writeCanvas, type CanvasGraph } from '@chatmind/core';
import { IndexDb } from '@chatmind/index';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { parseJudgement, placePrompt, TopicPlacer, type PlacementJudge } from '../src/placement';
import { mockModel } from './mock-model';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

/** Canvas `m`: strand Alpha (Q1 → A1) at the left, strand Beta (Q2 → A2) far right; vectors on two axes, no centring (< 8). */
async function fixture() {
  const root = await tmpDir();
  const alpha = linearGraph('m', [{ role: 'user', content: 'alpha q', summary: 'Frage zu Alpha' }, { role: 'assistant', content: 'alpha a' }]);
  const beta = linearGraph('m', [{ role: 'user', content: 'beta q' }, { role: 'assistant', content: 'beta a' }]);
  const g: CanvasGraph = alpha;
  for (const n of alpha.nodes.values()) n.topics = ['Alpha'];
  for (const [id, n] of beta.nodes) { n.topics = ['Beta']; g.nodes.set(id, n); const l = beta.layout.get(id)!; g.layout.set(id, { ...l, x: l.x + 2000 }); }
  await writeCanvas(g, root);
  const dbFile = path.join(root, '.app', 'index.db');
  const db = IndexDb.open(dbFile, { model: 'test/embed', dim: 3 });
  const [Q1, A1] = [...alpha.nodes.keys()] as [string, string];
  const [Q2, A2] = [...beta.nodes.keys()] as [string, string];
  for (const [id, vec] of [[Q1, v(1, 0, 0)], [A1, v(1, 0.1, 0)], [Q2, v(0, 1, 0)], [A2, v(0.1, 1, 0)]] as const) { db.upsertNode(id, 'm', 'h'); db.setEmbedded(id, 'h', vec); }
  db.close();
  const { canvases } = await readVault(root);
  return { root, dbFile, graph: canvases[0]!, A1 };
}
const embedding = (vec: Float32Array) => async () => [vec];
function placer(dbFile: string, embed: () => Promise<Float32Array[]>, judge?: PlacementJudge, timeouts: { embedTimeoutMs?: number; judgeTimeoutMs?: number } = {}) {
  return new TopicPlacer({ dbFile, embedder: { embed }, ...(judge ? { judge } : {}), ...timeouts });
}

describe('TopicPlacer.pick (spec M14)', () => {
  it('a clear embedding decides alone; the judge is not asked', async () => {
    const { dbFile, graph } = await fixture();
    const judge = vi.fn(async () => 'Beta');
    const p = placer(dbFile, embedding(v(1, 0.05, 0)), judge);
    expect(await p.pick(graph, 'neue Frage')).toBe('Alpha');
    expect(judge).not.toHaveBeenCalled();
    p.close();
  });
  it('an unclear embedding asks the judge with the closest topics first and their examples', async () => {
    const { dbFile, graph } = await fixture();
    const judge = vi.fn(async () => 'alpha');
    const p = placer(dbFile, embedding(v(1, 0.9, 0)), judge);
    expect(await p.pick(graph, '  titanik?  ')).toBe('Alpha'); // folded to the listed spelling
    expect(judge).toHaveBeenCalledWith({ question: 'titanik?', topics: [{ name: 'Alpha', examples: ['Frage zu Alpha', 'alpha a'] }, { name: 'Beta', examples: ['beta q', 'beta a'] }] });
    p.close();
  });
  it('NONE, an unlisted name, a slow or failing judge, or no judge → null', async () => {
    const { dbFile, graph } = await fixture();
    const tie = embedding(v(1, 1, 0));
    expect(await placer(dbFile, tie, async () => 'NONE').pick(graph, 'q')).toBeNull();
    expect(await placer(dbFile, tie, async () => 'Gamma').pick(graph, 'q')).toBeNull();
    expect(await placer(dbFile, tie, () => new Promise(() => undefined), { judgeTimeoutMs: 10 }).pick(graph, 'q')).toBeNull();
    expect(await placer(dbFile, tie, async () => { throw new Error('down'); }).pick(graph, 'q')).toBeNull();
    expect(await placer(dbFile, tie).pick(graph, 'q')).toBeNull();
  });
  it('without a usable embedding (failing, slow, wrong dimension, no index) the judge still decides', async () => {
    const { dbFile, graph } = await fixture();
    const judge = async () => 'Beta';
    expect(await placer(dbFile, async () => { throw new Error('down'); }, judge).pick(graph, 'q')).toBe('Beta');
    expect(await placer(dbFile, () => new Promise(() => undefined), judge, { embedTimeoutMs: 10 }).pick(graph, 'q')).toBe('Beta');
    expect(await placer(dbFile, embedding(v(1, 0)), judge).pick(graph, 'q')).toBe('Beta');
    expect(await placer(path.join(await tmpDir(), 'none.db'), embedding(v(1, 0, 0)), judge).pick(graph, 'q')).toBe('Beta');
  });
  it('empty text or a canvas without topics → null, nothing is called', async () => {
    const { dbFile, graph } = await fixture();
    const embed = vi.fn(embedding(v(1, 0, 0)));
    const judge = vi.fn(async () => 'Alpha');
    expect(await placer(dbFile, embed, judge).pick(graph, '  ')).toBeNull();
    for (const n of graph.nodes.values()) n.topics = [];
    expect(await placer(dbFile, embed, judge).pick(graph, 'q')).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('the judge prompt (spec M14)', () => {
  it('lists the topics with examples, then the question', () => {
    expect(placePrompt({ question: 'titanik?', topics: [{ name: 'Kaggle', examples: ['a', 'b'] }, { name: 'Pandas', examples: [] }] }))
      .toBe('Topics (with example summaries of messages filed there):\n- Kaggle: a | b\n- Pandas\n\nNew question:\ntitanik?');
  });
  it('parses a listed name (any spelling), NONE or anything else', () => {
    expect(parseJudgement('"kaggle titanic tutorial."', ['Kaggle-Titanic-Tutorial'])).toBe('Kaggle-Titanic-Tutorial');
    expect(parseJudgement('NONE', ['NONE-ish'])).toBeNull();
    expect(parseJudgement('None', ['A'])).toBeNull();
    expect(parseJudgement('Something new', ['A'])).toBeNull();
    expect(parseJudgement('', ['A'])).toBeNull();
  });
});

describe('POST messages places a new strand next to its topic (spec M14)', () => {
  const headers = { 'content-type': 'application/json' };
  const send = (app: ReturnType<typeof createApp>, parentIds: string[], content = 'neue Frage') =>
    app.request('/api/canvases/m/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds, content, model: 'claude-opus-5' }) });
  const layoutOf = async (res: Response) => (JSON.parse(/event: user-node\ndata: (.*)/.exec(await res.text())![1]!) as { layout: { x: number; y: number } }).layout;

  it('a new root lands right of the topic\'s cards; replies and unplaceable questions keep the old placement', async () => {
    const { root, graph, A1 } = await fixture();
    const pick = vi.fn(async (_graph: CanvasGraph, _text: string): Promise<string | null> => 'Alpha');
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['ok']), placer: { pick } });
    const alphaRight = Math.max(...[...graph.nodes.values()].filter((n) => n.topics[0] === 'Alpha').map((n) => graph.layout.get(n.id)!.x + graph.layout.get(n.id)!.width));
    expect(await layoutOf(await send(app, []))).toMatchObject({ x: alphaRight + NODE_GAP, y: 0 });
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick.mock.calls[0]![1]).toBe('neue Frage');
    await (await send(app, [A1])).text();
    expect(pick).toHaveBeenCalledTimes(1); // a reply never asks the placer

    pick.mockResolvedValue(null);
    const { canvases } = await readVault(root);
    const expected = placeChild(canvases[0]!, null);
    expect(await layoutOf(await send(app, []))).toMatchObject({ x: expected.x, y: expected.y });
  });
});
