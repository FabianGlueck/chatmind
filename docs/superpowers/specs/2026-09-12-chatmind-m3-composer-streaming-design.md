# chatmind — M3: Composer, Branching, Streaming Design

Status: approved in brainstorming, 2026-09-12
Builds on: cycle-1 spec (invariants §3, formats §8, reader/writer §9–§10) and the M2 spec (server, DTO, frontend). This document adds only what M3 needs.

## 1. Goal

The app becomes usable: the user writes a message targeting any node, the chosen model streams an answer into a new child node, replies to a node with children visibly branch, and the whole thing survives a vault round-trip and renders in Obsidian.

Done when (cycle-1 spec §13 M3): a full branching conversation can be held without touching the mouse, and the resulting vault opens correctly in Obsidian — verified manually by the user.

## 2. Decisions

| Question | Decision |
|---|---|
| LLM client | Vercel AI SDK (`ai` 7 + `@ai-sdk/anthropic` + `@ai-sdk/openai` + `@openrouter/ai-sdk-provider`), `streamText()`. No provider-specific SDKs. Test doubles from `ai/test` (the mock language model class of the installed major). |
| Models | Fixed list in `apps/server/src/models.ts`, three providers: **anthropic** `claude-opus-5` ("Claude Opus 5", strong, default) and `claude-sonnet-5` ("Claude Sonnet 5", fast); **openai**: the current strong and fast chat models as listed by the OpenAI Models API at implementation time, recorded with the verification date in a comment; **openrouter**: `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, plus one OpenAI and one Google model in OpenRouter's namespace (ids verified against `https://openrouter.ai/api/v1/models` at implementation time, dated comment). Anthropic-direct requests use adaptive thinking (the provider default); no effort/thinking UI in M3. |
| Multi-model | One model per send. Multi-model branching = reply to the same parent with another model. |
| API keys | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` from the environment; if unset, from `~/.config/chatmind/env` (`KEY=VALUE` lines, `#` comments). Never in the data dir, never in the repo. The server logs which providers are available at start. |
| New canvas | Sidebar button "New canvas" → name → `slug(name)` → empty canvas folder + empty `graph.canvas`. |
| Send transport | `POST /api/canvases/:slug/messages` answers with an SSE stream (`text/event-stream`). Client reads it via `fetch` + `ReadableStream` (POST, so no `EventSource`). |
| Write policy | User node written immediately. Assistant node buffered in memory, written once on completion (or on error with partial text). Completion runs to the end even if the client disconnects. All vault writes in the server go through one promise-chain mutex. |
| Layout | Deterministic; existing nodes never move. See §5. |
| Camera | Pans once after the user's own send so the new user node and the streaming child are visible; never auto-follows otherwise. |
| Keyboard | Graph: ↑ parent, ↓ first child, ←/→ previous/next sibling, Enter → composer, Esc → deselect. Composer: Enter sends, Shift+Enter inserts a newline (Cmd/Ctrl+Enter also sends), Esc → graph. |
| Context strategy | Ancestor chain root→parent as alternating `user`/`assistant` messages plus a short fixed system prompt. One strategy, no options. |
| Summaries | Not generated in M3 (`summary: ''`, bare-ULID filenames; M5 fills and may rename once). |

## 3. Packages and files

```
packages/core/src/
  layout.ts                 # + placeChild(graph, parentId): Layout  (§5)
  context.ts                # buildContext(graph, parentId): { system, messages }  (§6)
  vault/write.ts            # + writeNode(graph, id, root), writeCanvasFile(graph, root)
apps/server/src/
  models.ts                 # MODELS: { id, provider, label }[]; isAvailable(provider)
  keys.ts                   # loadKeys(): { anthropic?: string; openai?: string; openrouter?: string }
  providers.ts              # languageModel(modelId, keys) → LanguageModel (AI SDK)
  vault-lock.ts             # withVaultLock(fn): serialised vault mutations
  completion.ts             # runCompletion(job): drives streamText, emits events, writes on completion
  sse.ts                    # SSE encoding helpers
  app.ts                    # + GET /api/models, POST /api/canvases, POST /api/canvases/:slug/messages
apps/web/src/
  sse.ts                    # parseSseStream(readable): AsyncIterable<{ event, data }>
  streams.ts                # streaming reducer: Map<nodeId, StreamState>
  navigation.ts             # nextSelection(dto, current, key)
  Composer.tsx              # target chip, model chips, textarea, send
  App.tsx                   # + composer, streams, keyboard focus model, new-canvas button
  GraphView.tsx             # + streaming node rendering, pan-to-new-nodes
  MessageNode.tsx           # + streaming/error visual states
```

## 4. API

### `GET /api/models` → `ModelDto[]`
`{ id: string; provider: 'anthropic' | 'openai' | 'openrouter'; label: string; available: boolean }` for every entry of `MODELS`; `available` = the provider's key is loaded.

### `POST /api/canvases` with `{ name: string }` → `201 CanvasSummaryDto`
`slug = slug(name)`; `400 { error }` if the slug is empty or invalid; `409 { error: 'canvas exists' }` if the folder exists. Creates `<slug>/nodes/` and an empty `graph.canvas` (`{"nodes":[],"edges":[]}` in the canonical format).

### `POST /api/canvases/:slug/messages` with `{ parentId: string | null; content: string; model: string }`
Validation: canvas exists (404), `content` non-empty after trim (400), `model` in `MODELS` and available (400), `parentId` null or a node of the canvas (400).

