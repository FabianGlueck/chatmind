import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/context';
import { EXPLAIN_DEFAULT, EXPLAIN_HEADER, MAX_EXPLAIN_SELECTION, buildExplainContext, explainQuestion } from '../src/explain';
import { B, sampleGraph } from './helpers';

describe('buildExplainContext (spec quick-explain §3)', () => {
  it('the strand down to and including the card, then one request quoting the selection and its sentence', () => {
    const ctx = buildExplainContext(sampleGraph(), B, { selection: 'Zentroid', passage: 'Zentroid statt Re-Clustering.', exchange: [], ask: '' });
    expect(ctx.system).toBe(SYSTEM_PROMPT);
    expect(ctx.language).toBe('de');
    expect(ctx.messages.slice(0, 2)).toEqual([
      { role: 'user', content: 'Wie evaluiere ich Topic-Zuordnung?' },
      { role: 'assistant', content: 'Zentroid statt Re-Clustering.\n\nBegründung folgt.' },
    ]);
    expect(ctx.messages[2]).toEqual({ role: 'user', content: `${EXPLAIN_HEADER.de}\n\nStelle: »Zentroid«\nIm Satz: »Zentroid statt Re-Clustering.«\n\n${EXPLAIN_DEFAULT.de}` });
  });

  it('follow-ups continue the exchange; the passage is dropped when it is the selection itself', () => {
    const ctx = buildExplainContext(sampleGraph(), B, { selection: 'Re-Clustering', passage: 'Re-Clustering', exchange: [{ q: 'was ist das?', a: 'Neu gruppieren.' }], ask: 'und warum nicht?' });
    expect(ctx.messages.slice(2)).toEqual([
      { role: 'user', content: `${EXPLAIN_HEADER.de}\n\nStelle: »Re-Clustering«\n\nwas ist das?` },
      { role: 'assistant', content: 'Neu gruppieren.' },
      { role: 'user', content: 'und warum nicht?' },
    ]);
  });

  it('throws on an unknown id and caps the selection', () => {
    expect(() => buildExplainContext(sampleGraph(), 'nope', { selection: 'x', exchange: [], ask: '' })).toThrow();
    expect(MAX_EXPLAIN_SELECTION).toBeGreaterThan(100);
  });
});

describe('explainQuestion', () => {
  it('turns a kept explanation into a question that names the selection', () => {
    expect(explainQuestion('de', 'Zentroid', '')).toBe('»Zentroid« — Was bedeutet das hier?');
    expect(explainQuestion('en', 'centroid', 'why?')).toBe('»centroid« — why?');
  });
});
