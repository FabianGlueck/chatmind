import { topicKey } from '@chatmind/core';
import { writtenBy } from './summary';
import type { TopicInput } from './types';

export { topicKey };

/** Spec M6 §4: no centring below this many stored vectors — the mean of a handful is noise. */
export const MIN_CENTER = 8;
/** Spec M6 §4 rule 3: the parent's topic wins while it trails the best by at most this much (calibrated 2026-09-21, default). */
export const INHERIT_MARGIN = 0.05;
/** Spec M6 §4 rule 3: …and is at least this similar; below, the strand has left its topic (default). */
export const T_INHERIT = 0.15;
/** Spec M6 §4 rule 4: assign without the LLM only above this similarity (default). */
export const T_ASSIGN = 0.35;
/** Spec M6 §4 rule 4: …and with this much daylight to the runner-up; closer is a tie for the LLM (default). */
export const ASSIGN_MARGIN = 0.1;
const MAX_CANDIDATES = 3;

/** Spec M6 §4: the four knobs of the assignment, so a vault can be tuned without a rebuild (see topic-settings.ts). */
export interface Thresholds {
  tInherit: number;
  inheritMargin: number;
  tAssign: number;
  assignMargin: number;
}

export function meanVector(vecs: Iterable<Float32Array>, dim: number): Float32Array | null {
  const sum = new Float32Array(dim);
  let n = 0;
  for (const v of vecs) { for (let i = 0; i < dim; i++) sum[i]! += v[i]!; n++; }
  if (n === 0) return null;
  for (let i = 0; i < dim; i++) sum[i]! /= n;
  return sum;
}

/** Spec M6 §4: `v − μ` over every stored vector once there are MIN_CENTER of them; copies otherwise. Never mutates the input. */
export function centre(vectors: ReadonlyMap<string, Float32Array>, dim: number): Map<string, Float32Array> {
  const mu = vectors.size >= MIN_CENTER ? meanVector(vectors.values(), dim) : null;
  const out = new Map<string, Float32Array>();
  for (const [id, v] of vectors) {
    const c = Float32Array.from(v);
    if (mu) for (let i = 0; i < dim; i++) c[i]! -= mu[i]!;
    out.set(id, c);
  }
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Spec M6 §4: running mean per topic, updated as the run assigns nodes so later nodes see earlier decisions. */
export class TopicCentroids {
  private readonly sums = new Map<string, { sum: Float32Array; n: number }>();
  constructor(private readonly dim: number) {}
  add(topic: string, vec: Float32Array): void {
    let s = this.sums.get(topic);
    if (!s) { s = { sum: new Float32Array(this.dim), n: 0 }; this.sums.set(topic, s); }
    for (let i = 0; i < this.dim; i++) s.sum[i]! += vec[i]!;
    s.n++;
  }
  has(topic: string): boolean { return this.sums.has(topic); }
  topics(): string[] { return [...this.sums.keys()]; }
  all(): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    for (const [t, { sum, n }] of this.sums) out.set(t, sum.map((x) => x / n));
    return out;
  }
}

export interface Sim { topic: string; sim: number }
export type Decision = { kind: 'assign'; topic: string; sims: Sim[] } | { kind: 'ask'; candidates: string[]; sims: Sim[] };

/** Spec M6 §4 rules 1–5. `sims` is sorted best first and returned for the dry run. */
export function assignTopic(vec: Float32Array, centroids: TopicCentroids, parentTopic: string | undefined, t: Thresholds = { tInherit: T_INHERIT, inheritMargin: INHERIT_MARGIN, tAssign: T_ASSIGN, assignMargin: ASSIGN_MARGIN }): Decision {
  const sims: Sim[] = [...centroids.all()].map(([topic, c]) => ({ topic, sim: cosine(vec, c) })).sort((a, b) => b.sim - a.sim);
  if (sims.length === 0) return { kind: 'ask', candidates: [], sims };
  const best = sims[0]!;
  const second = sims[1]?.sim ?? -Infinity;
  const parent = parentTopic === undefined ? undefined : sims.find((s) => s.topic === parentTopic);
  if (parent && parent.sim >= best.sim - t.inheritMargin && parent.sim >= t.tInherit) return { kind: 'assign', topic: parent.topic, sims };
  if (best.sim >= t.tAssign && best.sim - second >= t.assignMargin) return { kind: 'assign', topic: best.topic, sims };
  const candidates = sims.slice(0, MAX_CANDIDATES).map((s) => s.topic);
  if (parent && !candidates.includes(parent.topic)) candidates.push(parent.topic);
  return { kind: 'ask', candidates, sims };
}

