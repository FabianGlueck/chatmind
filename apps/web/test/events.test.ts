import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRefetcher, subscribeVaultEvents } from '../src/events';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createRefetcher', () => {
  it('runs once, coalesces triggers during a run into exactly one follow-up', async () => {
    let resolve: () => void = () => undefined;
    const runs: number[] = [];
    const run = vi.fn(() => new Promise<void>((r) => { runs.push(runs.length); resolve = r; }));
    const trigger = createRefetcher(run);
    trigger();
    trigger();
    trigger();
    expect(run).toHaveBeenCalledTimes(1);
    resolve();
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
    resolve();
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a rejected run does not block the next trigger', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const trigger = createRefetcher(run);
    trigger();
    await tick();
    trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a synchronously throwing run does not leak an unhandled rejection', async () => {
    const run = vi.fn().mockImplementationOnce(() => { throw new Error('sync'); }).mockResolvedValue(undefined);
    const trigger = createRefetcher(run);
    trigger();
    await tick();
    trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('subscribeVaultEvents', () => {
  afterEach(() => { delete (globalThis as { EventSource?: unknown }).EventSource; });

  it('is a no-op without EventSource (jsdom)', () => {
    expect(typeof subscribeVaultEvents(() => undefined)).toBe('function');
  });

  it('parses vault-changed and closes on unsubscribe', () => {
    const instances: FakeES[] = [];
    class FakeES {
      listeners = new Map<string, (e: MessageEvent) => void>();
      closed = false;
      constructor(public url: string) { instances.push(this); }
      addEventListener(type: string, l: (e: MessageEvent) => void) { this.listeners.set(type, l); }
      close() { this.closed = true; }
    }
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
    const seen: string[][] = [];
    const off = subscribeVaultEvents((slugs) => seen.push(slugs));
    expect(instances[0]!.url).toBe('/api/events');
    instances[0]!.listeners.get('vault-changed')!({ data: '{"slugs":["m"]}' } as MessageEvent);
    instances[0]!.listeners.get('vault-changed')!({ data: 'not json' } as MessageEvent);
    expect(seen).toEqual([['m']]);
    off();
    expect(instances[0]!.closed).toBe(true);
  });
});
