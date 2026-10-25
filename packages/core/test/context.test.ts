import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PREAMBLE, ROLE_LABELS, SYSTEM_PROMPT, ancestorChain, blockLabels, buildContext, contextSet } from '../src/context';
import type { GraphLike, NodeLike } from '../src/graph-like';
import type { CanvasGraph } from '../src/types';
import { A, B, C, branchingGraph, node, sampleGraph } from './helpers';

describe('ancestorChain', () => {
  it('follows the primary parent for merge nodes and stops at unknown parents', () => {
    const g: CanvasGraph = sampleGraph();
    const M = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    g.nodes.set(M, node({ id: M, role: 'assistant', parents: [B, C], body: 'merged' }));
    expect(ancestorChain(g, M).map((n) => n.id)).toEqual([A, B, M]);
    g.nodes.get(A)!.parents = ['01JQ8F9ZZZZZZZZZZZZZZZZZZZ'];
    expect(ancestorChain(g, M).map((n) => n.id)).toEqual([A, B, M]);
  });

  it('tolerates cycles', () => {
    const g = sampleGraph();
    g.nodes.get(A)!.parents = [C];
    expect(ancestorChain(g, C).map((n) => n.id)).toEqual([A, B, C]);
  });
});

describe('buildContext', () => {
  it('root message: system prompt and only the instruction', () => {
    expect(buildContext(sampleGraph(), [], [], 'Neu')).toEqual({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'Neu' }], language: 'en' });
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}|01JQ/);
  });

  it('single target is byte-identical to the M3 prompt: chain root→target, then the instruction', () => {
    const { messages } = buildContext(sampleGraph(), [C], [], 'Und weiter?');
    expect(messages).toEqual([
      { role: 'user', content: 'Wie evaluiere ich Topic-Zuordnung?' },
      { role: 'assistant', content: 'Zentroid statt Re-Clustering.\n\nBegründung folgt.' },
      { role: 'user', content: 'Danke.' },
      { role: 'user', content: 'Und weiter?' },
    ]);
  });

  it('single target with an excluded ancestor drops that turn', () => {
    const { messages } = buildContext(sampleGraph(), [C], [B], 'x');
    expect(messages.map((m) => m.content)).toEqual(['Wie evaluiere ich Topic-Zuordnung?', 'Danke.', 'x']);
  });

  it('two targets: prefix turns, then one user turn with preamble, labelled blocks in target order, instruction last', () => {
    const { messages, language } = buildContext(branchingGraph(), ['U1b', 'A2'], [], 'Make a structure proposal from the outline and the content.');
    expect(language).toBe('en');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: 'root question' });
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toBe(
      [
        PREAMBLE.en,
        '## Gliederung\n**User:** u1\n\n**Assistant:** a1\n\n**User:** u1b',
        '## Erste Zeile\n**User:** u2\n\n**Assistant:** Erste Zeile\nZweite Zeile',
        'Make a structure proposal from the outline and the content.',
      ].join('\n\n'),
    );
  });

  it('two targets without a common root: no prefix turns', () => {
    const { messages } = buildContext(branchingGraph(), ['A1', 'Y'], [], 'go');
    expect(messages).toHaveLength(1);
    // A1 and Y have no summary → labels come from the body title
    expect(messages[0]!.content).toContain('## a1\n**User:** root question\n\n**User:** u1\n\n**Assistant:** a1');
    expect(messages[0]!.content).toContain('## y\n**User:** x\n\n**Assistant:** y');
  });

  it('excluded nodes are absent from prefix and blocks', () => {
    const { messages } = buildContext(branchingGraph(), ['U1b', 'A2'], ['R', 'A1'], 'go');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).not.toContain('root question');
    expect(messages[0]!.content).toContain('## Gliederung\n**User:** u1\n\n**User:** u1b');
  });

  it('switches preamble and role labels to German by content', () => {
    const g = branchingGraph();
    g.nodes.get('U1')!.body = 'Die Gliederung ist nicht fertig und das Kapitel fehlt.';
    const { messages, language } = buildContext(g, ['U1b', 'A2'], [], 'Mach mir einen Vorschlag für die Struktur.');
    expect(language).toBe('de');
    expect(messages[1]!.content.startsWith(PREAMBLE.de)).toBe(true);
    expect(messages[1]!.content).toContain(`**${ROLE_LABELS.de.user}:** u1b`);
    expect(messages[1]!.content).toContain(`**${ROLE_LABELS.de.assistant}:** a1`);
  });

  it('property: every non-excluded node of the set appears exactly once, excluded ones never', () => {
    // random trees: node i's primary parent is some j < i or none
    const treeArb = fc.integer({ min: 2, max: 9 }).chain((n) =>
      fc.tuple(...Array.from({ length: n }, (_, i) => (i === 0 ? fc.constant(-1) : fc.integer({ min: -1, max: i - 1 })))),
    );
    fc.assert(
      fc.property(treeArb, fc.array(fc.nat(8), { minLength: 1, maxLength: 4 }), fc.array(fc.nat(8), { maxLength: 3 }), (parents, rawTargets, rawExcluded) => {
        // summaries keep the body marker out of the block labels, so a target's marker appears only in its turn
        const ns: NodeLike[] = parents.map((p, i) => node({ id: `N${i}`, role: i % 2 === 0 ? 'user' : 'assistant', parents: p < 0 ? [] : [`N${p}`], body: `BODY-N${i}-END`, summary: `S${i}` }));
        const g: GraphLike = { nodes: new Map(ns.map((n) => [n.id, n])), layout: new Map() };
        // targets: distinct, none an ancestor of another (drop offenders)
        const targets: string[] = [];
        for (const t of [...new Set(rawTargets.map((i) => `N${i % parents.length}`))]) {
          if (!targets.some((o) => ancestorChain(g, t).some((n) => n.id === o) || ancestorChain(g, o).some((n) => n.id === t))) targets.push(t);
        }
        const set = contextSet(g, targets, []);
        const excluded = [...new Set(rawExcluded.map((i) => `N${i % parents.length}`))].filter((e) => set.all.has(e) && !targets.includes(e));
        const text = buildContext(g, targets, excluded, 'INSTR').messages.map((m) => m.content).join('\n');
        for (const id of set.all) {
          const count = text.split(`BODY-${id}-END`).length - 1;
          expect(count).toBe(excluded.includes(id) ? 0 : 1);
        }
      }),
    );
  });
});

describe('blockLabels', () => {
  it('uses summary, then the body title, then a numbered fallback; disambiguates duplicates; flattens newlines', () => {
    const t = (id: string, summary: string, body: string): NodeLike => ({ id, role: 'user', parents: [], summary, body });
    expect(blockLabels([t('a', 'Gliederung', 'x'), t('b', '', 'Erste\nZweite'), t('c', '', '  ')], 'de')).toEqual(['Gliederung', 'Erste', 'Zweig 3']);
    expect(blockLabels([t('a', '', ''), t('b', '', '')], 'en')).toEqual(['Branch 1', 'Branch 2']);
    expect(blockLabels([t('a', 'Same', ''), t('b', 'Same', ''), t('c', 'Same', '')], 'en')).toEqual(['Same', 'Same (2)', 'Same (3)']);
    expect(blockLabels([t('a', 'Zwei\n  Zeilen', '')], 'en')).toEqual(['Zwei Zeilen']);
  });
});
