import { describe, expect, it } from 'vitest';
import { allLinks, linkSpace, mutualLinks, vaultLinks, LINK_K, T_LINK } from '../src/links';
import { describeLinkSettings, DEFAULT_LINK_SETTINGS, linkSettings } from '../src/link-settings';

const v = (...xs: number[]): Float32Array => Float32Array.from(xs);
const none = (): ReadonlySet<string> => new Set();
const S = { k: 2, tMin: 0 };

/** Four participants in 3-d, no centring (fewer than MIN_CENTER vectors): P≈Q, R≈S, P/R far apart. */
function space4() {
  const vecs = new Map([
    ['P', v(1, 0.1, 0)],
    ['Q', v(1, 0.2, 0)],
    ['R', v(0, 1, 0.1)],
    ['S', v(0, 1, 0.2)],
  ]);
  return linkSpace(vecs, vecs.keys(), 3);
}

describe('linkSpace (spec M7 §4)', () => {
  it('keeps only participants and normalises them', () => {
    const vecs = new Map([['A', v(3, 4)], ['U', v(1, 0)]]);
    const s = linkSpace(vecs, ['A', 'missing'], 2);
    expect([...s.vecs.keys()]).toEqual(['A']);
    const a = s.vecs.get('A')!;
    expect(a[0]).toBeCloseTo(0.6);
    expect(a[1]).toBeCloseTo(0.8);
  });

  it('centres on the mean of every stored vector, participants or not, from MIN_CENTER on', () => {
    // Eight vectors all sharing a big common component along x; centred, A and B point in opposite directions.
    const vecs = new Map<string, Float32Array>([['A', v(10, 1)], ['B', v(10, -1)]]);
    for (let i = 0; i < 6; i++) vecs.set(`U${i}`, v(10, 0));
    const s = linkSpace(vecs, ['A', 'B'], 2);
    const [a, b] = [s.vecs.get('A')!, s.vecs.get('B')!];
    expect(a[0]! * b[0]! + a[1]! * b[1]!).toBeCloseTo(-1);
    const raw = linkSpace(new Map([['A', v(10, 1)], ['B', v(10, -1)]]), ['A', 'B'], 2); // below MIN_CENTER: no centring
    const [ra, rb] = [raw.vecs.get('A')!, raw.vecs.get('B')!];
    expect(ra[0]! * rb[0]! + ra[1]! * rb[1]!).toBeGreaterThan(0.9);
  });
});

describe('mutualLinks (spec M7 §4)', () => {
  it('links mutual nearest neighbours, sorted by similarity', () => {
    const got = mutualLinks('P', space4(), none, { k: 1, tMin: 0 });
    expect(got.map((l) => l.id)).toEqual(['Q']);
    expect(got[0]!.sim).toBeGreaterThan(0.9);
  });

  it('a one-sided neighbour is no link', () => {
    // T's nearest are Q and P, but each of them has two closer neighbours than T.
    const vecs = new Map([['P', v(1, 0, 0)], ['Q', v(1, 0.05, 0)], ['T2', v(1, 0, 0.05)], ['T', v(0.6, 0.8, 0)], ['Z', v(0, 0, 1)]]);
    const s = linkSpace(vecs, vecs.keys(), 3);
    expect(mutualLinks('T', s, none, S)).toEqual([]);
    expect(mutualLinks('P', s, none, S).map((l) => l.id).sort()).toEqual(['Q', 'T2']);
  });

  it('a mutual neighbour below tMin is no link', () => {
    expect(mutualLinks('P', space4(), none, { k: 3, tMin: 0.5 }).map((l) => l.id)).toEqual(['Q']);
    expect(mutualLinks('P', space4(), none, { k: 3, tMin: -1 }).map((l) => l.id)).toEqual(['Q', 'R', 'S']);
  });

  it('excluded nodes take no kNN place, on either side', () => {
    // Q is structural for P: excluded before the search, so P's k=1 slot goes to the next best, R.
    const ex = (id: string): ReadonlySet<string> => (id === 'P' ? new Set(['P', 'Q']) : id === 'Q' ? new Set(['Q', 'P']) : new Set([id]));
    const s = linkSpace(new Map([['P', v(1, 0, 0)], ['Q', v(1, 0.1, 0)], ['R', v(1, -0.3, 0)], ['Z', v(0, 0, 1)]]), ['P', 'Q', 'R', 'Z'], 3);
    expect(mutualLinks('P', s, ex, { k: 1, tMin: -1 }).map((l) => l.id)).toEqual(['R']);
  });

  it('a query that is not a participant has no links', () => {
    expect(mutualLinks('nope', space4(), none, S)).toEqual([]);
  });

  it('allLinks lists every mutual pair once, strongest first', () => {
    const pairs = allLinks(space4(), none, { k: 1, tMin: 0 });
    expect(pairs.map((p) => [p.a, p.b].sort().join('-')).sort()).toEqual(['P-Q', 'R-S']);
    expect(pairs[0]!.sim).toBeGreaterThanOrEqual(pairs[1]!.sim);
  });
});

