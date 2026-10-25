import { promises as fs } from 'node:fs';
import path from 'node:path';
import { linearGraph, readVault, writeCanvas } from '@chatmind/core';
import type { IndexStatus } from '@chatmind/index';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, resolveStaticPath } from '../src/app';
import { mockModel } from './mock-model';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function vaultWithCanvas(): Promise<string> {
  const root = await tmpDir();
  const g = linearGraph('masterarbeit', [
    { role: 'user', content: 'Frage', summary: 'Ursprungsfrage' },
    { role: 'assistant', content: 'Antwort', model: 'claude-sonnet-4-6' },
  ]);
  await writeCanvas(g, root);
  return root;
}

describe('GET /api/canvases', () => {
  it('lists canvases with node counts', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    const res = await app.request('/api/canvases');
    expect(res.status).toBe(200);
    expect(await json<{ slug: string; nodeCount: number }[]>(res)).toEqual([{ slug: 'masterarbeit', nodeCount: 2 }]);
  });

  it('returns [] for an empty data dir and for a missing one', async () => {
    const empty = createApp({ dataDir: await tmpDir() });
    expect(await (await empty.request('/api/canvases')).json()).toEqual([]);
    const missing = createApp({ dataDir: path.join(await tmpDir(), 'nope') });
    expect(await (await missing.request('/api/canvases')).json()).toEqual([]);
  });
});

describe('GET /api/canvases/:slug', () => {
  it('returns the canvas dto', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    const res = await app.request('/api/canvases/masterarbeit');
    expect(res.status).toBe(200);
    const dto = await json<{
      slug: string;
      nodes: { summary: string; layout: unknown }[];
      edges: unknown[];
      repairs: unknown[];
    }>(res);
    expect(dto.slug).toBe('masterarbeit');
    expect(dto.nodes).toHaveLength(2);
    expect(dto.nodes[0]!.summary).toBe('Ursprungsfrage');
    expect(dto.nodes[0]!.layout).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(dto.edges).toHaveLength(1);
    expect(dto.repairs).toEqual([]);
  });

  it('404s for an unknown slug', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    const res = await app.request('/api/canvases/unknown');
    expect(res.status).toBe(404);
    expect(await json<{ error: string }>(res)).toEqual({ error: 'canvas not found' });
  });
});

