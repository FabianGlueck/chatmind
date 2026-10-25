import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../src/sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(ctrl) { for (const c of chunks) ctrl.enqueue(enc.encode(c)); ctrl.close(); } });
}
async function all(chunks: string[]) {
  const out = [];
  for await (const e of parseSseStream(streamOf(chunks))) out.push(e);
  return out;
}

describe('parseSseStream', () => {
  it('parses events split arbitrarily across chunks', async () => {
    expect(await all(['event: delta\nda', 'ta: {"text":"a"}\n\nevent: do', 'ne\ndata: {"id":1}\n\n'])).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'done', data: '{"id":1}' },
    ]);
  });
  it('joins multi-line data, ignores comments, defaults event to "message"', async () => {
    expect(await all([':keepalive\ndata: a\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
  it('flushes a final event without trailing blank line', async () => {
    expect(await all(['event: x\ndata: 1'])).toEqual([{ event: 'x', data: '1' }]);
  });
  it('cancels the underlying stream when the consumer stops early', async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) { ctrl.enqueue(enc.encode('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')); },
      cancel() { cancelled = true; },
    });
    for await (const e of parseSseStream(body)) { expect(e.event).toBe('a'); break; }
    expect(cancelled).toBe(true);
  });
  it('accepts CRLF line endings, even split across chunks', async () => {
    expect(await all(['event: delta\r\ndata: {"t":1}\r', '\n\r\nevent: done\r\ndata: 2\r\n\r\n'])).toEqual([
      { event: 'delta', data: '{"t":1}' },
      { event: 'done', data: '2' },
    ]);
  });
});
