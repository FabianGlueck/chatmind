import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decodeTime } from 'ulid';
import { afterAll, describe, expect, it } from 'vitest';
import { isoTimestamp } from '../src/ids';
import { readCanvas, readVault } from '../src/vault/read';
import { writeCanvas } from '../src/vault/write';
import type { Repair } from '../src/types';
import { A, B, C, cleanupTmpDirs, sampleGraph, tmpDir } from './helpers';

afterAll(cleanupTmpDirs);

/** Sorted, compact view of repairs for stable assertions. */
function kinds(repairs: Repair[]): string[] {
  return repairs.map((r) => ('field' in r ? `${r.kind}:${r.field}` : r.kind)).sort();
}

async function writtenVault(): Promise<{ root: string; dir: string }> {
  const root = await tmpDir();
  await writeCanvas(sampleGraph(), root);
  return { root, dir: path.join(root, 'masterarbeit', 'nodes') };
}

describe('readVault — node scan', () => {
  it('reads back a vault written by writeCanvas with no repairs', async () => {
    const { root } = await writtenVault();
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases).toHaveLength(1);
    const g = canvases[0]!;
    const expected = sampleGraph();
    expect(g.slug).toBe('masterarbeit');
    expect(g.nodes).toEqual(expected.nodes);
    expect(g.layout).toEqual(expected.layout);
    expect(g.paths.get(A)).toBe(`masterarbeit/nodes/${A}-ursprungsfrage.md`);
    expect(g.foreign).toEqual({ nodes: [], edges: [] });
  });

  it('throws only when root is missing', async () => {
    await expect(readVault('/definitely/not/here')).rejects.toThrow();
  });

  it('returns no canvases for an empty root', async () => {
    expect(await readVault(await tmpDir())).toEqual({ canvases: [], repairs: [] });
  });

  it('reports unparseable files and leaves them out', async () => {
    const { root, dir } = await writtenVault();
    await fs.writeFile(path.join(dir, 'junk.md'), '# no frontmatter\n');
    await fs.writeFile(path.join(dir, 'bad-id.md'), '---\nid: nope\n---\n');
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.nodes.size).toBe(3);
    expect(repairs).toEqual([
      { kind: 'unparseable-node', path: 'masterarbeit/nodes/bad-id.md', reason: 'missing or invalid id' },
      { kind: 'unparseable-node', path: 'masterarbeit/nodes/junk.md', reason: 'no frontmatter block' },
    ]);
  });

  it('defaults missing fields and flags a canvas field that disagrees with the folder', async () => {
    const { root, dir } = await writtenVault();
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    await fs.writeFile(path.join(dir, `${D}.md`), `---\nid: ${D}\ncanvas: other\n---\nHallo\n`);
    const { canvases, repairs } = await readVault(root);
    const d = canvases[0]!.nodes.get(D);
    expect(d).toEqual({ id: D, role: 'user', parents: [], created: isoTimestamp(decodeTime(D)), summary: '', topics: [], body: 'Hallo' });
    expect(kinds(repairs.filter((r) => r.kind === 'defaulted-field'))).toEqual([
      'defaulted-field:canvas',
      'defaulted-field:created',
      'defaulted-field:parents',
      'defaulted-field:role',
      'defaulted-field:summary',
      'defaulted-field:topics',
    ]);
  });

  it('keeps the first of two files sharing an id (by path order) and reports the other', async () => {
    const { root, dir } = await writtenVault();
    const original = `masterarbeit/nodes/${C}.md`;
    await fs.copyFile(path.join(root, original), path.join(dir, `${C}-copy.md`)); // "-" (0x2d) sorts before "." (0x2e), so the copy is kept
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.nodes.size).toBe(3);
    expect(repairs.filter((r) => r.kind === 'duplicate-id')).toEqual([{ kind: 'duplicate-id', id: C, kept: `masterarbeit/nodes/${C}-copy.md`, dropped: original }]);
  });

  it('finds nodes moved into subfolders', async () => {
    const { root, dir } = await writtenVault();
    await fs.mkdir(path.join(dir, 'archiv'));
    await fs.rename(path.join(root, `masterarbeit/nodes/${A}-ursprungsfrage.md`), path.join(dir, 'archiv', 'frage.md'));
    const { canvases } = await readVault(root);
    expect(canvases[0]!.nodes.has(A)).toBe(true);
    expect(canvases[0]!.paths.get(A)).toBe('masterarbeit/nodes/archiv/frage.md');
  });

  it.skipIf(process.getuid?.() === 0)('reports an unreadable nodes dir as canvas-corrupt instead of throwing', async () => {
    const { root, dir } = await writtenVault();
    await fs.chmod(dir, 0o000);
    try {
      const { canvases, repairs } = await readVault(root);
      expect(canvases[0]!.nodes.size).toBe(0);
      const corrupt = repairs.find((r) => r.kind === 'canvas-corrupt');
      expect(corrupt).toBeDefined();
      expect((corrupt as { reason: string }).reason).toMatch(/^cannot scan nodes: EACCES/);
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });
});

