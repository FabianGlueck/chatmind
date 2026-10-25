/** Per-node consecutive-failure state (F1): `hash` is the content_hash the failures were counted against. */
export interface NodeFailure { hash: string; failures: number }

/** F1: a node given up on after this many consecutive embed/summary/topic failures is skipped until its body changes. */
export const MAX_FAILURES = 3;

/** F1: increments (or starts) the node's failure count for the given content_hash; a hash change resets it. */
export function recordFailure(failures: Map<string, NodeFailure> | undefined, id: string, hash: string): void {
  if (!failures) return;
  const cur = failures.get(id);
  failures.set(id, cur && cur.hash === hash ? { hash, failures: cur.failures + 1 } : { hash, failures: 1 });
}

/** F1: clears a node's failure count on success, so a later edit starts clean. */
export function clearFailure(failures: Map<string, NodeFailure> | undefined, id: string): void {
  failures?.delete(id);
}

/** F1: true once a node has reached MAX_FAILURES for its current content_hash (a body edit un-gives-up it). */
export function hasGivenUp(failures: Map<string, NodeFailure> | undefined, id: string, hash: string): boolean {
  const cur = failures?.get(id);
  return cur !== undefined && cur.hash === hash && cur.failures >= MAX_FAILURES;
}
