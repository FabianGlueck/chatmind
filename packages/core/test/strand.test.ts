import { describe, expect, it } from 'vitest';
import type { GraphLike, NodeLike } from '../src/graph-like';
import { rememberPath, strandOf } from '../src/strand';
import { node } from './helpers';

function graph(ns: NodeLike[]): GraphLike {
  return { nodes: new Map(ns.map((n) => [n.id, n])), layout: new Map() };
}

// Q1 → A1 → {Q2a → A2a, Q2b → A2b}; separate root R
const forked = (): GraphLike =>
  graph([
    node({ id: 'Q1' }),
    node({ id: 'A1', role: 'assistant', parents: ['Q1'] }),
    node({ id: 'Q2a', parents: ['A1'] }),
    node({ id: 'A2a', role: 'assistant', parents: ['Q2a'] }),
    node({ id: 'Q2b', parents: ['A1'] }),
    node({ id: 'A2b', role: 'assistant', parents: ['Q2b'] }),
    node({ id: 'R' }),
  ]);
const ids = (items: { node: NodeLike }[]): string[] => items.map((i) => i.node.id);

describe('strandOf (spec M9 §3)', () => {
  it('a linear chain from anywhere is the whole chain', () => {
    const g = graph([node({ id: 'a' }), node({ id: 'b', role: 'assistant', parents: ['a'] }), node({ id: 'c', parents: ['b'] })]);
    expect(ids(strandOf(g, 'a', new Map()))).toEqual(['a', 'b', 'c']);
    expect(ids(strandOf(g, 'c', new Map()))).toEqual(['a', 'b', 'c']);
  });
  it('below the cursor it takes the newest child', () => {
    expect(ids(strandOf(forked(), 'A1', new Map()))).toEqual(['Q1', 'A1', 'Q2b', 'A2b']);
  });
  it('the cursor chain wins over the default', () => {
    expect(ids(strandOf(forked(), 'Q2a', new Map()))).toEqual(['Q1', 'A1', 'Q2a', 'A2a']);
  });
  it('preferred wins below the cursor; a stale preference falls back to newest', () => {
    expect(ids(strandOf(forked(), 'Q1', new Map([['A1', 'Q2a']])))).toEqual(['Q1', 'A1', 'Q2a', 'A2a']);
    expect(ids(strandOf(forked(), 'Q1', new Map([['A1', 'gone']])))).toEqual(['Q1', 'A1', 'Q2b', 'A2b']);
  });
  it('siblings: primary children of the parent, roots for a root', () => {
    const s = strandOf(forked(), 'Q2a', new Map());
    expect(s.map((i) => i.siblings)).toEqual([['Q1', 'R'], ['A1'], ['Q2a', 'Q2b'], ['A2a']]);
  });
  it('a merge node carries the secondary branches; the primary one is inline', () => {
    const g = graph([
      node({ id: 'R' }),
      node({ id: 'A', role: 'assistant', parents: ['R'] }),
      node({ id: 'U1', parents: ['A'] }),
      node({ id: 'A1', role: 'assistant', parents: ['U1'] }),
      node({ id: 'U2', parents: ['A'] }),
      node({ id: 'A2', role: 'assistant', parents: ['U2'] }),
      node({ id: 'M', parents: ['A1', 'A2'] }),
    ]);
    const s = strandOf(g, 'M', new Map());
    expect(ids(s)).toEqual(['R', 'A', 'U1', 'A1', 'M']);
    const m = s.at(-1)!;
    expect(m.merged.map((seg) => [seg.target.id, seg.nodes.map((n) => n.id)])).toEqual([['A2', ['U2', 'A2']]]);
    expect(s.slice(0, -1).every((i) => i.merged.length === 0)).toBe(true);
  });
  it('a three-way merge shows every merged node once', () => {
    // Branches B and C share X below the fork; the primary branch P does not.
    const g = graph([
      node({ id: 'R' }),
      node({ id: 'P', role: 'assistant', parents: ['R'] }),
      node({ id: 'X', parents: ['R'] }),
      node({ id: 'B', role: 'assistant', parents: ['X'] }),
      node({ id: 'C', role: 'assistant', parents: ['X'] }),
      node({ id: 'M', parents: ['P', 'B', 'C'] }),
    ]);
    const m = strandOf(g, 'M', new Map()).at(-1)!;
    expect(m.merged.map((seg) => seg.nodes.map((n) => n.id))).toEqual([['X', 'B'], ['C']]);
  });
  it('a merged branch that shares an ancestor with the primary branch does not repeat it', () => {
    // Prefix of all three parents is only R; Y is on the primary chain and on B's segment.
    const g = graph([
      node({ id: 'R' }),
      node({ id: 'Y', role: 'assistant', parents: ['R'] }),
      node({ id: 'P', parents: ['Y'] }),
      node({ id: 'B', parents: ['Y'] }),
      node({ id: 'C', parents: ['R'] }),
      node({ id: 'M', role: 'user', parents: ['P', 'B', 'C'] }),
    ]);
    const m = strandOf(g, 'M', new Map()).at(-1)!;
    expect(m.merged.map((seg) => seg.nodes.map((n) => n.id))).toEqual([['B'], ['C']]);
  });
  it('unknown cursor: empty; a cycle stops the walk', () => {
    expect(strandOf(forked(), 'nope', new Map())).toEqual([]);
    const g = graph([node({ id: 'x', parents: ['y'] }), node({ id: 'y', parents: ['x'] })]);
    expect(ids(strandOf(g, 'x', new Map())).length).toBeLessThanOrEqual(2);
  });
});

describe('rememberPath', () => {
  it('records every parent → child pair on the cursor chain and keeps other entries', () => {
    const out = rememberPath(forked(), 'A2a', new Map([['X', 'Y'], ['A1', 'Q2b']]));
    expect(out).toEqual(new Map([['X', 'Y'], ['A1', 'Q2a'], ['Q1', 'A1'], ['Q2a', 'A2a']]));
  });
  it('returns the same map when nothing changes', () => {
    const first = rememberPath(forked(), 'A2a', new Map());
    expect(rememberPath(forked(), 'Q2a', first)).toBe(first);
  });
});
