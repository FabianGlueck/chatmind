import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { VaultLock, isoTimestamp, linearGraph, readVault, writeCanvas } from '@chatmind/core';
import { IndexDb } from '../src/db';
import { contentHash } from '../src/hash';
import { MAX_FAILURES, countPending, reconcile, type NodeFailure } from '../src/reconcile';
import { USER_WAIT_MS } from '../src/topic-phase';
import { fakeEmbedder, fakeNamer, fakeSummarizer, topicEmbedder } from './fakes';
import { cleanupTmpDirs, files, nodeOnDisk, tmpDir, vaultWith } from './helpers';

afterAll(cleanupTmpDirs);

// Two lines: a single line of ≤ 250 chars would take the shortcut and never reach the summarizer.
const LONG_Q = 'Wie evaluiere ich die Topic-Zuordnung, wenn die Zentroide sich mit der Zeit verschieben\nund alte Zettel nicht wandern dürfen?';
const LONG_A = 'Zentroid statt Re-Clustering.\n\nDie Begründung ist, dass Zettel niemals rückwirkend ihre Zuordnung ändern sollen.';

// Generic over `over` so a plain `deps(root)` keeps the fakes' `.calls`/`.fail` in its type, while a call that
// overrides `embedder`/`summarizer` (e.g. with a bad fake) gets that override's own type — a non-generic
// `Partial<ReconcileDeps>` parameter would widen every call site's `embedder`/`summarizer` to the bare interface.
// The default clock runs USER_WAIT_MS ahead so a just-written user node without a reply is judged, not deferred
// (spec M6 §4) — the M5 tests here are not about deferral; the one that is overrides `now`.
function deps<O extends Partial<Parameters<typeof reconcile>[0]> = Record<string, never>>(root: string, over: O = {} as O) {
  const embedder = fakeEmbedder();
  const summarizer = fakeSummarizer();
  return { dataDir: root, db: IndexDb.open(':memory:', embedder), summarizer, embedder, namer: fakeNamer(), now: () => Date.now() + USER_WAIT_MS + 1000, lock: new VaultLock(), embedBatch: 2, ...over };
}

