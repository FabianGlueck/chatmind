import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exists, isCanvasSlug, linearGraph, resolveDataDir, writeCanvas } from '@chatmind/core';
import { parseTranscript } from './transcript';

export async function importTranscript(file: string, canvas: string, dataDir?: string): Promise<{ root: string; count: number }> {
  if (!isCanvasSlug(canvas)) {
    throw new Error(`invalid canvas name "${canvas}" — use lowercase letters, digits and dashes, e.g. "masterarbeit"`);
  }
  const root = resolveDataDir(dataDir);
  const canvasDir = path.join(root, canvas);
  if (await exists(canvasDir)) {
    throw new Error(`canvas "${canvas}" already exists at ${canvasDir} — import-transcript creates new canvases only`);
  }
  const messages = parseTranscript(JSON.parse(await fs.readFile(file, 'utf8')));
  const graph = linearGraph(canvas, messages);
  await fs.mkdir(root, { recursive: true });
  await writeCanvas(graph, root);
  return { root, count: graph.nodes.size };
}
