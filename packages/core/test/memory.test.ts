import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildContext, SYSTEM_PROMPT, systemWithMemories } from '../src/context';
import { carryCovered, memoryOf, memoryPath, parseMemoryFile, serializeMemoryFile } from '../src/memory';
import { promptTokens } from '../src/tokens';
import { readCanvas, readVault } from '../src/vault/read';
import { writeCanvas, writeMemory } from '../src/vault/write';
import { A, C, cleanupTmpDirs, sampleGraph, tmpDir } from './helpers';

afterAll(cleanupTmpDirs);

describe('memory files (spec M15 §1)', () => {
  it('round-trips topic, covered and body', () => {
    const text = serializeMemoryFile({ topic: 'Kaggle: Titanic', covered: [A, C], body: '- eins\n- zwei' });
    expect(text).toBe(`---\ntopic: 'Kaggle: Titanic'\ncovered: [${A}, ${C}]\n---\n\n- eins\n- zwei\n`);
    expect(parseMemoryFile(text)).toEqual({ ok: true, topic: 'Kaggle: Titanic', covered: [A, C], body: '- eins\n- zwei' });
    expect(serializeMemoryFile({ topic: 'Leer', covered: [], body: '' })).toBe('---\ntopic: Leer\ncovered: []\n---\n');
  });
  it('adopts a hand-written file without covered; refuses one without a topic', () => {
    expect(parseMemoryFile('---\ntopic: Pandas\n---\n\nnotiz')).toEqual({ ok: true, topic: 'Pandas', covered: [], body: 'notiz' });
    expect(parseMemoryFile('---\ncovered: []\n---\n')).toEqual({ ok: false, reason: 'missing topic' });
    expect(parseMemoryFile('nur text')).toEqual({ ok: false, reason: 'no frontmatter block' });
  });
  it('memoryPath slugs the topic and steps past taken names; memoryOf matches by topicKey', () => {
    expect(memoryPath('m', 'Kaggle Titanic Tutorial', new Set())).toBe('m/memories/kaggle-titanic-tutorial.md');
    expect(memoryPath('m', 'Pandas', new Set(['m/memories/pandas.md']))).toBe('m/memories/pandas-2.md');
    expect(memoryOf([{ topic: 'Pandas-Befehle' }], 'pandas befehle')).toEqual({ topic: 'Pandas-Befehle' });
    expect(memoryOf([{ topic: 'Pandas' }], 'Kaggle')).toBeUndefined();
  });
});

describe('carryCovered (spec M15 §3)', () => {
  it('a new user node is covered when all the old ones it replaces were', () => {
    const replacement = { q1: 'N1', a1: 'M1', q2: 'N1', a2: 'M1', q3: 'N2', a3: 'M2' };
    const oldUsers = new Set(['q1', 'q2', 'q3']);
    expect(carryCovered(['q1', 'q2', 'x'], replacement, oldUsers)).toEqual(['q1', 'q2', 'x', 'N1']);
    expect(carryCovered(['q1', 'q3'], replacement, oldUsers)).toEqual(['q1', 'q3', 'N2']); // N1 also covers q2, which was not
    expect(carryCovered([], replacement, oldUsers)).toEqual([]);
  });
});

describe('reading and writing memories (spec M15 §1)', () => {
  it('the reader skips memories/ for nodes and reads them into graph.memories; duplicates and broken files are reported', async () => {
    const root = await tmpDir();
    await writeCanvas(sampleGraph(), root);
    const dir = path.join(root, 'masterarbeit', 'memories');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.md'), `---\ntopic: Evaluation\ncovered: [${A}]\n---\n\n- Zentroide\n`);
    await fs.writeFile(path.join(dir, 'b.md'), '---\ntopic: evaluation\n---\n');
    await fs.writeFile(path.join(dir, 'c.md'), 'kein frontmatter');
    const { canvases, repairs } = await readVault(root);
    const g = canvases[0]!;
    expect(g.nodes.size).toBe(3);
    expect(g.memories).toEqual([{ topic: 'Evaluation', covered: [A], body: '- Zentroide', path: 'masterarbeit/memories/a.md' }]);
    expect(repairs).toEqual([
      { kind: 'duplicate-memory', path: 'masterarbeit/memories/b.md', topic: 'evaluation', kept: 'masterarbeit/memories/a.md' },
      { kind: 'unparseable-memory', path: 'masterarbeit/memories/c.md', reason: 'no frontmatter block' },
    ]);
  });
  it('writeMemory creates at a free slug path (never over another file), updates in place, keeps graph.memories current', async () => {
    const root = await tmpDir();
    await writeCanvas(sampleGraph(), root);
    await fs.mkdir(path.join(root, 'masterarbeit', 'memories'), { recursive: true });
    await fs.writeFile(path.join(root, 'masterarbeit', 'memories', 'evaluation.md'), 'kaputt'); // unparseable, but taken
    const { graph } = (await readCanvas(root, 'masterarbeit'))!;
    const m = await writeMemory(graph, { topic: 'Evaluation', covered: [A], body: '- eins' }, root);
    expect(m.path).toBe('masterarbeit/memories/evaluation-2.md');
    await writeMemory(graph, { ...m, body: '- eins\n\n- zwei' }, root);
    expect(await fs.readFile(path.join(root, m.path), 'utf8')).toBe(`---\ntopic: Evaluation\ncovered: [${A}]\n---\n\n- eins\n\n- zwei\n`);
    expect(await fs.readFile(path.join(root, 'masterarbeit', 'memories', 'evaluation.md'), 'utf8')).toBe('kaputt');
    expect(graph.memories).toEqual([{ topic: 'Evaluation', covered: [A], body: '- eins\n\n- zwei', path: m.path }]);
    expect((await readCanvas(root, 'masterarbeit'))!.graph.memories).toEqual(graph.memories);
  });
});

describe('memories in the context (spec M15 §4)', () => {
  it('appends each non-empty memory to the system prompt and counts it', () => {
    const memories = [{ topic: 'Pandas', body: '- nutzt pandas 2' }, { topic: 'Leer', body: '  ' }];
    const ctx = buildContext(sampleGraph(), [C], [], 'x', memories);
    expect(ctx.system).toBe(`${SYSTEM_PROMPT}\n\nMemory of the topic "Pandas" — facts and decisions from earlier conversations on this canvas; rely on them where relevant:\n- nutzt pandas 2`);
    expect(systemWithMemories()).toBe(SYSTEM_PROMPT);
    expect(promptTokens(ctx)).toBeGreaterThan(promptTokens(buildContext(sampleGraph(), [C], [], 'x')));
  });
});
