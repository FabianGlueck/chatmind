import { describe, expect, it } from 'vitest';
import type { CanvasDto } from '../src/dto';
import { graphLikeFromDto } from '../src/graph-like';
import { placeChild } from '../src/layout';

const dto: CanvasDto = {
  slug: 'm',
  nodes: [
    { id: 'A', role: 'user', parents: [], created: 'c', summary: 'Frage', topics: [], body: 'Body A', layout: { x: 0, y: 0, width: 400, height: 200 } },
    { id: 'B', role: 'assistant', model: 'm1', parents: ['A'], created: 'c', summary: '', topics: [], body: 'Body B', layout: { x: 0, y: 280, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-A-B', from: 'A', to: 'B' }],
  repairs: [],
};

describe('graphLikeFromDto', () => {
  it('indexes nodes and layouts by id, keeping the DTO objects', () => {
    const g = graphLikeFromDto(dto);
    expect([...g.nodes.keys()]).toEqual(['A', 'B']);
    expect(g.nodes.get('B')).toBe(dto.nodes[1]);
    expect(g.layout.get('B')).toEqual({ x: 0, y: 280, width: 400, height: 200 });
  });
  it('is accepted by the layout functions', () => {
    expect(placeChild(graphLikeFromDto(dto), 'B')).toEqual({ x: 0, y: 560, width: 400, height: 200 });
  });
});