describe('static frontend', () => {
  it('serves files from staticDir and falls back to index.html', async () => {
    const dist = await tmpDir();
    await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>chatmind</title>');
    await fs.mkdir(path.join(dist, 'assets'));
    await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
    const app = createApp({ dataDir: await tmpDir(), staticDir: dist });
    expect(await (await app.request('/assets/app.js')).text()).toBe('console.log(1)');
    expect(await (await app.request('/')).text()).toContain('<title>chatmind</title>');
    expect(await (await app.request('/some/client/route')).text()).toContain('<title>chatmind</title>');
    expect((await app.request('/api/canvases/unknown')).status).toBe(404); // API still wins
  });

  it('does not serve anything static without staticDir', async () => {
    const app = createApp({ dataDir: await tmpDir() });
    expect((await app.request('/')).status).toBe(404);
  });

  it('404s an unknown /api/* path instead of falling back to the SPA shell', async () => {
    const dist = await tmpDir();
    await fs.writeFile(path.join(dist, 'index.html'), '<title>ok</title>');
    const app = createApp({ dataDir: await tmpDir(), staticDir: dist });
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await json<{ error: string }>(res)).toEqual({ error: 'not found' });
  });

  it('404s an unknown /api/* path even without staticDir', async () => {
    const app = createApp({ dataDir: await tmpDir() });
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await json<{ error: string }>(res)).toEqual({ error: 'not found' });
  });

  it('falls back to the index.html shell for percent-encoded traversal-shaped requests, never a 500', async () => {
    const dist = await tmpDir();
    await fs.writeFile(path.join(dist, 'index.html'), '<title>ok</title>');
    const app = createApp({ dataDir: await tmpDir(), staticDir: dist });
    for (const p of ['/%2e%2e/index.html', '/..%2findex.html']) {
      const res = await app.request(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>ok</title>');
    }
  });

  it('does not leak a file one level above staticDir for a percent-encoded traversal request', async () => {
    const dist = await tmpDir();
    await fs.writeFile(path.join(dist, 'index.html'), '<title>ok</title>');
    const secretName = `chatmind-secret-${process.pid}.txt`;
    const secretContent = 'top secret vault contents';
    await fs.writeFile(path.join(dist, '..', secretName), secretContent);
    const app = createApp({ dataDir: await tmpDir(), staticDir: dist });
    const res = await app.request(`/%2e%2e/${secretName}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(secretContent);
    expect(body).toContain('<title>ok</title>');
  });
});

describe('GET /api/models', () => {
  it('lists models with availability from injected keys', async () => {
    const app = createApp({ dataDir: await tmpDir(), keys: { anthropic: 'k' } });
    const list = await json<{ id: string; provider: string; available: boolean }[]>(await app.request('/api/models'));
    expect(list.find((m) => m.id === 'claude-opus-5')).toMatchObject({ provider: 'anthropic', available: true });
    expect(list.filter((m) => m.provider !== 'anthropic').every((m) => !m.available)).toBe(true);
  });
});

describe('POST /api/canvases', () => {
  it('creates an empty canvas from a name and returns 201', async () => {
    const root = await tmpDir();
    const app = createApp({ dataDir: root });
    const res = await app.request('/api/canvases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Python lernen' }) });
    expect(res.status).toBe(201);
    expect(await json<unknown>(res)).toEqual({ slug: 'python-lernen', nodeCount: 0 });
    expect(await fs.readFile(path.join(root, 'python-lernen', 'graph.canvas'), 'utf8')).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}');
    expect((await fs.stat(path.join(root, 'python-lernen', 'nodes'))).isDirectory()).toBe(true);
    expect(await json<unknown>(await app.request('/api/canvases'))).toEqual([{ slug: 'python-lernen', nodeCount: 0 }]);
  });
  it('rejects empty/invalid names and existing canvases', async () => {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root });
    const post = (name: unknown) => app.request('/api/canvases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    expect((await post('???')).status).toBe(400);
    expect((await post('')).status).toBe(400);
    expect((await post(42)).status).toBe(400);
    const dup = await post('Masterarbeit');
    expect(dup.status).toBe(409);
    expect(await json<unknown>(dup)).toEqual({ error: 'canvas exists' });
  });
  it('serialises concurrent creates of the same name: one 201, one 409', async () => {
    const app = createApp({ dataDir: await tmpDir() });
    const post = () => app.request('/api/canvases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Race' }) });
    const statuses = (await Promise.all([post(), post(), post()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
  });
});

describe('cross-site POST protection', () => {
  it('rejects a POST with no content-type header', async () => {
    const app = createApp({ dataDir: await tmpDir() });
    const res = await app.request('/api/canvases', { method: 'POST', body: JSON.stringify({ name: 'Race' }) });
    expect(res.status).toBe(415);
  });

  it('rejects a POST whose content-type is not application/json (a no-cors cross-site fetch cannot set this)', async () => {
    const app = createApp({ dataDir: await tmpDir() });
    const res = await app.request('/api/canvases', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: 'Race' }) });
    expect(res.status).toBe(415);
  });

  it('rejects a POST with an Origin header from another site', async () => {
    const app = createApp({ dataDir: await tmpDir() });
    const res = await app.request('/api/canvases', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ name: 'Race' }) });
    expect(res.status).toBe(403);
  });

  it('allows a POST with an Origin header from localhost', async () => {
    const app = createApp({ dataDir: await tmpDir() });
    const res = await app.request('/api/canvases', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: JSON.stringify({ name: 'Race' }) });
    expect(res.status).toBe(201);
  });
});

describe('resolveStaticPath', () => {
  const root = '/srv/dist';

  it('resolves paths inside root', () => {
    expect(resolveStaticPath(root, '/assets/app.js')).toBe('/srv/dist/assets/app.js');
    expect(resolveStaticPath(root, '/')).toBe('/srv/dist');
  });

  it('rejects every way of leaving root', () => {
    for (const p of ['/../secret', '/a/../../secret', '/..%2Fsecret', '/%2e%2e/secret', '/..%2f..%2fetc/passwd']) {
      expect(resolveStaticPath(root, p)).toBeNull();
    }
  });

  it('rejects the sibling-prefix trick', () => {
    expect(resolveStaticPath(root, '/../dist-evil/x')).toBeNull();
  });

  it('returns null on malformed percent-encoding', () => {
    expect(resolveStaticPath(root, '/%E0%A4%A')).toBeNull();
  });
});

/** Parse a whole SSE body into [event, data] pairs. */
function parseSse(text: string): { event: string; data: unknown }[] {
  return text.split('\n\n').filter((b) => b.trim() !== '').map((block) => {
    const event = /^event: (.*)$/m.exec(block)![1]!;
    const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    return { event, data: JSON.parse(data) };
  });
}

describe('POST /api/canvases/:slug/messages', () => {
  const headers = { 'content-type': 'application/json' };
  async function appWithModel(deltas: string[]) {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(deltas) });
    const dto = await json<{ nodes: { id: string; role: string }[] }>(await app.request('/api/canvases/masterarbeit'));
    return { root, app, lastId: dto.nodes.at(-1)!.id };
  }

  it('writes the user node, streams the assistant, writes it, and returns the event sequence', async () => {
    const { root, app, lastId } = await appWithModel(['Hi', ' there']);
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [lastId], content: 'Und weiter?', model: 'claude-opus-5' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['user-node', 'assistant-start', 'delta', 'delta', 'done']);
    const user = events[0]!.data as { id: string; role: string; parents: string[]; body: string; layout: { x: number; y: number } };
    expect(user).toMatchObject({ role: 'user', parents: [lastId], body: 'Und weiter?' });
    const start = events[1]!.data as { id: string; model: string; parents: string[]; layout: { y: number } };
    expect(start).toMatchObject({ model: 'claude-opus-5', parents: [user.id] });
    expect(start.layout.y).toBe(user.layout.y + 280);
    expect(events[2]!.data).toEqual({ text: 'Hi' });
    const done = events[4]!.data as { id: string; body: string; model: string };
    expect(done).toMatchObject({ id: start.id, body: 'Hi there', model: 'claude-opus-5' });
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.get(done.id)?.parents).toEqual([user.id]);
    expect(canvases[0]!.nodes.get(user.id)?.parents).toEqual([lastId]);
  });

  it('creates a root message when parentIds is empty', async () => {
    const { app } = await appWithModel(['ok']);
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [], content: 'Neu', model: 'claude-opus-5' }) });
    const events = parseSse(await res.text());
    expect((events[0]!.data as { parents: string[] }).parents).toEqual([]);
    // a new strand starts in the top row, right of the existing one
    expect((events[0]!.data as { layout: { x: number; y: number } }).layout).toMatchObject({ x: 480, y: 0 });
  });

  it('validates input', async () => {
    const { app, lastId } = await appWithModel(['x']);
    const post = (body: unknown, slug = 'masterarbeit') => app.request(`/api/canvases/${slug}/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ parentIds: [lastId], content: 'x', model: 'claude-opus-5' }, 'nope')).status).toBe(404);
    expect((await post({ parentIds: [lastId], content: '   ', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentIds: [lastId], content: 'x', model: 'unknown-model' })).status).toBe(400);
    expect((await post({ parentIds: [lastId], content: 'x', model: 'claude-sonnet-5' })).status).toBe(200);
    expect((await post({ parentIds: ['01JQ8F9ZZZZZZZZZZZZZZZZZZZ'], content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post('junk')).status).toBe(400);
  });

  it('rejects a model whose provider key is missing', async () => {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root, keys: {}, modelFactory: () => mockModel(['x']) });
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [], content: 'x', model: 'claude-opus-5' }) });
    expect(res.status).toBe(400);
    expect(await json<unknown>(res)).toEqual({ error: 'model claude-opus-5 is not available (missing anthropic API key)' });
  });

  it('still delivers user-node/assistant-start/error when the completion fails before the handler subscribes (fast provider failure)', async () => {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel([], { failAfter: true }) });
    const dto = await json<{ nodes: { id: string }[] }>(await app.request('/api/canvases/masterarbeit'));
    const lastId = dto.nodes.at(-1)!.id;
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [lastId], content: 'Und weiter?', model: 'claude-opus-5' }) });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['user-node', 'assistant-start', 'error']);
    expect(events[2]!.data).toMatchObject({ partial: false });
  });

  it('two concurrent sends to the same canvas both keep their user node (lock)', async () => {
    const { root, app, lastId } = await appWithModel(['ok']);
    const before = (await readVault(root)).canvases[0]!.nodes.size;
    const post = (content: string) => app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [lastId], content, model: 'claude-opus-5' }) });
    const [r1, r2] = await Promise.all([post('one'), post('two')]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const [events1, events2] = await Promise.all([r1.text().then(parseSse), r2.text().then(parseSse)]);
    const newIds = [...events1, ...events2].filter((e) => e.event === 'user-node' || e.event === 'done').map((e) => (e.data as { id: string }).id);
    expect(newIds).toHaveLength(4);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.size).toBe(before + 4);
    const canvasFile = await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8');
    for (const id of newIds) expect(canvasFile).toContain(id);
  });

  it('keeps the completion running to persist the full answer even after the HTTP request is aborted', async () => {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['one', 'two', 'three'], { delayMs: 20 }) });
    const dto = await json<{ nodes: { id: string }[] }>(await app.request('/api/canvases/masterarbeit'));
    const lastId = dto.nodes.at(-1)!.id;
    const beforeIds = new Set(dto.nodes.map((n) => n.id));
    const controller = new AbortController();
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [lastId], content: 'Und weiter?', model: 'claude-opus-5' }), signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // first chunk (user-node), so the completion has definitely started
    controller.abort();
    await reader.cancel().catch(() => undefined); // in-process fallback: cancelling the reader triggers Hono's stream.abort()
    // The completion must keep running server-side and persist the full text despite the abort.
    const deadline = Date.now() + 1000;
    let body: string | undefined;
    while (Date.now() < deadline) {
      const { canvases } = await readVault(root);
      const node = [...canvases[0]!.nodes.values()].find((n) => n.role === 'assistant' && !beforeIds.has(n.id));
      if (node) { body = node.body; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(body).toBe('onetwothree');
  });

  /** R(user) → A(assistant) → U1(user) ; R → U2(user): two sibling branches under A's chain. */
  async function appWithBranches(deltas: string[]) {
    const root = await tmpDir();
    const g = linearGraph('masterarbeit', [
      { role: 'user', content: 'Frage', summary: 'Ursprungsfrage' },
      { role: 'assistant', content: 'Antwort', model: 'claude-sonnet-4-6' },
      { role: 'user', content: 'Gliederung bitte', summary: 'Gliederung' },
    ]);
    const [R, A, U1] = [...g.nodes.keys()];
    // NOTE: the brief's literal ends in 'U', which ULID_RE (Crockford Base32) excludes — it fails to
    // round-trip through the vault (frontmatter.ts: isUlid → 'missing or invalid id' repair). Using 'A'.
    const U2 = '01JQ8F7000000000000000000A';
    g.nodes.set(U2, { id: U2, role: 'user', parents: [R!], created: '2026-09-13T10:00:00Z', summary: 'Inhalt', topics: [], body: 'Inhaltliches Brainstorming' });
    g.layout.set(U2, { x: 480, y: 280, width: 400, height: 200 });
    await writeCanvas(g, root);
    const factory = mockModel(deltas);
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => factory });
    return { root, app, R: R!, A: A!, U1: U1!, U2, factory };
  }

  it('merges two targets: user node has both parents, canvas has both edges, model gets the block prompt', async () => {
    const { root, app, U1, U2, factory } = await appWithBranches(['ok']);
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [U1, U2], excludedIds: [], content: 'Combine both into a structure.', model: 'claude-opus-5' }) });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['user-node', 'assistant-start', 'delta', 'done']);
    const user = events[0]!.data as { id: string; parents: string[] };
    expect(user.parents).toEqual([U1, U2]);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.get(user.id)!.parents).toEqual([U1, U2]);
    const canvasFile = await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8');
    expect(canvasFile).toContain(`"id":"e-${U1}-${user.id}"`);
    expect(canvasFile).toContain(`"id":"e-${U2}-${user.id}"`);
    // the prompt the model saw: prefix (R, A) as turns, then one user turn with both blocks
    // prefix = [R] only (A and U1 are below the LCA), so: R as a turn, then one user turn with both blocks.
    // The AI SDK puts `system` into the prompt as a leading system message — dropped here.
    const call = factory.doStreamCalls[0]!;
    const texts = call.prompt.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, text: Array.isArray(m.content) ? m.content.map((p) => ('text' in p ? p.text : '')).join('') : String(m.content) }));
    expect(texts.map((t) => t.role)).toEqual(['user', 'user']);
    expect(texts[0]!.text).toBe('Frage');
    expect(texts[1]!.text).toContain('## Gliederung\n**Assistant:** Antwort\n\n**User:** Gliederung bitte');
    expect(texts[1]!.text).toContain('## Inhalt\n**User:** Inhaltliches Brainstorming');
    expect(texts[1]!.text.endsWith('Combine both into a structure.')).toBe(true);
  });

  it('honours excludedIds', async () => {
    const { app, R, U1, U2, factory } = await appWithBranches(['ok']);
    await (await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [U1, U2], excludedIds: [R], content: 'go', model: 'claude-opus-5' }) })).text();
    const roles = factory.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system').map((m) => m.role);
    expect(roles).toEqual(['user']); // R dropped from the prefix — only the merge turn remains
  });

  it('rejects invalid target sets with 400', async () => {
    const { app, R, A, U1, U2 } = await appWithBranches(['ok']);
    const post = (body: unknown) => app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ parentIds: [A, U1], content: 'x', model: 'claude-opus-5' })).status).toBe(400);           // A is an ancestor of U1
    expect((await post({ parentIds: [U1, '01JQ8F9ZZZZZZZZZZZZZZZZZZZ'], content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentIds: [U1, U1], content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentIds: [U1, U2], excludedIds: [U1], content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentIds: [U1], excludedIds: [U2], content: 'x', model: 'claude-opus-5' })).status).toBe(400); // U2 not in U1's context
    expect((await post({ parentIds: 'nope', content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentIds: [U1], excludedIds: 'nope', content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ content: 'x', model: 'claude-opus-5' })).status).toBe(400);                                  // parentIds missing (no parentId fallback)
    expect((await post({ parentIds: [R], content: 'x', model: 'claude-opus-5' })).status).toBe(200);
  });
});

