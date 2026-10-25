# Cycle 6 (M6): Topics within a canvas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The indexer gives every node exactly one topic (`topics: [name]` in frontmatter) by centroid similarity over the M5 embeddings, with the parent's topic as a prior and an LLM naming a topic only when nothing fits or two are too close; the browser colours cards by topic and a sidebar list highlights a topic's nodes.

**Architecture:** A pure assignment core in `@chatmind/index` (`topics.ts`: centring, centroids, `assignTopic`, name cleaning/folding, prompt text) and a per-canvas phase (`topic-phase.ts`) that runs inside `reconcile` after summaries: it builds the topic set and centroids from the frontmatter and stored vectors, walks the unassigned nodes in `created` order, calls the injected `TopicNamer` on `ask`, and writes `topics` through a new `writeTopic` under the vault lock. `index.db` gains one column (`topic_written`) via an additive migration and a bulk vector read. The server implements the namer with the AI SDK; the CLI gets `index topics --dry-run`. The web app derives everything from `NodeDto.topics` — no API change.

**Tech Stack:** as cycles 1–5; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-chatmind-m6-topics-design.md` (binding), on top of the cycle-1 spec (invariants §3, traps §14) and the M5 spec (reconcile, writeback, live channel).

## Global Constraints

- Node `>=22.22.2`; shells: `put Node 22 and pnpm on `PATH` (e.g. `nvm use`)`.
- Files are the truth; everything in `.app/index.db` is derived and disposable (cycle-1 §3.1). No topic or centroid table — topics come from the frontmatter, centroids are computed per run. `graph.canvas` stays pure JSON Canvas 1.0. Identity is the frontmatter ULID.
- The indexer writes `summary` (M5) and, new, `topics` into frontmatter; **only when `topics` is empty**, never otherwise (spec §2 "retroactive change: never"). Nothing else in the vault is renamed or deleted.
- One topic per node: `topics = [name]`; all logic reads `topics[0]`.
- Raw vectors stay as M5 stored them; centring happens at query time over `v − μ`, μ = mean of every stored vector in the vault; no centring below `MIN_CENTER = 8` vectors (spec §4).
- Thresholds (spec §4, defaults to be calibrated at the gate): `INHERIT_MARGIN = 0.05`, `T_INHERIT = 0.15`, `T_ASSIGN = 0.35`, `ASSIGN_MARGIN = 0.10`; `USER_WAIT_MS = 120_000`; `TOPIC_MAX = 40`.
- `@chatmind/index` has no network dependency; the `TopicNamer` is injected and implemented in `apps/server/src/index-providers.ts` with the summary model, `reasoning.effort = 'minimal'`, `maxOutputTokens: 60`. `apps/web` imports runtime code only from `@chatmind/core/graph`.
- UI copy is English ("Topics"); topic names follow the content's language.
- Style: compact TypeScript, doc comments citing the spec section, no ESLint/Prettier. TDD per task; commit per task with the session's attribution trailer:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY
  ```
- Run `pnpm typecheck && pnpm test` at the end of every task before committing. Never point a probe at the user's vault; scratch servers use `--data-dir <scratchpad>/vault --port 3299 --no-index`.
- Work happens directly on `main`.

## File Map

| Path | Responsibility |
|---|---|
| `packages/core/src/vault/read.ts` | + `readCanvas(root, slug)`: one canvas folder or `null` |
| `packages/core/src/index.ts` | + export `readCanvas` |
| `packages/index/src/db.ts` | `SCHEMA_VERSION = 2`, `topic_written`, additive migration, `allVectors()`, `setTopic()`, `openReadonly(file, { vec })` |
| `packages/index/src/types.ts` | + `TopicInput`, `TopicNamer`; `Report.topics`, `pending.topics` |
| `packages/index/src/topics.ts` | constants, `meanVector`, `centre`, `cosine`, `TopicCentroids`, `assignTopic`, `TOPIC_SYSTEM`, `topicPrompt`, `cleanTopic`, `topicKey`, `foldTopic` (all pure) |
| `packages/index/src/failures.ts` | `recordFailure`, `clearFailure`, `hasGivenUp`, `MAX_FAILURES`, `NodeFailure` (moved out of `reconcile.ts`) |
| `packages/index/src/plan.ts` | + `planTopicJobs(entries, rows): string[]`; `rowsForPlan` fills `topic_written: null` |
| `packages/index/src/writeback.ts` | both writebacks read one canvas via `readCanvas`; + `writeTopic(job, deps)` |
| `packages/index/src/topic-phase.ts` | `prepareCanvas` (candidates, deferral, combined user vectors, examples), `runTopicPhase` (decide → name → write) |
| `packages/index/src/reconcile.ts` | `ReconcileDeps.namer`, `.now`; topic phase after renames; `Report.topics`; `countPending` |
| `packages/index/src/indexer.ts` | `IndexerOptions.namer`; pending sum includes topics; status |
| `packages/index/src/index.ts` | exports |
| `packages/index/test/fakes.ts` | + `topicEmbedder()`, `fakeNamer()` |
| `apps/server/src/index-providers.ts` | + `createTopicNamer(model)`; `openRouterIndexProviders` returns the namer |
| `apps/server/src/index.ts` | passes the namer to the `Indexer` |
| `apps/cli/src/index-status.ts` | + topics assigned / pending topics per canvas |
| `apps/cli/src/index-topics.ts` | `chatmind index topics --dry-run` |
| `apps/cli/src/index.ts` | routes `index topics` |
| `apps/web/src/topics.ts` | `TOPIC_COLOURS`, `topicPalette(dto)`, `topicList(dto)`, `nodesOfTopic(dto, name)` (pure) |
| `apps/web/src/flow.ts` | `MessageNodeData.topic/topicIndex/dimmed`; `toFlowNodes(dto, streams, marks, topics)` |
| `apps/web/src/MessageNode.tsx` | coloured left border + header label |
| `apps/web/src/NodePanel.tsx` | `.topic` pill in the topic colour |
| `apps/web/src/GraphView.tsx` | passes `topics` through to `toFlowNodes` |
| `apps/web/src/App.tsx` | topic list, `activeTopic`, Esc order, reset on canvas change, camera fit |
| `apps/web/src/styles.css` | `--topic-0…9`, `.has-topic`, `.dimmed`, `.topic-label`, `.topics` list |
| `README.md`, `CLAUDE.md` | docs |

---

### Task 1: `readCanvas` in core; both writebacks read one canvas

**Files:**
- Modify: `packages/core/src/vault/read.ts`, `packages/core/src/index.ts`, `packages/core/test/read.test.ts`
- Modify: `packages/index/src/writeback.ts`

**Interfaces:**
- Consumes: `readCanvasFolder(root, slug, repairs)` (private in `read.ts`), `exists`, `CANVAS_FILE`, `NODES_DIR` (`paths.ts`).
- Produces:
  ```ts
  // packages/core/src/vault/read.ts
  export async function readCanvas(root: string, slug: string): Promise<{ graph: CanvasGraph; repairs: Repair[] } | null>
  ```

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/read.test.ts`:

```ts
import { readCanvas } from '../src/vault/read';