describe('readVault — canvas resolution', () => {
  async function canvasJson(root: string): Promise<{ nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }> {
    return JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
  }
  async function writeCanvasJson(root: string, data: unknown): Promise<void> {
    await fs.writeFile(path.join(root, 'masterarbeit', 'graph.canvas'), JSON.stringify(data));
  }

  it('reports a missing canvas and still returns the nodes', async () => {
    const { root } = await writtenVault();
    await fs.unlink(path.join(root, 'masterarbeit', 'graph.canvas'));
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.nodes.size).toBe(3);
    expect(repairs.find((r) => r.kind === 'canvas-missing')).toEqual({ kind: 'canvas-missing', canvas: 'masterarbeit' });
  });

  it('reports a corrupt canvas', async () => {
    const { root } = await writtenVault();
    await fs.writeFile(path.join(root, 'masterarbeit', 'graph.canvas'), '{oops');
    const { repairs } = await readVault(root);
    expect(repairs.some((r) => r.kind === 'canvas-corrupt' && r.canvas === 'masterarbeit')).toBe(true);
  });

  it('repairs the path of a renamed file via the ULID id', async () => {
    const { root, dir } = await writtenVault();
    const from = `masterarbeit/nodes/${A}-ursprungsfrage.md`;
    await fs.rename(path.join(root, from), path.join(dir, 'Meine Frage.md'));
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.paths.get(A)).toBe('masterarbeit/nodes/Meine Frage.md');
    expect(canvases[0]!.layout.get(A)).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(repairs).toEqual([{ kind: 'path-repaired', id: A, from, to: 'masterarbeit/nodes/Meine Frage.md' }]);
  });

  it('matches a canvas node by file path when its id is not ours', async () => {
    const { root } = await writtenVault();
    const canvas = await canvasJson(root);
    canvas.nodes[1]!.id = 'obsidian-random-id';
    await writeCanvasJson(root, canvas);
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.layout.get(B)).toEqual({ x: 0, y: 280, width: 400, height: 200 });
    expect(repairs.filter((r) => r.kind === 'canvas-id-repaired')).toEqual([{ kind: 'canvas-id-repaired', id: B, canvasNodeId: 'obsidian-random-id' }]);
  });

  it('keeps text nodes, foreign file nodes and their edges verbatim', async () => {
    const { root } = await writtenVault();
    await fs.writeFile(path.join(root, 'masterarbeit', 'notiz.md'), '# Freie Notiz\n');
    const canvas = await canvasJson(root);
    const text = { id: 't1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 };
    const note = { id: 'f1', type: 'file', file: 'masterarbeit/notiz.md', x: 500, y: 200, width: 200, height: 100 };
    canvas.nodes.push(text, note);
    canvas.edges.push({ id: 'e1', fromNode: 't1', toNode: A }, { id: 'e2', fromNode: A, toNode: 'f1', label: 'siehe' });
    await writeCanvasJson(root, canvas);
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.foreign).toEqual({
      nodes: [text, note],
      edges: [{ id: 'e1', fromNode: 't1', toNode: A }, { id: 'e2', fromNode: A, toNode: 'f1', label: 'siehe' }],
    });
    // the free note is not a chatmind node: it is reported as unparseable but must not block anything
    expect(kinds(repairs)).toEqual(['unparseable-node']);
  });

  it('rewrites foreign edge endpoints when a canvas id was repaired', async () => {
    const { root } = await writtenVault();
    const canvas = await canvasJson(root);
    canvas.nodes[0]!.id = 'rnd';
    canvas.edges[0]!.fromNode = 'rnd';
    canvas.nodes.push({ id: 't1', type: 'text', text: 'x', x: 0, y: 0, width: 1, height: 1 });
    canvas.edges.push({ id: 'e9', fromNode: 'rnd', toNode: 't1' });
    await writeCanvasJson(root, canvas);
    const { canvases } = await readVault(root);
    expect(canvases[0]!.foreign.edges).toEqual([{ id: 'e9', fromNode: A, toNode: 't1' }]);
  });

  it('drops canvas file nodes whose file is gone and unknown', async () => {
    const { root } = await writtenVault();
    const canvas = await canvasJson(root);
    canvas.nodes.push({ id: 'ghost', type: 'file', file: 'masterarbeit/nodes/gone.md', x: 0, y: 0, width: 1, height: 1 });
    await writeCanvasJson(root, canvas);
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.foreign.nodes).toEqual([]);
    expect(repairs).toEqual([{ kind: 'orphan-canvas-node', canvas: 'masterarbeit', canvasNodeId: 'ghost', file: 'masterarbeit/nodes/gone.md' }]);
  });

  it('reports an edge that references an unknown canvas node', async () => {
    const { root } = await writtenVault();
    const canvas = await canvasJson(root);
    canvas.edges.push({ id: 'e-bad', fromNode: A, toNode: 'nope' });
    await writeCanvasJson(root, canvas);
    const { repairs } = await readVault(root);
    expect(repairs).toEqual([{ kind: 'edge-mismatch', canvas: 'masterarbeit', detail: 'edge e-bad references unknown node' }]);
  });

  it('keeps the first of two canvas entries resolving to the same node and reports the second', async () => {
    const { root } = await writtenVault();
    const canvas = await canvasJson(root);
    const file = canvas.nodes[0]!.file;
    canvas.nodes.push({ id: 'dup', type: 'file', file, x: 999, y: 999, width: 1, height: 1 });
    await writeCanvasJson(root, canvas);
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.layout.get(A)).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(repairs).toEqual([{ kind: 'duplicate-canvas-node', canvas: 'masterarbeit', canvasNodeId: 'dup', id: A }]);
  });
});

