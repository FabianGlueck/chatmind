import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../src/transcript';

describe('parseTranscript', () => {
  it('accepts the documented shape and keeps optional fields only when present', () => {
    expect(parseTranscript({ messages: [{ role: 'user', content: 'a', summary: 's' }, { role: 'assistant', content: 'b', model: 'm' }] })).toEqual([
      { role: 'user', content: 'a', summary: 's' },
      { role: 'assistant', content: 'b', model: 'm' },
    ]);
  });
  it('rejects a missing messages array', () => {
    expect(() => parseTranscript({})).toThrow('transcript must be an object with a "messages" array');
    expect(() => parseTranscript(null)).toThrow('transcript must be an object with a "messages" array');
  });
  it('rejects bad messages with their index', () => {
    expect(() => parseTranscript({ messages: [{ role: 'system', content: 'x' }] })).toThrow('message 0: role must be "user" or "assistant"');
    expect(() => parseTranscript({ messages: [{ role: 'user', content: 'x' }, { role: 'user' }] })).toThrow('message 1: content must be a string');
    expect(() => parseTranscript({ messages: ['x'] })).toThrow('message 0 is not an object');
  });
});
