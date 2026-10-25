import { derivedEdges } from './canvas';
import { placeholderLayout } from './layout';
import type { CanvasGraph, Layout, MessageNode, Repair, Role } from './types';
import { canvasOrder } from './vault/write';

/** JSON-safe projection of a MessageNode plus its canvas position. */
export interface NodeDto {
  id: string;
  role: Role;
  model?: string;
  parents: string[];
  created: string;
  summary: string;
  topics: string[];
  body: string;
  layout: Layout;
}

export interface EdgeDto {
  id: string;
  from: string;
  to: string;
}

/** Spec M15 §6: a topic memory as the browser sees it; `covered` is only a count. */
export interface MemoryDto { topic: string; body: string; covered: number }

export interface CanvasDto {
  slug: string;
  nodes: NodeDto[];
  edges: EdgeDto[];
  repairs: Repair[];
  memories?: MemoryDto[]; // always set by toCanvasDto; optional only so hand-built DTOs (tests) need not list it
}

export interface CanvasSummaryDto {
  slug: string;
  nodeCount: number;
}

/** Spec M7 §5: one semantic link of the selected node; `canvas` is the target's slug. */
export interface LinkDto {
  id: string;
  canvas: string;
  summary: string;
  /** Centred cosine. */
  similarity: number;
  /** Hub-corrected score (spec M7 §4, amended 2026-09-24): what the threshold applies to, the order, what the UI shows. */
  score: number;
}

/** Spec M7 §5: `from` is the assistant node the links belong to (≠ the requested id for a user node). */
export interface LinksDto {
  from: string | null;
  links: LinkDto[];
  /** Why `links` is empty, when that is not simply "none found". */
  reason?: 'no-index' | 'no-answer' | 'no-vector';
}

/** JSON-safe projection of a single node plus its canvas layout. */
export function toNodeDto(n: MessageNode, layout: Layout): NodeDto {
  const dto: NodeDto = { id: n.id, role: n.role, parents: [...n.parents], created: n.created, summary: n.summary, topics: [...n.topics], body: n.body, layout: { ...layout } };
  if (n.model !== undefined) dto.model = n.model;
  return dto;
}

/** Nodes in canvas order (spec §10), every node with a layout; edges derived from `parents` (spec §3.6). */
export function toCanvasDto(graph: CanvasGraph, repairs: Repair[]): CanvasDto {
  const nodes: NodeDto[] = [];
  for (const n of canvasOrder(graph)) {
    nodes.push(toNodeDto(n, graph.layout.get(n.id) ?? placeholderLayout(n, graph.layout)));
  }
  const edges = derivedEdges(graph).map((e) => ({ id: e.id, from: e.fromNode, to: e.toNode }));
  const memories = (graph.memories ?? []).map((m) => ({ topic: m.topic, body: m.body, covered: m.covered.length }));
  return { slug: graph.slug, nodes, edges, repairs: repairsForCanvas(graph, repairs), memories };
}

export function toCanvasSummaryDto(graph: CanvasGraph): CanvasSummaryDto {
  return { slug: graph.slug, nodeCount: graph.nodes.size };
}

/** The subset of a vault's repairs that concern this canvas. */
export function repairsForCanvas(graph: CanvasGraph, repairs: Repair[]): Repair[] {
  return repairs.filter((r) => {
    if ('canvas' in r) return r.canvas === graph.slug;
    if ('path' in r) return r.path.startsWith(`${graph.slug}/`);
    return graph.nodes.has(r.id);
  });
}

export type Provider = 'anthropic' | 'openai' | 'openrouter';
export interface ModelDto {
  id: string;
  provider: Provider;
  label: string;
  available: boolean;
  contextTokens: number; // the model's context window; the client derives its budget with budgetFor()
}
export interface SendRequest {
  parentIds: string[]; // [] = new root message; ≥2 = merge (spec M4 §5)
  excludedIds?: string[]; // ancestors taken out of the context; must lie inside contextSet(...).all
  content: string; // may be empty when `images` is not
  model: string;
  images?: { mediaType: string; data: string }[]; // spec M13: base64, written to attachments/ with the user node
  memoryTopics?: string[]; // spec M15 §4: memories that go into the system prompt; the server reads them from the files
}
