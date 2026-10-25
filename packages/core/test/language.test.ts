import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/language';

describe('detectLanguage', () => {
  it('detects German by stopword majority', () => {
    expect(detectLanguage(['Die Gliederung ist nicht fertig und das Kapitel fehlt.'])).toBe('de');
  });
  it('detects English by stopword majority', () => {
    expect(detectLanguage(['The outline is not finished and the chapter is missing.'])).toBe('en');
  });
  it('defaults to English on empty input and ties', () => {
    expect(detectLanguage([])).toBe('en');
    expect(detectLanguage(['', '   '])).toBe('en');
    expect(detectLanguage(['der the'])).toBe('en');
  });
  it('pools several texts and ignores case', () => {
    expect(detectLanguage(['DER', 'DIE', 'the'])).toBe('de');
  });
});
