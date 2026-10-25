import { promises as fs } from 'node:fs';
import path from 'node:path';
import { linearGraph, readCanvas, writeCanvas, writeMemory } from '@chatmind/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { mockModel } from './mock-model';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

const headers = { 'content-type': 'application/json' };

async function vault(turns = 1) {
  const root = await tmpDir();
  const g = linearGraph('m', Array.from({ length: turns }, (_, i) => [{ role: 'user' as const, content: `Frage ${i + 1}` }, { role: 'assistant' as const, content: `Antwort ${i + 1}`, model: 'claude-sonnet-4-6' }]).flat());
  for (const n of g.nodes.values()) n.topics = ['Pandas'];
  await writeCanvas(g, root);
  return { root, ids: [...g.nodes.keys()] };
}

describe('PUT /api/canvases/:slug/memories (spec M15 §5)', () => {
  const put = (app: ReturnType<typeof createApp>, body: unknown) => app.request('/api/canvases/m/memories', { method: 'PUT', headers, body: JSON.stringify(body) });

  it('creates a memory, updates it against its base, and refuses a stale base with the current body', async () => {
    const { root } = await vault();
    const app = createApp({ dataDir: root });
    const created = await put(app, { topic: 'Pandas', body: '- nutzt pandas 2', base: '' });
    expect(await created.json()).toEqual({ topic: 'Pandas', body: '- nutzt pandas 2', covered: 0 });
    expect(await fs.readFile(path.join(root, 'm', 'memories', 'pandas.md'), 'utf8')).toBe('---\ntopic: Pandas\ncovered: []\n---\n\n- nutzt pandas 2\n');
    expect((await put(app, { topic: 'pandas', body: '- nutzt pandas 2.2', base: '- nutzt pandas 2' })).status).toBe(200);
    const stale = await put(app, { topic: 'Pandas', body: 'x', base: '- nutzt pandas 2' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'the memory changed meanwhile', body: '- nutzt pandas 2.2' });
    const dto = (await (await app.request('/api/canvases/m')).json()) as { memories: unknown };
    expect(dto.memories).toEqual([{ topic: 'Pandas', body: '- nutzt pandas 2.2', covered: 0 }]);
  });
  it('validates the body and the canvas', async () => {
    const { root } = await vault();
    const app = createApp({ dataDir: root });
    expect((await put(app, { topic: '', body: 'x', base: '' })).status).toBe(400);
    expect((await put(app, { topic: 'T', body: 1, base: '' })).status).toBe(400);
    expect((await app.request('/api/canvases/nope/memories', { method: 'PUT', headers, body: JSON.stringify({ topic: 'T', body: 'x', base: '' }) })).status).toBe(404);
  });
});

describe('sending with memories (spec M15 §4)', () => {
  it('puts the chosen memories from the files into the system prompt; unknown topics are skipped', async () => {
    const { root, ids } = await vault();
    const { graph } = (await readCanvas(root, 'm'))!;
    await writeMemory(graph, { topic: 'Pandas', covered: [], body: '- nutzt pandas 2' }, root);
    const model = mockModel(['ok']);
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => model });
    const res = await app.request('/api/canvases/m/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [ids[1]], content: 'weiter', model: 'claude-opus-5', memoryTopics: ['pandas', 'Unbekannt'] }) });
    await res.text();
    const system = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system')!.content as string;
    expect(system).toContain('Memory of the topic "Pandas"');
    expect(system).toContain('- nutzt pandas 2');
    const bad = await app.request('/api/canvases/m/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [], content: 'x', model: 'claude-opus-5', memoryTopics: 'Pandas' }) });
    expect(bad.status).toBe(400);
  });
});

describe('compress keeps memories covered (spec M15 §3)', () => {
  it('a compressed turn whose originals were all covered joins covered', async () => {
    const { root, ids } = await vault(4);
    const { graph } = (await readCanvas(root, 'm'))!;
    const users = ids.filter((_, i) => i % 2 === 0); // Q1…Q4
    await writeMemory(graph, { topic: 'Pandas', covered: users.slice(0, 3), body: '- x' }, root); // Q4 not yet distilled
    const reply = JSON.stringify({ sections: [{ section: 1, turns: [{ covers: [1, 2], question: 'F12', answer: 'A12' }, { covers: [3, 4], question: 'F34', answer: 'A34' }] }] });
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel([reply]) });
    const res = await app.request('/api/canvases/m/compress', { method: 'POST', headers, body: JSON.stringify({ ids, model: 'claude-opus-5' }) });
    const out = (await res.json()) as { replacement: Record<string, string> };
    const m = (await readCanvas(root, 'm'))!.graph.memories![0]!;
    expect(m.covered).toEqual([...users.slice(0, 3), out.replacement[users[0]!]]); // F12 covered; F34 is not (Q4 was not)
  });
});
