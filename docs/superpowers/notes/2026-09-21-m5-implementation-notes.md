# M5 implementation notes — 2026-09-21

Status for whoever picks this up next (human or agent).

## Where M5 stands

- Implemented on `main`, commits `425080a..65f2855` (25 commits; plan `docs/superpowers/plans/2026-09-18-cycle-5-m5-index.md`, spec `docs/superpowers/specs/2026-09-18-chatmind-m5-index-design.md`). Typecheck clean, 355 tests green (core 159, index 51, cli 5, server 55, web 85).
- The spec was amended after implementation (commit `docs(spec): M5 implementation decisions`) and is authoritative. **The plan's code blocks predate the review fix rounds** — read the code, not the plan, for details.
- Every task had a scoped review; a whole-branch review (Opus) found no Critical issue; its five Important findings were fixed in `bec7001..65f2855` and re-reviewed.
- **Paid dry run done (2026-09-21)** on a 3-node scratch vault with the user's OpenRouter key: summaries generated, files renamed once, embeddings stored; `index.db` deleted → restart → `3 embedded, 3 summarized, pending 0` (rebuild condition met); a blanked summary was regenerated without a second rename. Finding: `openai/gpt-5.6-luna` spent 40 of the 60 output tokens on reasoning and one title came back cut off → `reasoning.effort = 'minimal'` + `maxOutputTokens: 200` (0 reasoning tokens, ~$0.00004 per title). The channel without the index was verified too: a frontmatter edit on disk → `vault-changed` on `/api/events` → the API serves the new summary.
- Manual gate passed 2026-09-21 — see `2026-09-21-m5-gate-findings.md`. M5 is done.

## Deviations from the spec as first written (now folded into the spec)

- Summaries take the first *paragraph*, not the first line (the plan's own test contradicted its code).
- `writeback` re-reads the whole vault under the lock instead of one file (the canvas rewrite after a rename needs every path) — O(N²) only on the first indexing of an existing vault.
- Give-up policy: `MAX_FAILURES = 3` consecutive failures per node (embed and summary share the counter, kept in memory by the `Indexer`) → node skipped until its body changes; `Report.gaveUp`; not pending. Batch embed failures fall back to per-item embedding once.
- Refetch protection in the browser: stream ids at fetch start ∪ end ∪ ids confirmed by `user-node`/`done` in the last 5 s.
- `sync` upserts in one transaction; `PRAGMA synchronous = NORMAL`.
- No rename job when `slug(summary)` is empty; `shortcutSummary` normalises whitespace.

## Rulings made during implementation (controller decisions, not the user's)

1. Default model ids live once in `@chatmind/index` (`defaults.ts`); server and CLI import them.
2. `IndexDb.meta()/vector()` swallow only `no such table|module`; everything else propagates. A corrupt `index.db` (`SQLITE_NOTADB`) therefore surfaces as a logged crash of the first reconcile — the startup line still says `index: on`. Deleting the file fixes it; auto-recreate on corruption is a candidate follow-up.
3. `vanished` writeback skips are not pending; rename-only skips are logged.
4. Shutdown is re-entrant-safe (SIGINT + SIGTERM).
5. `mergeCanvas` compares repairs by content and keeps ghost edges only with both endpoints present; `createRefetcher` tolerates a synchronously throwing `run`.
6. Parked: the rewritten indexer backoff test asserts one doubling (50 → 100 ms) and the reset, not the second doubling — production logic unchanged.
7. Parked: the shared embed/summary failure counter can let one job type's failures give up the other; per-job counters if it ever bites.

## Deferred minors (none blocks the gate)

- Docs/style: `createEmbedder` and `rowsForPlan` lack spec-cite doc comments; the unused `lang` parameter of the server summarizer is undocumented in code; `IndexDb.db` is public (needed by the schema-version test); import ordering in `write.test.ts`.
- Test gaps: exactly-80-char and no-space-long-word summary edges; standalone `isBareUlidPath`; `'1.5'`/negative `CHATMIND_EMBED_DIM`; partial-staleness canvas in `index status`; the skip-path writeback test does not re-read the summary on disk; the watcher test is timing-based (margins widened once).
- Code: 3.5 chars/token re-derived in `summary.ts` (core does not export `CHARS_PER_TOKEN`); `byId.get(id)!` outside `try` in `reconcile` relies on jobs ⊆ entries; `Indexer.close()`'s 10 s bound can race a still-dirty loop (caught + logged); chokidar `ignored` drops only dot-entries, `*.tmp` is filtered in `slugOf`; `slugOf` returns a top-level file's name as a slug (harmless list reload); CLI `index status` does not close the readonly db in a `finally` and does not show `gaveUp`; `truncateFor*` slice by UTF-16 code units; positional equality in `mergeCanvas` misses the identity fast-path on pure reordering (objects still reused); when the open canvas 404s on refetch the stale canvas stays rendered without a notice.
- Known and fine: `index.db-wal`/`index.db-shm` next to the db are SQLite WAL files (we set `journal_mode = WAL`); present while the server holds the db open, checkpointed and removed on a clean shutdown, replayed automatically after a crash. Delete all three together when rebuilding.
- Known and fine: `index.db` is ~6 MB even for a handful of nodes — sqlite-vec's `vec0` preallocates vector storage in chunks of 1024 rows × 1536 × 4 bytes; the file grows by another 6 MB at node 1025. Payload is 6 KB per node. `chunk_size=` on the table would shrink it; deliberately left at the default (user's call, 2026-09-21).
- Accepted consequences: a node behind an `unparseable-node` repair is deleted from the db and re-embedded (paid) once it parses again; every `fetchCanvas` and `writeback` reads the whole vault — a `readCanvas(root, slug)` in core would pay for itself in M6.
