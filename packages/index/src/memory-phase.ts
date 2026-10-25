import { detectLanguage, memoryOf, readCanvas, readVault, topicKey, writeMemory, type CanvasGraph, type NodeId, type TopicMemory, type VaultLock } from '@chatmind/core';
import { hasGivenUp, MAX_FAILURES, recordFailure, clearFailure, type NodeFailure } from './failures';
import type { MemoryWriter } from './types';

/** Spec M15 §2: each side of a turn is cut to this many characters in the writer's prompt. */
export const MEMORY_TURN_CHARS = 3000;
/** Spec M15 §2: at most this many bullets are appended per call. */
export const MAX_BULLETS = 8;
/** Spec M15 §2: at most this many due turns (oldest first) per call; the rest stays due for the next run. */
export const MAX_TURNS_PER_CALL = 12;

/**
 * Spec M15 §2, amended 2026-09-25: fixed and English (provider prompt caches); the bullets follow the conversation's
 * language. The first wording ("leave out general knowledge") made the model answer NONE for a topic of plain
 * how-does-X-work questions in 3 of 10 calls; the findings the user asked for are what later turns build on.
 */
export const MEMORY_SYSTEM =
  'You keep the memory of one topic of a branching conversation: short notes that later conversations on this topic receive as background, so they can build on what was already worked out. ' +
  'From the new turns, note what the user will want to build on later: facts about the user, their project and setup; decisions and preferences; constraints; and the conclusions and concrete findings the conversation arrived at (the specific answer to what the user asked — e.g. which option fits their case, what a number or setting turned out to be). ' +
  'Leave out the course of the conversation, generic background the user did not ask about, and anything the current memory already says. ' +
  `Write one short bullet per item, each line starting with "- ", in the language of the conversation, at most ${MAX_BULLETS} bullets. Reply exactly NONE only if the turns contain nothing of this kind at all.`;

export interface MemoryTurn { id: NodeId; question: string; answer: string }
export interface MemoryInput { topic: string; lang: 'de' | 'en'; memory: string; turns: { question: string; answer: string }[] }

const cut = (s: string): string => (s.length > MEMORY_TURN_CHARS ? `${s.slice(0, MEMORY_TURN_CHARS)}…` : s);

/** Spec M15 §2: the writer's user message. Pure. */
export function memoryPrompt(input: MemoryInput): string {
  const turns = input.turns.map((t, i) => `### Turn ${i + 1}\nUser: ${cut(t.question)}\n\nAssistant: ${cut(t.answer)}`);
  return [`Topic: ${input.topic}`, '', 'Current memory:', input.memory.trim() === '' ? '(empty)' : input.memory.trim(), '', 'New turns:', ...turns].join('\n');
}

const BULLET = /^(?:[-*•–]|\d+[.)])\s+(?=\S)/;

/** Spec M15 §2: the bullet (or numbered) lines of the writer's answer, normalised to "- ", at most MAX_BULLETS. */
export function parseMemoryBullets(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => BULLET.test(l)).map((l) => `- ${l.replace(BULLET, '')}`).slice(0, MAX_BULLETS);
}

/** Spec M15 §2: the writer's explicit "nothing to note" — the only answer without bullets that covers the turns. */
export const isNone = (text: string): boolean => /^\W*none\W*$/i.test(text.trim());

/**
 * Spec M15 §2: per topic (by topicKey), the turns not yet in its memory's `covered` — a user node with a topic and
 * an assistant child with a body (the first by id) — in `created` order.
 */
