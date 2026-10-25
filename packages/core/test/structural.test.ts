import { describe, expect, it } from 'vitest';
import type { GraphLike } from '../src/graph-like';
import { structuralNeighbours } from '../src/context';
import { branchingGraph, node } from './helpers';

/** branchingGraph plus a merge M of A1 and A2 with its reply AM. */
function mergeGraph(): GraphLike {
  const g = branchingGraph();
  const nodes = new Map(g.nodes);
  nodes.set('M', node({ id: 'M', parents: ['A1', 'A2'], body: 'merge' }));
  nodes.set('AM', node({ id: 'AM', role: 'assistant', parents: ['M'], body: 'synthesis' }));
  return { nodes, layout: g.layout };
}

describe('structuralNeighbours', () => {
  it('chain: the node, its ancestors and its descendants', () => {
    expect(structuralNeighbours(branchingGraph(), 'A1')).toEqual(new Set(['A1', 'U1', 'R', 'U1b']));
  });
  it('siblings and cousins are not excluded', () => {
    const s = structuralNeighbours(branchingGraph(), 'U1');
    expect(s.has('U2')).toBe(false);
    expect(s.has('A2')).toBe(false);
  });
  it('a root reaches its whole tree, but not a separate tree', () => {
    expect(structuralNeighbours(branchingGraph(), 'R')).toEqual(new Set(['R', 'U1', 'A1', 'U1b', 'U2', 'A2']));
  });
  it('merge: secondary parents count as ancestors', () => {
    expect(structuralNeighbours(mergeGraph(), 'AM')).toEqual(new Set(['AM', 'M', 'A1', 'U1', 'A2', 'U2', 'R']));
  });
  it('merge: the merge is a descendant of both branches', () => {
    const s = structuralNeighbours(mergeGraph(), 'A2');
    expect(s.has('M')).toBe(true);
    expect(s.has('AM')).toBe(true);
    expect(s.has('A1')).toBe(false);
  });
  it('unknown id: just the id', () => {
    expect(structuralNeighbours(branchingGraph(), 'nope')).toEqual(new Set(['nope']));
  });
});
