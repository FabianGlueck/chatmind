/** Spec M13: images live in `<canvas>/attachments/<ULID>.<ext>` and are referenced from a body as `![[<name>]]`. */
export const ATTACHMENTS_DIR = 'attachments';
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Spec M13: the provider-neutral estimate for one image in the prompt. */
export const IMAGE_TOKENS = 1600;

export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const EXT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const NAME = '[0-9A-HJKMNP-TV-Z]{26}\\.(?:png|jpg|gif|webp)';
const NAME_RE = new RegExp(`^${NAME}$`);
const EMBED_RE = () => new RegExp(`!\\[\\[(${NAME})\\]\\]`, 'g');

export function isAttachmentName(name: string): boolean {
  return NAME_RE.test(name);
}

/** The media type of an attachment file name, or undefined for anything that is not one. */
export function attachmentType(name: string): string | undefined {
  return isAttachmentName(name) ? EXT_TYPES[name.slice(name.lastIndexOf('.') + 1)] : undefined;
}

export const attachmentEmbed = (name: string): string => `![[${name}]]`;

/** Spec M13: attachment names embedded in `text`, in order (repeats kept — each is sent). */
export function attachmentsIn(text: string): string[] {
  return [...text.matchAll(EMBED_RE())].map((m) => m[1]!);
}

export type AttachmentPart = { type: 'text'; text: string } | { type: 'image'; name: string };

/** Spec M13: `text` split at its attachment embeds into interleaved text and image parts; blank text parts are dropped. */
export function splitAttachments(text: string): AttachmentPart[] {
  const parts: AttachmentPart[] = [];
  let at = 0;
  const pushText = (t: string): void => { if (t.trim() !== '') parts.push({ type: 'text', text: t.trim() }); };
  for (const m of text.matchAll(EMBED_RE())) {
    pushText(text.slice(at, m.index));
    parts.push({ type: 'image', name: m[1]! });
    at = m.index + m[0].length;
  }
  pushText(text.slice(at));
  return parts;
}

/** `text` with every attachment embed replaced by `by(name)`. */
export function replaceAttachments(text: string, by: (name: string) => string): string {
  return text.replace(EMBED_RE(), (_, name: string) => by(name));
}
