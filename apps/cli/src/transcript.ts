import type { TranscriptMessage } from '@chatmind/core';

export function parseTranscript(raw: unknown): TranscriptMessage[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { messages?: unknown }).messages)) {
    throw new Error('transcript must be an object with a "messages" array');
  }
  return (raw as { messages: unknown[] }).messages.map((m, i) => {
    if (typeof m !== 'object' || m === null) throw new Error(`message ${i} is not an object`);
    const { role, content, summary, model } = m as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') throw new Error(`message ${i}: role must be "user" or "assistant"`);
    if (typeof content !== 'string') throw new Error(`message ${i}: content must be a string`);
    const out: TranscriptMessage = { role, content };
    if (typeof summary === 'string') out.summary = summary;
    if (typeof model === 'string') out.model = model;
    return out;
  });
}
