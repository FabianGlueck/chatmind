import { promises as fs } from 'node:fs';
import path from 'node:path';
import { derivedEdges, edgeId, parseCanvas } from '../canvas';
import { parseNodeFile } from '../frontmatter';
import { MEMORIES_DIR, parseMemoryFile } from '../memory';
import { topicKey } from '../topic-key';
import type { CanvasGraph, Layout, NodeId, Repair, TopicMemory } from '../types';
import { CANVAS_FILE, exists, listCanvasFolders, NODES_DIR, toVaultPath, walkMarkdownFiles } from './paths';
import { NODE_HEIGHT, NODE_WIDTH, placeholderLayout } from '../layout';
import { sortedNodes } from './write';

export interface ReadResult {
  canvases: CanvasGraph[];
  repairs: Repair[];
}

/**
 * Parse a data folder into graphs. Never throws except when `root` is unreadable; every problem
 * becomes a Repair. Never writes (spec §9).
 */
export async function readVault(root: string): Promise<ReadResult> {
  await fs.access(root);
  const repairs: Repair[] = [];
  const canvases: CanvasGraph[] = [];
  for (const slug of await listCanvasFolders(root)) {
    canvases.push(await readCanvasFolder(root, slug, repairs));
  }
  return { canvases, repairs };
}

/**
 * Spec M6 §6: one canvas folder, with exactly the graph and repairs `readVault` would produce for it.
 * `null` when `slug` is not a canvas folder (no graph.canvas and no nodes/), or would leave the root.
 */
export async function readCanvas(root: string, slug: string): Promise<{ graph: CanvasGraph; repairs: Repair[] } | null> {
  if (slug === '' || slug.startsWith('.') || slug.includes('/') || slug.includes('\\')) return null;
  const dir = path.join(root, slug);
  if (!(await exists(path.join(dir, CANVAS_FILE))) && !(await exists(path.join(dir, NODES_DIR)))) return null;
  const repairs: Repair[] = [];
  const graph = await readCanvasFolder(root, slug, repairs);
  return { graph, repairs };
}

