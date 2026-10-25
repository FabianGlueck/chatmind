# chatmind M5 — Index, summaries, embeddings, live vault updates

Date: 2026-09-18. Builds on the cycle-1 vault format spec (§3 invariants, §4 stack, §8.2 filenames, §13 M5) and the M3/M4 specs. Brainstormed with the user; decisions below are theirs unless marked as defaults.

## 1. Goal and done condition

M5 gives every node a one-line `summary` (written into frontmatter, visible in Obsidian, used as card title and merge label) and an embedding (stored in SQLite, invisible until M6/M7). Both are produced by a background indexer that reacts to file changes. Because the indexer writes into the vault, the browser gets a live channel so summaries — and any other change made on disk, e.g. in Obsidian — appear without a reload.

**Done when** deleting `.app/index.db` and restarting the server rebuilds it fully (`chatmind index status` shows every node embedded and summarized), summaries show up live on the cards, files are renamed once in Obsidian, and a summary edited by hand in Obsidian is never overwritten.

## 2. Decisions

| Topic | Decision |
|---|---|
| Live updates | Yes (not "write-only" as the roadmap put it): a generic `vault-changed` SSE channel driven by the file watcher; the browser refetches and merges. Obsidian edits show up in the browser too. |
| Providers | Everything via OpenRouter (the only key the user has). Summaries: `openai/gpt-5.6-luna`. Embeddings: `openai/text-embedding-3-small`, dim 1536 (the roadmap's choice; OpenRouter exposes it at `/api/v1/embeddings`). Both overridable via env (§6). |
| Summary shape | Originally title-like (≤ 80 chars). Changed 2026-09-21 at the user's request: a short summary of 1–3 sentences, ≤ 250 characters, in the node's language; cards show only the summary, the panel shows summary and body; `nodeTitle` caps it to 80 chars wherever a title is needed (panel heading, merge labels). Existing summaries are not regenerated. |
| Rename | Exactly once: a file still named `{ULID}.md` is renamed to `{ULID}-{slug}.md` when a non-empty summary exists (ours or the user's). Never renamed again, never back. This is the explicit exception to "the writer never renames" that cycle-1 §8.2 reserved for M5. |
| Body edited (in Obsidian) | Embedding is recomputed. The summary is regenerated **only if it is still the one we wrote**; a summary the user changed is never touched. |
| `index.db` deleted | Embeddings are rebuilt; existing non-empty summaries are kept as they are (we no longer know which were ours), only empty ones are filled. |
| Indexer architecture | Reconcile loop (read vault → diff against SQLite → jobs), triggered by startup and the watcher. No per-file event logic; rebuild is the ordinary path with an empty table. |
| Where it runs | Inside the server process. The CLI only reads the index for `status`. |
| Roles | Both `user` and `assistant` nodes get summaries and embeddings. |

## 3. Packages and files

```
packages/index/                    new, @chatmind/index, Node-only
  src/db.ts                        open/migrate index.db, schema, vec table (re)creation
  src/hash.ts                      contentHash(body) = sha256 hex
  src/reconcile.ts                 reconcile(): diff → jobs → execute → report
  src/writeback.ts                 summary write + rename-once under the vault lock
  src/summary.ts                   summary post-processing, short-body shortcut, prompt text
  src/watcher.ts                   chokidar → debounced trigger; emits changed slugs
  src/indexer.ts                   Indexer class: start/stop, serialised runs, retry timer, status
  src/index.ts                     public exports
packages/core/src/vault/write.ts   + renameNodeFile(graph, id, root)
packages/core/src/vault/lock.ts    VaultLock moves here from apps/server (index and server share it)
apps/server/src/index-providers.ts OpenRouter Summarizer + Embedder via the AI SDK
apps/server/src/app.ts             + GET /api/events, GET /api/index/status; indexer option
apps/server/src/index.ts           + --no-index flag; starts the indexer
apps/cli/src/index-status.ts       chatmind index status
apps/web/src/events.ts             EventSource client, refetch coalescing
apps/web/src/merge.ts              mergeCanvas(current, fresh, streams): CanvasDto (pure, tested)
apps/web/src/App.tsx               wires events → refetch → merge; prunes selection
```

`@chatmind/index` depends on `@chatmind/core`, `better-sqlite3`, `sqlite-vec`, `chokidar`. It has **no network dependency**; the LLM and embedding calls are injected:

```ts
export interface Summarizer { (body: string, lang: 'de' | 'en'): Promise<string> }
export interface Embedder { model: string; dim: number; embed(texts: string[]): Promise<Float32Array[]> }
```

`apps/web` keeps importing runtime code only from `@chatmind/core/graph`; nothing from `@chatmind/index` reaches the browser.

## 4. Index database

Path: `<dataDir>/.app/index.db` (the reader already skips dot-folders). Fully disposable (invariant 3.1). Opened with WAL; one connection owned by the Indexer.

```sql
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- schema_version, embed_model, embed_dim
CREATE TABLE nodes (
  id               TEXT PRIMARY KEY,   -- ULID
  canvas           TEXT NOT NULL,
  content_hash     TEXT NOT NULL,      -- sha256(body), refreshed on every reconcile
  summary_written  TEXT,               -- the summary text WE last wrote; NULL = never / not ours
  summary_for_hash TEXT,               -- content_hash the written summary was generated from
  embedded_hash    TEXT                -- content_hash the stored vector belongs to; NULL = no vector
);
CREATE VIRTUAL TABLE vec_nodes USING vec0(id TEXT PRIMARY KEY, embedding float[<dim>]);
```

- `content_hash` is the single comparison value. Embedding stale ⇔ `embedded_hash IS NOT content_hash`. Summary stale ⇔ `summary_for_hash IS NOT content_hash AND summary_written = <summary currently in frontmatter>`.
- `meta.embed_model`/`embed_dim` are compared with the configured Embedder on open. On mismatch `vec_nodes` is dropped and recreated with the new dim, `embedded_hash` is set to NULL for every row, and `meta` is updated. A model change is therefore a rebuild of the vectors, nothing else.
- `schema_version = 1`. A future version (M6 topics/centroids, M7 semantic edges) migrates or, simplest, drops and rebuilds — the file is disposable.
- What is embedded: the **body** only, truncated to the model's context (8192 tokens for `text-embedding-3-small`; truncation by the core token estimate). One vector per node. Nodes with an empty body get no vector and no summary (an `embedded_hash` of the empty-body hash marks them done so they are not retried).

## 5. Reconcile

`reconcile(): Promise<Report>` is the only operation. Steps:

1. **Read** the vault with `readVault(dataDir)` — unchanged, repairs in memory only. Nodes behind an `unparseable-node` repair do not exist for this run (Obsidian's temp-file-plus-rename saves produce such moments); the next run picks them up. `duplicate-id` keeps the reader's choice.
2. **Sync rows**: delete `nodes`/`vec_nodes` rows whose id is no longer in the vault; upsert every current node with its `canvas` and fresh `content_hash` — all upserts in **one transaction** (the db runs `synchronous = NORMAL`; it is disposable).
3. **Derive jobs** purely from the diff:
   - **Embed**: rows with `embedded_hash IS NOT content_hash` and non-empty body. Batched, 32 texts per `embed` call, batches sequential.
   - **Summarize**: `summary === ''`, or (`summary === summary_written` and `summary_for_hash !== content_hash`). Non-empty body only. Concurrency 4.
   - **Rename**: `summary !== ''`, `slug(summary) !== ''` (a summary like `???` has no slug and would churn every run), and the file's basename is exactly `{ULID}.md`. Executed by the writeback step (§6) — either together with a fresh summary or on its own when the summary came from the user.
   - Empty body: no embed and no summary job; `embedded_hash` is set to `content_hash` without a vector so the row counts as done and is never pending.
4. **Execute**, updating rows as jobs finish. Vectors are written with `INSERT OR REPLACE` into `vec_nodes` and `embedded_hash` set in the same transaction.
5. **Report**: `{ at, nodes, embedded, summarized, renamed, failed, gaveUp, pending: { embed, summarize } }` where `pending` counts jobs still stale after the run that will be retried; a writeback skipped as `vanished` is not pending (the next sync deletes the row), given-up nodes (below) are not pending either.

**Convergence.** Every job moves a row toward "all hashes equal". Our own writes trigger the watcher → another reconcile → no jobs → quiet. Rebuild after deleting the database is the same path with every row missing. There is no second code path for "full rebuild".

**Serialisation.** At most one reconcile runs at a time. A trigger arriving during a run sets a `dirty` flag; when the run ends exactly one more run follows. Triggers: server start; every watcher batch; the retry timer.

**Triggers from the watcher.** chokidar on `<dataDir>`, watching `**/*.md` and `**/graph.canvas`, ignoring `.app/`, dot-entries and `*.tmp`; `awaitWriteFinish: { stabilityThreshold: 300 }`. Events are collected for 300 ms after the last one, then the set of affected canvas slugs (first path segment) is emitted once: to the SSE channel (§7) and to the reconcile trigger.

**Failures.** A failing job (network, rate limit, empty completion, wrong vector dim) is logged with node id and reason; its row stays stale. A failed embed **batch** is retried member by member once in the same run, so one rejected body cannot block the other 31. When a run ends with `pending > 0`, a retry timer schedules the next run: 60 s, doubling to a 10-minute cap, reset by any successful run with no failures. **Deterministic failures give up:** the `Indexer` keeps an in-memory per-node counter of consecutive failures (embed and summary share it); at `MAX_FAILURES = 3` the node is skipped — logged once, counted in `gaveUp`, not pending — until its `content_hash` changes. A wrong vector dimension is a configuration error (`CHATMIND_EMBED_DIM`) and is logged once per run. No key or `--no-index` → the indexer is not constructed at all; one log line; the rest of the app is unaffected.

**Streaming.** The writer writes assistant nodes once on completion (M3), so the watcher never sees a partial answer. The user node is written before the stream starts and is summarized while the answer streams.

## 6. Writeback and rename

Only `summary` is ever written by the indexer. One vault-lock turn per node (`VaultLock` moves to `packages/core/src/vault/lock.ts` so server and index share the instance the server passes in):

1. Re-read the vault (`readVault`) and take the node from it. *Deviation from the original "one file" wording:* the canvas rewrite after a rename needs every node's path and layout, so the whole vault is read under the lock, like `completion.persist` does. Cost: O(N) reads per writeback, O(N²) only on the first indexing of an existing vault. A `readCanvas(root, slug)` in core is the M6-era fix.
2. Guard: its `contentHash(body)` must equal the hash the summary was generated from, and its `summary` must equal what we expected (`''` for a fresh one, `summary_written` for a regeneration). Otherwise drop the job; the next reconcile decides afresh. This shrinks the "user is editing in Obsidian while we write" window to milliseconds.
3. Set `summary` on the node in the graph and call `writeNode` (same serializer as every other write: fixed key order, flow arrays, one trailing `\n`; frontmatter Obsidian reformatted gets normalised, the body is untouched).
4. If the basename is still `{ULID}.md`: `renameNodeFile(graph, id, root)` — `fs.rename` to `nodeFileName(id, summary)` in the same directory, update `graph.paths`, then `writeCanvasFile`. One lock turn, one visible change for Obsidian. If the target name already exists (an unlikely slug collision on a different file), the rename is skipped and logged; the file keeps its ULID name.
5. Update `summary_written`, `summary_for_hash`.

A crash between rename and canvas write is already covered: the reader repairs canvas paths from frontmatter ids (invariant 3.3).

`renameNodeFile` is the one exception to "the writer never renames or deletes" (cycle-1 §8.2): it only ever renames **from** a bare-ULID name, and only when the summary slug is non-empty. It never deletes, never moves between canvases, never renames a file that already carries a slug.

**Summary generation** (`apps/server/src/index-providers.ts` → `Summarizer`):

- Language via `detectLanguage([body])`. The summarizer receives `{ body, lang, role, parentContext? }` (`SummaryInput`): `parentContext` is the primary parent's summary, or the start of its body (≤ 300 chars) while it has none. System prompt (English, fixed for cache hits): 1–3 sentences, ≤ 200 characters, in the language of the message; for a **user** message state the intent (what is asked or wanted, not the quoted material) beginning with a label such as "Follow-up question: …"; for an **assistant** message state what the answer says. The user message is built by `summaryPrompt`: `Written by: <role>`, the parent as context ("for context only, do not summarise it"), then the body (added 2026-09-21 after user summaries repeated quoted text instead of the question). The body is sent as the user message, truncated to ~4000 tokens (a title needs the beginning, not the whole text).
- Post-processing in `packages/index/src/summary.ts` (pure, tested): take the **first paragraph** (up to a blank line — a hard-wrapped title is still one title, an explanation follows after a blank line), collapse whitespace to single spaces, strip surrounding quotes/backticks (ASCII and typographic), strip a trailing period only from a single-sentence result; over 250 characters (`SUMMARY_MAX`) cut back to the last sentence end in the second half, else on a word boundary with `…`. The prompt asks for ≤ 200 so the cut rarely triggers. Empty result → job failure (retry).
- **Shortcut**: a body that is a single non-empty line of ≤ 250 characters after trimming becomes its own summary with no LLM call (typical short user messages); whitespace runs are collapsed first so the stored `summary_written` equals what the serializer writes back.
- Model: `CHATMIND_SUMMARY_MODEL`, default `openai/gpt-5.6-luna`, via `createOpenRouter` and the AI SDK `generateText` with a small `maxOutputTokens`. Embedder: `CHATMIND_EMBED_MODEL`, default `openai/text-embedding-3-small` with dim 1536, via the AI SDK `embedMany` against the OpenRouter provider (dim is asserted on every returned vector). Both env vars are read like the keys: process env first, then `~/.config/chatmind/env`.

## 7. Live channel

### `GET /api/events` (SSE)

Stays open; a `: keep-alive` comment every 25 s; any number of clients. One event type in M5:

```
event: vault-changed
data: {"slugs":["masterarbeit"]}
```

Emitted by the watcher batch (§5) **before** the reconcile it triggers, so an Obsidian edit reaches the browser immediately and our own summary writes reach it through the same path when their file change lands. A new or removed canvas folder is a `vault-changed` with that slug. `/api/events` exists whether or not the indexer is enabled — the watcher runs whenever the server has a data dir; only the LLM work is gated by keys and `--no-index`. Without a watcher (tests that construct `createApp` without one) the endpoint still opens and only sends keep-alives.

### `GET /api/index/status`

`{ enabled: boolean, running: boolean, lastRun: Report | null, pending: { embed, summarize } }`. `enabled: false` with nulls when the indexer is off.

### Client (`apps/web/src/events.ts`, `merge.ts`)

- `EventSource('/api/events')` opened once per app mount; browser reconnects on its own.
- On `vault-changed`: the canvas list is always reloaded; if the current slug is included or a slug is unknown → `fetchCanvas(slug)` and merge. List and canvas are fetched with `Promise.allSettled` so a 404 of the open canvas (deleted in Obsidian) still removes it from the list. One refetch in flight at a time; events during it set a dirty flag → exactly one more refetch afterwards.
- `mergeCanvas(current, fresh, protectedIds): CanvasDto` (pure): nodes keyed by id — a node whose DTO is deep-equal keeps its object identity (React Flow does not remount), changed nodes take the fresh DTO (body, summary, parents, layout, model, topics), new nodes are added, nodes absent from `fresh` are dropped **unless their id is protected**. Protected = the stream ids at fetch **start** ∪ at fetch **end** ∪ ids confirmed by `user-node`/`done` events in the last 5 s (`RECENT_MS`) — a refetch in flight across the assistant's write must not drop the just-written node or its cursor. Kept ghost edges need both endpoints present. Edges otherwise from `fresh`; `repairs` compared by content; the same `current` object is returned when nothing differs.
- After a merge the selection is pruned of ids no longer present (M4's vanished-node guards do this); cursor, targets, exclusions and camera are otherwise untouched; focus is never moved.
- Consequence accepted by the user: a card dragged in Obsidian's canvas moves in the browser (files are the truth). "Existing nodes never move" remains a rule for chatmind's own layout logic.

## 8. Server and CLI

- `createApp` gains `indexer?: Indexer` and `watcher?: VaultWatcher` (the server constructs both in `index.ts`; tests inject fakes or nothing). `POST /api/canvases/:slug/messages` is unchanged.
- `apps/server/src/index.ts`: `--no-index` flag (also `CHATMIND_NO_INDEX=1`). Startup log gains one line: `index: on (summary openai/gpt-5.6-luna, embed openai/text-embedding-3-small/1536)` or `index: off (no OPENROUTER_API_KEY)` / `index: off (--no-index)`. Scratch servers used for probing (CLAUDE.md workflow) run with `--no-index` unless the probe is about the index.
- Shutdown (SIGINT/SIGTERM): stop the watcher, wait for the current reconcile to finish (bounded, 10 s), close the database.
- `chatmind index status [--data-dir]`: opens `index.db` read-only (missing → "no index"), reads the vault, prints per canvas: nodes, embedded, summarized (non-empty summary), pending embed/summary counts, and whether the stored embed model/dim match the defaults. No network. Exit 0 always (it is a report, not a check).

## 9. Testing

- `packages/index` (vitest, `:memory:` SQLite, fake Summarizer/Embedder, temp vaults written with core's writer):
  - fixed point: a second reconcile right after a complete one produces zero jobs;
  - rebuild: delete the db, reconcile → same rows and vectors as before;
  - edited summary preserved: change `summary` in the file, change the body → embed job yes, summary job no;
  - our summary regenerated: body change on a node whose summary equals `summary_written` → new summary;
  - rename exactly once: bare-ULID file gets `{ULID}-{slug}.md` and the canvas path follows; a second summary change never renames again;
  - user-provided summary on a bare-ULID file → rename without an LLM call;
  - vanished node → row and vector removed;
  - writeback guard: the file changes between job creation and the lock turn → nothing written, row stays stale;
  - embed model/dim change → `vec_nodes` recreated, all rows re-embedded;
  - empty body → no jobs, marked done;
  - failures: a rejecting Embedder leaves rows stale, `pending` counts them, a later run with a working Embedder finishes them;
  - a fast-check property: for any vault, `reconcile ∘ reconcile` reports zero jobs on the second run.
- `packages/core`: `renameNodeFile` (path update, canvas rewrite, refusal when the name already carries a slug or the target exists).
- `apps/server`: `/api/events` delivers `vault-changed` when a file under a temp data dir changes (real chokidar, generous timeout) and stays silent for `.app/`; `/api/index/status` shapes; Summarizer post-processing and the short-body shortcut (with a stubbed model); `--no-index` yields `enabled: false`.
- `apps/web`: `mergeCanvas` — identity preserved for unchanged nodes, streaming ghost kept with its edge, vanished node dropped, changed summary applied; `events.ts` coalescing (dirty flag → exactly one extra fetch).
- Manual gate (by the user): delete `index.db`, restart, `chatmind index status` complete; titles appear on cards without reload; files renamed in Obsidian, open file survives the rename; edit a body in Obsidian → browser follows, summary regenerates; edit a summary in Obsidian → stays; drag a card in Obsidian → browser follows; `pnpm cli check` clean afterwards.

## 10. Not in M5

Anything that **reads** the index for a user-facing feature (search, topics — M6, semantic cross-links — M7); compression-style summaries for token-budget overflow; an index indicator in the UI; `.app/config.json`; reattaching to running streams after a reload; embedding anything but the body; a second embedding provider; renaming files whose name already carries a slug; writing `topics`.
