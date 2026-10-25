import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { derivedEdges, serializeCanvas, type CanvasFileNode } from '../canvas';
import type { CompressionPlan } from '../compress';
import { spliceOut } from '../delete';
import { normalizeBody, serializeNodeFile } from '../frontmatter';
import { isCanvasSlug, nodeFileName } from '../ids';
import { placeholderLayout } from '../layout';
import { memoryPath, serializeMemoryFile } from '../memory';
import type { CanvasGraph, MessageNode, NodeId, TopicMemory } from '../types';
import { CANVAS_FILE, NODES_DIR, exists } from './paths';

export function sortedNodes(graph: CanvasGraph): MessageNode[] {
  return [...graph.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Order nodes for `graph.canvas` output: existing nodes keep the order of `graph.layout`
 * (i.e. the order the canvas was read in) instead of being re-sorted by id, then any node
 * without a prior layout entry is appended sorted by id. Obsidian reorders a canvas's `nodes`
 * array on interaction — the last element renders on top (z-order) — so re-sorting by id on
 * every write would both churn the file on every save and silently discard that z-order.
 */
export function canvasOrder(graph: CanvasGraph): MessageNode[] {
  const existing: MessageNode[] = [];
  const unlaidOut: MessageNode[] = [];
  for (const id of graph.layout.keys()) {
    const node = graph.nodes.get(id);
    if (node !== undefined) existing.push(node);
  }
  const laidOutIds = new Set(existing.map((n) => n.id));
  for (const node of sortedNodes(graph)) {
    if (!laidOutIds.has(node.id)) unlaidOut.push(node);
  }
  return [...existing, ...unlaidOut];
}

/** Write one node's markdown file, assigning its path on first write. Never renames. */
export async function writeNode(graph: CanvasGraph, id: NodeId, root: string): Promise<void> {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`node ${id} not in graph`);
  const { slug } = graph;
  const resolvedRoot = path.resolve(root);
  let rel = graph.paths.get(id);
  if (rel === undefined) {
    rel = `${slug}/${NODES_DIR}/${nodeFileName(id, node.summary)}`;
    graph.paths.set(id, rel);
  }
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(resolvedRoot + path.sep)) throw new Error(`node ${id}: path "${rel}" escapes the data dir`);
  await writeIfChanged(abs, serializeNodeFile(node, slug));
}

/** Write graph.canvas from the in-memory graph; nodes without layout get a placeholder recorded first. */
export async function writeCanvasFile(graph: CanvasGraph, root: string): Promise<void> {
  const fileNodes: CanvasFileNode[] = [];
  for (const node of canvasOrder(graph)) {
    const rel = graph.paths.get(node.id);
    if (rel === undefined) throw new Error(`node ${node.id} has no path — call writeNode first`);
    let layout = graph.layout.get(node.id);
    if (layout === undefined) {
      layout = placeholderLayout(node, graph.layout);
      graph.layout.set(node.id, layout);
    }
    fileNodes.push({ id: node.id, file: rel, ...layout });
  }
  await fs.mkdir(path.join(root, graph.slug), { recursive: true });
  await writeIfChanged(path.join(root, graph.slug, CANVAS_FILE), serializeCanvas({ fileNodes, edges: derivedEdges(graph), foreign: graph.foreign }));
}

/**
 * Write a whole canvas folder. Only files whose bytes change are written; nothing is ever renamed or deleted.
 * Side effects on `graph`: paths and placeholder layouts are recorded so memory matches disk afterwards.
 */
export async function writeCanvas(graph: CanvasGraph, root: string): Promise<void> {
  if (!isCanvasSlug(graph.slug)) throw new Error(`invalid canvas slug "${graph.slug}"`);
  await fs.mkdir(path.join(root, graph.slug, NODES_DIR), { recursive: true });
  for (const node of canvasOrder(graph)) await writeNode(graph, node.id, root);
  await writeCanvasFile(graph, root);
}

/** Atomic write (temp file + rename in the same directory), skipped when the content is already on disk. */
export async function writeIfChanged(abs: string, content: string): Promise<boolean> {
  let existing: string | undefined;
  try {
    existing = await fs.readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing === content) return false;

  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, abs);
  return true;
}

/**
 * Spec M5 §6: the one exception to "never rename". Renames exactly once, from `{ULID}.md` to
 * `{ULID}-{slug}.md`, and only when the summary yields a slug and the target is free. Updates
 * `graph.paths`; the caller writes graph.canvas afterwards. Returns whether a rename happened.
 */
