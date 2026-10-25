import { describe, expect, it } from 'vitest';
import type { MessageNode } from '@chatmind/core';
import type { Entry } from '../src/plan';
import { USER_WAIT_MS, prepareCanvas, summaryOf } from '../src/topic-phase';

const T0 = Date.parse('2026-09-21T10:00:00Z');
const iso = (offsetS: number): string => new Date(T0 + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const node = (id: string, over: Partial<MessageNode>): Entry => ({ node: { id, role: 'user', parents: [], created: iso(0), summary: '', topics: [], body: `${id} body`, ...over }, canvas: 'm', path: `m/nodes/${id}.md` });
const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe('prepareCanvas (spec M6 §4 user nodes, §6)', () => {
  it('seeds the state from assigned nodes and lists candidates in created order with their parent ids', () => {
    const entries = [
      node('P', { topics: ['Alpha'], summary: 'P sum', created: iso(0) }),
      node('B', { parents: ['A'], created: iso(20) }),
      node('A', { role: 'assistant', parents: ['P'], created: iso(10) }),
    ];
    const centred = new Map([['P', v(1, 0)], ['A', v(1, 0)], ['B', v(0, 1)]]);
    // B is a user node without a reply: with `now` past USER_WAIT_MS it is judged alone, not deferred.
    const { state, candidates, deferred } = prepareCanvas(entries, centred, new Set(['A', 'B']), 2, T0 + USER_WAIT_MS + 60_000);
    expect(state.centroids.topics()).toEqual(['Alpha']);
    expect(state.topicOf.get('P')).toBe('Alpha');
    expect(state.examples.get('Alpha')).toEqual(['P sum']);
    expect(candidates.map((c) => [c.id, c.parentId])).toEqual([['A', 'P'], ['B', 'A']]);
    expect(deferred).toEqual([]);
  });
  it('a user node is judged with its oldest assistant reply (mean vector); without one it is deferred while young', () => {
    const entries = [
      node('U', { created: iso(0) }),
      node('R2', { role: 'assistant', parents: ['U'], created: iso(5) }),
      node('R1', { role: 'assistant', parents: ['U'], created: iso(2) }),
      node('Y', { created: iso(50) }),
      node('O', { created: iso(0) }),
    ];
    const centred = new Map([['U', v(1, 0)], ['R1', v(0, 1)], ['R2', v(5, 5)], ['Y', v(1, 1)], ['O', v(1, 1)]]);
    const now = T0 + USER_WAIT_MS + 1000; // U and O are old, Y (created 50 s in) is young
    const { candidates, deferred } = prepareCanvas(entries, centred, new Set(['U', 'R1', 'R2', 'Y', 'O']), 2, now);
    expect(Array.from(candidates.find((c) => c.id === 'U')!.vec)).toEqual([0.5, 0.5]); // mean of U and R1, not R2
    expect(candidates.find((c) => c.id === 'U')!.replyId).toBe('R1'); // the namer sees the same reply's summary
    expect(candidates.find((c) => c.id === 'O')!.replyId).toBeUndefined();
    expect(deferred).toEqual(['Y']);
    expect(candidates.some((c) => c.id === 'Y')).toBe(false);
    expect(Array.from(candidates.find((c) => c.id === 'O')!.vec)).toEqual([1, 1]); // old, alone
  });
  it('a young note is judged alone at once — it never gets a reply to wait for (spec M16 §5)', () => {
    const entries = [node('N', { role: 'note', created: iso(0) })];
    const { candidates, deferred } = prepareCanvas(entries, new Map([['N', v(1, 0)]]), new Set(['N']), 2, T0 + 1000);
    expect(candidates.map((c) => c.id)).toEqual(['N']);
    expect(deferred).toEqual([]);
  });
  it('a user node whose reply has no vector yet is deferred, not judged alone', () => {
    const entries = [node('U', { created: iso(0) }), node('R', { role: 'assistant', parents: ['U'], created: iso(1) })];
    const centred = new Map([['U', v(1, 0)]]);
    const { candidates, deferred } = prepareCanvas(entries, centred, new Set(['U']), 2, T0 + 1000);
    expect(candidates).toEqual([]);
    expect(deferred).toEqual(['U']);
  });
  it('state.add updates topicOf, centroids and examples (max 3)', () => {
    const { state } = prepareCanvas([], new Map(), new Set(), 2, T0);
    for (const i of [1, 2, 3, 4]) state.add(`n${i}`, 'T', v(1, 0), `s${i}`);
    expect(state.examples.get('T')).toEqual(['s1', 's2', 's3']);
    expect(state.topicOf.get('n4')).toBe('T');
    expect(Array.from(state.centroids.all().get('T')!)).toEqual([1, 0]);
  });
  it('summaryOf prefers the summary, else the body start', () => {
    expect(summaryOf(node('X', { summary: 'S' }).node)).toBe('S');
    expect(summaryOf(node('X', { body: 'Body  text\nmore' }).node)).toBe('Body text more');
  });
});
