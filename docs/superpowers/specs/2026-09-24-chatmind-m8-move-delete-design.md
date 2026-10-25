# chatmind M8 — move and delete cards

Status: draft for review · 2026-09-24 · follows M7 (the cycle-1 roadmap §13 ends there; this is the first post-roadmap milestone)

## 1. Goal

The user arranges cards on the canvas by hand and removes conversation turns they no longer want. Structure stays intact: moving never touches `parents`; deleting splices the removed turn out of the chain, so what lay below it hangs on what lay above it.

## 2. Decisions (brainstorm 2026-09-24)

| Topic | Decision |
|---|---|
| Move | Cards are draggable in the browser, singly or as a multi-selection. Only the dragged cards move; children stay where they are, edges follow. |
| Delete target | Deleted node files move to `<data-dir>/.trash/` (Obsidian's vault trash convention), never unlinked. |
| Delete unit | A **turn**: the user message plus its assistant answer(s). Deleting either card deletes the whole turn. |
| Reparenting | Every surviving node whose `parents` names a deleted node gets that entry replaced by the deleted node's own (surviving) parents, in place, de-duplicated. |
| Layout | Neither operation moves any other card. Reparented children keep their position; only edges are re-derived. |

## 3. Invariant changes (explicit user override of cycle-1 §3 / §8.2)

- "Nothing else in the vault is ever renamed or deleted" gains a second exception: **the user's explicit delete** moves node files of the deleted turn(s) to `.trash/` and rewrites `parents` of the direct survivors. Nothing else — the reader, the indexer, completions — ever deletes.
- "Existing nodes never move on the canvas" is restated as: *chatmind's layout logic* never moves existing nodes; the user may (as already accepted for Obsidian drags in M5 §5).
- `role: assistant` ⇒ exactly one parent is preserved by construction (§5.2).
- `graph.canvas` stays pure JSON Canvas: a move only changes `x`/`y` of existing file nodes.
- CLAUDE.md's invariant list is updated in the same commit as the delete endpoint.

## 4. Move

### 4.1 Browser (`apps/web`)

- `nodesDraggable` on; message nodes `draggable: true`; the ghost stays non-draggable.
- Gestures (Shift keeps its M4 meaning — merge target toggle):
  - click = cursor (unchanged); drag a card = move that card.
  - **Cmd/Ctrl+click** toggles a card in the *move selection*; **Cmd/Ctrl+drag on the pane** draws a selection box that sets it (React Flow `multiSelectionKeyCode` / `selectionKeyCode` = Meta on macOS, Control elsewhere).
  - Dragging a card that is in the move selection drags the whole move selection (React Flow's built-in behaviour for selected nodes); dragging a card outside it drags only that card.
  - Plain click on the pane or Esc clears the move selection (Esc order: move selection first, then the existing M4/M6 order).
- The move selection is separate from `SelectionState` (cursor/targets/exclusions) and never influences context. React Flow `selected` = the move selection only; the cursor is drawn from `data.cursor` (so dragging the move selection never drags the cursor along).
- Positions are applied locally during the drag (controlled nodes via `onNodesChange`, position changes only); on `onNodeDragStop` the browser sends the final positions of all moved cards once. A streaming card is not draggable: the completion writes the layout it started with on `done`, which would snap it back (changed during implementation).
- On failure the canvas is refetched (files are the truth) and the error line shows the reason.
- Positions are snapped to integers (Obsidian writes integers).

### 4.2 Server

`PATCH /api/canvases/:slug/layout` · body `{ positions: { [id]: { x: number, y: number } } }`

- Inside `lock.run`: `readCanvas`, for each id present in `graph.layout` set `x`/`y` (width/height unchanged), `writeCanvasFile`. Unknown ids are ignored and reported in the response `{ ignored: string[] }`; non-finite numbers → 400.
- No node file is touched. The watcher's `vault-changed` brings other tabs up to date; the originating tab already shows the positions.

### 4.3 Core

`moveNodes(graph, positions): NodeId[]` — pure, mutates `graph.layout`, returns the ids actually moved. Lives in `packages/core/src/layout.ts` (browser-safe; the browser uses it to apply optimistic positions on its DTO copy too).

## 5. Delete

### 5.1 Turn expansion (core, pure)

`turnOf(graph, id): NodeId[]`

- `id` is `role: user` → `[id, ...assistant children of id]` (children by any parent entry, sorted by id).
- `id` is `role: assistant` whose `parents[0]` is a user node → `turnOf(graph, parents[0])`.
- Otherwise (root assistant, dangling parent, assistant under assistant from an Obsidian edit) → `[id]`.

`deleteSet(graph, ids)` = union of `turnOf` over the requested ids.

### 5.2 Splice (core, pure)

`spliceOut(graph, deleted: Set<NodeId>): Map<NodeId, NodeId[]>` returns the new `parents` of every surviving node whose parents change.

- `resolve(p)` = `p` if `p ∉ deleted`, else the concatenation of `resolve(q)` for `q` in `p.parents` (recursive — a chain of several deleted turns collapses to the nearest survivors). Dangling parents stay as they are (structure is never deleted by accident).
- New parents = `n.parents.flatMap(resolve)`, de-duplicated keeping the first occurrence. Order is preserved, so `parents[0]` of a child resolves to the primary parent of the deleted chain.
- Assistant rule: a surviving assistant's parent is a user node; if that user node is deleted, the assistant is in the same turn and deleted too. So no surviving assistant ever changes its parents — asserted in a test (property-based with fast-check over random chat graphs).
- A user node whose only parents were deleted and that had no further ancestors becomes a root (`parents: []`).

### 5.3 Server

`POST /api/canvases/:slug/delete` · body `{ ids: string[] }` · response `{ deleted: string[], reparented: string[] }`

Inside one `lock.run`:

1. `readCanvas`; unknown ids → 404 (nothing happens).
2. `deleteSet`; if any member has a running completion → 409 `"a reply is still streaming"` (the completion would otherwise write an answer under a vanished parent).
3. `spliceOut`; apply the new parents; `writeNode` for each reparented survivor.
4. Move every deleted file to `<data-dir>/.trash/<basename>`; on a name clash Obsidian-style suffix `<name> 1.md`, `<name> 2.md`, …. Remove the ids from `graph.nodes/layout/paths`.
5. `writeCanvasFile` (edges re-derived).

Order matters for crash safety: survivors are rewritten first, then files move, then the canvas. A crash after step 3 leaves children pointing past a still-present turn — a valid graph (the turn is just a dead-end branch). A crash after step 4 leaves canvas entries without files — the reader's existing `orphan-canvas-node` repair.

The indexer notices the vanished files through the watcher and drops their rows on the next sync (M5); summaries/topics of survivors are untouched (`parents` is not part of the content hash — verify in the plan).

### 5.4 Browser

- **Delete / Backspace** on the graph (same focus rules as the existing key handler) deletes the turns of: the move selection if non-empty, otherwise the cursor. A NodePanel button "Delete turn" does the same for the cursor.
- Confirmation: `window.confirm`-style inline dialog naming the count — "Delete 1 turn (2 cards)?" — Enter confirms, Esc cancels. The files go to `.trash/`, so this is the only guard; no in-app undo in M8.
- Before the request, the affected cards are marked (dimmed) so the preview shows exactly what the turn expansion will remove (`deleteSet` from core, same function as the server).
- After success: the canvas is refetched; the cursor moves to the first surviving parent of the first deleted node (`resolve` result), else is cleared; merge targets and exclusions of deleted ids are dropped (the existing vanished-node pruning); the move selection is cleared.

## 6. Out of scope

Undo/restore from `.trash/` in the app · deleting whole canvases · dragging to re-parent · resizing cards · moving a card to another canvas · subtree drag.

## 7. Tests

- Core: `turnOf`, `deleteSet`, `spliceOut` unit tests (middle of a chain, branch point with several children, merge node deleted → child inherits both parents in order, chain of two deleted turns, root turn → child becomes root, dangling parent untouched); fast-check property: after splice, every surviving assistant still has exactly one parent and no parent names a deleted id; `moveNodes`.
- Server: layout PATCH round-trip (only x/y change, canvas order kept, byte-stable otherwise); delete in temp vault: files in `.trash/`, clash suffix, children's frontmatter rewritten, canvas edges re-derived, 404 / 409 paths; reader afterwards reports no repairs.
- Web: drag stop sends one PATCH with all moved cards; Cmd-click selection separate from merge targets; Delete key opens the confirmation with the right count; Esc order.
- Manual gate (user): move cards in the browser → Obsidian shows the same layout; delete a middle turn → chain reconnects in both browser and Obsidian, file in `.trash/`; `pnpm cli check` clean; restart server, positions persist.
