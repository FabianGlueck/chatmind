import { describe, expect, it } from 'vitest';
import { NOTE_HEADER, ROLE_LABELS, buildContext } from '../src/context';
import { compressionSections } from '../src/compress';
import { spliceOut, turnOf } from '../src/delete';
import { parseNodeFile, serializeNodeFile } from '../src/frontmatter';
import type { CanvasGraph } from '../src/types';
import { A, B, C, node } from './helpers';

const N = '01JQ8F1A0B1C2D3E4F5G6H7JNN';
const D = '01JQ8F5A0B1C2D3E4F5G6H7JDD';

/** Spec M16: note N ← question A ← answer B ← question C. */
function noteGraph(): CanvasGraph {
  const nodes = [
    node({ id: N, role: 'note', body: 'Vertragstext: Kündigung mit drei Monaten Frist.' }),
    node({ id: A, parents: [N], body: 'Wie lange ist die Frist?' }),
    node({ id: B, role: 'assistant', model: 'm', parents: [A], body: 'Drei Monate.' }),
    node({ id: C, parents: [B], body: 'Und zum Monatsende?' }),
  ];
  return { slug: 'c', nodes: new Map(nodes.map((n) => [n.id, n])), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
}

describe('note files (spec M16 §2)', () => {
  it('round-trips role: note without a model', () => {
    const text = serializeNodeFile(node({ id: N, role: 'note', model: 'x', body: 'Text' }), 'c');
    expect(text).toContain('role: note\nparents: []');
    expect(text).not.toContain('model');
    const r = parseNodeFile(text);
    expect(r.ok && r.node.role).toBe('note');
    expect(r.ok && r.defaulted).toEqual([]);
  });

  it('still defaults other unknown roles to user', () => {
    const r = parseNodeFile(`---\nid: ${N}\nrole: system\nparents: []\ncreated: x\nsummary: ''\ntopics: []\n---\n`);
    expect(r.ok && r.node.role).toBe('user');
    expect(r.ok && r.defaulted).toEqual(['role']);
  });
});

describe('buildContext with notes (spec M16 §4)', () => {
  it('a note in the chain is a user message under the header', () => {
    const { messages } = buildContext(noteGraph(), [C], [], 'Genau?');
    expect(messages).toEqual([
      { role: 'user', content: `${NOTE_HEADER.de}\n\nVertragstext: Kündigung mit drei Monaten Frist.` },
      { role: 'user', content: 'Wie lange ist die Frist?' },
      { role: 'assistant', content: 'Drei Monate.' },
      { role: 'user', content: 'Und zum Monatsende?' },
      { role: 'user', content: 'Genau?' },
    ]);
  });

  it('a note as the direct target, header in the language of the conversation', () => {
    const g = noteGraph();
    g.nodes.get(N)!.body = 'The contract says three months.';
    const { messages } = buildContext(g, [N], [], 'What does it say about notice?');
    expect(messages).toEqual([
      { role: 'user', content: `${NOTE_HEADER.en}\n\nThe contract says three months.` },
      { role: 'user', content: 'What does it say about notice?' },
    ]);
  });

  it('a note merged with an answer renders under its role label in the block', () => {
    const g = noteGraph();
    g.nodes.set(D, node({ id: D, role: 'note', summary: 'Zweite Notiz', body: 'Noch ein Text.' }));
    const { messages } = buildContext(g, [B, D], [], 'Vergleiche.');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain(`## Zweite Notiz\n**${ROLE_LABELS.de.note}:** Noch ein Text.`);
    expect(messages[0]!.content).toContain(`**${ROLE_LABELS.de.note}:** Vertragstext`);
  });
});

describe('delete and compress with notes (spec M16 §5)', () => {
  it('a note is a turn of its own; the questions docked to it become roots', () => {
    const g = noteGraph();
    expect(turnOf(g, N)).toEqual([N]);
    expect(spliceOut(g, new Set([N]))).toEqual(new Map([[A, []]]));
  });

  it('a note is never part of a compressed section', () => {
    const g = noteGraph();
    g.nodes.set(D, node({ id: D, role: 'assistant', model: 'm', parents: [C], body: 'Ja.' }));
    const sections = compressionSections(g, [N, A, B, C, D]);
    expect(sections.map((s) => s.turns)).toEqual([[[A, B], [C, D]]]);
  });
});
