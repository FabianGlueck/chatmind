import { describe, expect, it } from 'vitest';
import { cleanSummary, parentContextOf, shortcutSummary, SUMMARY_MAX, summaryPrompt, truncateForEmbedding, truncateForSummary } from '../src/summary';

describe('cleanSummary (spec M5 §6)', () => {
  it('collapses whitespace, strips quotes and a lone trailing period', () => {
    expect(cleanSummary('  "Zentroid-Ansatz\n  skaliert besser."  ')).toBe('Zentroid-Ansatz skaliert besser');
    expect(cleanSummary('`Titel`')).toBe('Titel');
    expect(cleanSummary("'Titel'")).toBe('Titel');
    expect(cleanSummary('\u201ETitel\u201C')).toBe('Titel'); // ”Titel” - the brief's example
    expect(cleanSummary('\u201CTitel\u201D')).toBe('Titel'); // "Titel"
    expect(cleanSummary('\u2018Titel\u2019')).toBe('Titel'); // 'Titel'
  });
  it('keeps a question mark and inner periods', () => {
    expect(cleanSummary('Warum v2.0?')).toBe('Warum v2.0?');
  });
  it('keeps the final period of a multi-sentence summary', () => {
    expect(cleanSummary('Zentroid statt Re-Clustering. Alte Zettel wandern nie.')).toBe('Zentroid statt Re-Clustering. Alte Zettel wandern nie.');
  });
  it('takes only the first line of a multi-line answer', () => {
    expect(cleanSummary('Titel\n\nErklärung dazu')).toBe('Titel');
  });
  it('cuts at 250 characters on a word boundary with an ellipsis', () => {
    expect(SUMMARY_MAX).toBe(250);
    const long = 'Wort '.repeat(60).trim(); // 299 chars
    const out = cleanSummary(long);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe(`${'Wort '.repeat(49).trim()}…`);
  });
  it('cuts back to the last sentence end (no ellipsis) when one lies in the second half', () => {
    const sentence = 'Dieser Satz ist genau fuenfzig Zeichen lang, wirklich.'; // 55 chars
    const long = `${sentence} ${sentence} ${sentence} ${sentence} ${sentence}`; // 279 chars
    expect(cleanSummary(long)).toBe(`${sentence} ${sentence} ${sentence} ${sentence}`);
    const question = sentence.replace(/\.$/, '?');
    const q = `${sentence} ${sentence} ${question} ${'x'.repeat(240)}`; // '? ' at index 164, inside the second half
    expect(cleanSummary(q)).toBe(`${sentence} ${sentence} ${question}`);
    // a boundary in the first half is ignored: word cut with an ellipsis instead
    expect(cleanSummary(`${question} ${'x'.repeat(240)}`)).toBe(`${question}…`);
  });
  it('returns "" for empty or punctuation-only input', () => {
    expect(cleanSummary('')).toBe('');
    expect(cleanSummary('"."')).toBe('');
  });
});

describe('shortcutSummary', () => {
  it('uses a single short line as its own summary', () => {
    expect(shortcutSummary('  Was ist ein Zentroid?  ')).toBe('Was ist ein Zentroid?');
  });
  it('declines multi-line, long or empty bodies', () => {
    expect(shortcutSummary('Zeile 1\nZeile 2')).toBeNull();
    expect(shortcutSummary('x'.repeat(251))).toBeNull();
    expect(shortcutSummary('x'.repeat(250))).toBe('x'.repeat(250));
    expect(shortcutSummary('   ')).toBeNull();
  });
  // F5: `serializeNodeFile` writes summaries through `normalizeSummary`, which collapses inner
  // whitespace runs — shortcutSummary must match that or the written value never again equals
  // `summary_written` once read back, and the node looks user-edited forever.
  it('collapses inner whitespace runs to match normalizeSummary on write', () => {
    expect(shortcutSummary('Was  ist   das?')).toBe('Was ist das?');
  });
});

describe('truncation', () => {
  it('leaves short bodies alone and caps long ones', () => {
    expect(truncateForSummary('kurz')).toBe('kurz');
    expect(truncateForSummary('x'.repeat(100_000)).length).toBe(14_000);
    expect(truncateForEmbedding('x'.repeat(100_000)).length).toBe(28_000);
  });
});

describe('summaryPrompt / parentContextOf (spec M5 §6)', () => {
  it('names the role, gives the parent as context only, then the body', () => {
    const p = summaryPrompt({ body: 'kannst du mir das nochmal erklären?', lang: 'de', role: 'user', parentContext: 'Faustregel zur Dateigröße' });
    expect(p.split('\n')[0]).toBe('Written by: user');
    expect(p).toContain('for context only, do not summarise it): Faustregel zur Dateigröße');
    expect(p.endsWith('Message:\nkannst du mir das nochmal erklären?')).toBe(true);
  });
  it('omits the context line for a root node', () => {
    expect(summaryPrompt({ body: 'B', lang: 'en', role: 'assistant' })).toBe('Written by: assistant\n\nMessage:\nB');
    expect(summaryPrompt({ body: 'B', lang: 'en', role: 'note' })).toBe('Written by: note (text the user placed on the canvas)\n\nMessage:\nB');
  });
  it('uses the parent summary, else the start of its body', () => {
    expect(parentContextOf({ summary: 'S', body: 'ignored' })).toBe('S');
    expect(parentContextOf({ summary: '', body: 'Zeile 1\n\nZeile   2' })).toBe('Zeile 1 Zeile 2');
    expect(parentContextOf({ summary: '', body: 'x'.repeat(400) })).toBe(`${'x'.repeat(300)}…`);
  });
});
