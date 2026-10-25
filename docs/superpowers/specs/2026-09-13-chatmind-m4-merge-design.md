# chatmind — M4: Merge Design

Status: approved in brainstorming, 2026-09-13
Builds on: cycle-1 spec (invariants §3, formats §8, reader/writer §9–§10, milestones §13), M2 spec (server, DTO, frontend), M3 spec (send endpoint, completion, layout rule, keyboard model). This document adds only what M4 needs.

## 1. Goal and use case

Several nodes can be selected as the targets of one message; the model answers with all of their branches in context. Merge is primarily **context assembly**, not a comparison of parallel answer versions: the typical case is one branch holding the outline of a thesis, another holding a content brainstorm, and the user asking for a structure proposal that draws on both. The branches are therefore usually independent threads in the same canvas, not siblings with a deep common prefix. Assembling context from three or four branches is expected to be the normal case, so the token meter is a central control, not an overflow guard for a corner case.

Done when (cycle-1 spec §13 M4, refined): a merge of two branches with complementary content (structure + content) produces a usable proposal that recognisably draws on both branches; the multi-parent structure survives a vault round-trip and renders correctly in Obsidian. Verified manually by the user.

## 2. Decisions

| Question | Decision |
|---|---|
| What a merge is | The **user node** carries `parents: [target1, target2, …]` in selection order; the assistant node stays a normal single child of the user node. Merge is not a separate construct but the same send operation with n targets instead of one. |
| Invariant | `role: assistant` ⇒ `parents.length === 1`. Multi-parent exists only on user nodes. The reader reports violations (`assistant-parents` repair) and never modifies structure. |
| `parents[0]` | Layout only (primary parent, cycle-1 §7). The context builder treats all parents symmetrically; their order only determines block order in the prompt and is therefore user-controlled (selection order). |
| What enters the prompt | Selected targets plus their ancestors from the lowest common ancestor down, the common prefix root→LCA once. Every node entering the prompt is highlighted on the canvas. |
| Deselecting ancestors | Highlighted ancestors are individually excludable; the meter updates immediately. No mode, no setting. Rationale: a branch of fifteen exploratory messages ending in an outline — the user wants the outline, not the exploration. |
| Selectability | A node that is an ancestor of a selected target cannot itself become a target. The first-selected target is visibly marked (it determines layout and block order). |
| Composer | Placeholder, never prefilled ("Was soll aus diesen Zweigen entstehen?" / "What should come out of these branches?"). Send disabled when empty. |
| Context strategy | One strategy: common prefix as normal turns, then **one** user turn containing a preamble, labelled blocks (one per target, in selection order), and the user's instruction last. |
| Preamble location | In the user turn, not the system prompt: the merge message stays in the history and is rebuilt from the ancestor chain on later turns; with the preamble inside the turn, its framing replicates automatically without special handling. |
| Preamble content | Deliberately no output format ("synthesise", "compare", "name contradictions"). The user's instruction decides. |
| Block labels | From the target node's `summary`; fallback `nodeTitle(body)` (same title the card shows), then "Zweig n" / "Branch n". Makes the answer navigable: "as fixed under *Gliederungsstruktur*" can be found on the canvas. |
| Language | Preamble, role prefixes, fallback labels and composer placeholder in German or English, chosen by a stopword heuristic over the instruction plus all bodies in the set. |
| Token budget | Counts the **rendered prompt** of the deduplicated set (what is actually sent), estimated by a heuristic. Over budget: send blocked, user deselects nodes. No automatic compression in M4 (summaries arrive in M5). |
| API | `parentIds: string[]` + `excludedIds?: string[]` replace `parentId`. No legacy field; the single client changes in the same commit. |
| Shared logic | `contextSet`/`buildContext`/`estimateTokens` live in core behind a browser-safe entry `@chatmind/core/graph`; the browser (highlight, meter) and the server (prompt) call the same functions. |

## 3. Packages and files

