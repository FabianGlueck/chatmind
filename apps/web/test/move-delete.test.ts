import { graphLikeFromDto } from '@chatmind/core/graph';
import type { CanvasDto } from '@chatmind/core';
import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { movedPositions } from '../src/flow';
import { survivorAbove } from '../src/selection';

const l = (x: number, y: number) => ({ x, y, width: 400, height: 200 });
const dto: CanvasDto = { slug: 's', edges: [], repairs: [], nodes: [
  { id: 'Q1', role: 'user', parents: [], created: 'c', summary: '', topics: [], body: '', layout: l(0, 0) },
  { id: 'A1', role: 'assistant', parents: ['Q1'], created: 'c', summary: '', topics: [], body: '', layout: l(0, 280) },
  { id: 'Q2', role: 'user', parents: ['A1'], created: 'c', summary: '', topics: [], body: '', layout: l(0, 560) },
  { id: 'A2', role: 'assistant', parents: ['Q2'], created: 'c', summary: '', topics: [], body: '', layout: l(0, 840) },
] };

describe('movedPositions (spec M8 §4.1)', () => {
  it('keeps only cards whose rounded position changed', () => {
    const dragged = [{ id: 'Q1', position: { x: 0.2, y: 0 } }, { id: 'A1', position: { x: 50.6, y: 300 } }, { id: 'ghost', position: { x: 1, y: 1 } }] as Node[];
    expect(movedPositions(dto, dragged)).toEqual({ A1: { x: 51, y: 300 } });
  });
});

describe('survivorAbove (spec M8 §5.4)', () => {
  const g = graphLikeFromDto(dto);
  it('the answer above the deleted turn', () => expect(survivorAbove(g, 'A2', new Set(['Q2', 'A2']))).toBe('A1'));
  it('several turns: the nearest survivor', () => expect(survivorAbove(g, 'Q2', new Set(['Q1', 'A1', 'Q2', 'A2']))).toBeNull());
});
