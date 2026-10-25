import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { serializeNodeFile } from '../src/frontmatter';
import { deleteNodes, renameNodeFile, writeCanvas, writeCanvasFile, writeIfChanged, writeNode } from '../src/vault/write';
import { readVault } from '../src/vault/read';
import { A, B, C, cleanupTmpDirs, node, readTree, sampleGraph, tmpDir } from './helpers';

afterAll(cleanupTmpDirs);

describe('writeCanvas', () => {
  it('writes canonical node files under nodes/ and records their paths', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, root);
    const tree = await readTree(root);
    expect([...tree.keys()]).toEqual([
      'masterarbeit/graph.canvas',
      `masterarbeit/nodes/${A}-ursprungsfrage.md`,
      `masterarbeit/nodes/${B}-zentroid-ansatz-skaliert-besser.md`,
      `masterarbeit/nodes/${C}.md`,
    ]);
    expect(tree.get(`masterarbeit/nodes/${B}-zentroid-ansatz-skaliert-besser.md`)).toBe(serializeNodeFile(g.nodes.get(B)!, 'masterarbeit'));
    expect(g.paths.get(C)).toBe(`masterarbeit/nodes/${C}.md`);
  });

  it('writes graph.canvas with file nodes, layout and derived edges', async () => {
    const root = await tmpDir();
    await writeCanvas(sampleGraph(), root);
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
    expect(canvas.nodes).toEqual([
      { id: A, type: 'file', file: `masterarbeit/nodes/${A}-ursprungsfrage.md`, x: 0, y: 0, width: 400, height: 200 },
      { id: B, type: 'file', file: `masterarbeit/nodes/${B}-zentroid-ansatz-skaliert-besser.md`, x: 0, y: 280, width: 400, height: 200 },
      { id: C, type: 'file', file: `masterarbeit/nodes/${C}.md`, x: 0, y: 560, width: 400, height: 200 },
    ]);
    expect(canvas.edges).toEqual([
      { id: `e-${A}-${B}`, fromNode: A, fromSide: 'bottom', toNode: B, toSide: 'top' },
      { id: `e-${B}-${C}`, fromNode: B, fromSide: 'bottom', toNode: C, toSide: 'top' },
    ]);
  });

  it('respects existing paths and never renames', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.paths.set(A, 'masterarbeit/archiv/alte-frage.md');
    await writeCanvas(g, root);
    const tree = await readTree(root);
    expect(tree.has('masterarbeit/archiv/alte-frage.md')).toBe(true);
    expect(tree.has(`masterarbeit/nodes/${A}-ursprungsfrage.md`)).toBe(false);
    const canvas = JSON.parse(tree.get('masterarbeit/graph.canvas')!);
    expect(canvas.nodes[0].file).toBe('masterarbeit/archiv/alte-frage.md');
  });

  it('assigns placeholder layout to nodes without one and records it', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.layout.delete(C);
    await writeCanvas(g, root);
    expect(g.layout.get(C)).toEqual({ x: 0, y: 280 + 200 + 80, width: 400, height: 200 });
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
    expect(canvas.nodes[2].y).toBe(560);
  });

  it('passes foreign canvas content through', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.foreign.nodes.push({ id: 'note1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 });
    g.foreign.edges.push({ id: 'fe', fromNode: 'note1', toNode: A });
    await writeCanvas(g, root);
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
    expect(canvas.nodes[3]).toEqual({ id: 'note1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 });
    expect(canvas.edges[2]).toEqual({ id: 'fe', fromNode: 'note1', toNode: A });
  });

  it('does not touch files whose content is unchanged', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, root);
    const old = new Date('2020-01-01T00:00:00Z');
    for (const rel of [...g.paths.values(), 'masterarbeit/graph.canvas']) await fs.utimes(path.join(root, rel), old, old);
    await writeCanvas(g, root);
    for (const rel of [...g.paths.values(), 'masterarbeit/graph.canvas']) {
      expect((await fs.stat(path.join(root, rel))).mtime).toEqual(old);
    }
  });

  it('leaves no temp files behind', async () => {
    const root = await tmpDir();
    await writeCanvas(sampleGraph(), root);
    const nodesDir = await fs.readdir(path.join(root, 'masterarbeit', 'nodes'));
    expect(nodesDir.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const canvasDir = await fs.readdir(path.join(root, 'masterarbeit'));
    expect(canvasDir.filter((f) => f.endsWith('.tmp') || f.startsWith('.graph.canvas'))).toEqual([]);
  });

  it('preserves canvas node order from graph.layout and appends new nodes by id', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    // Obsidian moved B to the end (z-order); a brand-new node D has no layout yet
    const bLayout = g.layout.get(B)!;
    g.layout.delete(B);
    g.layout.set(B, bLayout);
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    g.nodes.set(D, node({ id: D, parents: [C], body: 'Neu.' }));
    await writeCanvas(g, root);
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
    expect(canvas.nodes.map((n: { id: string }) => n.id)).toEqual([A, C, B, D]);
  });

  it('rejects a path that escapes the data dir and writes nothing outside root', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.paths.set(A, '../outside.md');
    await expect(writeCanvas(g, root)).rejects.toThrow(`node ${A}: path "../outside.md" escapes the data dir`);
    expect(await fs.access(path.join(root, '..', 'outside.md')).then(() => true, () => false)).toBe(false);
  });

  it('rejects an invalid canvas slug before creating any directory', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.slug = '../esc';
    await expect(writeCanvas(g, root)).rejects.toThrow('invalid canvas slug');
    await expect(fs.access(path.join(root, '..', 'esc'))).rejects.toThrow();
  });
});

