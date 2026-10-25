import { describe, expect, it } from 'vitest';
import { NOTE_HEADER, PREAMBLE, SYSTEM_PROMPT } from '../src/context';
import { EDIT_HEADER, EDIT_ROLE, buildEditContext, cleanRewrite, cleanSummaryInput } from '../src/edit';
import type { GraphLike } from '../src/graph-like';
import { MAX_BODY_CHARS, MAX_NOTE_CHARS } from '../src/note';
import { A, B, C, branchingGraph, node, sampleGraph } from './helpers';

const header = (lang: 'de' | 'en', role: 'user' | 'assistant' | 'note'): string => EDIT_HEADER[lang].replace('{role}', EDIT_ROLE[lang][role]);

describe('buildEditContext (spec M17 §3.3)', () => {
  it('an answer: its question as context, the edit request with the answer body last', () => {
    const ctx = buildEditContext(sampleGraph(), B, 'Kürzer, und ohne den zweiten Absatz bitte.');
    expect(ctx.system).toBe(SYSTEM_PROMPT);
    expect(ctx.language).toBe('de');
    expect(ctx.messages).toEqual([
      { role: 'user', content: 'Wie evaluiere ich Topic-Zuordnung?' },
      { role: 'user', content: `${header('de', 'assistant')}\n\n<<<\nZentroid statt Re-Clustering.\n\nBegründung folgt.\n>>>\n\nKürzer, und ohne den zweiten Absatz bitte.` },
    ]);
    expect(ctx.messages[1]!.content).toContain('diese Antwort');
  });

  it('a question under a merge: the parents enter as blocks, as for a reply to them', () => {
    const g = branchingGraph() as GraphLike & { nodes: Map<string, ReturnType<typeof node>> };
    g.nodes.set('M', node({ id: 'M', parents: ['U1b', 'A2'], body: 'combine them' }));
    const ctx = buildEditContext(g, 'M', 'make it a question about the structure');
    expect(ctx.language).toBe('en');
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]).toEqual({ role: 'user', content: 'root question' });
    const last = ctx.messages[1]!.content;
    expect(last.startsWith(PREAMBLE.en)).toBe(true);
    expect(last).toContain('## Gliederung');
    expect(last.endsWith(`${header('en', 'user')}\n\n<<<\ncombine them\n>>>\n\nmake it a question about the structure`)).toBe(true);
    expect(header('en', 'user')).toContain('this question');
  });

  it('a root note: no context, only the request', () => {
    const g = { nodes: new Map([['N', node({ id: 'N', role: 'note', body: 'The contract says three months.' })]]), layout: new Map() };
    const ctx = buildEditContext(g, 'N', 'add that it ends at the end of a month');
    expect(ctx.messages).toEqual([{ role: 'user', content: `${header('en', 'note')}\n\n<<<\nThe contract says three months.\n>>>\n\nadd that it ends at the end of a month` }]);
    expect(ctx.messages[0]!.content).not.toContain(NOTE_HEADER.en);
  });

  it('a draft replaces the body in the request and drives the language', () => {
    const ctx = buildEditContext(sampleGraph(), C, 'shorter', 'Thanks, that is the answer I was looking for.');
    expect(ctx.language).toBe('en');
    const last = ctx.messages[ctx.messages.length - 1]!.content;
    expect(last).toContain('<<<\nThanks, that is the answer I was looking for.\n>>>');
    expect(last).not.toContain('Danke.');
    expect(last.startsWith(header('en', 'user'))).toBe(true);
  });

  it('German headers name Frage/Antwort/Notiz, English question/answer/note', () => {
    expect(EDIT_ROLE.de).toEqual({ user: 'Frage', assistant: 'Antwort', note: 'Notiz' });
    expect(EDIT_ROLE.en).toEqual({ user: 'question', assistant: 'answer', note: 'note' });
    expect(buildEditContext(sampleGraph(), A, 'Mach das kürzer und klarer, bitte.').messages[0]!.content.startsWith(header('de', 'user'))).toBe(true);
  });

  it('throws on an unknown id', () => {
    expect(() => buildEditContext(sampleGraph(), 'nope', 'x')).toThrow(/unknown node/);
  });
});

describe('cleanRewrite (spec M17 §4)', () => {
  it('trims and strips echoed markers, otherwise leaves the text alone', () => {
    expect(cleanRewrite('  plain text \n')).toBe('plain text');
    expect(cleanRewrite('<<<\nnew text\n>>>')).toBe('new text');
    expect(cleanRewrite('\n<<<  \nnew\n\ntext\n  >>>\n')).toBe('new\n\ntext');
    expect(cleanRewrite('<<<\nonly leading')).toBe('only leading');
    expect(cleanRewrite('a <<< b >>> c')).toBe('a <<< b >>> c');
    expect(cleanRewrite('<<<\n>>>')).toBe('');
  });
});

describe('MAX_BODY_CHARS', () => {
  it('is the old note limit under a new name', () => {
    expect(MAX_BODY_CHARS).toBe(400_000);
    expect(MAX_NOTE_CHARS).toBe(MAX_BODY_CHARS);
  });
});

describe('cleanSummaryInput (spec M17 §6)', () => {
  it('makes one trimmed line', () => {
    expect(cleanSummaryInput('  Zentroid\n statt   Re-Clustering \t')).toBe('Zentroid statt Re-Clustering');
    expect(cleanSummaryInput(' \n ')).toBe('');
  });
});
