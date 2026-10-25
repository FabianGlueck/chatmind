import path from 'node:path';
import { VaultLock, exists, listCanvasFolders, readCanvas, resolveDataDir, writeNode } from '@chatmind/core';
import { IndexDb } from '@chatmind/index';

/**
 * Spec M6 §4: blank the topics *we* wrote in one canvas so the indexer assigns them again with the current
 * thresholds. A topic the user set or renamed no longer matches `topic_written` and is therefore left alone.
 * Writes only `topics:`; no rename, no canvas rewrite. Like an edit in Obsidian, it is an external write the
 * running indexer picks up through the watcher — set CHATMIND_TOPIC_* and restart the server first, or the
 * re-assignment uses the old values.
 */
export async function indexRetopic(canvas: string, dataDir?: string): Promise<number> {
  const root = resolveDataDir(dataDir);
  console.log(`data dir: ${root}`);
  const found = await readCanvas(root, canvas);
  if (found === null) {
    // A slug is the folder name, not the canvas title the user typed — name the real ones instead of making them guess.
    const known = await listCanvasFolders(root).catch(() => []);
    console.error(`canvas ${canvas} not found in ${root}`);
    console.error(known.length === 0 ? 'this vault has no canvases yet' : `canvases in this vault: ${known.join(', ')}`);
    return 2;
  }
  const file = path.join(root, '.app', 'index.db');
  if (!(await exists(file))) {
    console.log('no index (.app/index.db missing) — nothing is known about which topics were ours');
    return 0;
  }
  const db = IndexDb.openReadonly(file);
  let rows;
  try {
    rows = db.rows();
  } finally {
    db.close();
  }
  const { graph } = found;
  let cleared = 0;
  let kept = 0;
  // One lock turn per node: the file is rewritten from the graph we just read, so nothing else in it changes.
  const lock = new VaultLock();
  for (const node of graph.nodes.values()) {
    const written = rows.get(node.id)?.topic_written;
    if (node.topics.length === 0) continue;
    if (written === null || written === undefined || node.topics[0] !== written) {
      kept += 1;
      continue;
    }
    node.topics = [];
    await lock.run(() => writeNode(graph, node.id, root));
    cleared += 1;
  }
  console.log(`canvas ${canvas}: cleared ${cleared}, kept ${kept} — the indexer assigns the cleared ones again on its next run`);
  return 0;
}