export async function renameNodeFile(graph: CanvasGraph, id: NodeId, root: string): Promise<boolean> {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`node ${id} not in graph`);
  const rel = graph.paths.get(id);
  if (rel === undefined) throw new Error(`node ${id} has no path — call writeNode first`);
  if (path.posix.basename(rel) !== `${id}.md`) return false;
  const target = nodeFileName(id, node.summary);
  if (target === `${id}.md`) return false;
  const newRel = `${path.posix.dirname(rel)}/${target}`;
  const absNew = path.resolve(root, newRel);
  if (await exists(absNew)) return false;
  await fs.rename(path.resolve(root, rel), absNew);
  graph.paths.set(id, newRel);
  return true;
}

export const TRASH_DIR = '.trash';

/** A free name in `dir`: `name.md`, then Obsidian-style `name 1.md`, `name 2.md`, …. */
async function freeName(dir: string, base: string): Promise<string> {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 0; ; i++) {
    const name = i === 0 ? base : `${stem} ${i}${ext}`;
    if (!(await exists(path.join(dir, name)))) return name;
  }
}

/** Move the files of `ids` to `<root>/.trash/` (never unlinked) and drop them from the in-memory graph. */
async function trashNodes(graph: CanvasGraph, ids: Iterable<NodeId>, root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const trash = path.join(root, TRASH_DIR);
  await fs.mkdir(trash, { recursive: true });
  for (const id of [...ids].sort()) {
    const rel = graph.paths.get(id);
    if (rel !== undefined) {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(resolvedRoot + path.sep)) throw new Error(`node ${id}: path "${rel}" escapes the data dir`);
      if (await exists(abs)) await fs.rename(abs, path.join(trash, await freeName(trash, path.basename(abs))));
    }
    graph.nodes.delete(id);
    graph.layout.delete(id);
    graph.paths.delete(id);
  }
}

/**
 * Spec M8 §5.3: the user's delete — the second exception to "never delete". Survivors that named a deleted node get
 * their spliced `parents` written first, then the deleted files move to `<root>/.trash/` (never unlinked), then
 * graph.canvas is rewritten. Every intermediate state reads back as a valid graph. Returns the reparented ids.
 */
export async function deleteNodes(graph: CanvasGraph, deleted: ReadonlySet<NodeId>, root: string): Promise<NodeId[]> {
  const changed = spliceOut(graph, deleted);
  for (const [id, parents] of changed) {
    graph.nodes.set(id, { ...graph.nodes.get(id)!, parents });
    await writeNode(graph, id, root);
  }
  await trashNodes(graph, deleted, root);
  await writeCanvasFile(graph, root);
  return [...changed.keys()];
}

/**
 * Spec M11 §5: the user's compress. New node files first, then the reparented survivors, then the replaced files
 * move to `.trash/`, then graph.canvas — every intermediate state reads back as a valid graph.
 */
export async function replaceNodes(graph: CanvasGraph, plan: CompressionPlan, root: string): Promise<void> {
  for (const n of plan.added) {
    graph.nodes.set(n.id, n);
    const l = plan.layout.get(n.id);
    if (l) graph.layout.set(n.id, l);
    await writeNode(graph, n.id, root);
  }
  for (const [id, parents] of plan.reparent) {
    graph.nodes.set(id, { ...graph.nodes.get(id)!, parents });
    await writeNode(graph, id, root);
  }
  await trashNodes(graph, plan.removed, root);
  for (const [id, l] of plan.moved) if (graph.layout.has(id)) graph.layout.set(id, l);
  await writeCanvasFile(graph, root);
}

/**
 * Spec M15 §1: write one memory file — at its own path, or (a new topic) at the first free slug path, never over
 * another file. Updates `graph.memories` and returns the memory with its path. Unchanged bytes are not written.
 */
export async function writeMemory(graph: CanvasGraph, m: { topic: string; covered: NodeId[]; body: string; path?: string }, root: string): Promise<TopicMemory> {
  let rel = m.path;
  if (rel === undefined) {
    const taken = new Set((graph.memories ?? []).map((x) => x.path));
    rel = memoryPath(graph.slug, m.topic, taken);
    while (await exists(path.resolve(root, rel))) { taken.add(rel); rel = memoryPath(graph.slug, m.topic, taken); }
  }
  const memory: TopicMemory = { topic: m.topic, covered: [...m.covered], body: normalizeBody(m.body), path: rel };
  await writeIfChanged(path.resolve(root, rel), serializeMemoryFile(memory));
  graph.memories = [...(graph.memories ?? []).filter((x) => x.path !== rel), memory];
  return memory;
}
