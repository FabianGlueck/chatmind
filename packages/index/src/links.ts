import { structuralNeighbours, type CanvasGraph } from '@chatmind/core';
import { centre } from './topics';

/** Spec M7 §4: at most this many links per node; mutuality usually leaves fewer (default, 2026-09-23 — calibrate at the gate). */
export const LINK_K = 5;
/**
 * Spec M7 §4: minimum hub-corrected score for a link (default). On the user's vault (2026-09-24) the pairs
 * worth a link scored 0.32–0.87 and the generic ones ("everything here is about Hugging Face") 0.25 and below.
 */
export const T_LINK = 0.3;

export interface LinkSettings {
  k: number;
  tMin: number;
}

/** Spec M7 §4: the participants' vectors, centred on the whole vault and normalised, so a similarity is a dot product. */
export interface LinkSpace {
  vecs: Map<string, Float32Array>;
  /** Canvas per participant; pairs from different canvases skip the hub correction. Absent: all one canvas. */
  group?: ReadonlyMap<string, string>;
}

export interface Link {
  id: string;
  /** Centred cosine. */
  sim: number;
  /** Hub-corrected: `2·sim − r(q) − r(id)`; what `tMin` applies to and what links are sorted by. */
  score: number;
}

interface Near {
  id: string;
  sim: number;
}

/** `vectors` is every stored vector (the centring mean); `participants` the assistant nodes that may link. */
export function linkSpace(vectors: ReadonlyMap<string, Float32Array>, participants: Iterable<string>, dim: number): LinkSpace {
  const centred = centre(vectors, dim);
  const vecs = new Map<string, Float32Array>();
  for (const id of participants) {
    const c = centred.get(id);
    if (!c || vecs.has(id)) continue;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += c[i]! * c[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i++) c[i]! /= norm;
    vecs.set(id, c);
  }
  return { vecs };
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Highest similarity first; ties by id so the result is deterministic. */
const bySim = (a: Near, b: Near): number => b.sim - a.sim || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byScore = (a: Link, b: Link): number => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The `k` participants nearest to `x`, skipping `excluded(x)` before ranking so structure takes no place. */
function knn(x: string, space: LinkSpace, excluded: ReadonlySet<string>, k: number): Near[] {
  const vx = space.vecs.get(x);
  if (!vx) return [];
  const top: Near[] = [];
  for (const [id, v] of space.vecs) {
    if (id === x || excluded.has(id)) continue;
    const l = { id, sim: dot(vx, v) };
    if (top.length < k) {
      top.push(l);
      top.sort(bySim);
    } else if (bySim(l, top[k - 1]!) < 0) {
      top[k - 1] = l;
      top.sort(bySim);
    }
  }
  return top;
}

/** Spec M7 §4: a node's hubness — the mean similarity to its `k` nearest. High for a node that resembles everything. */
const hubness = (near: readonly Near[]): number => (near.length === 0 ? 0 : near.reduce((t, n) => t + n.sim, 0) / near.length);

/**
 * Spec M7 §4 (amended 2026-09-24): hub-corrected within a canvas, where the shared theme is old news; the raw
 * similarity across canvases, where that shared theme is exactly what a link should point out.
 */
function score(space: LinkSpace, a: string, b: string, sim: number, ra: number, rb: number): number {
  return space.group !== undefined && space.group.get(a) !== space.group.get(b) ? sim : 2 * sim - ra - rb;
}

/**
 * Spec M7 §4 (amended 2026-09-24): `y` links to `q` when each is among the other's `k` nearest (structural
 * neighbours excluded first) and their score reaches `tMin`: within a canvas hub-corrected, `2·sim − r(q) − r(y)`
 * (across canvases the raw sim, see `score`), where r is a
 * node's mean similarity to its own `k` nearest (CSLS). A node that resembles everything in a homogeneous canvas
 * has a high r, so its links count less. Costs `(k + 1) · N` dot products; r comes from lists computed anyway.
 */
export function mutualLinks(q: string, space: LinkSpace, excluded: (id: string) => ReadonlySet<string>, s: LinkSettings): Link[] {
  const nearQ = knn(q, space, excluded(q), s.k);
  const rq = hubness(nearQ);
  const out: Link[] = [];
  for (const n of nearQ) {
    const nearY = knn(n.id, space, excluded(n.id), s.k);
    if (!nearY.some((m) => m.id === q)) continue;
    const sc = score(space, q, n.id, n.sim, rq, hubness(nearY));
    if (sc >= s.tMin) out.push({ id: n.id, sim: n.sim, score: sc });
  }
  return out.sort(byScore);
}

/** Spec M7 §5 (dry run): every mutual pair once, `a < b`, highest score first. O(N²) — for the CLI, not the request path. */
export function allLinks(space: LinkSpace, excluded: (id: string) => ReadonlySet<string>, s: LinkSettings): { a: string; b: string; sim: number; score: number }[] {
  const near = new Map<string, Near[]>();
  for (const id of space.vecs.keys()) near.set(id, knn(id, space, excluded(id), s.k));
  const r = new Map([...near].map(([id, ns]) => [id, hubness(ns)]));
  const out: { a: string; b: string; sim: number; score: number }[] = [];
  for (const [a, ns] of near) {
    for (const n of ns) {
      if (a >= n.id || !near.get(n.id)!.some((m) => m.id === a)) continue;
      const sc = score(space, a, n.id, n.sim, r.get(a)!, r.get(n.id)!);
      if (sc >= s.tMin) out.push({ a, b: n.id, sim: n.sim, score: sc });
    }
  }
  return out.sort((x, y) => y.score - x.score || (x.a < y.a ? -1 : 1));
}

/** Spec M7 §4 on a vault: the assistant participants (and notes, spec M16 §5), which canvas owns each, and their structural exclusion (memoised). */
export interface VaultLinks {
  space: LinkSpace;
  owner: Map<string, CanvasGraph>;
  excluded: (id: string) => ReadonlySet<string>;
}

/** Restricts the cached all-vectors space to the vault's assistant and note nodes; the vectors are shared, not copied. */
export function vaultLinks(canvases: readonly CanvasGraph[], all: LinkSpace): VaultLinks {
  const owner = new Map<string, CanvasGraph>();
  const vecs = new Map<string, Float32Array>();
  for (const g of canvases) {
    for (const n of g.nodes.values()) {
      const v = all.vecs.get(n.id);
      if ((n.role !== 'assistant' && n.role !== 'note') || !v) continue;
      owner.set(n.id, g);
      vecs.set(n.id, v);
    }
  }
  const memo = new Map<string, Set<string>>();
  const excluded = (id: string): ReadonlySet<string> => {
    let s = memo.get(id);
    if (!s) memo.set(id, (s = owner.has(id) ? structuralNeighbours(owner.get(id)!, id) : new Set([id])));
    return s;
  };
  return { space: { vecs, group: new Map([...owner].map(([id, g]) => [id, g.slug])) }, owner, excluded };
}
