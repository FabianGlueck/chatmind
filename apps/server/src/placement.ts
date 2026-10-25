import type { CanvasGraph } from '@chatmind/core';
import { assignTopic, centre, cleanTopic, foldTopic, IndexDb, meanVector, MIN_CENTER, prepareCanvas, topicKey, truncateForEmbedding, type Embedder } from '@chatmind/index';

/** Spec M14 §judge: the topics the LLM may choose from, each with example summaries, and the new question. */
export interface PlacementInput { question: string; topics: { name: string; examples: string[] }[] }
/** Spec M14 §judge: the model's raw answer — a listed topic name or `NONE`. */
export type PlacementJudge = (input: PlacementInput) => Promise<string>;

export interface TopicPlacerOptions {
  dbFile: string;
  embedder: Pick<Embedder, 'embed'>;
  /** Asked only when the embedding is unclear; absent means an unclear question keeps the old placement. */
  judge?: PlacementJudge;
  embedTimeoutMs?: number;
  judgeTimeoutMs?: number;
}

/**
 * Spec M14: a bare question is a weaker signal than the question + answer the indexer judges, so placement has its
 * own bar (calibrated 2026-09-25 on the user's pandas canvas: fitting questions 0.26–0.56 with ≥ 0.09 daylight,
 * unrelated ones ≤ 0.21). Above it the embedding decides alone; below it the judge is asked.
 */
export const T_PLACE = 0.25;
export const PLACE_MARGIN = 0.08;
/** Spec M14: how long a send waits for the embedding, and then for the judge, before it places the old way. */
export const EMBED_TIMEOUT_MS = 2000;
export const JUDGE_TIMEOUT_MS = 3000;
/** Spec M14 §judge: at most this many topics (the closest first) go into the judge's prompt. */
const MAX_JUDGE_TOPICS = 8;

/** Spec M14 §judge: fixed and language-neutral, like the namer's (provider prompt caches). */
export const PLACE_SYSTEM =
  'A user starts a new conversation strand on a canvas whose earlier messages are filed under topics. Decide whether the new question belongs to one of the listed topics: ' +
  'it must be about that same specific subject, not merely the same field (a general machine-learning question does not belong to a topic about one particular competition). ' +
  'The question may be short, casual or misspelled — read it charitably. ' +
  'Reply with exactly one listed topic name, or NONE if it fits none. Nothing else.';

/** Spec M14 §judge: the user message for the judge. Pure. */
export function placePrompt(input: PlacementInput): string {
  const topics = input.topics.map((t) => `- ${t.name}${t.examples.length > 0 ? `: ${t.examples.join(' | ')}` : ''}`);
  return ['Topics (with example summaries of messages filed there):', ...topics, '', 'New question:', input.question].join('\n');
}

/** Spec M14 §judge: the judge's answer as one of `names`, or `null` for NONE or anything unlisted. */
export function parseJudgement(raw: string, names: readonly string[]): string | null {
  const name = cleanTopic(raw);
  if (name === '' || topicKey(name) === 'none') return null;
  const folded = foldTopic(name, names);
  return names.includes(folded) ? folded : null;
}

function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([p, timeout]).catch(() => null).finally(() => clearTimeout(timer));
}

/**
 * Spec M14: which topic a new strand belongs to, so it can start next to it. The embedding decides a clear case;
 * an unclear one goes to the judge (an LLM). Its own read-only handle on `index.db` (as the link service); the
 * centred vectors are cached until `data_version` says the indexer committed. Never throws.
 */
export class TopicPlacer {
  private db: IndexDb | null = null;
  private cache: { version: number; dim: number; mu: Float32Array | null; centred: Map<string, Float32Array> } | null = null;

  constructor(private readonly o: TopicPlacerOptions) {}

  private space(): NonNullable<TopicPlacer['cache']> | null {
    if (this.db === null) {
      try {
        this.db = IndexDb.openReadonly(this.o.dbFile, { vec: true });
      } catch {
        return null; // no index yet — retried on the next send
      }
    }
    const version = this.db.dataVersion();
    if (this.cache?.version !== version) {
      const dim = Number(this.db.meta('embed_dim'));
      if (!Number.isInteger(dim) || dim <= 0) return null;
      const all = this.db.allVectors();
      this.cache = { version, dim, mu: all.size >= MIN_CENTER ? meanVector(all.values(), dim) : null, centred: centre(all, dim) };
    }
    return this.cache;
  }

  /** The topic of `graph` the new question `text` belongs to, or `null` — no topics, nothing fits, too slow, an error. */
  async pick(graph: CanvasGraph, text: string): Promise<string | null> {
    try {
      if (text.trim() === '') return null;
      const s = this.space();
      const entries = [...graph.nodes.values()].map((node) => ({ node, canvas: graph.slug, path: graph.paths.get(node.id) ?? '' }));
      const { state } = prepareCanvas(entries, s?.centred ?? new Map(), new Set(), s?.dim ?? 0, Date.now());
      const names = [...new Set(state.topicOf.values())];
      if (names.length === 0) return null;
      let order = names;
      if (s !== null) {
        const vecs = await within(this.o.embedder.embed([truncateForEmbedding(text)]), this.o.embedTimeoutMs ?? EMBED_TIMEOUT_MS);
        const vec = vecs?.[0];
        if (vec?.length === s.dim) {
          const q = s.mu === null ? vec : vec.map((x, i) => x - s.mu![i]!);
          const d = assignTopic(q, state.centroids, undefined, { tInherit: 1, inheritMargin: 0, tAssign: T_PLACE, assignMargin: PLACE_MARGIN });
          if (d.kind === 'assign') return d.topic;
          order = [...d.sims.map((x) => x.topic), ...names.filter((n) => !d.sims.some((x) => x.topic === n))];
        }
      }
      if (!this.o.judge) return null;
      const topics = order.slice(0, MAX_JUDGE_TOPICS).map((name) => ({ name, examples: (state.examples.get(name) ?? []).slice(0, 2) }));
      const raw = await within(this.o.judge({ question: text.trim(), topics }), this.o.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS);
      return raw === null ? null : parseJudgement(raw, topics.map((t) => t.name));
    } catch {
      return null; // placement must never fail a send — the strand goes where it always went
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
