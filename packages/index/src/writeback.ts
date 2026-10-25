import { readCanvas, renameNodeFile, writeCanvasFile, writeNode, type CanvasGraph, type MessageNode, type VaultLock } from '@chatmind/core';
import { contentHash } from './hash';

export interface WritebackJob {
  id: string;
  canvas: string;
  forHash: string; // content_hash the summary was generated from
  expectedSummary: string; // '' for a fresh summary, our previous one for a regeneration, the user's for rename-only
  newSummary: string;
}

export interface WritebackResult {
  written: boolean;
  renamed: boolean;
  skipped: 'vanished' | 'body-changed' | 'summary-changed' | null;
}

/**
 * Spec M5 §6 / M6 §6: the shared first half of a writeback turn — read this canvas (spec M6 §6: one folder,
 * not the whole vault; the canvas file rewrite after a rename needs its nodes' paths, not the vault's),
 * resolve the node, and report why the write must be dropped if it vanished or its body moved on since
 * `forHash` was computed. Returns the live node otherwise, for the caller to guard and mutate further.
 */
async function locate(dataDir: string, canvas: string, id: string, forHash: string): Promise<{ graph: CanvasGraph; node: MessageNode } | 'vanished' | 'body-changed'> {
  const found = await readCanvas(dataDir, canvas);
  const graph = found?.graph;
  const node = graph?.nodes.get(id);
  if (!graph || !node) return 'vanished';
  if (contentHash(node.body) !== forHash) return 'body-changed';
  return { graph, node };
}

/**
 * Spec M5 §6: one lock turn — re-read, guard against a concurrent edit, write the summary, rename once,
 * write graph.canvas.
 */
export async function writeback(job: WritebackJob, deps: { dataDir: string; lock: VaultLock }): Promise<WritebackResult> {
  return deps.lock.run(async () => {
    const found = await locate(deps.dataDir, job.canvas, job.id, job.forHash);
    if (found === 'vanished' || found === 'body-changed') return { written: false, renamed: false, skipped: found };
    const { graph, node } = found;
    if (node.summary !== job.expectedSummary) return { written: false, renamed: false, skipped: 'summary-changed' };
    let written = false;
    if (job.newSummary !== node.summary) {
      node.summary = job.newSummary;
      await writeNode(graph, job.id, deps.dataDir);
      written = true;
    }
    const renamed = await renameNodeFile(graph, job.id, deps.dataDir);
    if (renamed) await writeCanvasFile(graph, deps.dataDir);
    return { written, renamed, skipped: null };
  });
}

export interface TopicWriteJob {
  id: string;
  canvas: string;
  forHash: string; // content_hash of the body the topic decision's vector was computed from
  topic: string;
}

export interface TopicWriteResult {
  written: boolean;
  skipped: 'vanished' | 'body-changed' | 'topics-changed' | null;
}

/**
 * Spec M6 §6: one lock turn — re-read the canvas, drop the write if the node vanished, its body changed or
 * someone set a topic meanwhile (their edit wins), else `topics = [topic]`. No rename, no graph.canvas.
 */
export async function writeTopic(job: TopicWriteJob, deps: { dataDir: string; lock: VaultLock }): Promise<TopicWriteResult> {
  return deps.lock.run(async () => {
    const found = await locate(deps.dataDir, job.canvas, job.id, job.forHash);
    if (found === 'vanished' || found === 'body-changed') return { written: false, skipped: found };
    const { graph, node } = found;
    if (node.topics.length > 0) return { written: false, skipped: 'topics-changed' };
    node.topics = [job.topic];
    await writeNode(graph, job.id, deps.dataDir);
    return { written: true, skipped: null };
  });
}