function fakeWatcher() {
  const listeners = new Set<(slugs: string[]) => void>();
  return {
    onChange(l: (slugs: string[]) => void) { listeners.add(l); return () => listeners.delete(l); },
    emit(slugs: string[]) { for (const l of listeners) l(slugs); },
    size: () => listeners.size,
  };
}

async function readUntil(body: ReadableStream<Uint8Array>, needle: string): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (!buf.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  await reader.cancel();
  return buf;
}

describe('GET /api/events (spec M5 §7)', () => {
  it('streams vault-changed events from the watcher', async () => {
    const watcher = fakeWatcher();
    const app = createApp({ dataDir: await vaultWithCanvas(), watcher });
    const res = await app.request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await new Promise((r) => setTimeout(r, 10)); // handler subscribed
    expect(watcher.size()).toBe(1);
    watcher.emit(['masterarbeit']);
    const text = await readUntil(res.body!, '\n\n');
    expect(text).toContain('event: vault-changed\ndata: {"slugs":["masterarbeit"]}');
  });

  it('opens without a watcher and only sends keep-alives', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    const res = await app.request('/api/events');
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });
});

describe('GET /api/index/status', () => {
  it('reports disabled without an indexer', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    expect(await json<IndexStatus>(await app.request('/api/index/status'))).toEqual({ enabled: false, running: false, lastRun: null, pending: { embed: 0, summarize: 0, topics: 0, memories: 0 } });
  });
  it('passes the indexer status through', async () => {
    const status: IndexStatus = { enabled: true, running: true, lastRun: null, pending: { embed: 2, summarize: 1, topics: 0, memories: 0 } };
    const app = createApp({ dataDir: await vaultWithCanvas(), indexer: { status: () => status } });
    expect(await json<IndexStatus>(await app.request('/api/index/status'))).toEqual(status);
  });
});