describe('readVault — structure checks', () => {
  it('gives nodes absent from the canvas a placeholder layout below their parent', async () => {
    const { root, dir } = await writtenVault();
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    await fs.writeFile(path.join(dir, `${D}.md`), `---\nid: ${D}\ncanvas: masterarbeit\nrole: user\nparents: [${C}]\ncreated: 2026-01-01T00:00:00Z\nsummary: ''\ntopics: []\n---\n\nNeu.\n`);
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.layout.get(D)).toEqual({ x: 0, y: 560 + 200 + 80, width: 400, height: 200 });
    expect(repairs).toEqual([
      { kind: 'layout-missing', id: D },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: `missing in canvas: e-${C}-${D}` },
    ]);
  });

  it('places every node when the canvas is missing, chaining placeholders', async () => {
    const { root } = await writtenVault();
    await fs.unlink(path.join(root, 'masterarbeit', 'graph.canvas'));
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.layout.get(A)).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(canvases[0]!.layout.get(B)).toEqual({ x: 0, y: 280, width: 400, height: 200 });
    expect(canvases[0]!.layout.get(C)).toEqual({ x: 0, y: 560, width: 400, height: 200 });
    expect(kinds(repairs)).toEqual(['canvas-missing', 'layout-missing', 'layout-missing', 'layout-missing']);
  });

  it('reports dangling parents and keeps them in the model', async () => {
    const { root } = await writtenVault();
    const rel = `masterarbeit/nodes/${C}.md`;
    const X = '01JQ8F9ZZZZZZZZZZZZZZZZZZZ';
    const text = await fs.readFile(path.join(root, rel), 'utf8');
    await fs.writeFile(path.join(root, rel), text.replace(`parents: [${B}]`, `parents: [${B}, ${X}]`));
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.nodes.get(C)!.parents).toEqual([B, X]);
    expect(repairs).toEqual([{ kind: 'dangling-parent', id: C, parent: X }]);
  });

  it('reports canvas edges that frontmatter does not back, and vice versa', async () => {
    const { root } = await writtenVault();
    const canvasPath = path.join(root, 'masterarbeit', 'graph.canvas');
    const canvas = JSON.parse(await fs.readFile(canvasPath, 'utf8'));
    canvas.edges = [{ id: 'user-drawn', fromNode: A, toNode: C }]; // drops A→B and B→C, adds A→C
    await fs.writeFile(canvasPath, JSON.stringify(canvas));
    const { repairs } = await readVault(root);
    expect(repairs).toEqual([
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: `missing in canvas: e-${A}-${B}` },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: `missing in canvas: e-${B}-${C}` },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: `not in frontmatter: e-${A}-${C}` },
    ]);
  });

  it('reports a canvas that cannot be read as canvas-corrupt and still places the nodes', async () => {
    const { root } = await writtenVault();
    const canvasPath = path.join(root, 'masterarbeit', 'graph.canvas');
    await fs.rm(canvasPath);
    await fs.mkdir(canvasPath);
    const { canvases, repairs } = await readVault(root);
    const corrupt = repairs.find((r) => r.kind === 'canvas-corrupt');
    expect(corrupt).toBeDefined();
    expect((corrupt as { reason: string }).reason).toMatch(/^cannot read: EISDIR/);
    expect(kinds(repairs)).toEqual(['canvas-corrupt', 'layout-missing', 'layout-missing', 'layout-missing']);
    expect(canvases[0]!.nodes.size).toBe(3);
  });
});

