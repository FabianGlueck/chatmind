import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deleteSet, spliceOut, turnOf } from '../src/delete';
import type { GraphLike, NodeLike } from '../src/graph-like';
import { node } from './helpers';

function graph(ns: NodeLike[]): GraphLike {
  return { nodes: new Map(ns.map((n) => [n.id, n])), layout: new Map() };
}

// Q1 → A1 → Q2 → A2 → Q3 → A3, plus a branch A1 → Q2b → A2b
const chain = (): GraphLike =>
  graph([
    node({ id: 'Q1' }),
    node({ id: 'A1', role: 'assistant', parents: ['Q1'] }),
    node({ id: 'Q2', parents: ['A1'] }),
    node({ id: 'A2', role: 'assistant', parents: ['Q2'] }),
    node({ id: 'Q3', parents: ['A2'] }),
    node({ id: 'A3', role: 'assistant', parents: ['Q3'] }),
    node({ id: 'Q2b', parents: ['A1'] }),
    node({ id: 'A2b', role: 'assistant', parents: ['Q2b'] }),
  ]);

describe('turnOf', () => {
  it('a question takes its answer along', () => expect(turnOf(chain(), 'Q2')).toEqual(['Q2', 'A2']));
  it('an answer takes its question along', () => expect(turnOf(chain(), 'A2')).toEqual(['Q2', 'A2']));
  it('a question with two answers takes both', () => {
    const g = graph([node({ id: 'Q' }), node({ id: 'B', role: 'assistant', parents: ['Q'] }), node({ id: 'A', role: 'assistant', parents: ['Q'] })]);
    expect(turnOf(g, 'Q')).toEqual(['Q', 'A', 'B']);
  });
  it('a root assistant stands alone', () => expect(turnOf(graph([node({ id: 'A', role: 'assistant' })]), 'A')).toEqual(['A']));
  it('an unanswered question stands alone', () => expect(turnOf(graph([node({ id: 'Q' })]), 'Q')).toEqual(['Q']));
  it('unknown id: empty', () => expect(turnOf(chain(), 'nope')).toEqual([]));
});

describe('deleteSet', () => {
  it('unions the turns', () => expect(deleteSet(chain(), ['A2', 'Q3'])).toEqual(new Set(['Q2', 'A2', 'Q3', 'A3'])));
});

describe('spliceOut', () => {
  it('a middle turn: the next question hangs on the previous answer', () => {
    expect(spliceOut(chain(), deleteSet(chain(), ['Q2']))).toEqual(new Map([['Q3', ['A1']]]));
  });
  it('two consecutive turns collapse to the nearest survivor', () => {
    expect(spliceOut(chain(), deleteSet(chain(), ['Q2', 'Q3']))).toEqual(new Map());
    const g = chain();
    const withQ4 = graph([...g.nodes.values(), node({ id: 'Q4', parents: ['A3'] })]);
    expect(spliceOut(withQ4, deleteSet(withQ4, ['Q2', 'Q3']))).toEqual(new Map([['Q4', ['A1']]]));
  });
  it('a branch point: every child is reparented', () => {
    expect(spliceOut(chain(), deleteSet(chain(), ['Q1']))).toEqual(new Map([['Q2', []], ['Q2b', []]]));
  });
  it('a deleted merge: the child inherits both parents in order', () => {
    const g = graph([
      node({ id: 'P1', role: 'assistant' }),
      node({ id: 'P2', role: 'assistant' }),
      node({ id: 'M', parents: ['P2', 'P1'] }),
      node({ id: 'AM', role: 'assistant', parents: ['M'] }),
      node({ id: 'N', parents: ['AM', 'P1'] }),
    ]);
    expect(spliceOut(g, deleteSet(g, ['M']))).toEqual(new Map([['N', ['P2', 'P1']]]));
  });
  it('dangling parents stay', () => {
    const g = graph([node({ id: 'Q', parents: ['gone'] }), node({ id: 'A', role: 'assistant', parents: ['Q'] }), node({ id: 'N', parents: ['A', 'gone2'] })]);
    expect(spliceOut(g, deleteSet(g, ['Q']))).toEqual(new Map([['N', ['gone', 'gone2']]]));
  });

  it('property: no survivor names a deleted id; surviving assistants keep exactly their one parent', () => {
    // Random chat graph: node i is a question (parents among earlier answers, or root) or an answer to an earlier question.
    const arbGraph = fc.array(fc.tuple(fc.boolean(), fc.array(fc.nat(), { maxLength: 3 })), { minLength: 1, maxLength: 25 }).map((spec) => {
      const ns: NodeLike[] = [];
      spec.forEach(([answer, picks], i) => {
        const id = `n${String(i).padStart(2, '0')}`;
        const questions = ns.filter((n) => n.role === 'user');
        const answers = ns.filter((n) => n.role === 'assistant');
        if (answer && questions.length > 0) ns.push(node({ id, role: 'assistant', parents: [questions[(picks[0] ?? 0) % questions.length]!.id] }));
        else ns.push(node({ id, parents: answers.length === 0 ? [] : [...new Set(picks.map((p) => answers[p % answers.length]!.id))] }));
      });
      return graph(ns);
    });
    fc.assert(
      fc.property(arbGraph, fc.array(fc.nat()), (g, picks) => {
        const ids = [...g.nodes.keys()];
        const deleted = deleteSet(g, picks.map((p) => ids[p % ids.length]!));
        const changed = spliceOut(g, deleted);
        for (const n of g.nodes.values()) {
          if (deleted.has(n.id)) continue;
          const parents = changed.get(n.id) ?? n.parents;
          expect(parents.some((p) => deleted.has(p))).toBe(false);
          expect(new Set(parents).size).toBe(parents.length);
          if (n.role === 'assistant') expect(changed.has(n.id)).toBe(false);
        }
      }),
    );
  });
});
