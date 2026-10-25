export interface SseEvent { event: string; data: string }

/** Minimal text/event-stream parser: `event:` + one or more `data:` lines per blank-line-delimited block. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = function* (block: string): Generator<SseEvent> {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) yield { event, data: data.join('\n') };
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize line endings: handle \r\n and \r, but preserve trailing \r for potential \r\n across chunks
      let normalizeBuffer = buffer;
      let trailingR = '';
      if (normalizeBuffer.endsWith('\r')) {
        trailingR = '\r';
        normalizeBuffer = normalizeBuffer.slice(0, -1);
      }
      normalizeBuffer = normalizeBuffer.replace(/\r\n?/g, '\n');
      buffer = normalizeBuffer + trailingR;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        yield* flush(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n?/g, '\n');
    if (buffer.trim() !== '') yield* flush(buffer);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock?.();
  }
}
