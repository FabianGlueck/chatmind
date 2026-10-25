import { describe, expect, it } from 'vitest';
import { OUTPUT_RESERVE, budgetFor, estimateTokens, formatTokens, promptTokens } from '../src/tokens';

describe('tokens', () => {
  it('estimates ceil(len / 3.5)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('x'.repeat(35))).toBe(10);
    expect(estimateTokens('x'.repeat(36))).toBe(11);
  });
  it('counts the rendered prompt with a per-message overhead', () => {
    expect(promptTokens({ system: 'x'.repeat(35), messages: [{ content: 'x'.repeat(7) }, { content: '' }] })).toBe(10 + (2 + 4) + (0 + 4));
  });
  it('subtracts the output reserve, never below 1', () => {
    expect(OUTPUT_RESERVE).toBe(16_000);
    expect(budgetFor(200_000)).toBe(184_000);
    expect(budgetFor(100)).toBe(1);
  });
  it('formats compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(9_960)).toBe('10.0k');
    expect(formatTokens(184_000)).toBe('184k');
    expect(formatTokens(1_048_576)).toBe('1049k');
  });
});
