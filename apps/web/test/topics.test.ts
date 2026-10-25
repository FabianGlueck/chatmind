import type { CanvasDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { TOPIC_COLOURS, nodesOfTopic, topicList, topicPalette } from '../src/topics';

const n = (id: string, created: string, topics: string[]) => ({ id, role: 'user' as const, parents: [], created, summary: '', topics, body: '', layout: { x: 0, y: 0, width: 400, height: 200 } });
const dto = (nodes: ReturnType<typeof n>[]): CanvasDto => ({ slug: 'm', nodes, edges: [], repairs: [] });

describe('topics (spec M6 §7)', () => {
  it('palette indexes topics by first appearance (earliest created), cycling after TOPIC_COLOURS', () => {
    const d = dto([n('b', '2026-01-02', ['Beta']), n('a', '2026-01-01', ['Alpha']), n('c', '2026-01-03', ['Alpha']), n('x', '2026-01-04', [])]);
    expect([...topicPalette(d)]).toEqual([['Alpha', 0], ['Beta', 1]]);
    const many = dto(Array.from({ length: TOPIC_COLOURS + 1 }, (_, i) => n(`n${i}`, `2026-01-${String(i + 1).padStart(2, '0')}`, [`T${i}`])));
    expect(topicPalette(many).get(`T${TOPIC_COLOURS}`)).toBe(0);
  });
  it('topicList counts nodes per topic in palette order; nodesOfTopic lists ids', () => {
    const d = dto([n('b', '2026-01-02', ['Beta']), n('a', '2026-01-01', ['Alpha']), n('c', '2026-01-03', ['Alpha'])]);
    expect(topicList(d)).toEqual([{ name: 'Alpha', index: 0, count: 2 }, { name: 'Beta', index: 1, count: 1 }]);
    expect(nodesOfTopic(d, 'Alpha')).toEqual(['a', 'c']);
  });
});
