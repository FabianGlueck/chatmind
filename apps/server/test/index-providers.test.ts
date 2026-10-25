import { describe, expect, it } from 'vitest';
import { MockEmbeddingModelV3, MockLanguageModelV3 } from 'ai/test';
import { DEFAULT_THRESHOLDS, SUMMARY_SYSTEM, TOPIC_SYSTEM } from '@chatmind/index';
import { createEmbedder, createSummarizer, createTopicNamer, DEFAULT_INDEX_SETTINGS, indexSettings } from '../src/index-providers';

describe('indexSettings', () => {
  it('defaults to Luna + text-embedding-3-small/1536 via OpenRouter', () => {
    expect(indexSettings({})).toEqual(DEFAULT_INDEX_SETTINGS);
    expect(DEFAULT_INDEX_SETTINGS).toEqual({ summaryModel: 'openai/gpt-5.6-luna', embedModel: 'openai/text-embedding-3-small', embedDim: 1536, noIndex: false, thresholds: DEFAULT_THRESHOLDS });
  });
  it('honours the env overrides', () => {
    expect(indexSettings({ CHATMIND_SUMMARY_MODEL: 'a/b', CHATMIND_EMBED_MODEL: 'c/d', CHATMIND_EMBED_DIM: '768', CHATMIND_NO_INDEX: '1' })).toEqual({ summaryModel: 'a/b', embedModel: 'c/d', embedDim: 768, noIndex: true, thresholds: DEFAULT_THRESHOLDS });
    expect(indexSettings({ CHATMIND_EMBED_DIM: 'abc' }).embedDim).toBe(1536);
  });
});

describe('indexSettings thresholds (spec M6 §4)', () => {
  it('carries the topic thresholds, so the indexer and the dry run agree', () => {
    expect(indexSettings({ CHATMIND_TOPIC_INHERIT: '0.3' }).thresholds).toEqual({ ...DEFAULT_THRESHOLDS, tInherit: 0.3 });
    expect(indexSettings({ CHATMIND_TOPIC_INHERIT: 'nonsense' }).thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe('createSummarizer', () => {
  it('sends the fixed system prompt and the body, returns the raw text', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '"Ein Titel."' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: undefined, reasoning: undefined } },
        warnings: [],
      }),
    });
    const summarize = createSummarizer(model);
    expect(await summarize({ body: 'Body text', lang: 'de', role: 'user', parentContext: 'Vorherige Antwort' })).toBe('"Ein Titel."'); // cleaning happens in @chatmind/index
    const call = model.doGenerateCalls[0]!;
    expect(call.prompt[0]).toMatchObject({ role: 'system', content: SUMMARY_SYSTEM });
    expect(call.prompt[1]).toMatchObject({ role: 'user' });
    const userMessage = JSON.stringify(call.prompt[1]);
    expect(userMessage).toContain('Body text');
    expect(userMessage).toContain('Written by: user');
    expect(userMessage).toContain('Vorherige Antwort');
    expect(call.maxOutputTokens).toBe(200);
    // Reasoning models spend the output budget on reasoning first (dry run 2026-09-21: 40 of 60 tokens); ask for none.
    expect(call.providerOptions).toEqual({ openrouter: { reasoning: { effort: 'minimal' } } });
  });
});

describe('createTopicNamer when the model returns nothing', () => {
  it('throws an error naming the finish reason, instead of a bare empty string', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '  ' }],
        finishReason: { unified: 'length', raw: undefined },
        usage: { inputTokens: { total: 900, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 200, text: 0, reasoning: 200 } },
        warnings: [],
      }),
    });
    await expect(createTopicNamer(model)({ summary: 'S', role: 'user', lang: 'de', candidates: [], allTopics: [] }))
      .rejects.toThrow(/no topic name.*length/i);
  });
});

describe('createEmbedder', () => {
  it('returns Float32Arrays and carries model/dim', async () => {
    const model = new MockEmbeddingModelV3({ doEmbed: async ({ values }) => ({ embeddings: values.map(() => [0.1, 0.2, 0.3]), warnings: [] }) });
    const e = createEmbedder(model, 'test/embed', 3);
    expect(e.model).toBe('test/embed');
    expect(e.dim).toBe(3);
    const out = await e.embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0]!.length).toBe(3);
  });
});

describe('createTopicNamer (spec M6 §5)', () => {
  it('sends the fixed system prompt and the case, returns the raw text', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Zentroid-Ansatz' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: undefined, reasoning: undefined } },
        warnings: [],
      }),
    });
    const name = createTopicNamer(model);
    expect(await name({ summary: 'Frage nach Zentroiden', role: 'user', lang: 'de', parentTopic: 'Evaluation', candidates: [{ name: 'Evaluation', examples: ['x'] }], allTopics: ['Evaluation'] })).toBe('Zentroid-Ansatz');
    const call = model.doGenerateCalls[0]!;
    expect(call.prompt[0]).toMatchObject({ role: 'system', content: TOPIC_SYSTEM });
    const userMessage = JSON.stringify(call.prompt[1]);
    expect(userMessage).toContain('Frage nach Zentroiden');
    expect(userMessage).toContain('- Evaluation: x');
    expect(call.maxOutputTokens).toBe(200); // 60 left nothing for the name when the model emitted reasoning (2026-09-22)
    expect(call.providerOptions).toEqual({ openrouter: { reasoning: { effort: 'minimal' } } });
  });
});
