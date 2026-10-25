import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decodeTime } from 'ulid';
import { afterAll, describe, expect, it } from 'vitest';
import { compressionSections, compressPrompt, maxCompressedTurns, parseCompression, planCompression, subtreeIds, type CompressedTurn, type Section } from '../src/compress';
import type { GraphLike, NodeLike } from '../src/graph-like';
import { idAt, isoTimestamp } from '../src/ids';
import { readVault } from '../src/vault/read';
import { replaceNodes, writeCanvas } from '../src/vault/write';
import type { CanvasGraph, MessageNode } from '../src/types';
import { cleanupTmpDirs, node, tmpDir } from './helpers';

afterAll(cleanupTmpDirs);

function graph(ns: NodeLike[]): GraphLike {
  return { nodes: new Map(ns.map((n) => [n.id, n])), layout: new Map() };
}
const q = (id: string, parents: string[] = []) => node({ id, parents });
const a = (id: string, parent: string) => node({ id, role: 'assistant', parents: [parent] });

// Q1 A1 Q2 A2 Q3 A3 Q4 A4 in one chain
const chain = (n: number): NodeLike[] => Array.from({ length: n }, (_, i) => [q(`Q${i + 1}`, i === 0 ? [] : [`A${i}`]), a(`A${i + 1}`, `Q${i + 1}`)]).flat();

const ids = (ns: NodeLike[]) => ns.map((n) => n.id);
const heads = (ss: Section[]) => ss.map((s) => [s.turns.map((t) => t[0]), s.folds.map((f) => f.map((t) => t[0]))]);

describe('compressionSections (spec M11 §11)', () => {
  it('chains the chosen turns into one section', () => {
    expect(compressionSections(graph(chain(4)), ids(chain(4)))).toEqual([{ turns: [['Q1', 'A1'], ['Q2', 'A2'], ['Q3', 'A3'], ['Q4', 'A4']], folds: [] }]);
  });

  it('runs straight through a fork when only one branch is chosen (the context chain)', () => {
    const g = graph([...chain(4), q('X2', ['A1']), a('Y2', 'X2')]);
    expect(heads(compressionSections(g, ids(chain(4))))).toEqual([[['Q1', 'Q2', 'Q3', 'Q4'], []]]);
  });

  it('splits where several chosen turns continue one answer, and at a merge question', () => {
    const g = graph([...chain(3), q('X2', ['A1']), a('Y2', 'X2'), q('X3', ['Y2']), a('Y3', 'X3')]);
    expect(heads(compressionSections(g, [...g.nodes.keys()]))).toEqual([[['Q2', 'Q3'], []], [['X2', 'X3'], []]]); // Q1 alone is too short
    const m = graph([...chain(4).map((n) => (n.id === 'Q2' ? q('Q2', ['A1', 'Z']) : n)), q('Z'), a('ZA', 'Z')]);
    expect(heads(compressionSections(m, ids(chain(4))))).toEqual([[['Q2', 'Q3', 'Q4'], []]]);
  });

  it('takes the chosen answer of a question, else its first; skips unanswered questions', () => {
    const g = graph([...chain(2), a('A2b', 'Q2'), q('Q3', ['A2'])]);
    expect(compressionSections(g, ['A1', 'A2b'])[0]!.turns).toEqual([['Q1', 'A1'], ['Q2', 'A2b']]);
    expect(compressionSections(g, ['Q1', 'Q2', 'Q3'])[0]!.turns).toEqual([['Q1', 'A1'], ['Q2', 'A2']]);
    expect(compressionSections(g, ['Q1'])).toEqual([]);
  });

  // trunk Q1 A1 Q2 A2; A2 forks into a long branch Q3…A5, a one-turn dead end D, and a three-turn dead end E1…EA3
  const tree = () =>
    graph([
      ...chain(5),
      q('D1', ['A2']), a('DA1', 'D1'),
      q('E1', ['A2']), a('EA1', 'E1'), q('E2', ['EA1']), a('EA2', 'E2'), q('E3', ['EA2']), a('EA3', 'E3'),
    ]);

  it('subtreeIds: the turn of the card and everything below it', () => {
    expect(subtreeIds(tree(), 'A3')).toEqual(['Q3', 'A3', 'Q4', 'A4', 'Q5', 'A5']);
    expect(heads(compressionSections(tree(), subtreeIds(tree(), 'Q1')))).toEqual([[['E1', 'E2', 'E3'], []], [['Q1', 'Q2'], []], [['Q3', 'Q4', 'Q5'], []]]); // in id order
  });

  it('fold: short dead ends join the section they hang off; long ones and continued ones stay', () => {
    expect(heads(compressionSections(tree(), subtreeIds(tree(), 'Q1'), true))).toEqual([[['E1', 'E2', 'E3'], []], [['Q1', 'Q2'], [['D1']]], [['Q3', 'Q4', 'Q5'], []]]);
  });

  it('fold: a fork of nothing but dead ends keeps its longest branch (newest on a tie); a single turn with folds is a section', () => {
    const g = graph([...chain(1), q('D1', ['A1']), a('DA1', 'D1'), q('F1', ['A1']), a('FA1', 'F1')]);
    expect(heads(compressionSections(g, subtreeIds(g, 'Q1'), true))).toEqual([[['Q1'], [['D1']]]]);
    expect(compressionSections(g, subtreeIds(g, 'Q1'))).toEqual([]);
    const longer = graph([...chain(1), q('D1', ['A1']), a('DA1', 'D1'), q('D2', ['DA1']), a('DA2', 'D2'), q('F1', ['A1']), a('FA1', 'F1')]);
    expect(heads(compressionSections(longer, subtreeIds(longer, 'Q1'), true))).toEqual([[['D1', 'D2'], []], [['Q1'], [['F1']]]]);
  });
});

