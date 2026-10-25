# chatmind M9 — chat view of the current strand

Status: draft for review · 2026-09-24 · follows M8

## 1. Goal

A second view of the open canvas: the current strand as an ordinary chat transcript, to read a long conversation top to bottom. The canvas stays the place for the overview. Both views share one cursor, one selection and one composer, so switching back and forth loses nothing.

## 2. Decisions (brainstorm 2026-09-24)

| Topic | Decision |
|---|---|
| Strand | Root → cursor along `parents[0]`, then on to a leaf. Below the cursor it follows the branch the user last took there, otherwise the newest child. Every fork shows a switcher `‹ 2/3 ›`. |
| Merges | Before a merge message, each merged-in branch is a labelled block, collapsed by default. |
| Layout | The chat replaces the canvas in the middle pane. Sidebar, composer and panel stay; the panel drops the body (the chat shows it) and keeps meta, topics and Related. |
| Switching | A segmented control `Canvas | Chat` above the middle pane plus the key `V`. The view is part of the URL (`view=chat`). |

No vault, server or API change. Nothing new is written anywhere.

## 3. Strand model (core, browser-safe)

`packages/core/src/strand.ts`, exported from `@chatmind/core/graph`:

```ts
interface StrandItem<N> {
  node: N;
  siblings: NodeId[];        // primary children of node.parents[0] (roots: all roots), sorted by id; length ≥ 1
  merged: ContextSegment<N>[]; // for a merge node: segments[1..] of contextSet(graph, node.parents, []); else []
}
function strandOf<N>(graph: GraphLike<N>, cursor: NodeId, preferred: ReadonlyMap<NodeId, NodeId>): StrandItem<N>[]
function rememberPath(graph: GraphLike, cursor: NodeId, preferred: ReadonlyMap<NodeId, NodeId>): Map<NodeId, NodeId>
```

- **Leaf:** walk down from the cursor. At each node, take `preferred.get(node)` if it is still a primary child (`parents[0] === node`), otherwise the child with the largest id (the newest, since ULIDs sort by time). Stop at a node without primary children; a cycle stops the walk.
- **Strand** = `ancestorChain(graph, leaf)`, the same function the prompt uses, so the chat never shows a different primary chain than the LLM gets.
- **Merge blocks:** for a node with ≥ 2 parents, its primary branch is already inline (it is the chain above). The other branches are the segments 2..n of `contextSet(graph, node.parents, [])`, which is exactly what the prompt put into labelled blocks when the merge was sent. Labels come from `blockLabels`.
- **`rememberPath`:** App calls it on every cursor change. It records `preferred[parent] = child` for each consecutive pair on `ancestorChain(cursor)`. Moving the cursor up the strand (↑, or a click higher up) then keeps the branch you came from below it. The map lives in App state per open canvas (session only, reset on canvas switch).

## 4. Chat view (`apps/web/src/ChatView.tsx`)

### 4.1 Rendering

- A centered column (max ≈ 760px) that scrolls. User messages are right-aligned tinted bubbles; assistant messages are full-width with Markdown (same renderer and image rule as the panel), a small header with model and local time, and the topic dot and colour.
- The cursor message carries an accent bar. Merge targets show their number badge, in-context messages a faint accent edge, excluded ones are struck through and dimmed, cards a pending delete would remove are marked — all from the same `FlowMarks` the canvas uses.
- **Fork switcher:** on a message with `siblings.length > 1`: `‹ i/n ›` in its header. Pressing it moves the cursor to the neighbouring sibling (the strand recomputes from there).
- **Merge block:** `<details>` before the merge message: summary line "Merged branch · {label} · {n} messages"; expanded, its messages render compactly, in order.
- **Streaming:** the growing answer renders live (from `applyStreams`), with the existing "is answering" dots while the body is empty.
- **Branch point hint:** when the cursor is not the last item, a thin divider after the cursor message reads "Replying here starts a new branch".
- **Without a cursor:** the list of the canvas's roots (title, message count of their newest strand); a click sets the cursor.

### 4.2 Interaction

- Click on a message = cursor; Shift-click = merge target toggle (as on the canvas); the context badge toggles exclusion. No move selection in the chat (nothing to move); a move selection made on the canvas persists and Delete still uses it.
- Keys: the existing global handler stays in charge. In chat view, ↑/↓ move the cursor to the previous/next strand item and ←/→ to the previous/next sibling (the canvas meaning of ←/→, so a fork switches). Space, Enter, Delete and Esc behave as on the canvas.
- **Scrolling:** the cursor message is scrolled into view (block `nearest`) whenever the cursor changes by a user action, and centred when the chat view opens. While an answer streams, the view follows the bottom only if it was already at the bottom; any upward scroll stops following (the "camera never jumps" rule of M3 applied to a list).

### 4.3 Switching

- Segmented control `Canvas | Chat` at the top of the middle pane (tab semantics: `role="tablist"`); key `V` toggles when focus is not in an input (same focus rules as the other graph keys).
- Chat → canvas: the camera fits the cursor (a user action, so a camera move is allowed).
- Canvas → chat: the cursor message is centred.
- The view is kept in the URL (`?canvas=…&node=…&view=chat`, `replaceState`, like the cursor); a reload or Back restores it. Default is the canvas.

### 4.4 Panel

In chat view `NodePanel` hides the body; title, meta, topics, delete button and Related stay.

## 5. Out of scope

Editing messages · search in the transcript · per-canvas remembered view · persisting `preferred` · a chat view spanning several canvases · export.

## 6. Tests

- Core: `strandOf` — linear chain; cursor mid-chain continues to the newest leaf; `preferred` wins over newest and is ignored when no longer a child; fork siblings and order; roots as siblings; merge node yields the secondary segments with the primary branch inline; cycle safety. `rememberPath` records every pair on the chain and keeps other entries.
- Web: toggle via control and `V` (not while typing); URL carries `view=chat`; chat shows the strand in order with the cursor marked; fork switcher moves the cursor and the strand; merge block collapsed with the right label; ↑/↓/←/→ in chat; panel hides the body in chat view; roots list without cursor; a send in chat view streams into the transcript.
- Manual gate (user): read a long strand, switch branches at a fork, open a merge block, send from mid-strand and see the new branch, switch views repeatedly — cursor, selection and composer text survive.
