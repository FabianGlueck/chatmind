import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ATTACHMENTS_DIR, attachmentType, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, newId, splitAttachments, type ContextMessage } from '@chatmind/core';
import type { ModelMessage } from 'ai';

export interface DecodedImage { ext: string; bytes: Buffer }

/** Spec M13: validate `SendRequest.images`; a string is the 400 reason. */
export function decodeImages(raw: unknown): DecodedImage[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'images must be an array';
  if (raw.length > MAX_IMAGES) return `at most ${MAX_IMAGES} images per message`;
  const out: DecodedImage[] = [];
  for (const img of raw as { mediaType?: unknown; data?: unknown }[]) {
    const ext = typeof img?.mediaType === 'string' ? IMAGE_TYPES[img.mediaType] : undefined;
    if (ext === undefined) return `images must be one of ${Object.keys(IMAGE_TYPES).join(', ')}`;
    if (typeof img.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) return 'image data must be base64';
    const bytes = Buffer.from(img.data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) return `an image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`;
    out.push({ ext, bytes });
  }
  return out;
}

export const attachmentsDir = (dataDir: string, slug: string): string => path.join(dataDir, slug, ATTACHMENTS_DIR);

/** Spec M13: write each image once as `<canvas>/attachments/<ULID>.<ext>`; returns the names in order. */
export async function writeAttachments(dataDir: string, slug: string, images: readonly DecodedImage[]): Promise<string[]> {
  if (images.length === 0) return [];
  const dir = attachmentsDir(dataDir, slug);
  await fs.mkdir(dir, { recursive: true });
  const names: string[] = [];
  for (const img of images) {
    const name = `${newId()}.${img.ext}`;
    await fs.writeFile(path.join(dir, name), img.bytes, { flag: 'wx' });
    names.push(name);
  }
  return names;
}

/**
 * Spec M13: user messages split at their attachment embeds into text and image parts, the bytes read from `dir`;
 * a missing file becomes a text note. Assistant messages stay text.
 */
export async function withImages(messages: readonly ContextMessage[], dir: string): Promise<ModelMessage[]> {
  return Promise.all(
    messages.map(async (m): Promise<ModelMessage> => {
      const parts = splitAttachments(m.content);
      if (m.role === 'assistant' || parts.every((p) => p.type === 'text')) return m.role === 'assistant' ? { role: 'assistant', content: m.content } : { role: 'user', content: m.content };
      const content = await Promise.all(
        parts.map(async (p) => {
          if (p.type === 'text') return { type: 'text' as const, text: p.text };
          try {
            return { type: 'file' as const, data: await fs.readFile(path.join(dir, p.name)), mediaType: attachmentType(p.name)! };
          } catch {
            return { type: 'text' as const, text: `[missing image ${p.name}]` };
          }
        }),
      );
      return { role: 'user', content };
    }),
  );
}
