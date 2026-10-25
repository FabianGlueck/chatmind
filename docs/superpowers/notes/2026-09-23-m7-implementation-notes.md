# M7 implementation notes — 2026-09-23

Status for whoever picks this up next (human or agent). Companion to `2026-09-21-m6-implementation-notes.md`.

## Where M7 stands

- Implemented on `main`, commits `6218dfa..eca73e8` (6 commits: core, index, server, cli, web, plus the spec `1092ade`). Typecheck clean, 473 tests green (core 167, index 121, cli 17, server 63, web 105).
- **No plan document.** At the user's request (2026-09-23) M7 went from the approved spec straight to implementation, done inline by one agent, test-first per package, one commit per package. No subagents, no per-task reviews.
- Probed on a scratch vault (`--no-index`, a hand-built `index.db` with 6-dim vectors, port 3299, killed afterwards): `index links --dry-run` and the endpoint agree. A cross-canvas link, one within the canvas, the ancestor/descendant pair left out, a user node resolved to its answer, 404 for an unknown node, 3–16 ms per request. The browser UI was **not** probed in a real browser. It is covered only by jsdom tests, and React Flow draws no edges there, so the dashed edges have never been seen on screen.
- Manual gate on the user's own vault **passed** on 2026-09-24; findings in `docs/superpowers/notes/2026-09-23-m7-gate-findings.md`.

## Spec amendments made during implementation (in the spec file)

- **`canvasTitle` dropped from `LinkDto`.** Canvases have no title besides their slug, so the DTO carries `canvas` (the slug) and the panel shows the slug.
- **The exclusion walk is not `contextSet`'s.** The spec first said "the same walk as `contextSet`", but `ancestorChain`, which `contextSet` is built on, follows `parents[0]` only. `structuralNeighbours` walks **all** parents upwards and all parent edges downwards, as the user decided (merges' secondary parents count as ancestors).
- `web/src/links.ts` also holds `locationFor` / `readLocation` (the query string ↔ `{canvas, node}`); `useLinks` takes a `version` argument (bumped on every vault event).

## Rulings made during implementation (not the user's)

