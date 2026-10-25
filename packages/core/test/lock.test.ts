import { describe, expect, it } from 'vitest';
import { VaultLock } from '../src/vault/lock';

describe('VaultLock', () => {
  it('serialises callers in FIFO order and returns their values', async () => {
    const lock = new VaultLock();
    const log: string[] = [];
    const a = lock.run(async () => { log.push('a-start'); await new Promise((r) => setTimeout(r, 20)); log.push('a-end'); return 1; });
    const b = lock.run(async () => { log.push('b-start'); return 2; });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(log).toEqual(['a-start', 'a-end', 'b-start']);
  });
  it('a rejected task does not block later tasks', async () => {
    const lock = new VaultLock();
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lock.run(async () => 'ok')).toBe('ok');
  });
});
