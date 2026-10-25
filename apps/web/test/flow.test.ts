import type { CanvasDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { toFlowEdges, toFlowNodes, GHOST_ID, type MessageFlowNode } from '../src/flow';
import type { FlowMarks } from '../src/flow';

const dto: CanvasDto = {
  slug: 'm',
  nodes: [
    { id: 'A', role: 'user', parents: [], created: '2026-01-01T00:00:00Z', summary: 'Frage', topics: [], body: 'Body A', layout: { x: 10, y: 20, width: 400, height: 200 } },
    { id: 'B', role: 'assistant', model: 'm1', parents: ['A'], created: '2026-01-01T00:01:00Z', summary: '', topics: [], body: 'Erste Zeile\n\nZweite', layout: { x: 10, y: 300, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-A-B', from: 'A', to: 'B' }],
  repairs: [],
};

describe('toFlowNodes', () => {
  it('maps position and size 1:1 and carries the message data', () => {
    const nodes = toFlowNodes(dto);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      id: 'A', type: 'message', position: { x: 10, y: 20 }, width: 400, height: 200,
      draggable: true, connectable: false,
      data: { role: 'user', summary: 'Frage', body: 'Body A', created: '2026-01-01T00:00:00Z' },
    });
    expect(((nodes[1] as MessageFlowNode).data).model).toBe('m1');
    expect('model' in nodes[0]!.data).toBe(false);
  });
  it('spec M13: carries the URLs of embedded images and counts each as IMAGE_TOKENS', () => {
    const name = '01JQ7M2V3X4Y5Z6A7B8C9D0E1F.png';
    const withImage: CanvasDto = { ...dto, nodes: [{ ...dto.nodes[0]!, body: `![[${name}]]` }, dto.nodes[1]!] };
    const [a, b] = toFlowNodes(withImage, undefined, { targets: ['A'], all: new Set(['A']), excluded: new Set(), language: 'en' }) as MessageFlowNode[];
    expect(a!.data.images).toEqual([`/api/canvases/m/attachments/${name}`]);
    expect(a!.data.tokens).toBe(1600);
    expect(b!.data.images).toBeUndefined();
  });
  it('a streaming card is not draggable; a pending delete marks its cards (spec M8)', () => {
    const nodes = toFlowNodes(dto, new Map([['B', { status: 'streaming', text: '', model: 'm1' }]]) as never, { targets: [], all: new Set(), excluded: new Set(), language: 'en', deleting: new Set(['A']) });
    expect(nodes.map((n) => n.draggable)).toEqual([true, false]);
    expect((nodes[0] as MessageFlowNode).data.deleting).toBe(true);
    expect('deleting' in (nodes[1] as MessageFlowNode).data).toBe(false);
  });
  it('carries topic, colour index and dimming into node data (spec M6 §7)', () => {
    const d: CanvasDto = { slug: 'm', edges: [], repairs: [], nodes: [
      { id: 'a', role: 'user', parents: [], created: 'c', summary: '', topics: ['Alpha'], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } },
      { id: 'b', role: 'user', parents: [], created: 'c', summary: '', topics: [], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } },
    ] };
    const palette = new Map([['Alpha', 3]]);
    const off = toFlowNodes(d, undefined, undefined, { palette, active: null });
    expect(off[0]!.data).toMatchObject({ topic: 'Alpha', topicIndex: 3 });
    expect(off[0]!.data).not.toHaveProperty('dimmed');
    expect(off[1]!.data).not.toHaveProperty('topic');
    const on = toFlowNodes(d, undefined, undefined, { palette, active: 'Alpha' });
    expect(on[0]!.data).not.toHaveProperty('dimmed');
    expect(on[1]!.data).toMatchObject({ dimmed: true });
  });
});

describe('toFlowEdges', () => {
  it('maps from/to to source/target with smoothstep type', () => {
    expect(toFlowEdges(dto)).toEqual([{ id: 'e-A-B', source: 'A', target: 'B', type: 'smoothstep' }]);
  });
});

