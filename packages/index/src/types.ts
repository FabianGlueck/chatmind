import type { Role } from '@chatmind/core';
/** Spec M5 §6: what the summarizer sees — the message, its role, and the primary parent as context. */
export interface SummaryInput {
  body: string;
  lang: 'de' | 'en';
  role: Role;
  /** The parent's summary, or the start of its body while it has none; absent for a root node. */
  parentContext?: string;
}

/** Spec M5 §4: a summary generator — model and language are the caller's concern. */
export interface Summarizer {
  (input: SummaryInput): Promise<string>;
}

/** Spec M5 §4: an embedding backend, with the model identity and dimension it produces. */
export interface Embedder {
  model: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Spec M5 §5: the outcome of one indexer run. */
export interface Report {
  at: string;
  nodes: number;
  embedded: number;
  summarized: number;
  renamed: number;
  /** Spec M6 §6: topics written this run. */
  topics: number;
  /** Spec M6 §6: namer calls made this run (not every one lands in `topics` — see `failed`/`gaveUp`); every candidate that never asked was assigned by similarity alone. */
  asked: number;
  failed: number;
  /** F1: nodes skipped this run because they hit MAX_FAILURES consecutive failures — not counted in `pending`. */
  gaveUp: number;
  /** Spec M15 §2: memory files updated this run. */
  memories: number;
  pending: { embed: number; summarize: number; topics: number; memories: number };
}

/** Spec M5 §5: what `chatmind index status` reports. */
export interface IndexStatus {
  enabled: boolean;
  running: boolean;
  lastRun: Report | null;
  pending: { embed: number; summarize: number; topics: number; memories: number };
}

/** Spec M6 §3: what the topic namer sees — the node, its parent's topic, the closest topics with examples, and every topic of the canvas. */
export interface TopicInput {
  summary: string;
  role: Role;
  lang: 'de' | 'en';
  parentTopic?: string;
  /** Top-3 by similarity plus the parent's topic, each with up to 3 summaries of its nodes. */
  candidates: { name: string; examples: string[] }[];
  /** Every topic of the canvas, so the model does not invent a duplicate under another name. */
  allTopics: string[];
  /** Spec M6 §5 (amended 2026-09-25): the message has no parent — the user opened a strand of its own. */
  startsStrand?: boolean;
  /** Spec M6 §5 (amended 2026-09-25): no candidate reaches `T_ASSIGN` by similarity — the namer is told so. */
  distant?: boolean;
}

/** Spec M6 §3: returns a topic name — an existing one or a new one. */
export interface TopicNamer {
  (input: TopicInput): Promise<string>;
}

/** Spec M15 §2: writes the new bullets for one topic's memory — the raw answer, parsed by parseMemoryBullets. */
export interface MemoryWriter {
  (input: import('./memory-phase').MemoryInput): Promise<string>;
}
