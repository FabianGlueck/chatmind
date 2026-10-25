import { contextSet, isAncestor, turnOf, type GraphLike } from '@chatmind/core/graph';

/** Spec M4 §6.1: cursor = what the arrows move; targets = ordered parents of the next message; excluded = ancestors taken out. */
export interface SelectionState {
  cursorId: string | null;
  targets: string[];
  excluded: string[];
}

export function clearSelection(): SelectionState {
  return { cursorId: null, targets: [], excluded: [] };
}

/** Explicit targets win; without any, the cursor is the implicit single target (M3 behaviour). */
export function effectiveTargets(s: SelectionState): string[] {
  if (s.targets.length > 0) return s.targets;
  return s.cursorId === null ? [] : [s.cursorId];
}

/** Drops exclusions that no longer lie inside the context of the current targets. */
function prune(graph: GraphLike, s: SelectionState): SelectionState {
  const { all } = contextSet(graph, effectiveTargets(s), []);
  return { ...s, excluded: s.excluded.filter((e) => all.has(e)) };
}

/**
 * The single "Space" semantics: explicit target → remove; implicit cursor target → make explicit;
 * highlighted ancestor → exclude / re-include; descendant of a target → no-op; anything else → append.
 */
export function toggleParticipation(graph: GraphLike, s: SelectionState, id: string): SelectionState {
  if (!graph.nodes.has(id)) return s;
  if (s.targets.includes(id)) {
    const targets = s.targets.filter((t) => t !== id);
    // Invariant: exclusions exist only together with explicit targets. Losing the last one
    // leaves the cursor as an implicit target whose ancestor chain never matches what was
    // excluded under the old explicit targets, so there is nothing left to prune against.
    if (targets.length === 0) return { ...s, targets, excluded: [] };
    return prune(graph, { ...s, targets });
  }
  const targets = effectiveTargets(s);
  if (targets.includes(id)) return { ...s, targets: [id] };
  const { all } = contextSet(graph, targets, s.excluded);
  if (all.has(id)) {
    const excluded = s.excluded.includes(id) ? s.excluded.filter((e) => e !== id) : [...s.excluded, id];
    return { ...s, targets, excluded };
  }
  if (targets.some((t) => isAncestor(graph, t, id))) return s;
  return prune(graph, { ...s, targets: [...targets, id] });
}

/** Spec M8 §5.4: where the cursor lands after a delete — the nearest surviving primary ancestor of the first deleted turn. */
export function survivorAbove(graph: GraphLike, id: string, deleted: ReadonlySet<string>): string | null {
  let cur: string | undefined = turnOf(graph, id)[0];
  const seen = new Set<string>();
  while (cur !== undefined && deleted.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = graph.nodes.get(cur)?.parents[0];
  }
  return cur !== undefined && graph.nodes.has(cur) && !deleted.has(cur) ? cur : null;
}
