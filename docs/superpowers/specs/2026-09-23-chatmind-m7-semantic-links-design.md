# chatmind M7 — Semantic cross-links

Date: 2026-09-23. Builds on the cycle-1 vault format spec (§3 invariants, §13 M7, §14 traps), the M5 index spec (`index.db`, `vec_nodes`, live channel) and the M6 topics spec (centring, `MIN_CENTER`, user node ↔ oldest reply, env-tunable thresholds, dry run). Brainstormed with the user; decisions below are theirs unless marked as defaults.

## 1. Goal and done condition

M7 shows, for the selected node, the answers that are semantically related to it but not structurally: in the same canvas as dashed edges, and in a "Related" list in the node panel that also reaches into other canvases and jumps there. Links are derived from the M5 embeddings, computed per request and never stored — neither in the vault nor in SQLite.

**Done when**, on the user's own vault: the links are useful to the user (`k` and the threshold calibrated with `chatmind index links --dry-run` first); the dashed edges follow the selection, including arrow-key navigation; a jump into another canvas lands on the node, and the browser's back button returns to where the jump started; `graph.canvas` and all frontmatter stay untouched (a vault round-trip stays byte-identical).

## 2. Decisions

| Topic | Decision |
|---|---|
| Purpose | Both: within a canvas ("these two branches talk about the same thing") and across canvases ("I asked this over there before"). One computation over the whole vault, two presentations. |
| When visible in the canvas | On selection only: the cursor node's same-canvas links as dashed edges. No hover, no always-on edges, no per-topic aggregation. |
| Cross-canvas | A "Related" list in the node panel; clicking an entry in another canvas switches canvas, selects and focuses the node, and pushes a history entry so Back returns. |
| Structural exclusion | A node's whole ancestry and all its descendants (every parent, merges included) — everything that is already in its context or has it in context. Siblings are *not* excluded. |
| Participants | Assistant nodes with a vector only. Selecting a user node shows the links of its oldest assistant reply with a vector. |
| Computation | On demand, per selected node, on the server; brute force over centred in-memory vectors (cycle-1 §13: "computed on the fly below ~10k nodes"). Nothing persisted. |
| Thresholds | `LINK_K = 5`, `T_LINK = 0.30` as defaults (guessed; calibrated at the gate), overridable by `CHATMIND_LINK_K` / `CHATMIND_LINK_MIN` from the environment or `~/.config/chatmind/env`, read identically by the server and the dry run. |

## 3. Packages and files

```
packages/core/src/context.ts          + structuralNeighbours(graph, id) (exported from @chatmind/core/graph)
packages/core/src/dto.ts              + LinksDto, LinkDto
packages/index/src/links.ts           linkSpace, mutualLinks, LINK_K, T_LINK (pure)
packages/index/src/link-settings.ts   linkSettings(env), describeLinkSettings
packages/index/src/db.ts              + dataVersion() (PRAGMA data_version)
apps/server/src/links.ts              LinkService: read-only index.db handle, vector cache, links(slug, id)
apps/server/src/app.ts                GET /api/canvases/:slug/nodes/:id/links
apps/server/src/index.ts              creates the LinkService, logs non-default link settings at startup
apps/cli/src/index-links.ts           chatmind index links --dry-run [--data-dir] [--k] [--min]
apps/web/src/api.ts                   fetchLinks(slug, id, signal)
apps/web/src/links.ts                 useLinks(slug, cursorId, version): debounce, abort, per-canvas cache; locationFor / readLocation
apps/web/src/flow.ts                  toFlowEdges(dto, marks) + link edges
apps/web/src/NodePanel.tsx            "Related" section
apps/web/src/App.tsx                  history: pushState on canvas change, popstate, ?node=, jump from the panel
apps/web/src/styles.css               --link (light + dark), .link-edge, .related list
```

`@chatmind/index` keeps having no network dependency; M7 adds no LLM call at all.

## 4. Link rule (pure, `links.ts`)

**Participants.** Every assistant node in the vault whose vector exists in `vec_nodes`. A stale vector (body changed, not re-embedded yet) is used as stored — it is replaced within the next indexer run.

**Vectors.** `linkSpace(vectors, participants)`: the raw vectors are centred on the mean of *every* stored vector in the vault with M6's `centre()` (no centring below `MIN_CENTER = 8`), then restricted to the participants and normalised, so a similarity is a dot product.

