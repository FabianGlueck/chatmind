import { afterAll, describe, expect, it, vi } from 'vitest';
import { VaultLock } from '@chatmind/core';
import path from 'node:path';
import { Indexer } from '../src/indexer';
import { USER_WAIT_MS } from '../src/topic-phase';
import type { SummaryInput } from '../src/types';
import { fakeEmbedder, fakeNamer, fakeSummarizer } from './fakes';
import { cleanupTmpDirs, nodeOnDisk, vaultWith } from './helpers';

afterAll(cleanupTmpDirs);

// Two lines so it never takes the single-line shortcut (see summary.ts).
const LONG = 'Wie evaluiere ich die Topic-Zuordnung,\nwenn die Zentroide sich mit der Zeit verschieben?';

// The clock runs USER_WAIT_MS ahead so the lone user node is judged, not deferred (spec M6 §4) — deferral would keep
// `pending.topics` at 1 and the retry timer alive, which is not what these M5 timing tests measure.
function make(root: string, over: Partial<ConstructorParameters<typeof Indexer>[0]> = {}) {
  const embedder = fakeEmbedder();
  const summarizer = fakeSummarizer();
  const log: string[] = [];
  const ix = new Indexer({ dataDir: root, dbFile: path.join(root, '.app', 'index.db'), embedder, summarizer, namer: fakeNamer(), now: () => Date.now() + USER_WAIT_MS + 1000, lock: new VaultLock(), log: (m) => log.push(m), retryMs: { initial: 50, max: 200 }, ...over });
  return { ix, embedder, summarizer, log };
}

describe('Indexer (spec M5 §5)', () => {
  it('forwards the topic thresholds to the reconcile run (spec M6 §4)', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG }, { role: 'assistant', content: `Antwort:\n${LONG}`, model: 'x' }]);
    const namer = fakeNamer();
    // tInherit/tAssign at 1 are above every attainable cosine: no node can inherit or be assigned, so both ask.
    const { ix } = make(root, { namer, thresholds: { tInherit: 1, inheritMargin: 0.05, tAssign: 1, assignMargin: 0.1 } });
    await ix.start();
    await ix.idle();
    expect(namer.calls).toHaveLength(2);
    await ix.close();
  });

  it('start runs a reconcile; status reflects it', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: LONG }]);
    const { ix } = make(root);
    expect(ix.status()).toEqual({ enabled: true, running: false, lastRun: null, pending: { embed: 0, summarize: 0, topics: 0, memories: 0 } });
    await ix.start();
    await ix.idle();
    const s = ix.status();
    expect(s.running).toBe(false);
    expect(s.lastRun).toMatchObject({ nodes: 1, embedded: 1, summarized: 1 });
    expect((await nodeOnDisk(root, 'm', [...graph.nodes.keys()][0]!)).node.summary).toMatch(/^DE: /);
    await ix.close();
  });

  it('triggers during a run collapse into exactly one follow-up run', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG }]);
    let release: () => void = () => undefined;
    const slow = Object.assign(async ({ body }: SummaryInput) => { await new Promise<void>((r) => { release = r; }); return `T ${body.slice(0, 5)}`; }, { calls: [], fail: false });
    const { ix, embedder } = make(root, { summarizer: slow });
    const started = ix.start();
    await new Promise((r) => setTimeout(r, 20)); // inside run 1, blocked in the summarizer
    ix.trigger();
    ix.trigger();
    ix.trigger();
    release();
    await started;
    await ix.idle();
    // run 1 embedded once; run 2 (the single follow-up) found nothing to embed
    expect(embedder.calls).toHaveLength(1);
    expect(ix.status().lastRun).toMatchObject({ embedded: 0, summarized: 0 });
    await ix.close();
  });

  it('schedules retries with backoff while failures remain, and stops when clean', async () => {
    vi.useFakeTimers();
    try {
      const { root } = await vaultWith('m', [{ role: 'user', content: LONG }]);
      const { ix, embedder } = make(root);
      // Only the embedder fails here (not the summarizer too, as before F1): a node's give-up
      // counter (MAX_FAILURES = 3) is shared across embed and summary failures, and only two
      // failing attempts are exercised below — this isolates backoff timing from the F1 give-up
      // path, which has its own dedicated test.
      embedder.fail = true;
      await ix.start();
      await ix.idle();
      expect(ix.status().pending).toEqual({ embed: 1, summarize: 0, topics: 0, memories: 0 });
      await vi.advanceTimersByTimeAsync(50);
      await ix.idle();
      expect(embedder.calls).toHaveLength(2); // retry after 50 ms
      embedder.fail = false;
      await vi.advanceTimersByTimeAsync(100);
      await ix.idle();
      expect(ix.status().pending).toEqual({ embed: 0, summarize: 0, topics: 0, memories: 0 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(embedder.calls).toHaveLength(3); // no further retries
      await ix.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1: stops scheduling retries once a node gives up permanently', async () => {
    vi.useFakeTimers();
    try {
      const { root } = await vaultWith('m', [{ role: 'user', content: LONG }]);
      const { ix, summarizer } = make(root);
      summarizer.fail = true; // embedder keeps succeeding — only the summarize side stays pending
      await ix.start();
      await ix.idle();
      expect(ix.status().pending).toEqual({ embed: 0, summarize: 1, topics: 0, memories: 0 });
      await vi.advanceTimersByTimeAsync(50);
      await ix.idle();
      expect(summarizer.calls).toHaveLength(2); // retry after 50 ms
      await vi.advanceTimersByTimeAsync(100);
      await ix.idle();
      expect(summarizer.calls).toHaveLength(3); // the 3rd attempt gives up
      expect(ix.status().pending).toEqual({ embed: 0, summarize: 0, topics: 0, memories: 0 });
      expect(ix.status().lastRun).toMatchObject({ gaveUp: 1 });
      // no more pending ⇒ no retry timer, however long we wait
      await vi.advanceTimersByTimeAsync(10_000);
      expect(summarizer.calls).toHaveLength(3);
      await ix.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
