import path from 'node:path';
import { exists, readVault, resolveDataDir } from '@chatmind/core';
import { IndexDb, MIN_CENTER, assignTopic, centre, describeThresholds, loadEnv, planTopicJobs, prepareCanvas, rowsForPlan, topicSettings, type Entry } from '@chatmind/index';

/**
 * Spec M6 §6: the calibration tool — runs the assignment over every candidate with the stored vectors, prints
 * similarities and decisions, writes nothing and never calls the namer (`ask` prints as "would ask"). Exit 0 always.
 */
export async function indexTopicsDryRun(dataDir?: string, now: () => number = Date.now, env?: Record<string, string | undefined>): Promise<number> {
  // Omitted means "resolve them the way the server does": process env over ~/.config/chatmind/env.
  const resolved = env ?? (await loadEnv());
  const root = resolveDataDir(dataDir);
  const file = path.join(root, '.app', 'index.db');
  console.log(`data dir: ${root}`);
  if (!(await exists(file))) { console.log('no index (.app/index.db missing) — start the server to build it'); return 0; }
  const db = IndexDb.openReadonly(file, { vec: true });
  try {
    const { canvases } = await readVault(root);
    const vectors = db.allVectors();
    const dim = Number(db.meta('embed_dim'));
    const centred = centre(vectors, dim);
    console.log(`${vectors.size} vectors, dim ${dim}, centring ${vectors.size >= MIN_CENTER ? 'on' : 'off'}`);
    // Spec M6 §4: the same thresholds the indexer would use, so a tuned run and a dry run cannot disagree.
    const thresholds = topicSettings(resolved);
    const tuned = describeThresholds(thresholds);
    console.log(`thresholds: ${tuned ?? 'defaults'}`);
    const rows = db.rows();
    for (const g of canvases) {
      const entries: Entry[] = [...g.nodes.values()].map((node) => ({ node, canvas: g.slug, path: g.paths.get(node.id)! }));
      const jobs = new Set(planTopicJobs(entries, rowsForPlan(entries, rows)));
      const { state, candidates, deferred } = prepareCanvas(entries, centred, jobs, dim, now());
      const topics = state.centroids.topics();
      const topicsText = topics.length === 0 ? '0 topics' : `${topics.length} topic${topics.length === 1 ? '' : 's'} (${topics.join(', ')})`;
      console.log(`canvas ${g.slug}: ${topicsText}, ${candidates.length} candidates, ${deferred.length} deferred`);
      for (const c of candidates) {
        const node = g.nodes.get(c.id)!;
        const parentTopic = c.parentId === undefined ? undefined : state.topicOf.get(c.parentId);
        const d = assignTopic(c.vec, state.centroids, parentTopic, thresholds);
        const sims = d.sims.slice(0, 3).map((s) => `${s.topic}=${s.sim.toFixed(2)}`).join(' ');
        const verdict = d.kind === 'assign' ? `assign ${d.topic}` : `would ask [${d.candidates.join(', ')}]`;
        console.log(`  ${c.id} ${node.role} parent ${parentTopic ?? '-'} | ${sims || '(no topics)'} | → ${verdict}`);
      }
      for (const id of deferred) console.log(`  ${id} user → deferred (waiting for a reply)`);
    }
  } finally {
    db.close();
  }
  return 0;
}
