# Cycle 5 (M5): Index, summaries, embeddings, live vault updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background indexer inside the server gives every node a one-line `summary` (written into frontmatter, file renamed once from `{ULID}.md`) and an embedding in `.app/index.db`; a watcher-driven `vault-changed` SSE channel makes the browser follow every change on disk without a reload. Deleting `index.db` and restarting rebuilds it fully.

**Architecture:** A new Node-only package `@chatmind/index` owns SQLite (`better-sqlite3` + `sqlite-vec`), a pure job planner (`planJobs`: vault vs. rows → embed/summarize/rename jobs), the executor (`reconcile`), the writeback under the shared `VaultLock`, a chokidar watcher and an `Indexer` that serialises runs. LLM and embedding calls are injected (`Summarizer`, `Embedder`); the server implements them with the AI SDK against OpenRouter. The server exposes `GET /api/events` (from the watcher) and `GET /api/index/status`; the web app opens an `EventSource`, refetches the canvas and merges by id, keeping streaming ghosts and the camera untouched.

**Tech Stack:** as cycles 1–4 plus `better-sqlite3` 13, `sqlite-vec` 0.1.9, `chokidar` 5, AI SDK 7 `generateText`/`embedMany` with `@openrouter/ai-sdk-provider`.

**Spec:** `docs/superpowers/specs/2026-09-18-chatmind-m5-index-design.md` (binding), on top of the cycle-1 spec (invariants) and the M3/M4 specs.

## Global Constraints

- Node `>=22.22.2`; shells: `put Node 22 and pnpm on `PATH` (e.g. `nvm use`)`.
- Files are the truth; everything in `.app/index.db` is derived and disposable (cycle-1 §3.1). `graph.canvas` stays pure JSON Canvas 1.0. Identity is the frontmatter ULID.
- The reader never writes. The indexer writes **only** `summary` into frontmatter and renames a file **only** from `{ULID}.md` to `{ULID}-{slug}.md`, exactly once (spec §6). Nothing is ever deleted; canvas nodes are never moved by us.
- `@chatmind/core` runtime deps stay `js-yaml`, `ulid`, Node built-ins. `@chatmind/index` has no network dependency. `apps/web` imports runtime code only from `@chatmind/core/graph`; nothing from `@chatmind/index` reaches the browser.
- Providers: summaries `openai/gpt-5.6-luna`, embeddings `openai/text-embedding-3-small` dim 1536, both via OpenRouter; overridable with `CHATMIND_SUMMARY_MODEL`, `CHATMIND_EMBED_MODEL`, `CHATMIND_EMBED_DIM` (process env first, then `~/.config/chatmind/env`).
- Summary: one line, ≤ 80 characters, cleaned as in spec §6; a single-line body of ≤ 80 characters is its own summary without an LLM call.
- Staleness rules (spec §4/§5): embed stale ⇔ `embedded_hash ≠ content_hash`; summarize when `summary === ''`, or `summary === summary_written && summary_for_hash ≠ content_hash`; rename when `summary !== ''` and basename is `{ULID}.md`; empty body → `embedded_hash = content_hash`, no jobs.
- Watcher: 300 ms debounce, `awaitWriteFinish` 300 ms, `.app/`, dot-entries and `*.tmp` ignored. SSE event name `vault-changed`, data `{ "slugs": string[] }`.
- UI copy stays English. No new UI beyond titles arriving live.
- TDD per task; commit per task with the session's attribution trailer:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY
  ```
- Run `pnpm typecheck && pnpm test` at the end of every task before committing. Never point a probe at the user's vault; scratch servers use `--data-dir <scratchpad>/vault --port 3299 --no-index`.

## File Map

| Path | Responsibility |
|---|---|
| `packages/core/src/vault/lock.ts` | `VaultLock` (moved from `apps/server/src/vault-lock.ts`) |
| `packages/core/src/vault/write.ts` | + `renameNodeFile(graph, id, root): Promise<boolean>` |
| `packages/core/src/index.ts` | + exports `VaultLock`, `renameNodeFile` |
| `pnpm-workspace.yaml` | `allowBuilds: better-sqlite3` |
| `packages/index/package.json`, `tsconfig.json` | new package `@chatmind/index` |
| `packages/index/src/hash.ts` | `contentHash(body)` |
| `packages/index/src/db.ts` | `IndexDb`: open/migrate, `meta`, `nodes`, `vec_nodes`, row access |
| `packages/index/src/summary.ts` | `SUMMARY_MAX`, `SUMMARY_SYSTEM`, `cleanSummary`, `shortcutSummary`, `truncateForSummary`, `truncateForEmbedding` |
| `packages/index/src/types.ts` | `Summarizer`, `Embedder`, `Report`, `IndexStatus` |
| `packages/index/src/plan.ts` | `planJobs(entries, rows): Jobs` (pure) |
| `packages/index/src/writeback.ts` | `writeback(job, deps)` under the lock; summary + rename-once |
| `packages/index/src/reconcile.ts` | `reconcile(deps): Promise<Report>` — read, sync, plan, execute |
| `packages/index/src/watcher.ts` | `watchVault(dataDir, opts): VaultWatcher` (chokidar, debounced slugs) |
| `packages/index/src/indexer.ts` | `Indexer`: start/trigger/status/close, serialised runs, retry timer |
| `packages/index/src/index.ts` | public exports |
| `apps/server/src/keys.ts` | + `loadEnv` (env ∪ key file) used by `loadKeys` and the index settings |
| `apps/server/src/index-providers.ts` | `indexSettings`, `createSummarizer`, `createEmbedder`, `openRouterIndexProviders` |
| `apps/server/src/app.ts` | `indexer`/`watcher` options, `GET /api/events`, `GET /api/index/status`; `VaultLock` from core |
| `apps/server/src/completion.ts` | `VaultLock` type from core |
| `apps/server/src/index.ts` | `--no-index`, watcher + indexer wiring, shutdown |
| `apps/cli/src/index-status.ts`, `apps/cli/src/index.ts` | `chatmind index status` |
| `apps/web/src/merge.ts` | `mergeCanvas(current, fresh, streams)` (pure) |
| `apps/web/src/events.ts` | `subscribeVaultEvents`, `createRefetcher` |
| `apps/web/src/App.tsx` | events → refetch → merge; cursor pruning |
| `README.md`, `CLAUDE.md`, cycle-1 spec §8.2 | docs |

---

### Task 1: `VaultLock` into core, `renameNodeFile`

**Files:**
- Create: `packages/core/src/vault/lock.ts`, `packages/core/test/lock.test.ts`
- Modify: `packages/core/src/vault/write.ts`, `packages/core/src/index.ts`, `packages/core/test/write.test.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/completion.ts`
- Delete: `apps/server/src/vault-lock.ts`, `apps/server/test/vault-lock.test.ts`

**Interfaces:**
- Consumes: `writeNode`, `nodeFileName`, `exists`, `CanvasGraph` (core).
- Produces:
  ```ts
  // packages/core/src/vault/lock.ts
  export class VaultLock { run<T>(fn: () => Promise<T>): Promise<T> }
  // packages/core/src/vault/write.ts
  export async function renameNodeFile(graph: CanvasGraph, id: NodeId, root: string): Promise<boolean>
  ```

- [ ] **Step 1: Move the lock**

```bash
git mv apps/server/src/vault-lock.ts packages/core/src/vault/lock.ts
git mv apps/server/test/vault-lock.test.ts packages/core/test/lock.test.ts
```

Edit `packages/core/test/lock.test.ts` line 2 to `import { VaultLock } from '../src/vault/lock';`. Add to `packages/core/src/index.ts`:

```ts
export { VaultLock } from './vault/lock';
export { renameNodeFile } from './vault/write'; // added to the existing write export line
```

In `apps/server/src/app.ts` and `apps/server/src/completion.ts` replace `import { VaultLock } from './vault-lock'` / `import type { VaultLock } from './vault-lock'` with imports from `@chatmind/core` (merge into the existing `@chatmind/core` import line; `completion.ts` uses `type VaultLock`).

- [ ] **Step 2: Failing tests for `renameNodeFile`** — append to `packages/core/test/write.test.ts`:

```ts
import { renameNodeFile } from '../src/vault/write';
import { readVault } from '../src/vault/read';

