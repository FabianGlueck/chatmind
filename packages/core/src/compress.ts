import { decodeTime } from 'ulid';
import { attachmentEmbed, attachmentsIn } from './attachments';
import { turnOf } from './delete';
import type { GraphLike, NodeLike } from './graph-like';
import type { Layout, MessageNode, NodeId } from './types';

/** A question and the answer that continues it, in that order. */
export type Turn = [user: NodeId, assistant: NodeId];

/** Spec M11 §11: a section needs at least this many turns (or folds) to be worth compressing. */
export const MIN_COMPRESS_TURNS = 2;

function referrers(graph: GraphLike): Map<NodeId, NodeId[]> {
  const refs = new Map<NodeId, NodeId[]>();
  for (const n of [...graph.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) for (const p of new Set(n.parents)) refs.set(p, [...(refs.get(p) ?? []), n.id]);
  return refs;
}

/**
 * Spec M11 §9/§11: a unit of compression — consecutive turns (each question's only parent is the previous answer),
 * plus (when folding) the short dead-end side branches that hang off its last answer and are folded into its last
 * group. Other side branches may hang off any of its answers; they are rewired to the replacement.
 */
export interface Section { turns: Turn[]; folds: Turn[][] }

/** Spec M11 §9: a side branch of at most this many turns that nothing continues is folded when asked to. */
export const FOLD_MAX_TURNS = 2;

/** Spec M11 §9: the turn of `id` and its primary descendants (by `parents[0]`) — "everything below". */
export function subtreeIds(graph: GraphLike, id: NodeId): NodeId[] {
  const kids = new Map<NodeId, NodeId[]>();
  for (const n of [...graph.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const p = n.parents[0];
    if (p !== undefined) kids.set(p, [...(kids.get(p) ?? []), n.id]);
  }
  const order: NodeId[] = [];
  const seen = new Set<NodeId>();
  const queue = turnOf(graph, id);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur) || !graph.nodes.has(cur)) continue;
    seen.add(cur);
    order.push(cur);
    queue.push(...(kids.get(cur) ?? []));
  }
  return order;
}

/**
 * Spec M11 §11: the turns among `ids`, keyed by question. A question counts with the answer among `ids` (else its
 * first answer); an answer counts with its question. Questions without an answer and answers without a question
 * (root or hand-edited) are not compressible and are left out.
 */
function turnsAmong(graph: GraphLike, refs: Map<NodeId, NodeId[]>, ids: Iterable<NodeId>): Map<NodeId, Turn> {
  const chosen = new Set(ids);
  const turns = new Map<NodeId, Turn>();
  for (const id of chosen) {
    const n = graph.nodes.get(id);
    if (!n) continue;
    const u = n.role === 'user' ? n : graph.nodes.get(n.parents[0] ?? '');
    if (u?.role !== 'user' || (n.role === 'assistant' && n.parents.length !== 1)) continue;
    const answers = (refs.get(u.id) ?? []).filter((c) => { const a = graph.nodes.get(c); return a?.role === 'assistant' && a.parents.length === 1; });
    const a = n.role === 'assistant' ? n.id : (answers.find((c) => chosen.has(c)) ?? answers[0]);
    if (a === undefined) continue;
    if (!turns.has(u.id) || chosen.has(a)) turns.set(u.id, [u.id, a]);
  }
  return turns;
}

/**
 * Spec M11 §9/§11: what compressing `ids` rewrites — the chosen turns chained into sections: a turn continues the one
 * whose answer is its question's only parent, unless that answer is continued by several chosen turns (a fork
 * starts new sections). Sections come in time order of their first question. With `fold`, short dead-end sections
 * that hang off another section's last answer become its folds — at every fork one branch stays (the longest, newest
 * on a tie). Only sections with ≥ MIN_COMPRESS_TURNS turns or with folds are returned.
 */
