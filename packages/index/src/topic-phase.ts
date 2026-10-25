import { detectLanguage, type MessageNode, type VaultLock } from '@chatmind/core';
import type { IndexDb } from './db';
import { hasGivenUp, MAX_FAILURES, recordFailure, type NodeFailure } from './failures';
import { contentHash } from './hash';
import type { Entry } from './plan';
import { parentContextOf } from './summary';
import { assignTopic, centre, cleanTopic, foldTopic, meanVector, T_ASSIGN, TopicCentroids, type Thresholds } from './topics';
import type { TopicNamer } from './types';
import { writeTopic } from './writeback';

/** Spec M6 §4: a user node without an embedded assistant reply waits this long (by `created`) before being judged alone. */
export const USER_WAIT_MS = 120_000;
const MAX_EXAMPLES = 3;

/** `replyId`: the assistant reply whose vector went into `vec` (user nodes only); the namer sees its summary too. */
export interface Candidate { id: string; vec: Float32Array; parentId: string | undefined; replyId?: string }

/** Spec M6 §6: the canvas's topics as the run sees them, updated after every assignment. */
export interface CanvasTopicState {
  centroids: TopicCentroids;
  topicOf: Map<string, string>;
  examples: Map<string, string[]>;
  add(id: string, topic: string, vec: Float32Array, summary: string): void;
}

/** The summary, else the start of the body — what the namer sees of a node. */
export function summaryOf(node: MessageNode): string {
  return parentContextOf(node);
}

function newState(dim: number): CanvasTopicState {
  const state: CanvasTopicState = {
    centroids: new TopicCentroids(dim),
    topicOf: new Map(),
    examples: new Map(),
    add(id, topic, vec, summary) {
      state.topicOf.set(id, topic);
      state.centroids.add(topic, vec);
      const ex = state.examples.get(topic) ?? [];
      if (ex.length < MAX_EXAMPLES && summary !== '') ex.push(summary);
      state.examples.set(topic, ex);
    },
  };
  return state;
}

/**
 * Spec M6 §4/§6: seed the state from nodes that already have a topic (in `created` order, so examples are the
 * earliest), then list the candidates in `created` order. A user candidate is paired with its oldest assistant
 * child that has a vector (mean of both); without one it is deferred while younger than USER_WAIT_MS.
 */
export function prepareCanvas(entries: readonly Entry[], centred: ReadonlyMap<string, Float32Array>, jobIds: ReadonlySet<string>, dim: number, now: number): { state: CanvasTopicState; candidates: Candidate[]; deferred: string[] } {
  const state = newState(dim);
  const sorted = [...entries].sort((a, b) => (a.node.created < b.node.created ? -1 : a.node.created > b.node.created ? 1 : a.node.id < b.node.id ? -1 : 1));
  for (const { node } of sorted) {
    const topic = node.topics[0];
    if (topic === undefined || topic === '') continue;
    const vec = centred.get(node.id);
    if (vec) state.centroids.add(topic, vec);
    state.topicOf.set(node.id, topic);
    const ex = state.examples.get(topic) ?? [];
    const s = summaryOf(node);
    if (ex.length < MAX_EXAMPLES && s !== '') ex.push(s);
    state.examples.set(topic, ex);
  }
  const candidates: Candidate[] = [];
  const deferred: string[] = [];
  for (const { node } of sorted) {
    if (!jobIds.has(node.id)) continue;
    const own = centred.get(node.id);
    if (!own) continue;
    if (node.role === 'user') {
      const reply = sorted.find((e) => e.node.role === 'assistant' && e.node.parents[0] === node.id && centred.has(e.node.id));
      if (reply) { candidates.push({ id: node.id, vec: meanVector([own, centred.get(reply.node.id)!], dim)!, parentId: node.parents[0], replyId: reply.node.id }); continue; }
      if (now - Date.parse(node.created) < USER_WAIT_MS) { deferred.push(node.id); continue; }
    }
    candidates.push({ id: node.id, vec: own, parentId: node.parents[0] });
  }
  return { state, candidates, deferred };
}

export interface TopicPhaseDeps {
  dataDir: string;
  db: IndexDb;
  namer: TopicNamer;
  lock: VaultLock;
  dim: number;
  now: () => number;
  /** Spec M6 §4: assignment thresholds; omitted means the calibrated defaults. */
  thresholds?: Thresholds;
  log: (msg: string) => void;
  failures?: Map<string, NodeFailure>;
}