export function dueTurns(graph: CanvasGraph): Map<string, { topic: string; memory: TopicMemory | undefined; turns: MemoryTurn[] }> {
  const out = new Map<string, { topic: string; memory: TopicMemory | undefined; turns: MemoryTurn[] }>();
  const nodes = [...graph.nodes.values()].sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1));
  for (const q of nodes) {
    const topic = q.topics[0];
    if (q.role !== 'user' || topic === undefined || topic === '') continue;
    const a = nodes.filter((n) => n.role === 'assistant' && n.parents[0] === q.id && n.body !== '').sort((x, y) => (x.id < y.id ? -1 : 1))[0];
    if (!a) continue;
    const key = topicKey(topic);
    let group = out.get(key);
    if (!group) { group = { topic, memory: memoryOf(graph.memories, topic), turns: [] }; out.set(key, group); }
    if (group.memory?.covered.includes(q.id)) continue;
    group.turns.push({ id: q.id, question: q.body, answer: a.body });
  }
  for (const [key, g] of out) if (g.turns.length === 0) out.delete(key);
  return out;
}

/** Spec M15 §2: topics that still have due turns, over every canvas — what `status` and the retry timer count. */
export function countDueMemories(canvases: readonly CanvasGraph[]): number {
  return canvases.reduce((sum, g) => sum + dueTurns(g).size, 0);
}

export interface MemoryPhaseDeps {
  dataDir: string;
  lock: VaultLock;
  writer: MemoryWriter;
  log: (msg: string) => void;
  failures?: Map<string, NodeFailure>;
}

export interface MemoryPhaseReport { updated: number; failed: number; gaveUp: number; pending: number }

/**
 * Spec M15 §2: one writer call per topic with due turns; the bullets are appended under the lock to the memory as it
 * is then, and the turns join `covered` (also with no bullets — a turn is judged once).
 */
export async function runMemoryPhase(deps: MemoryPhaseDeps): Promise<MemoryPhaseReport> {
  const report: MemoryPhaseReport = { updated: 0, failed: 0, gaveUp: 0, pending: 0 };
  const { canvases } = await readVault(deps.dataDir);
  for (const g of canvases) {
    for (const [key, due] of dueTurns(g)) {
      const turns = due.turns.slice(0, MAX_TURNS_PER_CALL);
      const failKey = `memory:${g.slug}:${key}`;
      const forHash = turns.map((t) => t.id).join(',');
      if (hasGivenUp(deps.failures, failKey, forHash)) { report.gaveUp += 1; continue; }
      try {
        const lang = detectLanguage(turns.flatMap((t) => [t.question, t.answer]));
        const answer = await deps.writer({ topic: due.topic, lang, memory: due.memory?.body ?? '', turns });
        const bullets = parseMemoryBullets(answer);
        // Neither bullets nor an explicit NONE: an answer we cannot read must not mark the turns as done.
        if (bullets.length === 0 && !isNone(answer)) throw new Error(`the model's answer has no bullets (${JSON.stringify(answer.slice(0, 60))})`);
        await deps.lock.run(async () => {
          const graph = (await readCanvas(deps.dataDir, g.slug))?.graph;
          if (!graph) return;
          const cur = memoryOf(graph.memories, due.topic);
          const body = [cur?.body ?? '', bullets.join('\n')].filter((p) => p.trim() !== '').join('\n\n');
          const covered = [...new Set([...(cur?.covered ?? []), ...turns.map((t) => t.id)])];
          await writeMemory(graph, { topic: cur?.topic ?? due.topic, covered, body, ...(cur ? { path: cur.path } : {}) }, deps.dataDir);
        });
        clearFailure(deps.failures, failKey);
        report.updated += 1;
        if (due.turns.length > turns.length) report.pending += 1; // the rest follows next run
      } catch (err) {
        recordFailure(deps.failures, failKey, forHash);
        report.failed += 1;
        if (hasGivenUp(deps.failures, failKey, forHash)) {
          report.gaveUp += 1;
          deps.log(`giving up on the memory of "${due.topic}" (${g.slug}) after ${MAX_FAILURES} failures until new turns arrive`);
          continue;
        }
        report.pending += 1;
        deps.log(`memory failed for "${due.topic}" (${g.slug}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (report.updated > 0) deps.log(`memories: ${report.updated} updated`);
  return report;
}
