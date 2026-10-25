import path from 'node:path';
import { exists, readVault, resolveDataDir } from '@chatmind/core';
import { IndexDb, MIN_CENTER, allLinks, describeLinkSettings, linkSettings, linkSpace, loadEnv, summaryOf, vaultLinks } from '@chatmind/index';

/**
 * Spec M7 §5: the calibration tool — every mutual link in the vault with the stored vectors, printed once under
 * the canvas that sorts first as `score (cos raw)`, then totals. `--k` / `--min` override the settings. Read-only; exit 0 always.
 */
export async function indexLinksDryRun(dataDir?: string, flags: { k?: string; min?: string } = {}, env?: Record<string, string | undefined>): Promise<number> {
  // Omitted means "resolve them the way the server does": process env over ~/.config/chatmind/env.
  const resolved = { ...(env ?? (await loadEnv())) };
  if (flags.k !== undefined) resolved.CHATMIND_LINK_K = flags.k;
  if (flags.min !== undefined) resolved.CHATMIND_LINK_MIN = flags.min;
  const root = resolveDataDir(dataDir);
  const file = path.join(root, '.app', 'index.db');
  console.log(`data dir: ${root}`);
  if (!(await exists(file))) { console.log('no index (.app/index.db missing) — start the server to build it'); return 0; }
  const db = IndexDb.openReadonly(file, { vec: true });
  try {
    const { canvases } = await readVault(root);
    const vectors = db.allVectors();
    const dim = Number(db.meta('embed_dim'));
    const v = vaultLinks(canvases, linkSpace(vectors, vectors.keys(), dim));
    const participants = v.space.vecs.size;
    console.log(`${vectors.size} vectors, dim ${dim}, centring ${vectors.size >= MIN_CENTER ? 'on' : 'off'}, ${participants} participants`);
    const settings = linkSettings(resolved);
    console.log(`settings: ${describeLinkSettings(settings) ?? `defaults (k ${settings.k}, min ${settings.tMin})`}`);

    const pairs = allLinks(v.space, v.excluded, settings);
    const slugOf = (id: string): string => v.owner.get(id)!.slug;
    const label = (id: string): string => summaryOf(v.owner.get(id)!.nodes.get(id)!);
    const degree = new Map<string, number>();
    const byCanvas = new Map<string, string[]>();
    for (const p of pairs) {
      degree.set(p.a, (degree.get(p.a) ?? 0) + 1);
      degree.set(p.b, (degree.get(p.b) ?? 0) + 1);
      const [first, second] = slugOf(p.a) <= slugOf(p.b) ? [p.a, p.b] : [p.b, p.a];
      const other = slugOf(second) === slugOf(first) ? '' : ` [${slugOf(second)}]`;
      const lines = byCanvas.get(slugOf(first)) ?? [];
      lines.push(`  ${p.score.toFixed(2)} (cos ${p.sim.toFixed(2)})  ${label(first)} ↔ ${label(second)}${other}`);
      byCanvas.set(slugOf(first), lines);
    }
    for (const g of [...canvases].sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
      const lines = byCanvas.get(g.slug) ?? [];
      console.log(`canvas ${g.slug}: ${lines.length} link${lines.length === 1 ? '' : 's'}`);
      for (const l of lines) console.log(l);
    }
    const max = Math.max(0, ...degree.values());
    const mean = participants === 0 ? 0 : (2 * pairs.length) / participants;
    console.log(`totals: ${pairs.length} link${pairs.length === 1 ? '' : 's'}, ${participants} participants, ${participants - degree.size} without a link, per participant mean ${mean.toFixed(2)} max ${max}`);
  } finally {
    db.close();
  }
  return 0;
}
