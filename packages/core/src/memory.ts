import { dump, JSON_SCHEMA, load } from 'js-yaml';
import { normalizeBody } from './frontmatter';
import { slug } from './ids';
import { topicKey } from './topic-key';
import type { NodeId, TopicMemory } from './types';

/** Spec M15 §1: memories live in this folder of a canvas; the reader does not scan it for nodes. */
export const MEMORIES_DIR = 'memories';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

export type MemoryParse = { ok: true; topic: string; covered: NodeId[]; body: string } | { ok: false; reason: string };

/** Spec M15 §1: `topic` is required; a missing `covered` is an empty list (a hand-written memory). */
export function parseMemoryFile(rawText: string): MemoryParse {
  const text = rawText.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { ok: false, reason: 'no frontmatter block' };
  let data: unknown;
  try {
    data = load(match[1] ?? '', { schema: JSON_SCHEMA });
  } catch (err) {
    return { ok: false, reason: `invalid YAML: ${(err as Error).message}` };
  }
  const fm = (typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  if (typeof fm.topic !== 'string' || fm.topic.trim() === '') return { ok: false, reason: 'missing topic' };
  const covered = Array.isArray(fm.covered) ? fm.covered.map(String) : [];
  return { ok: true, topic: fm.topic.trim(), covered, body: normalizeBody(text.slice(match[0].length)) };
}

export function serializeMemoryFile(m: Pick<TopicMemory, 'topic' | 'covered' | 'body'>): string {
  const header = `---\n${dump({ topic: m.topic, covered: m.covered }, { schema: JSON_SCHEMA, flowLevel: 1, lineWidth: -1, noRefs: true })}---\n`;
  const body = normalizeBody(m.body);
  return body === '' ? header : `${header}\n${body}\n`;
}

/** Spec M15 §1: where a new memory of `topic` goes — `memories/<slug>.md`, `-2`, `-3`… past names in `taken`. */
export function memoryPath(canvas: string, topic: string, taken: ReadonlySet<string>): string {
  const base = slug(topic) || 'topic';
  for (let i = 1; ; i++) {
    const p = `${canvas}/${MEMORIES_DIR}/${i === 1 ? base : `${base}-${i}`}.md`;
    if (!taken.has(p)) return p;
  }
}

/** Spec M15 §1: the memory of `topic` (compared by topicKey), if any. */
export function memoryOf<M extends { topic: string }>(memories: readonly M[] | undefined, topic: string): M | undefined {
  const key = topicKey(topic);
  return memories?.find((m) => topicKey(m.topic) === key);
}

/**
 * Spec M15 §3: after a compress, each new user node joins `covered` when every old user node it replaces was in it —
 * the compressed turns are not distilled a second time. `oldUsers` are the replaced user nodes. Pure.
 */
export function carryCovered(covered: readonly NodeId[], replacement: Readonly<Record<NodeId, NodeId>>, oldUsers: ReadonlySet<NodeId>): NodeId[] {
  const had = new Set(covered);
  const byNew = new Map<NodeId, NodeId[]>();
  for (const old of oldUsers) { const n = replacement[old]; if (n !== undefined) byNew.set(n, [...(byNew.get(n) ?? []), old]); }
  const added = [...byNew].filter(([n, olds]) => !had.has(n) && olds.every((o) => had.has(o))).map(([n]) => n);
  return added.length === 0 ? [...covered] : [...covered, ...added];
}
