import type { VaultLock } from '@chatmind/core';
import { IndexDb } from './db';
import { reconcile, type NodeFailure } from './reconcile';
import type { Thresholds } from './topics';
import type { Embedder, IndexStatus, MemoryWriter, Report, Summarizer, TopicNamer } from './types';

export interface IndexerOptions {
  dataDir: string;
  dbFile: string;
  summarizer: Summarizer;
  embedder: Embedder;
  namer: TopicNamer;
  /** Spec M15 §2: absent means no memories. */
  memoryWriter?: MemoryWriter;
  lock: VaultLock;
  log?: (msg: string) => void;
  retryMs?: { initial: number; max: number }; // default 60 s → 10 min
  /** Spec M6 §4: assignment thresholds; omitted means the calibrated defaults. */
  thresholds?: Thresholds;
  embedBatch?: number;
  summaryConcurrency?: number;
  /** Spec M6 §6: clock for the user-node deferral; tests inject it. */
  now?: () => number;
}

/**
 * Spec M5 §5: at most one reconcile at a time; a trigger during a run sets `dirty` and exactly one more run
 * follows. While a run ends with pending jobs a retry timer doubles from `initial` to `max`; a clean run resets it.
 */
export class Indexer {
  private db: IndexDb | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private lastRun: Report | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private closed = false;
  // F1: one instance for the indexer's lifetime, so a node's consecutive-failure count survives across runs.
  private readonly failures = new Map<string, NodeFailure>();

  constructor(private readonly o: IndexerOptions) {
    this.retryDelay = o.retryMs?.initial ?? 60_000;
  }

  async start(): Promise<void> {
    this.db = IndexDb.open(this.o.dbFile, this.o.embedder);
    this.trigger();
    await this.running;
  }

  trigger(): void {
    if (this.closed || this.db === null) return;
    if (this.running !== null) {
      this.dirty = true;
      return;
    }
    this.running = this.runLoop().finally(() => {
      this.running = null;
    });
  }

  private async runLoop(): Promise<void> {
    do {
      this.dirty = false;
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      try {
        this.lastRun = await reconcile({ dataDir: this.o.dataDir, db: this.db!, summarizer: this.o.summarizer, embedder: this.o.embedder, namer: this.o.namer, ...(this.o.memoryWriter ? { memoryWriter: this.o.memoryWriter } : {}), lock: this.o.lock, log: this.o.log, embedBatch: this.o.embedBatch, summaryConcurrency: this.o.summaryConcurrency, now: this.o.now, thresholds: this.o.thresholds, failures: this.failures });
      } catch (err) {
        (this.o.log ?? console.error)(`reconcile crashed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } while (this.dirty && !this.closed);
    const pending = this.lastRun ? this.lastRun.pending.embed + this.lastRun.pending.summarize + this.lastRun.pending.topics + this.lastRun.pending.memories : 0;
    if (pending > 0 && !this.closed) {
      const max = this.o.retryMs?.max ?? 600_000;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.trigger();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, max);
    } else {
      this.retryDelay = this.o.retryMs?.initial ?? 60_000;
    }
  }

  status(): IndexStatus {
    return { enabled: true, running: this.running !== null, lastRun: this.lastRun, pending: this.lastRun?.pending ?? { embed: 0, summarize: 0, topics: 0, memories: 0 } };
  }

  /** Resolves once no run is active (a queued follow-up run counts as active). */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    await Promise.race([this.idle(), new Promise<void>((r) => setTimeout(r, 10_000))]);
    this.db?.close();
    this.db = null;
  }
}