```
packages/core/
  package.json              # + "exports": { ".": ./src/index.ts, "./graph": ./src/graph.ts }
  src/graph.ts              # browser-safe re-exports: layout, context, tokens, title, dto types — nothing importing node:*
  src/title.ts              # nodeTitle() (moved from apps/web/src/flow.ts)
  src/context.ts            # contextSet, validateTargets, buildContext, blockLabels, PREAMBLE, ROLE_LABELS
  src/language.ts           # detectLanguage
  src/tokens.ts             # estimateTokens, promptTokens
  src/types.ts              # + Repair 'assistant-parents'
  src/vault/read.ts         # + assistant-parents check
apps/server/src/
  models.ts                 # + contextTokens per model
  app.ts                    # POST …/messages takes parentIds/excludedIds; GET /api/models exposes contextTokens
apps/web/src/
  selection.ts              # SelectionState, effectiveTargets, toggleParticipation, clearSelection
  flow.ts                   # + targetIndex/inContext/excluded/cursor flags, ghost node, edge styles
  MessageNode.tsx           # + target badge, context badge (clickable), excluded dimming
  GhostNode.tsx             # dashed "Merge · n branches" card
  GraphView.tsx             # shift-click, badge click, ghost node type
  Composer.tsx              # merging chip, placeholder by language, token meter
  App.tsx                   # cursor/targets/excluded state, Space/Esc, send with parentIds
```

## 4. Core

### 4.1 Browser-safe entry

`@chatmind/core/graph` re-exports only pure modules (`layout`, `context`, `tokens`, `title`, `ids` helpers that do not touch the filesystem, DTO types). The default entry stays as it is for server and CLI. `apps/web` imports runtime code only from `/graph`.

The graph functions take a minimal structural view so the browser can call them on a `CanvasDto` without building a `CanvasGraph`:

```ts
interface GraphLike { nodes: ReadonlyMap<NodeId, Pick<MessageNode, 'id' | 'role' | 'parents' | 'body' | 'summary'>>; layout: ReadonlyMap<NodeId, Layout> }
function graphLikeFromDto(dto: CanvasDto): GraphLike
```

`layout` is there for `placeChild` — the ghost merge node's position is computed in the browser the same way the server computes a real child's. `CanvasGraph` satisfies `GraphLike` structurally, so the server passes its graph directly.

### 4.2 `contextSet(graph, targets, excluded): ContextSet`

```ts
interface ContextSet {
  prefix: MessageNode[];                              // root → LCA, in order (empty when no common root)
  segments: { target: MessageNode; nodes: MessageNode[] }[];   // one per target, in target order; each chain minus prefix
  all: Set<NodeId>;                                   // prefix ∪ all segment nodes — the highlight set
  excluded: Set<NodeId>;                              // excluded ∩ all
}
```

1. For each target: `ancestorChain(graph, target)` (root → target along `parents[0]`, as in M3).
2. Common prefix = the longest run of positionally identical ids from the root across all chains. With one target this is the whole chain; with no common root it is empty.
3. Segment per target = its chain minus the common prefix, one entry per known target in target order. With one target the segment's node list is empty (the whole chain is the prefix); with ≥2 valid targets every segment is non-empty because targets are never ancestors of one another.
4. `all` and `excluded` as above. `excluded` never removes nodes from `prefix`/`segments` in the returned structure — consumers filter with it, so highlighting can show excluded nodes dimmed rather than absent.

### 4.3 `validateTargets(graph, targets, excluded): string | null`

Returns an error message or `null`. Rules: every id is a node; no duplicates; no target is an ancestor (via `ancestorChain`) of another target; `excluded ⊆ contextSet(...).all`; `excluded ∩ targets = ∅`. Used by the server (400) and by the web selection logic (to refuse making an ancestor a target).

### 4.4 `buildContext(graph, targets, excluded, instruction): { system, messages }`

