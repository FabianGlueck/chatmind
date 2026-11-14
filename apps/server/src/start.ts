import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { VaultLock } from '@chatmind/core';
import { describeLinkSettings, describeThresholds, Indexer, linkSettings, watchVault } from '@chatmind/index';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { indexSettings, openRouterIndexProviders } from './index-providers';
import type { Keys } from './keys';
import { LinkService } from './links';
import { TopicPlacer } from './placement';

export interface StartOptions {
  dataDir: string;
  /** 0 picks a free port. */
  port: number;
  /** Built frontend (apps/web/dist), absolute. */
  staticDir?: string;
  noIndex?: boolean;
  /** Merged settings (`loadEnv`) and keys (`loadKeys`), loaded by the caller. */
  env: Record<string, string>;
  keys: Keys;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  dataDir: string;
  /** Spec M5 §8 shutdown order; idempotent, never exits the process. */
  close(): Promise<void>;
}

/**
 * Desktop spec §2: everything between argument parsing and signal handling, shared by the CLI entry
 * (`index.ts`) and the desktop app. Rejects with the listen error (code `EADDRINUSE` for a taken port)
 * after releasing what it opened.
 */
export async function startServer(o: StartOptions): Promise<RunningServer> {
  const log = o.log ?? ((line) => console.log(line));
  const error = o.error ?? ((line) => console.error(line));
  const { dataDir, keys } = o;
  await fs.mkdir(dataDir, { recursive: true });
  const settings = indexSettings(o.env);
  const lock = new VaultLock();
  const watcher = watchVault(dataDir);
  const dbFile = path.join(dataDir, '.app', 'index.db');

  let indexer: Indexer | undefined;
  let placer: TopicPlacer | undefined;
  let indexLine = 'index: off (--no-index)';
  if (!(o.noIndex || settings.noIndex)) {
    if (keys.openrouter) {
      const { summarizer, embedder, namer, judge, memoryWriter } = openRouterIndexProviders(keys.openrouter, settings);
      indexer = new Indexer({ dataDir, dbFile, summarizer, embedder, namer, memoryWriter, lock, thresholds: settings.thresholds });
      placer = new TopicPlacer({ dbFile, embedder, judge }); // spec M14
      watcher.onChange(() => indexer!.trigger());
      // Spec M6 §4: a tuned threshold is named on startup, so a typo in CHATMIND_TOPIC_* is visible instead of silently ignored.
      const tuned = describeThresholds(settings.thresholds);
      indexLine = `index: on (summary ${settings.summaryModel}, embed ${settings.embedModel}/${settings.embedDim}${tuned === null ? '' : `, topics ${tuned}`})`;
    } else {
      indexLine = 'index: off (no OPENROUTER_API_KEY)';
    }
  }

  // Spec M7 §5: links read index.db on their own handle, so they work with --no-index too.
  const linkCfg = linkSettings(o.env);
  const links = new LinkService({ dbFile, settings: linkCfg });
  const linkTuned = describeLinkSettings(linkCfg);

  const app = createApp({ dataDir, staticDir: o.staticDir, keys, lock, watcher, indexer, links, placer });
  const server = serve({ fetch: app.fetch, port: o.port, hostname: '127.0.0.1' });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      server.close();
      (server as { closeAllConnections?: () => void }).closeAllConnections?.(); // open SSE streams would hold it otherwise
      await watcher.close();
      await indexer?.close();
      links.close();
      placer?.close();
    })();
    return closing;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (err) {
    await close();
    throw err;
  }
  server.on('error', (err: Error) => error(`server error: ${err.message}`));
  const port = (server.address() as AddressInfo).port;
  log(`chatmind server on http://127.0.0.1:${port}  data dir: ${dataDir}${o.staticDir ? `  serving ${o.staticDir}` : ''}`);
  log(`providers: ${Object.keys(keys).join(', ') || 'none (set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or MISTRAL_API_KEY, or ~/.config/chatmind/env)'}`);
  log(indexLine);
  if (linkTuned !== null) log(`links: ${linkTuned}`);
  // Only once the port is ours: a second server that fails to listen must never index the vault next to the first.
  if (indexer) void indexer.start().catch((err: unknown) => error(`index: start failed: ${err instanceof Error ? err.message : String(err)}`));
  return { port, dataDir, close };
}
