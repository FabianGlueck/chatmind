import { detectLanguage, readVault, type VaultLock } from '@chatmind/core';
import { countDueMemories, runMemoryPhase } from './memory-phase';
import type { IndexDb } from './db';
import { clearFailure, hasGivenUp, MAX_FAILURES, recordFailure, type NodeFailure } from './failures';
import { contentHash } from './hash';
import { planJobs, planTopicJobs, rowsForPlan, type Entry, type Jobs } from './plan';
import { cleanSummary, parentContextOf, shortcutSummary, truncateForEmbedding, truncateForSummary } from './summary';
import { runTopicPhase } from './topic-phase';
import type { Thresholds } from './topics';
import type { Embedder, MemoryWriter, Report, Summarizer, TopicNamer } from './types';
import { writeback } from './writeback';

export { MAX_FAILURES, type NodeFailure } from './failures';

export interface ReconcileDeps {
  dataDir: string;
  db: IndexDb;
  summarizer: Summarizer;
  embedder: Embedder;
  namer: TopicNamer;
  /** Spec M15 §2: absent means no memory phase (tests of the other phases). */
  memoryWriter?: MemoryWriter;
  lock: VaultLock;
  log?: (msg: string) => void;
  embedBatch?: number; // default 32
  summaryConcurrency?: number; // default 4
  /** Spec M6 §6: clock for the user-node deferral; tests inject it. */
  now?: () => number;
  /** Spec M6 §4: assignment thresholds; omitted means the calibrated defaults (see topic-settings.ts). */
  thresholds?: Thresholds;
  /** F1: shared across a caller's reconcile runs (the Indexer owns one instance for its lifetime); tests pass their own. */
  failures?: Map<string, NodeFailure>;
}

/** Every node of every canvas as a plan entry (the reader has already repaired paths in memory). */
export async function readEntries(dataDir: string): Promise<Entry[]> {
  const { canvases } = await readVault(dataDir);
  return canvases.flatMap((g) => [...g.nodes.values()].map((node) => ({ node, canvas: g.slug, path: g.paths.get(node.id)! })));
}

/** Spec M5 §5 steps 1–2: read the vault, drop vanished rows, refresh every content_hash. */
async function sync(dataDir: string, db: IndexDb): Promise<{ entries: Entry[]; byId: Map<string, Entry> }> {
  const entries = await readEntries(dataDir);
  const byId = new Map(entries.map((e) => [e.node.id, e]));
  const rows = db.rows();
  db.deleteNodes([...rows.keys()].filter((id) => !byId.has(id)));
  // F3: one transaction for the whole upsert loop instead of an implicit commit (fsync, under WAL) per node.
  db.transaction(() => {
    for (const e of entries) {
      const hash = contentHash(e.node.body);
      db.upsertNode(e.node.id, e.canvas, hash);
      if (e.node.body === '' && rows.get(e.node.id)?.embedded_hash !== hash) db.setEmbedded(e.node.id, hash, null);
    }
  });
  return { entries, byId };
}

/** Read + plan only, no writes — what `chatmind index status` shows. */
export async function countPending(deps: { dataDir: string; db: IndexDb }): Promise<{ embed: number; summarize: number; topics: number; memories: number }> {
  const { canvases } = await readVault(deps.dataDir);
  const entries = canvases.flatMap((g) => [...g.nodes.values()].map((node) => ({ node, canvas: g.slug, path: g.paths.get(node.id)! })));
  const rows = rowsForPlan(entries, deps.db.rows());
  const jobs = planJobs(entries, rows);
  return { embed: jobs.embed.length, summarize: jobs.summarize.length, topics: planTopicJobs(entries, rows).length, memories: countDueMemories(canvases) };
}

