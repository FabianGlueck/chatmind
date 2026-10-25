import type { CanvasDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { MAP_FADE_START, MAP_ZOOM, labelFontSize, mapOpacity, topicRegions, visibleLabels } from '../src/topic-map';

const W = 400;
const H = 200;
const n = (id: string, x: number, y: number, topics: string[] = ['A']) => ({ id, role: 'user' as const, parents: [], created: '2026-01-01', summary: '', topics, body: '', layout: { x, y, width: W, height: H } });
const dto = (nodes: ReturnType<typeof n>[]): CanvasDto => ({ slug: 'm', nodes, edges: [], repairs: [] });
const palette = new Map([['A', 0], ['B', 1]]);

describe('topicRegions (spec M10 §2)', () => {
  it('joins cards one layout gap apart, also diagonally', () => {
    const r = topicRegions(dto([n('a', 0, 0), n('b', 0, 280), n('c', 480, 560)]), palette);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ topic: 'A', index: 0, ids: ['a', 'b', 'c'] });
    expect(r[0]!.rects).toHaveLength(3);
  });

  it('splits a topic spread over the canvas into several regions, larger first', () => {
    const r = topicRegions(dto([n('a', 0, 0), n('far', 3000, 0), n('b', 0, 280)]), palette);
    expect(r.map((x) => x.ids)).toEqual([['a', 'b'], ['far']]);
  });

  it('keeps topics apart and skips nodes without a topic', () => {
    const r = topicRegions(dto([n('a', 0, 0, ['A']), n('b', 0, 280, ['B']), n('x', 480, 0, [])]), palette);
    expect(r.map((x) => [x.topic, x.index, x.ids])).toEqual([['A', 0, ['a']], ['B', 1, ['b']]]);
  });

  it('anchors the label on the card nearest to the region centre', () => {
    // an L: the mean of the card centres (488, 492) lies in empty space; the label sits on card d
    const r = topicRegions(dto([n('a', 0, 0), n('b', 0, 280), n('c', 0, 560), n('d', 480, 560), n('e', 960, 560)]), palette);
    expect(r[0]!.label).toEqual({ x: 480 + W / 2, y: 560 + H / 2 });
  });
});

describe('mapOpacity', () => {
  it('fades linearly between MAP_FADE_START and MAP_ZOOM', () => {
    expect(mapOpacity(1)).toBe(0);
    expect(mapOpacity(MAP_FADE_START)).toBe(0);
    expect(mapOpacity((MAP_FADE_START + MAP_ZOOM) / 2)).toBeCloseTo(0.5);
    expect(mapOpacity(MAP_ZOOM)).toBe(1);
    expect(mapOpacity(0.05)).toBe(1);
  });
});

describe('visibleLabels', () => {
  it('grows the font with the region size, capped', () => {
    expect(labelFontSize(1)).toBe(14);
    expect(labelFontSize(16)).toBeGreaterThan(labelFontSize(4));
    expect(labelFontSize(100000)).toBe(26);
  });

  it('hides a label that would overlap a larger region label on screen', () => {
    const regions = topicRegions(dto([n('a', 0, 0, ['A']), n('a2', 0, 280, ['A']), n('b', 520, 0, ['B'])]), palette);
    // zoomed far out the two labels land on top of each other; the larger region (A) wins
    expect(visibleLabels(regions, 0.05).map((l) => l.region.topic)).toEqual(['A']);
    expect(visibleLabels(regions, 0.3).map((l) => l.region.topic)).toEqual(['A', 'B']);
  });
});