- `system`: unchanged M3 text (`SYSTEM_PROMPT`).
- `messages`: `prefix` minus excluded as alternating `user`/`assistant` turns (M3 mapping), followed by one final `user` turn:
  - **One target**: the turn is exactly `instruction`. The whole output is byte-identical to the M3 `buildContext` + appended user message (regression-tested).
  - **≥2 targets**: the turn is

    ```
    <preamble>

    ## <label of target 1>
    **<Role>:** <body of first non-excluded segment node>

    **<Role>:** <body of next segment node>
    …

    ## <label of target 2>
    …

    <instruction>
    ```

    Blocks appear in target order. Within a block, segment nodes appear root-side first, each as `**<Role>:** ` + body, separated by a blank line; excluded nodes are skipped. With three or more targets a node can be an ancestor of *some* targets without being in the common prefix; such a node renders once, in the first block that reaches it, and is skipped in later blocks — every node of the set appears exactly once in the prompt. Role labels: DE `Nutzer`/`Assistent`, EN `User`/`Assistant`.
- `targets.length === 0` (new root message): `messages = [{ role: 'user', content: instruction }]`.

**Labels**: `summary` if non-empty, else `nodeTitle(body)`, else `Zweig n` / `Branch n` (n = 1-based target position). Newlines are collapsed to spaces. If two targets produce the same label, later ones get ` (2)`, ` (3)`, …

**Preamble** (`PREAMBLE.de`, `PREAMBLE.en`):

DE:
> Die folgenden Abschnitte stammen aus verschiedenen Zweigen desselben Gesprächs. Sie wurden unabhängig voneinander erkundet und sind keine aufeinanderfolgenden Nachrichten. Nutze sie gemeinsam als Grundlage für die Aufgabe darunter und ziehe aus jedem heran, was dafür relevant ist. Du kannst die Abschnitte über ihre Überschriften referenzieren.

EN:
> The following sections come from different branches of the same conversation. They were explored independently and are not consecutive messages. Use them together as the basis for the task below, drawing on whatever is relevant from each. You can refer to the sections by their headings.

### 4.5 `detectLanguage(texts: string[]): 'de' | 'en'`

Counts whole-word, case-insensitive hits of a small German stopword list (der, die, das, und, nicht, ist, ein, eine, ich, mit, für, auf, zu, den, dem, sich, auch, wie, aber, oder) and an English one (the, and, is, of, to, that, it, for, with, as, on, this, are, be, not, by, from, or — deliberately without `in` and `an`, which are everyday German words too) over all texts joined. German when German hits > English hits; English otherwise (including ties and empty input). Inputs for the merge: the instruction plus the bodies of all non-excluded nodes in the set; the composer placeholder uses the bodies only (there is no instruction yet).

### 4.6 Tokens

- `estimateTokens(text) = Math.ceil(text.length / 3.5)`. A heuristic: Claude, OpenAI and Gemini tokenise differently, so an exact tokenizer for one provider is still an estimate for the others and would cost ~2 MB of browser bundle. German text tokenises more densely than English, hence 3.5 rather than 4. The UI shows the value with a `~`.
- `promptTokens({ system, messages })` = `estimateTokens(system)` + Σ `estimateTokens(content)` + 4 per message (turn overhead).
- Budget = `contextTokens` of the chosen model − `OUTPUT_RESERVE` (16 000). Both the meter and the send gate use this budget.

### 4.7 Reader

`readVault` emits `{ kind: 'assistant-parents'; id: NodeId; count: number }` for every `role: assistant` node whose `parents.length !== 1`. The node and its `parents` stay as read (structure is never deleted); layout and chains follow `parents[0]` regardless. `repairsForCanvas` needs no change (the repair carries `id`).

## 5. API and server

### `POST /api/canvases/:slug/messages`

```ts
{ parentIds: string[]; excludedIds?: string[]; content: string; model: string }
```

`parentIds: []` = new root message. `excludedIds` defaults to `[]`.

Validation (400) in addition to M3's: `parentIds` must be an array of strings, `excludedIds` an array of strings if present; `validateTargets(graph, parentIds, excludedIds)` must return `null`. Runs inside the same lock turn that today validates `parentId`.