1. `vaultLinks(canvases, allSpace)` lives in `@chatmind/index` (not in the spec's file list), so the server and the dry run share participant selection and the memoised exclusion instead of each building their own. `@chatmind/index` already depends on `@chatmind/core`, so `structuralNeighbours` is imported from there.
2. `LinkService` caches **all** stored vectors centred and normalised once per `data_version`. Per request it only restricts them to the vault's current assistant nodes (a shared view, no copies), because roles and structure come from the files and may change without the index changing.
3. `no-index` answers `from: null`: without the index no reply can be resolved for a user node, so no node is named at all.
4. A user node resolves to its oldest assistant reply **with a vector** (`parents[0] === id`, `created` then id). A reply without a vector is skipped, not reported as `no-vector`.
5. Link edge opacity is `clamp(similarity, 0.35, 1)`, the simplest mapping that keeps weak links visible.
6. `useLinks` keeps the previous answer on screen while a `version` refetch is in flight (no flicker on vault events), but shows nothing for a new cursor until its answer arrives. A failed request shows nothing, no error line.
7. The URL is kept current with `replaceState` on every cursor or canvas change. Only a canvas switch (sidebar, new canvas, Related jump) calls `pushState`, so moving the cursor adds no history entries.

## Deferred minors (none blocks the gate)

- The link request reads the whole vault (`readVault`) per request, like the canvas route. That is fine at today's size, and a vault cache would be its own change.
- `structuralNeighbours` rebuilds its children map per call. With `k + 1` calls per request that is `O(k · canvas size)`, negligible.
- A link edge goes from the bottom handle of `from` to the top handle of the target, so a target above `from` gets a looping bezier. Not tuned.
- The web test `App > semantic links > shows the related list…` failed once in a full parallel `pnpm test` and did not reproduce in six further runs. Its `findBy` timeout is now 3 s (debounce + fetch under load). The cause was not confirmed.
- `index links --dry-run` is O(N²) (`allLinks` computes every node's kNN). That is fine for calibration, but slow above a few thousand answers.

## Defaults in force (`packages/index/src/links.ts`)

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `LINK_K` | `CHATMIND_LINK_K` (1–50) | 5 | neighbours per side, so at most this many links per answer |
| `T_LINK` | `CHATMIND_LINK_MIN` ([−1, 1]) | 0.30 | minimum hub-corrected score (since 2026-09-24; see "Hub correction" below) |

Both values are guesses and have not been calibrated. The scratch probe's 6-dim vectors say nothing about real embeddings.

## Gate checklist for the user (own vault, real key)

1. `pnpm cli index links --dry-run` on your vault. Are the printed pairs really related? Is the number of links per answer useful (totals line)? Try `--min 0.25` / `--min 0.4` and `--k 3` / `--k 8` and pick values. If they differ from the defaults, set `CHATMIND_LINK_K` / `CHATMIND_LINK_MIN` in `~/.config/chatmind/env` and restart `pnpm dev`. The startup line then prints `links: …`.
2. In the browser, select an answer that has links. Do the dashed magenta edges to linked answers in the same canvas appear, and is the "Related" section at the bottom of the panel filled?
3. Arrow keys through a strand: the edges follow the selection without flicker, and nothing lags behind.
4. Select a user message. You see its answer's links, and the edges start at the answer.
5. Click a Related entry in the same canvas. It becomes the selection and the camera moves to it.
6. Click an entry from another canvas. The canvas switches, the node is selected and in view. Browser Back takes you to the old canvas with the old node selected, and Forward takes you back to the jump target.
7. A sidebar canvas switch followed by Back returns to the previous canvas.
8. Reload with `?canvas=…&node=…` in the URL. The node is selected.
9. Send a new message. Once the indexer has embedded the answer, selecting it shows links, without a reload.
10. Check the vault: `git status` or Obsidian shows no change to `graph.canvas` or any frontmatter caused by M7 (links are never written).

## Dev server lifecycle fix (2026-09-24, found during the gate)

- `EADDRINUSE` on 3210 after restarting `pnpm dev`: a server started by `tsx watch` at 17:18:15 on 2026-09-23 (while several server files were edited within a second) had lost its parent (ppid 1). It never got a signal: vault watcher and `index.db` were still open. A plain Ctrl+C and rapid Return-restarts of `tsx watch` did not reproduce it. How `tsx` lost the child is unconfirmed. It is probably the same thing as the M6 gate's "older instance still held the port".
- Fix (`apps/server/src/lifecycle.ts`, `index.ts`):
  - `pnpm dev` passes `--exit-with-parent`, so the server shuts down within ~2 s once it has been reparented.
  - Shutdown releases the port first (including open SSE connections) and exits anyway after 12 s.
  - `EADDRINUSE` prints the holding pid and `kill <pid>` instead of a stack trace.
  - The indexer starts only once the port is bound, so a server that failed to listen never indexes the vault next to the first one.
- Verified on port 3299: SIGKILL on the `tsx` parent → the server exits after 1.8 s; SIGINT with an open `/api/events` stream frees the port in 0.1 s; a second server gets the message with the pid and exits with code 1.

## Hub correction (2026-09-24, found during the gate)

- The user found the links in the homogeneous `hugginface` canvas of little use. Measured on their vault (read-only), then the rule was changed with their approval. The spec §4 amendment has the reasoning and the two rejected alternatives: canvas-mean centring and a z-scored threshold per canvas.
- A link now needs mutual kNN **and** a CSLS score `2·sim − r(a) − r(b) ≥ tMin`, where r = mean similarity to the node's own k nearest. `LinkDto` carries `score` next to the raw `similarity`. The panel, the edge opacity and the dry run's first column show the score.
- Dry run on the user's vault with the defaults: 24 → 11 links. `hugginface` 14 → 2 (the quantisation pairs), `masterarbeit` 4 → 3 (the gold-label pairs, Re-Clustering ↔ Gold-Labels gone), `asdfasfdasfd` keeps its 6 Therme links, and no cross-canvas link survives. The one loss the agent regrets: "HF offers classical ML" ↔ "where to find XGBoost" (score 0.25).
- Caveat: 27 participants. r becomes steadier as the vault grows, so check the threshold again at the gate.
- **Follow-up, same day (`48fa9a8`):** applied across canvases, the correction removed the "Hugging Face for a master thesis" links from `masterarbeit` into `hugginface`, which the user wanted kept. Now only same-canvas pairs are hub-corrected, and cross-canvas pairs use the raw similarity (spec §4, second amendment). Dry run: 14 links. The 3 cross-canvas ones are back (0.40, 0.40, 0.32); within `hugginface` still the 2 quantisation links. In the panel a cross-canvas entry therefore shows its raw similarity, a same-canvas one its corrected score.
