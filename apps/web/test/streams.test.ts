import type { CanvasDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { applyStreams, streamsReducer, type StreamState } from '../src/streams';

describe('streamsReducer', () => {
  it('starts, appends, errors and removes without mutating the previous map', () => {
    const s0 = new Map<string, StreamState>();
    const s1 = streamsReducer(s0, { type: 'start', id: 'a', model: 'm' });
    const s2 = streamsReducer(s1, { type: 'delta', id: 'a', text: 'He' });
    const s3 = streamsReducer(s2, { type: 'delta', id: 'a', text: 'y' });
    expect(s3.get('a')).toEqual({ model: 'm', text: 'Hey', status: 'streaming' });
    expect(s2.get('a')?.text).toBe('He');
    expect(s0.size).toBe(0);
    expect(streamsReducer(s3, { type: 'error', id: 'a', message: 'boom' }).get('a')).toEqual({ model: 'm', text: 'Hey', status: 'error', error: 'boom' });
    expect(streamsReducer(s3, { type: 'done', id: 'a' }).has('a')).toBe(false);
    expect(streamsReducer(s3, { type: 'delta', id: 'zzz', text: 'x' })).toBe(s3);
  });
});

describe('applyStreams', () => {
  const dto: CanvasDto = { slug: 'm', nodes: [{ id: 'a', role: 'assistant', model: 'm', parents: [], created: 'c', summary: '', topics: [], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } }], edges: [], repairs: [] };
  it('replaces bodies of streaming nodes and leaves others untouched', () => {
    const out = applyStreams(dto, new Map([['a', { model: 'm', text: 'live', status: 'streaming' }]]));
    expect(out.nodes[0]!.body).toBe('live');
    expect(applyStreams(dto, new Map())).toBe(dto);
  });
});