export function compressionSections(graph: GraphLike, ids: Iterable<NodeId>, fold = false): Section[] {
  const refs = referrers(graph);
  const turns = turnsAmong(graph, refs, ids);
  const byAnswer = new Map([...turns.values()].map((t) => [t[1], t]));
  const next = new Map<Turn, Turn[]>();
  const prev = new Map<Turn, Turn>();
  for (const t of turns.values()) {
    const ps = graph.nodes.get(t[0])!.parents;
    const p = ps.length === 1 ? byAnswer.get(ps[0]!) : undefined;
    if (p) { next.set(p, [...(next.get(p) ?? []), t]); prev.set(t, p); }
  }
  const linked = (t: Turn) => { const p = prev.get(t); return p !== undefined && next.get(p)!.length === 1 ? p : undefined; };
  const sections: Section[] = [];
  const seen = new Set<Turn>();
  for (const head of [...turns.values()].filter((t) => linked(t) === undefined).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const chain: Turn[] = [];
    for (let t: Turn | undefined = head; t && !seen.has(t); ) {
      seen.add(t);
      chain.push(t);
      const n: Turn[] = next.get(t) ?? [];
      t = n.length === 1 ? n[0] : undefined;
    }
    sections.push({ turns: chain, folds: [] });
  }
  const worth = (s: Section) => s.turns.length >= MIN_COMPRESS_TURNS || s.folds.length > 0;
  if (!fold) return sections.filter(worth);
  const byLast = new Map(sections.map((s) => [s.turns[s.turns.length - 1]![1], s]));
  const folded = new Set<Section>();
  const candidates = new Map<NodeId, Section[]>(); // fork answer → dead-end sections under it
  for (const s of sections) {
    const p = graph.nodes.get(s.turns[0]![0])!.parents;
    const last = s.turns[s.turns.length - 1]![1];
    if (s.turns.length > FOLD_MAX_TURNS || (refs.get(last) ?? []).length > 0 || p.length !== 1 || !byLast.has(p[0]!) || byLast.get(p[0]!) === s) continue;
    candidates.set(p[0]!, [...(candidates.get(p[0]!) ?? []), s]);
  }
  for (const [fork, dead] of candidates) {
    const keep = dead.length === (refs.get(fork) ?? []).length ? dead.reduce((k, s) => (s.turns.length >= k.turns.length ? s : k)) : null;
    for (const s of dead) if (s !== keep) { byLast.get(fork)!.folds.push(s.turns); folded.add(s); }
  }
  return sections.filter((s) => !folded.has(s) && worth(s));
}

/** Spec M11 §2: at most half as many turns, at least one. */
export function maxCompressedTurns(n: number): number {
  return Math.max(1, Math.floor(n / 2));
}

export const COMPRESS_SYSTEM = `You compress parts of a branching conversation between a user and an AI assistant into fewer turns, for an overview.
The input has one or more numbered sections; each is a stretch of consecutive numbered turns (side branches of the conversation that stay as they are are not shown). A section may continue after another section, which is noted — do not repeat there what the earlier section already established.
Within a section, group consecutive turns that belong to the same line of thought. For each group write one question that captures what the user was after and one answer that states what the covered answers established: keep facts, results, decisions, code and caveats; drop repetition, detours and dead ends.
A section may list side branches after its last turn: short explorations that were not continued. Work their substance into the answer of the group that covers the last turn (briefly, e.g. as a closing remark), not into a group of their own.
Write in the language of the conversation. Answers may use Markdown.
Reply with JSON only, no prose and no code fence:
{"sections":[{"section":1,"turns":[{"covers":[from,to],"question":"…","answer":"…"}]}]}
Return every section, in order. "covers" gives the first and last original turn number of the group within its section (inclusive). The groups of a section must cover its turns 1 to N in order, without gaps or overlaps.`;

function turnText(graph: GraphLike, [u, a]: Turn): string {
  return `**User:**\n${graph.nodes.get(u)?.body ?? ''}\n\n**Assistant:**\n${graph.nodes.get(a)?.body ?? ''}`;
}

/** Spec M11 §4/§9: the prompt — sections with their limit, how they connect, turns and side branches. */
export function compressPrompt(graph: GraphLike, sections: readonly Section[]): string {
  const endOf = new Map(sections.map((s, i) => [s.turns[s.turns.length - 1]![1], i + 1]));
  return sections
    .map((s, i) => {
      const from = endOf.get(graph.nodes.get(s.turns[0]![0])?.parents[0] ?? '');
      const head = `## Section ${i + 1} (N = ${s.turns.length}, return at most ${maxCompressedTurns(s.turns.length)} turns)${from !== undefined ? ` — continues after section ${from}` : ''}`;
      const turns = s.turns.map((t, j) => `### Turn ${j + 1}\n\n${turnText(graph, t)}`);
      const folds = s.folds.map((f, j) => `### Side branch ${j + 1} after turn ${s.turns.length}\n\n${f.map((t) => turnText(graph, t)).join('\n\n')}`);
      return [head, ...turns, ...folds].join('\n\n');
    })
    .join('\n\n');
}

