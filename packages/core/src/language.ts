export type Language = 'de' | 'en';

// Spec M4 §4.5. 'in' and 'an' are deliberately absent from the English list — both are everyday German
// words too and would bias German text towards English.
const GERMAN = new Set(['der', 'die', 'das', 'und', 'nicht', 'ist', 'ein', 'eine', 'ich', 'mit', 'für', 'auf', 'zu', 'den', 'dem', 'sich', 'auch', 'wie', 'aber', 'oder']);
const ENGLISH = new Set(['the', 'and', 'is', 'of', 'to', 'that', 'it', 'for', 'with', 'as', 'on', 'this', 'are', 'be', 'not', 'by', 'from', 'or']);

/** German when German stopwords outnumber English ones; English otherwise (ties, empty input). */
export function detectLanguage(texts: readonly string[]): Language {
  let de = 0;
  let en = 0;
  for (const word of texts.join(' ').toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (GERMAN.has(word)) de++;
    if (ENGLISH.has(word)) en++;
  }
  return de > en ? 'de' : 'en';
}
