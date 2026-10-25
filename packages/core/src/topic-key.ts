/** Spec M6 §4 (moved to core for M15): the identity under which two spellings count as the same topic. */
export function topicKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}
