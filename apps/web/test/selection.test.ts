import type { CanvasDto, NodeDto } from '@chatmind/core';
import { graphLikeFromDto } from '@chatmind/core/graph';
import { describe, expect, it } from 'vitest';
import { clearSelection, effectiveTargets, toggleParticipation, type SelectionState } from '../src/selection';

const n = (id: string, parents: string[]): NodeDto => ({ id, role: 'user', parents, created: 'c', summary: '', topics: [], body: 'b', layout: { x: 0, y: 0, width: 400, height: 200 } });
// R → A → (B, C); C → D ; second root R2
const dto: CanvasDto = { slug: 'm', nodes: [n('R', []), n('A', ['R']), n('B', ['A']), n('C', ['A']), n('D', ['C']), n('R2', [])], edges: [], repairs: [] };
const g = graphLikeFromDto(dto);
const s = (over: Partial<SelectionState>): SelectionState => ({ ...clearSelection(), ...over });

describe('effectiveTargets', () => {
  it('uses explicit targets, else the cursor, else nothing', () => {
    expect(effectiveTargets(s({ cursorId: 'A', targets: ['B', 'C'] }))).toEqual(['B', 'C']);
    expect(effectiveTargets(s({ cursorId: 'A' }))).toEqual(['A']);
    expect(effectiveTargets(clearSelection())).toEqual([]);
  });
});

describe('toggleParticipation', () => {
  it('promotes the implicit cursor target to an explicit one', () => {
    expect(toggleParticipation(g, s({ cursorId: 'B' }), 'B')).toEqual(s({ cursorId: 'B', targets: ['B'] }));
  });
  it('appends a free node as a target and removes an existing target', () => {
    const one = s({ cursorId: 'C', targets: ['B'] });
    const two = toggleParticipation(g, one, 'C');
    expect(two.targets).toEqual(['B', 'C']);
    expect(toggleParticipation(g, two, 'B').targets).toEqual(['C']);
  });
  it('excludes and re-includes a highlighted ancestor, making implicit targets explicit', () => {
    const excluded = toggleParticipation(g, s({ cursorId: 'C' }), 'A');
    expect(excluded).toEqual(s({ cursorId: 'C', targets: ['C'], excluded: ['A'] }));
    expect(toggleParticipation(g, excluded, 'A').excluded).toEqual([]);
  });
  it('ignores a descendant of an existing target and unknown ids', () => {
    const st = s({ cursorId: 'D', targets: ['C'] });
    expect(toggleParticipation(g, st, 'D')).toBe(st);
    expect(toggleParticipation(g, st, 'nope')).toBe(st);
  });
  it('clears exclusions when the last explicit target is removed', () => {
    expect(toggleParticipation(g, s({ cursorId: 'D', targets: ['D'], excluded: ['C'] }), 'D')).toEqual(s({ cursorId: 'D' }));
  });
  it('prunes exclusions that leave the context when targets change', () => {
    const st = s({ cursorId: 'R2', targets: ['B', 'C'], excluded: ['A', 'R'] });
    const afterC = toggleParticipation(g, st, 'C');
    expect(afterC.excluded).toEqual(['A', 'R']); // still in B's chain
    const afterB = toggleParticipation(g, afterC, 'B');
    expect(afterB.targets).toEqual([]);
    expect(afterB.excluded).toEqual([]); // the implicit target is now the cursor R2, whose chain holds neither
  });
  it('a root without a common ancestor can join as a target', () => {
    expect(toggleParticipation(g, s({ cursorId: 'R2', targets: ['B'] }), 'R2').targets).toEqual(['B', 'R2']);
  });
});
