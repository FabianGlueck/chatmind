import type { CanvasGraph, ForeignCanvasContent, NodeId } from './types';

export interface CanvasFileNode {
  id: string;
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
}

export interface CanvasContent {
  fileNodes: CanvasFileNode[];
  edges: CanvasEdge[];
  foreign: ForeignCanvasContent;
}

export type RawCanvas =
  | { ok: true; nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  | { ok: false; reason: string };

export function edgeId(from: NodeId, to: NodeId): string {
  return `e-${from}-${to}`;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Structural edges come from frontmatter `parents` only (spec §3.6). Dangling parents produce no edge. */
export function derivedEdges(graph: CanvasGraph): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  for (const node of graph.nodes.values()) {
    for (const parent of node.parents) {
      if (graph.nodes.has(parent)) edges.push({ id: edgeId(parent, node.id), fromNode: parent, toNode: node.id });
    }
  }
  return edges.sort(byId);
}

/**
 * Mimics Obsidian's own canvas formatting: tab-indented arrays, one compact object per line,
 * so that an Obsidian re-save produces no diff. Key order is verified manually in the M0 gate.
 */
export function serializeCanvas(content: CanvasContent): string {
  const nodeLines = [
    ...content.fileNodes.map((n) => JSON.stringify({ id: n.id, type: 'file', file: n.file, x: n.x, y: n.y, width: n.width, height: n.height })),
    ...content.foreign.nodes.map((n) => JSON.stringify(n)),
  ];
  const edgeLines = [
    ...content.edges.map((e) => JSON.stringify({ id: e.id, fromNode: e.fromNode, fromSide: 'bottom', toNode: e.toNode, toSide: 'top' })),
    ...content.foreign.edges.map((e) => JSON.stringify(e)),
  ];
  return `{\n\t"nodes":${block(nodeLines)},\n\t"edges":${block(edgeLines)}\n}`;
}

function block(lines: string[]): string {
  return lines.length === 0 ? '[]' : `[\n${lines.map((l) => `\t\t${l}`).join(',\n')}\n\t]`;
}

export function parseCanvas(text: string): RawCanvas {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'top level is not an object' };
  }
  const { nodes, edges } = data as Record<string, unknown>;
  return { ok: true, nodes: records(nodes), edges: records(edges) };
}

function records(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x));
}
