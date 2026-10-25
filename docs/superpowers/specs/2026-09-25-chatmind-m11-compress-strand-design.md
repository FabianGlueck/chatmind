# chatmind M11 — Compress a strand

Date: 2026-09-25. Builds on M8 (delete: turns, splice, `.trash/`) and M9 (strands). Raised by the user in conversation; decisions below are theirs unless marked as defaults.

## 1. Goal

A long unbranched stretch of a conversation — say 8 turns, 16 cards — can be compressed on request: an LLM rewrites it as fewer turns (at most half as many) that keep the substance, the new cards take the old ones' place, and the originals go to `.trash/`. Purpose: overview on the canvas.

**Done when** in the browser: the panel offers "Compress strand" on a card inside a stretch of ≥ 2 turns and names its size; after confirming, the stretch's cards pulse until the new cards replace them; whatever hung below the stretch now hangs below its last new card; the originals are in `.trash/`; Obsidian shows the new chain; `pnpm cli check` reports nothing.

## 2. Decisions

| Topic | Decision |
|---|---|
| Purpose | Overview on the canvas. The prompt context changes as a consequence (it is built from the files), but saving tokens is not the goal. |
| Originals | Replaced for good: the files move to `<data-dir>/.trash/` exactly as in an M8 delete (user, 2026-09-25: the no-delete rule "no longer holds; I think it is wrong"). |
| Trigger | On request only — a panel button for the cursor's stretch, with a confirmation. |
| Ratio | The LLM decides how to group, at most `floor(n/2)` new turns for `n` old ones, at least 1. Each new turn covers a contiguous run of old turns; together they cover all of them in order. |
| Model | The model selected in the composer (the user's choice of quality/cost is already there). |
| Stretch | The maximal unbranched run of turns through the cursor's turn, see §3. |
| New nodes | Per new turn a `user` node (a condensed question) and an `assistant` node (a condensed answer, `model` = the compressing model). `created` = the `created` of the first covered question / answer, and the ULID is generated from that time, so sibling order (ULID order) and chronology stay. `summary` empty (the indexer writes it); `topics` = the most frequent `topics[0]` among the covered cards (ties: the first), so topic colours do not churn. |
| Layout | The new cards take the positions (and sizes) of the first old cards in order; later old slots become free. Nothing else moves. |
| Structure | The first new question takes the old first question's `parents`. Every node that named the old last answer in its `parents` names the last new answer instead, in place. By construction (§3) no other node refers into the stretch. |
| Frontmatter | Unchanged format — no provenance key. |

## 3. The stretch (core, pure)

`compressRun(graph, id): NodeId[][]` — turns `[[u1, a1], [u2, a2], …]` in order, or `[]`.

A *simple turn* is a `user` node `u` with exactly one node naming it in `parents` (anywhere), which is an `assistant` `a` with `parents = [u]`. Starting from the turn of `id` (`turnOf`), the run extends
- **up** while the current first question `u` has `parents = [p]`, `p` is the answer of a simple turn, and nothing but `u` names `p`;
- **down** while the current last answer `a` is named by exactly one node `u'`, `u'` has `parents = [a]`, and `u'` starts a simple turn.

So inside the run every card has exactly one parent and one child; only the first question's parents (possibly a merge) and the last answer's children are open. A run of fewer than 2 turns is not compressible; a card that is not in a simple turn yields `[]`. A streaming card blocks (server: 409, browser: no button).

## 4. The LLM step

`compressPrompt(turns)` in core (pure): system prompt + the turns numbered `1…n` with question and answer. The model returns JSON only:

```json
{ "turns": [ { "covers": [1, 3], "question": "…", "answer": "…" }, … ] }
```

`parseCompression(text, n)` (pure) strips a code fence, parses, and validates: 1 ≤ length ≤ `floor(n/2)`; `covers` are `[from, to]` integers, contiguous from 1 to `n` without gaps or overlaps; non-empty strings. Anything else is an error ("the model returned an invalid compression: …") and nothing is written. Answers keep the conversation's language and Markdown; each new answer states what the covered answers established, dropping repetition and dead ends.

## 5. Server

`POST /api/canvases/:slug/compress` · body `{ id, model }` · response `{ removed: string[], added: string[], replacement: Record<string, string> }` (old id → new id covering it).

1. Under the lock: `readCanvas`, `compressRun`; unknown id → 404; run < 2 turns → 400; a card of the run streaming → 409. Snapshot the run (ids and bodies). Release the lock.
2. LLM call (`generateText`, generous output budget) and `parseCompression`; failure → 502 with the reason.
3. Under the lock again: re-read; if the run through `id` is no longer the snapshot (ids or bodies changed) → 409 "the strand changed meanwhile". Otherwise `planCompression` (core, pure: new nodes, layouts, reparenting) and `replaceNodes` (core vault): write the new node files, rewrite the reparented nodes, move the old files to `.trash/`, write the canvas — in that order, so a crash leaves a valid graph (a dead-end duplicate branch or orphan canvas entries the reader repairs).

## 6. Browser

- NodePanel: a "Compress strand" button next to "Delete turn" when `compressRun` of the cursor has ≥ 2 turns and nothing in it streams.
- Confirmation in the same inline dialog style as delete: "Compress 8 turns (16 cards) with <model>? The originals go to `.trash/`." Enter confirms, Esc cancels. The run's cards are marked (outline) while the dialog is open.
- While the request runs the run's cards pulse (`compressing`); the composer stays usable elsewhere.
- Afterwards: refetch; the cursor moves to the new card that covers the old cursor (`replacement`); targets/exclusions of vanished ids are dropped. Errors appear in the composer error line.

## 7. Invariant changes

CLAUDE.md: the user's explicit compress joins the explicit delete as the operations that remove node files (to `.trash/`) and rewrite other nodes' `parents`.

## 8. Tests

- Core: `compressRun` (middle of a chain, stops at forks above and below, merge node on top, secondary reference into the run stops it, regenerated answer = not simple, single turn → `[]`); `parseCompression` (valid, fenced, too many turns, gap, overlap, wrong order, empty strings, garbage); `planCompression` (parents, reparenting of children and of a secondary reference to the last answer, positions, created/ULID time, topics majority); `replaceNodes` in a temp vault (files, trash, canvas, reader clean).
- Server: compress with a mock model (happy path, invalid JSON → 502 and nothing written, run too short → 400, unknown id → 404).
- Web: panel button visibility; dialog confirm calls the API and moves the cursor.

## 9. Amendment 2026-09-25: branches (user: "path 1 with path 2 as a checkbox")

The dialog offers **This strand** (§3) or **Everything below**: every unbranched run in the subtree below the cursor's turn (primary descendants, the run through the cursor clipped at its turn), compressed in **one** LLM call that sees all of them, so later sections do not repeat earlier ones. Branch structure stays: each section becomes shorter, forks remain forks.

- `compressionSections(graph, id, mode, fold)` (core, pure) returns `Section { turns, folds }[]`, parents before children, only sections with ≥ 2 turns or with folds. The browser uses it for the dialog counts and the marks, the server for the request.
- **Fold short dead-end branches** (checkbox, subtree only): a section of at most `FOLD_MAX_TURNS = 2` turns whose last answer has no children and whose first question hangs off the last answer of another section is folded into that section — its substance goes into the answer of the group covering that section's last turn, its cards go to `.trash/`, and its ids map to that answer (`replacement`). At every fork one branch stays: if all children are such dead ends, the longest (newest on a tie) is kept.
- Prompt: sections numbered with their limit, "continues after section k" where a section hangs off another one's end, side branches listed after the last turn. Reply `{"sections":[{"section":1,"turns":[…]}]}`, every section in order, each validated as in §4.
- Rewiring: every surviving `parents` entry naming a replaced node points at its replacement (a section's first question at the new end of the section above it).

## 10. Amendment 2026-09-25: pull-up (user: "nachrutschen ist gut")

After a compress, what hung below a section moves up by the height the section lost (old last answer's bottom − new last answer's bottom), cumulatively through nested sections; the new cards of a lower section rise with it. Only primary descendants move (a merge hanging off the section by a secondary parent stays). All or nothing: if any card would then overlap another, nothing is pulled up and the new cards keep the old slots. The moves are written to `graph.canvas` with the rest of the compress. CLAUDE.md: the layout invariant gains this exception.

## 11. Amendment 2026-09-25: compress what is chosen (user: "I'd expect everything marked 'in context' to be compressed … manual multi-selection should work too")

The unbranched-run rule of §3 surprised the user: on the bottom card of a long chain with forks above, only the last run was offered. The unit is now **a set of cards**, from one of three sources in the dialog:

- **In context** (default): exactly the cards marked "in context" (the context set of the targets, minus exclusions) — for a single cursor the chain root → cursor, straight through forks.
- **Selected cards**: the ⌘-selection (M8); preferred when one exists.
- **Everything below**: the cursor's turn and its primary descendants (§9), with the fold checkbox.

`compressionSections(graph, ids, fold)` (core, pure) turns the set into sections: every chosen card contributes its turn (a question takes the chosen answer, else its first; an answer takes its question; unanswered questions and parentless answers are skipped); a turn continues the one whose answer is its question's only parent, unless several chosen turns continue that answer (then each starts a section); a merge question starts a section. Sections with < 2 turns and no folds are dropped. Side branches that are not chosen stay and hang off the replacement of their old parent afterwards; with §10 they rise by as much as that replacement sits higher than the old parent. The server takes `{ ids, model, fold }`; `compressRun`/§3's modes are gone.
