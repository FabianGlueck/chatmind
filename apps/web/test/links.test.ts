import type { LinksDto } from '@chatmind/core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINKS_DEBOUNCE_MS, locationFor, readLocation, useLinks } from '../src/links';

const dto = (from: string): LinksDto => ({ from, links: [{ id: `${from}-n`, canvas: 'm', summary: 's', similarity: 0.5, score: 0.4 }] });

describe('location (spec M7 §6)', () => {
  it('round-trips canvas and node through the query string', () => {
    expect(locationFor('mein canvas', null)).toBe('?canvas=mein+canvas');
    expect(locationFor('m', 'N1')).toBe('?canvas=m&node=N1');
    expect(readLocation('?canvas=m&node=N1')).toEqual({ canvas: 'm', node: 'N1', view: 'canvas' });
    expect(readLocation('')).toEqual({ canvas: null, node: null, view: 'canvas' });
    expect(locationFor('m', 'N1', 'chat')).toBe('?canvas=m&node=N1&view=chat'); // spec M9 §4.3
    expect(readLocation('?canvas=m&view=chat').view).toBe('chat');
  });
});

describe('useLinks (spec M7 §6)', () => {
  let calls: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const id = url.split('/')[5]!;
      return new Response(JSON.stringify(dto(id)), { status: 200 });
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const flush = async (): Promise<void> => {
    await act(async () => { await vi.advanceTimersByTimeAsync(LINKS_DEBOUNCE_MS + 1); });
  };

  it('debounces cursor moves: only the node it settles on is fetched', async () => {
    const { result, rerender } = renderHook(({ id }) => useLinks('m', id, 0), { initialProps: { id: 'A' as string | null } });
    rerender({ id: 'B' });
    rerender({ id: 'C' });
    expect(result.current).toBeNull();
    await flush();
    expect(calls).toEqual(['/api/canvases/m/nodes/C/links']);
    expect(result.current?.from).toBe('C');
  });

  it('serves a revisited node from the cache and refetches after a vault change', async () => {
    const { result, rerender } = renderHook(({ id, v }) => useLinks('m', id, v), { initialProps: { id: 'A' as string | null, v: 0 } });
    await flush();
    rerender({ id: 'B', v: 0 });
    await flush();
    rerender({ id: 'A', v: 0 });
    expect(result.current?.from).toBe('A'); // cached: at once, no request
    expect(calls).toHaveLength(2);
    rerender({ id: 'A', v: 1 });
    expect(result.current?.from).toBe('A'); // the old answer stays until the new one lands
    await flush();
    expect(calls).toHaveLength(3);
  });

  it('drops a superseded response and shows nothing without a cursor', async () => {
    const { result, rerender } = renderHook(({ id }) => useLinks('m', id, 0), { initialProps: { id: 'A' as string | null } });
    await act(async () => { await vi.advanceTimersByTimeAsync(LINKS_DEBOUNCE_MS + 1); rerender({ id: 'B' }); });
    await flush();
    expect(result.current?.from).toBe('B');
    rerender({ id: null });
    expect(result.current).toBeNull();
  });

  it('a failed request shows nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const { result } = renderHook(() => useLinks('m', 'A', 0));
    await flush();
    expect(result.current).toBeNull();
  });
});
