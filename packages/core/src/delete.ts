import type { GraphLike } from './graph-like';
import type { NodeId } from './types';

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Spec M8 §5.1: the unit a delete removes. A question takes its assistant answers along; an answer resolves to
 * its question's turn; anything else (root assistant, assistant under a non-question) stands alone.
 */
export function turnOf(graph: GraphLike, id: NodeId): NodeId[] {
  const n = graph.nodes.get(id);
  if (!n) return [];
  if (n.role === 'assistant') {
    const q = n.parents[0] === undefined ? undefined : graph.nodes.get(n.parents[0]);
    return q?.role === 'user' ? turnOf(graph, q.id) : [id];
  }
  const answers = [...graph.nodes.values()].filter((c) => c.role === 'assistant' && c.parents.includes(id)).map((c) => c.id).sort(byId);
  return [id, ...answers];
}

/** Spec M8 §5.1: the union of the turns of `ids`. */
export function deleteSet(graph: GraphLike, ids: readonly NodeId[]): Set<NodeId> {
  return new Set(ids.flatMap((id) => turnOf(graph, id)));
}

/**
 * Spec M8 §5.2: the new `parents` of every survivor that named a deleted node. Each deleted entry is replaced in
 * place by the deleted node's own parents (recursively, so a chain of deleted turns collapses to the nearest
 * survivors), de-duplicated keeping the first occurrence. Dangling parents are kept as they are.
 */
export function spliceOut(graph: GraphLike, deleted: ReadonlySet<NodeId>): Map<NodeId, NodeId[]> {
  const memo = new Map<NodeId, NodeId[]>();
  const resolve = (p: NodeId, seen: Set<NodeId>): NodeId[] => {
    if (!deleted.has(p)) return [p];
    const hit = memo.get(p);
    if (hit) return hit;
    if (seen.has(p)) return []; // a cycle from a hand-edited vault
    seen.add(p);
    const out = (graph.nodes.get(p)?.parents ?? []).flatMap((q) => resolve(q, seen));
    memo.set(p, out);
    return out;
  };
  const changed = new Map<NodeId, NodeId[]>();
  for (const n of graph.nodes.values()) {
    if (deleted.has(n.id) || !n.parents.some((p) => deleted.has(p))) continue;
    changed.set(n.id, [...new Set(n.parents.flatMap((p) => resolve(p, new Set())))]);
  }
  return changed;
}
