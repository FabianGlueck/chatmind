import type { CanvasDto, NodeDto, Repair } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { mergeCanvas } from '../src/merge';

const n = (id: string, over: Partial<NodeDto> = {}): NodeDto => ({ id, role: 'user', parents: [], created: 'c', summary: '', topics: [], body: 'b', layout: { x: 0, y: 0, width: 400, height: 200 }, ...over });
const dto = (nodes: NodeDto[], edges: CanvasDto['edges'] = [], repairs: Repair[] = []): CanvasDto => ({ slug: 'm', nodes, edges, repairs });

describe('mergeCanvas (spec M5 §7)', () => {
  it('keeps object identity for unchanged nodes and takes changed ones from fresh', () => {
    const a = n('A');
    const cur = dto([a, n('B')]);
    const fresh = dto([n('A'), n('B', { summary: 'Titel' })]);
    const out = mergeCanvas(cur, fresh, new Map());
    expect(out.nodes[0]).toBe(a);
    expect(out.nodes[1]).toEqual(n('B', { summary: 'Titel' }));
    expect(out.nodes[1]).not.toBe(cur.nodes[1]);
  });

  it('returns the current object when nothing changed', () => {
    const cur = dto([n('A')], [{ id: 'e', from: 'X', to: 'A' }]);
    expect(mergeCanvas(cur, dto([n('A')], [{ id: 'e', from: 'X', to: 'A' }]), new Map())).toBe(cur);
  });

  it('adds new nodes in fresh order and drops vanished ones', () => {
    const out = mergeCanvas(dto([n('A'), n('B')]), dto([n('C'), n('A')]), new Map());
    expect(out.nodes.map((x) => x.id)).toEqual(['C', 'A']);
  });

  it('keeps a streaming ghost that the vault does not have yet, with its edge', () => {
    const ghost = n('G', { role: 'assistant', parents: ['A'] });
    const cur = dto([n('A'), ghost], [{ id: 'e-A-G', from: 'A', to: 'G' }]);
    const out = mergeCanvas(cur, dto([n('A', { summary: 'S' })]), new Map([['G', {}]]));
    expect(out.nodes.map((x) => x.id)).toEqual(['A', 'G']);
    expect(out.nodes[1]).toBe(ghost);
    expect(out.edges).toEqual([{ id: 'e-A-G', from: 'A', to: 'G' }]);
  });

  it('a layout change from disk is applied', () => {
    const out = mergeCanvas(dto([n('A')]), dto([n('A', { layout: { x: 10, y: 0, width: 400, height: 200 } })]), new Map());
    expect(out.nodes[0]!.layout.x).toBe(10);
  });

  it('detects repair content changes (not just length)', () => {
    const r1: Repair[] = [{ kind: 'layout-missing', id: 'A' }];
    const r2: Repair[] = [{ kind: 'dangling-parent', id: 'A', parent: 'X' }];
    const cur = dto([n('A')], [], r1);
    const fresh = dto([n('A')], [], r2);
    const out = mergeCanvas(cur, fresh, new Map());
    expect(out).not.toBe(cur);
    expect(out.repairs).toEqual(r2);
  });

  it('drops ghost edge when its from node vanishes', () => {
    const ghost = n('G', { role: 'assistant', parents: ['A'] });
    const cur = dto([n('A'), ghost], [{ id: 'e-A-G', from: 'A', to: 'G' }]);
    const out = mergeCanvas(cur, dto([n('B')]), new Map([['G', {}]]));
    expect(out.nodes.map((x) => x.id)).toEqual(['B', 'G']);
    expect(out.edges).toEqual([]);
  });
});
