import type { GraphLike, NodeLike } from './graph-like';
import { detectLanguage, type Language } from './language';
import { nodeTitle } from './title';
import type { NodeId, Role } from './types';

export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Fixed and free of ids/timestamps so provider prompt caches can hit (spec §6). */
export const SYSTEM_PROMPT =
  'You are chatting inside chatmind, a canvas where conversations branch. Answer the latest message in the context of the thread above it. Be direct.';

/** Root → `id` along the primary parent. Unknown parents end the chain; cycles are cut. */
export function ancestorChain<N extends NodeLike>(graph: GraphLike<N>, id: NodeId): N[] {
  const chain: N[] = [];
  const seen = new Set<NodeId>();
  let cur: NodeId | undefined = id;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const n = graph.nodes.get(cur);
    if (!n) break;
    chain.push(n);
    cur = n.parents[0];
  }
  return chain.reverse();
}

export interface ContextSegment<N extends NodeLike = NodeLike> {
  target: N;
  nodes: N[]; // the target's chain below the common prefix, root-side first; ends with the target
}

export interface ContextSet<N extends NodeLike = NodeLike> {
  prefix: N[]; // root → LCA, once; the whole chain for a single target; empty without a common root
  segments: ContextSegment<N>[]; // one per known target, in target order
  all: Set<NodeId>; // every node that enters the prompt before exclusions — the highlight set
  excluded: Set<NodeId>; // excluded ∩ all
}

/**
 * Spec M4 §4.2. Chains per target, longest positionally identical run from the root as the shared prefix,
 * the rest of each chain as its segment. Unknown targets are skipped (validation is validateTargets' job).
 */
export function contextSet<N extends NodeLike>(graph: GraphLike<N>, targets: readonly NodeId[], excluded: readonly NodeId[]): ContextSet<N> {
  const chains = targets.filter((t) => graph.nodes.has(t)).map((t) => ancestorChain(graph, t));
  let common = 0;
  const first = chains[0];
  if (first) {
    while (common < first.length && chains.every((c) => c[common]?.id === first[common]!.id)) common++;
  }
  const prefix = first ? first.slice(0, common) : [];
  const segments = chains.map((c) => ({ target: c[c.length - 1]!, nodes: c.slice(common) }));
  const all = new Set<NodeId>([...prefix, ...segments.flatMap((s) => s.nodes)].map((n) => n.id));
  return { prefix, segments, all, excluded: new Set(excluded.filter((id) => all.has(id))) };
}

export const PREAMBLE: Record<Language, string> = {
  de: 'Die folgenden Abschnitte stammen aus verschiedenen Zweigen desselben Gesprächs. Sie wurden unabhängig voneinander erkundet und sind keine aufeinanderfolgenden Nachrichten. Nutze sie gemeinsam als Grundlage für die Aufgabe darunter und ziehe aus jedem heran, was dafür relevant ist. Du kannst die Abschnitte über ihre Überschriften referenzieren.',
  en: 'The following sections come from different branches of the same conversation. They were explored independently and are not consecutive messages. Use them together as the basis for the task below, drawing on whatever is relevant from each. You can refer to the sections by their headings.',
};

export const ROLE_LABELS: Record<Language, Record<Role, string>> = {
  de: { user: 'Nutzer', assistant: 'Assistent', note: 'Notiz' },
  en: { user: 'User', assistant: 'Assistant', note: 'Note' },
};

/** Spec M16 §4: what heads a note when it enters the prompt as a user message. */
export const NOTE_HEADER: Record<Language, string> = {
  de: 'Notiz, die der Nutzer auf den Canvas gelegt hat (keine Nachricht an dich):',
  en: 'A note the user placed on the canvas (not a message to you):',
};

/** Spec M16 §4: a node as a prompt turn — a note becomes a user message under its header. */
function asMessage(n: NodeLike, lang: Language): ContextMessage {
  return n.role === 'note' ? { role: 'user', content: `${NOTE_HEADER[lang]}\n\n${n.body}` } : { role: n.role, content: n.body };
}

const FALLBACK_LABEL: Record<Language, string> = { de: 'Zweig', en: 'Branch' };