**Exclusion.** `structuralNeighbours(graph, id)` in core: `id` itself, every ancestor over *all* `parents` (unlike `ancestorChain`, which follows `parents[0]` only), and every descendant over all parent edges. Computed within the node's own canvas; nodes of other canvases are never excluded. The exclusion is applied **before** the neighbour search, so ancestors cannot take up `k` places.

**Rule.** `knn(x)` = the `k` participants with the highest similarity to `x` outside `excluded(x)`. `mutualLinks(q, space, excluded, { k, tMin })` returns every `y` with

- `y ∈ knn(q)`, and
- `q ∈ knn(y)`, and
- `score(q, y) ≥ tMin`, where for `q`, `y` **in the same canvas** `score = 2·sim(q, y) − r(q) − r(y)` (`r(x)` = the mean similarity of `x` to its own `knn(x)`), and for `q`, `y` **in different canvases** `score = sim(q, y)`,

sorted by score descending, as `{ id, sim, score }[]`. `excluded` is a function `id → ReadonlySet<id>` so the pure logic never sees the graph. Cost per request: `(k + 1) · N` dot products (the `r` values come from kNN lists the mutuality check computes anyway).

*Amended 2026-09-24 (user: in a homogeneous canvas the links add little).* The first version required `sim(q, y) ≥ tMin`. In the user's `hugginface` canvas nearly everything is about local Hugging Face models, and 12 of its 14 links only said that ("HF offers classical ML" ↔ "new architectures in transformers"). They all hung on two answers that resemble every other one. The score is CSLS (cross-domain similarity local scaling): `r` measures how much a node resembles everything, and a link from such a hub counts for less. The correction is dynamic per node, not per canvas. It was chosen after two alternatives were measured on the user's vault and rejected: centring same-canvas pairs on the canvas mean removed the canvas's dominant theme (quantisation) instead of its generic one, and a z-scored threshold per canvas dropped the good links in a small canvas (11 pairs in `masterarbeit`). With the score, `hugginface` keeps its 2 real links (the repeated quantisation-maths question 0.87, quantisation 0.66) out of 14, `masterarbeit` its 3 gold-label links, and the generic pairs fall to 0.25 and below.

*Amended again 2026-09-24 (user: the Hugging Face answer in `masterarbeit` should still point into `hugginface`).* Applied across canvases, the correction had also removed the only cross-canvas links (0.40 → 0.12 / 0.04), because the `hugginface` answers are hubs within their own canvas. Across canvases, though, the shared theme is exactly the news ("there is a whole canvas about this"). So only same-canvas pairs are hub-corrected; cross-canvas pairs are held to the raw similarity. `LinkSpace.group` (canvas per participant, filled by `vaultLinks`) carries the distinction. Dry run afterwards: `hugginface` 2 links within + 3 into `masterarbeit` (0.40, 0.40, 0.32); nothing else changed.

**Defaults.** `LINK_K = 5` (a node shows at most five links; mutuality usually leaves fewer), `T_LINK = 0.30` (on the score; on the user's vault the gap lies between 0.32 and 0.25). Each constant carries its rationale and the calibration date. `linkSettings(env)`: `CHATMIND_LINK_K` an integer 1–50, `CHATMIND_LINK_MIN` in [−1, 1]; anything unparseable, empty or out of range falls back to the default (as `topicSettings`).

## 5. Server

**`LinkService`** (`apps/server/src/links.ts`), created in `index.ts` independently of the indexer, so links also work with `--no-index` as long as `.app/index.db` exists:

- Opens `.app/index.db` with `IndexDb.openReadonly(file, { vec: true })` lazily on the first request; a missing file → `reason: 'no-index'` (and retried on the next request).
- Caches the centred vectors (`allVectors()` → `centre`) together with `PRAGMA data_version`. On every request it compares `data_version`; only when another connection (the indexer) has committed since does it reload. Cheap per request, no coupling to the indexer.
- Reads the vault per request with `readVault` (as the canvas route does) for roles, structure and summaries.

**Endpoint** `GET /api/canvases/:slug/nodes/:id/links`:

```ts
export interface LinkDto { id: string; canvas: string; summary: string; similarity: number; score: number }   // canvas = slug; similarity = raw cosine, score = §4
export interface LinksDto {
  from: string | null;   // the assistant node the links are computed for (≠ id when a user node was selected)
  links: LinkDto[];
  reason?: 'no-index' | 'no-answer' | 'no-vector';   // why `links` is empty, when it is for a reason other than "none found"
}
```

- Unknown canvas or node → 404.
- User node → `from` = its oldest assistant child (by `created`) with a vector; none → `{ from: null, links: [], reason: 'no-answer' }`.
- Assistant node without a vector → `reason: 'no-vector'`.
- `summary` = the node's frontmatter `summary`, falling back to the body start (M6's `summaryOf`).
- `similarity` and `score` rounded to two decimals.