describe('reconcile (spec M5 §5)', () => {
  it('fills a fresh index: embeds, summarizes, renames; the second run is a fixed point', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: LONG_Q }, { role: 'assistant', content: LONG_A, model: 'x' }, { role: 'user', content: 'Danke' }]);
    const [q, a, d] = [...graph.nodes.keys()];
    const d1 = deps(root);
    const r1 = await reconcile(d1);
    expect(r1).toMatchObject({ nodes: 3, embedded: 3, summarized: 3, renamed: 3, failed: 0, pending: { embed: 0, summarize: 0, topics: 0, memories: 0 } });
    expect(d1.embedder.calls.map((c) => c.length)).toEqual([2, 1]); // batch size 2
    expect(d1.summarizer.calls).toHaveLength(2); // 'Danke' took the shortcut
    const forAssistant = d1.summarizer.calls.find((c) => c.role === 'assistant')!;
    expect(forAssistant.parentContext).toBe(LONG_Q.replace('\n', ' ')); // the parent's summary is not there yet → its body
    expect(d1.summarizer.calls.find((c) => c.role === 'user')!.parentContext).toBeUndefined(); // root
    expect((await nodeOnDisk(root, 'm', q!)).node.summary).toBe(`DE: ${LONG_Q.slice(0, 20)}`);
    expect((await nodeOnDisk(root, 'm', d!)).node.summary).toBe('Danke');
    expect(await files(root, 'm')).toEqual([`${q}-de-wie-evaluiere-ich-di.md`, `${a}-de-zentroid-statt-re-cl.md`, `${d}-danke.md`].sort());
    expect(d1.db.vector(q!)).not.toBeNull();
    const r2 = await reconcile(d1);
    expect(r2).toMatchObject({ embedded: 0, summarized: 0, renamed: 0, failed: 0 });
    expect(d1.embedder.calls).toHaveLength(2);
  });

  it('rebuild: a fresh db over an already-summarized vault re-embeds but keeps summaries', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG_Q }]);
    await reconcile(deps(root));
    const d2 = deps(root);
    const r = await reconcile(d2);
    expect(r).toMatchObject({ embedded: 1, summarized: 0, renamed: 0 });
    expect(d2.summarizer.calls).toHaveLength(0);
  });

  it('body edit: re-embeds; re-summarizes only our summary; a user summary stays', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: LONG_Q }, { role: 'assistant', content: LONG_A, model: 'x' }]);
    const [q, a] = [...graph.nodes.keys()];
    const d = deps(root);
    await reconcile(d);
    // user rewrites q's summary and both bodies in Obsidian
    for (const id of [q!, a!]) {
      const { path: rel } = await nodeOnDisk(root, 'm', id);
      let text = await fs.readFile(path.join(root, rel), 'utf8');
      text = text.replace(/\n\n[\s\S]*$/, '\n\nNeuer Text, der lang genug ist, um keinen Shortcut zu bekommen.\nZweite Zeile.\n');
      if (id === q) text = text.replace(/^summary: .*$/m, 'summary: Mein Titel');
      await fs.writeFile(path.join(root, rel), text);
    }
    const r = await reconcile(d);
    expect(r).toMatchObject({ embedded: 2, summarized: 1, renamed: 0 });
    expect((await nodeOnDisk(root, 'm', q!)).node.summary).toBe('Mein Titel');
    expect((await nodeOnDisk(root, 'm', a!)).node.summary).toBe('DE: Neuer Text, der lang');
  });

  it('a vanished node leaves the db; an empty body is done without jobs', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage eins' }, { role: 'user', content: 'Frage zwei' }]);
    const [one, two] = [...graph.nodes.keys()];
    const d = deps(root);
    await reconcile(d);
    await fs.rm(path.join(root, (await nodeOnDisk(root, 'm', two!)).path));
    const g = linearGraph('n', [{ role: 'user', content: '' }]);
    await writeCanvas(g, root);
    const r = await reconcile(d);
    expect(r).toMatchObject({ nodes: 2, embedded: 0, summarized: 0, pending: { embed: 0, summarize: 0, topics: 0, memories: 0 } });
    expect(d.db.rows().has(two!)).toBe(false);
    expect(d.db.vector(two!)).toBeNull();
    const empty = [...g.nodes.keys()][0]!;
    expect(d.db.rows().get(empty)).toMatchObject({ embedded_hash: contentHash('') });
    expect(d.db.rows().has(one!)).toBe(true);
  });

  it('failures leave rows stale and count as pending; a later run finishes them', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: LONG_Q }]);
    const id = [...graph.nodes.keys()][0]!;
    const d = deps(root);
    d.embedder.fail = true;
    d.summarizer.fail = true;
    const log: string[] = [];
    const r1 = await reconcile({ ...d, log: (m) => log.push(m) });
    expect(r1).toMatchObject({ embedded: 0, summarized: 0, failed: 2, pending: { embed: 1, summarize: 1 } });
    expect(log.join('\n')).toMatch(/embed down/);
    expect(log.join('\n')).toMatch(/llm down/);
    expect(log.join('\n')).toContain(`embed failed for ${id}`); // the failure names the node id, not just a count
    d.embedder.fail = false;
    d.summarizer.fail = false;
    expect(await reconcile(d)).toMatchObject({ embedded: 1, summarized: 1, failed: 0, pending: { embed: 0, summarize: 0, topics: 0, memories: 0 } });
  });

  it('rename skip is logged when the node vanishes mid-writeback', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const file = path.join(root, (await nodeOnDisk(root, 'm', id)).path);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace("summary: ''", 'summary: Von Hand')); // bare-ULID name + a summary => rename-only job
    // `force`: the topic phase takes a second lock turn for the same node, by then the file is already gone.
    const deletingLock = { run: async <T>(fn: () => Promise<T>): Promise<T> => { await fs.rm(file, { force: true }); return fn(); } } as unknown as VaultLock;
    const log: string[] = [];
    const d = deps(root, { lock: deletingLock });
    const r = await reconcile({ ...d, log: (m) => log.push(m) });
    expect(r).toMatchObject({ renamed: 0, failed: 0 });
    expect(log.join('\n')).toContain(`rename for ${id} dropped: vanished`);
  });

  it('a vanished summarize job logs the skip and is not pending (it will never be planned again)', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: LONG_Q }]);
    const id = [...graph.nodes.keys()][0]!;
    const file = path.join(root, (await nodeOnDisk(root, 'm', id)).path);
    // `force`: the topic phase takes a second lock turn for the same node, by then the file is already gone.
    const deletingLock = { run: async <T>(fn: () => Promise<T>): Promise<T> => { await fs.rm(file, { force: true }); return fn(); } } as unknown as VaultLock;
    const log: string[] = [];
    const d = deps(root, { lock: deletingLock });
    const r = await reconcile({ ...d, log: (m) => log.push(m) });
    expect(r.pending.summarize).toBe(0);
    expect(log.join('\n')).toContain(`summary for ${id} dropped: vanished`);
  });

  it('a summarizer answer that cleans to "" is a failure', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG_Q }]);
    const d = deps(root, { summarizer: Object.assign(async () => '"."', { calls: [], fail: false }) });
    expect(await reconcile(d)).toMatchObject({ summarized: 0, failed: 1 });
  });

  it('an embedder returning the wrong dim fails the batch without writing', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG_Q }]);
    const bad = { model: 'fake/embed', dim: 4, embed: async (t: string[]) => t.map(() => Float32Array.from([1])) };
    const d = deps(root, { embedder: bad, db: IndexDb.open(':memory:', bad) });
    expect(await reconcile(d)).toMatchObject({ embedded: 0, failed: 1, pending: { embed: 1 } });
  });

  it('F1: a persistent dim mismatch logs the CHATMIND_EMBED_DIM hint once per run, not once per item', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: 'Erster kurzer Satz.' }, { role: 'user', content: 'Zweiter kurzer Satz.' }]);
    const bad = { model: 'fake/embed', dim: 4, embed: async (t: string[]) => t.map(() => Float32Array.from([1])) };
    const d = deps(root, { embedder: bad, db: IndexDb.open(':memory:', bad), embedBatch: 2 });
    const log: string[] = [];
    const r = await reconcile({ ...d, log: (m) => log.push(m) });
    expect(r).toMatchObject({ embedded: 0, failed: 2, pending: { embed: 2 } });
    const hints = log.filter((m) => m.includes('CHATMIND_EMBED_DIM'));
    expect(hints).toHaveLength(1);
  });

  it('F1: a batch failure falls back to embedding each member individually — one bad body does not block its batch-mates', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Guter Satz eins.' }, { role: 'user', content: 'Böser Satz zwei.' }]);
    const [good, bad] = [...graph.nodes.keys()];
    const badBody = 'Böser Satz zwei.';
    const embedder = {
      model: 'fake/embed',
      dim: 4,
      calls: [] as string[][],
      async embed(texts: string[]): Promise<Float32Array[]> {
        this.calls.push(texts);
        if (texts.includes(badBody)) throw new Error('provider rejected this body');
        return texts.map((t) => Float32Array.from([t.length, t.charCodeAt(0) || 0, 1, 0]));
      },
    };
    const d = deps(root, { embedder, db: IndexDb.open(':memory:', embedder) }); // embedBatch: 2 (deps() default) — both nodes share one batch
    const log: string[] = [];
    const r = await reconcile({ ...d, log: (m) => log.push(m) });
    expect(r).toMatchObject({ embedded: 1, failed: 1, gaveUp: 0, pending: { embed: 1, summarize: 0, topics: 0 } });
    expect(d.db.rows().get(good!)?.embedded_hash).not.toBeNull();
    expect(d.db.rows().get(bad!)?.embedded_hash).toBeNull();
    expect(log.join('\n')).toContain(`embed failed for ${bad}`);
    // the batch call, then one embed() call per member of the fallback
    expect(embedder.calls).toEqual([['Guter Satz eins.', 'Böser Satz zwei.'], ['Guter Satz eins.'], ['Böser Satz zwei.']]);
  });

  it('F1: gives up on a node after 3 consecutive summarize failures, logs once, and an edit resets it', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: LONG_Q }]);
    const id = [...graph.nodes.keys()][0]!;
    const failures = new Map<string, NodeFailure>();
    const d = deps(root, { failures });
    d.summarizer.fail = true;

    const log1: string[] = [];
    const r1 = await reconcile({ ...d, log: (m) => log1.push(m) });
    expect(r1).toMatchObject({ summarized: 0, gaveUp: 0, pending: { summarize: 1 } });

    const log2: string[] = [];
    const r2 = await reconcile({ ...d, log: (m) => log2.push(m) });
    expect(r2).toMatchObject({ summarized: 0, gaveUp: 0, pending: { summarize: 1 } });

    const log3: string[] = [];
    const r3 = await reconcile({ ...d, log: (m) => log3.push(m) });
    expect(r3).toMatchObject({ summarized: 0, gaveUp: 1, pending: { summarize: 0 } });
    expect(log3.join('\n')).toContain(`giving up on ${id} after 3 failures until its body changes`);

    // further runs stay quiet — the node is skipped, not retried, and not re-logged
    const log4: string[] = [];
    const r4 = await reconcile({ ...d, log: (m) => log4.push(m) });
    expect(r4).toMatchObject({ summarized: 0, gaveUp: 1, pending: { summarize: 0 } });
    expect(log4).toHaveLength(0);
    expect(d.summarizer.calls).toHaveLength(3); // not called on run 4

    // editing the body resets the counter and it is retried
    d.summarizer.fail = false;
    const { path: rel } = await nodeOnDisk(root, 'm', id);
    let text = await fs.readFile(path.join(root, rel), 'utf8');
    text = text.replace(/\n\n[\s\S]*$/, '\n\nGanz neuer Text, lang genug für keinen Shortcut hier.\nZweite Zeile.\n');
    await fs.writeFile(path.join(root, rel), text);
    const r5 = await reconcile(d);
    expect(r5).toMatchObject({ summarized: 1, gaveUp: 0, pending: { summarize: 0 } });
  });

  it('countPending reads without writing', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG_Q }]);
    const d = deps(root);
    expect(await countPending(d)).toEqual({ embed: 1, summarize: 1, topics: 0, memories: 0 });
    await reconcile(d);
    expect(await countPending(d)).toEqual({ embed: 0, summarize: 0, topics: 0, memories: 0 });
  });

  it('property: reconcile ∘ reconcile has no jobs on the second run', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string({ unit: 'grapheme-ascii', minLength: 0, maxLength: 120 }), { minLength: 1, maxLength: 6 }), async (bodies) => {
        const root = await tmpDir();
        await writeCanvas(linearGraph('p', bodies.map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content, model: i % 2 ? 'x' : undefined }))), root);
        const d = deps(root);
        await reconcile(d);
        const r = await reconcile(d);
        expect(r).toMatchObject({ embedded: 0, summarized: 0, renamed: 0, failed: 0 });
        d.db.close();
      }),
      { numRuns: 15 },
    );
  }, 30_000);
});