export interface TopicPhaseReport { assigned: number; asked: number; deferred: number; failed: number; gaveUp: number; pending: number }

/**
 * Spec M6 §6: per canvas, serially — centre every stored vector once, seed the topic state from the frontmatter,
 * walk the candidates in created order: assign by similarity, or ask the namer; write; feed the state.
 */
export async function runTopicPhase(entries: readonly Entry[], jobIds: readonly string[], deps: TopicPhaseDeps): Promise<TopicPhaseReport> {
  const report: TopicPhaseReport = { assigned: 0, asked: 0, deferred: 0, failed: 0, gaveUp: 0, pending: 0 };
  if (jobIds.length === 0) return report;
  const centred = centre(deps.db.allVectors(), deps.dim);
  const byId = new Map(entries.map((e) => [e.node.id, e]));
  const jobs = new Set(jobIds);
  const canvases = [...new Set(entries.map((e) => e.canvas))].sort();
  for (const canvas of canvases) {
    const own = entries.filter((e) => e.canvas === canvas);
    const { state, candidates, deferred } = prepareCanvas(own, centred, jobs, deps.dim, deps.now());
    report.deferred += deferred.length;
    report.pending += deferred.length;
    for (const c of candidates) {
      const { node } = byId.get(c.id)!;
      const forHash = contentHash(node.body);
      if (hasGivenUp(deps.failures, c.id, forHash)) { report.gaveUp += 1; continue; }
      const parentTopic = c.parentId === undefined ? undefined : state.topicOf.get(c.parentId);
      try {
        const decision = assignTopic(c.vec, state.centroids, parentTopic, deps.thresholds);
        let topic: string;
        if (decision.kind === 'assign') {
          topic = decision.topic;
        } else {
          report.asked += 1;
          const reply = c.replyId === undefined ? undefined : byId.get(c.replyId);
          const summary = reply ? `${summaryOf(node)} — ${summaryOf(reply.node)}` : summaryOf(node);
          // Spec M6 §4: the topic set is every `topics[0]` of the canvas — including hand-set topics whose nodes have no vector.
          const allTopics = [...new Set([...state.topicOf.values(), ...state.centroids.topics()])];
          const input = {
            summary,
            role: node.role,
            lang: detectLanguage([node.body]),
            candidates: decision.candidates.map((name) => ({ name, examples: state.examples.get(name) ?? [] })),
            allTopics,
            ...(parentTopic === undefined ? {} : { parentTopic }),
            startsStrand: node.parents.length === 0,
            distant: (decision.sims[0]?.sim ?? -Infinity) < (deps.thresholds?.tAssign ?? T_ASSIGN),
          };
          const raw = await deps.namer(input);
          topic = foldTopic(cleanTopic(raw), allTopics);
          // Quote the model's own words: "empty topic name" alone leaves no way to tell a blank answer from a
          // stripped one (e.g. quotes and a full stop), and the retry is paid for either way.
          if (topic === '') throw new Error(`the model returned nothing usable as a topic name (${JSON.stringify(raw.slice(0, 60))})`);
        }
        const res = await writeTopic({ id: c.id, canvas, forHash, topic }, deps);
        if (res.skipped !== null) {
          deps.log(`topic for ${c.id} dropped: ${res.skipped}`);
          if (res.skipped === 'body-changed') report.pending += 1; // re-planned once the new body is embedded
          continue;
        }
        deps.db.setTopic(c.id, topic);
        // No clearFailure here: a written topic is never re-planned, and clearing would reset a summary failure counted earlier this run.
        state.add(c.id, topic, c.vec, summaryOf(node));
        report.assigned += 1;
      } catch (err) {
        recordFailure(deps.failures, c.id, forHash);
        report.failed += 1;
        if (hasGivenUp(deps.failures, c.id, forHash)) {
          report.gaveUp += 1;
          deps.log(`giving up on ${c.id} after ${MAX_FAILURES} failures until its body changes`);
          continue;
        }
        report.pending += 1;
        deps.log(`topic failed for ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // The ask rate is otherwise invisible at runtime (spec M6 §6) — log it once, only when the phase did anything.
  if (report.assigned + report.asked + report.deferred > 0) {
    deps.log(`topics: ${report.assigned} assigned, ${report.asked} asked, ${report.deferred} deferred`);
  }
  return report;
}
