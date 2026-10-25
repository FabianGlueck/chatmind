import type { CanvasDto, NodeDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { nextSelection } from '../src/navigation';

const n = (id: string, parents: string[]): NodeDto => ({ id, role: 'user', parents, created: 'c', summary: '', topics: [], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } });
// R1 → A → (B, C); C → D ; second root R2
const dto: CanvasDto = { slug: 'm', nodes: [n('R1', []), n('A', ['R1']), n('B', ['A']), n('C', ['A']), n('D', ['C']), n('R2', [])], edges: [], repairs: [] };

describe('nextSelection', () => {
  it('goes up to the primary parent and stays at a root', () => {
    expect(nextSelection(dto, 'D', 'ArrowUp')).toBe('C');
    expect(nextSelection(dto, 'R1', 'ArrowUp')).toBe('R1');
  });
  it('goes down to the first child (by id) and stays at a leaf', () => {
    expect(nextSelection(dto, 'A', 'ArrowDown')).toBe('B');
    expect(nextSelection(dto, 'B', 'ArrowDown')).toBe('B');
  });
  it('moves between siblings, including between roots, without wrapping', () => {
    expect(nextSelection(dto, 'B', 'ArrowRight')).toBe('C');
    expect(nextSelection(dto, 'C', 'ArrowRight')).toBe('C');
    expect(nextSelection(dto, 'C', 'ArrowLeft')).toBe('B');
    expect(nextSelection(dto, 'R1', 'ArrowRight')).toBe('R2');
  });
  it('selects the first root from nothing on ArrowDown, otherwise stays empty', () => {
    expect(nextSelection(dto, null, 'ArrowDown')).toBe('R1');
    expect(nextSelection(dto, null, 'ArrowUp')).toBeNull();
    expect(nextSelection({ ...dto, nodes: [] }, null, 'ArrowDown')).toBeNull();
  });
});
