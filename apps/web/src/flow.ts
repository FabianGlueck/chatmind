import type { CanvasDto, LinksDto, NodeDto } from '@chatmind/core';
import { attachmentsIn, bodyTokens, graphLikeFromDto, nodeTitle, placeChild, type Language } from '@chatmind/core/graph';
import type { Edge, Node, XYPosition } from '@xyflow/react';
import { attachmentUrl } from './api';
import type { StreamState } from './streams';

export { nodeTitle };

export type MessageNodeData = {
  role: NodeDto['role'];
  model?: string;
  summary: string;
  body: string;
  created: string;
  streaming?: boolean;
  error?: string;
  targetIndex?: number; // 1-based position among the merge targets (spec M4 §6.3)
  inContext?: boolean; // enters the prompt (before exclusions)
  excluded?: boolean;
  language?: Language; // for the context badge text; set only when inContext
  topic?: string; // topics[0] (spec M6 §7)
  topicIndex?: number; // colour index from topicPalette
  dimmed?: boolean; // another topic is active
  cursor?: boolean; // the arrow-key cursor (React Flow's `selected` is the move selection, spec M8 §4.1)
  deleting?: boolean; // part of the turns a pending delete would remove (spec M8 §5.4)
  compress?: 'pending' | 'running';
  outside?: boolean; // a context exists and this card is not part of it (spec M12)
  images?: string[]; // attachment URLs embedded in the body (spec M13)
  tokens?: number; // what this card adds to the prompt, when it is in context and not excluded (spec M12) // part of the run a compress asks about / is rewriting (spec M11 §6)
};

export type MessageFlowNode = Node<MessageNodeData, 'message'>;
export type GhostNodeData = { count: number; language: Language };
export type GhostFlowNode = Node<GhostNodeData, 'ghost'>;
export const GHOST_ID = 'ghost';

/** What the selection contributes to rendering; computed once per selection change in App. */
export interface FlowMarks {
  targets: readonly string[];
  all: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  language: Language;
  /** Spec M8 §5.4: cards a pending delete would remove. */
  deleting?: ReadonlySet<string>;
  /** Spec M11 §6: the run a compress asks about (`pending`) or is rewriting (`running`). */
  compress?: { ids: ReadonlySet<string>; running: boolean };
}

/** Spec M6 §7: what the topic highlight contributes to rendering. */
export interface TopicMarks { palette: ReadonlyMap<string, number>; active: string | null }

/** Canvas coordinates are React Flow coordinates — no transformation (spec M2 §2). */
export function toFlowNodes(dto: CanvasDto, streams?: ReadonlyMap<string, StreamState>, marks?: FlowMarks, topics?: TopicMarks): (MessageFlowNode | GhostFlowNode)[] {
  const nodes: (MessageFlowNode | GhostFlowNode)[] = dto.nodes.map((n) => {
    const s = streams?.get(n.id);
    const data: MessageNodeData = { role: n.role, summary: n.summary, body: n.body, created: n.created };
    if (n.model !== undefined) data.model = n.model;
    const images = attachmentsIn(n.body);
    if (images.length > 0) data.images = images.map((name) => attachmentUrl(dto.slug, name));
    if (s?.status === 'streaming') data.streaming = true;
    if (s?.status === 'error') data.error = s.error ?? 'error';
    if (marks) {
      const i = marks.targets.indexOf(n.id);
      if (i >= 0) data.targetIndex = i + 1;
      if (marks.all.has(n.id)) {
        data.inContext = true;
        data.language = marks.language;
        if (marks.excluded.has(n.id)) data.excluded = true;
        else data.tokens = bodyTokens(n.body);
      } else if (marks.all.size > 0) data.outside = true;
      if (marks.deleting?.has(n.id)) data.deleting = true;
      if (marks.compress?.ids.has(n.id)) data.compress = marks.compress.running ? 'running' : 'pending';
    }
    if (topics) {
      const t = n.topics[0];
      if (t !== undefined && t !== '') {
        data.topic = t;
        data.topicIndex = topics.palette.get(t) ?? 0;
      }
      if (topics.active !== null && t !== topics.active) data.dimmed = true;
    }
    // Spec M8 §4.1: the user moves cards; a streaming card stays put — the completion writes the layout it started with.
    return { id: n.id, type: 'message', position: { x: n.layout.x, y: n.layout.y }, width: n.layout.width, height: n.layout.height, draggable: s?.status !== 'streaming', connectable: false, data };
  });
  if (marks && marks.targets.length >= 2 && dto.nodes.some((n) => n.id === marks.targets[0])) {
    // Same function the server will call for the real user node, so the preview lands in the real slot.
    const layout = placeChild(graphLikeFromDto(dto), marks.targets[0]!);
    nodes.push({ id: GHOST_ID, type: 'ghost', position: { x: layout.x, y: layout.y }, width: layout.width, height: layout.height, draggable: false, connectable: false, selectable: false, data: { count: marks.targets.length, language: marks.language } });
  }
  return nodes;
}