/** Spec M6 §4: a topic name is a label, not a sentence. */
export const TOPIC_MAX = 40;

/** Fixed and language-neutral so provider caches can hit; the case travels in the user message (spec M6 §5). */
/**
 * Spec M6 §5, amended 2026-09-25: the old "prefer a candidate" wording filed a pasted Kaggle tutorial under
 * "Pandas Befehle" in 8 of 10 calls (similarity 0.18) — a candidate now has to be the same subject, not the same field.
 */
export const TOPIC_SYSTEM =
  'You file one message from a branching conversation under a topic. A topic is one specific subject — as narrow as a chapter heading, not a whole field. ' +
  'File the message under a candidate topic only if it is about that same subject; sharing a tool, a field or a keyword is not enough (a question about training a model in PyTorch does not belong under "NumPy basics" just because both are Python and machine learning). Otherwise name a new topic. ' +
  'Reply with exactly the topic name and nothing else — no quotes, no explanation, no punctuation at the end. ' +
  'A topic name has one to four words in the language of the message, names a subject (a noun phrase), and is neither a question nor a sentence.';

/** The user message for the namer (spec M6 §5). Pure. */
export function topicPrompt(input: TopicInput): string {
  const lines = [writtenBy(input.role)];
  // Spec M6 §5 (amended 2026-09-25): what the embeddings and the structure know, which the names alone do not show.
  if (input.startsStrand === true && input.candidates.length > 0) lines.push('This message opens a new strand of its own — the user started it separately, not as a reply.');
  if (input.distant === true && input.candidates.length > 0) lines.push('By content similarity, no candidate topic is close to this message.');
  if (input.candidates.length > 0) {
    lines.push('', 'Candidate topics (with example summaries of messages already filed there):');
    for (const c of input.candidates) lines.push(`- ${c.name}${c.examples.length > 0 ? `: ${c.examples.join(' | ')}` : ''}`);
  } else {
    lines.push('', 'This is the first message of the canvas: name its topic.');
  }
  if (input.allTopics.length > 0) lines.push(`All topics of this canvas: ${input.allTopics.join(', ')}`);
  if (input.parentTopic !== undefined) lines.push(`Topic of the message it replies to: ${input.parentTopic}`);
  lines.push('', 'Message summary:', input.summary);
  return lines.join('\n');
}

// ASCII quotes/backtick plus the curly/typographic pairs and guillemets, as in summary.ts.
const QUOTES = /^[\s"'`“”„‘’‚«»]+|[\s"'`“”„‘’‚«»]+$/g;

/** Spec M6 §4: first line, whitespace collapsed, quotes and trailing periods stripped, ≤ TOPIC_MAX on a word boundary. */
export function cleanTopic(raw: string): string {
  let s = (raw.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim().replace(QUOTES, '').replace(/\.+$/, '').replace(QUOTES, '');
  if (s.length > TOPIC_MAX) {
    // One char past the limit so a word that ends exactly at TOPIC_MAX is kept.
    const cut = s.slice(0, TOPIC_MAX + 1);
    const space = cut.lastIndexOf(' ');
    s = (space > 0 ? cut.slice(0, space) : cut.slice(0, TOPIC_MAX)).trim();
  }
  return s;
}


/** Spec M6 §4: a near-duplicate of an existing topic folds into the existing spelling. */
export function foldTopic(name: string, existing: Iterable<string>): string {
  const key = topicKey(name);
  for (const e of existing) if (topicKey(e) === key) return e;
  return name;
}
