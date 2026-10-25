import type { Embedder, Summarizer, SummaryInput, TopicInput, TopicNamer } from '../src/types';

/** Deterministic 4-dim vector from the text; records calls; can be made to fail. */
export function fakeEmbedder(opts: { fail?: boolean } = {}): Embedder & { calls: string[][]; fail: boolean } {
  const e = {
    model: 'fake/embed',
    dim: 4,
    calls: [] as string[][],
    fail: opts.fail ?? false,
    async embed(texts: string[]): Promise<Float32Array[]> {
      e.calls.push(texts);
      if (e.fail) throw new Error('embed down');
      return texts.map((t) => Float32Array.from([t.length, t.charCodeAt(0) || 0, 1, 0]));
    },
  };
  return e;
}

/** "T: <first 20 chars>" with the language; records calls; can fail. */
export function fakeSummarizer(opts: { fail?: boolean } = {}): Summarizer & { calls: SummaryInput[]; fail: boolean } {
  const s = Object.assign(
    async (input: SummaryInput): Promise<string> => {
      s.calls.push(input);
      if (s.fail) throw new Error('llm down');
      return `${input.lang.toUpperCase()}: ${input.body.slice(0, 20)}`;
    },
    { calls: [] as SummaryInput[], fail: opts.fail ?? false },
  );
  return s;
}

/** One-hot 4-dim vector by the text's first letter (A/B/C → axes 0/1/2), anything else → [1,1,1,1]; records calls. */
export function topicEmbedder(): Embedder & { calls: string[][] } {
  const e = {
    model: 'fake/topic-embed',
    dim: 4,
    calls: [] as string[][],
    async embed(texts: string[]): Promise<Float32Array[]> {
      e.calls.push(texts);
      return texts.map((t) => {
        const axis = 'ABC'.indexOf(t[0] ?? '');
        if (axis < 0) return Float32Array.from([1, 1, 1, 1]);
        const v = new Float32Array(4);
        v[axis] = 1;
        return v;
      });
    },
  };
  return e;
}

/** Names the topic after the summary's first letter ("Topic A"); records calls; can fail. */
export function fakeNamer(opts: { fail?: boolean } = {}): TopicNamer & { calls: TopicInput[]; fail: boolean } {
  const n = Object.assign(
    async (input: TopicInput): Promise<string> => {
      n.calls.push(input);
      if (n.fail) throw new Error('namer down');
      return `Topic ${input.summary.replace(/^[A-Z]+: /, '')[0] ?? '?'}`;
    },
    { calls: [] as TopicInput[], fail: opts.fail ?? false },
  );
  return n;
}