describe('writeNode / writeCanvasFile', () => {
  it('composes to exactly what writeCanvas writes', async () => {
    const rootA = await tmpDir();
    const rootB = await tmpDir();
    await writeCanvas(sampleGraph(), rootA);
    const g = sampleGraph();
    await fs.mkdir(path.join(rootB, 'masterarbeit', 'nodes'), { recursive: true });
    for (const id of [A, B, C]) await writeNode(g, id, rootB);
    await writeCanvasFile(g, rootB);
    expect(await readTree(rootB)).toEqual(await readTree(rootA));
  });

  it('writeNode writes one file and records the path; writeCanvasFile records placeholder layouts', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, root);
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    g.nodes.set(D, node({ id: D, parents: [C], body: 'Neu.' }));
    const before = await readTree(root);
    await writeNode(g, D, root);
    expect(g.paths.get(D)).toBe(`masterarbeit/nodes/${D}.md`);
    const mid = await readTree(root);
    expect([...mid.keys()].filter((k) => !before.has(k))).toEqual([`masterarbeit/nodes/${D}.md`]);
    expect(mid.get('masterarbeit/graph.canvas')).toBe(before.get('masterarbeit/graph.canvas'));
    await writeCanvasFile(g, root);
    expect(g.layout.get(D)).toEqual({ x: 0, y: 840, width: 400, height: 200 });
    expect(JSON.parse((await readTree(root)).get('masterarbeit/graph.canvas')!).nodes.map((n: { id: string }) => n.id)).toEqual([A, B, C, D]);
  });

  it('writeNode rejects a path escaping the data dir', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.paths.set(A, '../outside.md');
    await expect(writeNode(g, A, root)).rejects.toThrow('escapes the data dir');
  });
});

describe('writeIfChanged', () => {
  it('returns true on create and change, false when identical', async () => {
    const root = await tmpDir();
    const f = path.join(root, 'deep', 'x.txt');
    expect(await writeIfChanged(f, 'a')).toBe(true);
    expect(await writeIfChanged(f, 'a')).toBe(false);
    expect(await writeIfChanged(f, 'b')).toBe(true);
    expect(await fs.readFile(f, 'utf8')).toBe('b');
  });
});