describe('PATCH /api/canvases/:slug/layout (spec M8 §4.2)', () => {
  const headers = { 'content-type': 'application/json' };
  it('moves only x/y of known nodes and reports the ignored ids', async () => {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root });
    const [q, a] = (await readVault(root)).canvases[0]!.layout.keys();
    const qBefore = (await readVault(root)).canvases[0]!.layout.get(q!);
    const before = await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8');
    const res = await app.request('/api/canvases/masterarbeit/layout', { method: 'PATCH', headers, body: JSON.stringify({ positions: { [a!]: { x: 700.4, y: -20 }, nope: { x: 0, y: 0 } } }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: ['nope'] });
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.layout.get(a!)).toEqual({ x: 700, y: -20, width: 400, height: 200 });
    const after = await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8');
    expect(JSON.parse(after).nodes.map((n: { id: string }) => n.id)).toEqual(JSON.parse(before).nodes.map((n: { id: string }) => n.id));
    expect(canvases[0]!.layout.get(q!)).toEqual(qBefore);
  });

  it('validates', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    const patch = (body: unknown, slug = 'masterarbeit') => app.request(`/api/canvases/${slug}/layout`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    expect((await patch({ positions: { a: { x: '1', y: 0 } } })).status).toBe(400);
    expect((await patch({ positions: [] })).status).toBe(400);
    expect((await patch({ positions: {} }, 'nope')).status).toBe(404);
  });
});

