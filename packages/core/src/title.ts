import { attachmentsIn, replaceAttachments } from './attachments';

const TITLE_MAX = 80;

const cap = (s: string): string => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s);

/**
 * Summary if present, else the first non-empty body line (attachment embeds left out, spec M13), else "🖼 Image(s)"
 * for a body of images only, else "(empty)" — always capped to a title (summaries may be up to 250 chars).
 */
export function nodeTitle(n: { summary: string; body: string }): string {
  if (n.summary !== '') return cap(n.summary);
  const line = replaceAttachments(n.body, () => '').split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (line !== undefined) return cap(line);
  const images = attachmentsIn(n.body).length;
  return images === 0 ? '(empty)' : images === 1 ? '🖼 Image' : `🖼 ${images} images`;
}