Then as in M3: user node with `parents: parentIds`, `placeChild(graph, parentIds[0] ?? null)`, `buildContext(graph, parentIds, excludedIds, content)`, `startCompletion`. The SSE events are unchanged; `user-node` now carries several `parents` and the client derives one edge per parent.

### `GET /api/models`

`ModelDto` gains `contextTokens: number`. Values are recorded per model in `models.ts` with a dated comment, like the model ids.

No token endpoint: the meter runs in the browser with the same core functions.

## 6. Frontend

### 6.1 Selection state (`selection.ts`, pure, tested)

```ts
interface SelectionState { cursorId: string | null; targets: string[]; excluded: string[] }
function effectiveTargets(s): string[]            // targets.length > 0 ? targets : cursorId ? [cursorId] : []
function toggleParticipation(graph, s, id): SelectionState
function clearSelection(): SelectionState
```

`toggleParticipation` is the single "Space" semantics:

| `id` is … | result |
|---|---|
| a target | removed from `targets` |
| in `all` of the current set but not a target, not excluded | added to `excluded` |
| in `excluded` | removed from `excluded` |
| a descendant of an existing target (that target would become its ancestor) | no change |
| anything else | appended to `targets` |

Ancestors of a target are always in `all` (they lie on its primary chain), so they can only be excluded, never made targets — the second row covers the "not selectable" rule from §2. After every change, `excluded` is intersected with the new set's `all` (dropping exclusions that no longer apply). Removing the last explicit target clears `excluded` entirely — exclusions exist only together with explicit targets, so moving the implicit cursor target can never leave stale ones behind. Ancestor checks and `all` come from `contextSet`/`validateTargets` in core. When `targets` is empty the cursor acts as the implicit single target, so the M3 behaviour is unchanged until the user presses Space.

### 6.2 Input model

| Action | Keyboard | Mouse |
|---|---|---|
| Move cursor / read a node | ↑↓←→ (as M3, `nextSelection` moves the cursor) | click on a card |
| Toggle a node as target | `Space` | ⇧-click on a card |
| Exclude / re-include a highlighted ancestor | `Space` on it | click its context badge |
| Reset everything | `Esc` (targets, excluded, cursor) | click on the empty pane |
| Into the composer | `Enter` | — |

Keyboard scoping rules from M3 apply unchanged (window listener, ignored inside inputs/textareas/buttons). Moving the cursor never changes `targets` or `excluded`.

### 6.3 Rendering

`MessageNodeData` gains `cursor?: boolean`, `targetIndex?: number` (1-based), `inContext?: boolean`, `excluded?: boolean`. `MessageNode.tsx`:

- cursor → the existing `selected` frame;
- target → numbered badge ①②③ (the prompt order);
- in context (and not a target) → tinted border plus a small badge "im Kontext" / "in context" that is a button (toggle exclusion); targets carry the number badge instead;
- excluded → card dimmed, badge struck through (still clickable to re-include).

Highlight flags are computed once per selection change in `App.tsx` (`useMemo` over `contextSet`) and passed through `toFlowNodes`.

**Ghost node**: when `effectiveTargets.length ≥ 2`, `toFlowNodes` appends a node of type `ghost` at `placeChild(graph, targets[0])` (same core function the server will use, so the real user node takes the same slot after sending). Dashed card, text "Merge · n Zweige" / "Merge · n branches", not selectable, not draggable. One edge from every target to the ghost. It disappears when the selection is cleared (which happens on send).

**Edges** (`toFlowEdges`): an edge whose target's `parents[0]` is the source is the primary edge — `smoothstep`, solid, as today. Every other edge (secondary parent) is `default` (bezier), dashed, lighter. Applies to real nodes and the ghost alike.

### 6.4 Composer