describe('POST /api/canvases/:slug/delete (spec M8 §5.3)', () => {
  const headers = { 'content-type': 'application/json' };
  async function fourTurns() {
    const root = await tmpDir();
    const g = linearGraph('masterarbeit', [
      { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1', model: 'claude-sonnet-4-6' },
      { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2', model: 'claude-sonnet-4-6' },
      { role: 'user', content: 'Q3' }, { role: 'assistant', content: 'A3', model: 'claude-sonnet-4-6' },
    ]);
    await writeCanvas(g, root);
    return { root, ids: [...g.nodes.keys()].sort() };
  }

  it('deletes a middle turn into .trash/ and reconnects the chain', async () => {
    const { root, ids } = await fourTurns();
    const app = createApp({ dataDir: root });
    const res = await app.request('/api/canvases/masterarbeit/delete', { method: 'POST', headers, body: JSON.stringify({ ids: [ids[3]] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: [ids[2], ids[3]], reparented: [ids[4]] });
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.size).toBe(4);
    expect(canvases[0]!.nodes.get(ids[4]!)!.parents).toEqual([ids[1]]);
    expect((await fs.readdir(path.join(root, '.trash'))).length).toBe(2);
  });

  it('404s unknown ids and canvases, 400s a bad body, and changes nothing', async () => {
    const { root, ids } = await fourTurns();
    const app = createApp({ dataDir: root });
    const del = (body: unknown, slug = 'masterarbeit') => app.request(`/api/canvases/${slug}/delete`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await del({ ids: [ids[0], 'nope'] })).status).toBe(404);
    expect((await del({ ids: [ids[0]] }, 'nope')).status).toBe(404);
    expect((await del({ ids: [] })).status).toBe(400);
    expect((await readVault(root)).canvases[0]!.nodes.size).toBe(6);
  });

  it('409s while the turn is still streaming', async () => {
    const { root, ids } = await fourTurns();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['a', 'b', 'c'], { delayMs: 50 }) });
    const send = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [ids[5]], content: 'Q4', model: 'claude-opus-5' }) });
    const now = [...(await readVault(root)).canvases[0]!.nodes.keys()].sort();
    expect(now.length).toBe(7); // the user node is on disk, its answer still streams
    const user = now.at(-1)!;
    const res = await app.request('/api/canvases/masterarbeit/delete', { method: 'POST', headers, body: JSON.stringify({ ids: [user] }) });
    expect(res.status).toBe(409);
    await send.text();
    const after = await app.request('/api/canvases/masterarbeit/delete', { method: 'POST', headers, body: JSON.stringify({ ids: [user] }) });
    expect(after.status).toBe(200);
    expect((await json<{ deleted: string[] }>(after)).deleted.length).toBe(2);
  });
});