describe('topic phase (spec M6 §4/§6)', () => {
  // Bodies start with A/B so topicEmbedder puts them on different axes; two lines so summaries go through the summarizer.
  const A1 = 'Alpha Frage eins\nzweite Zeile';
  const A2 = 'Alpha Antwort dazu\nzweite Zeile';
  const A3 = 'Alpha noch eine Frage\nzweite Zeile';
  const B1 = 'Beta ganz anderes Thema\nzweite Zeile';
  const old = () => Date.now() + USER_WAIT_MS + 1000; // every node is "old": no deferral

  it('a chain founds one topic with a single namer call; later nodes are assigned by similarity', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: A1 }, { role: 'assistant', content: A2, model: 'x' }, { role: 'user', content: A3 }]);
    const ids = [...graph.nodes.keys()];
    const d = deps(root, { embedder: topicEmbedder(), now: old });
    const r = await reconcile(d);
    expect(r).toMatchObject({ topics: 3, asked: 1, pending: { topics: 0 } });
    expect(d.namer.calls).toHaveLength(1);
    expect(d.namer.calls[0]).toMatchObject({ candidates: [], allTopics: [], role: 'user' });
    for (const id of ids) expect((await nodeOnDisk(root, 'm', id)).node.topics).toEqual(['Topic A']);
    expect(d.db.rows().get(ids[0]!)!.topic_written).toBe('Topic A');
    const r2 = await reconcile(d);
    expect(r2.topics).toBe(0); // fixed point
  });

  it('a split whose second child drifts founds a second topic; the namer sees the parent topic and candidates', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: A1 }, { role: 'assistant', content: A2, model: 'x' }]);
    const [q, a] = [...graph.nodes.keys()];
    // second child of q: a user node on axis B, with its own assistant reply on B
    const { canvases } = await readVault(root);
    const g = canvases[0]!;
    // Created after a, so the run reaches them after q and a have their topic (created order, spec §4).
    const after = Date.parse(g.nodes.get(a!)!.created);
    const uB = { id: '01JQ8F5000000000000000000B', role: 'user' as const, parents: [q!], created: isoTimestamp(after + 60_000), summary: '', topics: [], body: B1 };
    const aB = { id: '01JQ8F5000000000000000000C', role: 'assistant' as const, model: 'x', parents: [uB.id], created: isoTimestamp(after + 70_000), summary: '', topics: [], body: 'Beta Antwort\nzweite Zeile' };
    g.nodes.set(uB.id, uB); g.nodes.set(aB.id, aB);
    await writeCanvas(g, root);
    const d = deps(root, { embedder: topicEmbedder(), now: old });
    const r = await reconcile(d);
    expect(r.topics).toBe(4);
    expect((await nodeOnDisk(root, 'm', a!)).node.topics).toEqual(['Topic A']);
    expect((await nodeOnDisk(root, 'm', uB.id)).node.topics).toEqual(['Topic B']);
    expect((await nodeOnDisk(root, 'm', aB.id)).node.topics).toEqual(['Topic B']);
    const askB = d.namer.calls.find((c) => c.summary.includes('Beta'))!;
    expect(askB.parentTopic).toBe('Topic A');
    expect(askB.candidates.map((c) => c.name)).toEqual(['Topic A']);
    expect(askB.candidates[0]!.examples.length).toBeGreaterThan(0);
    expect(askB).toMatchObject({ startsStrand: false, distant: true }); // a reply, and far from Topic A
    expect(d.namer.calls[0]).toMatchObject({ startsStrand: true });
    expect(d.namer.calls).toHaveLength(2);
  });

  it('a hand-set topic stays and seeds the centroid; a blanked topic is assigned again without a namer call', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: A1 }, { role: 'assistant', content: A2, model: 'x' }]);
    const [q, a] = [...graph.nodes.keys()];
    const file = path.join(root, 'm', 'nodes', `${q}.md`);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('topics: []', 'topics: [Mein Thema]'));
    const d = deps(root, { embedder: topicEmbedder(), now: old });
    await reconcile(d);
    expect(d.namer.calls).toHaveLength(0);
    expect((await nodeOnDisk(root, 'm', q!)).node.topics).toEqual(['Mein Thema']);
    expect((await nodeOnDisk(root, 'm', a!)).node.topics).toEqual(['Mein Thema']);
    expect(d.db.rows().get(q!)!.topic_written).toBeNull();
    // blank a's topic → next run assigns it again (by similarity to q), still no namer call
    const { path: rel } = await nodeOnDisk(root, 'm', a!);
    await fs.writeFile(path.join(root, rel), (await fs.readFile(path.join(root, rel), 'utf8')).replace('topics: [Mein Thema]', 'topics: []'));
    const r = await reconcile(d);
    expect(r.topics).toBe(1);
    expect((await nodeOnDisk(root, 'm', a!)).node.topics).toEqual(['Mein Thema']);
    expect(d.namer.calls).toHaveLength(0);
  });

  it('a young user node without a reply is deferred (pending.topics), then judged alone once old', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: A1 }]);
    const id = [...graph.nodes.keys()][0]!;
    const created = Date.parse(graph.nodes.get(id)!.created);
    const d = deps(root, { embedder: topicEmbedder(), now: () => created + 1000 });
    const r1 = await reconcile(d);
    expect(r1).toMatchObject({ topics: 0, pending: { topics: 1 } });
    expect((await nodeOnDisk(root, 'm', id)).node.topics).toEqual([]);
    d.now = () => created + USER_WAIT_MS + 1;
    const r2 = await reconcile(d);
    expect(r2).toMatchObject({ topics: 1, pending: { topics: 0 } });
  });

  it('namer failures count like summary failures and give up after MAX_FAILURES', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: A1 }]);
    const failures = new Map<string, NodeFailure>();
    const d = deps(root, { embedder: topicEmbedder(), now: old, namer: fakeNamer({ fail: true }), failures });
    for (let i = 0; i < MAX_FAILURES; i++) {
      const r = await reconcile(d);
      expect(r.failed).toBeGreaterThan(0);
      expect(r.pending.topics).toBe(i < MAX_FAILURES - 1 ? 1 : 0);
    }
    const r = await reconcile(d);
    expect(r).toMatchObject({ gaveUp: 1, pending: { topics: 0 } });
    expect(d.namer.calls).toHaveLength(MAX_FAILURES);
  });

  it('honours custom thresholds: raising them past every similarity sends each node to the namer', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG_Q }, { role: 'assistant', content: LONG_A, model: 'x' }]);
    const base = deps(root, { now: old });
    await reconcile(base);
    expect(base.namer.calls).toHaveLength(1); // the chain inherits: only the founding call

    const { root: root2 } = await vaultWith('m', [{ role: 'user', content: LONG_Q }, { role: 'assistant', content: LONG_A, model: 'x' }]);
    // tInherit/tAssign at 1 are above every attainable cosine, so rules 3 and 4 can never fire.
    const tuned = deps(root2, { now: old, thresholds: { tInherit: 1, inheritMargin: 0.05, tAssign: 1, assignMargin: 0.1 } });
    const r = await reconcile(tuned);
    expect(r.asked).toBe(2);
    expect(tuned.namer.calls).toHaveLength(2);
  });

  it('names what the model actually returned when it cleans away to nothing', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: A1 }]);
    const logs: string[] = [];
    // Quotes and a full stop survive nothing: cleanTopic strips them and leaves an empty name.
    const d = deps(root, { embedder: topicEmbedder(), now: old, namer: async () => '"..."', log: (m: string) => logs.push(m) });
    const r = await reconcile(d);
    expect(r.topics).toBe(0);
    const line = logs.find((m) => m.startsWith('topic failed'))!;
    expect(line).toContain('the model returned nothing usable as a topic name');
    expect(line).toContain('...'); // the model's own answer, quoted back
  });

  it('a fresh db over a topic-complete vault writes no topic', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: A1 }, { role: 'assistant', content: A2, model: 'x' }]);
    await reconcile(deps(root, { embedder: topicEmbedder(), now: old }));
    const before = await Promise.all([...graph.nodes.keys()].map((id) => nodeOnDisk(root, 'm', id)));
    const d2 = deps(root, { embedder: topicEmbedder(), now: old });
    const r = await reconcile(d2);
    expect(r).toMatchObject({ embedded: 2, topics: 0, asked: 0 });
    expect(d2.namer.calls).toHaveLength(0);
    const after = await Promise.all([...graph.nodes.keys()].map((id) => nodeOnDisk(root, 'm', id)));
    expect(after.map((n) => n.node.topics)).toEqual(before.map((n) => n.node.topics));
    expect(d2.db.rows().get([...graph.nodes.keys()][0]!)!.topic_written).toBeNull(); // we no longer know it was ours
  });
});