type Flow = 'ctx' | 'ctx-skipped';

function edge(id: string, source: string, target: string, primary: boolean, flow?: Flow): Edge {
  const e: Edge = primary ? { id, source, target, type: 'smoothstep' } : { id, source, target, type: 'default', className: 'secondary' };
  if (flow === undefined) return e;
  // drawn above the other edges, so the thread stays visible where lines cross
  return { ...e, className: e.className ? `${e.className} ${flow}` : flow, zIndex: 1 };
}

/**
 * Primary edge = the target's `parents[0]` (solid smoothstep); every other parent edge is dashed bezier (spec M4 §6.3).
 * Spec M7 §6: the cursor's semantic links to nodes of this canvas are extra dashed edges from `links.from`,
 * fainter the lower their score; links into other canvases draw nothing here (the panel lists them).
 */
export function toFlowEdges(dto: CanvasDto, marks?: FlowMarks, links?: LinksDto | null): Edge[] {
  const primaryParent = new Map(dto.nodes.map((n) => [n.id, n.parents[0]]));
  // Spec M12: an edge between two context cards carries the context towards the reply; one touching an excluded card is skipped.
  const flow = (from: string, to: string): Flow | undefined => {
    if (!marks || !marks.all.has(from) || !marks.all.has(to)) return undefined;
    return marks.excluded.has(from) || marks.excluded.has(to) ? 'ctx-skipped' : 'ctx';
  };
  const edges = dto.edges.map((e) => edge(e.id, e.from, e.to, primaryParent.get(e.to) === e.from, flow(e.from, e.to)));
  if (marks && marks.targets.length >= 2) {
    marks.targets.forEach((t, i) => edges.push(edge(`e-${t}-${GHOST_ID}`, t, GHOST_ID, i === 0, 'ctx')));
  }
  const from = links?.from;
  if (links && from != null && primaryParent.has(from)) {
    for (const l of links.links) {
      if (l.canvas !== dto.slug || !primaryParent.has(l.id)) continue;
      edges.push({ id: `link-${from}-${l.id}`, source: from, target: l.id, type: 'default', className: 'link', selectable: false, focusable: false, style: { opacity: Math.min(1, Math.max(0.35, l.score)) } });
    }
  }
  return edges;
}

/** The final positions of dragged cards that differ from the canvas layout (a click without movement moves nothing). */
export function movedPositions(canvas: CanvasDto, dragged: readonly Node[]): Record<string, XYPosition> {
  const layout = new Map(canvas.nodes.map((n) => [n.id, n.layout]));
  const out: Record<string, XYPosition> = {};
  for (const n of dragged) {
    const l = layout.get(n.id);
    if (l && (Math.round(n.position.x) !== l.x || Math.round(n.position.y) !== l.y)) out[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
  }
  return out;
}

/** Local, human date for display; the raw ISO string stays in `dateTime` and the tooltip. */
export function displayDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const CONTEXT_BADGE = { de: 'im Kontext', en: 'in context' } as const;

/** The role line of a card, chat message and panel; a note shows as such (spec M16 §6). */
export function roleText(n: { role: NodeDto['role']; model?: string | undefined }): string {
  return n.role === 'note' ? '📄 note' : n.model ? `${n.role} · ${n.model}` : n.role;
}
