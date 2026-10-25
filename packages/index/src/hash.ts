import { createHash } from 'node:crypto';

/** Spec M5 §4: the single comparison value for embeddings and summaries. */
export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