describe('parseCompression (spec M11 §4)', () => {
  const t = (covers: number[], question = 'q', answer = 'a') => ({ covers, question, answer });
  const ok = { sections: [{ section: 1, turns: [t([1, 2], 'q1', 'a1'), t([3, 4], 'q2', 'a2')] }, { section: 2, turns: [t([1, 2])] }] };
  it('accepts a valid reply, also in a code fence', () => {
    const want: CompressedTurn[][] = [[{ covers: [1, 2], question: 'q1', answer: 'a1' }, { covers: [3, 4], question: 'q2', answer: 'a2' }], [{ covers: [1, 2], question: 'q', answer: 'a' }]];
    expect(parseCompression(JSON.stringify(ok), [4, 2])).toEqual(want);
    expect(parseCompression('```json\n' + JSON.stringify(ok) + '\n```', [4, 2])).toEqual(want);
  });
  const one = (turns: unknown[]) => JSON.stringify({ sections: [{ section: 1, turns }] });
  it.each([
    ['garbage', 'not json at all', [4], /not JSON/],
    ['a missing section', JSON.stringify(ok), [4, 2, 2], /expected 3 sections/],
    ['sections out of order', JSON.stringify({ sections: [ok.sections[1], ok.sections[0]] }), [4, 2], /section 1 is missing or out of order/],
    ['no turns', one([]), [4], /section 1: no turns/],
    ['too many turns', one([t([1, 1]), t([2, 2]), t([3, 4])]), [4], /at most 2/],
    ['gap', one([t([1, 1]), t([3, 4])]), [4], /expected to start at 2/],
    ['overlap', one([t([1, 3]), t([3, 4])]), [4], /expected to start at 4/],
    ['not covering the end', one([t([1, 3])]), [4], /4–4 are not covered/],
    ['empty answer', one([t([1, 4], 'q', ' ')]), [4], /empty/],
  ])('rejects %s', (_, text, sizes, re) => expect(() => parseCompression(text, sizes)).toThrow(re));
  it('allows one turn for one to three', () => {
    expect(maxCompressedTurns(1)).toBe(1);
    expect(maxCompressedTurns(3)).toBe(1);
    expect(maxCompressedTurns(16)).toBe(8);
  });
});

