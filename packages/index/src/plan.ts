import { slug, type MessageNode } from '@chatmind/core';
import type { NodeRow } from './db';
import { contentHash } from './hash';

export interface Entry { node: MessageNode; canvas: string; path: string }
export interface SummaryJob { id: string; expected: string }
export interface Jobs { embed: string[]; summarize: SummaryJob[]; rename: string[] }

export function isBareUlidPath(p: string, id: string): boolean {
  return p.split('/').pop() === `${id}.md`;
}

/** The synced view of `rows` for the given entries, computed without writing: fresh hashes, missing rows all NULL. */
export function rowsForPlan(entries: readonly Entry[], rows: ReadonlyMap<string, NodeRow>): Map<string, NodeRow> {
  const out = new Map<string, NodeRow>();
  for (const { node, canvas } of entries) {
    const r = rows.get(node.id);
    const content_hash = contentHash(node.body);
    out.set(node.id, r ? { ...r, content_hash } : { id: node.id, canvas, content_hash, summary_written: null, summary_for_hash: null, embedded_hash: null, topic_written: null });
  }
  return out;
}

/**
 * Spec M5 §5 step 3. Pure: rows are the synced rows (content_hash current). Embed stale ⇔ embedded_hash ≠
 * content_hash. Summarize when the summary is empty, or still ours and made from an older body. Rename when a
 * summary exists but the file still carries the bare ULID; a fresh summary renames in its own writeback, so
 * `rename` only lists nodes that get no summary job. F4: a summary whose `slug()` is '' (e.g. '???', emoji-only)
 * renames to nothing — `renameNodeFile` would just fail silently every run — so it plans no rename job either.
 */
export function planJobs(entries: readonly Entry[], rows: ReadonlyMap<string, NodeRow>): Jobs {
  const jobs: Jobs = { embed: [], summarize: [], rename: [] };
  for (const { node, path } of entries) {
    const row = rows.get(node.id);
    if (!row || node.body === '') continue;
    if (row.embedded_hash !== row.content_hash) jobs.embed.push(node.id);
    const ours = row.summary_written !== null && node.summary === row.summary_written;
    if (node.summary === '' || (ours && row.summary_for_hash !== row.content_hash)) {
      jobs.summarize.push({ id: node.id, expected: node.summary });
    } else if (node.summary !== '' && isBareUlidPath(path, node.id) && slug(node.summary) !== '') {
      jobs.rename.push(node.id);
    }
  }
  return jobs;
}

/** Spec M6 §6: topic candidates — empty `topics`, a body, and a vector for the current body. Pure. */
export function planTopicJobs(entries: readonly Entry[], rows: ReadonlyMap<string, NodeRow>): string[] {
  const out: string[] = [];
  for (const { node } of entries) {
    const row = rows.get(node.id);
    if (!row || node.body === '' || node.topics.length > 0) continue;
    if (row.embedded_hash === row.content_hash) out.push(node.id);
  }
  return out;
}