export interface CompressedTurn { covers: [number, number]; question: string; answer: string }

/** Spec M11 §4: validate one section's groups against its `n` turns; throws with the reason. */
function checkTurns(turns: unknown, n: number, fail: (why: string) => never): CompressedTurn[] {
  if (!Array.isArray(turns) || turns.length === 0) return fail('no turns');
  if (turns.length > maxCompressedTurns(n)) return fail(`${turns.length} turns for ${n} (at most ${maxCompressedTurns(n)})`);
  let next = 1;
  const out: CompressedTurn[] = [];
  for (const t of turns as { covers?: unknown; question?: unknown; answer?: unknown }[]) {
    const c = t?.covers;
    if (!Array.isArray(c) || c.length !== 2 || !c.every((x) => Number.isInteger(x))) return fail('covers must be [from, to]');
    const [from, to] = c as [number, number];
    if (from !== next || to < from || to > n) return fail(`turn ${out.length + 1} covers ${from}–${to}, expected to start at ${next}`);
    if (typeof t.question !== 'string' || t.question.trim() === '' || typeof t.answer !== 'string' || t.answer.trim() === '') return fail('empty question or answer');
    out.push({ covers: [from, to], question: t.question.trim(), answer: t.answer.trim() });
    next = to + 1;
  }
  if (next !== n + 1) return fail(`turns ${next}–${n} are not covered`);
  return out;
}

/** Spec M11 §4/§9: parse and validate the model's reply for sections of `sizes[i]` turns; throws with the reason. */
export function parseCompression(text: string, sizes: readonly number[]): CompressedTurn[][] {
  const fail = (why: string): never => { throw new Error(`the model returned an invalid compression: ${why}`); };
  const raw = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail('not JSON');
  }
  const sections = (data as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections) || sections.length !== sizes.length) return fail(`expected ${sizes.length} section${sizes.length === 1 ? '' : 's'}`);
  return sections.map((s: { section?: unknown; turns?: unknown }, i) => {
    if (s?.section !== i + 1) return fail(`section ${i + 1} is missing or out of order`);
    return checkTurns(s.turns, sizes[i]!, (why) => fail(`section ${i + 1}: ${why}`));
  });
}

export interface CompressionPlan {
  added: MessageNode[];
  layout: Map<NodeId, Layout>;
  /** New `parents` of the surviving nodes that named a replaced node. */
  reparent: Map<NodeId, NodeId[]>;
  /** Spec M11 §10: new positions of surviving nodes pulled up into the space the compression freed. */
  moved: Map<NodeId, Layout>;
  removed: NodeId[];
  /** Old id → the new id that covers it (a folded branch → the answer it was folded into). */
  replacement: Record<NodeId, NodeId>;
}

function majorityTopic(nodes: readonly MessageNode[]): string[] {
  const counts = new Map<string, number>();
  for (const n of nodes) { const t = n.topics[0]; if (t !== undefined && t !== '') counts.set(t, (counts.get(t) ?? 0) + 1); }
  let best: string | undefined;
  for (const [t, c] of counts) if (best === undefined || c > counts.get(best)!) best = t;
  return best === undefined ? [] : [best];
}

/**
 * Spec M11 §2/§5/§9/§10: the new nodes and the rewiring for a validated compression. Pure; `idAt(ms)` makes a ULID
 * with that timestamp, so each new card sorts where its first covered card did. Every surviving reference to a
 * replaced node is redirected to its replacement. Whatever hangs off a replaced card — below a section or as a side
 * branch — rises by as much as that card's replacement sits higher, cumulatively; for all at once, or not at all if
 * anything would then overlap.
 */