**CLI** `chatmind index links --dry-run [--data-dir] [--k] [--min]`: opens the vault and `index.db` read-only (as `index topics --dry-run`), resolves settings from env / key file, overridden by the flags, and prints per canvas every link once (`score (cos similarity)  a ↔ b`, both summaries, the other canvas when it differs), then totals: links, participants, participants without a link, links per participant (mean/max). Exit 0 always.

## 6. Browser UI

**Which node.** The links belong to the cursor (`selection.cursorId`). `useLinks` debounces by 150 ms, aborts the superseded request, and caches `(slug, id) → LinksDto` per canvas. A `vault-changed` event for the open canvas clears the cache and refetches for the current cursor, so a freshly embedded answer shows its links without a reload. No cursor → no links.

**Edges.** Links to nodes of the same canvas become extra edges in `toFlowEdges`, passed as marks like the merge ghost edges: from `from` to the target, dashed, thin, bezier, no arrowhead, colour `--link` (light + dark values), opacity rising with the score. The camera does not move for them (cycle-1 §14: no auto-follow). Topic dimming and the merge context highlight are unaffected.

**Panel.** A "Related" section in `NodePanel` below the body. One entry per link, in the DTO's order: the summary (one line, ellipsis), the score small on the right, and the canvas slug below it when the node lives in another canvas. Empty states, muted: "No related answers." (no reason), "Not embedded yet." (`no-vector`), "Index not available." (`no-index`); `no-answer` renders no section.

**Click.** Same canvas → the entry becomes the cursor and the camera focuses it (`focusIds` — a deliberate user action). Other canvas → the current position is written into the current history entry (`replaceState`), then `pushState(?canvas=X&node=ID)`; the canvas switches and, once loaded, the node becomes the cursor and is focused.

**History.** New for every canvas switch, the sidebar included: each switch pushes `?canvas=…` (plus `&node=…` when there is a cursor, kept current with `replaceState`). A `popstate` handler restores canvas and cursor; a node that no longer exists opens only the canvas. The initial load reads `?node=` as well as `?canvas=`.

**Copy.** "Related" and the empty-state lines are English (UI rule); summaries are in the language of the content. No new keyboard shortcuts.

## 7. Testing

TDD per package, as before.

- `@chatmind/core` — `structuralNeighbours`: chain, branch, merge (secondary parents count as ancestors), siblings not excluded, descendants included.
- `@chatmind/index` — `mutualLinks` with hand-built vectors: a one-sided neighbour gives no link; a mutual neighbour below `tMin` gives no link; an ancestor takes no kNN place; cross-canvas neighbours count; order by similarity; `k = 1` yields only mutual best matches. `linkSpace`: centring on/off by `MIN_CENTER`, only assistant participants. `linkSettings`: defaults, valid values, invalid values fall back. `dataVersion` changes after a write through a second connection.
- `apps/server` — the endpoint on a fixture vault with a prepared `index.db`: links across two canvases; a user node redirected to its reply (`from`); `no-index`, `no-vector`, `no-answer`; 404; the cache reloads after another connection wrote.
- `apps/cli` — `index links --dry-run` output on the same fixture, including `--k` and `--min`.
- `apps/web` — `toFlowEdges` with link marks (dashed, from `from`, only same-canvas targets); the panel renders the list and each empty state; a same-canvas click sets the cursor; an other-canvas click pushes history and `popstate` restores canvas and cursor; a superseded response is dropped.

## 8. Not in M7

Showing all links at once; per-topic aggregation of links; links as LLM context; persisting links (SQLite or vault); links between user nodes; an ANN index or sqlite-vec KNN (brute force suffices below ~10k nodes); a threshold slider in the browser; new keyboard shortcuts.
