import { promises as fs } from 'node:fs';
import path from 'node:path';
import { linearGraph, NOTE_HEADER, readCanvas, writeCanvas, type NodeDto } from '@chatmind/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { mockModel } from './mock-model';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

const headers = { 'content-type': 'application/json' };

async function vault() {
  const root = await tmpDir();
  const g = linearGraph('m', [{ role: 'user', content: 'Frage' }, { role: 'assistant', content: 'Antwort', model: 'claude-sonnet-4-6' }]);
  await writeCanvas(g, root);
  return { root, ids: [...g.nodes.keys()] };
}

const post = (app: ReturnType<typeof createApp>, body: unknown, slug = 'm') => app.request(`/api/canvases/${slug}/notes`, { method: 'POST', headers, body: JSON.stringify(body) });
const put = (app: ReturnType<typeof createApp>, id: string, body: unknown) => app.request(`/api/canvases/m/nodes/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) });

describe('POST /api/canvases/:slug/notes (spec M16 §3)', () => {
  it('writes a root note at `at`, without calling a model', async () => {
    const { root } = await vault();
    const app = createApp({ dataDir: root });
    const res = await post(app, { body: 'Vertragstext\n', at: { x: 1000.4, y: -200 } });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as NodeDto;
    expect(dto).toMatchObject({ role: 'note', parents: [], body: 'Vertragstext', layout: { x: 1000, y: -200, width: 400, height: 200 } }); // free there: taken as given
    const file = await fs.readFile(path.join(root, 'm', 'nodes', `${dto.id}.md`), 'utf8');
    expect(file).toContain('role: note\nparents: []');
    const { graph } = (await readCanvas(root, 'm'))!;
    expect(graph.nodes.get(dto.id)?.role).toBe('note');
    expect(graph.layout.get(dto.id)).toEqual(dto.layout);
  });

  it('a wanted spot on top of a card moves to the nearest free one', async () => {
    const { root } = await vault();
    const dto = (await (await post(createApp({ dataDir: root }), { body: 'x', at: { x: 10, y: 10 } })).json()) as NodeDto;
    const { graph } = (await readCanvas(root, 'm'))!;
    const others = [...graph.layout].filter(([id]) => id !== dto.id).map(([, l]) => l);
    expect(others.some((l) => dto.layout.x < l.x + l.width + 40 && l.x - 40 < dto.layout.x + 400 && dto.layout.y < l.y + l.height + 40 && l.y - 40 < dto.layout.y + 200)).toBe(false);
  });

  it('without `at` it takes the next free root slot', async () => {
    const { root } = await vault();
    const dto = (await (await post(createApp({ dataDir: root }), { body: 'x' })).json()) as NodeDto;
    expect(dto.layout.x).not.toBe(0); // the existing strand sits at x = 0
  });

  it('validates body, size, `at` and the canvas', async () => {
    const { root } = await vault();
    const app = createApp({ dataDir: root });
    expect((await post(app, { body: '  ' })).status).toBe(400);
    expect((await post(app, { body: 'x'.repeat(400_001) })).status).toBe(400);
    expect((await post(app, { body: 'x', at: { x: 'a', y: 0 } })).status).toBe(400);
    expect((await post(app, { body: 'x' }, 'nope')).status).toBe(404);
  });
});

describe('PUT /api/canvases/:slug/nodes/:id (spec M16 §3)', () => {
  it('rewrites a note body against its base and refuses a stale base with the current body', async () => {
    const { root } = await vault();
    const app = createApp({ dataDir: root });
    const note = (await (await post(app, { body: 'alt' })).json()) as NodeDto;
    const ok = await put(app, note.id, { body: 'neu', base: 'alt' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as NodeDto).body).toBe('neu');
    expect((await readCanvas(root, 'm'))!.graph.nodes.get(note.id)!.body).toBe('neu');
    const stale = await put(app, note.id, { body: 'x', base: 'alt' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'the card changed meanwhile', body: 'neu' });
  });

  it('404s an unknown node and 400s a bad body (every role is editable since M17)', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root });
    expect((await put(app, '01JQ8F9ZZZZZZZZZZZZZZZZZZZ', { body: 'x', base: '' })).status).toBe(404);
    expect((await put(app, ids[0]!, { body: 1, base: '' })).status).toBe(400);
  });
});

describe('asking about a note (spec M16 §4)', () => {
  it('the note enters the prompt under its header', async () => {
    const { root } = await vault();
    const model = mockModel(['ok']);
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => model });
    const note = (await (await post(app, { body: 'The contract says three months.' })).json()) as NodeDto;
    const res = await app.request('/api/canvases/m/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [note.id], content: 'What is the notice period?', model: 'claude-opus-5' }) });
    await res.text();
    const users = model.doStreamCalls[0]!.prompt.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    expect(users[0]).toContain(`${NOTE_HEADER.en}\\n\\nThe contract says three months.`);
    expect(users[1]).toContain('What is the notice period?');
  });
});