export function planCompression(graph: GraphLike<MessageNode>, sections: readonly Section[], compressed: readonly CompressedTurn[][], model: string, idAt: (ms: number) => NodeId): CompressionPlan {
  const node = (id: NodeId) => graph.nodes.get(id)!;
  const added: MessageNode[] = [];
  const layout = new Map<NodeId, Layout>();
  const replacement: Record<NodeId, NodeId> = {};
  const removed: NodeId[] = [];
  const origParent = new Map<NodeId, NodeId>(); // a section's first new question → its old question's primary parent
  sections.forEach((section, i) => {
    const oldSeq = section.turns.flat();
    const mine: MessageNode[] = [];
    let prev: NodeId[] = [...node(section.turns[0]![0]).parents];
    const firstParent = prev[0];
    for (const t of compressed[i]!) {
      const covered = section.turns.slice(t.covers[0] - 1, t.covers[1]);
      const [u0, a0] = covered[0]!;
      const isLast = t.covers[1] === section.turns.length;
      const coveredNodes = [...covered.flat(), ...(isLast ? section.folds.flat(2) : [])].map(node);
      const topics = majorityTopic(coveredNodes);
      // Spec M13: images the model's rewrite dropped are appended to the new question, in order.
      const kept = new Set(attachmentsIn(`${t.question}\n${t.answer}`));
      const lost = [...new Set(coveredNodes.flatMap((n) => attachmentsIn(n.body)))].filter((a) => !kept.has(a));
      const question = lost.length === 0 ? t.question : `${t.question}\n\n${lost.map(attachmentEmbed).join('\n')}`;
      const u: MessageNode = { id: idAt(decodeTime(u0)), role: 'user', parents: prev, created: node(u0).created, summary: '', topics, body: question };
      const a: MessageNode = { id: idAt(decodeTime(a0)), role: 'assistant', model, parents: [u.id], created: node(a0).created, summary: '', topics, body: t.answer };
      for (const [ou, oa] of covered) { replacement[ou] = u.id; replacement[oa] = a.id; }
      if (isLast) for (const f of section.folds.flat(2)) replacement[f] = a.id;
      mine.push(u, a);
      prev = [a.id];
    }
    mine.forEach((n, k) => { const l = graph.layout.get(oldSeq[k]!); if (l) layout.set(n.id, { ...l }); });
    if (firstParent !== undefined) origParent.set(mine[0]!.id, firstParent);
    added.push(...mine);
    removed.push(...oldSeq, ...section.folds.flat(2));
  });
  const gone = new Set(removed);
  const remap = (parents: NodeId[]) => [...new Set(parents.map((p) => replacement[p] ?? p))];
  for (const n of added) n.parents = remap(n.parents);
  const reparent = new Map<NodeId, NodeId[]>();
  for (const n of graph.nodes.values()) if (!gone.has(n.id) && n.parents.some((p) => gone.has(p))) reparent.set(n.id, remap(n.parents));

  // Spec M11 §10: pull up. A card whose primary parent was replaced rises by how much higher the replacement's bottom
  // edge sits than the old parent's; on top comes whatever its new parent rises itself.
  const final = new Map<NodeId, { parents: NodeId[]; layout: Layout | undefined }>();
  for (const n of graph.nodes.values()) if (!gone.has(n.id)) final.set(n.id, { parents: reparent.get(n.id) ?? n.parents, layout: graph.layout.get(n.id) });
  for (const n of added) final.set(n.id, { parents: n.parents, layout: layout.get(n.id) });
  const addedIds = new Set(added.map((n) => n.id));
  const shift = new Map<NodeId, number>();
  const shiftOf = (id: NodeId, seen: Set<NodeId>): number => {
    const hit = shift.get(id);
    if (hit !== undefined) return hit;
    const p = final.get(id)?.parents[0];
    if (p === undefined || !final.has(p) || seen.has(id)) return 0;
    seen.add(id);
    const old = addedIds.has(id) ? origParent.get(id) : graph.nodes.get(id)?.parents[0];
    const was = old !== undefined && gone.has(old) ? graph.layout.get(old) : undefined;
    const now = old !== undefined ? layout.get(replacement[old] ?? '') : undefined;
    const s = shiftOf(p, seen) + (was && now ? was.y + was.height - (now.y + now.height) : 0);
    shift.set(id, s);
    return s;
  };
  const shifted = new Map<NodeId, Layout>();
  for (const [id, f] of final) { const d = shiftOf(id, new Set()); if (f.layout) shifted.set(id, d === 0 ? f.layout : { ...f.layout, y: f.layout.y - d }); }
  const rects = [...shifted.values()];
  const overlaps = rects.some((r, i) => rects.some((o, j) => j > i && r.x < o.x + o.width && o.x < r.x + r.width && r.y < o.y + o.height && o.y < r.y + r.height));
  const moved = new Map<NodeId, Layout>();
  if (!overlaps) {
    for (const n of added) { const l = shifted.get(n.id); if (l) layout.set(n.id, l); }
    for (const [id, l] of shifted) if (!addedIds.has(id) && l !== graph.layout.get(id)) moved.set(id, l);
  }
  return { added, layout, reparent, moved, removed, replacement };
}