describe('compressPrompt', () => {
  it('numbers sections and turns, states limits, links sections and lists side branches', () => {
    const g = graph([...chain(4), q('D1', ['A2']), a('DA1', 'D1')].map((n) => ({ ...n, body: `body ${n.id}` })));
    const p = compressPrompt(g, [{ turns: [['Q1', 'A1'], ['Q2', 'A2']], folds: [[['D1', 'DA1']]] }, { turns: [['Q3', 'A3'], ['Q4', 'A4']], folds: [] }]);
    expect(p).toMatch(/^## Section 1 \(N = 2, return at most 1 turns\)\n/);
    expect(p).toContain('## Section 2 (N = 2, return at most 1 turns) — continues after section 1');
    expect(p).toContain('### Turn 2\n\n**User:**\nbody Q2\n\n**Assistant:**\nbody A2');
    expect(p).toContain('### Side branch 1 after turn 2\n\n**User:**\nbody D1');
  });
});

type Spec = [name: string, role: 'user' | 'assistant', parents: string[], x: number, y: number, topic?: string];
/** A graph with real ULIDs (time order = list order) and explicit positions. */
function build(specs: Spec[]): { g: CanvasGraph; ids: Record<string, string> } {
  const t0 = Date.UTC(2026, 0, 1);
  const ids = Object.fromEntries(specs.map(([n], i) => [n, idAt(t0 + i * 60_000)]));
  const g: CanvasGraph = { slug: 'demo', nodes: new Map(), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
  for (const [name, role, parents, x, y, topic = 'T'] of specs) {
    const id = ids[name]!;
    g.nodes.set(id, { id, role, parents: parents.map((p) => ids[p]!), created: isoTimestamp(decodeTime(id)), summary: '', topics: [topic], body: `body ${name}`, ...(role === 'assistant' ? { model: 'm' } : {}) });
    g.layout.set(id, { x, y, width: 400, height: 200 });
  }
  return { g, ids };
}
const row = (i: number) => i * 280;

// root R → RA, then four turns in a column, a child C under the last answer and a merge M (from X) naming it too;
// X and M stand in their own column
function realGraph() {
  return build([
    ['R', 'user', [], 0, row(0)], ['RA', 'assistant', ['R'], 0, row(1)],
    ['Q1', 'user', ['RA'], 0, row(2)], ['A1', 'assistant', ['Q1'], 0, row(3), 'U'],
    ['Q2', 'user', ['A1'], 0, row(4), 'U'], ['A2', 'assistant', ['Q2'], 0, row(5), 'U'],
    ['Q3', 'user', ['A2'], 0, row(6)], ['A3', 'assistant', ['Q3'], 0, row(7)],
    ['Q4', 'user', ['A3'], 0, row(8)], ['A4', 'assistant', ['Q4'], 0, row(9)],
    ['C', 'user', ['A4'], 0, row(10)],
    ['X', 'user', [], 960, row(0)], ['M', 'user', ['X', 'A4'], 960, row(1)],
  ]);
}

describe('planCompression (spec M11 §2/§5/§10)', () => {
  const two: CompressedTurn[][] = [[{ covers: [1, 3], question: 'nq1', answer: 'na1' }, { covers: [4, 4], question: 'nq2', answer: 'na2' }]];

  it('builds the new chain, keeps time order and positions, reparents and pulls up what hung below', () => {
    const { g, ids } = realGraph();
    const plan = planCompression(g, compressionSections(g, ['Q1', 'Q2', 'Q3', 'Q4'].map((n) => ids[n]!)), two, 'model-x', idAt);
    const [u1, a1, u2, a2] = plan.added;
    expect(plan.added.map((n) => [n.role, n.body])).toEqual([['user', 'nq1'], ['assistant', 'na1'], ['user', 'nq2'], ['assistant', 'na2']]);
    expect(u1!.parents).toEqual([ids.RA]);
    expect(a1!.parents).toEqual([u1!.id]);
    expect(u2!.parents).toEqual([a1!.id]);
    expect(a2!.model).toBe('model-x');
    expect(u1!.model).toBeUndefined();
    expect(decodeTime(u1!.id)).toBe(decodeTime(ids.Q1!));
    expect(a2!.created).toBe(g.nodes.get(ids.A4!)!.created);
    expect(u1!.topics).toEqual(['T']); // Q1,Q3,A3 are T; A1,Q2,A2 are U — a tie goes to the first seen
    expect(plan.layout.get(u1!.id)).toEqual(g.layout.get(ids.Q1!));
    expect(plan.layout.get(a2!.id)).toEqual(g.layout.get(ids.A2!));
    expect(plan.removed).toEqual(['Q1', 'A1', 'Q2', 'A2', 'Q3', 'A3', 'Q4', 'A4'].map((n) => ids[n]));
    expect(plan.reparent).toEqual(new Map([[ids.C!, [a2!.id]], [ids.M!, [ids.X!, a2!.id]]]));
    expect(plan.replacement[ids.A3!]).toBe(a1!.id);
    expect(plan.replacement[ids.Q4!]).toBe(u2!.id);
    // A4 ended at row 9, the new last answer ends at row 5: C moves up four rows; M hangs below X, not below the run
    expect(plan.moved).toEqual(new Map([[ids.C!, { x: 0, y: row(6), width: 400, height: 200 }]]));
  });

  it('appends the images the rewrite dropped to the new question (spec M13)', () => {
    const { g, ids } = realGraph();
    const img = (n: number) => `01JQ7M2V3X4Y5Z6A7B8C9D0E${n}F.png`;
    g.nodes.get(ids.Q2!)!.body = `see ![[${img(1)}]] and ![[${img(2)}]]`;
    g.nodes.get(ids.Q4!)!.body = `![[${img(3)}]]`;
    const kept: CompressedTurn[][] = [[{ covers: [1, 3], question: `nq1 ![[${img(2)}]]`, answer: 'na1' }, { covers: [4, 4], question: 'nq2', answer: 'na2' }]];
    const plan = planCompression(g, compressionSections(g, ['Q1', 'Q2', 'Q3', 'Q4'].map((n) => ids[n]!)), kept, 'model-x', idAt);
    expect(plan.added.map((n) => n.body)).toEqual([`nq1 ![[${img(2)}]]\n\n![[${img(1)}]]`, 'na1', `nq2\n\n![[${img(3)}]]`, 'na2']);
  });

  // trunk Q1 A1 Q2 A2 in a column; A2 forks: branch Q3…A4 below it, a dead end D1 DA1 to the left, child C under A4
  const tree = (extra: Spec[] = []) =>
    build([
      ['Q1', 'user', [], 0, row(0)], ['A1', 'assistant', ['Q1'], 0, row(1)],
      ['Q2', 'user', ['A1'], 0, row(2)], ['A2', 'assistant', ['Q2'], 0, row(3)],
      ['Q3', 'user', ['A2'], 0, row(4)], ['A3', 'assistant', ['Q3'], 0, row(5)],
      ['Q4', 'user', ['A3'], 0, row(6)], ['A4', 'assistant', ['Q4'], 0, row(7)],
      ['D1', 'user', ['A2'], -480, row(4), 'D'], ['DA1', 'assistant', ['D1'], -480, row(5), 'D'],
      ['C', 'user', ['A4'], 480, row(8)],
      ...extra,
    ]);
  const halves: CompressedTurn[][] = [[{ covers: [1, 2], question: 's1q', answer: 's1a' }], [{ covers: [1, 2], question: 's2q', answer: 's2a' }]];

  it('several sections with a fold: chained through replacements, lifted cumulatively', () => {
    const { g, ids } = tree();
    const sections = compressionSections(g, subtreeIds(g, ids.Q1!), true);
    expect(sections.map((s) => s.folds.length)).toEqual([1, 0]);
    const plan = planCompression(g, sections, halves, 'model-x', idAt);
    const [u1, a1, u2, a2] = plan.added;
    expect(u2!.parents).toEqual([a1!.id]);
    expect(plan.replacement[ids.D1!]).toBe(a1!.id);
    expect(plan.removed).toHaveLength(10);
    expect(plan.reparent).toEqual(new Map([[ids.C!, [a2!.id]]]));
    // section 1 lost two rows, section 2 too: its new cards rise two rows, C (below section 2) four
    expect([u1, a1, u2, a2].map((n) => plan.layout.get(n!.id)!.y)).toEqual([row(0), row(1), row(2), row(3)]);
    expect(plan.moved.get(ids.C!)).toEqual({ x: 480, y: row(4), width: 400, height: 200 });
  });

  it('a side branch off an answer inside the section rises with that answer\'s replacement', () => {
    // chain Q1…A4 in a column; S (with answer SA) hangs off A2 in the next column; C hangs below A4
    const { g, ids } = build([
      ['Q1', 'user', [], 0, row(0)], ['A1', 'assistant', ['Q1'], 0, row(1)],
      ['Q2', 'user', ['A1'], 0, row(2)], ['A2', 'assistant', ['Q2'], 0, row(3)],
      ['Q3', 'user', ['A2'], 0, row(4)], ['A3', 'assistant', ['Q3'], 0, row(5)],
      ['Q4', 'user', ['A3'], 0, row(6)], ['A4', 'assistant', ['Q4'], 0, row(7)],
      ['S', 'user', ['A2'], 480, row(4)], ['SA', 'assistant', ['S'], 480, row(5)],
      ['C', 'user', ['A4'], 0, row(8)],
    ]);
    const sections = compressionSections(g, ['Q1', 'Q2', 'Q3', 'Q4'].map((n) => ids[n]!));
    const plan = planCompression(g, sections, [[{ covers: [1, 2], question: 'q', answer: 'a' }, { covers: [3, 4], question: 'q', answer: 'a' }]], 'model-x', idAt);
    const [, a1, , a2] = plan.added;
    expect(plan.reparent.get(ids.S!)).toEqual([a1!.id]);
    expect(plan.reparent.get(ids.C!)).toEqual([a2!.id]);
    // A2 ended at row 3, a1 ends at row 1: S and SA rise two rows; A4 ended at row 7, a2 at row 3: C rises four
    expect(plan.moved.get(ids.S!)!.y).toBe(row(2));
    expect(plan.moved.get(ids.SA!)!.y).toBe(row(3));
    expect(plan.moved.get(ids.C!)!.y).toBe(row(4));
  });

  it('pulls nothing up when that would overlap an unrelated card', () => {
    const { g, ids } = tree([['X', 'user', [], 480, row(4) + 40]]); // right where C would land
    const plan = planCompression(g, compressionSections(g, subtreeIds(g, ids.Q1!), true), halves, 'model-x', idAt);
    expect(plan.moved.size).toBe(0);
    expect(plan.layout.get(plan.added[2]!.id)).toEqual(g.layout.get(ids.Q3!)); // section 2 keeps its old slots
  });

  it('replaceNodes writes the new chain, trashes the old, applies the pull-up and reads back clean', async () => {
    const root = await tmpDir();
    const { g, ids } = realGraph();
    await writeCanvas(g, root);
    const plan = planCompression(g, compressionSections(g, ['Q1', 'Q2', 'Q3', 'Q4'].map((n) => ids[n]!)), two, 'model-x', idAt);
    await replaceNodes(g, plan, root);
    const trash = (await fs.readdir(path.join(root, '.trash'))).sort();
    expect(trash).toEqual(plan.removed.map((id) => `${id}.md`).sort());
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    const back = canvases[0]!;
    expect(back.nodes.size).toBe(13 - 8 + 4);
    expect(back.nodes.get(ids.C!)!.parents).toEqual([plan.added[3]!.id]);
    expect(back.nodes.get(plan.added[0]!.id)).toEqual({ ...(plan.added[0] as MessageNode) });
    expect(back.layout.get(ids.C!)).toEqual({ x: 0, y: row(6), width: 400, height: 200 });
  });
});
