# chatmind — M2: Read-only Frontend Design

Status: approved in brainstorming, 2026-09-12
Builds on: `docs/superpowers/specs/2026-09-11-chatmind-vault-format-design.md` (invariants §3, formats §8, reader §9). This document only adds what M2 needs.

## 1. Goal

A vault produced by cycle 1 is navigable in the browser: pick a canvas, pan/zoom the graph, click a node, read its full content. No editing, no LLM, no watcher.

Done when (spec §13 M2): the `masterarbeit` vault in `~/Documents/chatmind` is navigable at `http://localhost:5173` (dev) — verified manually by the user.

## 2. Decisions

| Question | Decision |
|---|---|
| Cycle scope | M2 only. M3 (composer, streaming) is its own cycle. |
| Server framework | Hono + `@hono/node-server`. `app.request()` makes route tests socket-free. |
| Dev workflow | Two processes: Vite dev server (5173) proxies `/api` to the Hono server (3210). One root script `pnpm dev` starts both (`pnpm -r --parallel run dev`). |
| Prod workflow | `pnpm build` (Vite) then `pnpm start`: the Hono process serves `apps/web/dist` statically — one process, per the briefing. |
| Frontend stack | Vite + React 19 + TypeScript + `@xyflow/react` (React Flow) + `react-markdown`. No router, no state library, no CSS framework. |
| UI language | English. |
| Data transport | REST JSON, read on every request via `readVault` (no cache — M5 adds the watcher). |
| Data contract | `CanvasDto` produced by `toCanvasDto()` in `@chatmind/core` (Maps → arrays). `apps/web` imports **types only** from core (`import type`), so no Node built-ins reach the browser bundle. |
| Positions | React Flow coordinates = canvas coordinates 1:1 (`layout.x/y/width/height`). The browser shows exactly the Obsidian layout. |
| Theme | Follows the system (`prefers-color-scheme`) via CSS variables. No toggle. |
| Models for M3 (noted) | Two per provider (one strong, one fast) for Anthropic and OpenAI; exact ids to be looked up at M3 time. |

## 3. Packages

```
apps/server/                 # @chatmind/server
  src/app.ts                 # createApp({ dataDir, staticDir? }): Hono
  src/index.ts               # CLI entry: --data-dir, --port / CHATMIND_PORT (default 3210), --static
  test/app.test.ts
apps/web/                    # @chatmind/web
  index.html
  vite.config.ts             # react plugin; server.proxy '/api' → http://localhost:3210
  src/main.tsx
  src/App.tsx                # canvas list → selected canvas → graph + panel
  src/api.ts                 # fetchCanvases(), fetchCanvas(slug)
  src/flow.ts                # toFlowNodes(dto), toFlowEdges(dto)  (pure)
  src/GraphView.tsx          # <ReactFlow> read-only, custom node type 'message'
  src/MessageNode.tsx        # node card: role, summary, body preview, handles
  src/NodePanel.tsx          # selected node: metadata + markdown body
  src/styles.css
  test/setup.ts              # jsdom mocks React Flow needs (ResizeObserver, DOMMatrixReadOnly, …)
  test/flow.test.ts, test/NodePanel.test.tsx, test/App.test.tsx
packages/core/src/dto.ts     # DTO types + toCanvasDto / toCanvasSummaryDto / repairsForCanvas
```

Dependency direction: `web` → (types) `core`; `server` → `core`; `core` → nothing new.

## 4. API

- `GET /api/canvases` → `CanvasSummaryDto[]` = `[{ slug, nodeCount }]`, sorted by slug. Missing data dir → `[]` (the server creates the dir on start anyway).
- `GET /api/canvases/:slug` → `CanvasDto` or `404 { error: "canvas not found" }`.
- Static (prod only): everything else from `staticDir`, with `index.html` fallback for unknown paths.

```ts
interface NodeDto { id; role; model?; parents; created; summary; topics; body; layout: Layout }
interface EdgeDto { id; from; to }          // from derivedEdges: e-{from}-{to}
interface CanvasDto { slug; nodes: NodeDto[]; edges: EdgeDto[]; repairs: Repair[] }
interface CanvasSummaryDto { slug; nodeCount }
```
`nodes` are in `canvasOrder(graph)`; every node has a layout (placeholder if the reader had to invent one — the reader already does this). `repairs` are the subset of the vault's repairs that belong to this canvas (`repairsForCanvas`).

## 5. Frontend behaviour

- On load: fetch canvases; select the first one (or `?canvas=<slug>` if present); fetch it.
- Left: canvas list (click to switch). Center: React Flow, `fitView` on load, `nodesDraggable={false}`, `nodesConnectable={false}`, pan/zoom enabled, `Background`, `Controls`, `MiniMap`. Right: `NodePanel` for the selected node (empty state: "Select a node").
- Node card: role badge (`user` / `assistant` + model), summary as title (fallback: first 80 chars of body), body preview (first ~200 chars), created timestamp. Target handle top, source handle bottom (matches the canvas `fromSide: bottom → toSide: top`).
- Edges: `smoothstep`, solid (structural). Semantic edges (dashed) do not exist yet.
- Repairs: if `repairs.length > 0`, a small banner "N repairs pending — run `pnpm cli check`" (no UI to act on them yet).
- Keyboard: none beyond React Flow defaults (M3 adds the navigation model).

## 6. Testing

- core: `dto.test.ts` — `toCanvasDto` node order, layout presence, edges, `repairsForCanvas` filtering by slug / node id / path.
- server: `app.test.ts` with `app.request()` against a tmp vault written by `writeCanvas`: list, detail, 404, empty dir, static fallback (tmp dist with an `index.html`).
- web: `flow.test.ts` (pure mapping), `NodePanel.test.tsx` (markdown renders), `App.test.tsx` (smoke: `fetch` stubbed, canvas name and graph container appear).
- Manual gate (done condition): user runs `pnpm dev`, opens `http://localhost:5173`, navigates the `masterarbeit` vault.

## 7. Not in M2

Composer, streaming, providers/keys, file watcher, editing, routing, auth, i18n, dark-mode toggle, Electron.
