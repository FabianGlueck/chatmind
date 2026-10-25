import { describe, expect, it } from 'vitest';
import { ASSIGN_MARGIN, INHERIT_MARGIN, MIN_CENTER, T_ASSIGN, T_INHERIT, TopicCentroids, assignTopic, centre, cosine, meanVector } from '../src/topics';
import { TOPIC_MAX, TOPIC_SYSTEM, cleanTopic, foldTopic, topicKey, topicPrompt } from '../src/topics';

const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe('vector helpers (spec M6 §4)', () => {
  it('meanVector averages, null when empty', () => {
    expect(Array.from(meanVector([v(1, 0), v(3, 2)], 2)!)).toEqual([2, 1]);
    expect(meanVector([], 2)).toBeNull();
  });
  it('cosine is 1 for parallel, 0 for orthogonal, 0 when a norm is zero', () => {
    expect(cosine(v(1, 0), v(2, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0), v(0, 1))).toBeCloseTo(0);
    expect(cosine(v(0, 0), v(1, 1))).toBe(0);
  });
  it('centre subtracts the mean only from MIN_CENTER vectors on', () => {
    const few = new Map([['a', v(1, 1)], ['b', v(3, 3)]]);
    expect(Array.from(centre(few, 2).get('a')!)).toEqual([1, 1]);
    const many = new Map(Array.from({ length: MIN_CENTER }, (_, i) => [`n${i}`, v(i, 10)] as const));
    const c = centre(many, 2);
    expect(c.size).toBe(MIN_CENTER);
    expect(Array.from(c.get('n0')!)).toEqual([-3.5, 0]);
    expect(Array.from(many.get('n0')!)).toEqual([0, 10]); // input untouched
  });
  it('TopicCentroids keeps a running mean per topic', () => {
    const tc = new TopicCentroids(2);
    tc.add('A', v(1, 0));
    tc.add('A', v(3, 0));
    tc.add('B', v(0, 1));
    expect(tc.topics()).toEqual(['A', 'B']);
    expect(Array.from(tc.all().get('A')!)).toEqual([2, 0]);
    expect(tc.has('C')).toBe(false);
  });
});

describe('assignTopic (spec M6 §4 rules)', () => {
  const space = (): TopicCentroids => {
    const tc = new TopicCentroids(3);
    tc.add('A', v(1, 0, 0));
    tc.add('B', v(0, 1, 0));
    return tc;
  };
  it('rule 1: no topics yet → ask([])', () => {
    expect(assignTopic(v(1, 0, 0), new TopicCentroids(3), undefined)).toEqual({ kind: 'ask', candidates: [], sims: [] });
  });
  it('rule 4: a clear winner is assigned without the LLM', () => {
    const d = assignTopic(v(1, 0.1, 0), space(), undefined);
    expect(d.kind).toBe('assign');
    expect(d.kind === 'assign' && d.topic).toBe('A');
    expect(d.sims[0]).toMatchObject({ topic: 'A' });
  });
  it('rule 3: the parent topic wins a close call', () => {
    // sim(A) ≈ sim(B): 0.70 vs 0.71 — within INHERIT_MARGIN, both above T_INHERIT
    const d = assignTopic(v(0.70, 0.71, 0), space(), 'A');
    expect(d).toMatchObject({ kind: 'assign', topic: 'A' });
    expect(INHERIT_MARGIN).toBe(0.05);
    expect(T_INHERIT).toBe(0.15);
  });
  it('rule 3: the parent topic loses when its similarity drops', () => {
    const d = assignTopic(v(0.05, 1, 0), space(), 'A'); // sim(A) ≈ 0.05 < T_INHERIT
    expect(d).toMatchObject({ kind: 'assign', topic: 'B' });
  });
  it('rule 5: two close topics without a parent prior → ask with both, best first', () => {
    const d = assignTopic(v(1, 1, 0), space(), undefined); // 0.707 each
    expect(d.kind).toBe('ask');
    expect(d.kind === 'ask' && d.candidates).toEqual(['A', 'B']);
    expect(ASSIGN_MARGIN).toBe(0.1);
  });
  it('rule 5: nothing close → ask; the parent topic is always a candidate', () => {
    const tc = space();
    tc.add('C', v(0, 0, 1));
    const far = assignTopic(v(-1, -1, -1), tc, 'B'); // every sim negative: below T_ASSIGN, parent below T_INHERIT
    expect(far.kind).toBe('ask');
    expect(far.kind === 'ask' && far.candidates).toContain('B');
    expect(T_ASSIGN).toBe(0.35);
  });
  it('candidates are at most 3 plus the parent topic', () => {
    const tc = new TopicCentroids(5);
    for (let i = 0; i < 5; i++) { const e = new Float32Array(5); e[i] = 1; tc.add(`T${i}`, e); }
    const d = assignTopic(v(0.9, 0.8, 0.7, 0.6, 0.01), tc, 'T4');
    expect(d.kind).toBe('ask');
    expect(d.kind === 'ask' && d.candidates).toEqual(['T0', 'T1', 'T2', 'T4']);
  });
});