- Target chip: one target → "Replying to: ‹title›" (M3); none → "New root message"; ≥2 → "Merging: ‹title 1›, ‹title 2›, ‹title 3›" with "+n" beyond three.
- Placeholder in merge mode: "Was soll aus diesen Zweigen entstehen?" / "What should come out of these branches?" by `detectLanguage` over the set's bodies. Otherwise the M3 placeholder.
- **Token meter** (always visible when a canvas is open): `~12.4k / 184k` and a bar. Computed from `promptTokens(buildContext(graph, effectiveTargets, excluded, text))` against the chosen model's budget, recomputed on every selection, model or text change. ≥80 % amber; >100 % red with the line "Über Budget — Nodes abwählen (Space auf einem hervorgehobenen Node)" / EN equivalent, and Send disabled.
- Send disabled when the text is empty, when over budget, while sending, or without a provider (M3).
- Send request: `{ parentIds: effectiveTargets, excludedIds: excluded, content, model }`. On acceptance: `clearSelection()`; on `assistant-start` the cursor moves to the assistant node and the camera fits user + assistant (M3 behaviour). On failure before acceptance the selection and text stay.

### 6.5 Panel

Unchanged: shows the cursor node.

## 7. Layout

`placeChild` is unchanged: the child lands under `parents[0]`, the collision scan applies, existing nodes never move. Secondary parents do not influence position — in the target use case they usually sit in other columns, and the dashed bezier edge bridges the distance. In Obsidian all edges look the same (JSON Canvas has no edge style without custom keys; invariant 3.2). Accepted.

## 8. Testing

**Core** (`context.test.ts`, `tokens.test.ts`, `read.test.ts`):
- `contextSet`: one target → whole chain as prefix, no segments; two siblings → prefix up to the parent, one-node segments; two targets without a common root → empty prefix; deep branches → segments from the LCA; exclusions inside prefix and inside segments stay in the structure and appear in `excluded`.
- `validateTargets`: ancestor as target, unknown id, duplicate, `excluded` outside the set, `excluded` overlapping targets.
- `buildContext`: one target is byte-identical to the M3 output with the instruction appended (regression); two targets → exactly one user turn after the prefix, preamble first, `##` labels in target order, role prefixes, instruction last; excluded nodes absent; label fallback chain and collision suffix; DE/EN switching of preamble, roles and fallback labels; zero targets.
- Property (fast-check): for random trees and valid target/excluded sets, no node body appears twice in the rendered prompt, and every non-excluded node of `all` appears exactly once.
- `detectLanguage` (German, English, empty, tie → en); `estimateTokens`/`promptTokens`.
- Reader: assistant with two parents → `assistant-parents` repair, node unchanged.

**Server** (`app.test.ts`): two `parentIds` → user node file has both parents, canvas has both edges, the mock model receives the block prompt; `[]` → root; 400 for ancestor-as-target, unknown id, `excludedIds` outside the set, non-array `parentIds`; `GET /api/models` includes `contextTokens`.

**Web**: `selection.test.ts` (each row of the toggle table, exclusion pruning after target changes, `effectiveTargets`); `flow.test.ts` (badges/flags, ghost node position and edges, primary vs secondary edge style); `App.test.tsx`: Space on two nodes → ghost visible, composer says "Merging", meter shows a value, send posts `parentIds`/`excludedIds`; a model with a tiny `contextTokens` → over budget, Send disabled; Esc clears everything; arrows move the cursor without losing targets.

**Manual gate** (§1): in the `masterarbeit` canvas, merge two independent branches (structure + content), use ancestor exclusion, confirm the answer draws on both and references the labels; then `pnpm cli check` is clean, Obsidian shows the user node with two incoming edges, and a further reply under the merge assistant works normally. Findings go to `docs/superpowers/notes/`.

## 9. Not in M4

Automatic summary compression on overflow (M5, once summaries exist and can be cached), reordering targets after selection (deselect and reselect instead), a prompt preview in the UI, persisting the selection across reloads, exact per-provider tokenizers, edge styles in Obsidian, editing or deleting nodes.