describe('POST /api/canvases/:slug/compress (spec M11 §5)', () => {
  const headers = { 'content-type': 'application/json' };
  async function longVault(): Promise<string> {
    const root = await tmpDir();
    const turns = [1, 2, 3, 4].flatMap((i) => [{ role: 'user' as const, content: `Frage ${i}` }, { role: 'assistant' as const, content: `Antwort ${i}`, model: 'claude-sonnet-4-6' }]);
    await writeCanvas(linearGraph('masterarbeit', turns), root);
    return root;
  }
  const reply = JSON.stringify({ sections: [{ section: 1, turns: [{ covers: [1, 2], question: 'Frage 1+2', answer: 'Antwort 1+2' }, { covers: [3, 4], question: 'Frage 3+4', answer: 'Antwort 3+4' }] }] });

  it('replaces the run with the model\'s turns and trashes the originals', async () => {
    const root = await longVault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel([reply]) });
    const ids = [...(await readVault(root)).canvases[0]!.nodes.keys()].sort();
    const res = await app.request('/api/canvases/masterarbeit/compress', { method: 'POST', headers, body: JSON.stringify({ ids, model: 'claude-opus-5' }) });
    expect(res.status).toBe(200);
    const out = await json<{ removed: string[]; added: string[]; replacement: Record<string, string> }>(res);
    expect(out.removed.sort()).toEqual(ids);
    expect(out.added).toHaveLength(4);
    expect(out.replacement[ids[2]!]).toBe(out.added[0]);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    const all = [...canvases[0]!.nodes.values()];
    const nodes = [all.find((n) => n.parents.length === 0)!];
    for (let next; (next = all.find((n) => n.parents[0] === nodes[nodes.length - 1]!.id)); ) nodes.push(next);
    expect(nodes.map((n) => [n.role, n.body, n.parents.length])).toEqual([['user', 'Frage 1+2', 0], ['assistant', 'Antwort 1+2', 1], ['user', 'Frage 3+4', 1], ['assistant', 'Antwort 3+4', 1]]);
    expect(nodes[3]!.model).toBe('claude-opus-5');
    expect((await fs.readdir(path.join(root, '.trash'))).length).toBe(8);
  });

  it('writes nothing when the model reply is invalid', async () => {
    const root = await longVault();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(['not json']) });
    const ids = [...(await readVault(root)).canvases[0]!.nodes.keys()];
    const res = await app.request('/api/canvases/masterarbeit/compress', { method: 'POST', headers, body: JSON.stringify({ ids, model: 'claude-opus-5' }) });
    expect(res.status).toBe(502);
    expect((await json<{ error: string }>(res)).error).toMatch(/invalid compression: not JSON/);
    expect((await readVault(root)).canvases[0]!.nodes.size).toBe(8);
  });

  it('with fold, a dead end at a fork is folded; the kept branch hangs off the new answer', async () => {
    const root = await tmpDir();
    const g = linearGraph('masterarbeit', [1, 2].flatMap((i) => [{ role: 'user' as const, content: `Frage ${i}` }, { role: 'assistant' as const, content: `Antwort ${i}`, model: 'claude-sonnet-4-6' }]));
    const [, , , a2] = [...g.nodes.keys()];
    const dead = { id: '01JQ8F9000000000000000000A', role: 'user' as const, parents: [a2!], created: '2026-01-01T00:00:00Z', summary: '', topics: [], body: 'Nebenfrage' };
    const deadA = { id: '01JQ8F9000000000000000000B', role: 'assistant' as const, model: 'm', parents: [dead.id], created: '2026-01-01T00:00:00Z', summary: '', topics: [], body: 'Nebenantwort' };
    const cont = { ...dead, id: '01JQ8F9000000000000000000C', body: 'Weiter' };
    const contA = { ...deadA, id: '01JQ8F9000000000000000000D', parents: [cont.id], body: 'Weiter A' };
    [dead, deadA, cont, contA].forEach((n, i) => { g.nodes.set(n.id, n); g.layout.set(n.id, { x: 480 + (i >= 2 ? 480 : 0), y: 1120 + (i % 2) * 280, width: 400, height: 200 }); });
    await writeCanvas(g, root);
    let prompt = '';
    const model = mockModel([JSON.stringify({ sections: [{ section: 1, turns: [{ covers: [1, 2], question: 'Q', answer: 'A mit Nebenfrage' }] }] })]);
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => { const orig = model.doGenerate.bind(model); model.doGenerate = async (o) => { prompt = JSON.stringify(o.prompt); return orig(o); }; return model; } });
    const res = await app.request('/api/canvases/masterarbeit/compress', { method: 'POST', headers, body: JSON.stringify({ ids: [...g.nodes.keys()], model: 'claude-opus-5', fold: true }) });
    expect(res.status).toBe(200);
    expect(prompt).toContain('Side branch 1 after turn 2');
    const { removed, replacement } = await json<{ removed: string[]; replacement: Record<string, string> }>(res);
    expect(removed).toHaveLength(6);
    const back = (await readVault(root)).canvases[0]!;
    expect(back.nodes.get(cont.id)!.parents).toEqual([replacement[a2!]]);
  });

  it('400 for a single turn, 404 for an unknown node', async () => {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel([reply]) });
    const ids = [...(await readVault(root)).canvases[0]!.nodes.keys()];
    const short = await app.request('/api/canvases/masterarbeit/compress', { method: 'POST', headers, body: JSON.stringify({ ids, model: 'claude-opus-5' }) });
    expect(short.status).toBe(400);
    const unknown = await app.request('/api/canvases/masterarbeit/compress', { method: 'POST', headers, body: JSON.stringify({ ids: ['nope'], model: 'claude-opus-5' }) });
    expect(unknown.status).toBe(404);
  });
});