describe('readVault — assistant parents invariant', () => {
  it('reports an assistant node with two parents and leaves its parents untouched', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    g.nodes.set(D, { id: D, role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Zweite Wurzel.' });
    g.layout.set(D, { x: 480, y: 0, width: 400, height: 200 });
    g.nodes.get(B)!.parents = [A, D];
    await writeCanvas(g, root);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([{ kind: 'assistant-parents', id: B, count: 2 }]);
    expect(canvases[0]!.nodes.get(B)!.parents).toEqual([A, D]);
  });
  it('does not report user nodes with several parents', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.nodes.get(C)!.parents = [B, A];
    await writeCanvas(g, root);
    expect((await readVault(root)).repairs).toEqual([]);
  });
});

describe('readCanvas (spec M6 §6)', () => {
  it('returns the same graph and repairs as the matching element of readVault', async () => {
    const { root } = await writtenVault();
    const whole = await readVault(root);
    const one = await readCanvas(root, 'masterarbeit');
    expect(one).not.toBeNull();
    expect(one!.graph).toEqual(whole.canvases[0]);
    expect(one!.repairs).toEqual(whole.repairs);
  });

  it('returns null for a folder that is not a canvas, a missing folder and an unsafe slug', async () => {
    const { root } = await writtenVault();
    await fs.mkdir(path.join(root, 'notes'));
    expect(await readCanvas(root, 'notes')).toBeNull();
    expect(await readCanvas(root, 'missing')).toBeNull();
    expect(await readCanvas(root, '../masterarbeit')).toBeNull();
    expect(await readCanvas(root, '.app')).toBeNull();
  });
});
