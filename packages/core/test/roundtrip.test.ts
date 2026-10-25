import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { linearGraph } from '../src/chain';
import { readVault } from '../src/vault/read';
import { writeCanvas } from '../src/vault/write';
import type { CanvasGraph, TranscriptMessage } from '../src/index';
import { A, B, C, cleanupTmpDirs, node, readTree, sampleGraph, tmpDir } from './helpers';

afterAll(cleanupTmpDirs);

const M = '01JQ8F5A0B1C2D3E4F5G6H7JAA';

/** A (root) → B, C (both parents: [A]) → M (parents: [B, C]): the merge-node diamond of spec §12. */
function diamondGraph(): CanvasGraph {
  const nodes = [
    node({ id: A, summary: 'Ursprungsfrage', body: 'Wie evaluiere ich Topic-Zuordnung?' }),
    node({ id: B, role: 'assistant', model: 'claude-sonnet-4-6', parents: [A], summary: 'Zentroid-Ansatz', body: 'Zentroid statt Re-Clustering.' }),
    node({ id: C, role: 'assistant', model: 'claude-sonnet-4-6', parents: [A], summary: 'Alternative Metrik', body: 'Cosine statt Euklid.' }),
    node({ id: M, parents: [B, C], body: 'Danke, beides zusammen ergibt Sinn.' }),
  ];
  return {
    slug: 'masterarbeit',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    layout: new Map([
      [A, { x: 200, y: 0, width: 400, height: 200 }],
      [B, { x: 0, y: 280, width: 400, height: 200 }],
      [C, { x: 400, y: 280, width: 400, height: 200 }],
      [M, { x: 200, y: 560, width: 400, height: 200 }],
    ]),
    paths: new Map(),
    foreign: { nodes: [], edges: [] },
  };
}

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/cli/fixtures/transcript.json');

async function fixtureGraph(): Promise<CanvasGraph> {
  const raw = JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as { messages: TranscriptMessage[] };
  let t = Date.UTC(2026, 8, 11, 9, 0, 0);
  return linearGraph('masterarbeit', raw.messages, () => (t += 1000));
}

async function roundTrip(graph: CanvasGraph): Promise<{ rootA: string; rootB: string }> {
  const rootA = await tmpDir();
  const rootB = await tmpDir();
  await writeCanvas(graph, rootA);
  const { canvases, repairs } = await readVault(rootA);
  expect(repairs).toEqual([]);
  await writeCanvas(canvases[0]!, rootB);
  return { rootA, rootB };
}

describe('vault round-trip (M1 done condition)', () => {
  it('write → read → write is byte-identical for the sample graph', async () => {
    const { rootA, rootB } = await roundTrip(sampleGraph());
    expect(await readTree(rootB)).toEqual(await readTree(rootA));
  });

  it('write → read → write is byte-identical for a merge node with two parents', async () => {
    const { rootA, rootB } = await roundTrip(diamondGraph());
    expect(await readTree(rootB)).toEqual(await readTree(rootA));

    const { canvases, repairs } = await readVault(rootA);
    expect(repairs).toEqual([]);
    const g = canvases[0]!;
    expect(g.nodes.get(M)!.parents).toEqual([B, C]);

    const canvas = JSON.parse(await fs.readFile(path.join(rootA, 'masterarbeit', 'graph.canvas'), 'utf8')) as { edges: { id: string }[] };
    expect(canvas.edges.map((e) => e.id).sort()).toEqual([`e-${A}-${B}`, `e-${A}-${C}`, `e-${B}-${M}`, `e-${C}-${M}`].sort());
  });

  it('write → read → write is byte-identical for the M0 fixture', async () => {
    const { rootA, rootB } = await roundTrip(await fixtureGraph());
    const tree = await readTree(rootA);
    expect(tree.size).toBe(6); // 5 nodes + canvas
    expect(await readTree(rootB)).toEqual(tree);
  });

  it('re-writing a freshly read vault touches nothing', async () => {
    const root = await tmpDir();
    await writeCanvas(await fixtureGraph(), root);
    const old = new Date('2020-01-01T00:00:00Z');
    const before = await readTree(root);
    for (const rel of before.keys()) await fs.utimes(path.join(root, rel), old, old);
    const { canvases } = await readVault(root);
    await writeCanvas(canvases[0]!, root);
    for (const rel of before.keys()) expect((await fs.stat(path.join(root, rel))).mtime).toEqual(old);
  });

  it('survives rename + move + user text node + lost canvas, converging after one write', async () => {
    const rootA = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, rootA);
    // user activity in Obsidian:
    await fs.rename(path.join(rootA, g.paths.get(A)!), path.join(rootA, 'masterarbeit', 'nodes', 'Frage.md'));
    await fs.mkdir(path.join(rootA, 'masterarbeit', 'nodes', 'archiv'));
    await fs.rename(path.join(rootA, g.paths.get(B)!), path.join(rootA, 'masterarbeit', 'nodes', 'archiv', 'antwort.md'));
    const canvasPath = path.join(rootA, 'masterarbeit', 'graph.canvas');
    const canvas = JSON.parse(await fs.readFile(canvasPath, 'utf8'));
    canvas.nodes.push({ id: 't1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 });
    await fs.writeFile(canvasPath, JSON.stringify(canvas));

    const first = await readVault(rootA);
    expect(first.repairs.map((r) => r.kind).sort()).toEqual(['path-repaired', 'path-repaired']);
    expect(first.canvases[0]!.nodes).toEqual(g.nodes);
    await writeCanvas(first.canvases[0]!, rootA); // persists the repairs

    const second = await readVault(rootA);
    expect(second.repairs).toEqual([]);
    expect(second.canvases[0]!.paths.get(A)).toBe('masterarbeit/nodes/Frage.md');
    expect(second.canvases[0]!.paths.get(B)).toBe('masterarbeit/nodes/archiv/antwort.md');
    expect(second.canvases[0]!.foreign.nodes).toEqual([{ id: 't1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 }]);

    // and the lost-canvas case rebuilds layout deterministically
    await fs.unlink(canvasPath);
    const third = await readVault(rootA);
    expect(third.canvases[0]!.nodes).toEqual(g.nodes);
    await writeCanvas(third.canvases[0]!, rootA);
    expect((await readVault(rootA)).repairs).toEqual([]);
  });
});
