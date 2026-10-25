import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveDataDir, VaultLock } from '@chatmind/core';
import { describeLinkSettings, describeThresholds, Indexer, linkSettings, watchVault } from '@chatmind/index';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { indexSettings, openRouterIndexProviders } from './index-providers';
import { loadEnv, loadKeys } from './keys';
import { listenerPid, portInUseMessage, watchParent } from './lifecycle';
import { LinkService } from './links';
import { TopicPlacer } from './placement';

const invokedFrom = process.env.INIT_CWD ?? process.cwd();
const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    port: { type: 'string' },
    static: { type: 'string' },
    'no-index': { type: 'boolean' },
    // Dev only (package.json "dev"): exit when `tsx watch` dies without signalling us — see lifecycle.ts.
    'exit-with-parent': { type: 'boolean' },
  },
});

const dataDir = resolveDataDir(values['data-dir'] === undefined ? undefined : path.resolve(invokedFrom, values['data-dir']));
const port = Number(values.port ?? process.env.CHATMIND_PORT ?? 3210);
// `--static` is given relative to the server package (see package.json "start"), not the invoking shell.
const staticDir = values.static === undefined ? undefined : path.resolve(import.meta.dirname, '..', values.static);

await fs.mkdir(dataDir, { recursive: true });
const env = await loadEnv();
const keys = await loadKeys();
const settings = indexSettings(env);
const lock = new VaultLock();
const watcher = watchVault(dataDir);

let indexer: Indexer | undefined;
let placer: TopicPlacer | undefined;
let indexLine = 'index: off (--no-index)';
if (!(values['no-index'] || settings.noIndex)) {
  if (keys.openrouter) {
    const { summarizer, embedder, namer, judge, memoryWriter } = openRouterIndexProviders(keys.openrouter, settings);
    indexer = new Indexer({ dataDir, dbFile: path.join(dataDir, '.app', 'index.db'), summarizer, embedder, namer, memoryWriter, lock, thresholds: settings.thresholds });
    placer = new TopicPlacer({ dbFile: path.join(dataDir, '.app', 'index.db'), embedder, judge }); // spec M14
    watcher.onChange(() => indexer!.trigger());
    // Spec M6 §4: a tuned threshold is named on startup, so a typo in CHATMIND_TOPIC_* is visible instead of silently ignored.
    const tuned = describeThresholds(settings.thresholds);
    indexLine = `index: on (summary ${settings.summaryModel}, embed ${settings.embedModel}/${settings.embedDim}${tuned === null ? '' : `, topics ${tuned}`})`;
  } else {
    indexLine = 'index: off (no OPENROUTER_API_KEY)';
  }
}

// Spec M7 §5: links read index.db on their own handle, so they work with --no-index too.
const linkCfg = linkSettings(env);
const links = new LinkService({ dbFile: path.join(dataDir, '.app', 'index.db'), settings: linkCfg });
const linkTuned = describeLinkSettings(linkCfg);

const app = createApp({ dataDir, staticDir, keys, lock, watcher, indexer, links, placer });
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`chatmind server on http://127.0.0.1:${port}  data dir: ${dataDir}${staticDir ? `  serving ${staticDir}` : ''}`);
  console.log(`providers: ${Object.keys(keys).join(', ') || 'none (set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, or ~/.config/chatmind/env)'}`);
  console.log(indexLine);
  if (linkTuned !== null) console.log(`links: ${linkTuned}`);
  // Only once the port is ours: a second server that fails to listen must never index the vault next to the first.
  if (indexer) void indexer.start().catch((err: unknown) => console.error(`index: start failed: ${err instanceof Error ? err.message : String(err)}`));
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(portInUseMessage(port, listenerPid(port)));
  void watcher.close().finally(() => process.exit(1));
});

// Spec M5 §8: stop watching, let the current reconcile finish (bounded inside close()), close the db.
// `process.once` only dedupes the same signal, so a SIGTERM arriving while a SIGINT shutdown is still
// awaiting close() must not start a second, concurrent shutdown (double close, possible unhandled rejection).
// The port is released first, so a restart never races a slow reconcile; a hung close is cut off after SHUTDOWN_MS.
const SHUTDOWN_MS = 12_000;
let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  (server as { closeAllConnections?: () => void }).closeAllConnections?.(); // open SSE streams would hold it otherwise
  setTimeout(() => {
    console.error(`shutdown took over ${SHUTDOWN_MS / 1000} s — exiting anyway`);
    process.exit(1);
  }, SHUTDOWN_MS).unref();
  try {
    await watcher.close();
    await indexer?.close();
    links.close();
    placer?.close();
  } finally {
    process.exit(0);
  }
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
if (values['exit-with-parent']) {
  watchParent({
    onGone: () => {
      console.error('parent process gone — shutting down');
      void shutdown();
    },
  });
}
