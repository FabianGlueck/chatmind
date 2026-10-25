import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EDIT_HEADER, EDIT_ROLE, linearGraph, readCanvas, writeCanvas, type NodeDto } from '@chatmind/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { mockModel } from './mock-model';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

const headers = { 'content-type': 'application/json' };
type App = ReturnType<typeof createApp>;

/** Spec M17: question → answer in canvas "m". */
async function vault() {
  const root = await tmpDir();
  const g = linearGraph('m', [{ role: 'user', content: 'What is a centroid?' }, { role: 'assistant', content: 'The mean of the points.', model: 'claude-sonnet-4-6' }]);
  await writeCanvas(g, root);
  return { root, ids: [...g.nodes.keys()] };
}

/** Every file under `root` (dot-entries included) as relative path → content. */
async function tree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    out.set(path.relative(root, abs), await fs.readFile(abs, 'utf8'));
  }
  return out;
}

async function nodeFile(root: string, id: string): Promise<string> {
  const dir = path.join(root, 'm', 'nodes');
  const name = (await fs.readdir(dir)).find((f) => f.startsWith(id))!;
  return fs.readFile(path.join(dir, name), 'utf8');
}
const frontmatter = (file: string): string => file.slice(0, file.indexOf('\n---\n') + 5);

function parseSse(text: string): { event: string; data: unknown }[] {
  return text.split('\n\n').filter((b) => b.trim() !== '').map((block) => {
    const event = /^event: (.*)$/m.exec(block)![1]!;
    const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    return { event, data: JSON.parse(data) };
  });
}

