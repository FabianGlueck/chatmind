import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

// Two shapes changed vs. the brief's assumption, per `LanguageModelV3StreamPart`/`LanguageModelV3Usage`/
// `LanguageModelV3FinishReason` in node_modules/.pnpm/@ai-sdk+provider@4.0.13/.../dist/index.d.ts:
// - `finish.finishReason` is `{ unified; raw }`, not a bare string union.
// - `usage` nests token counts as `inputTokens: { total, noCache, cacheRead, cacheWrite }` /
//   `outputTokens: { total, text, reasoning }`, not flat `{ inputTokens, outputTokens, totalTokens }: number`.
type Part =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'error'; error: unknown }
  | {
      type: 'finish';
      finishReason: { unified: 'stop'; raw: undefined };
      usage: {
        inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: number | undefined; cacheWrite: number | undefined };
        outputTokens: { total: number | undefined; text: number | undefined; reasoning: number | undefined };
      };
    };

/** A language model that streams the given text deltas, optionally failing after them. */
export function mockModel(deltas: string[], opts: { failAfter?: boolean; delayMs?: number } = {}) {
  const chunks: Part[] = [{ type: 'text-start', id: 't' }, ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't', delta }))];
  if (opts.failAfter) chunks.push({ type: 'error', error: new Error('provider exploded') });
  else
    chunks.push(
      { type: 'text-end', id: 't' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
      },
    );
  return new MockLanguageModelV3({
    // generateText (spec M11 compress) reads the whole text at once.
    doGenerate: async () => ({
      content: [{ type: 'text', text: deltas.join('') }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: undefined, reasoning: undefined } },
      warnings: [],
    }),
    doStream: async () => ({ stream: simulateReadableStream({ chunks, chunkDelayInMs: opts.delayMs ?? 0 }) }),
  });
}