describe('renameNodeFile (spec M5 §6)', () => {
  it('renames a bare-ULID file once the summary has a slug and updates graph.paths', async () => {
    const root = await tmpDir();
    const g = sampleGraph(); // C has summary ''
    await writeCanvas(g, root);
    g.nodes.get(C)!.summary = 'Danke für die Hinweise';
    expect(await renameNodeFile(g, C, root)).toBe(true);
    expect(g.paths.get(C)).toBe(`masterarbeit/nodes/${C}-danke-fuer-die-hinweise.md`);
    const tree = await readTree(root);
    expect(tree.has(`masterarbeit/nodes/${C}-danke-fuer-die-hinweise.md`)).toBe(true);
    expect(tree.has(`masterarbeit/nodes/${C}.md`)).toBe(false);
    await writeCanvasFile(g, root);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.paths.get(C)).toBe(`masterarbeit/nodes/${C}-danke-fuer-die-hinweise.md`);
  });

  it('is a no-op when the file already carries a slug, when the summary has no slug, or when the target exists', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, root);
    g.nodes.get(A)!.summary = 'Neuer Titel';
    expect(await renameNodeFile(g, A, root)).toBe(false); // already `A-ursprungsfrage.md`
    expect(g.paths.get(A)).toBe(`masterarbeit/nodes/${A}-ursprungsfrage.md`);
    g.nodes.get(C)!.summary = '???';
    expect(await renameNodeFile(g, C, root)).toBe(false); // slug('???') === ''
    g.nodes.get(C)!.summary = 'Danke';
    await fs.writeFile(path.join(root, 'masterarbeit', 'nodes', `${C}-danke.md`), 'occupied');
    expect(await renameNodeFile(g, C, root)).toBe(false);
    expect(g.paths.get(C)).toBe(`masterarbeit/nodes/${C}.md`);
  });

  it('throws for an unknown node or one without a path', async () => {
    const g = sampleGraph();
    await expect(renameNodeFile(g, 'nope', await tmpDir())).rejects.toThrow('not in graph');
    await expect(renameNodeFile(g, C, await tmpDir())).rejects.toThrow('no path');
  });
});

describe('deleteNodes (spec M8 §5.3)', () => {
  const D = '01JQ8F5Q5R6S7T8V9W0X1Y2ZDD';
  const E = '01JQ8F6Q5R6S7T8V9W0X1Y2ZEE';
  it('moves the turn to .trash/, reparents the survivor, re-derives edges; the reader reports no repairs', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.nodes.set(D, node({ id: D, role: 'assistant', parents: [C] }));
    g.nodes.set(E, node({ id: E, parents: [D] }));
    g.layout.set(D, { x: 0, y: 840, width: 400, height: 200 });
    g.layout.set(E, { x: 500, y: 1120, width: 400, height: 200 });
    await writeCanvas(g, root);
    expect(await deleteNodes(g, new Set([C, D]), root)).toEqual([E]);
    const trash = (await fs.readdir(path.join(root, '.trash'))).sort();
    expect(trash).toEqual([`${C}.md`, `${D}.md`]);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    const back = canvases[0]!;
    expect([...back.nodes.keys()].sort()).toEqual([A, B, E].sort());
    expect(back.nodes.get(E)!.parents).toEqual([B]);
    expect(back.layout.get(E)).toEqual({ x: 500, y: 1120, width: 400, height: 200 });
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
    expect(canvas.edges.map((e: { fromNode: string; toNode: string }) => `${e.fromNode}>${e.toNode}`).sort()).toEqual([`${A}>${B}`, `${B}>${E}`].sort());
  });

  it('a name clash in .trash/ gets an Obsidian-style suffix', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, root);
    await fs.mkdir(path.join(root, '.trash'));
    await fs.writeFile(path.join(root, '.trash', `${C}.md`), 'older');
    await deleteNodes(g, new Set([C]), root);
    expect((await fs.readdir(path.join(root, '.trash'))).sort()).toEqual([`${C} 1.md`, `${C}.md`]);
    expect(await fs.readFile(path.join(root, '.trash', `${C}.md`), 'utf8')).toBe('older');
  });
});
