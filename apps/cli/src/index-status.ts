import path from 'node:path';
import { exists, readVault, resolveDataDir } from '@chatmind/core';
import { DEFAULT_EMBED_DIM, DEFAULT_EMBED_MODEL, IndexDb, contentHash, dueTurns, planJobs, planTopicJobs, rowsForPlan, type Entry } from '@chatmind/index';

/** Spec M5 §8: read-only report — vault + index.db, no network, no writes. Exit 0 always. */
export async function indexStatus(dataDir?: string): Promise<number> {
  const root = resolveDataDir(dataDir);
  const file = path.join(root, '.app', 'index.db');
  console.log(`data dir: ${root}`);
  const { canvases } = await readVault(root);
  const db = (await exists(file)) ? IndexDb.openReadonly(file) : null;
  if (db === null) console.log('no index (.app/index.db missing) — start the server to build it');
  const rows = db?.rows() ?? new Map();
  for (const g of canvases) {
    const entries: Entry[] = [...g.nodes.values()].map((node) => ({ node, canvas: g.slug, path: g.paths.get(node.id)! }));
    const fresh = rowsForPlan(entries, rows);
    const jobs = planJobs(entries, fresh);
    const embedded = entries.filter((e) => fresh.get(e.node.id)?.embedded_hash === contentHash(e.node.body)).length;
    const summarized = entries.filter((e) => e.node.summary !== '').length;
    const topics = entries.filter((e) => e.node.topics.length > 0).length;
    const pendingTopics = planTopicJobs(entries, fresh).length;
    console.log(`canvas ${g.slug}: ${entries.length} nodes, ${embedded} embedded, ${summarized} summarized, ${topics} topics, pending embed ${jobs.embed.length}, pending summary ${jobs.summarize.length}, pending topics ${pendingTopics}, ${g.memories?.length ?? 0} memories, pending memories ${dueTurns(g).size}`);
  }
  if (db !== null) {
    const model = db.meta('embed_model');
    const dim = db.meta('embed_dim');
    const matches = model === DEFAULT_EMBED_MODEL && dim === String(DEFAULT_EMBED_DIM);
    console.log(`embed model: ${model} (dim ${dim}) — ${matches ? 'matches default' : 'differs from default; the server rebuilds vectors on start if its setting differs'}`);
    db.close();
  }
  return 0;
}