Response `200 text/event-stream`, events in order:
1. `user-node` — `NodeDto` of the newly written user node (`parents: parentId ? [parentId] : []`).
2. `assistant-start` — `{ id, model, layout, parents: [userId], created }`.
3. `delta` — `{ text }` zero or more times.
4. `done` — `NodeDto` of the written assistant node; **or** `error` — `{ message, partial: boolean }` (`partial` true when text had arrived and was written).
Stream ends after `done`/`error`.

The assistant node's `model` frontmatter field = the model id. `summary: ''`, `topics: []`.

### Completion semantics
`runCompletion` is started before the SSE response is returned and is not tied to the connection: it collects deltas into a buffer, and on finish (or provider error after ≥1 delta) writes the node under the vault lock, then resolves. The SSE handler subscribes to the job's events; if the client aborts, the subscription is dropped and the job continues. Jobs are held in an in-memory `Map<assistantId, Job>` until finished (no reattach in M3).

## 5. Layout rule (`placeChild`)

Given parent `P` with layout and its existing children in creation order (= ULID order):
- `y = P.y + P.height + NODE_GAP`.
- `x = P.x` if `P` has no children; otherwise `x = extentRight(lastChild) + NODE_GAP`, where `extentRight(n)` = `max(x + width)` over `n` and all its descendants.
- While the candidate rectangle (`NODE_WIDTH × NODE_HEIGHT`) intersects any existing node's rectangle, `x += NODE_GAP + NODE_WIDTH` (scan right).
- Existing nodes are never moved.

Child rule amended 2026-09-24 (user feedback: branches only ever grew to the right). Slots are `x = P.x + k·(NODE_WIDTH + NODE_GAP)` in the row `y` above, tried in order of distance from the parent: `k = 0`, then alternately one side and the other (`±1, ∓1, ±2, …`), starting with the side that has fewer existing primary children (children centred under `P` count for neither; ties go right). A slot is taken if its *lane* is clear: nothing but `P` in the row directly above it (a branch must not steal another node's continuation slot) and nothing in the `LANE_ROWS = 3` rows below (room to grow). If no slot within 12 steps per side has a clear lane, the nearest slot that merely overlaps nothing wins. The rules for `y`, for existing nodes and the property below are unchanged.

Root nodes (no parent) — amended 2026-09-18 after the M4 gate feedback: roots form a row along the top and each strand grows downwards. `x = extentRight(all nodes) + NODE_GAP` where `extentRight` = `max(x + width)` (0 for an empty canvas), `y = min(y over existing roots)` (0 for an empty canvas), then the same collision scan. (Until then: `x = 0`, `y = extentBottom(all nodes) + NODE_GAP`.)
Property (tested with fast-check): after any sequence of `placeChild` calls no two nodes overlap and no pre-existing layout changed.

## 6. Context builder (`buildContext`)

- `system`: fixed string — "You are chatting inside chatmind, a canvas where conversations branch. Answer the latest message in the context of the thread above it. Be direct." (exact text lives in `context.ts`; it never includes timestamps or ids, so provider caches can hit.)
- `messages`: the ancestor chain from the root to `parentId` inclusive, in order, mapped `role → role`, `content → body`. Consecutive same-role messages are kept as-is (the AI SDK / providers merge them). The new user message is appended by the caller.
- Empty chain (root message) → `messages = []`.

## 7. Frontend behaviour

- **Composer** (always visible, bottom): target chip ("Replying to: <title>" or "New root message"), model chips (one active; last choice remembered in `localStorage`), auto-growing textarea, Send button. No branch button.
- **Keyboard**: as in §2 — Enter sends, Shift+Enter inserts a newline (Cmd/Ctrl+Enter also sends). Selection changes by keyboard pan the viewport to keep the selected node visible (React Flow `setCenter`/`fitBounds` with duration, zoom unchanged). Root reachable from any node via repeated ↑; `→`/`←` wrap nowhere.
- **Streaming**: on `user-node` the node is inserted into the local `CanvasDto`; on `assistant-start` a stream entry is created and a node with empty body is inserted (card shows model badge + pulsing border); `delta` appends; `done` replaces the node with the final DTO and removes the stream entry; `error` marks the entry `status: 'error'` with the message (card red border, panel shows message; partial text stays).
- **Camera**: after the local send only, `fitBounds` of the user node + assistant node with padding, once.
- **No providers**: composer shows "No provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY (or ~/.config/chatmind/env) and restart chatmind" instead of chips; Send disabled.
- **Send failure before the stream starts** (4xx/5xx): message line above the composer; text stays in the textarea.
- **New canvas**: button in the sidebar → `prompt()`-free inline input → `POST /api/canvases` → select it.

## 8. Testing

- core: `placeChild` (unit cases + property), `buildContext` (chain order, root, roles), `writeNode`/`writeCanvasFile` (single-file writes, byte-identical to a full `writeCanvas`).
- server: `keys.ts` (env precedence, file parsing), `models.ts`, `POST /api/canvases` (201/400/409), `POST …/messages` with a mock language model from `ai/test` yielding fixed deltas (event order, files written, partial-on-error, validation 400s), vault lock (two completions finishing concurrently → both nodes in the canvas), disconnect (abort the request; node still written).
- web: `parseSseStream` (events split across chunks), streaming reducer, `nextSelection`, Composer keyboard flow (Enter/Cmd+Enter/Esc) with a stubbed streaming `fetch`.
- Manual gate: the user holds a branching conversation keyboard-only with both providers, then verifies in Obsidian and with `pnpm cli check`.

## 9. Not in M3

Merge (M4), summaries/embeddings (M5), editing or deleting nodes, stopping a running stream, reattaching to running jobs after reload, tool use, images, multi-model parallel sends, effort/thinking controls, provider streaming of "thinking" text.
