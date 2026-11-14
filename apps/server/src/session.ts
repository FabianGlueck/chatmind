import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { VaultLock } from '@chatmind/core';
import { describeLinkSettings, describeThresholds, Indexer, linkSettings, watchVault, type VaultWatcher } from '@chatmind/index';
import { indexSettings, openRouterIndexProviders } from './index-providers';
import type { Keys } from './keys';
import { LinkService } from './links';
import { TopicPlacer } from './placement';

/** Spec vault-switcher §5: everything that hangs on one data folder. */
export interface VaultSession {
  dataDir: string;
  watcher?: Pick<VaultWatcher, 'onChange'>;
  indexer?: Indexer;
  links?: Pick<LinkService, 'links'>;
  placer?: Pick<TopicPlacer, 'pick'>;
  /** Startup log lines about the index and links. */
  describe: string[];
  /** Begins background indexing; called once the session is the live one (the port is ours). */
  start(): void;
  close(): Promise<void>;
}

export interface SessionContext {
  keys: Keys;
  env: Record<string, string>;
  noIndex: boolean;
  lock: VaultLock;
}

/** Creates the folder like startup always did (`mkdir -p`); throws with the reason when it cannot be a vault folder. */
export async function openSession(dataDir: string, ctx: SessionContext): Promise<VaultSession> {
  await fs.mkdir(dataDir, { recursive: true });
  const settings = indexSettings(ctx.env);
  const dbFile = path.join(dataDir, '.app', 'index.db');
  const watcher = watchVault(dataDir);

  let indexer: Indexer | undefined;
  let placer: TopicPlacer | undefined;
  let indexLine = 'index: off (--no-index)';
  if (!(ctx.noIndex || settings.noIndex)) {
    if (ctx.keys.openrouter) {
      const { summarizer, embedder, namer, judge, memoryWriter } = openRouterIndexProviders(ctx.keys.openrouter, settings);
      indexer = new Indexer({ dataDir, dbFile, summarizer, embedder, namer, memoryWriter, lock: ctx.lock, thresholds: settings.thresholds });
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
  const linkCfg = linkSettings(ctx.env);
  const links = new LinkService({ dbFile, settings: linkCfg });
  const linkTuned = describeLinkSettings(linkCfg);

  return {
    dataDir,
    watcher,
    ...(indexer ? { indexer } : {}),
    links,
    ...(placer ? { placer } : {}),
    describe: [indexLine, ...(linkTuned === null ? [] : [`links: ${linkTuned}`])],
    start: () => {
      if (indexer) void indexer.start().catch((err: unknown) => console.error(`index: start failed: ${err instanceof Error ? err.message : String(err)}`));
    },
    // Spec M5 §8: stop watching, let the current reconcile finish (bounded inside close()), close the db.
    close: async () => {
      await watcher.close();
      await indexer?.close();
      links.close();
      placer?.close();
    },
  };
}
