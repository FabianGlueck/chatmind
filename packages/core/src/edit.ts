import { buildContext, type BuiltContext } from './context';
import type { GraphLike } from './graph-like';
import { detectLanguage, type Language } from './language';
import type { NodeId, Role } from './types';

/** Spec M17 §3.3: heads the edit request; `{role}` is replaced with `EDIT_ROLE[lang][role]`. */
export const EDIT_HEADER: Record<Language, string> = {
  de: 'Überarbeite diese {role} nach der Anweisung unten. Antworte nur mit dem neuen Text — ohne Vorrede, ohne Begleitkommentar, ohne die <<< >>> Marker.',
  en: 'Rewrite this {role} following the instruction below. Reply with the new text only — no preamble, no comments, no <<< >>> markers.',
};

export const EDIT_ROLE: Record<Language, Record<Role, string>> = {
  de: { user: 'Frage', assistant: 'Antwort', note: 'Notiz' },
  en: { user: 'question', assistant: 'answer', note: 'note' },
};

/**
 * Spec M17 §3.3. The strand above the card exactly as a reply to its parents would see it, then one user
 * message: header, the card's text (or `draft`, when refining a preview) between `<<<`/`>>>`, the
 * instruction. The language follows the instruction and the text being edited. Throws on an unknown id.
 */
export function buildEditContext(graph: GraphLike, id: NodeId, instruction: string, draft?: string): BuiltContext {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`unknown node ${id}`);
  const text = draft ?? node.body;
  const language = detectLanguage([instruction, text]);
  const request = `${EDIT_HEADER[language].replace('{role}', EDIT_ROLE[language][node.role])}\n\n<<<\n${text}\n>>>\n\n${instruction}`;
  return { ...buildContext(graph, node.parents, [], request), language };
}

/** Spec M17 §4: trims, and drops a leading `<<<` / trailing `>>>` line the model echoed anyway. */
export function cleanRewrite(text: string): string {
  return text.trim().replace(/^<<<[ \t]*(?:\n|$)/, '').replace(/(?:^|\n)[ \t]*>>>$/, '').trim();
}

/** Spec M17 §6: the longest summary the user may type — the indexer's own limit (`SUMMARY_MAX` in @chatmind/index). */
export const MAX_SUMMARY_CHARS = 250;

/** Spec M17 §6: a typed summary is one line — inner whitespace runs (newlines included) become one space. */
export function cleanSummaryInput(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
