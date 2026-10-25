import { describe, expect, it } from 'vitest';
import { contextSet, isAncestor, validateTargets } from '../src/context';
import { branchingGraph } from './helpers';

const ids = (ns: { id: string }[]) => ns.map((n) => n.id);

describe('contextSet', () => {
  it('one target: the whole chain is the prefix and the segment is empty', () => {
    const s = contextSet(branchingGraph(), ['U1b'], []);
    expect(ids(s.prefix)).toEqual(['R', 'U1', 'A1', 'U1b']);
    expect(s.segments).toHaveLength(1);
    expect(s.segments[0]!.target.id).toBe('U1b');
    expect(s.segments[0]!.nodes).toEqual([]);
    expect([...s.all]).toEqual(['R', 'U1', 'A1', 'U1b']);
  });
  it('two siblings: prefix up to the parent, one-node segments in target order', () => {
    const s = contextSet(branchingGraph(), ['U2', 'U1'], []);
    expect(ids(s.prefix)).toEqual(['R']);
    expect(s.segments.map((seg) => [seg.target.id, ids(seg.nodes)])).toEqual([['U2', ['U2']], ['U1', ['U1']]]);
  });
  it('deep branches: segments start below the LCA', () => {
    const s = contextSet(branchingGraph(), ['U1b', 'A2'], []);
    expect(ids(s.prefix)).toEqual(['R']);
    expect(ids(s.segments[0]!.nodes)).toEqual(['U1', 'A1', 'U1b']);
    expect(ids(s.segments[1]!.nodes)).toEqual(['U2', 'A2']);
    expect(s.all).toEqual(new Set(['R', 'U1', 'A1', 'U1b', 'U2', 'A2']));
  });
  it('no common root: empty prefix, everything in segments', () => {
    const s = contextSet(branchingGraph(), ['A1', 'Y'], []);
    expect(s.prefix).toEqual([]);
    expect(ids(s.segments[0]!.nodes)).toEqual(['R', 'U1', 'A1']);
    expect(ids(s.segments[1]!.nodes)).toEqual(['X', 'Y']);
  });
  it('keeps excluded nodes in the structure and reports the ones inside the set', () => {
    const s = contextSet(branchingGraph(), ['U1b', 'A2'], ['R', 'A1', 'X']);
    expect(ids(s.prefix)).toEqual(['R']);
    expect(ids(s.segments[0]!.nodes)).toEqual(['U1', 'A1', 'U1b']);
    expect(s.excluded).toEqual(new Set(['R', 'A1']));
  });
  it('skips unknown targets and handles no targets', () => {
    expect(contextSet(branchingGraph(), ['nope'], []).segments).toEqual([]);
    expect(contextSet(branchingGraph(), [], []).all.size).toBe(0);
  });
});

describe('isAncestor', () => {
  it('follows the primary parent and is strict', () => {
    expect(isAncestor(branchingGraph(), 'R', 'U1b')).toBe(true);
    expect(isAncestor(branchingGraph(), 'U1b', 'R')).toBe(false);
    expect(isAncestor(branchingGraph(), 'U1', 'U1')).toBe(false);
    expect(isAncestor(branchingGraph(), 'X', 'U1')).toBe(false);
  });
});

describe('validateTargets', () => {
  it('accepts valid sets', () => {
    expect(validateTargets(branchingGraph(), ['U1b', 'A2'], ['R', 'A1'])).toBeNull();
    expect(validateTargets(branchingGraph(), [], [])).toBeNull();
    expect(validateTargets(branchingGraph(), ['U1b'], [])).toBeNull();
  });
  it('rejects unknown, duplicate and nested targets', () => {
    expect(validateTargets(branchingGraph(), ['nope'], [])).toMatch(/unknown node nope/);
    expect(validateTargets(branchingGraph(), ['U1', 'U1'], [])).toMatch(/duplicate/);
    expect(validateTargets(branchingGraph(), ['U1', 'U1b'], [])).toMatch(/U1 is an ancestor of target U1b/);
  });
  it('rejects exclusions outside the set or on a target', () => {
    expect(validateTargets(branchingGraph(), ['U1b'], ['X'])).toMatch(/X is not in the context/);
    expect(validateTargets(branchingGraph(), ['U1b'], ['U1b'])).toMatch(/U1b is a target/);
  });
});