describe('naming helpers (spec M6 §4–5)', () => {
  it('cleanTopic: first line, collapsed, quotes and trailing period stripped, ≤ TOPIC_MAX on a word boundary', () => {
    expect(cleanTopic('  "Zentroid-Ansatz."  \nZweite Zeile')).toBe('Zentroid-Ansatz');
    expect(cleanTopic('„Topic   Modelle“')).toBe('Topic Modelle');
    expect(cleanTopic('Topic: Evaluation')).toBe('Topic: Evaluation');
    const long = cleanTopic('Sehr lange Bezeichnung für ein Thema das niemand so nennen würde');
    expect(long.length).toBeLessThanOrEqual(TOPIC_MAX);
    expect(long).toBe('Sehr lange Bezeichnung für ein Thema das');
    expect(cleanTopic('')).toBe('');
    expect(cleanTopic('...')).toBe('');
  });
  it('topicKey ignores case, diacritics and hyphen/underscore', () => {
    expect(topicKey('Zentroid-Ansatz')).toBe('zentroid ansatz');
    expect(topicKey('Größen_Schätzung')).toBe('großen schatzung'); // NFD strips the umlauts, ß stays
    expect(topicKey('Évaluation')).toBe('evaluation');
  });
  it('foldTopic returns the existing spelling on a match, else the name itself', () => {
    expect(foldTopic('zentroid ansatz', ['Zentroid-Ansatz', 'Evaluation'])).toBe('Zentroid-Ansatz');
    expect(foldTopic('Neues Thema', ['Zentroid-Ansatz'])).toBe('Neues Thema');
  });
  it('topicPrompt lists candidates with examples, all topics, the parent topic and the summary; omits the assignment part without candidates', () => {
    const p = topicPrompt({ summary: 'Frage nach Zentroiden', role: 'user', lang: 'de', parentTopic: 'Evaluation', candidates: [{ name: 'Evaluation', examples: ['Wie evaluieren?'] }, { name: 'Clustering', examples: [] }], allTopics: ['Evaluation', 'Clustering', 'Schreiben'] });
    expect(p).toContain('Written by: user');
    expect(p).toContain('- Evaluation: Wie evaluieren?');
    expect(p).toContain('- Clustering');
    expect(p).toContain('All topics of this canvas: Evaluation, Clustering, Schreiben');
    expect(p).toContain('Topic of the message it replies to: Evaluation');
    expect(p).toContain('Message summary:\nFrage nach Zentroiden');
    const first = topicPrompt({ summary: 'Erste Frage', role: 'user', lang: 'de', candidates: [], allTopics: [] });
    expect(first).not.toContain('Candidate topics');
    expect(first).toContain('This is the first message of the canvas: name its topic.');
    expect(TOPIC_SYSTEM).toMatch(/exactly the topic name/i);
    expect(p).not.toContain('new strand');
    expect(p).not.toContain('no candidate topic is close');
  });
  it('topicPrompt tells the namer a message opens its own strand and that nothing is close (spec M6 §5, amended)', () => {
    const p = topicPrompt({ summary: 'Kaggle-Tutorial', role: 'user', lang: 'de', candidates: [{ name: 'Pandas Befehle', examples: [] }], allTopics: ['Pandas Befehle'], startsStrand: true, distant: true });
    expect(p).toContain('opens a new strand of its own');
    expect(p).toContain('no candidate topic is close');
    const first = topicPrompt({ summary: 'Erste Frage', role: 'user', lang: 'de', candidates: [], allTopics: [], startsStrand: true, distant: true });
    expect(first).not.toContain('new strand'); // nothing to choose from — the hints would only add noise
    expect(TOPIC_SYSTEM).toMatch(/same subject/);
  });
});

describe('assignTopic with custom thresholds (spec M6 §4)', () => {
  const v = (...xs: number[]): Float32Array => Float32Array.from(xs);
  const space = (): TopicCentroids => {
    const tc = new TopicCentroids(3);
    tc.add('A', v(1, 0, 0));
    tc.add('B', v(0, 1, 0));
    return tc;
  };
  const DEFAULTS = { tInherit: T_INHERIT, inheritMargin: INHERIT_MARGIN, tAssign: T_ASSIGN, assignMargin: ASSIGN_MARGIN };

  it('a raised tInherit breaks a strand off its parent topic that the default would have kept', () => {
    // sim(A) ≈ 0.70, sim(B) ≈ 0.71 — inside inheritMargin, so the default lets the parent keep it.
    const vec = v(0.70, 0.71, 0);
    expect(assignTopic(vec, space(), 'A', DEFAULTS)).toMatchObject({ kind: 'assign', topic: 'A' });
    expect(assignTopic(vec, space(), 'A', { ...DEFAULTS, tInherit: 0.9 }).kind).toBe('ask');
  });

  it('a raised tAssign sends a clear winner to the namer instead of assigning it', () => {
    const vec = v(1, 0.1, 0); // sim(A) ≈ 0.995, sim(B) ≈ 0.0995
    expect(assignTopic(vec, space(), undefined, DEFAULTS)).toMatchObject({ kind: 'assign', topic: 'A' });
    expect(assignTopic(vec, space(), undefined, { ...DEFAULTS, tAssign: 0.999 }).kind).toBe('ask');
  });

  it('a raised assignMargin turns a clear winner into a tie for the namer', () => {
    const vec = v(1, 0.1, 0);
    expect(assignTopic(vec, space(), undefined, { ...DEFAULTS, assignMargin: 0.95 }).kind).toBe('ask');
  });

  it('omitting the thresholds keeps the shipped behaviour', () => {
    const vec = v(1, 0.1, 0);
    expect(assignTopic(vec, space(), undefined)).toEqual(assignTopic(vec, space(), undefined, DEFAULTS));
  });
});
