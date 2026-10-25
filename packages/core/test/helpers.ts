import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanvasGraph, MessageNode } from '../src/types';
import type { GraphLike } from '../src/graph-like';

export const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
export const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';
export const C = '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA';

const createdTmpDirs: string[] = [];

export async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-'));
  createdTmpDirs.push(dir);
  return dir;
}

/** Removes every dir created by tmpDir() so far. Call from an afterAll in each test file that uses tmpDir. */
export async function cleanupTmpDirs(): Promise<void> {
  await Promise.all(createdTmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  createdTmpDirs.length = 0;
}

/** Every file under root as posix-relative path → content, sorted by path. Dot-entries are skipped. */
export async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.set(path.relative(root, abs).split(path.sep).join('/'), await fs.readFile(abs, 'utf8'));
    }
  }
  await walk(root);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function node(over: Partial<MessageNode> & { id: string }): MessageNode {
  return { role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Body.', ...over };
}

/** A → B → C chain in canvas "masterarbeit", laid out in a column, no paths assigned yet. */
export function sampleGraph(): CanvasGraph {
  const nodes = [
    node({ id: A, summary: 'Ursprungsfrage', body: 'Wie evaluiere ich Topic-Zuordnung?' }),
    node({ id: B, role: 'assistant', model: 'claude-sonnet-4-6', parents: [A], summary: 'Zentroid-Ansatz skaliert besser', body: 'Zentroid statt Re-Clustering.\n\nBegründung folgt.' }),
    node({ id: C, parents: [B], body: 'Danke.' }),
  ];
  return {
    slug: 'masterarbeit',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    layout: new Map([
      [A, { x: 0, y: 0, width: 400, height: 200 }],
      [B, { x: 0, y: 280, width: 400, height: 200 }],
      [C, { x: 0, y: 560, width: 400, height: 200 }],
    ]),
    paths: new Map(),
    foreign: { nodes: [], edges: [] },
  };
}

// R → U1 → A1 → U1b        (branch 1, three deep)
// R → U2 → A2               (branch 2)
// X → Y                     (separate root)
export function branchingGraph(): GraphLike {
  const ns = [
    node({ id: 'R', body: 'root question' }),
    node({ id: 'U1', parents: ['R'], body: 'u1' }),
    node({ id: 'A1', role: 'assistant', parents: ['U1'], body: 'a1' }),
    node({ id: 'U1b', parents: ['A1'], body: 'u1b', summary: 'Gliederung' }),
    node({ id: 'U2', parents: ['R'], body: 'u2' }),
    node({ id: 'A2', role: 'assistant', parents: ['U2'], body: 'Erste Zeile\nZweite Zeile' }),
    node({ id: 'X', body: 'x' }),
    node({ id: 'Y', role: 'assistant', parents: ['X'], body: 'y' }),
  ];
  return { nodes: new Map(ns.map((n) => [n.id, n])), layout: new Map() };
}
