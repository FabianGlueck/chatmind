import { describe, expect, it } from 'vitest';
import { repairsForCanvas, toCanvasDto, toCanvasSummaryDto, toNodeDto } from '../src/dto';
import type { Repair } from '../src/types';
import { A, B, C, node, sampleGraph } from './helpers';

describe('toCanvasDto', () => {
  it('flattens nodes in canvas order with layout, and derives edges', () => {
    const g = sampleGraph();
    const dto = toCanvasDto(g, []);
    expect(dto.slug).toBe('masterarbeit');
    expect(dto.nodes.map((n) => n.id)).toEqual([A, B, C]);
    expect(dto.nodes[1]).toEqual({
      id: B, role: 'assistant', model: 'claude-sonnet-4-6', parents: [A], created: '2026-03-14T10:42:03Z',
      summary: 'Zentroid-Ansatz skaliert besser', topics: [], body: 'Zentroid statt Re-Clustering.\n\nBegründung folgt.',
      layout: { x: 0, y: 280, width: 400, height: 200 },
    });
    expect(dto.edges).toEqual([
      { id: `e-${A}-${B}`, from: A, to: B },
      { id: `e-${B}-${C}`, from: B, to: C },
    ]);
    expect(dto.repairs).toEqual([]);
    expect(dto.nodes[0]!.layout).not.toBe(g.layout.get(A));
    expect(dto.nodes[0]!.parents).not.toBe(g.nodes.get(A)!.parents);
  });

  it('omits the model key for user nodes and gives layout-less nodes a placeholder', () => {
    const g = sampleGraph();
    g.layout.delete(C);
    const dto = toCanvasDto(g, []);
    const c = dto.nodes.find((n) => n.id === C)!;
    expect('model' in c).toBe(false);
    expect(c.layout).toEqual({ x: 0, y: 560, width: 400, height: 200 });
  });

  it('follows graph.layout insertion order (canvas order), new nodes last', () => {
    const g = sampleGraph();
    const b = g.layout.get(B)!;
    g.layout.delete(B);
    g.layout.set(B, b);
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    g.nodes.set(D, node({ id: D, parents: [C] }));
    expect(toCanvasDto(g, []).nodes.map((n) => n.id)).toEqual([A, C, B, D]);
  });

  it('is JSON-serialisable without loss', () => {
    const dto = toCanvasDto(sampleGraph(), []);
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  });
});

describe('toCanvasSummaryDto', () => {
  it('reports slug and node count', () => {
    expect(toCanvasSummaryDto(sampleGraph())).toEqual({ slug: 'masterarbeit', nodeCount: 3 });
  });
});

describe('repairsForCanvas', () => {
  it('keeps repairs addressed to this canvas by slug, node id or path', () => {
    const g = sampleGraph();
    const repairs: Repair[] = [
      { kind: 'canvas-missing', canvas: 'masterarbeit' },
      { kind: 'canvas-missing', canvas: 'other' },
      { kind: 'layout-missing', id: A },
      { kind: 'layout-missing', id: '01JQ8F9ZZZZZZZZZZZZZZZZZZZ' },
      { kind: 'unparseable-node', path: 'masterarbeit/nodes/junk.md', reason: 'x' },
      { kind: 'unparseable-node', path: 'other/nodes/junk.md', reason: 'x' },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: 'd' },
      { kind: 'dangling-parent', id: C, parent: 'X' },
      { kind: 'orphan-canvas-node', canvas: 'masterarbeit', canvasNodeId: 'x', file: 'masterarbeit/nodes/gone.md' },
      { kind: 'orphan-canvas-node', canvas: 'other', canvasNodeId: 'x', file: 'other/nodes/gone.md' },
      { kind: 'duplicate-canvas-node', canvas: 'masterarbeit', canvasNodeId: 'dup', id: A },
      { kind: 'duplicate-canvas-node', canvas: 'other', canvasNodeId: 'dup', id: A },
    ];
    expect(repairsForCanvas(g, repairs)).toEqual([
      { kind: 'canvas-missing', canvas: 'masterarbeit' },
      { kind: 'layout-missing', id: A },
      { kind: 'unparseable-node', path: 'masterarbeit/nodes/junk.md', reason: 'x' },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: 'd' },
      { kind: 'dangling-parent', id: C, parent: 'X' },
      { kind: 'orphan-canvas-node', canvas: 'masterarbeit', canvasNodeId: 'x', file: 'masterarbeit/nodes/gone.md' },
      { kind: 'duplicate-canvas-node', canvas: 'masterarbeit', canvasNodeId: 'dup', id: A },
    ]);
  });
});

describe('toNodeDto', () => {
  it('projects a node with its layout, copying arrays and omitting an absent model', () => {
    const g = sampleGraph();
    const n = g.nodes.get(C)!;
    const dto = toNodeDto(n, g.layout.get(C)!);
    expect(dto).toEqual({ id: C, role: 'user', parents: [B], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Danke.', layout: { x: 0, y: 560, width: 400, height: 200 } });
    expect(dto.parents).not.toBe(n.parents);
    expect('model' in dto).toBe(false);
  });
});
