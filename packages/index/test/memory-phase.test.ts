import { promises as fs } from 'node:fs';
import path from 'node:path';
import { linearGraph, readCanvas, VaultLock, writeCanvas, writeMemory, type CanvasGraph } from '@chatmind/core';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_TURNS_PER_CALL, dueTurns, isNone, memoryPrompt, parseMemoryBullets, runMemoryPhase, type MemoryInput } from '../src/memory-phase';
import { cleanupTmpDirs, tmpDir } from './helpers';

afterAll(cleanupTmpDirs);

/** Canvas `m`: turns Q1→A1→Q2→A2 on topic Pandas, then Q3 without an answer, and a root turn R→RA on topic Kaggle. */
async function vault(opts: { turns?: number } = {}) {
  const root = await tmpDir();
  const n = opts.turns ?? 2;
  const g: CanvasGraph = linearGraph('m', [...Array.from({ length: n }, (_, i) => [{ role: 'user' as const, content: `Frage ${i + 1}` }, { role: 'assistant' as const, content: `Antwort ${i + 1}` }]).flat(), { role: 'user', content: 'offen' }]);
  for (const node of g.nodes.values()) node.topics = ['Pandas'];
  const k = linearGraph('m', [{ role: 'user', content: 'Kaggle?' }, { role: 'assistant', content: 'Kaggle ist…' }]);
  for (const [id, node] of k.nodes) { node.topics = ['Kaggle']; g.nodes.set(id, node); g.layout.set(id, { ...k.layout.get(id)!, x: 2000 }); }
  await writeCanvas(g, root);
  return { root, ids: [...g.nodes.keys()] };
}
const graphOf = async (root: string) => (await readCanvas(root, 'm'))!.graph;
function writer(answer: (i: MemoryInput) => string | Promise<string>) {
  const calls: MemoryInput[] = [];
  const w = async (i: MemoryInput) => { calls.push(i); return answer(i); };
  return Object.assign(w, { calls });
}
const deps = (root: string, w: (i: MemoryInput) => Promise<string>, failures = new Map()) => ({ dataDir: root, lock: new VaultLock(), writer: w, log: () => undefined, failures });

describe('memory prompt and bullets (spec M15 §2)', () => {
  it('memoryPrompt shows the topic, the current memory and the numbered turns', () => {
    const p = memoryPrompt({ topic: 'Pandas', lang: 'de', memory: '', turns: [{ question: 'Q', answer: 'A' }] });
    expect(p).toBe('Topic: Pandas\n\nCurrent memory:\n(empty)\n\nNew turns:\n### Turn 1\nUser: Q\n\nAssistant: A');
    expect(memoryPrompt({ topic: 'T', lang: 'de', memory: '- alt', turns: [{ question: 'x'.repeat(4000), answer: 'y' }] })).toContain(`User: ${'x'.repeat(3000)}…`);
  });
  it('parseMemoryBullets keeps bullet lines, normalised, at most 8; NONE is nothing', () => {
    expect(parseMemoryBullets('Hier:\n- eins\n* zwei\n• drei\n– vier\n1. fünf\n2) sechs\nkein bullet\n2026 war gut')).toEqual(['- eins', '- zwei', '- drei', '- vier', '- fünf', '- sechs']);
    expect([isNone('NONE'), isNone(' none. '), isNone('**NONE**'), isNone('Nothing')]).toEqual([true, true, true, false]);
    expect(parseMemoryBullets('NONE')).toEqual([]);
    expect(parseMemoryBullets(Array.from({ length: 12 }, (_, i) => `- ${i}`).join('\n'))).toHaveLength(8);
  });
});

