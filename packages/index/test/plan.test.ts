import { describe, expect, it } from 'vitest';
import type { MessageNode } from '@chatmind/core';
import { contentHash } from '../src/hash';
import type { NodeRow } from '../src/db';
import { planJobs, planTopicJobs, rowsForPlan, type Entry } from '../src/plan';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
function entry(over: Partial<MessageNode> & { id: string }, file?: string): Entry {
  const node: MessageNode = { role: 'user', parents: [], created: 'c', summary: '', topics: [], body: 'Ein Body.\nZwei Zeilen.', ...over };
  return { node, canvas: 'masterarbeit', path: `masterarbeit/nodes/${file ?? `${node.id}.md`}` };
}
function row(e: Entry, over: Partial<NodeRow> = {}): [string, NodeRow] {
  return [e.node.id, { id: e.node.id, canvas: e.canvas, content_hash: contentHash(e.node.body), summary_written: null, summary_for_hash: null, embedded_hash: null, topic_written: null, ...over }];
}

describe('planJobs (spec M5 §5)', () => {
  it('a new node needs an embedding and a summary, no rename yet', () => {
    const e = entry({ id: A });
    expect(planJobs([e], new Map([row(e)]))).toEqual({ embed: [A], summarize: [{ id: A, expected: '' }], rename: [] });
  });

  it('an up-to-date node needs nothing', () => {
    const e = entry({ id: A, summary: 'Titel' }, `${A}-titel.md`);
    const h = contentHash(e.node.body);
    expect(planJobs([e], new Map([row(e, { summary_written: 'Titel', summary_for_hash: h, embedded_hash: h })]))).toEqual({ embed: [], summarize: [], rename: [] });
  });

  it('a body change re-embeds and re-summarizes only when the summary is ours', () => {
    const ours = entry({ id: A, summary: 'Titel' }, `${A}-titel.md`);
    const theirs = entry({ id: 'B', summary: 'Mein eigener Titel' }, 'B-mein-eigener-titel.md');
    const rows = new Map([
      row(ours, { summary_written: 'Titel', summary_for_hash: 'old', embedded_hash: 'old' }),
      row(theirs, { summary_written: 'Titel', summary_for_hash: 'old', embedded_hash: 'old' }),
    ]);
    expect(planJobs([ours, theirs], rows)).toEqual({ embed: [A, 'B'], summarize: [{ id: A, expected: 'Titel' }], rename: [] });
  });

  it('after a rebuild an existing summary is final (summary_written null, body unchanged)', () => {
    const e = entry({ id: A, summary: 'Titel' }, `${A}-titel.md`);
    expect(planJobs([e], new Map([row(e)]))).toEqual({ embed: [A], summarize: [], rename: [] });
  });

  it('a user-provided summary on a bare-ULID file is a rename job without a summary job', () => {
    const e = entry({ id: A, summary: 'Von Hand' });
    const h = contentHash(e.node.body);
    expect(planJobs([e], new Map([row(e, { embedded_hash: h })]))).toEqual({ embed: [], summarize: [], rename: [A] });
  });

  it('F4: a non-empty summary whose slug() is "" (e.g. "???") on a bare-ULID file plans no rename', () => {
    const e = entry({ id: A, summary: '???' });
    const h = contentHash(e.node.body);
    expect(planJobs([e], new Map([row(e, { embedded_hash: h })]))).toEqual({ embed: [], summarize: [], rename: [] });
  });

  it('an empty body gets no jobs', () => {
    const e = entry({ id: A, body: '' });
    expect(planJobs([e], new Map([row(e)]))).toEqual({ embed: [], summarize: [], rename: [] });
  });

  it('a node without a row (not yet synced) is skipped', () => {
    expect(planJobs([entry({ id: A })], new Map())).toEqual({ embed: [], summarize: [], rename: [] });
  });
});

describe('rowsForPlan', () => {
  it('refreshes content_hash and synthesises missing rows without touching the input', () => {
    const e = entry({ id: A });
    const stale = new Map([row(e, { content_hash: 'old', embedded_hash: 'old' })]);
    const out = rowsForPlan([e, entry({ id: 'B' })], stale);
    expect(out.get(A)).toMatchObject({ content_hash: contentHash(e.node.body), embedded_hash: 'old' });
    expect(out.get('B')).toEqual({ id: 'B', canvas: 'masterarbeit', content_hash: contentHash('Ein Body.\nZwei Zeilen.'), summary_written: null, summary_for_hash: null, embedded_hash: null, topic_written: null });
    expect(stale.get(A)!.content_hash).toBe('old');
    expect(planJobs([e], out)).toEqual({ embed: [A], summarize: [{ id: A, expected: '' }], rename: [] });
  });
});

describe('planTopicJobs (spec M6 §6)', () => {
  const entry = (id: string, over: Partial<MessageNode> = {}): Entry => ({ node: { id, role: 'user', parents: [], created: '2026-01-01T00:00:00Z', summary: '', topics: [], body: 'text', ...over }, canvas: 'm', path: `m/nodes/${id}.md` });
  const row = (id: string, embedded: boolean): NodeRow => ({ id, canvas: 'm', content_hash: contentHash('text'), summary_written: null, summary_for_hash: null, embedded_hash: embedded ? contentHash('text') : null, topic_written: null });
  it('plans nodes with empty topics, a body and a current embedding — nothing else', () => {
    const entries = [entry('A'), entry('B', { topics: ['Set'] }), entry('C', { body: '' }), entry('D')];
    const rows = new Map([['A', row('A', true)], ['B', row('B', true)], ['C', row('C', true)], ['D', row('D', false)]]);
    expect(planTopicJobs(entries, rows)).toEqual(['A']);
  });
});