const put = (app: App, id: string, body: unknown) => app.request(`/api/canvases/m/nodes/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
const rewrite = (app: App, id: string, body: unknown, init: RequestInit = {}) => app.request(`/api/canvases/m/nodes/${id}/rewrite`, { method: 'POST', headers, body: JSON.stringify(body), ...init });

/** Starts a slow send below `parent`; resolves once the user and assistant ids are known. */
async function slowSend(app: App, parent: string) {
  const res = await app.request('/api/canvases/m/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [parent], content: 'Why the mean?', model: 'claude-opus-5' }) });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: assistant-start') || !text.slice(text.indexOf('event: assistant-start')).includes('\n\n')) text += decoder.decode((await reader.read()).value);
  const events = parseSse(text.slice(0, text.lastIndexOf('\n\n')));
  const user = (events.find((e) => e.event === 'user-node')!.data as NodeDto).id;
  const assistant = (events.find((e) => e.event === 'assistant-start')!.data as { id: string }).id;
  const finish = async (): Promise<void> => {
    while (!(await reader.read()).done);
  };
  return { user, assistant, finish };
}

describe('PUT /api/canvases/:slug/nodes/:id for every role (spec M17 §4)', () => {
  it('rewrites a question and an answer in place; the frontmatter stays byte-identical', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root });
    for (const [id, base] of [[ids[0]!, 'What is a centroid?'], [ids[1]!, 'The mean of the points.']] as const) {
      const before = await nodeFile(root, id);
      const res = await put(app, id, { body: `New text for ${id}.\n`, base });
      expect(res.status).toBe(200);
      expect(((await res.json()) as NodeDto).body).toBe(`New text for ${id}.`);
      const after = await nodeFile(root, id);
      expect(frontmatter(after)).toBe(frontmatter(before));
      expect(after.endsWith(`\nNew text for ${id}.\n`)).toBe(true);
    }
    const { graph } = (await readCanvas(root, 'm'))!;
    expect(graph.nodes.get(ids[1]!)!.parents).toEqual([ids[0]]);
  });

  it('a note still works', async () => {
    const { root } = await vault();
    const app = createApp({ dataDir: root });
    const note = (await (await app.request('/api/canvases/m/notes', { method: 'POST', headers, body: JSON.stringify({ body: 'alt' }) })).json()) as NodeDto;
    expect((await put(app, note.id, { body: 'neu', base: 'alt' })).status).toBe(200);
  });

  it('409 on a changed base, with the current body', async () => {
    const { root, ids } = await vault();
    const res = await put(createApp({ dataDir: root }), ids[1]!, { body: 'x', base: 'something else' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'the card changed meanwhile', body: 'The mean of the points.' });
  });

  it('an unchanged body is not written', async () => {
    const { root, ids } = await vault();
    const before = await tree(root);
    const res = await put(createApp({ dataDir: root }), ids[0]!, { body: 'What is a centroid?\n\n', base: 'What is a centroid?' });
    expect(res.status).toBe(200);
    expect(await tree(root)).toEqual(before);
  });

  it('400 empty or too large, 404 unknown', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root });
    expect((await put(app, ids[0]!, { body: '  ', base: 'What is a centroid?' })).status).toBe(400);
    expect((await put(app, ids[0]!, { body: 'x'.repeat(400_001), base: 'What is a centroid?' })).status).toBe(400);
    expect((await put(app, ids[0]!, { body: 1, base: '' })).status).toBe(400);
    expect((await put(app, '01JQ8F9ZZZZZZZZZZZZZZZZZZZ', { body: 'x', base: '' })).status).toBe(404);
  });

  it('409 while the card or its answer is streaming', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['a', 'b', 'c'], { delayMs: 50 }) });
    const send = await slowSend(app, ids[1]!);
    expect((await put(app, send.user, { body: 'x', base: 'Why the mean?' })).status).toBe(409);
    expect((await put(app, send.assistant, { body: 'x', base: '' })).status).toBe(409);
    await send.finish();
    expect((await put(app, send.user, { body: 'x', base: 'Why the mean?' })).status).toBe(200);
  });
});

describe('POST /api/canvases/:slug/nodes/:id/rewrite (spec M17 §4)', () => {
  it('streams deltas and a cleaned done, writes nothing, and prompts with the strand above, header and body', async () => {
    const { root, ids } = await vault();
    const model = mockModel(['<<<\nThe arithmetic ', 'mean of the points.\n', '>>>\n']);
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => model });
    const before = await tree(root);
    const res = await rewrite(app, ids[1]!, { instruction: 'say arithmetic mean', model: 'claude-opus-5' });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.filter((e) => e.event === 'delta').map((e) => (e.data as { text: string }).text).join('')).toBe('<<<\nThe arithmetic mean of the points.\n>>>\n');
    expect(events.at(-1)).toEqual({ event: 'done', data: { text: 'The arithmetic mean of the points.' } });
    expect(await tree(root)).toEqual(before);
    const prompt = model.doStreamCalls[0]!.prompt;
    const users = prompt.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    expect(users).toHaveLength(2);
    expect(users[0]).toContain('What is a centroid?');
    expect(users[1]).toContain(JSON.stringify(EDIT_HEADER.en.replace('{role}', EDIT_ROLE.en.assistant)).slice(1, -1));
    expect(users[1]).toContain('<<<\\nThe mean of the points.\\n>>>\\n\\nsay arithmetic mean');
  });

  it('a draft reaches the prompt instead of the body', async () => {
    const { root, ids } = await vault();
    const model = mockModel(['ok']);
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => model });
    await (await rewrite(app, ids[1]!, { instruction: 'shorter', model: 'claude-opus-5', draft: 'A previous preview.' })).text();
    const last = JSON.stringify(model.doStreamCalls[0]!.prompt.at(-1)!.content);
    expect(last).toContain('<<<\\nA previous preview.\\n>>>');
    expect(last).not.toContain('The mean of the points.');
  });

  it('validates model, instruction, draft and node', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['ok']) });
    expect((await rewrite(app, ids[1]!, { instruction: 'x', model: 'nope' })).status).toBe(400);
    expect((await rewrite(app, ids[1]!, { instruction: 'x', model: 'gpt-6-astra' })).status).toBe(400); // no openai key
    expect((await rewrite(app, ids[1]!, { instruction: '  ', model: 'claude-opus-5' })).status).toBe(400);
    expect((await rewrite(app, ids[1]!, { instruction: 'x', model: 'claude-opus-5', draft: 3 })).status).toBe(400);
    expect((await rewrite(app, '01JQ8F9ZZZZZZZZZZZZZZZZZZZ', { instruction: 'x', model: 'claude-opus-5' })).status).toBe(404);
    expect((await app.request(`/api/canvases/nope/nodes/${ids[1]}/rewrite`, { method: 'POST', headers, body: JSON.stringify({ instruction: 'x', model: 'claude-opus-5' }) })).status).toBe(404);
  });

  it('409 while the card is streaming', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['a', 'b', 'c'], { delayMs: 50 }) });
    const send = await slowSend(app, ids[1]!);
    expect((await rewrite(app, send.user, { instruction: 'x', model: 'claude-opus-5' })).status).toBe(409);
    expect((await rewrite(app, send.assistant, { instruction: 'x', model: 'claude-opus-5' })).status).toBe(409);
    await send.finish();
  });

  it('a failing model ends with error { message, partial }', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['half'], { failAfter: true }) });
    const before = await tree(root);
    const events = parseSse(await (await rewrite(app, ids[1]!, { instruction: 'x', model: 'claude-opus-5' })).text());
    expect(events.at(-1)).toEqual({ event: 'error', data: { message: 'provider exploded', partial: true } });
    expect(await tree(root)).toEqual(before);
  });

  it('an aborted request stops the model call', async () => {
    const { root, ids } = await vault();
    const model = mockModel(['a', 'b', 'c', 'd', 'e', 'f'], { delayMs: 50 });
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => model });
    const ac = new AbortController();
    const res = await rewrite(app, ids[1]!, { instruction: 'x', model: 'claude-opus-5' }, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(model.doStreamCalls[0]!.abortSignal?.aborted).toBe(true);
  });
});

const putSummary = (app: App, id: string, req: unknown) => app.request(`/api/canvases/m/nodes/${id}/summary`, { method: 'PUT', headers, body: JSON.stringify(req) });

describe('PUT /api/canvases/:slug/nodes/:id/summary (spec M17 §6)', () => {
  it('writes the summary as one line; body, parents and the rest of the frontmatter stay', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root });
    const before = await nodeFile(root, ids[1]!);
    const res = await putSummary(app, ids[1]!, { summary: '  Zentroid\n als Mittelwert ', base: '' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as NodeDto).summary).toBe('Zentroid als Mittelwert');
    const after = await nodeFile(root, ids[1]!);
    expect(after).toBe(before.replace("summary: ''", 'summary: Zentroid als Mittelwert'));
    const { graph } = (await readCanvas(root, 'm'))!;
    expect(graph.nodes.get(ids[1]!)!.summary).toBe('Zentroid als Mittelwert');
  });

  it('an empty summary clears it (the indexer writes a new one); an unchanged one is not written', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root });
    expect((await putSummary(app, ids[0]!, { summary: 'Frage', base: '' })).status).toBe(200);
    const before = await tree(root);
    expect((await putSummary(app, ids[0]!, { summary: ' Frage ', base: 'Frage' })).status).toBe(200);
    expect(await tree(root)).toEqual(before);
    const res = await putSummary(app, ids[0]!, { summary: '  ', base: 'Frage' });
    expect(((await res.json()) as NodeDto).summary).toBe('');
  });

  it('409 on a changed base with the current summary; 400 bad input or too long; 404 unknown', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root });
    const res = await putSummary(app, ids[0]!, { summary: 'x', base: 'old title' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'the summary changed meanwhile', summary: '' });
    expect((await putSummary(app, ids[0]!, { summary: 'x'.repeat(251), base: '' })).status).toBe(400);
    expect((await putSummary(app, ids[0]!, { summary: 1, base: '' })).status).toBe(400);
    expect((await putSummary(app, '01JQ8F9ZZZZZZZZZZZZZZZZZZZ', { summary: 'x', base: '' })).status).toBe(404);
  });

  it('409 while the card is streaming', async () => {
    const { root, ids } = await vault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['a', 'b', 'c'], { delayMs: 50 }) });
    const send = await slowSend(app, ids[1]!);
    expect((await putSummary(app, send.assistant, { summary: 'x', base: '' })).status).toBe(409);
    await send.finish();
  });
});
