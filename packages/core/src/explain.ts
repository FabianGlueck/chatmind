import { buildContext, type BuiltContext } from './context';
import type { GraphLike } from './graph-like';
import { detectLanguage, type Language } from './language';
import type { NodeId } from './types';

/** Spec quick-explain §3: heads the first request of an explanation; nothing of it is ever written. */
export const EXPLAIN_HEADER: Record<Language, string> = {
  de: 'Kurze Verständnisfrage zu einer Stelle in der letzten Nachricht. Antworte knapp in zwei bis drei Sätzen, ohne Vorrede, bezogen auf genau diese Stelle in ihrem Zusammenhang.',
  en: 'A quick question about one spot in the last message. Answer briefly in two or three sentences, without preamble, about exactly this spot in its context.',
};
/** The question when the user only marked a spot and asked nothing. */
export const EXPLAIN_DEFAULT: Record<Language, string> = { de: 'Was bedeutet das hier?', en: 'What does this mean here?' };
const SPOT: Record<Language, [string, string]> = { de: ['Stelle', 'Im Satz'], en: ['Spot', 'In the sentence'] };

export const MAX_EXPLAIN_SELECTION = 500;
export const MAX_EXPLAIN_PASSAGE = 2000;

export interface ExplainInput {
  selection: string;
  /** The sentence or paragraph around the selection, as the browser saw it. */
  passage?: string;
  /** Earlier questions and answers of this popover, oldest first. */
  exchange: readonly { q: string; a: string }[];
  /** The question now asked; '' = the default question (first turn) . */
  ask: string;
}

/**
 * Spec quick-explain §3. The strand down to and including the card — the same `buildContext` as a reply to it —
 * then the request: header, the selection and its sentence, the first question; follow-ups continue as turns.
 * Throws on an unknown id.
 */
export function buildExplainContext(graph: GraphLike, id: NodeId, input: ExplainInput): BuiltContext {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`unknown node ${id}`);
  const questions = [...input.exchange.map((e) => e.q), input.ask];
  // One target, so the request is the last message on its own; its language follows the strand and the questions.
  const ctx = buildContext(graph, [id], [], '');
  const language = detectLanguage([...ctx.messages.map((m) => m.content), input.selection, input.passage ?? '', ...questions]);
  const [spot, sentence] = SPOT[language];
  const passage = input.passage?.trim() ?? '';
  const quote = [`${spot}: »${input.selection.trim()}«`, ...(passage !== '' && passage !== input.selection.trim() ? [`${sentence}: »${passage}«`] : [])].join('\n');
  const ask = (q: string): string => (q.trim() === '' ? EXPLAIN_DEFAULT[language] : q.trim());
  ctx.messages[ctx.messages.length - 1] = { role: 'user', content: `${EXPLAIN_HEADER[language]}\n\n${quote}\n\n${ask(questions[0]!)}` };
  input.exchange.forEach((e, i) => ctx.messages.push({ role: 'assistant', content: e.a }, { role: 'user', content: ask(questions[i + 1]!) }));
  return { ...ctx, language };
}

/** Spec quick-explain §4: the question of a kept explanation, as it lands in the vault. */
export function explainQuestion(language: Language, selection: string, question: string): string {
  return `»${selection.trim()}« — ${question.trim() === '' ? EXPLAIN_DEFAULT[language] : question.trim()}`;
}
