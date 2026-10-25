import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NODE_GAP, NODE_HEIGHT, NODE_WIDTH, childrenOf, columnLayout, placeAt, placeChild, placeNear, densestStrand, placeholderLayout, rectsOverlap, rootsOf, subtreeExtentRight, moveNodes } from '../src/layout';
import type { CanvasGraph, MessageNode } from '../src/types';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';

function node(over: Partial<MessageNode> & { id: string }): MessageNode {
  return { role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: '', ...over };
}

describe('columnLayout', () => {
  it('stacks nodes in one column with a gap', () => {
    expect(columnLayout([A, B])).toEqual(
      new Map([
        [A, { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT }],
        [B, { x: 0, y: NODE_HEIGHT + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT }],
      ]),
    );
  });
});

describe('placeholderLayout', () => {
  it('places a node below its first parent', () => {
    const layout = new Map([[A, { x: 100, y: 50, width: 400, height: 300 }]]);
    expect(placeholderLayout(node({ id: B, parents: [A] }), layout)).toEqual({ x: 100, y: 50 + 300 + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  it('falls back to the origin without a laid-out parent', () => {
    expect(placeholderLayout(node({ id: B, parents: [A] }), new Map())).toEqual({ x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(placeholderLayout(node({ id: A }), new Map())).toEqual({ x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT });
  });
});

function emptyGraph(): CanvasGraph {
  return { slug: 'm', nodes: new Map(), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
}
function add(g: CanvasGraph, id: string, parent: string | null): void {
  const layout = placeChild(g, parent);
  g.nodes.set(id, node({ id, parents: parent === null ? [] : [parent] }));
  g.layout.set(id, layout);
}
const ID = (n: number) => `01JQ8F${String(n).padStart(20, '0')}`; // 26 chars, sorts by n

describe('placeChild', () => {
  it('places the first root at the origin and later roots in the top row, right of everything', () => {
    const g = emptyGraph();
    expect(placeChild(g, null)).toEqual({ x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT });
    add(g, ID(1), null);
    add(g, ID(2), ID(1));
    add(g, ID(3), ID(2)); // a deep strand must not push the next root down
    expect(placeChild(g, null)).toEqual({ x: NODE_WIDTH + NODE_GAP, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT });
    add(g, ID(4), null);
    add(g, ID(5), ID(4));
    add(g, ID(6), ID(4)); // a wide strand: the next root goes right of its widest node
    expect(placeChild(g, null).x).toBe(3 * (NODE_WIDTH + NODE_GAP));
  });

  it('aligns later roots with the topmost existing root', () => {
    const g = emptyGraph();
    g.nodes.set(ID(1), node({ id: ID(1) }));
    g.layout.set(ID(1), { x: 0, y: -500, width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(placeChild(g, null).y).toBe(-500);
  });

  it('places the first child directly below the parent', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    expect(placeChild(g, ID(1))).toEqual({ x: 0, y: NODE_HEIGHT + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  it('places a second child right of the first child subtree', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    add(g, ID(2), ID(1));
    add(g, ID(3), ID(2)); // grandchild directly below child 2
    add(g, ID(4), ID(3));
    // extent of child-2 subtree is a single column: x+width = 400
    expect(placeChild(g, ID(1))).toEqual({ x: NODE_WIDTH + NODE_GAP, y: NODE_HEIGHT + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  it('fans further children out alternately right and left of the parent', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    const s = NODE_WIDTH + NODE_GAP;
    for (const [i, x] of [[2, 0], [3, s], [4, -s], [5, 2 * s], [6, -2 * s]] as const) {
      add(g, ID(i), ID(1));
      expect(g.layout.get(ID(i))!.x).toBe(x);
    }
  });

  it('does not start a branch directly below another node', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    add(g, ID(2), ID(1)); // x = 0
    add(g, ID(3), ID(1)); // x = +s, a leaf whose continuation slot must stay free
    add(g, ID(4), ID(2)); // x = 0, below ID(2)
    expect(placeChild(g, ID(2)).x).toBe(-(NODE_WIDTH + NODE_GAP));
  });

  it('keeps a new branch out of an existing strand below', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    add(g, ID(2), ID(1));
    // a foreign node two rows below the +s slot: that lane is taken, so the branch goes left
    g.nodes.set(ID(9), node({ id: ID(9) }));
    g.layout.set(ID(9), { x: NODE_WIDTH + NODE_GAP, y: 3 * (NODE_HEIGHT + NODE_GAP), width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(placeChild(g, ID(1)).x).toBe(-(NODE_WIDTH + NODE_GAP));
  });

  it('scans right when the slot collides with an unrelated node', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    // a foreign-positioned node occupying the first-child slot
    g.nodes.set(ID(9), node({ id: ID(9), parents: [] }));
    g.layout.set(ID(9), { x: 0, y: NODE_HEIGHT + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(placeChild(g, ID(1)).x).toBe(NODE_WIDTH + NODE_GAP);
  });

  it('throws when the parent has no layout', () => {
    const g = emptyGraph();
    g.nodes.set(ID(1), node({ id: ID(1) }));
    expect(() => placeChild(g, ID(1))).toThrow(/no layout/);
  });

  it('never overlaps and never moves existing nodes (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 50 }), { minLength: 1, maxLength: 40 }), (picks) => {
        const g = emptyGraph();
        let n = 0;
        for (const pick of picks) {
          const ids = [...g.nodes.keys()];
          const parent = ids.length === 0 || pick % 7 === 0 ? null : ids[pick % ids.length]!;
          const before = new Map([...g.layout].map(([k, v]) => [k, { ...v }]));
          add(g, ID(++n), parent);
          for (const [k, v] of before) expect(g.layout.get(k)).toEqual(v);
        }
        const rects = [...g.layout.values()];
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }),
    );
  });
});

describe('graph helpers', () => {
  it('childrenOf / rootsOf use the primary parent and sort by id', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    add(g, ID(3), ID(1));
    add(g, ID(2), ID(1));
    add(g, ID(4), null);
    expect(childrenOf(g, ID(1)).map((n) => n.id)).toEqual([ID(2), ID(3)]);
    expect(rootsOf(g).map((n) => n.id)).toEqual([ID(1), ID(4)]);
  });
  it('subtreeExtentRight covers descendants and tolerates cycles', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    add(g, ID(2), ID(1));
    add(g, ID(3), ID(1));
    expect(subtreeExtentRight(g, ID(1))).toBe(2 * NODE_WIDTH + NODE_GAP);
    g.nodes.get(ID(1))!.parents = [ID(3)]; // hand-edited cycle
    expect(subtreeExtentRight(g, ID(1))).toBe(2 * NODE_WIDTH + NODE_GAP);
  });
});

describe('moveNodes', () => {
  it('sets rounded x/y of known ids, keeps size, ignores unknown ids', () => {
    const layout = new Map([['a', { x: 0, y: 0, width: 400, height: 250 }]]);
    expect(moveNodes(layout, { a: { x: 10.6, y: -3.2 }, nope: { x: 1, y: 1 } })).toEqual(['a']);
    expect(layout.get('a')).toEqual({ x: 11, y: -3, width: 400, height: 250 });
    expect(layout.has('nope')).toBe(false);
  });
});

describe('placeNear (spec M14)', () => {
  const W = NODE_WIDTH + NODE_GAP; // one column
  const R = NODE_HEIGHT + NODE_GAP; // one row
  const at = (g: CanvasGraph, id: string, col: number, row: number) => { g.nodes.set(id, node({ id })); g.layout.set(id, { x: col * W, y: row * R, width: NODE_WIDTH, height: NODE_HEIGHT }); };
  const slot = (col: number, row: number) => ({ x: col * W, y: row * R, width: NODE_WIDTH, height: NODE_HEIGHT });

  it('goes right of the topic\'s cards at the height of their top card', () => {
    const g = emptyGraph();
    at(g, ID(1), 0, 0); at(g, ID(2), 0, 1); at(g, ID(3), 1, 2); // the topic: a strand that forks right
    at(g, ID(9), 5, 0); // another topic further right
    expect(placeNear(g, [ID(1), ID(2), ID(3)])).toEqual(slot(2, 0));
  });
  it('goes below the topic when the right is taken, a row further down while that is taken too', () => {
    const g = emptyGraph();
    at(g, ID(1), 0, 0); at(g, ID(2), 0, 1);
    at(g, ID(8), 1, 3); // blocks the lane right of the topic (rows 0–3)
    expect(placeNear(g, [ID(1), ID(2)])).toEqual(slot(0, 2));
    at(g, ID(7), 0, 5); // now the lane below (rows 2–5) is blocked as well
    expect(placeNear(g, [ID(1), ID(2)])).toEqual(slot(0, 6));
  });
  it('is null when none of the cards has a layout', () => {
    expect(placeNear(emptyGraph(), [ID(1)])).toBeNull();
  });
  it('densestStrand keeps the strand holding most of the cards, a tie going to the newest', () => {
    const g = emptyGraph();
    const put = (id: string, parent: string | null) => g.nodes.set(id, node({ id, parents: parent === null ? [] : [parent] }));
    put(ID(1), null); put(ID(2), ID(1)); put(ID(3), ID(2)); // strand 1
    put(ID(4), null); put(ID(5), ID(4)); // strand 4
    expect(densestStrand(g, [ID(1), ID(3), ID(5)])).toEqual([ID(1), ID(3)]);
    expect(densestStrand(g, [ID(2), ID(5)])).toEqual([ID(5)]);
    expect(densestStrand(g, [])).toEqual([]);
  });
});

describe('placeAt (spec M16 §3)', () => {
  const g = (rects: Record<string, { x: number; y: number }>) => ({ nodes: new Map(), layout: new Map(Object.entries(rects).map(([id, p]) => [id, { ...p, width: 400, height: 200 }])) });
  it('takes the wanted spot when it is clear', () => {
    expect(placeAt(g({ a: { x: 0, y: 0 } }), { x: 1000, y: 0 })).toEqual({ x: 1000, y: 0, width: 400, height: 200 });
  });
  it('moves to the nearest spot that keeps clear of existing cards', () => {
    const l = placeAt(g({ a: { x: 0, y: 0 } }), { x: 50, y: 20 });
    expect(rectsOverlap({ x: l.x - 40, y: l.y - 40, width: 480, height: 280 }, { x: 0, y: 0, width: 400, height: 200 })).toBe(false);
    expect(Math.hypot(l.x - 50, l.y - 20)).toBeLessThan(400);
  });
});
