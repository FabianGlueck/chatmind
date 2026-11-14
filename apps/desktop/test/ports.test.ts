import { describe, expect, it } from 'vitest';
import { DESKTOP_PORTS, onFirstFreePort } from '../src/ports';

const inUse = (): Error => Object.assign(new Error('in use'), { code: 'EADDRINUSE' });

describe('onFirstFreePort (desktop spec §1)', () => {
  it('starts at 3211 and stays within ten ports', () => {
    expect(DESKTOP_PORTS[0]).toBe(3211);
    expect(DESKTOP_PORTS).toHaveLength(10);
  });
  it('moves on past taken ports and returns the first start that works', async () => {
    const tried: number[] = [];
    const got = await onFirstFreePort([1, 2, 3], async (p) => {
      tried.push(p);
      if (p < 3) throw inUse();
      return `on ${p}`;
    });
    expect(got).toBe('on 3');
    expect(tried).toEqual([1, 2, 3]);
  });
  it('gives up on any other error and when every port is taken', async () => {
    await expect(onFirstFreePort([1, 2], async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(onFirstFreePort([1, 2], async () => { throw inUse(); })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
