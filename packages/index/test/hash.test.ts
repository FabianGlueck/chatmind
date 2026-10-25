import { describe, expect, it } from 'vitest';
import { contentHash } from '../src/hash';

describe('contentHash', () => {
  it('is sha256 hex of the body', () => {
    expect(contentHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
