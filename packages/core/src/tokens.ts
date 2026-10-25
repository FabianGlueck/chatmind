import { attachmentsIn, IMAGE_TOKENS, replaceAttachments } from './attachments';

/** Spec M4 §4.6. A heuristic shared by all providers; the UI shows it with a "~". */
const CHARS_PER_TOKEN = 3.5;
const PER_MESSAGE_OVERHEAD = 4;
export const OUTPUT_RESERVE = 16_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Spec M13: a body's text without its attachment embeds, plus `IMAGE_TOKENS` per embedded image. */
export function bodyTokens(body: string): number {
  return estimateTokens(replaceAttachments(body, () => '')) + attachmentsIn(body).length * IMAGE_TOKENS;
}

/** Tokens of the rendered prompt — what is actually sent, preamble and labels included; images per spec M13. */
export function promptTokens(ctx: { system: string; messages: readonly { content: string }[] }): number {
  return estimateTokens(ctx.system) + ctx.messages.reduce((sum, m) => sum + bodyTokens(m.content) + PER_MESSAGE_OVERHEAD, 0);
}

export function budgetFor(contextTokens: number): number {
  return Math.max(contextTokens - OUTPUT_RESERVE, 1);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