/** Spec M4 §4.4 labels: summary → body title → "Zweig n"/"Branch n"; newlines flattened; duplicates suffixed. */
export function blockLabels(targets: readonly NodeLike[], lang: Language): string[] {
  const seen = new Map<string, number>();
  return targets.map((t, i) => {
    const raw = t.summary !== '' ? t.summary : t.body.trim() !== '' ? nodeTitle(t) : `${FALLBACK_LABEL[lang]} ${i + 1}`;
    const base = raw.replace(/\s*\n+\s*/g, ' ').trim();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** Spec M15 §4: a topic memory as it enters the system prompt. */
export interface ContextMemory { topic: string; body: string }

/** Spec M15 §4: the system prompt with every non-empty memory appended. */
export function systemWithMemories(memories: readonly ContextMemory[] = []): string {
  const blocks = memories.filter((m) => m.body.trim() !== '').map((m) => `Memory of the topic "${m.topic}" — facts and decisions from earlier conversations on this canvas; rely on them where relevant:\n${m.body.trim()}`);
  return [SYSTEM_PROMPT, ...blocks].join('\n\n');
}

export interface BuiltContext {
  system: string;
  messages: ContextMessage[];
  language: Language;
}

/**
 * Spec M4 §4.4. Prefix as turns; the last user turn is the instruction alone for ≤1 target, or
 * preamble + labelled blocks + instruction for ≥2. The preamble lives in the user turn on purpose: the
 * merge message is replayed from the ancestor chain on later turns and carries its own framing.
 */
export function buildContext(graph: GraphLike, targets: readonly NodeId[], excluded: readonly NodeId[], instruction: string, memories: readonly ContextMemory[] = []): BuiltContext {
  const system = systemWithMemories(memories);
  const set = contextSet(graph, targets, excluded);
  const keep = (n: NodeLike): boolean => !set.excluded.has(n.id);
  const prefix = set.prefix.filter(keep);
  // contextSet's prefix is only what *all* targets share; with 3+ targets a node can be a shared
  // ancestor of some (but not all) of them and so surface in more than one segment — drop repeats
  // here so every node of the set still renders exactly once, in its first segment.
  const rendered = new Set(prefix.map((n) => n.id));
  const segments = set.segments.map((s) => ({
    target: s.target,
    nodes: s.nodes.filter(keep).filter((n) => (rendered.has(n.id) ? false : (rendered.add(n.id), true))),
  }));
  const language = detectLanguage([instruction, ...prefix.map((n) => n.body), ...segments.flatMap((s) => s.nodes.map((n) => n.body))]);
  const messages: ContextMessage[] = prefix.map((n) => asMessage(n, language));
  if (segments.length < 2) {
    messages.push({ role: 'user', content: instruction });
    return { system, messages, language };
  }
  const labels = blockLabels(segments.map((s) => s.target), language);
  const blocks = segments.map((s, i) => {
    const turns = s.nodes.map((n) => `**${ROLE_LABELS[language][n.role]}:** ${n.body}`);
    return `## ${labels[i]}\n${turns.join('\n\n')}`;
  });
  messages.push({ role: 'user', content: [PREAMBLE[language], ...blocks, instruction].join('\n\n') });
  return { system, messages, language };
}

/** True when `ancestorId` lies strictly above `id` on `id`'s primary-parent chain. */
export function isAncestor(graph: GraphLike, ancestorId: NodeId, id: NodeId): boolean {
  if (ancestorId === id) return false;
  return ancestorChain(graph, id).some((n) => n.id === ancestorId);
}

/**
 * Spec M7 §4: `id`, every ancestor over all parents (merges included) and every descendant — the nodes a
 * semantic link to `id` would tell nothing new about. Siblings stay out. An unknown id yields just itself.
 */
export function structuralNeighbours(graph: GraphLike, id: NodeId): Set<NodeId> {
  const children = new Map<NodeId, NodeId[]>();
  for (const n of graph.nodes.values()) for (const p of n.parents) children.set(p, [...(children.get(p) ?? []), n.id]);
  const out = new Set<NodeId>([id]);
  const walk = (start: NodeId, next: (id: NodeId) => readonly NodeId[]): void => {
    const seen = new Set<NodeId>([start]);
    const stack = [...next(start)];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur) || !graph.nodes.has(cur)) continue;
      seen.add(cur);
      out.add(cur);
      stack.push(...next(cur));
    }
  };
  walk(id, (n) => graph.nodes.get(n)?.parents ?? []);
  walk(id, (n) => children.get(n) ?? []);
  return out;
}

/** Spec M4 §4.3 — the rules the server enforces (400) and the selection UI respects. */
export function validateTargets(graph: GraphLike, targets: readonly NodeId[], excluded: readonly NodeId[]): string | null {
  if (new Set(targets).size !== targets.length) return 'duplicate target';
  for (const t of targets) if (!graph.nodes.has(t)) return `unknown node ${t}`;
  for (const t of targets) {
    for (const o of targets) if (o !== t && isAncestor(graph, o, t)) return `target ${o} is an ancestor of target ${t}`;
  }
  const targetSet = new Set(targets);
  const { all } = contextSet(graph, targets, []);
  for (const e of excluded) {
    if (targetSet.has(e)) return `excluded node ${e} is a target`;
    if (!all.has(e)) return `excluded node ${e} is not in the context`;
  }
  return null;
}