async function readCanvasFolder(root: string, slug: string, repairs: Repair[]): Promise<CanvasGraph> {
  const graph: CanvasGraph = { slug, nodes: new Map(), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
  await scanNodes(root, graph, repairs);
  graph.memories = await readMemories(root, graph.slug, repairs);
  const pass = await applyCanvas(root, graph, repairs);
  fillMissingLayout(graph, repairs);
  checkParents(graph, repairs);
  if (pass) checkEdges(graph, pass, repairs);
  return graph;
}

/** Step 1 of spec §9: every .md under the canvas folder, indexed by frontmatter id. */
async function scanNodes(root: string, graph: CanvasGraph, repairs: Repair[]): Promise<void> {
  let files: string[];
  try {
    // Spec M15 §1: memory files are not nodes.
    const memories = path.join(root, graph.slug, MEMORIES_DIR) + path.sep;
    files = (await walkMarkdownFiles(path.join(root, graph.slug))).filter((f) => !f.startsWith(memories));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    repairs.push({ kind: 'canvas-corrupt', canvas: graph.slug, reason: `cannot scan nodes: ${code ?? String(err)}` });
    return;
  }
  for (const abs of files) {
    const rel = toVaultPath(root, abs);
    let text: string;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch (err) {
      repairs.push({ kind: 'unparseable-node', path: rel, reason: `cannot read: ${(err as NodeJS.ErrnoException).code ?? String(err)}` });
      continue;
    }
    const parsed = parseNodeFile(text);
    if (!parsed.ok) {
      repairs.push({ kind: 'unparseable-node', path: rel, reason: parsed.reason });
      continue;
    }
    const { node } = parsed;
    const kept = graph.paths.get(node.id);
    if (kept !== undefined) {
      repairs.push({ kind: 'duplicate-id', id: node.id, kept, dropped: rel });
      continue;
    }
    graph.nodes.set(node.id, node);
    graph.paths.set(node.id, rel);
    for (const field of parsed.defaulted) repairs.push({ kind: 'defaulted-field', id: node.id, field });
    if (parsed.canvas !== graph.slug) repairs.push({ kind: 'defaulted-field', id: node.id, field: 'canvas' });
  }
}

/** Spec M15 §1: every memory file of the canvas, first by path wins per topic (topicKey). */
async function readMemories(root: string, slug: string, repairs: Repair[]): Promise<TopicMemory[]> {
  let files: string[];
  try {
    files = await walkMarkdownFiles(path.join(root, slug, MEMORIES_DIR));
  } catch {
    return []; // no memories/ folder (yet)
  }
  const out: TopicMemory[] = [];
  const byKey = new Map<string, TopicMemory>();
  for (const abs of files) {
    const rel = toVaultPath(root, abs);
    let parsed: ReturnType<typeof parseMemoryFile>;
    try {
      parsed = parseMemoryFile(await fs.readFile(abs, 'utf8'));
    } catch (err) {
      parsed = { ok: false, reason: `cannot read: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
    }
    if (!parsed.ok) {
      repairs.push({ kind: 'unparseable-memory', path: rel, reason: parsed.reason });
      continue;
    }
    const kept = byKey.get(topicKey(parsed.topic));
    if (kept) {
      repairs.push({ kind: 'duplicate-memory', path: rel, topic: parsed.topic, kept: kept.path });
      continue;
    }
    const m: TopicMemory = { topic: parsed.topic, covered: parsed.covered, body: parsed.body, path: rel };
    byKey.set(topicKey(m.topic), m);
    out.push(m);
  }
  return out;
}

interface CanvasPass {
  /** canvas node id → our node id, for every canvas node that resolved to one of ours */
  ours: Map<string, NodeId>;
  /** canvas edges between two of our nodes, already resolved to our ids, for checkEdges */
  structuralEdges: { from: NodeId; to: NodeId }[];
}

/** Step 2 of spec §9: resolve canvas nodes in order (a) known ULID, (b) known path, (c) existing foreign file, (d) orphan. */
async function applyCanvas(root: string, graph: CanvasGraph, repairs: Repair[]): Promise<CanvasPass | undefined> {
  const canvasPath = path.join(root, graph.slug, CANVAS_FILE);
  let text: string;
  try {
    text = await fs.readFile(canvasPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      repairs.push({ kind: 'canvas-missing', canvas: graph.slug });
      return undefined;
    }
    repairs.push({ kind: 'canvas-corrupt', canvas: graph.slug, reason: `cannot read: ${code ?? String(err)}` });
    return undefined;
  }
  const parsed = parseCanvas(text);
  if (!parsed.ok) {
    repairs.push({ kind: 'canvas-corrupt', canvas: graph.slug, reason: parsed.reason });
    return undefined;
  }

  const byPath = new Map<string, NodeId>([...graph.paths].map(([id, p]) => [p, id]));
  const ours = new Map<string, NodeId>();
  const foreignIds = new Set<string>();
  const resolved = new Set<NodeId>();

  for (const raw of parsed.nodes) {
    const cid = String(raw.id);
    const file = raw.type === 'file' && typeof raw.file === 'string' ? raw.file : undefined;

    // (a) known ULID, (b) known path
    let id: NodeId | undefined;
    let byPathMatch = false;
    if (file !== undefined) {
      if (graph.nodes.has(cid)) id = cid;
      else {
        const byFile = byPath.get(file);
        if (byFile !== undefined) {
          id = byFile;
          byPathMatch = true;
        }
      }
    }
    if (id !== undefined && file !== undefined) {
      if (resolved.has(id)) {
        repairs.push({ kind: 'duplicate-canvas-node', canvas: graph.slug, canvasNodeId: cid, id });
        continue; // a second canvas entry for a node that already has one: first wins
      }
      resolved.add(id);
      if (byPathMatch) repairs.push({ kind: 'canvas-id-repaired', id, canvasNodeId: cid });
      ours.set(cid, id);
      const current = graph.paths.get(id) ?? file;
      if (file !== current) repairs.push({ kind: 'path-repaired', id, from: file, to: current });
      graph.layout.set(id, readLayout(raw));
      continue;
    }
    // (d) file node pointing nowhere
    if (file !== undefined && !(await exists(path.join(root, file)))) {
      repairs.push({ kind: 'orphan-canvas-node', canvas: graph.slug, canvasNodeId: cid, file });
      continue;
    }
    // (c) text/group/link nodes and file nodes for notes that are not ours
    graph.foreign.nodes.push(raw);
    foreignIds.add(cid);
  }

  const structuralEdges: { from: NodeId; to: NodeId }[] = [];
  for (const raw of parsed.edges) {
    const from = String(raw.fromNode);
    const to = String(raw.toNode);
    const ourFrom = ours.get(from);
    const ourTo = ours.get(to);
    const known = (x: string): boolean => ours.has(x) || foreignIds.has(x);
    if (ourFrom !== undefined && ourTo !== undefined) {
      structuralEdges.push({ from: ourFrom, to: ourTo });
    } else if (known(from) && known(to)) {
      graph.foreign.edges.push({ ...raw, fromNode: ourFrom ?? from, toNode: ourTo ?? to });
    } else {
      repairs.push({ kind: 'edge-mismatch', canvas: graph.slug, detail: `edge ${String(raw.id)} references unknown node` });
    }
  }
  return { ours, structuralEdges };
}

function readLayout(raw: Record<string, unknown>): Layout {
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return { x: num(raw.x, 0), y: num(raw.y, 0), width: num(raw.width, NODE_WIDTH), height: num(raw.height, NODE_HEIGHT) };
}

/** Step 3: nodes on disk but not in the canvas. Processed in id order so a parent is placed before its children. */
function fillMissingLayout(graph: CanvasGraph, repairs: Repair[]): void {
  for (const node of sortedNodes(graph)) {
    if (graph.layout.has(node.id)) continue;
    graph.layout.set(node.id, placeholderLayout(node, graph.layout));
    repairs.push({ kind: 'layout-missing', id: node.id });
  }
}

/** Step 4: parents that reference unknown ids stay in the model but are reported; so does an assistant with ≠1 parents (spec M4). */
function checkParents(graph: CanvasGraph, repairs: Repair[]): void {
  for (const node of sortedNodes(graph)) {
    for (const parent of node.parents) {
      if (!graph.nodes.has(parent)) repairs.push({ kind: 'dangling-parent', id: node.id, parent });
    }
    if (node.role === 'assistant' && node.parents.length !== 1) repairs.push({ kind: 'assistant-parents', id: node.id, count: node.parents.length });
  }
}

/** Step 5: frontmatter wins; differences to the canvas edges are reported only. */
function checkEdges(graph: CanvasGraph, pass: CanvasPass, repairs: Repair[]): void {
  const inCanvas = new Set(pass.structuralEdges.map((e) => edgeId(e.from, e.to)));
  const derived = new Set(derivedEdges(graph).map((e) => e.id));
  for (const id of [...derived].sort()) {
    if (!inCanvas.has(id)) repairs.push({ kind: 'edge-mismatch', canvas: graph.slug, detail: `missing in canvas: ${id}` });
  }
  for (const id of [...inCanvas].sort()) {
    if (!derived.has(id)) repairs.push({ kind: 'edge-mismatch', canvas: graph.slug, detail: `not in frontmatter: ${id}` });
  }
}
