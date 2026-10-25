import { promises as fs } from 'node:fs';
import path from 'node:path';
import { linearGraph, placeChild, readVault, VaultLock, writeCanvas, type MessageNode } from '@chatmind/core';
import { afterAll, describe, expect, it } from 'vitest';
import { startCompletion, type CompletionEvent } from '../src/completion';
import { mockModel } from './mock-model';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

async function seeded() {
  const root = await tmpDir();
  const g = linearGraph('masterarbeit', [{ role: 'user', content: 'Frage' }]);
  await writeCanvas(g, root);
  const parentId = [...g.nodes.keys()][0]!;
  const assistant: MessageNode = { id: '01JQ8F5A0B1C2D3E4F5G6H7JAA', role: 'assistant', model: 'claude-opus-5', parents: [parentId], created: '2026-09-12T10:00:00Z', summary: '', topics: [], body: '' };
  return { root, g, parentId, assistant, layout: placeChild(g, parentId) };
}

function collect(job: ReturnType<typeof startCompletion>): Promise<CompletionEvent[]> {
  return new Promise((resolve) => {
    const events: CompletionEvent[] = [];
    job.subscribe((e) => { events.push(e); if (e.type !== 'delta') resolve(events); });
  });
}

describe('startCompletion', () => {
  it('streams deltas, writes the node on completion, emits done with the NodeDto', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel(['Hel', 'lo']), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock: new VaultLock() });
    const events = await collect(job);
    expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'done']);
    const done = events[2] as Extract<CompletionEvent, { type: 'done' }>;
    expect(done.node).toMatchObject({ id: assistant.id, role: 'assistant', model: 'claude-opus-5', body: 'Hello', layout });
    await job.finished;
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.get(assistant.id)?.body).toBe('Hello');
    expect(await fs.readFile(path.join(root, 'masterarbeit', 'nodes', `${assistant.id}.md`), 'utf8')).toContain('model: claude-opus-5');
  });

  it('writes partial text and emits error when the provider fails mid-stream', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel(['part'], { failAfter: true }), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock: new VaultLock() });
    const events = await collect(job);
    expect(events.at(-1)).toEqual({ type: 'error', message: expect.stringContaining('provider exploded'), partial: true });
    await job.finished;
    expect((await readVault(root)).canvases[0]!.nodes.get(assistant.id)?.body).toBe('part');
  });

  it('writes nothing and emits error with partial=false when it fails before any text', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel([], { failAfter: true }), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock: new VaultLock() });
    const events = await collect(job);
    expect(events).toEqual([{ type: 'error', message: expect.any(String), partial: false }]);
    await job.finished;
    expect((await readVault(root)).canvases[0]!.nodes.has(assistant.id)).toBe(false);
  });

  it('writes nothing and emits error when the model finishes normally with no text at all', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel([]), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock: new VaultLock() });
    const events = await collect(job);
    expect(events).toEqual([{ type: 'error', message: 'the model returned no text', partial: false }]);
    await job.finished;
    expect((await readVault(root)).canvases[0]!.nodes.has(assistant.id)).toBe(false);
  });

  it('completes and persists with no subscriber at all (client gone)', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel(['x']), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock: new VaultLock() });
    await job.finished;
    expect((await readVault(root)).canvases[0]!.nodes.get(assistant.id)?.body).toBe('x');
  });

  it('replays earlier events to a late subscriber', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel(['a', 'b']), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock: new VaultLock() });
    await job.finished;
    const events = await collect(job);
    expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'done']);
  });

  it('subscribing after the job already failed still delivers the one error event, and unsubscribe is safe to call', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel([], { failAfter: true }), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock: new VaultLock() });
    await job.finished; // the job is already terminal before anyone subscribes
    const events: CompletionEvent[] = [];
    const unsubscribe = job.subscribe((e) => events.push(e));
    expect(events).toEqual([{ type: 'error', message: expect.any(String), partial: false }]);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('two concurrent completions both land in the canvas (lock)', async () => {
    const { root, g, parentId, layout } = await seeded();
    const lock = new VaultLock();
    const mk = (id: string): MessageNode => ({ id, role: 'assistant', model: 'claude-opus-5', parents: [parentId], created: '2026-09-12T10:00:00Z', summary: '', topics: [], body: '' });
    const l2 = { ...layout, x: layout.x + 480 };
    const j1 = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant: mk('01JQ8F5A0B1C2D3E4F5G6H7JAA'), layout, model: mockModel(['one'], { delayMs: 5 }), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock });
    const j2 = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant: mk('01JQ8F5B0B1C2D3E4F5G6H7JAA'), layout: l2, model: mockModel(['two'], { delayMs: 1 }), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock });
    await Promise.all([j1.finished, j2.finished]);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.size).toBe(g.nodes.size + 2);
  });
});
