import { describe, expect, it } from 'vitest';
import { nodeTitle } from '../src/title';

describe('nodeTitle', () => {
  it('prefers the summary, capped at 80 chars like the body fallback', () => {
    expect(nodeTitle({ summary: 'S', body: 'B' })).toBe('S');
    expect(nodeTitle({ summary: 's'.repeat(100), body: 'B' })).toBe('s'.repeat(79) + '…');
  });
  it('falls back to the first non-empty body line, capped at 80 chars', () => {
    expect(nodeTitle({ summary: '', body: '\n\nErste Zeile\nZweite' })).toBe('Erste Zeile');
    expect(nodeTitle({ summary: '', body: 'x'.repeat(100) })).toBe('x'.repeat(79) + '…');
  });
  it('leaves attachment embeds out, naming a body of images only (spec M13)', () => {
    const img = '![[01JQ7M2V3X4Y5Z6A7B8C9D0E1F.png]]';
    expect(nodeTitle({ summary: '', body: `${img}\n\nWas ist das?` })).toBe('Was ist das?');
    expect(nodeTitle({ summary: '', body: img })).toBe('🖼 Image');
    expect(nodeTitle({ summary: '', body: `${img}\n${img}` })).toBe('🖼 2 images');
  });
  it('is "(empty)" for an empty message', () => expect(nodeTitle({ summary: '', body: '  ' })).toBe('(empty)'));
});
