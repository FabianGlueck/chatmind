import type { Role } from '@chatmind/core';
import type { SummaryInput } from './types';

export const SUMMARY_MAX = 250;

/** Fixed and language-neutral so provider caches can hit; role and context travel in the user message (spec M5 §6). */
export const SUMMARY_SYSTEM =
  'You summarise one message from a branching conversation. Reply with one short paragraph of one to three sentences and at most 200 characters, in the language of the message. No quotes, no preamble, no explanation. ' +
  'For a message written by the user: state what they ask for or want — the intent — not the material they quote or paste. Begin with the kind of message as a label, e.g. "Follow-up question: …", "Request to explain: …", "Decision: …", "Instruction: …" (in the language of the message); never start with "The user …". ' +
  'For a message written by the assistant: state what the answer says. ' +
  'For a note (text the user placed on the canvas as material): state what the text is and what it is about. ' +
  'A short message may be summarised in a few words.';

const PARENT_CONTEXT_MAX = 300;

/** The first line of the summarizer's and the namer's prompt; a note is named as such (spec M16 §5). */
export function writtenBy(role: Role): string {
  return role === 'note' ? 'Written by: note (text the user placed on the canvas)' : `Written by: ${role}`;
}

/** The user message for the summarizer: role, the parent as context, then the body (spec M5 §6). Pure. */
export function summaryPrompt(input: SummaryInput): string {
  const lines = [writtenBy(input.role)];
  if (input.parentContext !== undefined && input.parentContext !== '') lines.push(`The message it replies to (for context only, do not summarise it): ${input.parentContext}`);
  lines.push('', 'Message:', input.body);
  return lines.join('\n');
}

/** What a child sees of its parent: the summary, else the start of the body. */
export function parentContextOf(parent: { summary: string; body: string }): string {
  if (parent.summary !== '') return parent.summary;
  const flat = parent.body.replace(/\s+/g, ' ').trim();
  return flat.length > PARENT_CONTEXT_MAX ? `${flat.slice(0, PARENT_CONTEXT_MAX)}…` : flat;
}

// ASCII quotes/backtick plus the curly/typographic pairs (U+201C–U+201E, U+2018–U+201A) and guillemets.
const QUOTES = /^[\s"'`“”„‘’‚«»]+|[\s"'`“”„‘’‚«»]+$/g;

/**
 * First paragraph only (stops at blank line), whitespace collapsed, quotes stripped, ≤ SUMMARY_MAX chars, cut at the last sentence end when
 * possible, else on a word boundary with `…`. A trailing period is dropped only from a single-sentence result (a title); a multi-sentence summary
 * keeps its final period.
 */
export function cleanSummary(raw: string): string {
  const firstParagraph = raw.split(/\n\s*\n/)[0] ?? '';
  let s = firstParagraph.replace(/\s+/g, ' ').trim().replace(QUOTES, '');
  if (!/[.!?] /.test(s)) s = s.replace(/\.+$/, '').replace(QUOTES, '');
  if (s.length <= SUMMARY_MAX) return s;
  // Too long: end at the last sentence boundary if one lies in the second half (clean, no ellipsis) …
  const window = s.slice(0, SUMMARY_MAX);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  if (sentenceEnd >= SUMMARY_MAX / 2) return window.slice(0, sentenceEnd + 1);
  // … otherwise on a word boundary with an ellipsis.
  const cut = s.slice(0, SUMMARY_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * A single non-empty line of ≤ SUMMARY_MAX characters is its own summary — no LLM call (spec M5 §6). F5: inner
 * whitespace runs are collapsed first, matching `normalizeSummary` on write — otherwise `summary_written`
 * (this value) and the body-round-tripped-through-disk summary never compare equal, and the node looks
 * user-edited forever.
 */
export function shortcutSummary(body: string): string | null {
  const t = body.trim();
  if (t === '' || t.includes('\n')) return null; // multi-line check first: collapsing \s+ would eat the newline itself
  const collapsed = t.replace(/\s+/g, ' ');
  return collapsed.length > SUMMARY_MAX ? null : collapsed;
}

// Same heuristic as core's estimateTokens (3.5 chars/token); a title needs the beginning, not the whole text.
const SUMMARY_CHARS = 4000 * 3.5;
const EMBED_CHARS = 8000 * 3.5;

export function truncateForSummary(body: string): string {
  return body.length > SUMMARY_CHARS ? body.slice(0, SUMMARY_CHARS) : body;
}

export function truncateForEmbedding(body: string): string {
  return body.length > EMBED_CHARS ? body.slice(0, EMBED_CHARS) : body;
}
