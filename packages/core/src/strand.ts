import { ancestorChain, contextSet, type ContextSegment } from './context';
import type { GraphLike, NodeLike } from './graph-like';
import type { NodeId } from './types';

export interface StrandItem<N extends NodeLike = NodeLike> {
  node: N;
  /** Primary children of `node.parents[0]` (all roots for a root), sorted by id — the fork switcher's range. */
  siblings: NodeId[];
  /** For a merge node: the merged-in branches (segments 2..n of the prompt's context set); otherwise empty. */
  merged: ContextSegment<N>[];
}

const byId = (a: NodeId, b: NodeId): number => (a < b ? -1 : a > b ? 1 : 0);

function primaryChildren(graph: GraphLike, id: NodeId | null): NodeId[] {
  const out: NodeId[] = [];
  for (const n of graph.nodes.values()) if ((id === null ? n.parents.length === 0 : n.parents[0] === id)) out.push(n.id);
  return out.sort(byId);
}

/**
 * Spec M9 §3: the strand through `cursor` — root → cursor along `parents[0]`, then down to a leaf, taking the
 * remembered child where it is still one and the newest child otherwise. Upwards it is `ancestorChain`, the chain
 * the prompt uses. An unknown cursor yields [].
 */
export function strandOf<N extends NodeLike>(graph: GraphLike<N>, cursor: NodeId, preferred: ReadonlyMap<NodeId, NodeId>): StrandItem<N>[] {
  if (!graph.nodes.has(cursor)) return [];
  let leaf = cursor;
  const seen = new Set<NodeId>([cursor]);
  for (;;) {
    const children = primaryChildren(graph, leaf);
    if (children.length === 0) break;
    const want = preferred.get(leaf);
    const next = want !== undefined && children.includes(want) ? want : children[children.length - 1]!;
    if (seen.has(next)) break;
    seen.add(next);
    leaf = next;
  }
  return ancestorChain(graph, leaf).map((node) => ({
    node,
    siblings: primaryChildren(graph, node.parents[0] ?? null),
    merged: node.parents.length > 1 ? mergedBranches(graph, node) : [],
  }));
}

/** Secondary segments of a merge, minus nodes already shown inline or in an earlier block (as `buildContext` dedups). */
function mergedBranches<N extends NodeLike>(graph: GraphLike<N>, node: N): ContextSegment<N>[] {
  const shown = new Set(ancestorChain(graph, node.id).map((n) => n.id));
  return contextSet(graph, node.parents, []).segments.slice(1).map((seg) => ({
    target: seg.target,
    nodes: seg.nodes.filter((n) => (shown.has(n.id) ? false : (shown.add(n.id), true))),
  }));
}

/** Spec M9 §3: remember the branch taken at every fork on the cursor's chain, so moving up keeps it below. */
export function rememberPath(graph: GraphLike, cursor: NodeId, preferred: ReadonlyMap<NodeId, NodeId>): ReadonlyMap<NodeId, NodeId> {
  const chain = ancestorChain(graph, cursor);
  const pairs = chain.slice(1).map((n, i) => [chain[i]!.id, n.id] as const);
  if (pairs.every(([p, c]) => preferred.get(p) === c)) return preferred as Map<NodeId, NodeId>; // unchanged: same object, no re-render
  const out = new Map(preferred);
  for (const [p, c] of pairs) out.set(p, c);
  return out;
}