async function runPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** F1: one `embed([text])` call, validated the same way a batch call is. */
async function embedOne(deps: ReconcileDeps, text: string): Promise<Float32Array> {
  const vecs = await deps.embedder.embed([text]);
  if (vecs.length !== 1) throw new Error(`embedder returned ${vecs.length} vectors for 1 text`);
  if (vecs[0]!.length !== deps.embedder.dim) throw new Error(`embedder returned dim ${vecs[0]!.length}, expected ${deps.embedder.dim}`);
  return vecs[0]!;
}

const DIM_ERROR = /^embedder returned dim \d+, expected \d+$/;

/** Spec M5 §5: the one operation. Every job moves a row toward "all hashes equal"; a run with no jobs is the fixed point. */
export async function reconcile(deps: ReconcileDeps): Promise<Report> {
  const log = deps.log ?? ((m: string) => console.log(`index: ${m}`));
  const at = new Date().toISOString();
  const { entries, byId } = await sync(deps.dataDir, deps.db);
  const jobs: Jobs = planJobs(entries, deps.db.rows());
  const report: Report = { at, nodes: entries.length, embedded: 0, summarized: 0, renamed: 0, topics: 0, asked: 0, memories: 0, failed: 0, gaveUp: 0, pending: { embed: 0, summarize: 0, topics: 0, memories: 0 } };

  // F1: a node stuck at MAX_FAILURES consecutive failures (for its current body, embed or summary —
  // one shared counter) is skipped until its content_hash changes; it counts toward `gaveUp`, never
  // toward `pending`. Nodes already given up before this run are counted once, up front; `embedJobs`
  // is filtered now, but `summarizeJobs` is filtered again below, after the embed loop has run, so a
  // give-up the embed loop just caused doesn't also let this same run attempt (and double-log) the
  // node's summarize job.
  const isGivenUp = (id: string): boolean => hasGivenUp(deps.failures, id, contentHash(byId.get(id)!.node.body));
  report.gaveUp = new Set([...jobs.embed, ...jobs.summarize.map((j) => j.id)].filter(isGivenUp)).size;
  const embedJobs = jobs.embed.filter((id) => !isGivenUp(id));

  /** F1: one node's embed attempt failed — record it, and either give up on it or count it pending. */
  const failEmbed = (id: string, err: unknown): void => {
    const hash = contentHash(byId.get(id)!.node.body);
    const msg = err instanceof Error ? err.message : String(err);
    recordFailure(deps.failures, id, hash);
    report.failed += 1;
    if (hasGivenUp(deps.failures, id, hash)) {
      report.gaveUp += 1;
      log(`giving up on ${id} after ${MAX_FAILURES} failures until its body changes`);
      return;
    }
    report.pending.embed += 1;
    if (DIM_ERROR.test(msg)) {
      if (!dimMismatchLogged) { dimMismatchLogged = true; log(`embed dim mismatch (${msg}) — check CHATMIND_EMBED_DIM`); }
    } else {
      log(`embed failed for ${id}: ${msg}`);
    }
  };

  // embed, batched and sequential (spec §5); a batch failure falls back to one embed() call per
  // member (F1) so one body the provider rejects cannot leave its batch-mates stale too.
  const batch = deps.embedBatch ?? 32;
  let dimMismatchLogged = false;
  for (let i = 0; i < embedJobs.length; i += batch) {
    const ids = embedJobs.slice(i, i + batch);
    const texts = ids.map((id) => truncateForEmbedding(byId.get(id)!.node.body));
    let batchErr: unknown;
    try {
      const vecs = await deps.embedder.embed(texts);
      if (vecs.length !== ids.length) throw new Error(`embedder returned ${vecs.length} vectors for ${ids.length} texts`);
      for (const v of vecs) if (v.length !== deps.embedder.dim) throw new Error(`embedder returned dim ${v.length}, expected ${deps.embedder.dim}`);
      ids.forEach((id, k) => { deps.db.setEmbedded(id, contentHash(byId.get(id)!.node.body), vecs[k]!); clearFailure(deps.failures, id); });
      report.embedded += ids.length;
      continue;
    } catch (err) {
      batchErr = err;
    }
    // A lone item's batch call already was the "per item" call — no point repeating it.
    if (ids.length === 1) {
      failEmbed(ids[0]!, batchErr);
      continue;
    }
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      try {
        const vec = await embedOne(deps, texts[k]!);
        deps.db.setEmbedded(id, contentHash(byId.get(id)!.node.body), vec);
        clearFailure(deps.failures, id);
        report.embedded += 1;
      } catch (err) {
        failEmbed(id, err);
      }
    }
  }

  // F1: filtered again here (see comment above `embedJobs`) — a give-up the embed loop just recorded
  // for this node must not also fire a summarize attempt this run.
  const summarizeJobs = jobs.summarize.filter((j) => !isGivenUp(j.id));

  // summarize with bounded concurrency; each result is written back under the lock
  await runPool(summarizeJobs, deps.summaryConcurrency ?? 4, async ({ id, expected }) => {
    const { node, canvas } = byId.get(id)!;
    const forHash = contentHash(node.body);
    try {
      const parent = node.parents[0] === undefined ? undefined : byId.get(node.parents[0])?.node;
      const input = { body: truncateForSummary(node.body), lang: detectLanguage([node.body]), role: node.role, parentContext: parent && parentContextOf(parent) };
      const summary = shortcutSummary(node.body) ?? cleanSummary(await deps.summarizer(input));
      if (summary === '') throw new Error('empty summary');
      const res = await writeback({ id, canvas, forHash, expectedSummary: expected, newSummary: summary }, deps);
      if (res.skipped !== null) {
        log(`summary for ${id} dropped: ${res.skipped}`);
        if (res.skipped !== 'vanished') report.pending.summarize += 1; // vanished rows are deleted by the next sync, never re-planned
        return;
      }
      deps.db.setSummary(id, summary, forHash);
      node.summary = summary; // the topic phase below reads summaries from these entries
      clearFailure(deps.failures, id);
      report.summarized += 1;
      if (res.renamed) report.renamed += 1;
    } catch (err) {
      recordFailure(deps.failures, id, forHash);
      report.failed += 1;
      if (hasGivenUp(deps.failures, id, forHash)) {
        report.gaveUp += 1;
        log(`giving up on ${id} after ${MAX_FAILURES} failures until its body changes`);
        return;
      }
      report.pending.summarize += 1;
      log(`summary failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // rename-only (summary provided by the user on a bare-ULID file)
  for (const id of jobs.rename) {
    const { node, canvas } = byId.get(id)!;
    try {
      const res = await writeback({ id, canvas, forHash: contentHash(node.body), expectedSummary: node.summary, newSummary: node.summary }, deps);
      if (res.renamed) report.renamed += 1;
      else if (res.skipped !== null) log(`rename for ${id} dropped: ${res.skipped}`); // no pending bucket for renames; the next run re-plans it
    } catch (err) {
      report.failed += 1;
      log(`rename failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Spec M6 §6: topics last — summaries are the namer's examples, and the embed loop above supplied the vectors.
  const topicJobs = planTopicJobs(entries, deps.db.rows());
  const t = await runTopicPhase(entries, topicJobs, { dataDir: deps.dataDir, db: deps.db, namer: deps.namer, lock: deps.lock, dim: deps.embedder.dim, now: deps.now ?? Date.now, thresholds: deps.thresholds, log, failures: deps.failures });
  report.topics = t.assigned;
  report.asked = t.asked;
  report.failed += t.failed;
  report.gaveUp += t.gaveUp;
  report.pending.topics = t.pending;

  // Spec M15 §2: memories last — they need the topics this run just wrote.
  if (deps.memoryWriter) {
    const m = await runMemoryPhase({ dataDir: deps.dataDir, lock: deps.lock, writer: deps.memoryWriter, log, failures: deps.failures });
    report.memories = m.updated;
    report.failed += m.failed;
    report.gaveUp += m.gaveUp;
    report.pending.memories = m.pending;
  }
  return report;
}