describe('renameNodeFile (spec M5 §6)', () => {
  it('renames a bare-ULID file once the summary has a slug and updates graph.paths', async () => {
    const root = await tmpDir();
    const g = sampleGraph(); // C has summary ''
    await writeCanvas(g, root);
    g.nodes.get(C)!.summary = 'Danke für die Hinweise';
    expect(await renameNodeFile(g, C, root)).toBe(true);
    expect(g.paths.get(C)).toBe(`masterarbeit/nodes/${C}-danke-fuer-die-hinweise.md`);
    const tree = await readTree(root);
    expect(tree.has(`masterarbeit/nodes/${C}-danke-fuer-die-hinweise.md`)).toBe(true);
    expect(tree.has(`masterarbeit/nodes/${C}.md`)).toBe(false);
    await writeCanvasFile(g, root);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.paths.get(C)).toBe(`masterarbeit/nodes/${C}-danke-fuer-die-hinweise.md`);
  });

  it('is a no-op when the file already carries a slug, when the summary has no slug, or when the target exists', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, root);
    g.nodes.get(A)!.summary = 'Neuer Titel';
    expect(await renameNodeFile(g, A, root)).toBe(false); // already `A-ursprungsfrage.md`
    expect(g.paths.get(A)).toBe(`masterarbeit/nodes/${A}-ursprungsfrage.md`);
    g.nodes.get(C)!.summary = '???';
    expect(await renameNodeFile(g, C, root)).toBe(false); // slug('???') === ''
    g.nodes.get(C)!.summary = 'Danke';
    await fs.writeFile(path.join(root, 'masterarbeit', 'nodes', `${C}-danke.md`), 'occupied');
    expect(await renameNodeFile(g, C, root)).toBe(false);
    expect(g.paths.get(C)).toBe(`masterarbeit/nodes/${C}.md`);
  });

  it('throws for an unknown node or one without a path', async () => {
    const g = sampleGraph();
    await expect(renameNodeFile(g, 'nope', await tmpDir())).rejects.toThrow('not in graph');
    await expect(renameNodeFile(g, C, await tmpDir())).rejects.toThrow('no path');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @chatmind/core test -- write` — expected: FAIL, `renameNodeFile` is not exported.

- [ ] **Step 4: Implement** — append to `packages/core/src/vault/write.ts` (add `exists` to the `./paths` import):

```ts
/**
 * Spec M5 §6: the one exception to "never rename". Renames exactly once, from `{ULID}.md` to
 * `{ULID}-{slug}.md`, and only when the summary yields a slug and the target is free. Updates
 * `graph.paths`; the caller writes graph.canvas afterwards. Returns whether a rename happened.
 */
export async function renameNodeFile(graph: CanvasGraph, id: NodeId, root: string): Promise<boolean> {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`node ${id} not in graph`);
  const rel = graph.paths.get(id);
  if (rel === undefined) throw new Error(`node ${id} has no path — call writeNode first`);
  if (path.posix.basename(rel) !== `${id}.md`) return false;
  const target = nodeFileName(id, node.summary);
  if (target === `${id}.md`) return false;
  const newRel = `${path.posix.dirname(rel)}/${target}`;
  const absNew = path.resolve(root, newRel);
  if (await exists(absNew)) return false;
  await fs.rename(path.resolve(root, rel), absNew);
  graph.paths.set(id, newRel);
  return true;
}
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm test` — expected: all green (server tests still pass with the lock from core).

- [ ] **Step 6: Commit**

```bash
git add -A packages/core apps/server
git commit -m "feat(core): VaultLock moves to core; renameNodeFile renames a bare-ULID file once"
```

---

### Task 2: `@chatmind/index` package, `contentHash`, `IndexDb`

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `packages/index/package.json`, `packages/index/tsconfig.json`, `packages/index/src/hash.ts`, `packages/index/src/db.ts`, `packages/index/src/types.ts`, `packages/index/src/index.ts`
- Test: `packages/index/test/hash.test.ts`, `packages/index/test/db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // hash.ts
  export function contentHash(body: string): string            // sha256 hex
  // types.ts
  export interface Summarizer { (body: string, lang: 'de' | 'en'): Promise<string> }
  export interface Embedder { model: string; dim: number; embed(texts: string[]): Promise<Float32Array[]> }
  export interface Report { at: string; nodes: number; embedded: number; summarized: number; renamed: number; failed: number; pending: { embed: number; summarize: number } }
  export interface IndexStatus { enabled: boolean; running: boolean; lastRun: Report | null; pending: { embed: number; summarize: number } }
  // db.ts
  export interface NodeRow { id: string; canvas: string; content_hash: string; summary_written: string | null; summary_for_hash: string | null; embedded_hash: string | null }
  export const SCHEMA_VERSION = 1;
  export class IndexDb {
    static open(file: string, embed: { model: string; dim: number }): IndexDb   // ':memory:' allowed
    static openReadonly(file: string): IndexDb                                    // no vec extension needed
    rows(): Map<string, NodeRow>
    upsertNode(id: string, canvas: string, contentHash: string): void
    deleteNodes(ids: readonly string[]): void
    setEmbedded(id: string, hash: string, vec: Float32Array | null): void        // one transaction
    setSummary(id: string, written: string, forHash: string): void
    vector(id: string): Float32Array | null
    meta(key: string): string | null
    close(): void
  }
  ```

- [ ] **Step 1: Package scaffolding**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
allowBuilds:
  esbuild: true
  better-sqlite3: true
```

`packages/index/package.json`:
```json
{
  "name": "@chatmind/index",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@chatmind/core": "workspace:*",
    "better-sqlite3": "^13.0.3",
    "chokidar": "^5.0.0",
    "sqlite-vec": "^0.1.9"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0"
  }
}
```

`packages/index/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run `pnpm install`. If `better-sqlite3` reports a missing binary, run `pnpm rebuild better-sqlite3` once; verify with `node -e "require('better-sqlite3')(':memory:')"` from `packages/index`. (Fallback per spec §8 if prebuilds fail on this Mac: `node:sqlite` with `allowExtension: true` and `sqliteVec.getLoadablePath()`; same SQL. Only take it if the rebuild fails.)

`packages/index/src/types.ts` — the interfaces listed above, verbatim.

- [ ] **Step 2: Failing tests**

`packages/index/test/hash.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { contentHash } from '../src/hash';

describe('contentHash', () => {
  it('is sha256 hex of the body', () => {
    expect(contentHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});
```

`packages/index/test/db.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IndexDb, SCHEMA_VERSION } from '../src/db';

const dirs: string[] = [];
async function tmpFile(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-index-'));
  dirs.push(d);
  return path.join(d, '.app', 'index.db');
}
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

const EMBED = { model: 'test/embed', dim: 4 };
const vec = (n: number): Float32Array => Float32Array.from([n, n, n, n]);

describe('IndexDb', () => {
  it('creates the schema, records meta and round-trips rows and vectors', () => {
    const db = IndexDb.open(':memory:', EMBED);
    expect(db.meta('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(db.meta('embed_model')).toBe('test/embed');
    expect(db.meta('embed_dim')).toBe('4');
    db.upsertNode('A', 'masterarbeit', 'h1');
    expect(db.rows().get('A')).toEqual({ id: 'A', canvas: 'masterarbeit', content_hash: 'h1', summary_written: null, summary_for_hash: null, embedded_hash: null });
    db.setEmbedded('A', 'h1', vec(1));
    expect(Array.from(db.vector('A')!)).toEqual([1, 1, 1, 1]);
    expect(db.rows().get('A')!.embedded_hash).toBe('h1');
    db.setSummary('A', 'Titel', 'h1');
    expect(db.rows().get('A')).toMatchObject({ summary_written: 'Titel', summary_for_hash: 'h1' });
    db.upsertNode('A', 'masterarbeit', 'h2'); // body changed: hash moves, the rest stays
    expect(db.rows().get('A')).toMatchObject({ content_hash: 'h2', summary_written: 'Titel', embedded_hash: 'h1' });
    db.close();
  });

  it('setEmbedded with null stores no vector but marks the hash (empty body)', () => {
    const db = IndexDb.open(':memory:', EMBED);
    db.upsertNode('A', 'c', 'h');
    db.setEmbedded('A', 'h', null);
    expect(db.vector('A')).toBeNull();
    expect(db.rows().get('A')!.embedded_hash).toBe('h');
  });

  it('deleteNodes removes rows and vectors', () => {
    const db = IndexDb.open(':memory:', EMBED);
    db.upsertNode('A', 'c', 'h');
    db.setEmbedded('A', 'h', vec(1));
    db.deleteNodes(['A', 'missing']);
    expect(db.rows().size).toBe(0);
    expect(db.vector('A')).toBeNull();
  });

  it('rejects a vector of the wrong dimension', () => {
    const db = IndexDb.open(':memory:', EMBED);
    db.upsertNode('A', 'c', 'h');
    expect(() => db.setEmbedded('A', 'h', Float32Array.from([1, 2]))).toThrow('dim');
  });

  it('persists to disk, creating .app/, and reopens; an embed model change drops the vectors only', async () => {
    const file = await tmpFile();
    let db = IndexDb.open(file, EMBED);
    db.upsertNode('A', 'c', 'h');
    db.setEmbedded('A', 'h', vec(1));
    db.setSummary('A', 'Titel', 'h');
    db.close();
    db = IndexDb.open(file, EMBED);
    expect(Array.from(db.vector('A')!)).toEqual([1, 1, 1, 1]);
    db.close();
    db = IndexDb.open(file, { model: 'test/other', dim: 3 });
    expect(db.meta('embed_model')).toBe('test/other');
    expect(db.vector('A')).toBeNull();
    expect(db.rows().get('A')).toMatchObject({ embedded_hash: null, summary_written: 'Titel', summary_for_hash: 'h' });
    db.setEmbedded('A', 'h', Float32Array.from([1, 2, 3]));
    db.close();
    const ro = IndexDb.openReadonly(file);
    expect(ro.rows().get('A')!.embedded_hash).toBe('h');
    expect(ro.meta('embed_dim')).toBe('3');
    ro.close();
  });

  it('a schema version mismatch rebuilds from scratch', async () => {
    const file = await tmpFile();
    let db = IndexDb.open(file, EMBED);
    db.upsertNode('A', 'c', 'h');
    db.db.prepare(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`).run();
    db.close();
    db = IndexDb.open(file, EMBED);
    expect(db.rows().size).toBe(0);
    expect(db.meta('schema_version')).toBe(String(SCHEMA_VERSION));
    db.close();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @chatmind/index test` — expected: FAIL, modules missing.

- [ ] **Step 4: Implement**

`packages/index/src/hash.ts`:
```ts
import { createHash } from 'node:crypto';

/** Spec M5 §4: the single comparison value for embeddings and summaries. */
export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
```

`packages/index/src/db.ts`:
```ts
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export interface NodeRow {
  id: string;
  canvas: string;
  content_hash: string;
  summary_written: string | null;
  summary_for_hash: string | null;
  embedded_hash: string | null;
}

export const SCHEMA_VERSION = 1;

const TABLES = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  canvas TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary_written TEXT,
  summary_for_hash TEXT,
  embedded_hash TEXT
);`;

/**
 * Spec M5 §4. One connection, WAL, fully disposable. `open` migrates: a schema version mismatch drops
 * everything; an embed model/dim mismatch drops only `vec_nodes` and clears `embedded_hash`.
 */
export class IndexDb {
  private constructor(readonly db: Database.Database) {}

  static open(file: string, embed: { model: string; dim: number }): IndexDb {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true }); // sync throughout, like better-sqlite3
    const raw = new Database(file);
    raw.pragma('journal_mode = WAL');
    sqliteVec.load(raw);
    const db = new IndexDb(raw);
    if (db.meta('schema_version') !== String(SCHEMA_VERSION)) {
      raw.exec('DROP TABLE IF EXISTS vec_nodes; DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS meta;');
    }
    raw.exec(TABLES);
    db.setMeta('schema_version', String(SCHEMA_VERSION));
    if (db.meta('embed_model') !== embed.model || db.meta('embed_dim') !== String(embed.dim)) {
      raw.exec('DROP TABLE IF EXISTS vec_nodes; UPDATE nodes SET embedded_hash = NULL;');
      db.setMeta('embed_model', embed.model);
      db.setMeta('embed_dim', String(embed.dim));
    }
    raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes USING vec0(id TEXT PRIMARY KEY, embedding float[${embed.dim}])`);
    return db;
  }

  /** For `chatmind index status`: rows and meta only, no extension, no writes. */
  static openReadonly(file: string): IndexDb {
    return new IndexDb(new Database(file, { readonly: true, fileMustExist: true }));
  }

  meta(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null; // table does not exist yet
    }
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  rows(): Map<string, NodeRow> {
    const out = new Map<string, NodeRow>();
    for (const r of this.db.prepare('SELECT * FROM nodes').all() as NodeRow[]) out.set(r.id, r);
    return out;
  }

  upsertNode(id: string, canvas: string, contentHash: string): void {
    this.db
      .prepare('INSERT INTO nodes(id, canvas, content_hash) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET canvas = excluded.canvas, content_hash = excluded.content_hash')
      .run(id, canvas, contentHash);
  }

  deleteNodes(ids: readonly string[]): void {
    const delNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    const delVec = this.db.prepare('DELETE FROM vec_nodes WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) {
        delVec.run(id);
        delNode.run(id);
      }
    })();
  }

  private dim(): number {
    return Number(this.meta('embed_dim'));
  }

  /** Vector + hash in one transaction; `null` marks an empty body as done without a vector. */
  setEmbedded(id: string, hash: string, vec: Float32Array | null): void {
    if (vec !== null && vec.length !== this.dim()) throw new Error(`vector for ${id} has dim ${vec.length}, expected ${this.dim()}`);
    const delVec = this.db.prepare('DELETE FROM vec_nodes WHERE id = ?');
    const insVec = this.db.prepare('INSERT INTO vec_nodes(id, embedding) VALUES (?, ?)');
    const upd = this.db.prepare('UPDATE nodes SET embedded_hash = ? WHERE id = ?');
    this.db.transaction(() => {
      delVec.run(id);
      if (vec !== null) insVec.run(id, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      upd.run(hash, id);
    })();
  }

  setSummary(id: string, written: string, forHash: string): void {
    this.db.prepare('UPDATE nodes SET summary_written = ?, summary_for_hash = ? WHERE id = ?').run(written, forHash, id);
  }

  vector(id: string): Float32Array | null {
    try {
      const row = this.db.prepare('SELECT embedding FROM vec_nodes WHERE id = ?').get(id) as { embedding: Buffer } | undefined;
      if (!row) return null;
      const b = row.embedding;
      return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    } catch {
      return null; // readonly handle without the extension, or table missing
    }
  }

  close(): void {
    this.db.close();
  }
}
```

`packages/index/src/index.ts`:
```ts
export { contentHash } from './hash';
export { IndexDb, SCHEMA_VERSION, type NodeRow } from './db';
export type { Summarizer, Embedder, Report, IndexStatus } from './types';
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @chatmind/index test && pnpm typecheck` — expected: PASS. If `vec0` refuses `INSERT` after `DELETE` in the same transaction or the `TEXT PRIMARY KEY` form, check the installed `sqlite-vec` README in `node_modules/sqlite-vec/README.md` and adjust the DDL; keep the `IndexDb` interface unchanged.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/index
git commit -m "feat(index): @chatmind/index package with IndexDb (sqlite + sqlite-vec) and contentHash"
```

---

### Task 3: Summary helpers (pure)

**Files:**
- Create: `packages/index/src/summary.ts`
- Test: `packages/index/test/summary.test.ts`
- Modify: `packages/index/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SUMMARY_MAX = 80;
  export const SUMMARY_SYSTEM: string;
  export function cleanSummary(raw: string): string          // '' when nothing usable
  export function shortcutSummary(body: string): string | null
  export function truncateForSummary(body: string): string    // ~4000 tokens
  export function truncateForEmbedding(body: string): string  // ~8000 tokens
  ```

- [ ] **Step 1: Failing tests** — `packages/index/test/summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cleanSummary, shortcutSummary, SUMMARY_MAX, truncateForEmbedding, truncateForSummary } from '../src/summary';

describe('cleanSummary (spec M5 §6)', () => {
  it('collapses whitespace, strips quotes and a trailing period', () => {
    expect(cleanSummary('  "Zentroid-Ansatz\n  skaliert besser."  ')).toBe('Zentroid-Ansatz skaliert besser');
    expect(cleanSummary('`Titel`')).toBe('Titel');
    expect(cleanSummary("'Titel'")).toBe('Titel');
    expect(cleanSummary('„Titel“')).toBe('Titel');
  });
  it('keeps a question mark and inner periods', () => {
    expect(cleanSummary('Warum v2.0?')).toBe('Warum v2.0?');
  });
  it('takes only the first line of a multi-line answer', () => {
    expect(cleanSummary('Titel\n\nErklärung dazu')).toBe('Titel');
  });
  it('cuts at 80 characters on a word boundary with an ellipsis', () => {
    const long = 'Wort '.repeat(30).trim();
    const out = cleanSummary(long);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe(`${'Wort '.repeat(15).trim()}…`);
  });
  it('returns "" for empty or punctuation-only input', () => {
    expect(cleanSummary('')).toBe('');
    expect(cleanSummary('"."')).toBe('');
  });
});

describe('shortcutSummary', () => {
  it('uses a single short line as its own summary', () => {
    expect(shortcutSummary('  Was ist ein Zentroid?  ')).toBe('Was ist ein Zentroid?');
  });
  it('declines multi-line, long or empty bodies', () => {
    expect(shortcutSummary('Zeile 1\nZeile 2')).toBeNull();
    expect(shortcutSummary('x'.repeat(81))).toBeNull();
    expect(shortcutSummary('   ')).toBeNull();
  });
});

describe('truncation', () => {
  it('leaves short bodies alone and caps long ones', () => {
    expect(truncateForSummary('kurz')).toBe('kurz');
    expect(truncateForSummary('x'.repeat(100_000)).length).toBe(14_000);
    expect(truncateForEmbedding('x'.repeat(100_000)).length).toBe(28_000);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @chatmind/index test -- summary` → FAIL.

- [ ] **Step 3: Implement** — `packages/index/src/summary.ts`:

```ts
export const SUMMARY_MAX = 80;

/** Fixed and language-neutral so provider caches can hit; the body follows as the user message (spec M5 §6). */
export const SUMMARY_SYSTEM =
  'You write titles. Reply with a single line: a title for the message you are given — a headline or noun phrase of at most 80 characters, in the language of the message. No quotes, no trailing period, no explanation.';

const QUOTES = /^[\s"'`„“”‚‘’«»]+|[\s"'`„“”‚‘’«»]+$/g;

/** First line only, whitespace collapsed, quotes and a trailing period stripped, ≤ 80 chars on a word boundary. */
export function cleanSummary(raw: string): string {
  const firstLine = raw.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  let s = firstLine.replace(/\s+/g, ' ').replace(QUOTES, '');
  s = s.replace(/\.+$/, '').replace(QUOTES, '');
  if (s.length <= SUMMARY_MAX) return s;
  const cut = s.slice(0, SUMMARY_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** A single non-empty line of ≤ 80 characters is its own summary — no LLM call (spec M5 §6). */
export function shortcutSummary(body: string): string | null {
  const t = body.trim();
  if (t === '' || t.includes('\n') || t.length > SUMMARY_MAX) return null;
  return t;
}

// Same heuristic as core's estimateTokens (3.5 chars/token); a title needs the beginning, not the whole text.
const SUMMARY_CHARS = 4000 * 3.5;
const EMBED_CHARS = 8000 * 3.5;

export function truncateForSummary(body: string): string {
  return body.length > SUMMARY_CHARS ? body.slice(0, SUMMARY_CHARS) : body;
}

export function truncateForEmbedding(body: string): string {
  return body.length > EMBED_CHARS ? body.slice(0, EMBED_CHARS) : body;
}
```

Add to `packages/index/src/index.ts`:
```ts
export { SUMMARY_MAX, SUMMARY_SYSTEM, cleanSummary, shortcutSummary, truncateForSummary, truncateForEmbedding } from './summary';
```

- [ ] **Step 4: Verify** — `pnpm --filter @chatmind/index test && pnpm typecheck` → PASS. If the word-boundary expectation in the 80-char test is off by one, fix the implementation, not the expectation (`'Wort '.repeat(15).trim()` is 74 chars + `…`).

- [ ] **Step 5: Commit**

```bash
git add packages/index
git commit -m "feat(index): summary cleaning, short-body shortcut and input truncation"
```

---

### Task 4: `planJobs` (pure diff)

**Files:**
- Create: `packages/index/src/plan.ts`
- Test: `packages/index/test/plan.test.ts`
- Modify: `packages/index/src/index.ts`

**Interfaces:**
- Consumes: `NodeRow` (Task 2), `MessageNode` (core).
- Produces:
  ```ts
  export interface Entry { node: MessageNode; canvas: string; path: string }   // path vault-relative, e.g. masterarbeit/nodes/<id>.md
  export interface SummaryJob { id: string; expected: string }                  // expected = summary currently in the file ('' or ours)
  export interface Jobs { embed: string[]; summarize: SummaryJob[]; rename: string[] }
  export function planJobs(entries: readonly Entry[], rows: ReadonlyMap<string, NodeRow>): Jobs
  export function rowsForPlan(entries: readonly Entry[], rows: ReadonlyMap<string, NodeRow>): Map<string, NodeRow>  // fresh content_hash; missing rows synthesised (all NULL) — read-only view for status/countPending
  export function isBareUlidPath(p: string, id: string): boolean
  ```
  `rows` are the rows **after** sync (content_hash current); `rowsForPlan` builds that view without writing. Ids in `rename` never overlap `summarize` (a fresh summary renames inside its own writeback).

- [ ] **Step 1: Failing tests** — `packages/index/test/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { MessageNode } from '@chatmind/core';
import { contentHash } from '../src/hash';
import type { NodeRow } from '../src/db';
import { planJobs, rowsForPlan, type Entry } from '../src/plan';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
function entry(over: Partial<MessageNode> & { id: string }, file?: string): Entry {
  const node: MessageNode = { role: 'user', parents: [], created: 'c', summary: '', topics: [], body: 'Ein Body.\nZwei Zeilen.', ...over };
  return { node, canvas: 'masterarbeit', path: `masterarbeit/nodes/${file ?? `${node.id}.md`}` };
}
function row(e: Entry, over: Partial<NodeRow> = {}): [string, NodeRow] {
  return [e.node.id, { id: e.node.id, canvas: e.canvas, content_hash: contentHash(e.node.body), summary_written: null, summary_for_hash: null, embedded_hash: null, ...over }];
}

describe('planJobs (spec M5 §5)', () => {
  it('a new node needs an embedding and a summary, no rename yet', () => {
    const e = entry({ id: A });
    expect(planJobs([e], new Map([row(e)]))).toEqual({ embed: [A], summarize: [{ id: A, expected: '' }], rename: [] });
  });

  it('an up-to-date node needs nothing', () => {
    const e = entry({ id: A, summary: 'Titel' }, `${A}-titel.md`);
    const h = contentHash(e.node.body);
    expect(planJobs([e], new Map([row(e, { summary_written: 'Titel', summary_for_hash: h, embedded_hash: h })]))).toEqual({ embed: [], summarize: [], rename: [] });
  });

  it('a body change re-embeds and re-summarizes only when the summary is ours', () => {
    const ours = entry({ id: A, summary: 'Titel' }, `${A}-titel.md`);
    const theirs = entry({ id: 'B', summary: 'Mein eigener Titel' }, 'B-mein-eigener-titel.md');
    const rows = new Map([
      row(ours, { summary_written: 'Titel', summary_for_hash: 'old', embedded_hash: 'old' }),
      row(theirs, { summary_written: 'Titel', summary_for_hash: 'old', embedded_hash: 'old' }),
    ]);
    expect(planJobs([ours, theirs], rows)).toEqual({ embed: [A, 'B'], summarize: [{ id: A, expected: 'Titel' }], rename: [] });
  });

  it('after a rebuild an existing summary is final (summary_written null, body unchanged)', () => {
    const e = entry({ id: A, summary: 'Titel' }, `${A}-titel.md`);
    expect(planJobs([e], new Map([row(e)]))).toEqual({ embed: [A], summarize: [], rename: [] });
  });

  it('a user-provided summary on a bare-ULID file is a rename job without a summary job', () => {
    const e = entry({ id: A, summary: 'Von Hand' });
    const h = contentHash(e.node.body);
    expect(planJobs([e], new Map([row(e, { embedded_hash: h })]))).toEqual({ embed: [], summarize: [], rename: [A] });
  });

  it('an empty body gets no jobs', () => {
    const e = entry({ id: A, body: '' });
    expect(planJobs([e], new Map([row(e)]))).toEqual({ embed: [], summarize: [], rename: [] });
  });

  it('a node without a row (not yet synced) is skipped', () => {
    expect(planJobs([entry({ id: A })], new Map())).toEqual({ embed: [], summarize: [], rename: [] });
  });
});

describe('rowsForPlan', () => {
  it('refreshes content_hash and synthesises missing rows without touching the input', () => {
    const e = entry({ id: A });
    const stale = new Map([row(e, { content_hash: 'old', embedded_hash: 'old' })]);
    const out = rowsForPlan([e, entry({ id: 'B' })], stale);
    expect(out.get(A)).toMatchObject({ content_hash: contentHash(e.node.body), embedded_hash: 'old' });
    expect(out.get('B')).toEqual({ id: 'B', canvas: 'masterarbeit', content_hash: contentHash('Ein Body.\nZwei Zeilen.'), summary_written: null, summary_for_hash: null, embedded_hash: null });
    expect(stale.get(A)!.content_hash).toBe('old');
    expect(planJobs([e], out)).toEqual({ embed: [A], summarize: [{ id: A, expected: '' }], rename: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @chatmind/index test -- plan` → FAIL.

- [ ] **Step 3: Implement** — `packages/index/src/plan.ts`:

```ts
import type { MessageNode } from '@chatmind/core';
import type { NodeRow } from './db';
import { contentHash } from './hash';

export interface Entry { node: MessageNode; canvas: string; path: string }
export interface SummaryJob { id: string; expected: string }
export interface Jobs { embed: string[]; summarize: SummaryJob[]; rename: string[] }

export function isBareUlidPath(p: string, id: string): boolean {
  return p.split('/').pop() === `${id}.md`;
}

/** The synced view of `rows` for the given entries, computed without writing: fresh hashes, missing rows all NULL. */
export function rowsForPlan(entries: readonly Entry[], rows: ReadonlyMap<string, NodeRow>): Map<string, NodeRow> {
  const out = new Map<string, NodeRow>();
  for (const { node, canvas } of entries) {
    const r = rows.get(node.id);
    const content_hash = contentHash(node.body);
    out.set(node.id, r ? { ...r, content_hash } : { id: node.id, canvas, content_hash, summary_written: null, summary_for_hash: null, embedded_hash: null });
  }
  return out;
}

/**
 * Spec M5 §5 step 3. Pure: rows are the synced rows (content_hash current). Embed stale ⇔ embedded_hash ≠
 * content_hash. Summarize when the summary is empty, or still ours and made from an older body. Rename when a
 * summary exists but the file still carries the bare ULID; a fresh summary renames in its own writeback, so
 * `rename` only lists nodes that get no summary job.
 */
export function planJobs(entries: readonly Entry[], rows: ReadonlyMap<string, NodeRow>): Jobs {
  const jobs: Jobs = { embed: [], summarize: [], rename: [] };
  for (const { node, path } of entries) {
    const row = rows.get(node.id);
    if (!row || node.body === '') continue;
    if (row.embedded_hash !== row.content_hash) jobs.embed.push(node.id);
    const ours = row.summary_written !== null && node.summary === row.summary_written;
    if (node.summary === '' || (ours && row.summary_for_hash !== row.content_hash)) {
      jobs.summarize.push({ id: node.id, expected: node.summary });
    } else if (node.summary !== '' && isBareUlidPath(path, node.id)) {
      jobs.rename.push(node.id);
    }
  }
  return jobs;
}
```

Add to `packages/index/src/index.ts`: `export { planJobs, rowsForPlan, isBareUlidPath, type Entry, type Jobs, type SummaryJob } from './plan';`

- [ ] **Step 4: Verify** — `pnpm --filter @chatmind/index test && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/index
git commit -m "feat(index): planJobs derives embed/summarize/rename jobs from the vault-vs-rows diff"
```

---

### Task 5: `writeback` under the lock

**Files:**
- Create: `packages/index/src/writeback.ts`
- Test: `packages/index/test/writeback.test.ts`, `packages/index/test/helpers.ts`
- Modify: `packages/index/src/index.ts`

**Interfaces:**
- Consumes: `readVault`, `writeNode`, `writeCanvasFile`, `renameNodeFile`, `VaultLock` (core); `contentHash`.
- Produces:
  ```ts
  export interface WritebackJob { id: string; canvas: string; forHash: string; expectedSummary: string; newSummary: string }
  export interface WritebackResult { written: boolean; renamed: boolean; skipped: 'vanished' | 'body-changed' | 'summary-changed' | null }
  export async function writeback(job: WritebackJob, deps: { dataDir: string; lock: VaultLock }): Promise<WritebackResult>
  ```

- [ ] **Step 1: Test helpers** — `packages/index/test/helpers.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linearGraph, readVault, writeCanvas, type CanvasGraph, type MessageNode, type TranscriptMessage } from '@chatmind/core';

const dirs: string[] = [];
export async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-index-'));
  dirs.push(d);
  return d;
}
export async function cleanupTmpDirs(): Promise<void> {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  dirs.length = 0;
}

/** A vault with one canvas from a transcript; returns root and the written graph (paths assigned). */
export async function vaultWith(slug: string, messages: TranscriptMessage[]): Promise<{ root: string; graph: CanvasGraph }> {
  const root = await tmpDir();
  const graph = linearGraph(slug, messages);
  await writeCanvas(graph, root);
  return { root, graph };
}

export async function nodeOnDisk(root: string, slug: string, id: string): Promise<{ node: MessageNode; path: string }> {
  const { canvases } = await readVault(root);
  const g = canvases.find((c) => c.slug === slug)!;
  return { node: g.nodes.get(id)!, path: g.paths.get(id)! };
}

export async function files(root: string, slug: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, slug, 'nodes'))).filter((f) => !f.startsWith('.')).sort();
}
```

- [ ] **Step 2: Failing tests** — `packages/index/test/writeback.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VaultLock } from '@chatmind/core';
import { contentHash } from '../src/hash';
import { writeback } from '../src/writeback';
import { cleanupTmpDirs, files, nodeOnDisk, vaultWith } from './helpers';

afterAll(cleanupTmpDirs);

describe('writeback (spec M5 §6)', () => {
  it('writes the summary, renames the bare-ULID file once and updates graph.canvas', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Wie evaluiere ich Topic-Zuordnung?' }]);
    const id = [...graph.nodes.keys()][0]!;
    const res = await writeback({ id, canvas: 'm', forHash: contentHash('Wie evaluiere ich Topic-Zuordnung?'), expectedSummary: '', newSummary: 'Evaluation der Topic-Zuordnung' }, { dataDir: root, lock: new VaultLock() });
    expect(res).toEqual({ written: true, renamed: true, skipped: null });
    expect(await files(root, 'm')).toEqual([`${id}-evaluation-der-topic-zuordnung.md`]);
    const { node, path: p } = await nodeOnDisk(root, 'm', id);
    expect(node.summary).toBe('Evaluation der Topic-Zuordnung');
    expect(p).toBe(`m/nodes/${id}-evaluation-der-topic-zuordnung.md`);
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'm', 'graph.canvas'), 'utf8')) as { nodes: { file: string }[] };
    expect(canvas.nodes[0]!.file).toBe(p);
  });

  it('a second summary never renames again', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const deps = { dataDir: root, lock: new VaultLock() };
    await writeback({ id, canvas: 'm', forHash: contentHash('Frage'), expectedSummary: '', newSummary: 'Erster' }, deps);
    const res = await writeback({ id, canvas: 'm', forHash: contentHash('Frage'), expectedSummary: 'Erster', newSummary: 'Zweiter' }, deps);
    expect(res).toEqual({ written: true, renamed: false, skipped: null });
    expect(await files(root, 'm')).toEqual([`${id}-erster.md`]);
    expect((await nodeOnDisk(root, 'm', id)).node.summary).toBe('Zweiter');
  });

  it('rename-only job: summary unchanged, file renamed', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const file = path.join(root, 'm', 'nodes', `${id}.md`);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace("summary: ''", 'summary: Von Hand'));
    const res = await writeback({ id, canvas: 'm', forHash: contentHash('Frage'), expectedSummary: 'Von Hand', newSummary: 'Von Hand' }, { dataDir: root, lock: new VaultLock() });
    expect(res).toEqual({ written: false, renamed: true, skipped: null });
    expect(await files(root, 'm')).toEqual([`${id}-von-hand.md`]);
  });

  it('skips when the body changed or the summary changed since the job was planned', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: 'Frage' }]);
    const id = [...graph.nodes.keys()][0]!;
    const deps = { dataDir: root, lock: new VaultLock() };
    expect(await writeback({ id, canvas: 'm', forHash: contentHash('andere Frage'), expectedSummary: '', newSummary: 'X' }, deps)).toEqual({ written: false, renamed: false, skipped: 'body-changed' });
    expect(await writeback({ id, canvas: 'm', forHash: contentHash('Frage'), expectedSummary: 'nicht leer', newSummary: 'X' }, deps)).toEqual({ written: false, renamed: false, skipped: 'summary-changed' });
    expect(await writeback({ id: 'nope', canvas: 'm', forHash: 'h', expectedSummary: '', newSummary: 'X' }, deps)).toEqual({ written: false, renamed: false, skipped: 'vanished' });
    expect(await files(root, 'm')).toEqual([`${id}.md`]);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @chatmind/index test -- writeback` → FAIL.

- [ ] **Step 4: Implement** — `packages/index/src/writeback.ts`:

```ts
import { readVault, renameNodeFile, writeCanvasFile, writeNode, type VaultLock } from '@chatmind/core';
import { contentHash } from './hash';

export interface WritebackJob {
  id: string;
  canvas: string;
  forHash: string; // content_hash the summary was generated from
  expectedSummary: string; // '' for a fresh summary, our previous one for a regeneration, the user's for rename-only
  newSummary: string;
}

export interface WritebackResult {
  written: boolean;
  renamed: boolean;
  skipped: 'vanished' | 'body-changed' | 'summary-changed' | null;
}

/**
 * Spec M5 §6: one lock turn — re-read, guard against a concurrent edit, write the summary, rename once,
 * write graph.canvas. The graph is re-read whole (like completion.persist) because the canvas file needs
 * every node's path and layout.
 */
export async function writeback(job: WritebackJob, deps: { dataDir: string; lock: VaultLock }): Promise<WritebackResult> {
  return deps.lock.run(async () => {
    const { canvases } = await readVault(deps.dataDir);
    const graph = canvases.find((g) => g.slug === job.canvas);
    const node = graph?.nodes.get(job.id);
    if (!graph || !node) return { written: false, renamed: false, skipped: 'vanished' };
    if (contentHash(node.body) !== job.forHash) return { written: false, renamed: false, skipped: 'body-changed' };
    if (node.summary !== job.expectedSummary) return { written: false, renamed: false, skipped: 'summary-changed' };
    let written = false;
    if (job.newSummary !== node.summary) {
      node.summary = job.newSummary;
      await writeNode(graph, job.id, deps.dataDir);
      written = true;
    }
    const renamed = await renameNodeFile(graph, job.id, deps.dataDir);
    if (renamed) await writeCanvasFile(graph, deps.dataDir);
    return { written, renamed, skipped: null };
  });
}
```

Add to `packages/index/src/index.ts`: `export { writeback, type WritebackJob, type WritebackResult } from './writeback';`

- [ ] **Step 5: Verify** — `pnpm --filter @chatmind/index test && pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/index
git commit -m "feat(index): writeback writes the summary and renames once under the vault lock"
```

---

### Task 6: `reconcile` — read, sync, plan, execute, report

**Files:**
- Create: `packages/index/src/reconcile.ts`
- Test: `packages/index/test/reconcile.test.ts`, `packages/index/test/fakes.ts`
- Modify: `packages/index/src/index.ts`

**Interfaces:**
- Consumes: `IndexDb`, `planJobs`, `writeback`, `contentHash`, summary helpers, `readVault`, `detectLanguage`.
- Produces:
  ```ts
  export interface ReconcileDeps { dataDir: string; db: IndexDb; summarizer: Summarizer; embedder: Embedder; lock: VaultLock; log?: (msg: string) => void; embedBatch?: number; summaryConcurrency?: number }
  export async function reconcile(deps: ReconcileDeps): Promise<Report>
  export function countPending(deps: { dataDir: string; db: IndexDb }): Promise<{ embed: number; summarize: number }>  // read + plan only
  ```

- [ ] **Step 1: Fakes** — `packages/index/test/fakes.ts`:

```ts
import type { Embedder, Summarizer } from '../src/types';

/** Deterministic 4-dim vector from the text; records calls; can be made to fail. */
export function fakeEmbedder(opts: { fail?: boolean } = {}): Embedder & { calls: string[][]; fail: boolean } {
  const e = {
    model: 'fake/embed',
    dim: 4,
    calls: [] as string[][],
    fail: opts.fail ?? false,
    async embed(texts: string[]): Promise<Float32Array[]> {
      e.calls.push(texts);
      if (e.fail) throw new Error('embed down');
      return texts.map((t) => Float32Array.from([t.length, t.charCodeAt(0) || 0, 1, 0]));
    },
  };
  return e;
}

/** "T: <first 20 chars>" with the language; records calls; can fail. */
export function fakeSummarizer(opts: { fail?: boolean } = {}): Summarizer & { calls: string[]; fail: boolean } {
  const s = Object.assign(
    async (body: string, lang: 'de' | 'en'): Promise<string> => {
      s.calls.push(body);
      if (s.fail) throw new Error('llm down');
      return `${lang.toUpperCase()}: ${body.slice(0, 20)}`;
    },
    { calls: [] as string[], fail: opts.fail ?? false },
  );
  return s;
}
```

- [ ] **Step 2: Failing tests** — `packages/index/test/reconcile.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { VaultLock, linearGraph, writeCanvas } from '@chatmind/core';
import { IndexDb } from '../src/db';
import { contentHash } from '../src/hash';
import { countPending, reconcile } from '../src/reconcile';
import { fakeEmbedder, fakeSummarizer } from './fakes';
import { cleanupTmpDirs, files, nodeOnDisk, tmpDir, vaultWith } from './helpers';

afterAll(cleanupTmpDirs);

const LONG_Q = 'Wie evaluiere ich die Topic-Zuordnung, wenn die Zentroide sich mit der Zeit verschieben und alte Zettel nicht wandern dürfen?';
const LONG_A = 'Zentroid statt Re-Clustering.\n\nDie Begründung ist, dass Zettel niemals rückwirkend ihre Zuordnung ändern sollen.';

function deps(root: string, over: Partial<Parameters<typeof reconcile>[0]> = {}) {
  const embedder = fakeEmbedder();
  const summarizer = fakeSummarizer();
  return { dataDir: root, db: IndexDb.open(':memory:', embedder), summarizer, embedder, lock: new VaultLock(), embedBatch: 2, ...over };
}

describe('reconcile (spec M5 §5)', () => {
  it('fills a fresh index: embeds, summarizes, renames; the second run is a fixed point', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: LONG_Q }, { role: 'assistant', content: LONG_A, model: 'x' }, { role: 'user', content: 'Danke' }]);
    const [q, a, d] = [...graph.nodes.keys()];
    const d1 = deps(root);
    const r1 = await reconcile(d1);
    expect(r1).toMatchObject({ nodes: 3, embedded: 3, summarized: 3, renamed: 3, failed: 0, pending: { embed: 0, summarize: 0 } });
    expect(d1.embedder.calls.map((c) => c.length)).toEqual([2, 1]); // batch size 2
    expect(d1.summarizer.calls).toHaveLength(2); // 'Danke' took the shortcut
    expect((await nodeOnDisk(root, 'm', q!)).node.summary).toBe(`DE: ${LONG_Q.slice(0, 20)}`);
    expect((await nodeOnDisk(root, 'm', d!)).node.summary).toBe('Danke');
    expect(await files(root, 'm')).toEqual([`${q}-de-wie-evaluiere-ich-die.md`, `${a}-de-zentroid-statt-re-cl.md`, `${d}-danke.md`].sort());
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
    expect(r).toMatchObject({ nodes: 2, embedded: 0, summarized: 0, pending: { embed: 0, summarize: 0 } });
    expect(d.db.rows().has(two!)).toBe(false);
    expect(d.db.vector(two!)).toBeNull();
    const empty = [...g.nodes.keys()][0]!;
    expect(d.db.rows().get(empty)).toMatchObject({ embedded_hash: contentHash('') });
    expect(d.db.rows().has(one!)).toBe(true);
  });

  it('failures leave rows stale and count as pending; a later run finishes them', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG_Q }]);
    const d = deps(root);
    d.embedder.fail = true;
    d.summarizer.fail = true;
    const log: string[] = [];
    const r1 = await reconcile({ ...d, log: (m) => log.push(m) });
    expect(r1).toMatchObject({ embedded: 0, summarized: 0, failed: 2, pending: { embed: 1, summarize: 1 } });
    expect(log.join('\n')).toMatch(/embed down/);
    expect(log.join('\n')).toMatch(/llm down/);
    d.embedder.fail = false;
    d.summarizer.fail = false;
    expect(await reconcile(d)).toMatchObject({ embedded: 1, summarized: 1, failed: 0, pending: { embed: 0, summarize: 0 } });
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

  it('countPending reads without writing', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG_Q }]);
    const d = deps(root);
    expect(await countPending(d)).toEqual({ embed: 1, summarize: 1 });
    await reconcile(d);
    expect(await countPending(d)).toEqual({ embed: 0, summarize: 0 });
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
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @chatmind/index test -- reconcile` → FAIL.

- [ ] **Step 4: Implement** — `packages/index/src/reconcile.ts`:

```ts
import { detectLanguage, readVault, type VaultLock } from '@chatmind/core';
import type { IndexDb } from './db';
import { contentHash } from './hash';
import { planJobs, rowsForPlan, type Entry, type Jobs } from './plan';
import { cleanSummary, shortcutSummary, truncateForEmbedding, truncateForSummary } from './summary';
import type { Embedder, Report, Summarizer } from './types';
import { writeback } from './writeback';

export interface ReconcileDeps {
  dataDir: string;
  db: IndexDb;
  summarizer: Summarizer;
  embedder: Embedder;
  lock: VaultLock;
  log?: (msg: string) => void;
  embedBatch?: number; // default 32
  summaryConcurrency?: number; // default 4
}

/** Every node of every canvas as a plan entry (the reader has already repaired paths in memory). */
export async function readEntries(dataDir: string): Promise<Entry[]> {
  const { canvases } = await readVault(dataDir);
  return canvases.flatMap((g) => [...g.nodes.values()].map((node) => ({ node, canvas: g.slug, path: g.paths.get(node.id)! })));
}

/** Spec M5 §5 steps 1–2: read the vault, drop vanished rows, refresh every content_hash. */
async function sync(dataDir: string, db: IndexDb): Promise<{ entries: Entry[]; byId: Map<string, Entry> }> {
  const entries = await readEntries(dataDir);
  const byId = new Map(entries.map((e) => [e.node.id, e]));
  db.deleteNodes([...db.rows().keys()].filter((id) => !byId.has(id)));
  for (const e of entries) {
    const hash = contentHash(e.node.body);
    db.upsertNode(e.node.id, e.canvas, hash);
    if (e.node.body === '') db.setEmbedded(e.node.id, hash, null);
  }
  return { entries, byId };
}

/** Read + plan only, no writes — what `chatmind index status` shows. */
export async function countPending(deps: { dataDir: string; db: IndexDb }): Promise<{ embed: number; summarize: number }> {
  const entries = await readEntries(deps.dataDir);
  const jobs = planJobs(entries, rowsForPlan(entries, deps.db.rows()));
  return { embed: jobs.embed.length, summarize: jobs.summarize.length };
}

async function runPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** Spec M5 §5: the one operation. Every job moves a row toward "all hashes equal"; a run with no jobs is the fixed point. */
export async function reconcile(deps: ReconcileDeps): Promise<Report> {
  const log = deps.log ?? ((m: string) => console.log(`index: ${m}`));
  const at = new Date().toISOString();
  const { entries, byId } = await sync(deps.dataDir, deps.db);
  const jobs: Jobs = planJobs(entries, deps.db.rows());
  const report: Report = { at, nodes: entries.length, embedded: 0, summarized: 0, renamed: 0, failed: 0, pending: { embed: 0, summarize: 0 } };

  // embed, batched and sequential (spec §5)
  const batch = deps.embedBatch ?? 32;
  for (let i = 0; i < jobs.embed.length; i += batch) {
    const ids = jobs.embed.slice(i, i + batch);
    try {
      const vecs = await deps.embedder.embed(ids.map((id) => truncateForEmbedding(byId.get(id)!.node.body)));
      if (vecs.length !== ids.length) throw new Error(`embedder returned ${vecs.length} vectors for ${ids.length} texts`);
      for (const v of vecs) if (v.length !== deps.embedder.dim) throw new Error(`embedder returned dim ${v.length}, expected ${deps.embedder.dim}`);
      ids.forEach((id, k) => deps.db.setEmbedded(id, contentHash(byId.get(id)!.node.body), vecs[k]!));
      report.embedded += ids.length;
    } catch (err) {
      report.failed += 1;
      report.pending.embed += ids.length;
      log(`embed failed for ${ids.length} node(s): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // summarize with bounded concurrency; each result is written back under the lock
  await runPool(jobs.summarize, deps.summaryConcurrency ?? 4, async ({ id, expected }) => {
    const { node, canvas } = byId.get(id)!;
    const forHash = contentHash(node.body);
    try {
      const summary = shortcutSummary(node.body) ?? cleanSummary(await deps.summarizer(truncateForSummary(node.body), detectLanguage([node.body])));
      if (summary === '') throw new Error('empty summary');
      const res = await writeback({ id, canvas, forHash, expectedSummary: expected, newSummary: summary }, deps);
      if (res.skipped !== null) {
        log(`summary for ${id} dropped: ${res.skipped}`);
        report.pending.summarize += 1;
        return;
      }
      deps.db.setSummary(id, summary, forHash);
      report.summarized += 1;
      if (res.renamed) report.renamed += 1;
    } catch (err) {
      report.failed += 1;
      report.pending.summarize += 1;
      log(`summary failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // rename-only (summary provided by the user on a bare-ULID file)
  for (const id of jobs.rename) {
    const { node, canvas } = byId.get(id)!;
    try {
      const res = await writeback({ id, canvas, forHash: contentHash(node.body), expectedSummary: node.summary, newSummary: node.summary }, deps);
      if (res.renamed) report.renamed += 1;
    } catch (err) {
      report.failed += 1;
      log(`rename failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}
```

Add to `packages/index/src/index.ts`: `export { reconcile, countPending, readEntries, type ReconcileDeps } from './reconcile';`

- [ ] **Step 5: Verify** — `pnpm --filter @chatmind/index test && pnpm typecheck` → PASS. The expected filenames in the first test are `slug('DE: ' + first 20 body chars)`; if your computed slug differs, print `nodeFileName(id, summary)` and fix the **expectation** (the slug rule is cycle-1's, not this task's). `grapheme-ascii` keeps the property test to printable ASCII so YAML quoting never becomes the subject.

- [ ] **Step 6: Commit**

```bash
git add packages/index
git commit -m "feat(index): reconcile reads, syncs, plans and executes embed/summary/rename jobs"
```

---

### Task 7: Watcher and `Indexer`

**Files:**
- Create: `packages/index/src/watcher.ts`, `packages/index/src/indexer.ts`
- Test: `packages/index/test/watcher.test.ts`, `packages/index/test/indexer.test.ts`
- Modify: `packages/index/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  // watcher.ts
  export interface VaultWatcher { onChange(listener: (slugs: string[]) => void): () => void; close(): Promise<void> }
  export function watchVault(dataDir: string, opts?: { debounceMs?: number; stabilityMs?: number }): VaultWatcher
  export function slugOf(dataDir: string, file: string): string | null    // pure: first path segment, null for .app/, dot-entries, *.tmp, non-md/canvas files
  // indexer.ts
  export interface IndexerOptions { dataDir: string; dbFile: string; summarizer: Summarizer; embedder: Embedder; lock: VaultLock; log?: (msg: string) => void; retryMs?: { initial: number; max: number }; embedBatch?: number; summaryConcurrency?: number }
  export class Indexer {
    constructor(opts: IndexerOptions)
    start(): Promise<void>        // opens the db, runs the first reconcile
    trigger(): void               // dirty-flag serialised run
    status(): IndexStatus
    idle(): Promise<void>         // resolves when no run is active and none pending (tests, shutdown)
    close(): Promise<void>
  }
  ```

- [ ] **Step 1: Failing tests**

`packages/index/test/watcher.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { slugOf, watchVault } from '../src/watcher';
import { cleanupTmpDirs, tmpDir } from './helpers';

afterAll(cleanupTmpDirs);

describe('slugOf', () => {
  it('maps vault files to their canvas slug and ignores the rest', () => {
    const root = '/v';
    expect(slugOf(root, '/v/masterarbeit/nodes/01J.md')).toBe('masterarbeit');
    expect(slugOf(root, '/v/masterarbeit/graph.canvas')).toBe('masterarbeit');
    expect(slugOf(root, '/v/masterarbeit')).toBe('masterarbeit'); // folder add/unlink
    expect(slugOf(root, '/v/.app/index.db')).toBeNull();
    expect(slugOf(root, '/v/masterarbeit/nodes/.01J.md.abc.tmp')).toBeNull();
    expect(slugOf(root, '/v/masterarbeit/notes.txt')).toBeNull();
    expect(slugOf(root, '/v')).toBeNull();
    expect(slugOf(root, '/elsewhere/x.md')).toBeNull();
  });
});

describe('watchVault', () => {
  it('emits the affected slugs once per debounced batch and ignores .app', async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, 'm', 'nodes'), { recursive: true });
    await fs.mkdir(path.join(root, '.app'), { recursive: true });
    const w = watchVault(root, { debounceMs: 100, stabilityMs: 50 });
    const batches: string[][] = [];
    w.onChange((slugs) => batches.push(slugs));
    await new Promise((r) => setTimeout(r, 300)); // chokidar ready
    await fs.writeFile(path.join(root, 'm', 'nodes', 'a.md'), 'x');
    await fs.writeFile(path.join(root, 'm', 'nodes', 'b.md'), 'y');
    await fs.writeFile(path.join(root, '.app', 'index.db'), 'z');
    await new Promise((r) => setTimeout(r, 600));
    expect(batches).toEqual([['m']]);
    await fs.mkdir(path.join(root, 'n'));
    await fs.writeFile(path.join(root, 'n', 'graph.canvas'), '{}');
    await new Promise((r) => setTimeout(r, 600));
    expect(batches).toEqual([['m'], ['n']]);
    await w.close();
  }, 10_000);
});
```

`packages/index/test/indexer.test.ts`:
```ts
import { afterAll, describe, expect, it, vi } from 'vitest';
import { VaultLock } from '@chatmind/core';
import path from 'node:path';
import { Indexer } from '../src/indexer';
import { fakeEmbedder, fakeSummarizer } from './fakes';
import { cleanupTmpDirs, nodeOnDisk, vaultWith } from './helpers';

afterAll(cleanupTmpDirs);

const LONG = 'Wie evaluiere ich die Topic-Zuordnung, wenn die Zentroide sich mit der Zeit verschieben?';

function make(root: string, over: Partial<ConstructorParameters<typeof Indexer>[0]> = {}) {
  const embedder = fakeEmbedder();
  const summarizer = fakeSummarizer();
  const log: string[] = [];
  const ix = new Indexer({ dataDir: root, dbFile: path.join(root, '.app', 'index.db'), embedder, summarizer, lock: new VaultLock(), log: (m) => log.push(m), retryMs: { initial: 50, max: 200 }, ...over });
  return { ix, embedder, summarizer, log };
}

describe('Indexer (spec M5 §5)', () => {
  it('start runs a reconcile; status reflects it', async () => {
    const { root, graph } = await vaultWith('m', [{ role: 'user', content: LONG }]);
    const { ix } = make(root);
    expect(ix.status()).toEqual({ enabled: true, running: false, lastRun: null, pending: { embed: 0, summarize: 0 } });
    await ix.start();
    await ix.idle();
    const s = ix.status();
    expect(s.running).toBe(false);
    expect(s.lastRun).toMatchObject({ nodes: 1, embedded: 1, summarized: 1 });
    expect((await nodeOnDisk(root, 'm', [...graph.nodes.keys()][0]!)).node.summary).toMatch(/^DE: /);
    await ix.close();
  });

  it('triggers during a run collapse into exactly one follow-up run', async () => {
    const { root } = await vaultWith('m', [{ role: 'user', content: LONG }]);
    let release: () => void = () => undefined;
    const slow = Object.assign(async (b: string) => { await new Promise<void>((r) => { release = r; }); return `T ${b.slice(0, 5)}`; }, { calls: [], fail: false });
    const { ix, embedder } = make(root, { summarizer: slow });
    const started = ix.start();
    await new Promise((r) => setTimeout(r, 20)); // inside run 1, blocked in the summarizer
    ix.trigger();
    ix.trigger();
    ix.trigger();
    release();
    await started;
    await ix.idle();
    // run 1 embedded once; run 2 (the single follow-up) found nothing to embed
    expect(embedder.calls).toHaveLength(1);
    expect(ix.status().lastRun).toMatchObject({ embedded: 0, summarized: 0 });
    await ix.close();
  });

  it('schedules retries with backoff while failures remain, and stops when clean', async () => {
    vi.useFakeTimers();
    try {
      const { root } = await vaultWith('m', [{ role: 'user', content: LONG }]);
      const { ix, embedder, summarizer } = make(root);
      embedder.fail = true;
      summarizer.fail = true;
      await ix.start();
      await ix.idle();
      expect(ix.status().pending).toEqual({ embed: 1, summarize: 1 });
      await vi.advanceTimersByTimeAsync(50);
      await ix.idle();
      expect(embedder.calls).toHaveLength(2); // retry after 50 ms
      await vi.advanceTimersByTimeAsync(100);
      await ix.idle();
      expect(embedder.calls).toHaveLength(3); // then 100 ms
      embedder.fail = false;
      summarizer.fail = false;
      await vi.advanceTimersByTimeAsync(200);
      await ix.idle();
      expect(ix.status().pending).toEqual({ embed: 0, summarize: 0 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(embedder.calls).toHaveLength(4); // no further retries
      await ix.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @chatmind/index test -- watcher indexer` → FAIL.

- [ ] **Step 3: Implement**

`packages/index/src/watcher.ts`:
```ts
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';

export interface VaultWatcher {
  onChange(listener: (slugs: string[]) => void): () => void;
  close(): Promise<void>;
}

/** Canvas slug for a path under the vault, or null when the path is nothing we watch (spec M5 §5). */
export function slugOf(dataDir: string, file: string): string | null {
  const rel = path.relative(dataDir, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.some((p) => p.startsWith('.')) || rel.endsWith('.tmp')) return null;
  const last = parts[parts.length - 1]!;
  if (parts.length > 1 && !last.endsWith('.md') && last !== 'graph.canvas') return null;
  return parts[0]!;
}

/**
 * chokidar 5 has no glob support: watch the whole data dir, ignore dot-entries at any depth, and let
 * `slugOf` filter. Events are collected for `debounceMs` after the last one and emitted as one batch.
 */
export function watchVault(dataDir: string, opts: { debounceMs?: number; stabilityMs?: number } = {}): VaultWatcher {
  const listeners = new Set<(slugs: string[]) => void>();
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    timer = null;
    const slugs = [...pending].sort();
    pending.clear();
    for (const l of listeners) l(slugs);
  };
  const watcher: FSWatcher = watch(dataDir, {
    ignoreInitial: true,
    ignored: (p) => path.relative(dataDir, p).split(path.sep).some((seg) => seg.startsWith('.')),
    awaitWriteFinish: { stabilityThreshold: opts.stabilityMs ?? 300, pollInterval: 50 },
  });
  watcher.on('all', (_event, file) => {
    const slug = slugOf(dataDir, file);
    if (slug === null) return;
    pending.add(slug);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, opts.debounceMs ?? 300);
  });
  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (timer !== null) clearTimeout(timer);
      await watcher.close();
    },
  };
}
```

`packages/index/src/indexer.ts`:
```ts
import type { VaultLock } from '@chatmind/core';
import { IndexDb } from './db';
import { reconcile } from './reconcile';
import type { Embedder, IndexStatus, Report, Summarizer } from './types';

export interface IndexerOptions {
  dataDir: string;
  dbFile: string;
  summarizer: Summarizer;
  embedder: Embedder;
  lock: VaultLock;
  log?: (msg: string) => void;
  retryMs?: { initial: number; max: number }; // default 60 s → 10 min
  embedBatch?: number;
  summaryConcurrency?: number;
}

/**
 * Spec M5 §5: at most one reconcile at a time; a trigger during a run sets `dirty` and exactly one more run
 * follows. While a run ends with pending jobs a retry timer doubles from `initial` to `max`; a clean run resets it.
 */
export class Indexer {
  private db: IndexDb | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private lastRun: Report | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private closed = false;

  constructor(private readonly o: IndexerOptions) {
    this.retryDelay = o.retryMs?.initial ?? 60_000;
  }

  async start(): Promise<void> {
    this.db = IndexDb.open(this.o.dbFile, this.o.embedder);
    this.trigger();
    await this.running;
  }

  trigger(): void {
    if (this.closed || this.db === null) return;
    if (this.running !== null) {
      this.dirty = true;
      return;
    }
    this.running = this.runLoop().finally(() => {
      this.running = null;
    });
  }

  private async runLoop(): Promise<void> {
    do {
      this.dirty = false;
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      try {
        this.lastRun = await reconcile({ dataDir: this.o.dataDir, db: this.db!, summarizer: this.o.summarizer, embedder: this.o.embedder, lock: this.o.lock, log: this.o.log, embedBatch: this.o.embedBatch, summaryConcurrency: this.o.summaryConcurrency });
      } catch (err) {
        (this.o.log ?? console.error)(`reconcile crashed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } while (this.dirty && !this.closed);
    const pending = this.lastRun ? this.lastRun.pending.embed + this.lastRun.pending.summarize : 0;
    if (pending > 0 && !this.closed) {
      const max = this.o.retryMs?.max ?? 600_000;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.trigger();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, max);
    } else {
      this.retryDelay = this.o.retryMs?.initial ?? 60_000;
    }
  }

  status(): IndexStatus {
    return { enabled: true, running: this.running !== null, lastRun: this.lastRun, pending: this.lastRun?.pending ?? { embed: 0, summarize: 0 } };
  }

  /** Resolves once no run is active (a queued follow-up run counts as active). */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    await Promise.race([this.idle(), new Promise<void>((r) => setTimeout(r, 10_000))]);
    this.db?.close();
    this.db = null;
  }
}
```

Add to `packages/index/src/index.ts`:
```ts
export { watchVault, slugOf, type VaultWatcher } from './watcher';
export { Indexer, type IndexerOptions } from './indexer';
```

- [ ] **Step 4: Verify** — `pnpm --filter @chatmind/index test && pnpm typecheck` → PASS. The fake-timer test relies on `reconcile` awaiting only promises (no real timers) — the fakes are promise-only, so `advanceTimersByTimeAsync` drains them. If the watcher test is flaky on macOS, raise the sleeps, never remove the `.app` assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/index
git commit -m "feat(index): chokidar vault watcher with debounced slugs; Indexer serialises runs and retries with backoff"
```

---

### Task 8: Server providers — `loadEnv`, OpenRouter summarizer and embedder

**Files:**
- Modify: `apps/server/src/keys.ts`, `apps/server/package.json`
- Create: `apps/server/src/index-providers.ts`
- Test: `apps/server/test/keys.test.ts` (extend), `apps/server/test/index-providers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // keys.ts
  export async function loadEnv(env?: NodeJS.ProcessEnv, filePath?: string): Promise<Record<string, string>>  // env wins over file; empty strings dropped
  // index-providers.ts
  export interface IndexSettings { summaryModel: string; embedModel: string; embedDim: number; noIndex: boolean }
  export const DEFAULT_INDEX_SETTINGS: IndexSettings   // 'openai/gpt-5.6-luna', 'openai/text-embedding-3-small', 1536, false
  export function indexSettings(env: Record<string, string>): IndexSettings
  export function createSummarizer(model: LanguageModel): Summarizer
  export function createEmbedder(model: EmbeddingModel, id: string, dim: number): Embedder
  export function openRouterIndexProviders(apiKey: string, s: IndexSettings): { summarizer: Summarizer; embedder: Embedder }
  ```

- [ ] **Step 1: Dependencies**

`apps/server/package.json` dependencies: add `"@chatmind/index": "workspace:*"`. Run `pnpm install`.

- [ ] **Step 2: Failing tests**

Append to `apps/server/test/keys.test.ts`:
```ts
import { loadEnv } from '../src/keys';

describe('loadEnv', () => {
  it('merges the key file under the process env and drops empty values', async () => {
    const file = path.join(await tmpDir(), 'env');
    await fs.writeFile(file, 'OPENROUTER_API_KEY=file\nCHATMIND_SUMMARY_MODEL=openai/x\n');
    const env = await loadEnv({ OPENROUTER_API_KEY: 'env', CHATMIND_EMBED_DIM: '' } as NodeJS.ProcessEnv, file);
    expect(env.OPENROUTER_API_KEY).toBe('env');
    expect(env.CHATMIND_SUMMARY_MODEL).toBe('openai/x');
    expect('CHATMIND_EMBED_DIM' in env).toBe(false);
  });
});
```
(Use the file's existing imports/helpers for `fs`, `path`, `tmpDir`; add what is missing.)

`apps/server/test/index-providers.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MockEmbeddingModelV3, MockLanguageModelV3 } from 'ai/test';
import { SUMMARY_SYSTEM } from '@chatmind/index';
import { createEmbedder, createSummarizer, DEFAULT_INDEX_SETTINGS, indexSettings } from '../src/index-providers';

describe('indexSettings', () => {
  it('defaults to Luna + text-embedding-3-small/1536 via OpenRouter', () => {
    expect(indexSettings({})).toEqual(DEFAULT_INDEX_SETTINGS);
    expect(DEFAULT_INDEX_SETTINGS).toEqual({ summaryModel: 'openai/gpt-5.6-luna', embedModel: 'openai/text-embedding-3-small', embedDim: 1536, noIndex: false });
  });
  it('honours the env overrides', () => {
    expect(indexSettings({ CHATMIND_SUMMARY_MODEL: 'a/b', CHATMIND_EMBED_MODEL: 'c/d', CHATMIND_EMBED_DIM: '768', CHATMIND_NO_INDEX: '1' })).toEqual({ summaryModel: 'a/b', embedModel: 'c/d', embedDim: 768, noIndex: true });
    expect(indexSettings({ CHATMIND_EMBED_DIM: 'abc' }).embedDim).toBe(1536);
  });
});

describe('createSummarizer', () => {
  it('sends the fixed system prompt and the body, returns the raw text', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '"Ein Titel."' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: undefined, reasoning: undefined } },
        warnings: [],
      }),
    });
    const summarize = createSummarizer(model);
    expect(await summarize('Body text', 'de')).toBe('"Ein Titel."'); // cleaning happens in @chatmind/index
    const call = model.doGenerateCalls[0]!;
    expect(call.prompt[0]).toMatchObject({ role: 'system', content: SUMMARY_SYSTEM });
    expect(call.prompt[1]).toMatchObject({ role: 'user' });
    expect(JSON.stringify(call.prompt[1])).toContain('Body text');
    expect(call.maxOutputTokens).toBe(60);
  });
});

describe('createEmbedder', () => {
  it('returns Float32Arrays and carries model/dim', async () => {
    const model = new MockEmbeddingModelV3({ doEmbed: async ({ values }) => ({ embeddings: values.map(() => [0.1, 0.2, 0.3]), warnings: [] }) });
    const e = createEmbedder(model, 'test/embed', 3);
    expect(e.model).toBe('test/embed');
    expect(e.dim).toBe(3);
    const out = await e.embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0]!.length).toBe(3);
  });
});
```

If `MockLanguageModelV3`'s `doGenerate` result or `doEmbed` shape rejects at typecheck, align with `LanguageModelV3GenerateResult` / `EmbeddingModelV3Result` in `node_modules/.pnpm/@ai-sdk+provider@*/node_modules/@ai-sdk/provider/dist/index.d.ts` (the existing `apps/server/test/mock-model.ts` documents the same discovery for streaming).

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @chatmind/server test -- keys index-providers` → FAIL.

- [ ] **Step 4: Implement**

`apps/server/src/keys.ts` — add `loadEnv` and make `loadKeys` use it:
```ts
/** Process env first, then the key file; empty strings count as unset. Never throws for a missing file. */
export async function loadEnv(env: NodeJS.ProcessEnv = process.env, filePath: string = DEFAULT_KEY_FILE): Promise<Record<string, string>> {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnvFile(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fromFile)) if (v) out[k] = v;
  for (const [k, v] of Object.entries(env)) if (v) out[k] = v;
  return out;
}

export async function loadKeys(env: NodeJS.ProcessEnv = process.env, filePath: string = DEFAULT_KEY_FILE): Promise<Keys> {
  const all = await loadEnv(env, filePath);
  const keys: Keys = {};
  for (const [provider, name] of Object.entries(VARS) as [keyof Keys, string][]) {
    if (all[name]) keys[provider] = all[name];
  }
  return keys;
}
```

`apps/server/src/index-providers.ts`:
```ts
import { SUMMARY_SYSTEM, type Embedder, type Summarizer } from '@chatmind/index';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { embedMany, generateText, type EmbeddingModel, type LanguageModel } from 'ai';

export interface IndexSettings { summaryModel: string; embedModel: string; embedDim: number; noIndex: boolean }

/** Spec M5 §2/§6 defaults; everything runs through OpenRouter. */
export const DEFAULT_INDEX_SETTINGS: IndexSettings = { summaryModel: 'openai/gpt-5.6-luna', embedModel: 'openai/text-embedding-3-small', embedDim: 1536, noIndex: false };

export function indexSettings(env: Record<string, string>): IndexSettings {
  const dim = Number(env.CHATMIND_EMBED_DIM);
  return {
    summaryModel: env.CHATMIND_SUMMARY_MODEL || DEFAULT_INDEX_SETTINGS.summaryModel,
    embedModel: env.CHATMIND_EMBED_MODEL || DEFAULT_INDEX_SETTINGS.embedModel,
    embedDim: Number.isInteger(dim) && dim > 0 ? dim : DEFAULT_INDEX_SETTINGS.embedDim,
    noIndex: env.CHATMIND_NO_INDEX === '1' || env.CHATMIND_NO_INDEX === 'true',
  };
}

/** Raw model text; cleaning and the short-body shortcut live in @chatmind/index. */
export function createSummarizer(model: LanguageModel): Summarizer {
  return async (body) => {
    const { text } = await generateText({ model, system: SUMMARY_SYSTEM, prompt: body, maxOutputTokens: 60 });
    return text;
  };
}

export function createEmbedder(model: EmbeddingModel, id: string, dim: number): Embedder {
  return {
    model: id,
    dim,
    async embed(texts) {
      const { embeddings } = await embedMany({ model, values: texts });
      return embeddings.map((v) => Float32Array.from(v));
    },
  };
}

export function openRouterIndexProviders(apiKey: string, s: IndexSettings): { summarizer: Summarizer; embedder: Embedder } {
  const openrouter = createOpenRouter({ apiKey });
  return {
    summarizer: createSummarizer(openrouter(s.summaryModel)),
    embedder: createEmbedder(openrouter.textEmbeddingModel(s.embedModel), s.embedModel, s.embedDim),
  };
}
```

The `Summarizer` signature takes `(body, lang)`; `lang` is unused here because the system prompt says "in the language of the message" — keep the parameter for fakes and future prompts.

- [ ] **Step 5: Verify** — `pnpm --filter @chatmind/server test && pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): loadEnv; OpenRouter summarizer and embedder behind the index interfaces"
```

---

### Task 9: `GET /api/events`, `GET /api/index/status`, server wiring and shutdown

**Files:**
- Modify: `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Test: `apps/server/test/app.test.ts` (extend)

**Interfaces:**
- Consumes: `VaultWatcher`, `IndexStatus`, `Indexer`, `watchVault`, `openRouterIndexProviders`, `indexSettings`, `loadEnv`.
- Produces: `AppOptions.watcher?: Pick<VaultWatcher, 'onChange'>`, `AppOptions.indexer?: { status(): IndexStatus }`; `apps/server/src/index.ts` flag `--no-index`.

- [ ] **Step 1: Failing tests** — append to `apps/server/test/app.test.ts`:

```ts
import type { IndexStatus } from '@chatmind/index';

function fakeWatcher() {
  const listeners = new Set<(slugs: string[]) => void>();
  return {
    onChange(l: (slugs: string[]) => void) { listeners.add(l); return () => listeners.delete(l); },
    emit(slugs: string[]) { for (const l of listeners) l(slugs); },
    size: () => listeners.size,
  };
}

async function readUntil(body: ReadableStream<Uint8Array>, needle: string): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (!buf.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  await reader.cancel();
  return buf;
}

describe('GET /api/events (spec M5 §7)', () => {
  it('streams vault-changed events from the watcher', async () => {
    const watcher = fakeWatcher();
    const app = createApp({ dataDir: await vaultWithCanvas(), watcher });
    const res = await app.request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await new Promise((r) => setTimeout(r, 10)); // handler subscribed
    expect(watcher.size()).toBe(1);
    watcher.emit(['masterarbeit']);
    const text = await readUntil(res.body!, '\n\n');
    expect(text).toContain('event: vault-changed\ndata: {"slugs":["masterarbeit"]}');
  });

  it('opens without a watcher and only sends keep-alives', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    const res = await app.request('/api/events');
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });
});

describe('GET /api/index/status', () => {
  it('reports disabled without an indexer', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    expect(await json<IndexStatus>(await app.request('/api/index/status'))).toEqual({ enabled: false, running: false, lastRun: null, pending: { embed: 0, summarize: 0 } });
  });
  it('passes the indexer status through', async () => {
    const status: IndexStatus = { enabled: true, running: true, lastRun: null, pending: { embed: 2, summarize: 1 } };
    const app = createApp({ dataDir: await vaultWithCanvas(), indexer: { status: () => status } });
    expect(await json<IndexStatus>(await app.request('/api/index/status'))).toEqual(status);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @chatmind/server test -- app` → FAIL (unknown options / 404).

- [ ] **Step 3: Implement**

`apps/server/src/app.ts` — extend `AppOptions` and add the routes before `app.all('/api/*', …)`:
```ts
import type { IndexStatus, VaultWatcher } from '@chatmind/index';

export interface AppOptions {
  dataDir: string;
  staticDir?: string;
  keys?: Keys;
  modelFactory?: ModelFactory;
  /** File watcher feeding /api/events; absent in tests that need no events. */
  watcher?: Pick<VaultWatcher, 'onChange'>;
  /** Background indexer; absent when no key or --no-index (spec M5 §8). */
  indexer?: { status(): IndexStatus };
}
```
```ts
  const KEEP_ALIVE_MS = 25_000;
  // Spec M5 §7: one long-lived stream per client; the watcher's debounced batches become vault-changed events.
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = watcher?.onChange((slugs) => void stream.writeSSE({ event: 'vault-changed', data: JSON.stringify({ slugs }) }).catch(() => undefined)) ?? (() => undefined);
      const keepAlive = setInterval(() => void stream.write(': keep-alive\n\n').catch(() => undefined), KEEP_ALIVE_MS);
      keepAlive.unref(); // never keeps the process (or a vitest worker) alive on its own
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepAlive);
      unsubscribe();
    }),
  );

  const OFF: IndexStatus = { enabled: false, running: false, lastRun: null, pending: { embed: 0, summarize: 0 } };
  app.get('/api/index/status', (c) => c.json(indexer ? indexer.status() : OFF));
```
Destructure `watcher` and `indexer` from the options in `createApp`. If `stream.write` is not on Hono's `SSEStreamingApi` in the installed version, use `stream.writeSSE({ event: 'keep-alive', data: '' })` instead — the client ignores unknown events.

`apps/server/src/index.ts` — replace the body after `parseArgs`:
```ts
import { Indexer, watchVault } from '@chatmind/index';
import { VaultLock } from '@chatmind/core';
import { indexSettings, openRouterIndexProviders } from './index-providers';
import { loadEnv, loadKeys } from './keys';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    port: { type: 'string' },
    static: { type: 'string' },
    'no-index': { type: 'boolean' },
  },
});
// … dataDir / port / staticDir as before …

await fs.mkdir(dataDir, { recursive: true });
const env = await loadEnv();
const keys = await loadKeys();
const settings = indexSettings(env);
const lock = new VaultLock();
const watcher = watchVault(dataDir);

let indexer: Indexer | undefined;
let indexLine = 'index: off (--no-index)';
if (!(values['no-index'] || settings.noIndex)) {
  if (keys.openrouter) {
    const { summarizer, embedder } = openRouterIndexProviders(keys.openrouter, settings);
    indexer = new Indexer({ dataDir, dbFile: path.join(dataDir, '.app', 'index.db'), summarizer, embedder, lock });
    watcher.onChange(() => indexer!.trigger());
    indexLine = `index: on (summary ${settings.summaryModel}, embed ${settings.embedModel}/${settings.embedDim})`;
  } else {
    indexLine = 'index: off (no OPENROUTER_API_KEY)';
  }
}

const app = createApp({ dataDir, staticDir, keys, lock, watcher, indexer });
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`chatmind server on http://127.0.0.1:${port}  data dir: ${dataDir}${staticDir ? `  serving ${staticDir}` : ''}`);
  console.log(`providers: ${Object.keys(keys).join(', ') || 'none (set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, or ~/.config/chatmind/env)'}`);
  console.log(indexLine);
});
if (indexer) void indexer.start().catch((err: unknown) => console.error(`index: start failed: ${err instanceof Error ? err.message : String(err)}`));

// Spec M5 §8: stop watching, let the current reconcile finish (bounded inside close()), close the db.
const shutdown = async (): Promise<void> => {
  await watcher.close();
  await indexer?.close();
  server.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
```
`createApp` must accept `lock?: VaultLock` (default `new VaultLock()`) so the indexer and the send endpoint share one instance — add it to `AppOptions` and use `options.lock ?? new VaultLock()`.

- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm test` → PASS. Then a smoke run against a scratch vault (never the user's):

```bash
mkdir -p /private/tmp/claude-501/-Users-fabian-dev-chatmind/7084d3f1-8a33-40f8-92b1-8582ca612241/scratchpad/vault
pnpm --filter @chatmind/server exec tsx src/index.ts --data-dir /private/tmp/claude-501/-Users-fabian-dev-chatmind/7084d3f1-8a33-40f8-92b1-8582ca612241/scratchpad/vault --port 3299 --no-index &
sleep 2
curl -s http://127.0.0.1:3299/api/index/status
curl -sN --max-time 3 http://127.0.0.1:3299/api/events &
sleep 1; curl -s -XPOST -H 'content-type: application/json' -d '{"name":"probe"}' http://127.0.0.1:3299/api/canvases
sleep 2
kill %1
```
Expected: status `{"enabled":false,…}`; the events stream prints `event: vault-changed` / `data: {"slugs":["probe"]}`. Kill the server by pid afterwards (`kill <pid>`).

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): /api/events from the vault watcher, /api/index/status, --no-index, indexer wiring and shutdown"
```

---

### Task 10: CLI `chatmind index status`

**Files:**
- Create: `apps/cli/src/index-status.ts`
- Modify: `apps/cli/src/index.ts`, `apps/cli/package.json`
- Test: `apps/cli/test/index-status.test.ts`

**Interfaces:**
- Consumes: `IndexDb.openReadonly`, `countPending`, `planJobs`, `readVault`, `DEFAULT_INDEX_SETTINGS` (duplicated as constants here — the CLI does not depend on the server).
- Produces: `export async function indexStatus(dataDir?: string): Promise<number>` (always 0; prints the report).

- [ ] **Step 1: Dependency** — `apps/cli/package.json`: add `"@chatmind/index": "workspace:*"`; `pnpm install`.

- [ ] **Step 2: Failing test** — `apps/cli/test/index-status.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { VaultLock, linearGraph, writeCanvas } from '@chatmind/core';
import { IndexDb, reconcile } from '@chatmind/index';
import { indexStatus } from '../src/index-status';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

async function vault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-cli-'));
  dirs.push(root);
  await writeCanvas(linearGraph('m', [{ role: 'user', content: 'Eine längere Frage, die keinen Shortcut bekommt, weil sie mehr als achtzig Zeichen hat, ganz sicher.' }, { role: 'user', content: 'Kurz' }]), root);
  return root;
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  return { lines, restore: () => spy.mockRestore() };
}

describe('chatmind index status', () => {
  it('reports "no index" when index.db is missing', async () => {
    const root = await vault();
    const { lines, restore } = capture();
    expect(await indexStatus(root)).toBe(0);
    restore();
    expect(lines.join('\n')).toMatch(/no index/);
    expect(lines.join('\n')).toMatch(/canvas m: 2 nodes, 0 embedded, 0 summarized, pending embed 2, pending summary 2/);
  });

  it('counts embedded, summarized and pending per canvas after a reconcile', async () => {
    const root = await vault();
    const embedder = { model: 'openai/text-embedding-3-small', dim: 1536, embed: async (t: string[]) => t.map(() => new Float32Array(1536)) };
    const db = IndexDb.open(path.join(root, '.app', 'index.db'), embedder);
    await reconcile({ dataDir: root, db, embedder, summarizer: async (b) => `T ${b.slice(0, 10)}`, lock: new VaultLock() });
    db.close();
    const { lines, restore } = capture();
    await indexStatus(root);
    restore();
    const out = lines.join('\n');
    expect(out).toMatch(/canvas m: 2 nodes, 2 embedded, 2 summarized, pending embed 0, pending summary 0/);
    expect(out).toMatch(/embed model: openai\/text-embedding-3-small \(dim 1536\) — matches default/);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @chatmind/cli test -- index-status` → FAIL.

- [ ] **Step 4: Implement** — `apps/cli/src/index-status.ts`:

```ts
import path from 'node:path';
import { exists, readVault, resolveDataDir } from '@chatmind/core';
import { IndexDb, contentHash, planJobs, rowsForPlan, type Entry } from '@chatmind/index';

// Defaults mirror apps/server/src/index-providers.ts (the CLI does not import the server).
const DEFAULT_EMBED = { model: 'openai/text-embedding-3-small', dim: 1536 };

/** Spec M5 §8: read-only report — vault + index.db, no network, no writes. Exit 0 always. */
export async function indexStatus(dataDir?: string): Promise<number> {
  const root = resolveDataDir(dataDir);
  const file = path.join(root, '.app', 'index.db');
  console.log(`data dir: ${root}`);
  const { canvases } = await readVault(root);
  const db = (await exists(file)) ? IndexDb.openReadonly(file) : null;
  if (db === null) console.log('no index (.app/index.db missing) — start the server to build it');
  const rows = db?.rows() ?? new Map();
  for (const g of canvases) {
    const entries: Entry[] = [...g.nodes.values()].map((node) => ({ node, canvas: g.slug, path: g.paths.get(node.id)! }));
    const fresh = rowsForPlan(entries, rows);
    const jobs = planJobs(entries, fresh);
    const embedded = entries.filter((e) => fresh.get(e.node.id)?.embedded_hash === contentHash(e.node.body)).length;
    const summarized = entries.filter((e) => e.node.summary !== '').length;
    console.log(`canvas ${g.slug}: ${entries.length} nodes, ${embedded} embedded, ${summarized} summarized, pending embed ${jobs.embed.length}, pending summary ${jobs.summarize.length}`);
  }
  if (db !== null) {
    const model = db.meta('embed_model');
    const dim = db.meta('embed_dim');
    const matches = model === DEFAULT_EMBED.model && dim === String(DEFAULT_EMBED.dim);
    console.log(`embed model: ${model} (dim ${dim}) — ${matches ? 'matches default' : 'differs from default; the server rebuilds vectors on start if its setting differs'}`);
    db.close();
  }
  return 0;
}
```

`apps/cli/src/index.ts`: add `index status` to `USAGE` (`chatmind index status [--data-dir <path>]`) and a case:
```ts
    case 'index': {
      if (rest[0] !== 'status') { console.error(USAGE); return 2; }
      return indexStatus(dataDir);
    }
```
with `import { indexStatus } from './index-status';`.

- [ ] **Step 5: Verify** — `pnpm typecheck && pnpm test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli pnpm-lock.yaml
git commit -m "feat(cli): chatmind index status reads the vault and index.db without network"
```

---

### Task 11: Web — `mergeCanvas` and event subscription

**Files:**
- Create: `apps/web/src/merge.ts`, `apps/web/src/events.ts`
- Test: `apps/web/test/merge.test.ts`, `apps/web/test/events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // merge.ts
  export function mergeCanvas(current: CanvasDto, fresh: CanvasDto, streams: ReadonlyMap<string, unknown>): CanvasDto
  // events.ts
  export function subscribeVaultEvents(onChange: (slugs: string[]) => void): () => void   // no-op without EventSource
  export function createRefetcher(run: () => Promise<void>): () => void                   // coalescing trigger
  ```

- [ ] **Step 1: Failing tests**

`apps/web/test/merge.test.ts`:
```ts
import type { CanvasDto, NodeDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { mergeCanvas } from '../src/merge';

const n = (id: string, over: Partial<NodeDto> = {}): NodeDto => ({ id, role: 'user', parents: [], created: 'c', summary: '', topics: [], body: 'b', layout: { x: 0, y: 0, width: 400, height: 200 }, ...over });
const dto = (nodes: NodeDto[], edges: CanvasDto['edges'] = []): CanvasDto => ({ slug: 'm', nodes, edges, repairs: [] });

describe('mergeCanvas (spec M5 §7)', () => {
  it('keeps object identity for unchanged nodes and takes changed ones from fresh', () => {
    const a = n('A');
    const cur = dto([a, n('B')]);
    const fresh = dto([n('A'), n('B', { summary: 'Titel' })]);
    const out = mergeCanvas(cur, fresh, new Map());
    expect(out.nodes[0]).toBe(a);
    expect(out.nodes[1]).toEqual(n('B', { summary: 'Titel' }));
    expect(out.nodes[1]).not.toBe(cur.nodes[1]);
  });

  it('returns the current object when nothing changed', () => {
    const cur = dto([n('A')], [{ id: 'e', from: 'X', to: 'A' }]);
    expect(mergeCanvas(cur, dto([n('A')], [{ id: 'e', from: 'X', to: 'A' }]), new Map())).toBe(cur);
  });

  it('adds new nodes in fresh order and drops vanished ones', () => {
    const out = mergeCanvas(dto([n('A'), n('B')]), dto([n('C'), n('A')]), new Map());
    expect(out.nodes.map((x) => x.id)).toEqual(['C', 'A']);
  });

  it('keeps a streaming ghost that the vault does not have yet, with its edge', () => {
    const ghost = n('G', { role: 'assistant', parents: ['A'] });
    const cur = dto([n('A'), ghost], [{ id: 'e-A-G', from: 'A', to: 'G' }]);
    const out = mergeCanvas(cur, dto([n('A', { summary: 'S' })]), new Map([['G', {}]]));
    expect(out.nodes.map((x) => x.id)).toEqual(['A', 'G']);
    expect(out.nodes[1]).toBe(ghost);
    expect(out.edges).toEqual([{ id: 'e-A-G', from: 'A', to: 'G' }]);
  });

  it('a layout change from disk is applied', () => {
    const out = mergeCanvas(dto([n('A')]), dto([n('A', { layout: { x: 10, y: 0, width: 400, height: 200 } })]), new Map());
    expect(out.nodes[0]!.layout.x).toBe(10);
  });
});
```

`apps/web/test/events.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRefetcher, subscribeVaultEvents } from '../src/events';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createRefetcher', () => {
  it('runs once, coalesces triggers during a run into exactly one follow-up', async () => {
    let resolve: () => void = () => undefined;
    const runs: number[] = [];
    const run = vi.fn(() => new Promise<void>((r) => { runs.push(runs.length); resolve = r; }));
    const trigger = createRefetcher(run);
    trigger();
    trigger();
    trigger();
    expect(run).toHaveBeenCalledTimes(1);
    resolve();
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
    resolve();
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a rejected run does not block the next trigger', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const trigger = createRefetcher(run);
    trigger();
    await tick();
    trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('subscribeVaultEvents', () => {
  afterEach(() => { delete (globalThis as { EventSource?: unknown }).EventSource; });

  it('is a no-op without EventSource (jsdom)', () => {
    expect(typeof subscribeVaultEvents(() => undefined)).toBe('function');
  });

  it('parses vault-changed and closes on unsubscribe', () => {
    const instances: FakeES[] = [];
    class FakeES {
      listeners = new Map<string, (e: MessageEvent) => void>();
      closed = false;
      constructor(public url: string) { instances.push(this); }
      addEventListener(type: string, l: (e: MessageEvent) => void) { this.listeners.set(type, l); }
      close() { this.closed = true; }
    }
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
    const seen: string[][] = [];
    const off = subscribeVaultEvents((slugs) => seen.push(slugs));
    expect(instances[0]!.url).toBe('/api/events');
    instances[0]!.listeners.get('vault-changed')!({ data: '{"slugs":["m"]}' } as MessageEvent);
    instances[0]!.listeners.get('vault-changed')!({ data: 'not json' } as MessageEvent);
    expect(seen).toEqual([['m']]);
    off();
    expect(instances[0]!.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @chatmind/web test -- merge events` → FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/merge.ts`:
```ts
import type { CanvasDto, EdgeDto, NodeDto } from '@chatmind/core';

function sameLayout(a: NodeDto['layout'], b: NodeDto['layout']): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function sameNode(a: NodeDto, b: NodeDto): boolean {
  return a.role === b.role && a.model === b.model && a.created === b.created && a.summary === b.summary && a.body === b.body && sameList(a.parents, b.parents) && sameList(a.topics, b.topics) && sameLayout(a.layout, b.layout);
}
function sameEdges(a: readonly EdgeDto[], b: readonly EdgeDto[]): boolean {
  return a.length === b.length && a.every((e, i) => e.id === b[i]!.id && e.from === b[i]!.from && e.to === b[i]!.to);
}

/**
 * Spec M5 §7: merge a refetched canvas into the current one by id. Unchanged nodes keep their object
 * (React Flow does not remount), changed/new nodes come from `fresh` in its order, vanished nodes go —
 * except streaming ghosts (ids in `streams`), which belong to the client until `done`. Returns `current`
 * itself when nothing differs.
 */
export function mergeCanvas(current: CanvasDto, fresh: CanvasDto, streams: ReadonlyMap<string, unknown>): CanvasDto {
  const byId = new Map(current.nodes.map((n) => [n.id, n]));
  const nodes: NodeDto[] = fresh.nodes.map((n) => {
    const cur = byId.get(n.id);
    return cur !== undefined && sameNode(cur, n) ? cur : n;
  });
  const freshIds = new Set(fresh.nodes.map((n) => n.id));
  const ghosts = current.nodes.filter((n) => !freshIds.has(n.id) && streams.has(n.id));
  nodes.push(...ghosts);
  const ghostIds = new Set(ghosts.map((g) => g.id));
  const edges: EdgeDto[] = [...fresh.edges, ...current.edges.filter((e) => ghostIds.has(e.to))];
  const unchanged = nodes.length === current.nodes.length && nodes.every((n, i) => n === current.nodes[i]) && sameEdges(edges, current.edges) && fresh.repairs.length === current.repairs.length;
  return unchanged ? current : { slug: current.slug, nodes, edges, repairs: fresh.repairs };
}
```

`apps/web/src/events.ts`:
```ts
/** One refetch in flight at a time; triggers during a run set a dirty flag → exactly one more run (spec M5 §7). */
export function createRefetcher(run: () => Promise<void>): () => void {
  let running = false;
  let dirty = false;
  const loop = async (): Promise<void> => {
    running = true;
    try {
      do {
        dirty = false;
        await run().catch(() => undefined);
      } while (dirty);
    } finally {
      running = false;
    }
  };
  return () => {
    if (running) dirty = true;
    else void loop();
  };
}

/** Opens /api/events; the browser reconnects on its own. No-op where EventSource is missing (tests). */
export function subscribeVaultEvents(onChange: (slugs: string[]) => void): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;
  const es = new EventSource('/api/events');
  es.addEventListener('vault-changed', (e) => {
    try {
      const { slugs } = JSON.parse((e as MessageEvent).data as string) as { slugs: unknown };
      if (Array.isArray(slugs) && slugs.every((s) => typeof s === 'string')) onChange(slugs as string[]);
    } catch {
      // malformed event — ignore
    }
  });
  return () => es.close();
}
```

- [ ] **Step 4: Verify** — `pnpm --filter @chatmind/web test && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): mergeCanvas keeps identity and streaming ghosts; EventSource subscription with coalesced refetch"
```

---

### Task 12: Web — wire events into `App`

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/App.test.tsx` (extend)

**Interfaces:**
- Consumes: `subscribeVaultEvents`, `createRefetcher`, `mergeCanvas`, `fetchCanvas`, `fetchCanvases`.

- [ ] **Step 1: Failing test** — add to `apps/web/test/App.test.tsx` (reuse the file's existing fetch mock; it maps `/api/canvases/masterarbeit` to `masterarbeit`):

```ts
describe('live vault updates (spec M5 §7)', () => {
  it('refetches the current canvas on vault-changed and shows the new summary without losing the cursor', async () => {
    const instances: { listeners: Map<string, (e: MessageEvent) => void> }[] = [];
    class FakeES {
      listeners = new Map<string, (e: MessageEvent) => void>();
      constructor() { instances.push(this); }
      addEventListener(type: string, l: (e: MessageEvent) => void) { this.listeners.set(type, l); }
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
    try {
      render(<App />);
      await screen.findByText('Ursprungsfrage');
      // select the first card so we can check the cursor survives
      await userEvent.click(screen.getByText('Ursprungsfrage'));
      // the next fetch of the canvas returns a new summary on node 2
      extraCanvasBodies = { masterarbeit: { ...masterarbeit, nodes: [masterarbeit.nodes[0], { ...masterarbeit.nodes[1], summary: 'Neuer Titel' }] } };
      await act(async () => {
        instances[0]!.listeners.get('vault-changed')!({ data: '{"slugs":["masterarbeit"]}' } as MessageEvent);
      });
      await screen.findByText('Neuer Titel');
      expect(screen.getByText('Ursprungsfrage').closest('.react-flow__node')).toHaveClass('selected');
    } finally {
      delete (globalThis as { EventSource?: unknown }).EventSource;
      extraCanvasBodies = {};
    }
  });
});
```
Adapt the selector for "card is the cursor" to whatever class/attribute `MessageNode.tsx` renders for the cursor today (grep `cursor` in `apps/web/src/MessageNode.tsx` and `flow.ts`); the assertion must check that the cursor node is still the cursor after the merge. If the file's fetch mock does not consult `extraCanvasBodies` for known slugs, extend the mock so a slug present there overrides the static fixture.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @chatmind/web test -- App` → FAIL (no refetch happens).

- [ ] **Step 3: Implement** — in `apps/web/src/App.tsx`:

```ts
import { createRefetcher, subscribeVaultEvents } from './events';
import { mergeCanvas } from './merge';
```
Add `streamsRef` and `canvasesRef` next to `currentSlugRef` and keep them current (the subscription effect runs once and must never read a stale closure):
```ts
  const streamsRef = useRef<ReadonlyMap<string, StreamState>>(new Map());
  useEffect(() => { streamsRef.current = streams; }, [streams]);
  const canvasesRef = useRef<CanvasSummaryDto[]>([]);
  useEffect(() => { canvasesRef.current = canvases ?? []; }, [canvases]);
```
Add the subscription effect after the canvas-loading effect:
```ts
  // Spec M5 §7: follow the vault. Any change reloads the list; a change to the open canvas refetches and
  // merges it by id — ghosts, cursor and camera are left alone.
  useEffect(() => {
    const refetch = createRefetcher(async () => {
      const cur = currentSlugRef.current;
      const [list, fresh] = await Promise.all([fetchCanvases(), cur === null ? null : fetchCanvas(cur)]);
      setCanvases(list);
      if (fresh === null || currentSlugRef.current !== fresh.slug) return;
      setCanvas((c) => (c && c.slug === fresh.slug ? mergeCanvas(c, fresh, streamsRef.current) : c));
      const ids = new Set([...fresh.nodes.map((n) => n.id), ...streamsRef.current.keys()]);
      setSelection((s) => (s.cursorId !== null && !ids.has(s.cursorId) ? { ...s, cursorId: null } : s));
    });
    return subscribeVaultEvents((slugs) => {
      const cur = currentSlugRef.current;
      const unknown = slugs.some((s) => !canvasesRef.current.some((c) => c.slug === s));
      if (cur === null || slugs.includes(cur) || unknown) refetch();
      else void fetchCanvases().then(setCanvases).catch(() => undefined);
    });
  }, []);
```
If the current canvas fails to refetch (404 after deletion in Obsidian), `createRefetcher` swallows the error; the list reload removes it and `slug` selection falls back through the existing empty-list handling.

- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm test` → PASS. Then a manual probe on a scratch vault with `--no-index` (watcher only): start the server on :3299 and a Vite instance with a temp config proxying to it, open a canvas, edit a node's body in the scratch vault with `sed`, see the card update without reload; kill both by pid.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): follow vault-changed events — refetch and merge the open canvas live"
```

---

### Task 13: Docs — README, CLAUDE.md, cycle-1 pointer

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-11-chatmind-vault-format-design.md`

- [ ] **Step 1: README** — add a section after the running/setup instructions:

```markdown
## Index (M5)

With an `OPENROUTER_API_KEY` the server runs a background indexer: every node gets a one-line `summary`
(written into its frontmatter; the file is renamed once from `<ULID>.md` to `<ULID>-<slug>.md`) and an
embedding in `<data dir>/.app/index.db`. The database is derived and disposable — delete it and restart
to rebuild. The browser follows every change on disk (including edits in Obsidian) through `/api/events`.

- Models: `CHATMIND_SUMMARY_MODEL` (default `openai/gpt-5.6-luna`), `CHATMIND_EMBED_MODEL`
  (default `openai/text-embedding-3-small`) and `CHATMIND_EMBED_DIM` (default `1536`), in the
  environment or `~/.config/chatmind/env`.
- `--no-index` (or `CHATMIND_NO_INDEX=1`) runs the server without the indexer; the watcher and
  `/api/events` stay on.
- `pnpm cli index status [--data-dir <path>]` reports per canvas how many nodes are embedded and
  summarized and what is pending — no network, no writes.
- A summary you edit by hand is never overwritten; a body you edit gets a new embedding and, if the
  summary was generated, a new summary.
```

- [ ] **Step 2: CLAUDE.md** — in "Hard invariants" change the reader line to:
```
- The reader repairs in memory and reports `Repair[]`; it never writes and never deletes structure. The indexer (M5) writes only `summary` into frontmatter and renames a file exactly once, from `{ULID}.md` to `{ULID}-{slug}.md`; nothing else in the vault is ever renamed or deleted.
```
In "Workflow", change the scratch-server line to include `--no-index`: `--data-dir <scratchpad>/vault --port 3299 --no-index`. In "Code rules" add: `- `@chatmind/index` has no network dependency; LLM/embedding calls are injected (`Summarizer`, `Embedder`) and implemented in `apps/server/src/index-providers.ts`.`

- [ ] **Step 3: cycle-1 spec §8.2** — replace `(M5 may rename once when a file still carries the bare-ULID name and a summary becomes available — decided there.)` with `(Decided in the M5 spec §6: renamed exactly once, from the bare-ULID name, when a summary exists.)`.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/superpowers/specs/2026-09-11-chatmind-vault-format-design.md
git commit -m "docs: README index section; CLAUDE.md rename exception and --no-index; cycle-1 §8.2 pointer"
```

---

### Task 14: Full verification and gate handoff

- [ ] **Step 1:** `pnpm typecheck && pnpm test` — all packages green; note the counts.
- [ ] **Step 2:** Rebuild check on a scratch vault **with** the index (this spends a few cents on OpenRouter — only with the user's ok in the session): import a transcript via `pnpm cli import-transcript … --data-dir <scratchpad>/vault`, start the server on :3299 without `--no-index`, wait for `curl /api/index/status` to show `running: false` and `pending: {0,0}`, run `pnpm cli index status --data-dir <scratchpad>/vault`, delete `<scratchpad>/vault/.app/index.db`, restart, confirm the same status. Kill the server by pid.
- [ ] **Step 3:** Hand over to the user for the manual gate (spec §9): delete `index.db` in their vault, restart, `pnpm cli index status`; titles appear on cards without reload; files renamed in Obsidian with a file open; body edit in Obsidian → browser follows and the summary regenerates; summary edit in Obsidian → stays; card dragged in Obsidian → browser follows; `pnpm cli check` clean. Record findings in `docs/superpowers/notes/<date>-m5-gate-findings.md`.
