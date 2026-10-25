import { monotonicFactory, ulid } from 'ulid';

const nextUlid = monotonicFactory();

/** Time-sortable ULID; monotonic within the process so same-millisecond ids still sort by creation. */
export function newId(now: number = Date.now()): string {
  return nextUlid(now);
}

/** A ULID carrying the timestamp `ms` (not monotonic): new cards that stand in for older ones sort where those did. */
export function idAt(ms: number): string {
  return ulid(ms);
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(v: unknown): v is string {
  return typeof v === 'string' && ULID_RE.test(v);
}

/** ISO-8601 UTC without milliseconds, e.g. 2026-03-14T10:42:03Z */
export function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const SLUG_MAX = 48;

const TRANSLIT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

export function slug(text: string): string {
  const dashed = text
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => TRANSLIT[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (dashed.length <= SLUG_MAX) return dashed;
  const cut = dashed.slice(0, SLUG_MAX);
  if (dashed[SLUG_MAX] === '-') return cut;
  const lastDash = cut.lastIndexOf('-');
  return lastDash > 0 ? cut.slice(0, lastDash) : cut;
}

/** True iff `s` is exactly what `slug()` would produce from itself: a valid canvas folder name. */
export function isCanvasSlug(s: string): boolean {
  return s.length > 0 && s === slug(s);
}

export function nodeFileName(id: string, summary: string): string {
  const s = slug(summary);
  return s === '' ? `${id}.md` : `${id}-${s}.md`;
}
