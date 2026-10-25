import { describe, expect, it } from 'vitest';
import { derivedEdges, edgeId, parseCanvas, serializeCanvas } from '../src/canvas';
import type { CanvasGraph, MessageNode } from '../src/types';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';
const C = '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA';
const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';

function node(over: Partial<MessageNode> & { id: string }): MessageNode {
  return { role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Body.', ...over };
}

function graph(nodes: MessageNode[]): CanvasGraph {
  return { slug: 'm', nodes: new Map(nodes.map((n) => [n.id, n])), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
}

const twoNodes = {
  fileNodes: [
    { id: A, file: 'm/nodes/a.md', x: 0, y: 0, width: 400, height: 200 },
    { id: B, file: 'm/nodes/b.md', x: 0, y: 280, width: 400, height: 200 },
  ],
  edges: [{ id: edgeId(A, B), fromNode: A, toNode: B }],
  foreign: { nodes: [], edges: [] },
};

describe('serializeCanvas', () => {
  it('writes Obsidian-style tab-indented JSON with one object per line', () => {
    expect(serializeCanvas(twoNodes)).toBe(
      `{
\t"nodes":[
\t\t{"id":"${A}","type":"file","file":"m/nodes/a.md","x":0,"y":0,"width":400,"height":200},
\t\t{"id":"${B}","type":"file","file":"m/nodes/b.md","x":0,"y":280,"width":400,"height":200}
\t],
\t"edges":[
\t\t{"id":"e-${A}-${B}","fromNode":"${A}","fromSide":"bottom","toNode":"${B}","toSide":"top"}
\t]
}`,
    );
  });

  it('writes empty arrays compactly', () => {
    expect(serializeCanvas({ fileNodes: [], edges: [], foreign: { nodes: [], edges: [] } })).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}');
  });

  it('appends foreign nodes and edges verbatim after ours', () => {
    const text = serializeCanvas({
      ...twoNodes,
      foreign: {
        nodes: [{ id: 'abc123', type: 'text', text: 'note', x: 1, y: 2, width: 3, height: 4, color: '2' }],
        edges: [{ id: 'xyz', fromNode: 'abc123', toNode: A, label: 'see' }],
      },
    });
    const lines = text.split('\n');
    expect(lines[4]).toBe('\t\t{"id":"abc123","type":"text","text":"note","x":1,"y":2,"width":3,"height":4,"color":"2"}');
    expect(lines[8]).toBe('\t\t{"id":"xyz","fromNode":"abc123","toNode":"' + A + '","label":"see"}');
  });

  it('is valid JSON', () => {
    expect(() => JSON.parse(serializeCanvas(twoNodes))).not.toThrow();
  });
});

describe('parseCanvas', () => {
  it('returns nodes and edges of a valid canvas', () => {
    const r = parseCanvas(serializeCanvas(twoNodes));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]).toEqual({ id: A, type: 'file', file: 'm/nodes/a.md', x: 0, y: 0, width: 400, height: 200 });
    expect(r.edges).toEqual([{ id: edgeId(A, B), fromNode: A, fromSide: 'bottom', toNode: B, toSide: 'top' }]);
  });

  it('treats missing arrays as empty and drops non-object entries', () => {
    expect(parseCanvas('{}')).toEqual({ ok: true, nodes: [], edges: [] });
    expect(parseCanvas('{"nodes":[1,"x",null,{"id":"a"}]}')).toEqual({ ok: true, nodes: [{ id: 'a' }], edges: [] });
  });

  it('rejects invalid JSON and non-object roots', () => {
    const bad = parseCanvas('{nope');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toMatch(/^invalid JSON/);
    expect(parseCanvas('[]')).toEqual({ ok: false, reason: 'top level is not an object' });
    expect(parseCanvas('null')).toEqual({ ok: false, reason: 'top level is not an object' });
  });
});

describe('derivedEdges', () => {
  it('derives one edge per known parent, sorted by id, skipping dangling parents', () => {
    const g = graph([
      node({ id: A }),
      node({ id: B, parents: [A] }),
      node({ id: C, parents: [A] }),
      node({ id: D, parents: [C, B, '01JQ8F9ZZZZZZZZZZZZZZZZZZZ'] }),
    ]);
    expect(derivedEdges(g)).toEqual([
      { id: edgeId(A, B), fromNode: A, toNode: B },
      { id: edgeId(A, C), fromNode: A, toNode: C },
      { id: edgeId(B, D), fromNode: B, toNode: D },
      { id: edgeId(C, D), fromNode: C, toNode: D },
    ]);
  });
});