describe('hub correction (spec M7 §4, amended 2026-09-24)', () => {
  // H sits between A, B and C (cos 0.58 to each); P and Q are a pair of their own at the same raw cos 0.58.
  const s = 1 / Math.sqrt(3);
  const vecs = new Map([
    ['H', v(1, 1, 1, 0, 0)],
    ['A', v(1, 0, 0, 0, 0)],
    ['B', v(0, 1, 0, 0, 0)],
    ['C', v(0, 0, 1, 0, 0)],
    ['P', v(0, 0, 0, 1, 0)],
    ['Q', v(0, 0, 0, s, Math.sqrt(1 - s * s))],
  ]);
  const space = () => linkSpace(vecs, vecs.keys(), 5);
  const S2 = { k: 2, tMin: 0.3 };

  it('a hub\'s links count less than an equally similar distinctive pair', () => {
    const pq = mutualLinks('P', space(), none, S2);
    expect(pq.map((l) => l.id)).toEqual(['Q']);
    expect(pq[0]!.sim).toBeCloseTo(s);
    // r(P) = r(Q) = mean(s, 0) → score = 2s − s = s
    expect(pq[0]!.score).toBeCloseTo(s);
    // r(H) = s, r(A) = s / 2 → score = 2s − 1.5s = 0.29 < 0.3: mutual neighbours, yet no link
    expect(mutualLinks('H', space(), none, S2)).toEqual([]);
    expect(mutualLinks('A', space(), none, { k: 2, tMin: 0.28 }).map((l) => [l.id, +l.score.toFixed(3)])).toEqual([['H', +(s / 2).toFixed(3)]]);
  });

  it('across canvases the raw similarity counts — the shared theme is the news there (amended 2026-09-24)', () => {
    // Same vectors, but A lives in another canvas: H ↔ A is no longer discounted.
    const group = new Map([['H', 'c1'], ['A', 'c2'], ['B', 'c1'], ['C', 'c1'], ['P', 'c1'], ['Q', 'c1']]);
    const grouped = { ...space(), group };
    const ha = mutualLinks('H', grouped, none, S2);
    expect(ha.map((l) => l.id)).toEqual(['A']);
    expect(ha[0]!.score).toBeCloseTo(s); // = sim
    expect(allLinks(grouped, none, S2).map((p) => `${p.a}-${p.b}`).sort()).toEqual(['A-H', 'P-Q']); // equal scores: order is float noise
  });

  it('allLinks applies the same score', () => {
    const pairs = allLinks(space(), none, S2);
    expect(pairs.map((p) => [p.a, p.b])).toEqual([['P', 'Q']]);
    expect(pairs[0]!.score).toBeCloseTo(s);
    expect(pairs[0]!.sim).toBeCloseTo(s);
  });
});

describe('linkSettings (spec M7 §4)', () => {
  it('defaults to the constants', () => {
    expect(linkSettings({})).toEqual(DEFAULT_LINK_SETTINGS);
    expect(DEFAULT_LINK_SETTINGS).toEqual({ k: LINK_K, tMin: T_LINK });
  });

  it('reads k and the threshold from the environment', () => {
    expect(linkSettings({ CHATMIND_LINK_K: '8', CHATMIND_LINK_MIN: '0.4' })).toEqual({ k: 8, tMin: 0.4 });
    expect(linkSettings({ CHATMIND_LINK_MIN: '-0.2' }).tMin).toBe(-0.2);
  });

  it('falls back to the default for nonsense and out-of-range values', () => {
    for (const bad of ['', 'x', '0', '51', '2.5', '-3']) expect(linkSettings({ CHATMIND_LINK_K: bad }).k).toBe(LINK_K);
    for (const bad of ['', 'x', '1.5', '-2', 'NaN']) expect(linkSettings({ CHATMIND_LINK_MIN: bad }).tMin).toBe(T_LINK);
  });

  it('describeLinkSettings names only what differs from the default', () => {
    expect(describeLinkSettings(DEFAULT_LINK_SETTINGS)).toBeNull();
    expect(describeLinkSettings({ k: 8, tMin: T_LINK })).toBe(`k 8 (default ${LINK_K})`);
  });
});

describe('vaultLinks (spec M7 §4)', () => {
  it('keeps assistant nodes with a vector, knows their canvas and excludes their structure', async () => {
    const { linearGraph } = await import('@chatmind/core');
    const g = linearGraph('m', [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'b' }]);
    const [U, A, , B] = [...g.nodes.keys()] as [string, string, string, string];
    const all = linkSpace(new Map([[U, v(1, 0)], [A, v(1, 0)], [B, v(0, 1)]]), [U, A, B], 2);
    const vl = vaultLinks([g], all);
    expect([...vl.space.vecs.keys()]).toEqual([A, B]);
    expect(vl.owner.get(A)!.slug).toBe('m');
    expect(vl.excluded(A).has(B)).toBe(true);
    expect(vl.space.vecs.get(A)).toBe(all.vecs.get(A)); // shared, not copied
  });

  it('notes take part with their own vector (spec M16 §5)', async () => {
    const { linearGraph } = await import('@chatmind/core');
    const g = linearGraph('m', [{ role: 'note', content: 'n' }, { role: 'user', content: 'u' }]);
    const [N, U] = [...g.nodes.keys()] as [string, string];
    const vl = vaultLinks([g], linkSpace(new Map([[N, v(1, 0)], [U, v(0, 1)]]), [N, U], 2));
    expect([...vl.space.vecs.keys()]).toEqual([N]);
  });
});
