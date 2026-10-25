import type { CanvasDto, EdgeDto, NodeDto, Repair } from '@chatmind/core';

function sameLayout(a: NodeDto['layout'], b: NodeDto['layout']): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function sameNode(a: NodeDto, b: NodeDto): boolean {
  return a.role === b.role && a.model === b.model && a.created === b.created && a.summary === b.summary && a.body === b.body && sameList(a.parents, b.parents) && sameList(a.topics, b.topics) && sameLayout(a.layout, b.layout);
}
function sameEdges(a: readonly EdgeDto[], b: readonly EdgeDto[]): boolean {
  return a.length === b.length && a.every((e, i) => e.id === b[i]!.id && e.from === b[i]!.from && e.to === b[i]!.to);
}
function sameRepairs(a: readonly Repair[], b: readonly Repair[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Spec M5 §7: merge a refetched canvas into the current one by id. Unchanged nodes keep their object
 * (React Flow does not remount), changed/new nodes come from `fresh` in its order, vanished nodes go —
 * except streaming ghosts (ids in `streams`), which belong to the client until `done`. Returns `current`
 * itself when nothing differs.
 */
export function mergeCanvas(current: CanvasDto, fresh: CanvasDto, streams: ReadonlyMap<string, unknown>): CanvasDto {
  const byId = new Map(current.nodes.map((n) => [n.id, n]));
  const nodes: NodeDto[] = fresh.nodes.map((n) => {
    const cur = byId.get(n.id);
    return cur !== undefined && sameNode(cur, n) ? cur : n;
  });
  const freshIds = new Set(fresh.nodes.map((n) => n.id));
  const ghosts = current.nodes.filter((n) => !freshIds.has(n.id) && streams.has(n.id));
  nodes.push(...ghosts);
  const ghostIds = new Set(ghosts.map((g) => g.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: EdgeDto[] = [...fresh.edges, ...current.edges.filter((e) => ghostIds.has(e.to) && nodeIds.has(e.from))];
  const unchanged = nodes.length === current.nodes.length && nodes.every((n, i) => n === current.nodes[i]) && sameEdges(edges, current.edges) && sameRepairs(fresh.repairs, current.repairs);
  return unchanged ? current : { slug: current.slug, nodes, edges, repairs: fresh.repairs };
}