describe('dueTurns (spec M15 §2)', () => {
  it('groups answered turns by topic; covered and unanswered ones are not due', async () => {
    const { root, ids } = await vault();
    const g = await graphOf(root);
    expect([...dueTurns(g).entries()].map(([k, d]) => [k, d.turns.map((t) => [t.question, t.answer])])).toEqual([
      ['pandas', [['Frage 1', 'Antwort 1'], ['Frage 2', 'Antwort 2']]],
      ['kaggle', [['Kaggle?', 'Kaggle ist…']]],
    ]);
    await writeMemory(g, { topic: 'pandas', covered: [ids[0]!, ids[2]!], body: '' }, root);
    expect([...dueTurns(await graphOf(root)).keys()]).toEqual(['kaggle']);
  });
});

describe('runMemoryPhase (spec M15 §2)', () => {
  it('one call per topic; appends the bullets and covers the turns; a second run calls nothing', async () => {
    const { root, ids } = await vault();
    const w = writer((i) => (i.topic === 'Pandas' ? '- nutzt pandas 2\n- Einsteiger' : 'NONE'));
    expect(await runMemoryPhase(deps(root, w))).toEqual({ updated: 2, failed: 0, gaveUp: 0, pending: 0 });
    expect(w.calls.map((c) => [c.topic, c.turns.length])).toEqual([['Pandas', 2], ['Kaggle', 1]]);
    const text = await fs.readFile(path.join(root, 'm', 'memories', 'pandas.md'), 'utf8');
    expect(text).toBe(`---\ntopic: Pandas\ncovered: [${ids[0]}, ${ids[2]}]\n---\n\n- nutzt pandas 2\n- Einsteiger\n`);
    expect((await graphOf(root)).memories!.find((m) => m.topic === 'Kaggle')).toMatchObject({ body: '', covered: [ids[5]] }); // NONE still covers
    expect(await runMemoryPhase(deps(root, w))).toEqual({ updated: 0, failed: 0, gaveUp: 0, pending: 0 });
    expect(w.calls).toHaveLength(2);
  });
  it('adopts a hand-written memory: its text stays, the new bullets go below it', async () => {
    const { root } = await vault();
    await fs.mkdir(path.join(root, 'm', 'memories'), { recursive: true });
    await fs.writeFile(path.join(root, 'm', 'memories', 'meins.md'), '---\ntopic: pandas\n---\n\nMeine Notiz.\n');
    const w = writer((i) => (i.topic === 'Pandas' ? '- neu' : 'NONE')); // the turns' own spelling; the file keeps its own
    await runMemoryPhase(deps(root, w));
    expect(w.calls[0]!.memory).toBe('Meine Notiz.');
    const m = (await graphOf(root)).memories!.find((x) => x.topic === 'pandas')!;
    expect(m).toMatchObject({ path: 'm/memories/meins.md', body: 'Meine Notiz.\n\n- neu' });
    expect(m.covered).toHaveLength(2);
  });
  it('an answer with neither bullets nor NONE is a failure: the turns stay due', async () => {
    const { root } = await vault();
    expect(await runMemoryPhase(deps(root, writer(() => 'Der Nutzer fragt nach Pandas.')))).toMatchObject({ updated: 0, failed: 2, pending: 2 });
    expect((await graphOf(root)).memories).toEqual([]);
  });
  it('a failing writer leaves the turns due and counts; at most MAX_TURNS_PER_CALL per call, the rest stays pending', async () => {
    const { root } = await vault({ turns: MAX_TURNS_PER_CALL + 2 });
    const failing = writer(() => { throw new Error('down'); });
    expect(await runMemoryPhase(deps(root, failing))).toMatchObject({ updated: 0, failed: 2, pending: 2 });
    expect((await graphOf(root)).memories).toEqual([]);
    const w = writer(() => '- x');
    expect(await runMemoryPhase(deps(root, w))).toMatchObject({ updated: 2, pending: 1 });
    expect(w.calls[0]!.turns).toHaveLength(MAX_TURNS_PER_CALL);
    expect(await runMemoryPhase(deps(root, w))).toMatchObject({ updated: 1, pending: 0 });
    expect(w.calls[2]!.turns).toHaveLength(2);
  });
});
