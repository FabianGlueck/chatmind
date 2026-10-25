import { describe, expect, it } from 'vitest';
import { SLUG_MAX, isCanvasSlug, isUlid, isoTimestamp, newId, nodeFileName, slug } from '../src/ids';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';

describe('slug', () => {
  it('lowercases and dashes words', () => {
    expect(slug('Zentroid-Ansatz skaliert besser')).toBe('zentroid-ansatz-skaliert-besser');
  });
  it('transliterates German umlauts and sharp s', () => {
    expect(slug('Über Größe & Maß')).toBe('ueber-groesse-mass');
  });
  it('strips other diacritics', () => {
    expect(slug('Café résumé')).toBe('cafe-resume');
  });
  it('collapses punctuation and trims dashes', () => {
    expect(slug('  Hallo: Welt!! ')).toBe('hallo-welt');
  });
  it('returns empty for empty or symbol-only input', () => {
    expect(slug('')).toBe('');
    expect(slug('???')).toBe('');
  });
  it('caps at SLUG_MAX on a word boundary', () => {
    const s = slug('one two three four five six seven eight nine ten eleven twelve');
    expect(s.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(s.endsWith('-')).toBe(false);
    expect(s).toBe('one-two-three-four-five-six-seven-eight-nine-ten');
  });
  it('never cuts inside a word', () => {
    expect(slug('a'.repeat(40) + ' ' + 'b'.repeat(20))).toBe('a'.repeat(40));
  });
});

describe('isCanvasSlug', () => {
  it.each([
    ['masterarbeit', true],
    ['python-lernen', true],
    ['a/b', false],
    ['.hidden', false],
    ['Meine Arbeit', false],
    ['../esc', false],
    ['', false],
  ])('isCanvasSlug(%j) === %j', (input, expected) => {
    expect(isCanvasSlug(input)).toBe(expected);
  });
});

describe('newId / isUlid', () => {
  it('produces valid, monotonically increasing ULIDs', () => {
    const a = newId(1_000);
    const b = newId(1_000);
    const c = newId(2_000);
    expect(isUlid(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });
  it('rejects non-ULIDs', () => {
    expect(isUlid('nope')).toBe(false);
    expect(isUlid(A.toLowerCase())).toBe(false);
    expect(isUlid(42)).toBe(false);
  });
});

describe('isoTimestamp', () => {
  it('formats UTC without milliseconds', () => {
    expect(isoTimestamp(Date.UTC(2026, 2, 14, 10, 42, 3, 123))).toBe('2026-03-14T10:42:03Z');
  });
});

describe('nodeFileName', () => {
  it('joins id and slug', () => {
    expect(nodeFileName(A, 'Zentroid Ansatz')).toBe(`${A}-zentroid-ansatz.md`);
  });
  it('uses the bare id for an empty summary', () => {
    expect(nodeFileName(A, '')).toBe(`${A}.md`);
  });
});
