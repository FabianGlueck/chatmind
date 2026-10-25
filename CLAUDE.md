# chatmind — notes for Claude

Non-linear chat over an Obsidian vault. pnpm monorepo: `packages/core` (pure logic + vault reader/writer), `apps/server` (Hono, SSE streaming via the Vercel AI SDK), `apps/web` (Vite + React 19 + @xyflow/react), `apps/cli`. See `README.md` for setup and running.

## Hard invariants (cycle-1 spec §3 — breaking one means a vault migration)

- Files are the truth; anything in SQLite (from M5) is derived and disposable.
- `graph.canvas` stays pure JSON Canvas 1.0 — no custom keys.
- Identity is the ULID in frontmatter, never the filename.
- Frontmatter `parents` is the only source of structure; canvas edges are derived. `parents[0]` drives layout and (M6) the topic prior — never extra structure.
- The reader repairs in memory and reports `Repair[]`; it never writes and never deletes structure. The indexer (M5/M6) writes only `summary` and `topics` into frontmatter — `topics` only when it is empty, `summary` only when it is empty or still its own (the user may type one, M17, via PUT with a `base` check) — and renames a file exactly once, from `{ULID}.md` to `{ULID}-{slug}.md`. It also keeps the topic memories (M15) in `<canvas>/memories/<slug>.md`: it only appends bullets to a memory's body and adds turn ids to its `covered` list (the truth about what is already distilled — never in SQLite); the user's edit (PUT with a `base` check) and a compress (carrying `covered` over to the new turns) are the other writers. Memory files are never renamed or deleted, and the reader does not scan `memories/` for nodes. The only other exceptions are the user's explicit delete (M8) and compress (M11): whole turns move to `<data-dir>/.trash/` (never unlinked); on delete the survivors' `parents` are spliced onto the deleted nodes' parents, on compress the nodes below the run point at the last new answer instead. Nothing else in the vault is ever renamed or deleted — including images in `<canvas>/attachments/` (M13), which are written once with the user node that embeds them (`![[<ULID>.<ext>]]`) and stay even when that node goes.
- Notes (M16, `role: note`) are created without parents and never get an answer of their own. A node's body is rewritten after creation only by the user's edit (PUT with a `base` check) — typed by hand or a model rewrite the user accepted (M17). Nothing else rewrites a body; a model rewrite never writes on its own.
- `role: assistant` ⇒ exactly one parent (delete and compress remove question and answer together, so it holds by construction). chatmind's layout logic never moves existing nodes; only the user does (drag → x/y in `graph.canvas`) — and a compress (M11), which pulls what hung below the compressed run up into the freed space when nothing would overlap.
- API keys never in the data folder or the repo (`~/.config/chatmind/env` or env vars).

## Code rules

- `apps/web` imports runtime code only from `@chatmind/core/graph` (browser-safe entry); the default entry pulls `node:fs`. Type-only imports from `@chatmind/core` are fine.
- `@chatmind/index` has no network dependency; LLM/embedding calls are injected (`Summarizer`, `Embedder`) and implemented in `apps/server/src/index-providers.ts`.
- Browser and server share the same core functions for context assembly (`contextSet`, `buildContext`, `promptTokens`) — never reimplement them on one side.
- UI copy is English; only the merge preamble, role labels, note header, edit header, placeholders (composer and edit mode), badges and over-budget line follow `detectLanguage` (DE/EN).
- Style: compact TypeScript, doc comments that cite the spec section, no ESLint/Prettier. TDD; `pnpm typecheck && pnpm test` before every commit.

## Workflow

- Milestones follow the roadmap in the cycle-1 spec (§13). Each one: brainstorm → spec in `docs/superpowers/specs/` → plan in `docs/superpowers/plans/` → subagent-driven implementation → manual gate by the user → findings in `docs/superpowers/notes/`.
- Work happens directly on `main` (the user's choice); no feature branches unless asked.
- The user writes German; specs, plans, code and commit messages are English.
- To probe the running app, never point at the user's vault: start a scratch server with `--data-dir <scratchpad>/vault --port 3299 --no-index` and, if needed, a Vite instance with a temporary config proxying to it. Kill both afterwards (`kill <pid>`, `pkill -f` has missed them before). The user's own `pnpm dev` runs on :3210/:5173.

## User feedback and feature ideas

`docs/user-feedback/feedback.md` and `docs/user-feedback/feature-ideen.md` are the user's own lists, kept as Markdown checklists (`- [ ]` / `- [x]`).

- When an item is implemented, tick it (`- [x]`) in the same commit or right after, and append a short note: the commit hash, or why no change was needed (e.g. "nicht reproduzierbar").
- Never delete or reword the user's items; only tick them and append notes.
- New ideas the user raises in conversation go into `feature-ideen.md` as unticked items when they ask for it.