// A(user) → B(assistant) ; A → C(user) ; M(user, parents [B, C]) — a merge node already on the canvas
const merged: CanvasDto = {
  slug: 'm',
  nodes: [
    ...dto.nodes,
    { id: 'C', role: 'user', parents: ['A'], created: 'c', summary: 'C', topics: [], body: 'c', layout: { x: 480, y: 300, width: 400, height: 200 } },
    { id: 'M', role: 'user', parents: ['B', 'C'], created: 'c', summary: 'M', topics: [], body: 'm', layout: { x: 10, y: 580, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-A-B', from: 'A', to: 'B' }, { id: 'e-A-C', from: 'A', to: 'C' }, { id: 'e-B-M', from: 'B', to: 'M' }, { id: 'e-C-M', from: 'C', to: 'M' }],
  repairs: [],
};
const marks = (over: Partial<FlowMarks>): FlowMarks => ({ targets: [], all: new Set(), excluded: new Set(), language: 'en', ...over });

describe('toFlowNodes with marks', () => {
  it('flags targets with their 1-based index, context membership and exclusion', () => {
    const nodes = toFlowNodes(merged, undefined, marks({ targets: ['C', 'B'], all: new Set(['A', 'B', 'C']), excluded: new Set(['A']) }));
    const by = (id: string) => nodes.find((n) => n.id === id)!.data as { targetIndex?: number; inContext?: boolean; excluded?: boolean; language?: string };
    expect(by('C').targetIndex).toBe(1);
    expect(by('B').targetIndex).toBe(2);
    expect(by('A')).toMatchObject({ inContext: true, excluded: true, language: 'en' });
    expect('targetIndex' in by('A')).toBe(false);
    expect(by('M').inContext).toBeUndefined();
  });
  it('appends a ghost node under the first target when there are ≥2 targets, and none otherwise', () => {
    const none = toFlowNodes(dto, undefined, marks({ targets: ['B'] }));
    expect(none.some((n) => n.type === 'ghost')).toBe(false);
    const nodes = toFlowNodes(merged, undefined, marks({ targets: ['C', 'B'], language: 'de' }));
    const ghost = nodes.find((n) => n.type === 'ghost')!;
    expect(ghost).toMatchObject({ id: GHOST_ID, type: 'ghost', selectable: false, draggable: false, data: { count: 2, language: 'de' } });
    // placeChild(graph, 'C'): C has no primary children → x = C.x, y = C.y + 200 + 80
    expect(ghost.position).toEqual({ x: 480, y: 580 });
  });
  it('skips the ghost when the first target is not on the canvas', () => {
    const nodes = toFlowNodes(dto, undefined, marks({ targets: ['ZZZ', 'B'] }));
    expect(nodes.some((n) => n.type === 'ghost')).toBe(false);
  });
});

describe('toFlowEdges styles', () => {
  it('draws primary edges solid smoothstep and secondary edges as dashed bezier', () => {
    const edges = toFlowEdges(merged);
    expect(edges.find((e) => e.id === 'e-B-M')).toEqual({ id: 'e-B-M', source: 'B', target: 'M', type: 'smoothstep' });
    expect(edges.find((e) => e.id === 'e-C-M')).toEqual({ id: 'e-C-M', source: 'C', target: 'M', type: 'default', className: 'secondary' });
  });
  it('adds one edge per target to the ghost, the first primary', () => {
    const edges = toFlowEdges(merged, marks({ targets: ['C', 'B'] }));
    expect(edges.filter((e) => e.target === GHOST_ID)).toEqual([
      { id: `e-C-${GHOST_ID}`, source: 'C', target: GHOST_ID, type: 'smoothstep', className: 'ctx', zIndex: 1 },
      { id: `e-B-${GHOST_ID}`, source: 'B', target: GHOST_ID, type: 'default', className: 'secondary ctx', zIndex: 1 },
    ]);
    expect(toFlowEdges(merged, marks({ targets: ['C'] })).some((e) => e.target === GHOST_ID)).toBe(false);
  });
  it('spec M12: marks the context thread, dots edges at excluded cards, leaves the rest', () => {
    const edges = toFlowEdges(merged, marks({ targets: ['M'], all: new Set(['A', 'B', 'C', 'M']), excluded: new Set(['C']) }));
    const cls = (id: string) => edges.find((e) => e.id === id)!.className;
    expect(cls('e-A-B')).toBe('ctx');
    expect(cls('e-B-M')).toBe('ctx');
    expect(cls('e-A-C')).toBe('ctx-skipped');
    expect(cls('e-C-M')).toBe('secondary ctx-skipped');
    const partial = toFlowEdges(merged, marks({ targets: ['B'], all: new Set(['A', 'B']) }));
    expect(partial.find((e) => e.id === 'e-A-C')!.className).toBeUndefined();
  });
  it('spec M12: context cards carry their tokens, cards outside step back, nothing without a context', () => {
    const nodes = toFlowNodes(merged, undefined, marks({ targets: ['B'], all: new Set(['A', 'B']) })) as MessageFlowNode[];
    const data = (id: string) => nodes.find((n) => n.id === id)!.data;
    expect(data('B').tokens).toBeGreaterThan(0);
    expect(data('C').outside).toBe(true);
    expect(data('B').outside).toBeUndefined();
    expect((toFlowNodes(merged, undefined, marks({})) as MessageFlowNode[]).some((n) => n.data.outside)).toBe(false);
  });
});

describe('toFlowEdges with links (spec M7 §6)', () => {
  const three: CanvasDto = { ...dto, nodes: [...dto.nodes, { id: 'C', role: 'assistant', parents: ['A'], created: 'c', summary: '', topics: [], body: '', layout: { x: 480, y: 300, width: 400, height: 200 } }] };
  it('adds a dashed link edge from `from` to each same-canvas target, fainter the lower the hub-corrected score', () => {
    const links = { from: 'B', links: [{ id: 'C', canvas: 'm', summary: 's', similarity: 0.9, score: 0.5 }, { id: 'X', canvas: 'other', summary: 'x', similarity: 0.9, score: 0.9 }, { id: 'gone', canvas: 'm', summary: 'g', similarity: 0.8, score: 0.8 }] };
    const edges = toFlowEdges(three, undefined, links);
    const link = edges.filter((e) => e.className === 'link');
    expect(link).toHaveLength(1); // other canvas and vanished nodes draw nothing
    expect(link[0]).toMatchObject({ id: 'link-B-C', source: 'B', target: 'C', selectable: false, focusable: false, style: { opacity: 0.5 } });
    expect(toFlowEdges(three, undefined, { from: 'B', links: [{ id: 'C', canvas: 'm', summary: 's', similarity: 0.9, score: 0.1 }] })[1]!.style).toEqual({ opacity: 0.35 });
  });
  it('draws nothing without links or without `from`', () => {
    expect(toFlowEdges(three, undefined, null)).toHaveLength(1);
    expect(toFlowEdges(three, undefined, { from: null, links: [], reason: 'no-answer' })).toHaveLength(1);
  });
});
