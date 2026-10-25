import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linearGraph, readVault, writeCanvas, type CanvasGraph, type MessageNode, type TranscriptMessage } from '@chatmind/core';

const dirs: string[] = [];
export async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-index-'));
  dirs.push(d);
  return d;
}
export async function cleanupTmpDirs(): Promise<void> {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  dirs.length = 0;
}

/** A vault with one canvas from a transcript; returns root and the written graph (paths assigned). */
export async function vaultWith(slug: string, messages: TranscriptMessage[]): Promise<{ root: string; graph: CanvasGraph }> {
  const root = await tmpDir();
  const graph = linearGraph(slug, messages);
  await writeCanvas(graph, root);
  return { root, graph };
}

export async function nodeOnDisk(root: string, slug: string, id: string): Promise<{ node: MessageNode; path: string }> {
  const { canvases } = await readVault(root);
  const g = canvases.find((c) => c.slug === slug)!;
  return { node: g.nodes.get(id)!, path: g.paths.get(id)! };
}

export async function files(root: string, slug: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, slug, 'nodes'))).filter((f) => !f.startsWith('.')).sort();
}
