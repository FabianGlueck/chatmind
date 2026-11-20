import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EXPLAIN_HEADER, linearGraph, readCanvas, writeCanvas, type NodeDto } from '@chatmind/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { mockModel } from './mock-model';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

const headers = { 'content-type': 'application/json' };
type App = ReturnType<typeof createApp>;

async function vault() {
  const root = await tmpDir();
  const g = linearGraph('m', [{ role: 'user', content: 'What is a centroid?' }, { role: 'assistant', content: 'The mean of the points in embedding space.', model: 'claude-sonnet-4-6' }]);
  await writeCanvas(g, root);
  return { root, ids: [...g.nodes.keys()] };
}

async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(root, { recursive: true, withFileTypes: true })) if (e.isFile()) out.push(`${path.relative(root, path.join(e.parentPath, e.name))}:${await fs.readFile(path.join(e.parentPath, e.name), 'utf8')}`);
  return out.sort();
}

function parseSse(text: string): { event: string; data: unknown }[] {
  return text.split('\n\n').filter((b) => b.trim() !== '').map((block) => ({ event: /^event: (.*)$/m.exec(block)![1]!, data: JSON.parse(block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')) }));
}

const explain = (app: App, id: string, body: unknown) => app.request(`/api/canvases/m/nodes/${id}/explain`, { method: 'POST', headers, body: JSON.stringify(body) });
const keep = (app: App, id: string, body: unknown) => app.request(`/api/canvases/m/nodes/${id}/explain/keep`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('POST …/explain (spec quick-explain §4)', () => {
  it('streams a short explanation, writes nothing, and prompts with the strand and the quoted spot', async () => {
    const { root, ids } = await vault();
    const model = mockModel(['An embedding ', 'is a vector.']);
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => model });
    const before = await snapshot(root);
    const res = await explain(app, ids[1]!, { selection: 'embedding space', passage: 'The mean of the points in embedding space.', exchange: [], ask: '', model: 'claude-opus-5-5' });
    expect(res.status).toBe(200);
    expect(parseSse(await res.text()).at(-1)).toEqual({ event: 'done', data: { text: 'An embedding is a vector.' } });
    expect(await snapshot(root)).toEqual(before);
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(prompt).toContain('What is a centroid?');
    expect(prompt).toContain(EXPLAIN_HEADER.en);
    expect(prompt).toContain('»embedding space«');
  });

  it('rejects an empty or too long selection, an unknown model and an unknown node', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['x']) });
    const ok = { selection: 'x', exchange: [], ask: '', model: 'claude-opus-5-5' };
    expect((await explain(app, ids[1]!, { ...ok, selection: '  ' })).status).toBe(400);
    expect((await explain(app, ids[1]!, { ...ok, selection: 'x'.repeat(501) })).status).toBe(400);
    expect((await explain(app, ids[1]!, { ...ok, exchange: [{ q: 1 }] })).status).toBe(400);
    expect((await explain(app, ids[1]!, { ...ok, model: 'nope' })).status).toBe(400);
    expect((await explain(app, 'NOPE', ok)).status).toBe(404);
  });
});

describe('POST …/explain/keep (spec quick-explain §5)', () => {
  it('writes the question below the card and the explanation as its answer, without a model call', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => { throw new Error('no model call'); } });
    const res = await keep(app, ids[1]!, { selection: 'embedding space', exchange: [{ q: '', a: 'A vector space.' }, { q: 'how many dimensions?', a: 'Often 1536.' }], model: 'claude-opus-5-5' });
    expect(res.status).toBe(201);
    const { nodes } = (await res.json()) as { nodes: NodeDto[] };
    expect(nodes).toHaveLength(4);
    const g = (await readCanvas(root, 'm'))!.graph;
    const [q1, a1, q2, a2] = nodes.map((n) => g.nodes.get(n.id)!);
    expect(q1).toMatchObject({ role: 'user', parents: [ids[1]], body: '»embedding space« — What does this mean here?' });
    expect(a1).toMatchObject({ role: 'assistant', parents: [q1!.id], model: 'claude-opus-5-5', body: 'A vector space.' });
    expect(q2).toMatchObject({ role: 'user', parents: [a1!.id], body: 'how many dimensions?' });
    expect(a2).toMatchObject({ role: 'assistant', parents: [q2!.id], body: 'Often 1536.' });
    for (const n of nodes) expect(g.layout.has(n.id)).toBe(true);
  });

  it('rejects an empty answer and an unknown card', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' } });
    expect((await keep(app, ids[1]!, { selection: 'x', exchange: [{ q: '', a: ' ' }], model: 'claude-opus-5-5' })).status).toBe(400);
    expect((await keep(app, ids[1]!, { selection: 'x', exchange: [], model: 'claude-opus-5-5' })).status).toBe(400);
    expect((await keep(app, 'NOPE', { selection: 'x', exchange: [{ q: '', a: 'a' }], model: 'claude-opus-5-5' })).status).toBe(404);
  });
});
