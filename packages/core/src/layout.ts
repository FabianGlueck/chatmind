import { ancestorChain } from './context';
import type { GraphLike, NodeLike } from './graph-like';
import type { Layout, NodeId } from './types';

export const NODE_WIDTH = 400;
export const NODE_HEIGHT = 200;
export const NODE_GAP = 80;

/** Naive placement for nodes without a canvas entry (the reader's repair path); `placeChild` is the rule for new nodes. */
export function placeholderLayout(node: { parents: NodeId[] }, layout: ReadonlyMap<NodeId, Layout>): Layout {
  const primary = node.parents[0];
  const parent = primary === undefined ? undefined : layout.get(primary);
  if (parent) return { x: parent.x, y: parent.y + parent.height + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT };
  return { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT };
}

export function columnLayout(ids: NodeId[]): Map<NodeId, Layout> {
  return new Map(ids.map((id, i) => [id, { x: 0, y: i * (NODE_HEIGHT + NODE_GAP), width: NODE_WIDTH, height: NODE_HEIGHT }]));
}

function byId<N extends { id: string }>(a: N, b: N): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Children for layout purposes: nodes whose PRIMARY parent (parents[0]) is `id`, in creation order. */
export function childrenOf<N extends NodeLike>(graph: GraphLike<N>, id: NodeId): N[] {
  return [...graph.nodes.values()].filter((n) => n.parents[0] === id).sort(byId);
}

export function rootsOf<N extends NodeLike>(graph: GraphLike<N>): N[] {
  return [...graph.nodes.values()].filter((n) => n.parents.length === 0).sort(byId);
}

/** Right edge of the subtree rooted at `id` (primary-parent descendants only); nodes without layout are ignored. */
export function subtreeExtentRight(graph: GraphLike, id: NodeId): number {
  let right = Number.NEGATIVE_INFINITY;
  const seen = new Set<NodeId>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const l = graph.layout.get(cur);
    if (l) right = Math.max(right, l.x + l.width);
    for (const child of childrenOf(graph, cur)) stack.push(child.id);
  }
  return right === Number.NEGATIVE_INFINITY ? 0 : right;
}

export function rectsOverlap(a: Layout, b: Layout): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Spec M16 §3: how far (in card steps per direction) the search for a free spot around a wanted point goes. */
const NEAR_SEARCH = 8;
/** Spec M16 §3: the clearance a note keeps from existing cards. */
const NEAR_CLEARANCE = NODE_GAP / 2;

/**
 * Spec M16 §3: a card at `at` (top-left) if it keeps clear of every existing card, else the nearest spot that does —
 * searched on a grid of half-card steps around `at`. Existing nodes never move.
 */
export function placeAt(graph: GraphLike, at: { x: number; y: number }): Layout {
  const rects = [...graph.layout.values()].map((r) => ({ x: r.x - NEAR_CLEARANCE, y: r.y - NEAR_CLEARANCE, width: r.width + 2 * NEAR_CLEARANCE, height: r.height + 2 * NEAR_CLEARANCE }));
  const card = (x: number, y: number): Layout => ({ x: Math.round(x), y: Math.round(y), width: NODE_WIDTH, height: NODE_HEIGHT });
  const sx = (NODE_WIDTH + NODE_GAP) / 2;
  const sy = (NODE_HEIGHT + NODE_GAP) / 2;
  const candidates: Layout[] = [];
  for (let i = -2 * NEAR_SEARCH; i <= 2 * NEAR_SEARCH; i++) for (let j = -2 * NEAR_SEARCH; j <= 2 * NEAR_SEARCH; j++) candidates.push(card(at.x + i * sx, at.y + j * sy));
  const dist = (c: Layout): number => (c.x - at.x) ** 2 + (c.y - at.y) ** 2;
  candidates.sort((a, b) => dist(a) - dist(b) || a.y - b.y || a.x - b.x);
  return candidates.find((c) => !rects.some((r) => rectsOverlap(c, r))) ?? card(at.x, at.y);
}

/** Rows below a child slot that should be free, so the new branch has room to grow downwards (spec M3 §5, amended 2026-09-24). */
export const LANE_ROWS = 3;
/** How far (in slots per side) the search for a free lane goes before settling for any free slot. */
const LANE_SEARCH = 12;

/**
 * Spec M3 §5 (root rule amended 2026-09-18, child rule amended 2026-09-24). Deterministic slot for a new child of
 * `parentId` (or a new root when null). Existing nodes never move.
 * A child sits in the row below its parent, in the free slot nearest to the parent's column: first directly below,
 * then fanning out alternately right and left (the side with fewer existing siblings first, ties go right). A slot
 * counts only if its lane is clear — nothing but the parent in the row above, nothing in the `LANE_ROWS` rows below —
 * so a branch neither steals another node's continuation nor runs into an existing strand. Without such a slot
 * nearby, the nearest merely non-overlapping slot wins.
 */