describe('images (spec M13)', () => {
  const headers = { 'content-type': 'application/json' };
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const png = { mediaType: 'image/png', data: PNG.toString('base64') };
  async function setup() {
    const root = await vaultWithCanvas();
    const model = mockModel(['ok']);
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => model });
    const dto = await json<{ nodes: { id: string }[] }>(await app.request('/api/canvases/masterarbeit'));
    const post = (body: unknown) => app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [dto.nodes.at(-1)!.id], model: 'claude-opus-5', ...(body as object) }) });
    return { root, app, model, post };
  }

  it('writes the images to attachments/, embeds them in the body and sends them to the model as image parts', async () => {
    const { root, app, model, post } = await setup();
    const res = await post({ content: 'Was ist das?', images: [png, png] });
    const events = parseSse(await res.text());
    const user = events[0]!.data as { id: string; body: string };
    const names = [...user.body.matchAll(/!\[\[(.+?)\]\]/g)].map((m) => m[1]!);
    expect(names).toHaveLength(2);
    expect(user.body).toBe(`Was ist das?\n\n![[${names[0]}]]\n![[${names[1]}]]`);
    expect(await fs.readFile(path.join(root, 'masterarbeit', 'attachments', names[0]!))).toEqual(PNG);
    const last = model.doStreamCalls[0]!.prompt.at(-1)!;
    expect(last.role).toBe('user');
    expect((last.content as { type: string; mediaType?: string }[]).map((p) => [p.type, p.mediaType])).toEqual([['text', undefined], ['file', 'image/png'], ['file', 'image/png']]);
    const img = await app.request(`/api/canvases/masterarbeit/attachments/${names[0]}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG);
  });

  it('accepts a message of images only', async () => {
    const { post } = await setup();
    const res = await post({ content: '', images: [png] });
    expect(res.status).toBe(200);
    const user = parseSse(await res.text())[0]!.data as { body: string };
    expect(user.body).toMatch(/^!\[\[[0-9A-Z]{26}\.png\]\]$/);
  });

  it('rejects bad images', async () => {
    const { post } = await setup();
    expect((await post({ content: 'x', images: [{ mediaType: 'image/svg+xml', data: 'AAAA' }] })).status).toBe(400);
    expect((await post({ content: 'x', images: [{ mediaType: 'image/png', data: 'not base64!' }] })).status).toBe(400);
    expect((await post({ content: 'x', images: Array(7).fill(png) })).status).toBe(400);
    expect((await post({ content: 'x', images: [{ mediaType: 'image/png', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }] })).status).toBe(400);
    expect((await post({ content: '', images: [] })).status).toBe(400);
  });

  it('serves only attachment names', async () => {
    const { app } = await setup();
    expect((await app.request('/api/canvases/masterarbeit/attachments/01JQ7M2V3X4Y5Z6A7B8C9D0E1F.png')).status).toBe(404);
    expect((await app.request('/api/canvases/masterarbeit/attachments/graph.canvas')).status).toBe(404);
    expect((await app.request('/api/canvases/../attachments/01JQ7M2V3X4Y5Z6A7B8C9D0E1F.png')).status).toBe(404);
  });
});
