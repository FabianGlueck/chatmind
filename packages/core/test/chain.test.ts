import { describe, expect, it } from 'vitest';
import { linearGraph } from '../src/chain';
import { isUlid } from '../src/ids';
import { NODE_GAP, NODE_HEIGHT } from '../src/layout';

describe('linearGraph', () => {
  const messages = [
    { role: 'user' as const, content: 'Frage', summary: 'Ursprungsfrage' },
    { role: 'assistant' as const, content: 'Antwort', model: 'claude-sonnet-4-6' },
    { role: 'user' as const, content: 'Danke' },
  ];

  it('chains messages by parents in order with increasing ids', () => {
    let t = Date.UTC(2026, 8, 11, 12, 0, 0);
    const g = linearGraph('masterarbeit', messages, () => (t += 1000));
    const ids = [...g.nodes.keys()];
    expect(ids).toHaveLength(3);
    expect(ids.every(isUlid)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    const [a, b, c] = ids as [string, string, string];
    expect(g.nodes.get(a)).toEqual({ id: a, role: 'user', parents: [], created: '2026-09-11T12:00:01Z', summary: 'Ursprungsfrage', topics: [], body: 'Frage' });
    expect(g.nodes.get(b)).toEqual({ id: b, role: 'assistant', model: 'claude-sonnet-4-6', parents: [a], created: '2026-09-11T12:00:02Z', summary: '', topics: [], body: 'Antwort' });
    expect(g.nodes.get(c)?.parents).toEqual([b]);
  });

  it('lays nodes out in a column and leaves paths empty', () => {
    const g = linearGraph('m', messages);
    const ids = [...g.nodes.keys()];
    expect(g.layout.get(ids[2]!)?.y).toBe(2 * (NODE_HEIGHT + NODE_GAP));
    expect(g.paths.size).toBe(0);
    expect(g.slug).toBe('m');
    expect(g.foreign).toEqual({ nodes: [], edges: [] });
  });

  it('ignores model on user messages', () => {
    const g = linearGraph('m', [{ role: 'user', content: 'x', model: 'gpt' }]);
    expect([...g.nodes.values()][0]?.model).toBeUndefined();
  });
});
