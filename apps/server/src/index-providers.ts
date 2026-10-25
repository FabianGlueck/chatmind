import { DEFAULT_EMBED_DIM, DEFAULT_EMBED_MODEL, DEFAULT_SUMMARY_MODEL, DEFAULT_THRESHOLDS, topicSettings, type Thresholds, SUMMARY_SYSTEM, summaryPrompt, TOPIC_SYSTEM, topicPrompt, MEMORY_SYSTEM, memoryPrompt, type Embedder, type MemoryWriter, type Summarizer, type TopicNamer } from '@chatmind/index';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { embedMany, generateText, type EmbeddingModel, type LanguageModel } from 'ai';
import { PLACE_SYSTEM, placePrompt, type PlacementJudge } from './placement';

/** Spec M5 §2/§6: the server's index settings, resolved from CHATMIND_* env vars. */
export interface IndexSettings { summaryModel: string; embedModel: string; embedDim: number; noIndex: boolean; thresholds: Thresholds }

/** Spec M5 §2/§6 defaults; everything runs through OpenRouter. */
export const DEFAULT_INDEX_SETTINGS: IndexSettings = {
  summaryModel: DEFAULT_SUMMARY_MODEL,
  embedModel: DEFAULT_EMBED_MODEL,
  embedDim: DEFAULT_EMBED_DIM,
  noIndex: false,
  thresholds: DEFAULT_THRESHOLDS,
};

export function indexSettings(env: Record<string, string>): IndexSettings {
  const dim = Number(env.CHATMIND_EMBED_DIM);
  return {
    summaryModel: env.CHATMIND_SUMMARY_MODEL || DEFAULT_INDEX_SETTINGS.summaryModel,
    embedModel: env.CHATMIND_EMBED_MODEL || DEFAULT_INDEX_SETTINGS.embedModel,
    embedDim: Number.isInteger(dim) && dim > 0 ? dim : DEFAULT_INDEX_SETTINGS.embedDim,
    noIndex: env.CHATMIND_NO_INDEX === '1' || env.CHATMIND_NO_INDEX === 'true',
    thresholds: topicSettings(env), // spec M6 §4 — one source for the indexer and `index topics --dry-run`
  };
}

/**
 * Raw model text; cleaning and the short-body shortcut live in @chatmind/index, which also builds the prompt
 * (role, parent context, body). Reasoning models spend the output budget on reasoning before the answer (dry run
 * 2026-09-21: 40 of 60 tokens, title cut off), so reasoning is set to minimal and the budget is generous.
 */
export function createSummarizer(model: LanguageModel): Summarizer {
  return async (input) => {
    const { text } = await generateText({
      model,
      system: SUMMARY_SYSTEM,
      prompt: summaryPrompt(input),
      maxOutputTokens: 200,
      providerOptions: { openrouter: { reasoning: { effort: 'minimal' } } },
    });
    return text;
  };
}

/** Spec M6 §5: the summary model names topics; the prompt lives in @chatmind/index, cleaning and folding too. */
export function createTopicNamer(model: LanguageModel): TopicNamer {
  return async (input) => {
    const { text, finishReason, usage } = await generateText({
      model,
      system: TOPIC_SYSTEM,
      prompt: topicPrompt(input),
      // 60 was enough for the name itself but not for a turn that spends output tokens on reasoning first: the
      // answer then came back empty and the node failed as "empty topic name" (seen live 2026-09-22, and the
      // same failure M5 hit on summaries). The budget is a cap, not a spend — a topic name is a handful of tokens.
      maxOutputTokens: 200,
      providerOptions: { openrouter: { reasoning: { effort: 'minimal' } } },
    });
    // An empty completion is the provider's problem, not a bad name: say so, with what the provider reported.
    if (text.trim() === '') {
      const reasoning = usage.outputTokenDetails?.reasoningTokens;
      throw new Error(`the model returned no topic name (finish reason ${finishReason}, ${usage.outputTokens ?? '?'} output tokens${reasoning ? `, ${reasoning} of them reasoning` : ''})`);
    }
    return text;
  };
}

/** Spec M15 §2: the summary model writes the new bullets of one topic's memory. */
export function createMemoryWriter(model: LanguageModel): MemoryWriter {
  return async (input) => {
    const { text, finishReason } = await generateText({
      model,
      system: MEMORY_SYSTEM,
      prompt: memoryPrompt(input),
      maxOutputTokens: 1000,
      providerOptions: { openrouter: { reasoning: { effort: 'minimal' } } },
    });
    if (text.trim() === '') throw new Error(`the model returned no memory (finish reason ${finishReason})`);
    return text;
  };
}

/** Spec M14 §judge: the summary model decides whether a new question belongs to one of the canvas's topics. */
export function createPlacementJudge(model: LanguageModel): PlacementJudge {
  return async (input) => {
    const { text } = await generateText({
      model,
      system: PLACE_SYSTEM,
      prompt: placePrompt(input),
      maxOutputTokens: 200, // a cap, not a spend — see createTopicNamer
      providerOptions: { openrouter: { reasoning: { effort: 'minimal' } } },
    });
    return text;
  };
}

export function createEmbedder(model: EmbeddingModel, id: string, dim: number): Embedder {
  return {
    model: id,
    dim,
    async embed(texts) {
      const { embeddings } = await embedMany({ model, values: texts });
      return embeddings.map((v) => Float32Array.from(v));
    },
  };
}

/** Wires the OpenRouter-backed summarizer, embedder and topic namer from resolved settings. */
export function openRouterIndexProviders(apiKey: string, s: IndexSettings): { summarizer: Summarizer; embedder: Embedder; namer: TopicNamer; judge: PlacementJudge; memoryWriter: MemoryWriter } {
  const openrouter = createOpenRouter({ apiKey });
  const model = openrouter(s.summaryModel);
  return {
    summarizer: createSummarizer(model),
    embedder: createEmbedder(openrouter.textEmbeddingModel(s.embedModel), s.embedModel, s.embedDim),
    namer: createTopicNamer(model),
    judge: createPlacementJudge(model),
    memoryWriter: createMemoryWriter(model),
  };
}