export function placeChild(graph: GraphLike, parentId: NodeId | null): Layout {
  const rects = [...graph.layout.values()];
  const free = (c: Layout) => !rects.some((r) => rectsOverlap(c, r));
  if (parentId === null) {
    // Roots form a row along the top; each strand grows downwards from its root. A new root goes right of
    // everything (a wide strand pushes it further) and aligns with the topmost existing root.
    let right = Number.NEGATIVE_INFINITY;
    for (const l of rects) right = Math.max(right, l.x + l.width);
    let top = Number.POSITIVE_INFINITY;
    for (const r of rootsOf(graph)) {
      const l = graph.layout.get(r.id);
      if (l) top = Math.min(top, l.y);
    }
    const candidate: Layout = { x: right === Number.NEGATIVE_INFINITY ? 0 : right + NODE_GAP, y: top === Number.POSITIVE_INFINITY ? 0 : top, width: NODE_WIDTH, height: NODE_HEIGHT };
    while (!free(candidate)) candidate.x += NODE_WIDTH + NODE_GAP;
    return candidate;
  }
  const p = graph.layout.get(parentId);
  if (!p) throw new Error(`parent ${parentId} has no layout`);
  const y = p.y + p.height + NODE_GAP;
  let left = 0;
  let right = 0;
  for (const s of childrenOf(graph, parentId)) {
    const l = graph.layout.get(s.id);
    if (!l) continue;
    const d = l.x + l.width / 2 - (p.x + p.width / 2);
    if (d < 0) left++;
    else if (d > 0) right++;
  }
  const first = left < right ? -1 : 1;
  const step = NODE_WIDTH + NODE_GAP;
  const at = (k: number): Layout => ({ x: p.x + k * step, y, width: NODE_WIDTH, height: NODE_HEIGHT });
  const laneClear = (c: Layout) => {
    const lane: Layout = { x: c.x, y: c.y - NODE_GAP - NODE_HEIGHT, width: c.width, height: (LANE_ROWS + 2) * (NODE_HEIGHT + NODE_GAP) - NODE_GAP };
    return !rects.some((r) => r !== p && rectsOverlap(lane, r));
  };
  for (let i = 0; i <= LANE_SEARCH; i++) for (const k of i === 0 ? [0] : [first * i, -first * i]) if (laneClear(at(k))) return at(k);
  for (let i = 0; ; i++) for (const k of i === 0 ? [0] : [first * i, -first * i]) if (free(at(k))) return at(k);
}

/**
 * Spec M14: the cards among `ids` that share the strand (root) holding most of them — a topic spread over several
 * strands is anchored where most of it lives; a tie goes to the strand with the newest card.
 */
export function densestStrand(graph: GraphLike, ids: readonly NodeId[]): NodeId[] {
  const groups = new Map<NodeId, NodeId[]>();
  for (const id of ids) {
    const root = ancestorChain(graph, id)[0]?.id;
    if (root !== undefined) groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  let best: NodeId[] = [];
  const newest = (g: NodeId[]) => g.reduce((m, x) => (x > m ? x : m), '');
  for (const g of groups.values()) if (g.length > best.length || (g.length === best.length && newest(g) > newest(best))) best = g;
  return best;
}

/**
 * Spec M14: a slot for a new root next to the cards `ids` (the cards of a topic) — right of their rightmost edge at
 * the height of their top card, else below their lowest card in their leftmost column, a row further down while
 * taken. A slot needs a clear lane (itself and `LANE_ROWS` rows below). `null` when none of `ids` has a layout.
 */
export function placeNear(graph: GraphLike, ids: readonly NodeId[]): Layout | null {
  const own = ids.map((id) => graph.layout.get(id)).filter((l): l is Layout => l !== undefined);
  if (own.length === 0) return null;
  const rects = [...graph.layout.values()];
  const row = NODE_HEIGHT + NODE_GAP;
  const clear = (c: Layout) => !rects.some((r) => rectsOverlap({ ...c, height: (LANE_ROWS + 1) * row - NODE_GAP }, r));
  const right: Layout = { x: Math.max(...own.map((l) => l.x + l.width)) + NODE_GAP, y: Math.min(...own.map((l) => l.y)), width: NODE_WIDTH, height: NODE_HEIGHT };
  if (clear(right)) return right;
  const below: Layout = { x: Math.min(...own.map((l) => l.x)), y: Math.max(...own.map((l) => l.y + l.height)) + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT };
  while (!clear(below)) below.y += row;
  return below;
}

/**
 * Spec M8 §4.3: the user's move. Sets x/y (rounded — Obsidian writes integers) of every id that already has a
 * layout; width/height stay. Returns the ids actually moved. The layout logic above never calls this.
 */
export function moveNodes(layout: Map<NodeId, Layout>, positions: Readonly<Record<NodeId, { x: number; y: number }>>): NodeId[] {
  const moved: NodeId[] = [];
  for (const [id, p] of Object.entries(positions)) {
    const l = layout.get(id);
    if (!l) continue;
    layout.set(id, { ...l, x: Math.round(p.x), y: Math.round(p.y) });
    moved.push(id);
  }
  return moved;
}