describe('readCanvas (spec M6 §6)', () => {
  it('returns the same graph and repairs as the matching element of readVault', async () => {
    const { root } = await writtenVault();
    const whole = await readVault(root);
    const one = await readCanvas(root, 'masterarbeit');
    expect(one).not.toBeNull();
    expect(one!.graph).toEqual(whole.canvases[0]);
    expect(one!.repairs).toEqual(whole.repairs);
  });

  it('returns null for a folder that is not a canvas, a missing folder and an unsafe slug', async () => {
    const { root } = await writtenVault();
    await fs.mkdir(path.join(root, 'notes'));
    expect(await readCanvas(root, 'notes')).toBeNull();
    expect(await readCanvas(root, 'missing')).toBeNull();
    expect(await readCanvas(root, '../masterarbeit')).toBeNull();
    expect(await readCanvas(root, '.app')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @chatmind/core test -- read.test.ts`
Expected: FAIL — `readCanvas` is not exported.

- [ ] **Step 3: Implement `readCanvas`**

In `packages/core/src/vault/read.ts`, import `NODES_DIR` alongside `CANVAS_FILE` and add after `readVault`:

```ts
/**
 * Spec M6 §6: one canvas folder, with exactly the graph and repairs `readVault` would produce for it.
 * `null` when `slug` is not a canvas folder (no graph.canvas and no nodes/), or would leave the root.
 */
export async function readCanvas(root: string, slug: string): Promise<{ graph: CanvasGraph; repairs: Repair[] } | null> {
  if (slug === '' || slug.startsWith('.') || slug.includes('/') || slug.includes('\\')) return null;
  const dir = path.join(root, slug);
  if (!(await exists(path.join(dir, CANVAS_FILE))) && !(await exists(path.join(dir, NODES_DIR)))) return null;
  const repairs: Repair[] = [];
  const graph = await readCanvasFolder(root, slug, repairs);
  return { graph, repairs };
}
```

In `packages/core/src/index.ts` change the read export line to:

```ts
export { readVault, readCanvas, type ReadResult } from './vault/read';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @chatmind/core test -- read.test.ts`
Expected: PASS.

- [ ] **Step 5: Switch the summary writeback to `readCanvas`**

In `packages/index/src/writeback.ts` replace the import and the first lines of the lock turn:

```ts
import { readCanvas, renameNodeFile, writeCanvasFile, writeNode, type VaultLock } from '@chatmind/core';
```

```ts
  return deps.lock.run(async () => {
    // Spec M6 §6: only this canvas is read — the canvas file rewrite after a rename needs its nodes' paths, not the vault's.
    const found = await readCanvas(deps.dataDir, job.canvas);
    const graph = found?.graph;
    const node = graph?.nodes.get(job.id);
    if (!graph || !node) return { written: false, renamed: false, skipped: 'vanished' };
```

Update the doc comment above `writeback`: replace "The graph is re-read whole (like completion.persist) because the canvas file needs every node's path and layout." with "The canvas is re-read (spec M6 §6: one folder, not the whole vault) because the canvas file needs every node's path and layout."

- [ ] **Step 6: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: all green (the existing writeback and reconcile tests cover the switch).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/vault/read.ts packages/core/src/index.ts packages/core/test/read.test.ts packages/index/src/writeback.ts
git commit -m "feat(core,index): readCanvas reads one canvas folder; writeback uses it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

---

### Task 2: `index.db` schema 2 — `topic_written`, additive migration, bulk vectors

**Files:**
- Modify: `packages/index/src/db.ts`, `packages/index/src/plan.ts` (`rowsForPlan` only), `packages/index/test/db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // packages/index/src/db.ts
  export interface NodeRow { …; topic_written: string | null }
  export const SCHEMA_VERSION = 2;
  static openReadonly(file: string, opts?: { vec?: boolean }): IndexDb   // vec: load sqlite-vec so vector()/allVectors() work
  allVectors(): Map<string, Float32Array>
  setTopic(id: string, name: string): void
  ```

- [ ] **Step 1: Write the failing tests**

In `packages/index/test/db.test.ts`, update the first test's row expectation to include the new column:

```ts
    expect(db.rows().get('A')).toEqual({ id: 'A', canvas: 'masterarbeit', content_hash: 'h1', summary_written: null, summary_for_hash: null, embedded_hash: null, topic_written: null });
```

Append these tests:

```ts
  it('setTopic records the topic we wrote; allVectors returns every stored vector', () => {
    const db = IndexDb.open(':memory:', EMBED);
    db.upsertNode('A', 'c', 'h');
    db.upsertNode('B', 'c', 'h');
    db.setEmbedded('A', 'h', vec(1));
    db.setEmbedded('B', 'h', vec(2));
    db.setTopic('A', 'Zentroide');
    expect(db.rows().get('A')!.topic_written).toBe('Zentroide');
    const all = db.allVectors();
    expect([...all.keys()].sort()).toEqual(['A', 'B']);
    expect(Array.from(all.get('B')!)).toEqual([2, 2, 2, 2]);
    db.close();
  });

  it('migrates schema 1 → 2 in place: vectors and hashes survive, topic_written is added', async () => {
    const file = await tmpFile();
    const v2 = IndexDb.open(file, EMBED);
    v2.upsertNode('A', 'c', 'h');
    v2.setEmbedded('A', 'h', vec(3));
    v2.setSummary('A', 'T', 'h');
    // Turn the file back into what M5 wrote: no topic column, version 1.
    v2.db.exec("ALTER TABLE nodes DROP COLUMN topic_written; UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    v2.close();
    const db = IndexDb.open(file, EMBED);
    expect(db.meta('schema_version')).toBe('2');
    expect(db.rows().get('A')).toEqual({ id: 'A', canvas: 'c', content_hash: 'h', summary_written: 'T', summary_for_hash: 'h', embedded_hash: 'h', topic_written: null });
    expect(Array.from(db.vector('A')!)).toEqual([3, 3, 3, 3]);
    db.close();
  });

  it('an unknown schema version still drops everything', async () => {
    const file = await tmpFile();
    const db1 = IndexDb.open(file, EMBED);
    db1.upsertNode('A', 'c', 'h');
    db1.db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    db1.close();
    const db2 = IndexDb.open(file, EMBED);
    expect(db2.rows().size).toBe(0);
    expect(db2.meta('schema_version')).toBe('2');
    db2.close();
  });

  it('openReadonly with vec loads the extension so vectors are readable', async () => {
    const file = await tmpFile();
    const w = IndexDb.open(file, EMBED);
    w.upsertNode('A', 'c', 'h');
    w.setEmbedded('A', 'h', vec(4));
    w.close();
    const ro = IndexDb.openReadonly(file, { vec: true });
    expect(Array.from(ro.vector('A')!)).toEqual([4, 4, 4, 4]);
    expect(ro.allVectors().size).toBe(1);
    ro.close();
    const plain = IndexDb.openReadonly(file);
    expect(plain.vector('A')).toBeNull(); // no extension: "no such module" is swallowed as before
    plain.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/index test -- db.test.ts`
Expected: FAIL — `topic_written` missing from rows, `setTopic`/`allVectors` undefined.

- [ ] **Step 3: Implement schema 2**

In `packages/index/src/db.ts`:

```ts
export interface NodeRow {
  id: string;
  canvas: string;
  content_hash: string;
  summary_written: string | null;
  summary_for_hash: string | null;
  embedded_hash: string | null;
  /** Spec M6 §6: the topic we wrote, or null when the frontmatter topic is the user's (or none yet). */
  topic_written: string | null;
}

export const SCHEMA_VERSION = 2;

const TABLES = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  canvas TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary_written TEXT,
  summary_for_hash TEXT,
  embedded_hash TEXT,
  topic_written TEXT
);`;
```

Replace the version check inside `open` with:

```ts
    const version = db.meta('schema_version');
    if (version === '1') {
      // Spec M6 §6: additive — a drop would re-embed the whole vault for one new column.
      raw.exec('ALTER TABLE nodes ADD COLUMN topic_written TEXT');
    } else if (version !== String(SCHEMA_VERSION)) {
      raw.exec('DROP TABLE IF EXISTS vec_nodes; DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS meta;');
    }
```

Replace `openReadonly`:

```ts
  /** For the CLI: rows and meta only, no writes. `vec: true` loads sqlite-vec so `vector()`/`allVectors()` work (dry run, spec M6 §6). */
  static openReadonly(file: string, opts: { vec?: boolean } = {}): IndexDb {
    const raw = new Database(file, { readonly: true, fileMustExist: true });
    if (opts.vec) sqliteVec.load(raw);
    return new IndexDb(raw);
  }
```

Add after `vector`:

```ts
  /** Spec M6 §6: every stored vector, loaded once per run for centring and centroids. */
  allVectors(): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    try {
      for (const row of this.db.prepare('SELECT id, embedding FROM vec_nodes').all() as { id: string; embedding: Buffer }[]) {
        const b = row.embedding;
        out.set(row.id, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
      }
    } catch (err) {
      if (!IndexDb.isMissing(err)) throw err;
    }
    return out;
  }

  setTopic(id: string, name: string): void {
    this.db.prepare('UPDATE nodes SET topic_written = ? WHERE id = ?').run(name, id);
  }
```

In `packages/index/src/plan.ts` (`rowsForPlan`), add the new column to the synthetic row:

```ts
    out.set(node.id, r ? { ...r, content_hash } : { id: node.id, canvas, content_hash, summary_written: null, summary_for_hash: null, embedded_hash: null, topic_written: null });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @chatmind/index test -- db.test.ts`
Expected: PASS. If `DROP COLUMN` is rejected by the bundled SQLite, replace that line of the migration test with a manual v1 build: `CREATE TABLE nodes_v1 AS SELECT id, canvas, content_hash, summary_written, summary_for_hash, embedded_hash FROM nodes; DROP TABLE nodes; ALTER TABLE nodes_v1 RENAME TO nodes;` — the assertion stays the same.

- [ ] **Step 5: Run the whole suite, commit**

Run: `pnpm typecheck && pnpm test`
Expected: green (any test comparing full rows with `toEqual` must include `topic_written: null`; fix those in `plan.test.ts`/`reconcile.test.ts` if they exist).

```bash
git add packages/index/src/db.ts packages/index/src/plan.ts packages/index/test
git commit -m "feat(index): schema 2 — topic_written, additive migration, allVectors, readonly vec

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

---

### Task 3: Pure assignment — centring, centroids, `assignTopic`

**Files:**
- Create: `packages/index/src/topics.ts`, `packages/index/test/topics.test.ts`
- Modify: `packages/index/src/types.ts`, `packages/index/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  // packages/index/src/types.ts
  export interface TopicInput { summary: string; role: 'user' | 'assistant'; lang: 'de' | 'en'; parentTopic?: string; candidates: { name: string; examples: string[] }[]; allTopics: string[] }
  export interface TopicNamer { (input: TopicInput): Promise<string> }
  // packages/index/src/topics.ts
  export const MIN_CENTER = 8, INHERIT_MARGIN = 0.05, T_INHERIT = 0.15, T_ASSIGN = 0.35, ASSIGN_MARGIN = 0.10;
  export function meanVector(vecs: Iterable<Float32Array>, dim: number): Float32Array | null
  export function centre(vectors: ReadonlyMap<string, Float32Array>, dim: number): Map<string, Float32Array>
  export function cosine(a: Float32Array, b: Float32Array): number
  export class TopicCentroids { constructor(dim: number); add(topic: string, vec: Float32Array): void; has(topic): boolean; topics(): string[]; all(): Map<string, Float32Array> }
  export interface Sim { topic: string; sim: number }
  export type Decision = { kind: 'assign'; topic: string; sims: Sim[] } | { kind: 'ask'; candidates: string[]; sims: Sim[] }
  export function assignTopic(vec: Float32Array, centroids: TopicCentroids, parentTopic: string | undefined): Decision
  ```

- [ ] **Step 1: Add the types**

Append to `packages/index/src/types.ts`:

```ts
/** Spec M6 §3: what the topic namer sees — the node, its parent's topic, the closest topics with examples, and every topic of the canvas. */
export interface TopicInput {
  summary: string;
  role: 'user' | 'assistant';
  lang: 'de' | 'en';
  parentTopic?: string;
  /** Top-3 by similarity plus the parent's topic, each with up to 3 summaries of its nodes. */
  candidates: { name: string; examples: string[] }[];
  /** Every topic of the canvas, so the model does not invent a duplicate under another name. */
  allTopics: string[];
}

/** Spec M6 §3: returns a topic name — an existing one or a new one. */
export interface TopicNamer {
  (input: TopicInput): Promise<string>;
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/index/test/topics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ASSIGN_MARGIN, INHERIT_MARGIN, MIN_CENTER, T_ASSIGN, T_INHERIT, TopicCentroids, assignTopic, centre, cosine, meanVector } from '../src/topics';

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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/index test -- topics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `topics.ts` (assignment half)**

Create `packages/index/src/topics.ts`:

```ts
/** Spec M6 §4: no centring below this many stored vectors — the mean of a handful is noise. */
export const MIN_CENTER = 8;
/** Spec M6 §4 rule 3: the parent's topic wins while it trails the best by at most this much (calibrated 2026-09-21, default). */
export const INHERIT_MARGIN = 0.05;
/** Spec M6 §4 rule 3: …and is at least this similar; below, the strand has left its topic (default). */
export const T_INHERIT = 0.15;
/** Spec M6 §4 rule 4: assign without the LLM only above this similarity (default). */
export const T_ASSIGN = 0.35;
/** Spec M6 §4 rule 4: …and with this much daylight to the runner-up; closer is a tie for the LLM (default). */
export const ASSIGN_MARGIN = 0.1;
const MAX_CANDIDATES = 3;

export function meanVector(vecs: Iterable<Float32Array>, dim: number): Float32Array | null {
  const sum = new Float32Array(dim);
  let n = 0;
  for (const v of vecs) { for (let i = 0; i < dim; i++) sum[i]! += v[i]!; n++; }
  if (n === 0) return null;
  for (let i = 0; i < dim; i++) sum[i]! /= n;
  return sum;
}

/** Spec M6 §4: `v − μ` over every stored vector once there are MIN_CENTER of them; copies otherwise. Never mutates the input. */
export function centre(vectors: ReadonlyMap<string, Float32Array>, dim: number): Map<string, Float32Array> {
  const mu = vectors.size >= MIN_CENTER ? meanVector(vectors.values(), dim) : null;
  const out = new Map<string, Float32Array>();
  for (const [id, v] of vectors) {
    const c = Float32Array.from(v);
    if (mu) for (let i = 0; i < dim; i++) c[i]! -= mu[i]!;
    out.set(id, c);
  }
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Spec M6 §4: running mean per topic, updated as the run assigns nodes so later nodes see earlier decisions. */
export class TopicCentroids {
  private readonly sums = new Map<string, { sum: Float32Array; n: number }>();
  constructor(private readonly dim: number) {}
  add(topic: string, vec: Float32Array): void {
    let s = this.sums.get(topic);
    if (!s) { s = { sum: new Float32Array(this.dim), n: 0 }; this.sums.set(topic, s); }
    for (let i = 0; i < this.dim; i++) s.sum[i]! += vec[i]!;
    s.n++;
  }
  has(topic: string): boolean { return this.sums.has(topic); }
  topics(): string[] { return [...this.sums.keys()]; }
  all(): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    for (const [t, { sum, n }] of this.sums) out.set(t, sum.map((x) => x / n));
    return out;
  }
}

export interface Sim { topic: string; sim: number }
export type Decision = { kind: 'assign'; topic: string; sims: Sim[] } | { kind: 'ask'; candidates: string[]; sims: Sim[] };

/** Spec M6 §4 rules 1–5. `sims` is sorted best first and returned for the dry run. */
export function assignTopic(vec: Float32Array, centroids: TopicCentroids, parentTopic: string | undefined): Decision {
  const sims: Sim[] = [...centroids.all()].map(([topic, c]) => ({ topic, sim: cosine(vec, c) })).sort((a, b) => b.sim - a.sim);
  if (sims.length === 0) return { kind: 'ask', candidates: [], sims };
  const best = sims[0]!;
  const second = sims[1]?.sim ?? -Infinity;
  const parent = parentTopic === undefined ? undefined : sims.find((s) => s.topic === parentTopic);
  if (parent && parent.sim >= best.sim - INHERIT_MARGIN && parent.sim >= T_INHERIT) return { kind: 'assign', topic: parent.topic, sims };
  if (best.sim >= T_ASSIGN && best.sim - second >= ASSIGN_MARGIN) return { kind: 'assign', topic: best.topic, sims };
  const candidates = sims.slice(0, MAX_CANDIDATES).map((s) => s.topic);
  if (parent && !candidates.includes(parent.topic)) candidates.push(parent.topic);
  return { kind: 'ask', candidates, sims };
}
```

Export from `packages/index/src/index.ts`:

```ts
export type { TopicInput, TopicNamer } from './types';
export { MIN_CENTER, INHERIT_MARGIN, T_INHERIT, T_ASSIGN, ASSIGN_MARGIN, meanVector, centre, cosine, TopicCentroids, assignTopic, type Sim, type Decision } from './topics';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @chatmind/index test -- topics.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite, commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add packages/index/src/topics.ts packages/index/src/types.ts packages/index/src/index.ts packages/index/test/topics.test.ts
git commit -m "feat(index): pure topic assignment — centring, centroids, assignTopic

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

---

### Task 4: Naming helpers — prompt, `cleanTopic`, `foldTopic`

**Files:**
- Modify: `packages/index/src/topics.ts`, `packages/index/src/index.ts`, `packages/index/test/topics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TOPIC_MAX = 40;
  export const TOPIC_SYSTEM: string;
  export function topicPrompt(input: TopicInput): string
  export function cleanTopic(raw: string): string
  export function topicKey(name: string): string
  export function foldTopic(name: string, existing: Iterable<string>): string
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/index/test/topics.test.ts`:

```ts
import { TOPIC_MAX, TOPIC_SYSTEM, cleanTopic, foldTopic, topicKey, topicPrompt } from '../src/topics';

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
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/index test -- topics.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the naming half**

Append to `packages/index/src/topics.ts`:

```ts
import type { TopicInput } from './types';

/** Spec M6 §4: a topic name is a label, not a sentence. */
export const TOPIC_MAX = 40;

/** Fixed and language-neutral so provider caches can hit; the case travels in the user message (spec M6 §5). */
export const TOPIC_SYSTEM =
  'You file one message from a branching conversation under a topic. Prefer one of the candidate topics if the message belongs there; only if none fits, name a new topic. ' +
  'Reply with exactly the topic name and nothing else — no quotes, no explanation, no punctuation at the end. ' +
  'A topic name has one to four words in the language of the message, names a subject (a noun phrase), and is neither a question nor a sentence.';

/** The user message for the namer (spec M6 §5). Pure. */
export function topicPrompt(input: TopicInput): string {
  const lines = [`Written by: ${input.role}`];
  if (input.candidates.length > 0) {
    lines.push('', 'Candidate topics (with example summaries of messages already filed there):');
    for (const c of input.candidates) lines.push(`- ${c.name}${c.examples.length > 0 ? `: ${c.examples.join(' | ')}` : ''}`);
  } else {
    lines.push('', 'This is the first message of the canvas: name its topic.');
  }
  if (input.allTopics.length > 0) lines.push(`All topics of this canvas: ${input.allTopics.join(', ')}`);
  if (input.parentTopic !== undefined) lines.push(`Topic of the message it replies to: ${input.parentTopic}`);
  lines.push('', 'Message summary:', input.summary);
  return lines.join('\n');
}

// ASCII quotes/backtick plus the curly/typographic pairs and guillemets, as in summary.ts.
const QUOTES = /^[\s"'`“”„‘’‚«»]+|[\s"'`“”„‘’‚«»]+$/g;

/** Spec M6 §4: first line, whitespace collapsed, quotes and trailing periods stripped, ≤ TOPIC_MAX on a word boundary. */
export function cleanTopic(raw: string): string {
  let s = (raw.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim().replace(QUOTES, '').replace(/\.+$/, '').replace(QUOTES, '');
  if (s.length > TOPIC_MAX) {
    // One char past the limit so a word that ends exactly at TOPIC_MAX is kept.
    const cut = s.slice(0, TOPIC_MAX + 1);
    const space = cut.lastIndexOf(' ');
    s = (space > 0 ? cut.slice(0, space) : cut.slice(0, TOPIC_MAX)).trim();
  }
  return s;
}

/** Spec M6 §4: the identity under which two spellings count as the same topic. */
export function topicKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Spec M6 §4: a near-duplicate of an existing topic folds into the existing spelling. */
export function foldTopic(name: string, existing: Iterable<string>): string {
  const key = topicKey(name);
  for (const e of existing) if (topicKey(e) === key) return e;
  return name;
}
```

Move the `import type { TopicInput }` to the top of the file. Add to `packages/index/src/index.ts`:

```ts
export { TOPIC_MAX, TOPIC_SYSTEM, topicPrompt, cleanTopic, topicKey, foldTopic } from './topics';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @chatmind/index test -- topics.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite, commit**

```bash
git add packages/index/src/topics.ts packages/index/src/index.ts packages/index/test/topics.test.ts
git commit -m "feat(index): topic naming helpers — prompt, cleanTopic, foldTopic

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

---

### Task 5: `planTopicJobs` and `writeTopic`

**Files:**
- Modify: `packages/index/src/plan.ts`, `packages/index/src/writeback.ts`, `packages/index/src/index.ts`
- Modify: `packages/index/test/plan.test.ts`, `packages/index/test/writeback.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // plan.ts
  export function planTopicJobs(entries: readonly Entry[], rows: ReadonlyMap<string, NodeRow>): string[]
  // writeback.ts
  export interface TopicWriteJob { id: string; canvas: string; forHash: string; topic: string }
  export interface TopicWriteResult { written: boolean; skipped: 'vanished' | 'body-changed' | 'topics-changed' | null }
  export async function writeTopic(job: TopicWriteJob, deps: { dataDir: string; lock: VaultLock }): Promise<TopicWriteResult>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/index/test/plan.test.ts` (reuse that file's existing helpers for building entries/rows; if it has none, build them inline as below):

```ts
import { planTopicJobs } from '../src/plan';

describe('planTopicJobs (spec M6 §6)', () => {
  const entry = (id: string, over: Partial<MessageNode> = {}): Entry => ({ node: { id, role: 'user', parents: [], created: '2026-01-01T00:00:00Z', summary: '', topics: [], body: 'text', ...over }, canvas: 'm', path: `m/nodes/${id}.md` });
  const row = (id: string, embedded: boolean): NodeRow => ({ id, canvas: 'm', content_hash: contentHash('text'), summary_written: null, summary_for_hash: null, embedded_hash: embedded ? contentHash('text') : null, topic_written: null });
  it('plans nodes with empty topics, a body and a current embedding — nothing else', () => {
    const entries = [entry('A'), entry('B', { topics: ['Set'] }), entry('C', { body: '' }), entry('D')];
    const rows = new Map([['A', row('A', true)], ['B', row('B', true)], ['C', row('C', true)], ['D', row('D', false)]]);
    expect(planTopicJobs(entries, rows)).toEqual(['A']);
  });
});
```

(Imports needed at the top of that file: `MessageNode` from `@chatmind/core`, `NodeRow` from `../src/db`, `contentHash` from `../src/hash`, `Entry` from `../src/plan`.)

Append to `packages/index/test/writeback.test.ts`:

```ts
import { writeTopic } from '../src/writeback';

describe('writeTopic (spec M6 §6)', () => {
  it('writes topics: [name] into the frontmatter and touches nothing else', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const before = await files(root, 'm');
    const res = await writeTopic({ id, canvas: 'm', forHash: contentHash('Frage'), topic: 'Evaluation' }, { dataDir: root, lock: new VaultLock() });
    expect(res).toEqual({ written: true, skipped: null });
    const { node } = await nodeOnDisk(root, 'm', id);
    expect(node.topics).toEqual(['Evaluation']);
    expect(node.summary).toBe('');
    expect(await files(root, 'm')).toEqual(before); // no rename
  });
  it('drops the write when a topic appeared meanwhile, the body changed, or the node vanished', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const deps = { dataDir: root, lock: new VaultLock() };
    const file = path.join(root, 'm', 'nodes', `${id}.md`);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('topics: []', 'topics: [Von Hand]'));
    expect(await writeTopic({ id, canvas: 'm', forHash: contentHash('Frage'), topic: 'X' }, deps)).toEqual({ written: false, skipped: 'topics-changed' });
    expect((await nodeOnDisk(root, 'm', id)).node.topics).toEqual(['Von Hand']);
    expect(await writeTopic({ id, canvas: 'm', forHash: contentHash('anders'), topic: 'X' }, deps)).toMatchObject({ written: false, skipped: 'body-changed' });
    expect(await writeTopic({ id: '01JQ8F2H7T4WKD9M3XBQNAZZZZ', canvas: 'm', forHash: 'h', topic: 'X' }, deps)).toEqual({ written: false, skipped: 'vanished' });
    expect(await writeTopic({ id, canvas: 'nope', forHash: 'h', topic: 'X' }, deps)).toEqual({ written: false, skipped: 'vanished' });
  });
});
```

Note the guard order in the second test: with `topics: [Von Hand]` on disk and a wrong hash, `body-changed` is checked before `topics-changed`, so that call returns `body-changed`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/index test -- plan.test.ts writeback.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Append to `packages/index/src/plan.ts`:

```ts
/** Spec M6 §6: topic candidates — empty `topics`, a body, and a vector for the current body. Pure. */
export function planTopicJobs(entries: readonly Entry[], rows: ReadonlyMap<string, NodeRow>): string[] {
  const out: string[] = [];
  for (const { node } of entries) {
    const row = rows.get(node.id);
    if (!row || node.body === '' || node.topics.length > 0) continue;
    if (row.embedded_hash === row.content_hash) out.push(node.id);
  }
  return out;
}
```

Append to `packages/index/src/writeback.ts`:

```ts
export interface TopicWriteJob {
  id: string;
  canvas: string;
  forHash: string; // content_hash the vector the decision used was made from
  topic: string;
}

export interface TopicWriteResult {
  written: boolean;
  skipped: 'vanished' | 'body-changed' | 'topics-changed' | null;
}

/**
 * Spec M6 §6: one lock turn — re-read the canvas, drop the write if the node vanished, its body changed or
 * someone set a topic meanwhile (their edit wins), else `topics = [topic]`. No rename, no graph.canvas.
 */
export async function writeTopic(job: TopicWriteJob, deps: { dataDir: string; lock: VaultLock }): Promise<TopicWriteResult> {
  return deps.lock.run(async () => {
    const found = await readCanvas(deps.dataDir, job.canvas);
    const graph = found?.graph;
    const node = graph?.nodes.get(job.id);
    if (!graph || !node) return { written: false, skipped: 'vanished' };
    if (contentHash(node.body) !== job.forHash) return { written: false, skipped: 'body-changed' };
    if (node.topics.length > 0) return { written: false, skipped: 'topics-changed' };
    node.topics = [job.topic];
    await writeNode(graph, job.id, deps.dataDir);
    return { written: true, skipped: null };
  });
}
```

Exports in `packages/index/src/index.ts`:

```ts
export { planJobs, planTopicJobs, rowsForPlan, isBareUlidPath, type Entry, type Jobs, type SummaryJob } from './plan';
export { writeback, writeTopic, type WritebackJob, type WritebackResult, type TopicWriteJob, type TopicWriteResult } from './writeback';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @chatmind/index test -- plan.test.ts writeback.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite, commit**

```bash
git add packages/index/src packages/index/test
git commit -m "feat(index): planTopicJobs and writeTopic

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

---

### Task 6: Topic phase in `reconcile`; `Indexer` wiring; fakes

**Files:**
- Create: `packages/index/src/failures.ts`, `packages/index/src/topic-phase.ts`, `packages/index/test/topic-phase.test.ts`
- Modify: `packages/index/src/reconcile.ts`, `packages/index/src/indexer.ts`, `packages/index/src/types.ts`, `packages/index/src/index.ts`, `packages/index/test/fakes.ts`, `packages/index/test/reconcile.test.ts`, `packages/index/test/indexer.test.ts`

**Interfaces:**
- Consumes: `assignTopic`, `TopicCentroids`, `centre`, `meanVector`, `cleanTopic`, `foldTopic`, `topicPrompt` (Task 3–4); `planTopicJobs`, `writeTopic` (Task 5); `db.allVectors`, `db.setTopic` (Task 2); `parentContextOf` (`summary.ts`).
- Produces:
  ```ts
  // failures.ts (moved from reconcile.ts, now exported)
  export interface NodeFailure { hash: string; failures: number }
  export const MAX_FAILURES = 3;
  export function recordFailure(failures: Map<string, NodeFailure> | undefined, id: string, hash: string): void
  export function clearFailure(failures: Map<string, NodeFailure> | undefined, id: string): void
  export function hasGivenUp(failures: Map<string, NodeFailure> | undefined, id: string, hash: string): boolean
  // topic-phase.ts
  export const USER_WAIT_MS = 120_000;
  export interface Candidate { id: string; vec: Float32Array; parentId: string | undefined }
  export interface CanvasTopicState { centroids: TopicCentroids; topicOf: Map<string, string>; examples: Map<string, string[]>; add(id: string, topic: string, vec: Float32Array, summary: string): void }
  export function prepareCanvas(entries: readonly Entry[], centred: ReadonlyMap<string, Float32Array>, jobIds: ReadonlySet<string>, dim: number, now: number): { state: CanvasTopicState; candidates: Candidate[]; deferred: string[] }
  export function summaryOf(node: MessageNode): string            // summary, else body start (parentContextOf)
  export interface TopicPhaseDeps { dataDir: string; db: IndexDb; namer: TopicNamer; lock: VaultLock; dim: number; now: () => number; log: (m: string) => void; failures?: Map<string, NodeFailure> }
  export interface TopicPhaseReport { assigned: number; asked: number; deferred: number; failed: number; gaveUp: number; pending: number }
  export async function runTopicPhase(entries: readonly Entry[], jobIds: readonly string[], deps: TopicPhaseDeps): Promise<TopicPhaseReport>
  // types.ts
  Report { …; topics: number; pending: { embed; summarize; topics } }
  IndexStatus.pending.topics
  // reconcile.ts
  ReconcileDeps { …; namer: TopicNamer; now?: () => number }
  // indexer.ts
  IndexerOptions { …; namer: TopicNamer }
  // test/fakes.ts
  export function topicEmbedder(): Embedder & { calls: string[][] }   // 4-dim one-hot by first letter A/B/C, else [1,1,1,1]
  export function fakeNamer(opts?: { fail?: boolean }): TopicNamer & { calls: TopicInput[]; fail: boolean }  // returns `Topic ${first letter of summary}`
  ```

- [ ] **Step 1: Move the failure helpers**

Create `packages/index/src/failures.ts` with `NodeFailure`, `MAX_FAILURES`, `recordFailure`, `clearFailure`, `hasGivenUp` cut verbatim from `reconcile.ts` (keep their doc comments), all exported. In `reconcile.ts` replace the definitions with `import { clearFailure, hasGivenUp, MAX_FAILURES, recordFailure, type NodeFailure } from './failures';` and keep re-exporting for the public API: `export { MAX_FAILURES, type NodeFailure } from './failures';` (so `packages/index/src/index.ts` stays valid). Run `pnpm --filter @chatmind/index test` — still green.

- [ ] **Step 2: Add the fakes**

Append to `packages/index/test/fakes.ts`:

```ts
import type { TopicInput, TopicNamer } from '../src/types';

/** One-hot 4-dim vector by the text's first letter (A/B/C → axes 0/1/2), anything else → [1,1,1,1]; records calls. */
export function topicEmbedder(): Embedder & { calls: string[][] } {
  const e = {
    model: 'fake/topic-embed',
    dim: 4,
    calls: [] as string[][],
    async embed(texts: string[]): Promise<Float32Array[]> {
      e.calls.push(texts);
      return texts.map((t) => {
        const axis = 'ABC'.indexOf(t[0] ?? '');
        if (axis < 0) return Float32Array.from([1, 1, 1, 1]);
        const v = new Float32Array(4);
        v[axis] = 1;
        return v;
      });
    },
  };
  return e;
}

/** Names the topic after the summary's first letter ("Topic A"); records calls; can fail. */
export function fakeNamer(opts: { fail?: boolean } = {}): TopicNamer & { calls: TopicInput[]; fail: boolean } {
  const n = Object.assign(
    async (input: TopicInput): Promise<string> => {
      n.calls.push(input);
      if (n.fail) throw new Error('namer down');
      return `Topic ${input.summary.replace(/^[A-Z]+: /, '')[0] ?? '?'}`;
    },
    { calls: [] as TopicInput[], fail: opts.fail ?? false },
  );
  return n;
}
```

(`fakeSummarizer` returns `"DE: <body start>"`, so the namer strips the `XX: ` label to read the body's first letter.)

- [ ] **Step 3: Write the failing tests for `prepareCanvas`**

Create `packages/index/test/topic-phase.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { MessageNode } from '@chatmind/core';
import type { Entry } from '../src/plan';
import { USER_WAIT_MS, prepareCanvas, summaryOf } from '../src/topic-phase';

const T0 = Date.parse('2026-09-21T10:00:00Z');
const iso = (offsetS: number): string => new Date(T0 + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const node = (id: string, over: Partial<MessageNode>): Entry => ({ node: { id, role: 'user', parents: [], created: iso(0), summary: '', topics: [], body: `${id} body`, ...over }, canvas: 'm', path: `m/nodes/${id}.md` });
const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe('prepareCanvas (spec M6 §4 user nodes, §6)', () => {
  it('seeds the state from assigned nodes and lists candidates in created order with their parent ids', () => {
    const entries = [
      node('P', { topics: ['Alpha'], summary: 'P sum', created: iso(0) }),
      node('B', { parents: ['A'], created: iso(20) }),
      node('A', { role: 'assistant', parents: ['P'], created: iso(10) }),
    ];
    const centred = new Map([['P', v(1, 0)], ['A', v(1, 0)], ['B', v(0, 1)]]);
    // B is a user node without a reply: with `now` past USER_WAIT_MS it is judged alone, not deferred.
    const { state, candidates, deferred } = prepareCanvas(entries, centred, new Set(['A', 'B']), 2, T0 + USER_WAIT_MS + 60_000);
    expect(state.centroids.topics()).toEqual(['Alpha']);
    expect(state.topicOf.get('P')).toBe('Alpha');
    expect(state.examples.get('Alpha')).toEqual(['P sum']);
    expect(candidates.map((c) => [c.id, c.parentId])).toEqual([['A', 'P'], ['B', 'A']]);
    expect(deferred).toEqual([]);
  });
  it('a user node is judged with its oldest assistant reply (mean vector); without one it is deferred while young', () => {
    const entries = [
      node('U', { created: iso(0) }),
      node('R2', { role: 'assistant', parents: ['U'], created: iso(5) }),
      node('R1', { role: 'assistant', parents: ['U'], created: iso(2) }),
      node('Y', { created: iso(50) }),
      node('O', { created: iso(0) }),
    ];
    const centred = new Map([['U', v(1, 0)], ['R1', v(0, 1)], ['R2', v(5, 5)], ['Y', v(1, 1)], ['O', v(1, 1)]]);
    const now = T0 + USER_WAIT_MS + 1000; // U and O are old, Y (created 50 s in) is young
    const { candidates, deferred } = prepareCanvas(entries, centred, new Set(['U', 'R1', 'R2', 'Y', 'O']), 2, now);
    expect(Array.from(candidates.find((c) => c.id === 'U')!.vec)).toEqual([0.5, 0.5]); // mean of U and R1, not R2
    expect(deferred).toEqual(['Y']);
    expect(candidates.some((c) => c.id === 'Y')).toBe(false);
    expect(Array.from(candidates.find((c) => c.id === 'O')!.vec)).toEqual([1, 1]); // old, alone
  });
  it('a user node whose reply has no vector yet is deferred, not judged alone', () => {
    const entries = [node('U', { created: iso(0) }), node('R', { role: 'assistant', parents: ['U'], created: iso(1) })];
    const centred = new Map([['U', v(1, 0)]]);
    const { candidates, deferred } = prepareCanvas(entries, centred, new Set(['U']), 2, T0 + 1000);
    expect(candidates).toEqual([]);
    expect(deferred).toEqual(['U']);
  });
  it('state.add updates topicOf, centroids and examples (max 3)', () => {
    const { state } = prepareCanvas([], new Map(), new Set(), 2, T0);
    for (const i of [1, 2, 3, 4]) state.add(`n${i}`, 'T', v(1, 0), `s${i}`);
    expect(state.examples.get('T')).toEqual(['s1', 's2', 's3']);
    expect(state.topicOf.get('n4')).toBe('T');
    expect(Array.from(state.centroids.all().get('T')!)).toEqual([1, 0]);
  });
  it('summaryOf prefers the summary, else the body start', () => {
    expect(summaryOf(node('X', { summary: 'S' }).node)).toBe('S');
    expect(summaryOf(node('X', { body: 'Body  text\nmore' }).node)).toBe('Body text more');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/index test -- topic-phase.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `topic-phase.ts`**

Create `packages/index/src/topic-phase.ts`:

```ts
import { detectLanguage, type MessageNode, type VaultLock } from '@chatmind/core';
import type { IndexDb } from './db';
import { clearFailure, hasGivenUp, MAX_FAILURES, recordFailure, type NodeFailure } from './failures';
import { contentHash } from './hash';
import type { Entry } from './plan';
import { parentContextOf } from './summary';
import { assignTopic, cleanTopic, foldTopic, meanVector, TopicCentroids } from './topics';
import type { TopicNamer } from './types';
import { writeTopic } from './writeback';

/** Spec M6 §4: a user node without an embedded assistant reply waits this long (by `created`) before being judged alone. */
export const USER_WAIT_MS = 120_000;
const MAX_EXAMPLES = 3;

export interface Candidate { id: string; vec: Float32Array; parentId: string | undefined }

/** Spec M6 §6: the canvas's topics as the run sees them, updated after every assignment. */
export interface CanvasTopicState {
  centroids: TopicCentroids;
  topicOf: Map<string, string>;
  examples: Map<string, string[]>;
  add(id: string, topic: string, vec: Float32Array, summary: string): void;
}

/** The summary, else the start of the body — what the namer sees of a node. */
export function summaryOf(node: MessageNode): string {
  return parentContextOf(node);
}

function newState(dim: number): CanvasTopicState {
  const state: CanvasTopicState = {
    centroids: new TopicCentroids(dim),
    topicOf: new Map(),
    examples: new Map(),
    add(id, topic, vec, summary) {
      state.topicOf.set(id, topic);
      state.centroids.add(topic, vec);
      const ex = state.examples.get(topic) ?? [];
      if (ex.length < MAX_EXAMPLES && summary !== '') ex.push(summary);
      state.examples.set(topic, ex);
    },
  };
  return state;
}

/**
 * Spec M6 §4/§6: seed the state from nodes that already have a topic (in `created` order, so examples are the
 * earliest), then list the candidates in `created` order. A user candidate is paired with its oldest assistant
 * child that has a vector (mean of both); without one it is deferred while younger than USER_WAIT_MS.
 */
export function prepareCanvas(entries: readonly Entry[], centred: ReadonlyMap<string, Float32Array>, jobIds: ReadonlySet<string>, dim: number, now: number): { state: CanvasTopicState; candidates: Candidate[]; deferred: string[] } {
  const state = newState(dim);
  const sorted = [...entries].sort((a, b) => (a.node.created < b.node.created ? -1 : a.node.created > b.node.created ? 1 : a.node.id < b.node.id ? -1 : 1));
  for (const { node } of sorted) {
    const topic = node.topics[0];
    if (topic === undefined || topic === '') continue;
    const vec = centred.get(node.id);
    if (vec) state.centroids.add(topic, vec);
    state.topicOf.set(node.id, topic);
    const ex = state.examples.get(topic) ?? [];
    const s = summaryOf(node);
    if (ex.length < MAX_EXAMPLES && s !== '') ex.push(s);
    state.examples.set(topic, ex);
  }
  const candidates: Candidate[] = [];
  const deferred: string[] = [];
  for (const { node } of sorted) {
    if (!jobIds.has(node.id)) continue;
    const own = centred.get(node.id);
    if (!own) continue;
    let vec = own;
    if (node.role === 'user') {
      const replies = sorted.filter((e) => e.node.role === 'assistant' && e.node.parents[0] === node.id);
      const reply = replies.find((e) => centred.has(e.node.id));
      if (reply) vec = meanVector([own, centred.get(reply.node.id)!], dim)!;
      else if (now - Date.parse(node.created) < USER_WAIT_MS) { deferred.push(node.id); continue; }
    }
    candidates.push({ id: node.id, vec, parentId: node.parents[0] });
  }
  return { state, candidates, deferred };
}
```

- [ ] **Step 6: Run the `prepareCanvas` tests**

Run: `pnpm --filter @chatmind/index test -- topic-phase.test.ts`
Expected: PASS. (In the "oldest reply" test both R1 and R2 have vectors; R1 is older → `[0.5, 0.5]`. In the third test R has no vector → deferred.)

- [ ] **Step 7: Write the failing end-to-end reconcile tests**

Update `packages/index/test/reconcile.test.ts`: import `fakeNamer`, `topicEmbedder` from `./fakes` and `nodeOnDisk`; extend `deps()` to include `namer: fakeNamer()` and `now: () => Date.now()`. Every existing `toMatchObject({ … pending: { embed: 0, summarize: 0 } })` must become `pending: { embed: 0, summarize: 0, topics: 0 }` where the whole `pending` object is asserted.

Append a new describe block:

```ts
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
    expect(r).toMatchObject({ topics: 3, pending: { topics: 0 } });
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

  it('a fresh db over a topic-complete vault writes no topic', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: A1 }, { role: 'assistant', content: A2, model: 'x' }]);
    await reconcile(deps(root, { embedder: topicEmbedder(), now: old }));
    const before = await Promise.all([...graph.nodes.keys()].map((id) => nodeOnDisk(root, 'm', id)));
    const d2 = deps(root, { embedder: topicEmbedder(), now: old });
    const r = await reconcile(d2);
    expect(r).toMatchObject({ embedded: 2, topics: 0 });
    expect(d2.namer.calls).toHaveLength(0);
    const after = await Promise.all([...graph.nodes.keys()].map((id) => nodeOnDisk(root, 'm', id)));
    expect(after.map((n) => n.node.topics)).toEqual(before.map((n) => n.node.topics));
    expect(d2.db.rows().get([...graph.nodes.keys()][0]!)!.topic_written).toBeNull(); // we no longer know it was ours
  });
});
```

Imports to add at the top: `readVault`, `isoTimestamp` from `@chatmind/core`, `USER_WAIT_MS` from `../src/topic-phase`, `MAX_FAILURES` from `../src/reconcile` (already re-exported), `fakeNamer`, `topicEmbedder` from `./fakes`.

Note on the summarizer in these tests: `fakeSummarizer` returns `DE: Alpha Frage eins` etc.; the summary loop updates the in-memory node (Step 9), so the namer sees these summaries, and `fakeNamer` (which strips the `DE: ` label) returns `Topic A`/`Topic B`. For the user node in the split test, the namer's `summary` is the user's summary plus the reply's, joined with ` — ` (see `runTopicPhase`), so `.includes('Beta')` holds.

- [ ] **Step 8: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/index test -- reconcile.test.ts`
Expected: FAIL — `topics` missing from the report, `namer` unknown.

- [ ] **Step 9: Implement `runTopicPhase` and wire it into `reconcile`**

Append to `packages/index/src/topic-phase.ts`:

```ts
export interface TopicPhaseDeps {
  dataDir: string;
  db: IndexDb;
  namer: TopicNamer;
  lock: VaultLock;
  dim: number;
  now: () => number;
  log: (msg: string) => void;
  failures?: Map<string, NodeFailure>;
}

export interface TopicPhaseReport { assigned: number; asked: number; deferred: number; failed: number; gaveUp: number; pending: number }

/**
 * Spec M6 §6: per canvas, serially — centre every stored vector once, seed the topic state from the frontmatter,
 * walk the candidates in created order: assign by similarity, or ask the namer; write; feed the state.
 */
export async function runTopicPhase(entries: readonly Entry[], jobIds: readonly string[], deps: TopicPhaseDeps): Promise<TopicPhaseReport> {
  const report: TopicPhaseReport = { assigned: 0, asked: 0, deferred: 0, failed: 0, gaveUp: 0, pending: 0 };
  if (jobIds.length === 0) return report;
  const centred = centre(deps.db.allVectors(), deps.dim);
  const byId = new Map(entries.map((e) => [e.node.id, e]));
  const jobs = new Set(jobIds);
  const canvases = [...new Set(entries.map((e) => e.canvas))].sort();
  for (const canvas of canvases) {
    const own = entries.filter((e) => e.canvas === canvas);
    const { state, candidates, deferred } = prepareCanvas(own, centred, jobs, deps.dim, deps.now());
    report.deferred += deferred.length;
    report.pending += deferred.length;
    for (const c of candidates) {
      const { node } = byId.get(c.id)!;
      const forHash = contentHash(node.body);
      if (hasGivenUp(deps.failures, c.id, forHash)) { report.gaveUp += 1; continue; }
      const parentTopic = c.parentId === undefined ? undefined : state.topicOf.get(c.parentId);
      try {
        const decision = assignTopic(c.vec, state.centroids, parentTopic);
        let topic: string;
        if (decision.kind === 'assign') {
          topic = decision.topic;
        } else {
          report.asked += 1;
          const reply = node.role === 'user' ? own.find((e) => e.node.role === 'assistant' && e.node.parents[0] === node.id && centred.has(e.node.id)) : undefined;
          const summary = reply ? `${summaryOf(node)} — ${summaryOf(reply.node)}` : summaryOf(node);
          const input = {
            summary,
            role: node.role,
            lang: detectLanguage([node.body]),
            candidates: decision.candidates.map((name) => ({ name, examples: state.examples.get(name) ?? [] })),
            allTopics: state.centroids.topics(),
            ...(parentTopic === undefined ? {} : { parentTopic }),
          };
          topic = foldTopic(cleanTopic(await deps.namer(input)), state.centroids.topics());
          if (topic === '') throw new Error('empty topic name');
        }
        const res = await writeTopic({ id: c.id, canvas, forHash, topic }, deps);
        if (res.skipped !== null) {
          deps.log(`topic for ${c.id} dropped: ${res.skipped}`);
          if (res.skipped === 'body-changed') report.pending += 1; // re-planned once the new body is embedded
          continue;
        }
        deps.db.setTopic(c.id, topic);
        clearFailure(deps.failures, c.id);
        state.add(c.id, topic, c.vec, summaryOf(node));
        report.assigned += 1;
      } catch (err) {
        recordFailure(deps.failures, c.id, forHash);
        report.failed += 1;
        if (hasGivenUp(deps.failures, c.id, forHash)) {
          report.gaveUp += 1;
          deps.log(`giving up on ${c.id} after ${MAX_FAILURES} failures until its body changes`);
          continue;
        }
        report.pending += 1;
        deps.log(`topic failed for ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return report;
}
```

In `packages/index/src/types.ts` extend the report types:

```ts
export interface Report {
  at: string;
  nodes: number;
  embedded: number;
  summarized: number;
  renamed: number;
  /** Spec M6 §6: topics written this run. */
  topics: number;
  failed: number;
  gaveUp: number;
  pending: { embed: number; summarize: number; topics: number };
}

export interface IndexStatus {
  enabled: boolean;
  running: boolean;
  lastRun: Report | null;
  pending: { embed: number; summarize: number; topics: number };
}
```

In `packages/index/src/reconcile.ts`:

- `ReconcileDeps` gains `namer: TopicNamer;` and `/** Spec M6 §6: clock for the user-node deferral; tests inject it. */ now?: () => number;`.
- `countPending` returns `{ embed, summarize, topics: planTopicJobs(entries, rows).length }` (compute `rows` once).
- The initial report becomes `{ at, nodes: entries.length, embedded: 0, summarized: 0, renamed: 0, topics: 0, failed: 0, gaveUp: 0, pending: { embed: 0, summarize: 0, topics: 0 } }`.
- In the summary loop, right after `deps.db.setSummary(id, summary, forHash);` add `node.summary = summary; // the topic phase below reads summaries from these entries` so the namer's examples are this run's summaries, not the pre-run `''`.
- After the rename loop, before `return report`:

```ts
  // Spec M6 §6: topics last — summaries are the namer's examples, and the embed loop above supplied the vectors.
  const topicJobs = planTopicJobs(entries, deps.db.rows());
  const t = await runTopicPhase(entries, topicJobs, { dataDir: deps.dataDir, db: deps.db, namer: deps.namer, lock: deps.lock, dim: deps.embedder.dim, now: deps.now ?? Date.now, log, failures: deps.failures });
  report.topics = t.assigned;
  report.failed += t.failed;
  report.gaveUp += t.gaveUp;
  report.pending.topics = t.pending;
```

Import `planTopicJobs` from `./plan`, `runTopicPhase` from `./topic-phase`, `TopicNamer` from `./types`.

In `packages/index/src/indexer.ts`: `IndexerOptions` gains `namer: TopicNamer;`; pass `namer: this.o.namer` into `reconcile`; the pending sum becomes `this.lastRun.pending.embed + this.lastRun.pending.summarize + this.lastRun.pending.topics`; `status()` defaults to `{ embed: 0, summarize: 0, topics: 0 }`.

Update `packages/index/test/indexer.test.ts`: every `Indexer` construction gets `namer: fakeNamer()`; every `pending` `toEqual` gains `topics: 0`.

Exports in `packages/index/src/index.ts`:

```ts
export { USER_WAIT_MS, prepareCanvas, runTopicPhase, summaryOf, type Candidate, type CanvasTopicState, type TopicPhaseDeps, type TopicPhaseReport } from './topic-phase';
```

- [ ] **Step 10: Run the index tests**

Run: `pnpm --filter @chatmind/index test`
Expected: PASS. If the "split" test's `Topic B` naming fails, check `fakeNamer`: the combined summary is `DE: Beta ganz anderes … — DE: Beta Antwort`; the regex strips only the leading label, so the first letter is `B`.

- [ ] **Step 11: Run the whole suite, commit**

Run: `pnpm typecheck && pnpm test` — `apps/server` and `apps/cli` will fail to typecheck until Task 7 adds the namer; if so, finish Task 7's wiring step (Step 3 there) before committing, or commit this task with the server/CLI compile fix included. Prefer the latter: add `namer` to the server's `Indexer` construction and to the CLI test's `reconcile` call now (see Task 7 Step 3 for the exact lines).

```bash
git add packages/index apps/server/src/index.ts apps/cli/test
git commit -m "feat(index): topic phase in reconcile — assign, ask, write, defer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

---

### Task 7: Server namer; CLI `index status` + `index topics --dry-run`

**Files:**
- Modify: `apps/server/src/index-providers.ts`, `apps/server/src/index.ts`, `apps/server/test/index-providers.test.ts`
- Modify: `apps/cli/src/index-status.ts`, `apps/cli/src/index.ts`, `apps/cli/test/index-status.test.ts`
- Create: `apps/cli/src/index-topics.ts`, `apps/cli/test/index-topics.test.ts`

**Interfaces:**
- Consumes: `TOPIC_SYSTEM`, `topicPrompt`, `TopicNamer`, `planTopicJobs`, `prepareCanvas`, `assignTopic`, `centre`, `IndexDb.openReadonly(file, { vec: true })`, `rowsForPlan`.
- Produces:
  ```ts
  // apps/server/src/index-providers.ts
  export function createTopicNamer(model: LanguageModel): TopicNamer
  export function openRouterIndexProviders(apiKey, s): { summarizer: Summarizer; embedder: Embedder; namer: TopicNamer }
  // apps/cli/src/index-topics.ts
  export async function indexTopicsDryRun(dataDir?: string, now?: () => number): Promise<number>
  ```

- [ ] **Step 1: Write the failing server test**

Append to `apps/server/test/index-providers.test.ts`:

```ts
import { TOPIC_SYSTEM } from '@chatmind/index';
import { createTopicNamer } from '../src/index-providers';

describe('createTopicNamer (spec M6 §5)', () => {
  it('sends the fixed system prompt and the case, returns the raw text', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Zentroid-Ansatz' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: undefined, reasoning: undefined } },
        warnings: [],
      }),
    });
    const name = createTopicNamer(model);
    expect(await name({ summary: 'Frage nach Zentroiden', role: 'user', lang: 'de', parentTopic: 'Evaluation', candidates: [{ name: 'Evaluation', examples: ['x'] }], allTopics: ['Evaluation'] })).toBe('Zentroid-Ansatz');
    const call = model.doGenerateCalls[0]!;
    expect(call.prompt[0]).toMatchObject({ role: 'system', content: TOPIC_SYSTEM });
    const userMessage = JSON.stringify(call.prompt[1]);
    expect(userMessage).toContain('Frage nach Zentroiden');
    expect(userMessage).toContain('- Evaluation: x');
    expect(call.maxOutputTokens).toBe(60);
    expect(call.providerOptions).toEqual({ openrouter: { reasoning: { effort: 'minimal' } } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @chatmind/server test -- index-providers.test.ts`
Expected: FAIL — `createTopicNamer` not exported.

- [ ] **Step 3: Implement the namer and wire it**

In `apps/server/src/index-providers.ts` add to the import from `@chatmind/index`: `TOPIC_SYSTEM, topicPrompt, type TopicNamer`, and add:

```ts
/** Spec M6 §5: the summary model names topics; the prompt lives in @chatmind/index, cleaning and folding too. */
export function createTopicNamer(model: LanguageModel): TopicNamer {
  return async (input) => {
    const { text } = await generateText({
      model,
      system: TOPIC_SYSTEM,
      prompt: topicPrompt(input),
      maxOutputTokens: 60,
      providerOptions: { openrouter: { reasoning: { effort: 'minimal' } } },
    });
    return text;
  };
}
```

Change `openRouterIndexProviders`:

```ts
export function openRouterIndexProviders(apiKey: string, s: IndexSettings): { summarizer: Summarizer; embedder: Embedder; namer: TopicNamer } {
  const openrouter = createOpenRouter({ apiKey });
  const model = openrouter(s.summaryModel);
  return {
    summarizer: createSummarizer(model),
    embedder: createEmbedder(openrouter.textEmbeddingModel(s.embedModel), s.embedModel, s.embedDim),
    namer: createTopicNamer(model),
  };
}
```

In `apps/server/src/index.ts`:

```ts
    const { summarizer, embedder, namer } = openRouterIndexProviders(keys.openrouter, settings);
    indexer = new Indexer({ dataDir, dbFile: path.join(dataDir, '.app', 'index.db'), summarizer, embedder, namer, lock });
```

In `apps/cli/test/index-status.test.ts` the `reconcile` call gains `namer: async () => 'Thema'`.

- [ ] **Step 4: Run the server test to verify it passes**

Run: `pnpm --filter @chatmind/server test -- index-providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI tests**

Update `apps/cli/test/index-status.test.ts` expectations:

```ts
    expect(lines.join('\n')).toMatch(/canvas m: 2 nodes, 0 embedded, 0 summarized, 0 topics, pending embed 2, pending summary 2, pending topics 0/);
```
and after the reconcile:
```ts
    expect(out).toMatch(/canvas m: 2 nodes, 2 embedded, 2 summarized, 2 topics, pending embed 0, pending summary 0, pending topics 0/);
```
(the fake namer names both nodes "Thema"; the `reconcile` call there must pass `now: () => Date.now() + 200_000` so the young user nodes are not deferred).

Create `apps/cli/test/index-topics.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { VaultLock, linearGraph, writeCanvas } from '@chatmind/core';
import { IndexDb, reconcile } from '@chatmind/index';
import { indexTopicsDryRun } from '../src/index-topics';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  return { lines, restore: () => spy.mockRestore() };
}

// One-hot by first letter, like the index package's topicEmbedder.
const embedder = { model: 'fake/e', dim: 4, embed: async (t: string[]) => t.map((s) => { const v = new Float32Array(4); const i = 'ABC'.indexOf(s[0] ?? ''); if (i >= 0) v[i] = 1; else v.fill(1); return v; }) };

describe('chatmind index topics --dry-run (spec M6 §6)', () => {
  it('prints similarities and decisions without writing or naming', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
    dirs.push(root);
    await writeCanvas(linearGraph('m', [{ role: 'user', content: 'Alpha eins\nzwei' }, { role: 'assistant', content: 'Alpha zwei\ndrei', model: 'x' }, { role: 'user', content: 'Beta drei\nvier' }]), root);
    const db = IndexDb.open(path.join(root, '.app', 'index.db'), embedder);
    const far = () => Date.now() + 200_000;
    // Index with a namer that fails: vectors and summaries land, topics do not.
    await reconcile({ dataDir: root, db, embedder, summarizer: async ({ body }) => `T ${body.slice(0, 10)}`, namer: async () => { throw new Error('off'); }, lock: new VaultLock(), now: far });
    db.close();
    // Give the first node ("Alpha eins") a topic by hand so there is a centroid.
    const nodes = path.join(root, 'm', 'nodes');
    for (const name of await fs.readdir(nodes)) {
      const f = path.join(nodes, name);
      const text = await fs.readFile(f, 'utf8');
      if (text.includes('Alpha eins')) await fs.writeFile(f, text.replace('topics: []', 'topics: [Alpha]'));
    }
    const { lines, restore } = capture();
    expect(await indexTopicsDryRun(root, far)).toBe(0);
    restore();
    const out = lines.join('\n');
    expect(out).toMatch(/canvas m: 1 topic \(Alpha\), 2 candidates, 0 deferred/);
    expect(out).toMatch(/assistant parent Alpha \| Alpha=1\.00 \| → assign Alpha/);
    // The Beta node's parent is the assistant, which the dry run does not assign — so no parent topic.
    expect(out).toMatch(/user parent - \| Alpha=0\.00 \| → would ask \[Alpha\]/);
    // nothing written
    const after = await Promise.all((await fs.readdir(nodes)).map((n) => fs.readFile(path.join(nodes, n), 'utf8')));
    expect(after.filter((t) => t.includes('topics: []'))).toHaveLength(2);
  });

  it('says so when there is no index', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
    dirs.push(root);
    await writeCanvas(linearGraph('m', [{ role: 'user', content: 'x' }]), root);
    const { lines, restore } = capture();
    expect(await indexTopicsDryRun(root)).toBe(0);
    restore();
    expect(lines.join('\n')).toMatch(/no index/);
  });
});
```

- [ ] **Step 6: Run the CLI tests to verify they fail**

Run: `pnpm --filter @chatmind/cli test`
Expected: FAIL — status line format, `index-topics` missing.

- [ ] **Step 7: Implement the CLI**

In `apps/cli/src/index-status.ts`, import `planTopicJobs` and extend the per-canvas line:

```ts
    const topics = entries.filter((e) => e.node.topics.length > 0).length;
    const pendingTopics = planTopicJobs(entries, fresh).length;
    console.log(`canvas ${g.slug}: ${entries.length} nodes, ${embedded} embedded, ${summarized} summarized, ${topics} topics, pending embed ${jobs.embed.length}, pending summary ${jobs.summarize.length}, pending topics ${pendingTopics}`);
```

Create `apps/cli/src/index-topics.ts`:

```ts
import path from 'node:path';
import { exists, readVault, resolveDataDir } from '@chatmind/core';
import { IndexDb, assignTopic, centre, planTopicJobs, prepareCanvas, rowsForPlan, type Entry } from '@chatmind/index';

/**
 * Spec M6 §6: the calibration tool — runs the assignment over every candidate with the stored vectors, prints
 * similarities and decisions, writes nothing and never calls the namer (`ask` prints as "would ask"). Exit 0 always.
 */
export async function indexTopicsDryRun(dataDir?: string, now: () => number = Date.now): Promise<number> {
  const root = resolveDataDir(dataDir);
  const file = path.join(root, '.app', 'index.db');
  console.log(`data dir: ${root}`);
  if (!(await exists(file))) { console.log('no index (.app/index.db missing) — start the server to build it'); return 0; }
  const db = IndexDb.openReadonly(file, { vec: true });
  try {
    const { canvases } = await readVault(root);
    const vectors = db.allVectors();
    const dim = Number(db.meta('embed_dim'));
    const centred = centre(vectors, dim);
    console.log(`${vectors.size} vectors, dim ${dim}, centring ${vectors.size >= 8 ? 'on' : 'off'}`);
    const rows = db.rows();
    for (const g of canvases) {
      const entries: Entry[] = [...g.nodes.values()].map((node) => ({ node, canvas: g.slug, path: g.paths.get(node.id)! }));
      const jobs = new Set(planTopicJobs(entries, rowsForPlan(entries, rows)));
      const { state, candidates, deferred } = prepareCanvas(entries, centred, jobs, dim, now());
      const topics = state.centroids.topics();
      console.log(`canvas ${g.slug}: ${topics.length} topic${topics.length === 1 ? '' : 's'} (${topics.join(', ')}), ${candidates.length} candidates, ${deferred.length} deferred`);
      for (const c of candidates) {
        const node = g.nodes.get(c.id)!;
        const parentTopic = c.parentId === undefined ? undefined : state.topicOf.get(c.parentId);
        const d = assignTopic(c.vec, state.centroids, parentTopic);
        const sims = d.sims.slice(0, 3).map((s) => `${s.topic}=${s.sim.toFixed(2)}`).join(' ');
        const verdict = d.kind === 'assign' ? `assign ${d.topic}` : `would ask [${d.candidates.join(', ')}]`;
        console.log(`  ${c.id} ${node.role} parent ${parentTopic ?? '-'} | ${sims || '(no topics)'} | → ${verdict}`);
      }
      for (const id of deferred) console.log(`  ${id} user → deferred (waiting for a reply)`);
    }
  } finally {
    db.close();
  }
  return 0;
}
```

Route it in `apps/cli/src/index.ts`: add `'dry-run': { type: 'boolean' }` to the options, extend `USAGE` with `  chatmind index topics --dry-run [--data-dir <path>]`, and:

```ts
    case 'index': {
      if (rest[0] === 'status') return indexStatus(dataDir);
      if (rest[0] === 'topics' && values['dry-run']) return indexTopicsDryRun(dataDir);
      console.error(USAGE);
      return 2;
    }
```

Export what the CLI needs from `packages/index/src/index.ts` if not yet exported (`assignTopic`, `centre`, `prepareCanvas`, `planTopicJobs`, `rowsForPlan` — all added in Tasks 3–6).

- [ ] **Step 8: Run the CLI tests to verify they pass**

Run: `pnpm --filter @chatmind/cli test`
Expected: PASS. If the readonly handle cannot load sqlite-vec (`SQLITE_READONLY` on load), open the dry run's db with `IndexDb.open(file, { model: db.meta('embed_model'), dim })` instead and note it in the doc comment — the dry run then holds a write handle but performs no writes.

- [ ] **Step 9: Run the whole suite, commit**

```bash
git add apps/server apps/cli packages/index/src/index.ts
git commit -m "feat(server,cli): topic namer; index status shows topics; index topics --dry-run

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

---

### Task 8: Web — palette, card and panel colours

**Files:**
- Create: `apps/web/src/topics.ts`, `apps/web/test/topics.test.ts`
- Modify: `apps/web/src/flow.ts`, `apps/web/src/MessageNode.tsx`, `apps/web/src/NodePanel.tsx`, `apps/web/src/GraphView.tsx`, `apps/web/src/styles.css`
- Modify: `apps/web/test/flow.test.ts`, `apps/web/test/MessageNode.test.tsx`, `apps/web/test/NodePanel.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // apps/web/src/topics.ts
  export const TOPIC_COLOURS = 10;
  export interface TopicEntry { name: string; index: number; count: number }
  export function topicPalette(dto: CanvasDto): Map<string, number>
  export function topicList(dto: CanvasDto): TopicEntry[]
  export function nodesOfTopic(dto: CanvasDto, name: string): string[]
  // apps/web/src/flow.ts
  export interface TopicMarks { palette: ReadonlyMap<string, number>; active: string | null }
  MessageNodeData { …; topic?: string; topicIndex?: number; dimmed?: boolean }
  export function toFlowNodes(dto, streams?, marks?, topics?: TopicMarks)
  // GraphView Props: + topics: TopicMarks
  // NodePanel props: + palette?: ReadonlyMap<string, number>
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/topics.test.ts`:

```ts
import type { CanvasDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { TOPIC_COLOURS, nodesOfTopic, topicList, topicPalette } from '../src/topics';

const n = (id: string, created: string, topics: string[]) => ({ id, role: 'user' as const, parents: [], created, summary: '', topics, body: '', layout: { x: 0, y: 0, width: 400, height: 200 } });
const dto = (nodes: ReturnType<typeof n>[]): CanvasDto => ({ slug: 'm', nodes, edges: [], repairs: [] });

describe('topics (spec M6 §7)', () => {
  it('palette indexes topics by first appearance (earliest created), cycling after TOPIC_COLOURS', () => {
    const d = dto([n('b', '2026-01-02', ['Beta']), n('a', '2026-01-01', ['Alpha']), n('c', '2026-01-03', ['Alpha']), n('x', '2026-01-04', [])]);
    expect([...topicPalette(d)]).toEqual([['Alpha', 0], ['Beta', 1]]);
    const many = dto(Array.from({ length: TOPIC_COLOURS + 1 }, (_, i) => n(`n${i}`, `2026-01-${String(i + 1).padStart(2, '0')}`, [`T${i}`])));
    expect(topicPalette(many).get(`T${TOPIC_COLOURS}`)).toBe(0);
  });
  it('topicList counts nodes per topic in palette order; nodesOfTopic lists ids', () => {
    const d = dto([n('b', '2026-01-02', ['Beta']), n('a', '2026-01-01', ['Alpha']), n('c', '2026-01-03', ['Alpha'])]);
    expect(topicList(d)).toEqual([{ name: 'Alpha', index: 0, count: 2 }, { name: 'Beta', index: 1, count: 1 }]);
    expect(nodesOfTopic(d, 'Alpha')).toEqual(['a', 'c']);
  });
});
```

Append to `apps/web/test/flow.test.ts` (reuse its existing fixture dto; otherwise build one as above):

```ts
  it('carries topic, colour index and dimming into node data (spec M6 §7)', () => {
    const d: CanvasDto = { slug: 'm', edges: [], repairs: [], nodes: [
      { id: 'a', role: 'user', parents: [], created: 'c', summary: '', topics: ['Alpha'], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } },
      { id: 'b', role: 'user', parents: [], created: 'c', summary: '', topics: [], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } },
    ] };
    const palette = new Map([['Alpha', 3]]);
    const off = toFlowNodes(d, undefined, undefined, { palette, active: null });
    expect(off[0]!.data).toMatchObject({ topic: 'Alpha', topicIndex: 3 });
    expect(off[0]!.data).not.toHaveProperty('dimmed');
    expect(off[1]!.data).not.toHaveProperty('topic');
    const on = toFlowNodes(d, undefined, undefined, { palette, active: 'Alpha' });
    expect(on[0]!.data).not.toHaveProperty('dimmed');
    expect(on[1]!.data).toMatchObject({ dimmed: true });
  });
```

Append to `apps/web/test/MessageNode.test.tsx`:

```ts
  it('shows the topic label and colour only when a topic is set', () => {
    const { container } = renderNode({ ...base, summary: 'S', topic: 'Zentroide', topicIndex: 2 });
    const label = screen.getByText('Zentroide');
    expect(label).toHaveClass('topic-label');
    expect(label).toHaveAttribute('title', 'Zentroide');
    const card = container.querySelector('.message-node')!;
    expect(card).toHaveClass('has-topic');
    expect((card as HTMLElement).style.getPropertyValue('--topic')).toBe('var(--topic-2)');
  });
  it('has neither label nor colour without a topic, and dims when asked', () => {
    const { container } = renderNode({ ...base, summary: 'S', dimmed: true });
    expect(screen.queryByText(/topic/)).toBeNull();
    const card = container.querySelector('.message-node')!;
    expect(card).not.toHaveClass('has-topic');
    expect(card).toHaveClass('dimmed');
  });
```

Append to `apps/web/test/NodePanel.test.tsx` (match its existing `node` fixture shape):

```ts
  it('colours the topic pill from the palette', () => {
    render(<NodePanel node={{ ...node, topics: ['Alpha'] }} palette={new Map([['Alpha', 4]])} />);
    const pill = screen.getByText('Alpha');
    expect(pill).toHaveClass('topic');
    expect((pill as HTMLElement).style.getPropertyValue('--topic')).toBe('var(--topic-4)');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/web test -- topics flow MessageNode NodePanel`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/web/src/topics.ts`:

```ts
import type { CanvasDto } from '@chatmind/core';

/** Spec M6 §7: ten hues (`--topic-0 … --topic-9`), cycling from the eleventh topic on. */
export const TOPIC_COLOURS = 10;

export interface TopicEntry { name: string; index: number; count: number }

/** Spec M6 §7: topic → colour index by first appearance (earliest `created` among its nodes). Pure. */
export function topicPalette(dto: CanvasDto): Map<string, number> {
  const first = new Map<string, string>();
  for (const n of dto.nodes) {
    const t = n.topics[0];
    if (t === undefined || t === '') continue;
    const cur = first.get(t);
    if (cur === undefined || n.created < cur) first.set(t, n.created);
  }
  const ordered = [...first].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
  return new Map(ordered.map(([name], i) => [name, i % TOPIC_COLOURS]));
}

/** Topics in palette order with node counts — the sidebar list. */
export function topicList(dto: CanvasDto): TopicEntry[] {
  const counts = new Map<string, number>();
  for (const n of dto.nodes) { const t = n.topics[0]; if (t !== undefined && t !== '') counts.set(t, (counts.get(t) ?? 0) + 1); }
  return [...topicPalette(dto)].map(([name, index]) => ({ name, index, count: counts.get(name) ?? 0 }));
}

export function nodesOfTopic(dto: CanvasDto, name: string): string[] {
  return dto.nodes.filter((n) => n.topics[0] === name).map((n) => n.id);
}
```

In `apps/web/src/flow.ts`:

```ts
export type MessageNodeData = {
  …existing fields…
  topic?: string; // topics[0] (spec M6 §7)
  topicIndex?: number; // colour index from topicPalette
  dimmed?: boolean; // another topic is active
};

/** Spec M6 §7: what the topic highlight contributes to rendering. */
export interface TopicMarks { palette: ReadonlyMap<string, number>; active: string | null }

export function toFlowNodes(dto: CanvasDto, streams?: ReadonlyMap<string, StreamState>, marks?: FlowMarks, topics?: TopicMarks): (MessageFlowNode | GhostFlowNode)[] {
```
and inside the `map`, after the `marks` block:
```ts
    if (topics) {
      const t = n.topics[0];
      if (t !== undefined && t !== '') {
        data.topic = t;
        data.topicIndex = topics.palette.get(t) ?? 0;
      }
      if (topics.active !== null && t !== topics.active) data.dimmed = true;
    }
```

In `apps/web/src/MessageNode.tsx`:

```ts
  const cls = `message-node role-${data.role}${selected ? ' selected' : ''}${data.streaming ? ' streaming' : ''}${data.error ? ' error' : ''}${data.inContext ? ' in-context' : ''}${data.excluded ? ' excluded' : ''}${data.topic !== undefined ? ' has-topic' : ''}${data.dimmed ? ' dimmed' : ''}`;
  const style = data.topic !== undefined ? ({ ['--topic' as string]: `var(--topic-${data.topicIndex ?? 0})` } as React.CSSProperties) : undefined;
  return (
    <div className={cls} style={style}>
      …
      <header>
        {data.topic !== undefined && <span className="topic-label" title={data.topic}><i className="dot" aria-hidden="true" />{data.topic}</span>}
        <span className="role">…</span>
```

(`import type { CSSProperties } from 'react'` if the `React` namespace is not in scope.)

In `apps/web/src/NodePanel.tsx` add the prop `palette?: ReadonlyMap<string, number>` and render the pill as:

```tsx
            <span key={t} className="topic" style={palette?.has(t) ? ({ ['--topic' as string]: `var(--topic-${palette.get(t)})` } as CSSProperties) : undefined}>{t}</span>
```

In `apps/web/src/GraphView.tsx` add `topics: TopicMarks` to `Props`, thread it into `Inner`, and compute `nodes` with `toFlowNodes(canvas, streams, marks, topics)` (add `topics` to the `useMemo` deps).

In `apps/web/src/styles.css`, after the `:root` block's variables (light) and inside the dark `:root`:

```css
  /* Spec M6 §7: ten muted topic hues. */
  --topic-0: #c2410c; --topic-1: #0e7490; --topic-2: #6d28d9; --topic-3: #15803d; --topic-4: #b91c1c;
  --topic-5: #a16207; --topic-6: #1d4ed8; --topic-7: #be185d; --topic-8: #4d7c0f; --topic-9: #7c2d12;
```
dark:
```css
  --topic-0: #fb923c; --topic-1: #22d3ee; --topic-2: #a78bfa; --topic-3: #4ade80; --topic-4: #f87171;
  --topic-5: #facc15; --topic-6: #60a5fa; --topic-7: #f472b6; --topic-8: #a3e635; --topic-9: #fdba74;
```
and rules:
```css
.message-node.has-topic { border-left: 4px solid var(--topic); }
.message-node.dimmed { opacity: 0.35; }
.topic-label { display: inline-flex; align-items: center; gap: 4px; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--topic); }
.topic-label .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--topic); flex: none; }
.message-node header { gap: 6px; }
.panel .topic { border-color: var(--topic, var(--border)); color: var(--topic, inherit); }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @chatmind/web test`
Expected: PASS. `App.tsx` does not compile yet if `GraphView` now requires `topics` — pass `topics={{ palette: new Map(), active: null }}` there for now (Task 9 replaces it).

- [ ] **Step 5: Run the whole suite, commit**

```bash
git add apps/web
git commit -m "feat(web): topic colours on cards and panel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

---

### Task 9: Web — topic list, highlight, Esc order, camera

**Files:**
- Modify: `apps/web/src/App.tsx`, `apps/web/src/styles.css`, `apps/web/test/App.test.tsx`

**Interfaces:**
- Consumes: `topicPalette`, `topicList`, `nodesOfTopic` (Task 8), `TopicMarks`, `focusIds` state (existing).

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/App.test.tsx`, give the `masterarbeit` fixture topics: node 1 `topics: ['Evaluation']`, node 2 `topics: ['Zentroide']`; `zweige` keeps `topics: []`. Then append a describe block:

```ts
describe('topics (spec M6 §7)', () => {
  it('lists topics with counts, highlights on click, fits the camera, toggles off on a second click', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    const list = screen.getByRole('list', { name: 'Topics' });
    const items = within(list).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual(['Evaluation1', 'Zentroide1']);
    fireEvent.click(items[0]!);
    expect(items[0]).toHaveAttribute('aria-pressed', 'true');
    const cards = document.querySelectorAll('.message-node');
    expect(cards[0]).not.toHaveClass('dimmed');
    expect(cards[1]).toHaveClass('dimmed');
    fireEvent.click(items[0]!);
    expect(items[0]).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.message-node.dimmed')).toBeNull();
  });

  it('Esc clears the active topic first and the selection only on the second press', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Ursprungsfrage'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Ursprungsfrage' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('list', { name: 'Topics' })).getByText('Zentroide'));
    expect(document.querySelector('.message-node.dimmed')).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('.message-node.dimmed')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Ursprungsfrage' })).toBeInTheDocument(); // selection kept
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByText('Select a node to read it.')).toBeInTheDocument();
  });

  it('hides the list on a canvas without topics and resets the active topic on canvas change', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(within(screen.getByRole('list', { name: 'Topics' })).getByText('Evaluation'));
    await userEvent.click(screen.getByRole('button', { name: /zweige/ }));
    await screen.findByText('3 nodes');
    expect(screen.queryByRole('list', { name: 'Topics' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /masterarbeit/ }));
    await screen.findByText('2 nodes');
    expect(document.querySelector('.message-node.dimmed')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Topics' })).getByText('Evaluation').closest('button')).toHaveAttribute('aria-pressed', 'false');
  });
});
```

Check the existing App tests still hold with the fixture change (none asserts on `topics`; the panel now renders a pill "Evaluation" for node 1 — `getByText('Evaluation')` inside the Topics list is scoped with `within`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/web test -- App`
Expected: FAIL — no "Topics" list.

- [ ] **Step 3: Implement in `App.tsx`**

Imports: `import { nodesOfTopic, topicList, topicPalette } from './topics';` and `type TopicMarks` from `./flow`.

State and derived values (next to `focusIds`):

```ts
  const [activeTopic, setActiveTopic] = useState<string | null>(null);
```
In the `[slug]` effect that resets state add `setActiveTopic(null);`.

Extend `keyStateRef` to carry the active topic:

```ts
  const keyStateRef = useRef<{ canvas: CanvasDto | null; selection: SelectionState; activeTopic: string | null }>({ canvas: null, selection: clearSelection(), activeTopic: null });
  …
  useEffect(() => { keyStateRef.current = { canvas, selection, activeTopic }; }, [canvas, selection, activeTopic]);
```

In the key handler, the Escape branch becomes:

```ts
      } else if (e.key === 'Escape') {
        // Spec M6 §7: a topic highlight goes first; the selection only on the next press.
        if (keyStateRef.current.activeTopic !== null) setActiveTopic(null);
        else setSelection(clearSelection());
      }
```

After `marks`:

```ts
  // Spec M6 §7: colour index per topic and the sidebar list, once per canvas fetch; the active topic dims the rest.
  const palette = useMemo(() => (canvas ? topicPalette(canvas) : new Map<string, number>()), [canvas]);
  const topics = useMemo(() => (canvas ? topicList(canvas) : []), [canvas]);
  const topicMarks: TopicMarks = useMemo(() => ({ palette, active: activeTopic }), [palette, activeTopic]);
  const toggleTopic = (name: string): void => {
    if (activeTopic === name) { setActiveTopic(null); return; }
    setActiveTopic(name);
    if (canvas) setFocusIds(nodesOfTopic(canvas, name)); // a deliberate click, not auto-follow
  };
```

Sidebar, after the new-canvas block and before the "No canvases yet" hint:

```tsx
        {topics.length > 0 && (
          <section className="topics">
            <h2>Topics</h2>
            <ul aria-label="Topics">
              {topics.map((t) => (
                <li key={t.name}>
                  <button type="button" aria-pressed={activeTopic === t.name} style={{ ['--topic' as string]: `var(--topic-${t.index})` }} onClick={() => toggleTopic(t.name)}>
                    <i className="dot" aria-hidden="true" />{t.name}<span className="count">{t.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
```

Pass through: `<GraphView … topics={topicMarks} />` and `<NodePanel … palette={palette} />`.

CSS:

```css
.sidebar .topics { margin-top: 16px; }
.sidebar .topics h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 6px; }
.sidebar .topics button { display: flex; align-items: center; gap: 6px; }
.sidebar .topics button .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--topic); flex: none; }
.sidebar .topics button[aria-pressed="true"] { background: var(--assistant); outline: 1px solid var(--topic); }
.sidebar .topics button .count { margin-left: auto; float: none; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @chatmind/web test`
Expected: PASS. If the first test's `textContent` assertion differs because of whitespace, assert with `toHaveTextContent(/Evaluation\s*1/)` per item instead.

- [ ] **Step 5: Probe in a real browser**

Start a scratch server and Vite (never the user's vault). `SCRATCH` is the session's scratchpad directory:

```bash
mkdir -p "$SCRATCH/vault"
cat > "$SCRATCH/demo.json" <<'JSON'
{ "messages": [
  { "role": "user", "content": "Wie evaluiere ich die Topic-Zuordnung?" },
  { "role": "assistant", "content": "Zentroid statt Re-Clustering.", "model": "x" },
  { "role": "user", "content": "Und wie schreibe ich das Kapitel dazu?" },
  { "role": "assistant", "content": "Erst die Methode, dann die Evaluation.", "model": "x" }
] }
JSON
pnpm cli import-transcript "$SCRATCH/demo.json" --canvas demo --data-dir "$SCRATCH/vault"
sed -i '' 's/^topics: \[\]$/topics: [Evaluation]/' "$SCRATCH/vault/demo/nodes/"*.md   # then change two of them to [Schreiben] by hand
pnpm --filter @chatmind/server exec tsx src/index.ts --data-dir "$SCRATCH/vault" --port 3299 --no-index &
```

Write a temporary `vite.config.probe.ts` in `apps/web` (copy of `vite.config.ts` with `server.proxy['/api'].target = 'http://127.0.0.1:3299'` and a different port, e.g. 5299), start `pnpm --filter @chatmind/web exec vite --config vite.config.probe.ts`, open it, and check: coloured left borders + labels, the Topics list, click → others dim and the camera fits, Esc order, dark mode (`prefers-color-scheme`). Kill both processes afterwards (`kill <pid>`).

- [ ] **Step 6: Run the whole suite, commit**

```bash
git add apps/web
git commit -m "feat(web): topic list with highlight, camera fit and Esc order

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

---

### Task 10: Docs, paid dry run, gate hand-off

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-21-chatmind-m6-topics-design.md` (only if implementation deviated)
- Create: `docs/superpowers/notes/2026-09-21-m6-implementation-notes.md`

- [ ] **Step 1: README**

In the index section of `README.md` add: what topics are (one per node, written into `topics:` only when empty; edit or blank in Obsidian to correct or re-assign), the `chatmind index topics --dry-run` command and what its output columns mean, the colour/list UI, and that `index.db` migrates in place from M5 (no re-embedding).

- [ ] **Step 2: CLAUDE.md**

Change the invariant line to: "The indexer (M5/M6) writes only `summary` and `topics` into frontmatter — `topics` only when it is empty — and renames a file exactly once, from `{ULID}.md` to `{ULID}-{slug}.md`; nothing else in the vault is ever renamed or deleted."

- [ ] **Step 3: Paid dry run on a scratch vault**

With the user's OpenRouter key in the environment (`~/.config/chatmind/env` is read by the server), build a scratch vault with two clearly different strands (e.g. an import of two short transcripts into one canvas by editing `parents`, or a hand-written 6-node canvas: 3 nodes on one subject, a split, 3 on another), start the server **with** the index on `--port 3299 --data-dir <scratchpad>/vault`, and check: the first node gets a named topic; the chain inherits it without further namer calls (server log); the split's second strand founds a second topic; `chatmind index topics --dry-run --data-dir …` prints similarities that make the thresholds look sane (log the numbers into the notes); deleting `.app/index.db` and restarting writes no topic. Record cost and model behaviour (name length, language) in the notes. Kill the server.

- [ ] **Step 4: Notes**

Write `docs/superpowers/notes/2026-09-21-m6-implementation-notes.md` in the style of the M5 notes: status, deviations from the spec, rulings, deferred minors, dry-run numbers and the threshold values in force, plus the gate checklist for the user (their vault: every node gets a topic; topics usable; cards coloured; list highlights; a topic set in Obsidian stays; blanking re-assigns; `index.db` delete + restart changes no `topics:`; `pnpm cli check` clean). If the spec was amended, commit the amendment with the notes.

- [ ] **Step 5: Final verification and commit**

Run: `pnpm typecheck && pnpm test` — green. Then:

```bash
git add README.md CLAUDE.md docs
git commit -m "docs: M6 topics — README, invariants, implementation notes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY"
```

Hand over to the user for the manual gate; findings go to `docs/superpowers/notes/2026-09-21-m6-gate-findings.md`.
