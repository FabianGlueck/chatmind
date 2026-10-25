# Cycle 3 (M3): Composer, Branching, Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user can write a message targeting any node, a chosen model streams the answer into a new child node (branching visibly when the target already has children), keyboard-only, with every node persisted to the vault exactly as cycle 1 specified.

**Architecture:** Core gains three pure/IO pieces: the deterministic `placeChild` layout rule, the `buildContext` ancestor-chain prompt builder, and single-file writers (`writeNode`, `writeCanvasFile`). The server gains keys/models/providers (Vercel AI SDK 7 with Anthropic, OpenAI and OpenRouter), a promise-chain vault lock, a completion job that streams via `streamText`, buffers, and writes once on completion regardless of the client, and two new routes (`POST /api/canvases`, `POST /api/canvases/:slug/messages` → SSE). The web app gains an SSE parser, a streaming reducer, keyboard navigation, a composer, and streaming visuals.

**Tech Stack:** as cycles 1–2 plus `ai@^7`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@openrouter/ai-sdk-provider@^3`, `hono/streaming` (`streamSSE`).

**Spec:** `docs/superpowers/specs/2026-09-12-chatmind-m3-composer-streaming-design.md` (binding), on top of the cycle-1 spec (invariants) and the M2 spec.

## Global Constraints

- Node `>=22.22.2`; shells: `put Node 22 and pnpm on `PATH` (e.g. `nvm use`)`.
- `@chatmind/core` runtime deps stay `js-yaml`, `ulid`, Node built-ins (the new core modules are pure or fs-only). `apps/web` imports only types from `@chatmind/core`.
- User node written immediately; assistant node written once on completion (or on error after ≥1 delta); completion continues when the client disconnects; all server vault writes go through the `VaultLock`.
- Layout: existing nodes never move; `placeChild` per spec §5 (`NODE_WIDTH 400`, `NODE_HEIGHT 200`, `NODE_GAP 80`).
- Context: spec §6 — system prompt constant, ancestor chain root→parent, no ids/timestamps in the prompt.
- Keys: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` from env, else `~/.config/chatmind/env`. Never in the data dir or repo. **Tests never read the real key file or env** — inject.
- SSE events exactly: `user-node`, `assistant-start`, `delta`, `done` | `error` (spec §4).
- Keyboard: graph ↑ parent, ↓ first child, ←/→ siblings, Enter → composer, Esc → deselect; composer Cmd/Ctrl+Enter send, Esc → graph.
- Camera pans once after the local send; never auto-follows. English UI.
- AI SDK API drift: library shapes below are written for `ai@7` as far as known; where the installed version differs (mock class name, stream part field names), adapt minimally by reading `node_modules/ai/dist/index.d.ts` / `node_modules/ai/dist/test/index.d.ts`, and report the exact adaptation.
- TDD per task; commit per task with the session's attribution trailer.

## File Map

| Path | Responsibility |
|---|---|
| `packages/core/src/layout.ts` | + `childrenOf`, `subtreeExtentRight`, `placeChild` |
| `packages/core/src/context.ts` | `SYSTEM_PROMPT`, `ancestorChain`, `buildContext`, `ContextMessage` |
| `packages/core/src/vault/write.ts` | `writeNode`, `writeCanvasFile`; `writeCanvas` composed from them |
| `packages/core/src/dto.ts` | + `toNodeDto(node, layout)`, `ModelDto`, `SendRequest` |
| `apps/server/src/keys.ts` | `parseEnvFile`, `loadKeys` |
| `apps/server/src/models.ts` | `MODELS`, `DEFAULT_MODEL`, `findModel`, `modelDtos` |
| `apps/server/src/providers.ts` | `createModelFactory(keys)` → AI SDK `LanguageModel` per spec |
| `apps/server/src/vault-lock.ts` | `VaultLock` |
| `apps/server/src/completion.ts` | `startCompletion` job with subscribe/replay |
| `apps/server/src/app.ts` | + `GET /api/models`, `POST /api/canvases`, `POST /api/canvases/:slug/messages`; `AppOptions.keys`, `AppOptions.modelFactory` |
| `apps/server/src/index.ts` | loads keys, logs available providers |
| `apps/web/src/sse.ts`, `streams.ts`, `navigation.ts` | pure client logic |
| `apps/web/src/api.ts` | + `fetchModels`, `createCanvas`, `sendMessage` |
| `apps/web/src/Composer.tsx` | composer UI |
| `apps/web/src/App.tsx`, `GraphView.tsx`, `MessageNode.tsx`, `NodePanel.tsx`, `flow.ts`, `styles.css` | wiring, streaming visuals, camera |

---

### Task 1: Deterministic child placement (core)

**Files:**
- Modify: `packages/core/src/layout.ts`
- Modify: `packages/core/src/index.ts` (export line for layout)
- Test: `packages/core/test/layout.test.ts` (append)

**Interfaces:**
- Consumes: `CanvasGraph`, `Layout`, `MessageNode`, `NodeId` (`types.ts`); `NODE_*` constants.
- Produces:
  ```ts
  childrenOf(graph: CanvasGraph, id: NodeId): MessageNode[]           // nodes whose parents[0] === id, sorted by id
  rootsOf(graph: CanvasGraph): MessageNode[]                           // nodes with parents.length === 0, sorted by id
  subtreeExtentRight(graph: CanvasGraph, id: NodeId): number           // max(x+width) over id and primary-parent descendants with layout
  rectsOverlap(a: Layout, b: Layout): boolean
  placeChild(graph: CanvasGraph, parentId: NodeId | null): Layout      // spec §5; pure, never mutates graph
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/layout.test.ts` (add `fc` import and `CanvasGraph` type import at the top; keep existing tests):
```ts
import fc from 'fast-check';
import { childrenOf, placeChild, rectsOverlap, rootsOf, subtreeExtentRight } from '../src/layout';
import type { CanvasGraph } from '../src/types';

function emptyGraph(): CanvasGraph {
  return { slug: 'm', nodes: new Map(), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
}
function add(g: CanvasGraph, id: string, parent: string | null): void {
  const layout = placeChild(g, parent);
  g.nodes.set(id, node({ id, parents: parent === null ? [] : [parent] }));
  g.layout.set(id, layout);
}
const ID = (n: number) => `01JQ8F${String(n).padStart(20, '0')}`; // 26 chars, sorts by n

describe('placeChild', () => {
  it('places the first root at the origin and later roots below everything', () => {
    const g = emptyGraph();
    expect(placeChild(g, null)).toEqual({ x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT });
    add(g, ID(1), null);
    add(g, ID(2), ID(1));
    expect(placeChild(g, null)).toEqual({ x: 0, y: 2 * (NODE_HEIGHT + NODE_GAP), width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  it('places the first child directly below the parent', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    expect(placeChild(g, ID(1))).toEqual({ x: 0, y: NODE_HEIGHT + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  it('places a second child right of the first child subtree', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    add(g, ID(2), ID(1));
    add(g, ID(3), ID(2)); // grandchild directly below child 2
    add(g, ID(4), ID(3));
    // extent of child-2 subtree is a single column: x+width = 400
    expect(placeChild(g, ID(1))).toEqual({ x: NODE_WIDTH + NODE_GAP, y: NODE_HEIGHT + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  it('scans right when the slot collides with an unrelated node', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    // a foreign-positioned node occupying the first-child slot
    g.nodes.set(ID(9), node({ id: ID(9), parents: [] }));
    g.layout.set(ID(9), { x: 0, y: NODE_HEIGHT + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(placeChild(g, ID(1)).x).toBe(NODE_WIDTH + NODE_GAP);
  });

  it('throws when the parent has no layout', () => {
    const g = emptyGraph();
    g.nodes.set(ID(1), node({ id: ID(1) }));
    expect(() => placeChild(g, ID(1))).toThrow(/no layout/);
  });

  it('never overlaps and never moves existing nodes (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 50 }), { minLength: 1, maxLength: 40 }), (picks) => {
        const g = emptyGraph();
        let n = 0;
        for (const pick of picks) {
          const ids = [...g.nodes.keys()];
          const parent = ids.length === 0 || pick % 7 === 0 ? null : ids[pick % ids.length]!;
          const before = new Map([...g.layout].map(([k, v]) => [k, { ...v }]));
          add(g, ID(++n), parent);
          for (const [k, v] of before) expect(g.layout.get(k)).toEqual(v);
        }
        const rects = [...g.layout.values()];
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }),
    );
  });
});

describe('graph helpers', () => {
  it('childrenOf / rootsOf use the primary parent and sort by id', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    add(g, ID(3), ID(1));
    add(g, ID(2), ID(1));
    add(g, ID(4), null);
    expect(childrenOf(g, ID(1)).map((n) => n.id)).toEqual([ID(2), ID(3)]);
    expect(rootsOf(g).map((n) => n.id)).toEqual([ID(1), ID(4)]);
  });
  it('subtreeExtentRight covers descendants and tolerates cycles', () => {
    const g = emptyGraph();
    add(g, ID(1), null);
    add(g, ID(2), ID(1));
    add(g, ID(3), ID(1));
    expect(subtreeExtentRight(g, ID(1))).toBe(2 * NODE_WIDTH + NODE_GAP);
    g.nodes.get(ID(1))!.parents = [ID(3)]; // hand-edited cycle
    expect(subtreeExtentRight(g, ID(1))).toBe(2 * NODE_WIDTH + NODE_GAP);
  });
});
```
(`node` is already imported from `./helpers` in cycle-1's layout test? If not, import it: `import { node } from './helpers';`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core exec vitest run test/layout.test.ts`
Expected: FAIL — `placeChild` etc. not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/layout.ts` (also import `CanvasGraph`):
```ts
function byId(a: MessageNode, b: MessageNode): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Children for layout purposes: nodes whose PRIMARY parent (parents[0]) is `id`, in creation order. */
export function childrenOf(graph: CanvasGraph, id: NodeId): MessageNode[] {
  return [...graph.nodes.values()].filter((n) => n.parents[0] === id).sort(byId);
}

export function rootsOf(graph: CanvasGraph): MessageNode[] {
  return [...graph.nodes.values()].filter((n) => n.parents.length === 0).sort(byId);
}

/** Right edge of the subtree rooted at `id` (primary-parent descendants only); nodes without layout are ignored. */
export function subtreeExtentRight(graph: CanvasGraph, id: NodeId): number {
  let right = Number.NEGATIVE_INFINITY;
  const seen = new Set<NodeId>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const l = graph.layout.get(cur);
    if (l) right = Math.max(right, l.x + l.width);
    for (const child of childrenOf(graph, cur)) stack.push(child.id);
  }
  return right === Number.NEGATIVE_INFINITY ? 0 : right;
}

export function rectsOverlap(a: Layout, b: Layout): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Spec §5. Deterministic slot for a new child of `parentId` (or a new root when null).
 * Existing nodes never move; the candidate scans right until it overlaps nothing.
 */
export function placeChild(graph: CanvasGraph, parentId: NodeId | null): Layout {
  let x: number;
  let y: number;
  if (parentId === null) {
    x = 0;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const l of graph.layout.values()) bottom = Math.max(bottom, l.y + l.height);
    y = bottom === Number.NEGATIVE_INFINITY ? 0 : bottom + NODE_GAP;
  } else {
    const p = graph.layout.get(parentId);
    if (!p) throw new Error(`parent ${parentId} has no layout`);
    y = p.y + p.height + NODE_GAP;
    const siblings = childrenOf(graph, parentId);
    const last = siblings[siblings.length - 1];
    x = last === undefined ? p.x : subtreeExtentRight(graph, last.id) + NODE_GAP;
  }
  const candidate: Layout = { x, y, width: NODE_WIDTH, height: NODE_HEIGHT };
  const rects = [...graph.layout.values()];
  while (rects.some((r) => rectsOverlap(candidate, r))) candidate.x += NODE_WIDTH + NODE_GAP;
  return candidate;
}
```
Update the `placeholderLayout` doc comment: it stays for the reader's repair path ("nodes without a canvas entry"); `placeChild` is the rule for new nodes.

Barrel: `export { NODE_WIDTH, NODE_HEIGHT, NODE_GAP, placeholderLayout, columnLayout, placeChild, childrenOf, rootsOf, subtreeExtentRight, rectsOverlap } from './layout';`

- [ ] **Step 4: Run to verify pass, commit**

Run: `pnpm --filter @chatmind/core test && pnpm typecheck`
Expected: all pass incl. the property test.
```bash
git add packages/core/src/layout.ts packages/core/src/index.ts packages/core/test/layout.test.ts
git commit -m "feat(core): deterministic child placement (placeChild)"
```

---

### Task 2: Context builder (core)

**Files:**
- Create: `packages/core/src/context.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/context.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ContextMessage { role: 'user' | 'assistant'; content: string }
  const SYSTEM_PROMPT: string
  ancestorChain(graph: CanvasGraph, id: NodeId): MessageNode[]      // root … id (inclusive) along parents[0]; stops at unknown/cyclic
  buildContext(graph: CanvasGraph, parentId: NodeId | null): { system: string; messages: ContextMessage[] }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/context.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, ancestorChain, buildContext } from '../src/context';
import type { CanvasGraph } from '../src/types';
import { A, B, C, node, sampleGraph } from './helpers';

describe('buildContext', () => {
  it('returns the fixed system prompt and no messages for a root message', () => {
    expect(buildContext(sampleGraph(), null)).toEqual({ system: SYSTEM_PROMPT, messages: [] });
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}|01JQ/);
  });

  it('maps the ancestor chain root→parent to role/content in order', () => {
    const { messages } = buildContext(sampleGraph(), C);
    expect(messages).toEqual([
      { role: 'user', content: 'Wie evaluiere ich Topic-Zuordnung?' },
      { role: 'assistant', content: 'Zentroid statt Re-Clustering.\n\nBegründung folgt.' },
      { role: 'user', content: 'Danke.' },
    ]);
  });

  it('follows the primary parent for merge nodes and stops at unknown parents', () => {
    const g: CanvasGraph = sampleGraph();
    const M = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    g.nodes.set(M, node({ id: M, role: 'assistant', parents: [B, C], body: 'merged' }));
    expect(ancestorChain(g, M).map((n) => n.id)).toEqual([A, B, M]);
    g.nodes.get(A)!.parents = ['01JQ8F9ZZZZZZZZZZZZZZZZZZZ'];
    expect(ancestorChain(g, M).map((n) => n.id)).toEqual([A, B, M]);
  });

  it('tolerates cycles', () => {
    const g = sampleGraph();
    g.nodes.get(A)!.parents = [C];
    expect(ancestorChain(g, C).map((n) => n.id)).toEqual([A, B, C]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core exec vitest run test/context.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`packages/core/src/context.ts`:
```ts
import type { CanvasGraph, MessageNode, NodeId, Role } from './types';

export interface ContextMessage {
  role: Role;
  content: string;
}

/** Fixed and free of ids/timestamps so provider prompt caches can hit (spec §6). */
export const SYSTEM_PROMPT =
  'You are chatting inside chatmind, a canvas where conversations branch. Answer the latest message in the context of the thread above it. Be direct.';

/** Root → `id` along the primary parent. Unknown parents end the chain; cycles are cut. */
export function ancestorChain(graph: CanvasGraph, id: NodeId): MessageNode[] {
  const chain: MessageNode[] = [];
  const seen = new Set<NodeId>();
  let cur: NodeId | undefined = id;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const n = graph.nodes.get(cur);
    if (!n) break;
    chain.push(n);
    cur = n.parents[0];
  }
  return chain.reverse();
}

export function buildContext(graph: CanvasGraph, parentId: NodeId | null): { system: string; messages: ContextMessage[] } {
  const messages = parentId === null ? [] : ancestorChain(graph, parentId).map((n) => ({ role: n.role, content: n.body }));
  return { system: SYSTEM_PROMPT, messages };
}
```
Barrel: `export { SYSTEM_PROMPT, ancestorChain, buildContext, type ContextMessage } from './context';`

- [ ] **Step 4: Run, commit**

Run: `pnpm --filter @chatmind/core test && pnpm typecheck`
```bash
git add packages/core/src/context.ts packages/core/src/index.ts packages/core/test/context.test.ts
git commit -m "feat(core): ancestor-chain context builder"
```

---

### Task 3: Single-file writers and node DTO (core)

**Files:**
- Modify: `packages/core/src/vault/write.ts`, `packages/core/src/dto.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/write.test.ts` (append), `packages/core/test/dto.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  writeNode(graph: CanvasGraph, id: NodeId, root: string): Promise<void>   // assigns graph.paths if missing; escape check; writes the .md
  writeCanvasFile(graph: CanvasGraph, root: string): Promise<void>         // assigns placeholder layouts if missing; writes graph.canvas
  // writeCanvas(graph, root) == validate slug + mkdir + writeNode for each canvasOrder node + writeCanvasFile
  toNodeDto(node: MessageNode, layout: Layout): NodeDto
  interface ModelDto { id: string; provider: 'anthropic' | 'openai' | 'openrouter'; label: string; available: boolean }
  interface SendRequest { parentId: string | null; content: string; model: string }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/write.test.ts` (import `writeCanvasFile, writeNode` from `../src/vault/write` and `node` from `./helpers`):
```ts
describe('writeNode / writeCanvasFile', () => {
  it('composes to exactly what writeCanvas writes', async () => {
    const rootA = await tmpDir();
    const rootB = await tmpDir();
    await writeCanvas(sampleGraph(), rootA);
    const g = sampleGraph();
    await fs.mkdir(path.join(rootB, 'masterarbeit', 'nodes'), { recursive: true });
    for (const id of [A, B, C]) await writeNode(g, id, rootB);
    await writeCanvasFile(g, rootB);
    expect(await readTree(rootB)).toEqual(await readTree(rootA));
  });

  it('writeNode writes one file and records the path; writeCanvasFile records placeholder layouts', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, root);
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    g.nodes.set(D, node({ id: D, parents: [C], body: 'Neu.' }));
    const before = await readTree(root);
    await writeNode(g, D, root);
    expect(g.paths.get(D)).toBe(`masterarbeit/nodes/${D}.md`);
    const mid = await readTree(root);
    expect([...mid.keys()].filter((k) => !before.has(k))).toEqual([`masterarbeit/nodes/${D}.md`]);
    expect(mid.get('masterarbeit/graph.canvas')).toBe(before.get('masterarbeit/graph.canvas'));
    await writeCanvasFile(g, root);
    expect(g.layout.get(D)).toEqual({ x: 0, y: 840, width: 400, height: 200 });
    expect(JSON.parse((await readTree(root)).get('masterarbeit/graph.canvas')!).nodes.map((n: { id: string }) => n.id)).toEqual([A, B, C, D]);
  });

  it('writeNode rejects a path escaping the data dir', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.paths.set(A, '../outside.md');
    await expect(writeNode(g, A, root)).rejects.toThrow('escapes the data dir');
  });
});
```
Append to `packages/core/test/dto.test.ts`:
```ts
describe('toNodeDto', () => {
  it('projects a node with its layout, copying arrays and omitting an absent model', () => {
    const g = sampleGraph();
    const n = g.nodes.get(C)!;
    const dto = toNodeDto(n, g.layout.get(C)!);
    expect(dto).toEqual({ id: C, role: 'user', parents: [B], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Danke.', layout: { x: 0, y: 560, width: 400, height: 200 } });
    expect(dto.parents).not.toBe(n.parents);
    expect('model' in dto).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @chatmind/core test` → FAIL (missing exports).

- [ ] **Step 3: Implement**

In `packages/core/src/vault/write.ts` replace `writeCanvas` with:
```ts
/** Write one node's markdown file, assigning its path on first write. Never renames. */
export async function writeNode(graph: CanvasGraph, id: NodeId, root: string): Promise<void> {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`node ${id} not in graph`);
  const { slug } = graph;
  const resolvedRoot = path.resolve(root);
  let rel = graph.paths.get(id);
  if (rel === undefined) {
    rel = `${slug}/${NODES_DIR}/${nodeFileName(id, node.summary)}`;
    graph.paths.set(id, rel);
  }
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(resolvedRoot + path.sep)) throw new Error(`node ${id}: path "${rel}" escapes the data dir`);
  await writeIfChanged(abs, serializeNodeFile(node, slug));
}

/** Write graph.canvas from the in-memory graph; nodes without layout get a placeholder recorded first. */
export async function writeCanvasFile(graph: CanvasGraph, root: string): Promise<void> {
  const fileNodes: CanvasFileNode[] = [];
  for (const node of canvasOrder(graph)) {
    const rel = graph.paths.get(node.id);
    if (rel === undefined) throw new Error(`node ${node.id} has no path — call writeNode first`);
    let layout = graph.layout.get(node.id);
    if (layout === undefined) {
      layout = placeholderLayout(node, graph.layout);
      graph.layout.set(node.id, layout);
    }
    fileNodes.push({ id: node.id, file: rel, ...layout });
  }
  await fs.mkdir(path.join(root, graph.slug), { recursive: true });
  await writeIfChanged(path.join(root, graph.slug, CANVAS_FILE), serializeCanvas({ fileNodes, edges: derivedEdges(graph), foreign: graph.foreign }));
}

/**
 * Write a whole canvas folder. Only files whose bytes change are written; nothing is ever renamed or deleted.
 * Side effects on `graph`: paths and placeholder layouts are recorded so memory matches disk afterwards.
 */
export async function writeCanvas(graph: CanvasGraph, root: string): Promise<void> {
  if (!isCanvasSlug(graph.slug)) throw new Error(`invalid canvas slug "${graph.slug}"`);
  await fs.mkdir(path.join(root, graph.slug, NODES_DIR), { recursive: true });
  for (const node of canvasOrder(graph)) await writeNode(graph, node.id, root);
  await writeCanvasFile(graph, root);
}
```
(import `NodeId` from `../types`.) Note the canvas-order subtlety: `canvasOrder` lists nodes without layout last; `writeCanvasFile` assigns their placeholder in that order — same as before.

In `packages/core/src/dto.ts`: extract the node projection from `toCanvasDto` into
```ts
export function toNodeDto(n: MessageNode, layout: Layout): NodeDto {
  const dto: NodeDto = { id: n.id, role: n.role, parents: [...n.parents], created: n.created, summary: n.summary, topics: [...n.topics], body: n.body, layout: { ...layout } };
  if (n.model !== undefined) dto.model = n.model;
  return dto;
}
```
and make `toCanvasDto` use it (`nodes.push(toNodeDto(n, graph.layout.get(n.id) ?? placeholderLayout(n, graph.layout)))`). Add:
```ts
export type Provider = 'anthropic' | 'openai' | 'openrouter';
export interface ModelDto { id: string; provider: Provider; label: string; available: boolean }
export interface SendRequest { parentId: string | null; content: string; model: string }
```
Barrel: add `writeNode, writeCanvasFile` to the write export; add `toNodeDto, type ModelDto, type SendRequest, type Provider` to the dto export.

- [ ] **Step 4: Run everything, commit**

Run: `pnpm test && pnpm typecheck` (server/web tests must still pass — `writeCanvas` behaviour is unchanged).
```bash
git add packages/core
git commit -m "feat(core): single-file writers writeNode/writeCanvasFile and toNodeDto"
```

---

### Task 4: Keys, models, providers, `GET /api/models` (server)

**Files:**
- Create: `apps/server/src/keys.ts`, `apps/server/src/models.ts`, `apps/server/src/providers.ts`
- Modify: `apps/server/src/app.ts` (options + route), `apps/server/src/index.ts`
- Test: `apps/server/test/keys.test.ts`, `apps/server/test/models.test.ts`, `apps/server/test/app.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  interface Keys { anthropic?: string; openai?: string; openrouter?: string }
  parseEnvFile(text: string): Record<string, string>
  loadKeys(env?: NodeJS.ProcessEnv, filePath?: string): Promise<Keys>
  interface ModelSpec { id: string; provider: Provider; label: string }
  const MODELS: readonly ModelSpec[]; const DEFAULT_MODEL: string
  findModel(id: string): ModelSpec | undefined
  modelDtos(keys: Keys): ModelDto[]
  isAvailable(spec: ModelSpec, keys: Keys): boolean
  type ModelFactory = (spec: ModelSpec) => LanguageModel            // from 'ai'
  createModelFactory(keys: Keys): ModelFactory
  AppOptions += { keys?: Keys; modelFactory?: ModelFactory }
  GET /api/models → ModelDto[]
  ```

- [ ] **Step 1: Install and verify model ids**

Run: `pnpm --filter @chatmind/server add ai @ai-sdk/anthropic @ai-sdk/openai @openrouter/ai-sdk-provider && pnpm install`
Expected: `ai` 7.x, `@openrouter/ai-sdk-provider` 3.x (peer `ai@^7`).

Verify ids (do not guess): `curl -s https://openrouter.ai/api/v1/models | python3 -c "import sys,json; [print(m['id']) for m in json.load(sys.stdin)['data'] if m['id'].startswith(('anthropic/claude-opus-5','anthropic/claude-sonnet-5','openai/gpt','google/gemini'))]"` and pick: `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5` (must exist; if the exact ids differ, use OpenRouter's ids for those two models), the newest flagship `openai/gpt-…` and newest `google/gemini-…-pro` or `-flash`. For OpenAI-direct ids: if `OPENAI_API_KEY` is set in your shell, `curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"`; otherwise WebFetch `https://platform.openai.com/docs/models` and take the current flagship + its `mini`. Record the date in a comment.

- [ ] **Step 2: Write the failing tests**

`apps/server/test/keys.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKeys, parseEnvFile } from '../src/keys';

describe('parseEnvFile', () => {
  it('parses KEY=VALUE lines, ignores comments/blank lines, strips quotes', () => {
    expect(parseEnvFile('# c\n\nANTHROPIC_API_KEY=sk-a\nOPENAI_API_KEY="sk-o"\nOPENROUTER_API_KEY=\'sk-r\'\nBAD LINE\n')).toEqual({
      ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o', OPENROUTER_API_KEY: 'sk-r',
    });
  });
});

describe('loadKeys', () => {
  it('prefers env, falls back to the file, ignores a missing file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-keys-'));
    const file = path.join(dir, 'env');
    await fs.writeFile(file, 'OPENAI_API_KEY=file-o\nOPENROUTER_API_KEY=file-r\n');
    expect(await loadKeys({ ANTHROPIC_API_KEY: 'env-a', OPENAI_API_KEY: 'env-o' }, file)).toEqual({ anthropic: 'env-a', openai: 'env-o', openrouter: 'file-r' });
    expect(await loadKeys({}, path.join(dir, 'nope'))).toEqual({});
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('treats empty values as unset', async () => {
    expect(await loadKeys({ ANTHROPIC_API_KEY: '' }, '/nonexistent/env')).toEqual({});
  });
});
```
`apps/server/test/models.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, MODELS, findModel, modelDtos } from '../src/models';

describe('models', () => {
  it('has the two Anthropic models, a default, and three providers', () => {
    expect(findModel('claude-opus-5')?.provider).toBe('anthropic');
    expect(findModel('claude-sonnet-5')?.provider).toBe('anthropic');
    expect(DEFAULT_MODEL).toBe('claude-opus-5');
    expect(new Set(MODELS.map((m) => m.provider))).toEqual(new Set(['anthropic', 'openai', 'openrouter']));
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
  });
  it('marks availability per provider key', () => {
    const dtos = modelDtos({ openrouter: 'k' });
    expect(dtos.filter((d) => d.available).every((d) => d.provider === 'openrouter')).toBe(true);
    expect(dtos.some((d) => d.provider === 'anthropic' && !d.available)).toBe(true);
    expect(modelDtos({}).every((d) => !d.available)).toBe(true);
  });
});
```
Append to `apps/server/test/app.test.ts`:
```ts
describe('GET /api/models', () => {
  it('lists models with availability from injected keys', async () => {
    const app = createApp({ dataDir: await tmpDir(), keys: { anthropic: 'k' } });
    const list = await json<{ id: string; provider: string; available: boolean }[]>(await app.request('/api/models'));
    expect(list.find((m) => m.id === 'claude-opus-5')).toMatchObject({ provider: 'anthropic', available: true });
    expect(list.filter((m) => m.provider !== 'anthropic').every((m) => !m.available)).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @chatmind/server test` → FAIL.

- [ ] **Step 4: Implement**

`apps/server/src/keys.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Keys { anthropic?: string; openai?: string; openrouter?: string }

export const DEFAULT_KEY_FILE = path.join(os.homedir(), '.config', 'chatmind', 'env');

/** KEY=VALUE per line; `#` comments and blank lines ignored; surrounding single/double quotes stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

const VARS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as const;

/** Environment first, then the key file; empty strings count as unset. Never throws for a missing file. */
export async function loadKeys(env: NodeJS.ProcessEnv = process.env, filePath: string = DEFAULT_KEY_FILE): Promise<Keys> {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnvFile(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const keys: Keys = {};
  for (const [provider, name] of Object.entries(VARS) as [keyof Keys, string][]) {
    const value = env[name] || fromFile[name];
    if (value) keys[provider] = value;
  }
  return keys;
}
```
`apps/server/src/models.ts`:
```ts
import type { ModelDto, Provider } from '@chatmind/core';
import type { Keys } from './keys';

export interface ModelSpec { id: string; provider: Provider; label: string }

// Anthropic ids from the Claude API reference (2026-09). OpenAI / OpenRouter ids verified on <DATE> against
// https://api.openai.com/v1/models and https://openrouter.ai/api/v1/models — replace <…> with what you verified.
export const MODELS: readonly ModelSpec[] = [
  { id: 'claude-opus-5', provider: 'anthropic', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5' },
  { id: '<openai-flagship-id>', provider: 'openai', label: '<OpenAI flagship label>' },
  { id: '<openai-mini-id>', provider: 'openai', label: '<OpenAI mini label>' },
  { id: 'anthropic/claude-opus-5', provider: 'openrouter', label: 'Claude Opus 5 (OpenRouter)' },
  { id: 'anthropic/claude-sonnet-5', provider: 'openrouter', label: 'Claude Sonnet 5 (OpenRouter)' },
  { id: '<openai-via-openrouter-id>', provider: 'openrouter', label: '<label> (OpenRouter)' },
  { id: '<google-via-openrouter-id>', provider: 'openrouter', label: '<label> (OpenRouter)' },
];
export const DEFAULT_MODEL = 'claude-opus-5';

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}
export function isAvailable(spec: ModelSpec, keys: Keys): boolean {
  return keys[spec.provider] !== undefined;
}
export function modelDtos(keys: Keys): ModelDto[] {
  return MODELS.map((m) => ({ ...m, available: isAvailable(m, keys) }));
}
```
The `<…>` entries are the ONLY values you fill from Step 1 — the file must contain no angle brackets when you commit.

`apps/server/src/providers.ts`:
```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { Keys } from './keys';
import type { ModelSpec } from './models';

export type ModelFactory = (spec: ModelSpec) => LanguageModel;

/** Lazily builds provider clients from the loaded keys. Throws if the provider's key is missing. */
export function createModelFactory(keys: Keys): ModelFactory {
  return (spec) => {
    const apiKey = keys[spec.provider];
    if (!apiKey) throw new Error(`no API key for provider ${spec.provider}`);
    switch (spec.provider) {
      case 'anthropic':
        return createAnthropic({ apiKey })(spec.id);
      case 'openai':
        return createOpenAI({ apiKey })(spec.id);
      case 'openrouter':
        return createOpenRouter({ apiKey })(spec.id);
    }
  };
}
```
If the installed provider packages expose a different factory name/signature (check `node_modules/@ai-sdk/anthropic/dist/index.d.ts` etc.), adapt and report.

`apps/server/src/app.ts`: extend `AppOptions` with `keys?: Keys; modelFactory?: ModelFactory;` and in `createApp` — `const keys = options.keys ?? {}; const modelFactory = options.modelFactory ?? createModelFactory(keys);` — add before the `/api/*` 404:
```ts
app.get('/api/models', (c) => c.json(modelDtos(keys)));
```
`apps/server/src/index.ts`: `const keys = await loadKeys(); const app = createApp({ dataDir, staticDir, keys });` and log `providers: ${Object.keys(keys).join(', ') || 'none (set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, or ~/.config/chatmind/env)'}`.

- [ ] **Step 5: Run, commit**

Run: `pnpm --filter @chatmind/server test && pnpm typecheck` — Expected: green; `grep -c '<' apps/server/src/models.ts` shows only the import/type lines (no `<…>` placeholders).
```bash
git add -A
git commit -m "feat(server): API keys, model list with availability, AI SDK provider factory"
```

---

### Task 5: `POST /api/canvases` (server)

**Files:**
- Create: `apps/server/src/vault-lock.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/vault-lock.test.ts`, `apps/server/test/app.test.ts` (append)

**Interfaces:**
- Produces: `class VaultLock { run<T>(fn: () => Promise<T>): Promise<T> }` (FIFO, errors do not poison the chain); `createApp` holds one `VaultLock` per app instance; `POST /api/canvases` per spec §4.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/vault-lock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VaultLock } from '../src/vault-lock';

describe('VaultLock', () => {
  it('serialises callers in FIFO order and returns their values', async () => {
    const lock = new VaultLock();
    const log: string[] = [];
    const a = lock.run(async () => { log.push('a-start'); await new Promise((r) => setTimeout(r, 20)); log.push('a-end'); return 1; });
    const b = lock.run(async () => { log.push('b-start'); return 2; });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(log).toEqual(['a-start', 'a-end', 'b-start']);
  });
  it('a rejected task does not block later tasks', async () => {
    const lock = new VaultLock();
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lock.run(async () => 'ok')).toBe('ok');
  });
});
```
Append to `apps/server/test/app.test.ts`:
```ts
describe('POST /api/canvases', () => {
  it('creates an empty canvas from a name and returns 201', async () => {
    const root = await tmpDir();
    const app = createApp({ dataDir: root });
    const res = await app.request('/api/canvases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Python lernen' }) });
    expect(res.status).toBe(201);
    expect(await json<unknown>(res)).toEqual({ slug: 'python-lernen', nodeCount: 0 });
    expect(await fs.readFile(path.join(root, 'python-lernen', 'graph.canvas'), 'utf8')).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}');
    expect((await fs.stat(path.join(root, 'python-lernen', 'nodes'))).isDirectory()).toBe(true);
    expect(await json<unknown>(await app.request('/api/canvases'))).toEqual([{ slug: 'python-lernen', nodeCount: 0 }]);
  });
  it('rejects empty/invalid names and existing canvases', async () => {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root });
    const post = (name: unknown) => app.request('/api/canvases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    expect((await post('???')).status).toBe(400);
    expect((await post('')).status).toBe(400);
    expect((await post(42)).status).toBe(400);
    const dup = await post('Masterarbeit');
    expect(dup.status).toBe(409);
    expect(await json<unknown>(dup)).toEqual({ error: 'canvas exists' });
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

`apps/server/src/vault-lock.ts`:
```ts
/** Serialises vault mutations: every `run` waits for the previous one, FIFO; a failure never blocks the next. */
export class VaultLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
```
In `app.ts` (imports: `exists`, `slug`, `isCanvasSlug`, `writeCanvas`, `type CanvasGraph` from core; `VaultLock`):
```ts
const lock = new VaultLock();
// …
app.post('/api/canvases', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name : '';
  const s = slug(name);
  if (!isCanvasSlug(s)) return c.json({ error: 'name must contain letters or digits' }, 400);
  if (await exists(path.join(dataDir, s))) return c.json({ error: 'canvas exists' }, 409);
  const graph: CanvasGraph = { slug: s, nodes: new Map(), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
  await lock.run(() => writeCanvas(graph, dataDir));
  return c.json({ slug: s, nodeCount: 0 }, 201);
});
```
Register it before the `/api/*` 404.

- [ ] **Step 4: Run, commit**

Run: `pnpm --filter @chatmind/server test && pnpm typecheck`
```bash
git add -A
git commit -m "feat(server): create canvases via POST /api/canvases; vault write lock"
```

---

### Task 6: Completion job and `POST /api/canvases/:slug/messages` (server)

**Files:**
- Create: `apps/server/src/completion.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/completion.test.ts`, `apps/server/test/app.test.ts` (append), `apps/server/test/mock-model.ts` (helper)

**Interfaces:**
- Consumes: `placeChild`, `buildContext`, `writeNode`, `writeCanvasFile`, `toNodeDto`, `readVault`, `newId`, `isoTimestamp` (core); `findModel`, `isAvailable`, `ModelFactory`, `VaultLock`.
- Produces:
  ```ts
  type CompletionEvent = { type: 'delta'; text: string } | { type: 'done'; node: NodeDto } | { type: 'error'; message: string; partial: boolean }
  interface CompletionJob { assistantId: string; subscribe(listener: (e: CompletionEvent) => void): () => void; finished: Promise<void> }
  startCompletion(opts: { dataDir: string; slug: string; assistant: MessageNode; layout: Layout; model: LanguageModel; system: string; messages: ContextMessage[]; lock: VaultLock }): CompletionJob
  ```
  `subscribe` replays already-emitted events to a late subscriber, then continues live.

- [ ] **Step 1: Write the mock-model helper and failing tests**

`apps/server/test/mock-model.ts` — written against `ai@7`'s `ai/test`; verify the class name and part shapes in `node_modules/ai/dist/test/index.d.ts` and adapt (report the adaptation):
```ts
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

type Part =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'error'; error: unknown }
  | { type: 'finish'; finishReason: 'stop'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } };

/** A language model that streams the given text deltas, optionally failing after them. */
export function mockModel(deltas: string[], opts: { failAfter?: boolean; delayMs?: number } = {}) {
  const chunks: Part[] = [{ type: 'text-start', id: 't' }, ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't', delta }))];
  if (opts.failAfter) chunks.push({ type: 'error', error: new Error('provider exploded') });
  else chunks.push({ type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks, chunkDelayInMs: opts.delayMs ?? 0 }) }),
  });
}
```
(If the installed major names the class `MockLanguageModelV2`, or `doStream` must also return `rawCall`/`warnings`, follow the `.d.ts`.)

`apps/server/test/completion.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { linearGraph, placeChild, readVault, writeCanvas, type MessageNode } from '@chatmind/core';
import { afterAll, describe, expect, it } from 'vitest';
import { startCompletion, type CompletionEvent } from '../src/completion';
import { VaultLock } from '../src/vault-lock';
import { mockModel } from './mock-model';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

async function seeded() {
  const root = await tmpDir();
  const g = linearGraph('masterarbeit', [{ role: 'user', content: 'Frage' }]);
  await writeCanvas(g, root);
  const parentId = [...g.nodes.keys()][0]!;
  const assistant: MessageNode = { id: '01JQ8F5A0B1C2D3E4F5G6H7JAA', role: 'assistant', model: 'claude-opus-5', parents: [parentId], created: '2026-09-12T10:00:00Z', summary: '', topics: [], body: '' };
  return { root, g, parentId, assistant, layout: placeChild(g, parentId) };
}

function collect(job: ReturnType<typeof startCompletion>): Promise<CompletionEvent[]> {
  return new Promise((resolve) => {
    const events: CompletionEvent[] = [];
    job.subscribe((e) => { events.push(e); if (e.type !== 'delta') resolve(events); });
  });
}

describe('startCompletion', () => {
  it('streams deltas, writes the node on completion, emits done with the NodeDto', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel(['Hel', 'lo']), system: 's', messages: [{ role: 'user', content: 'Frage' }], lock: new VaultLock() });
    const events = await collect(job);
    expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'done']);
    const done = events[2] as Extract<CompletionEvent, { type: 'done' }>;
    expect(done.node).toMatchObject({ id: assistant.id, role: 'assistant', model: 'claude-opus-5', body: 'Hello', layout });
    await job.finished;
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.get(assistant.id)?.body).toBe('Hello');
    expect(await fs.readFile(path.join(root, 'masterarbeit', 'nodes', `${assistant.id}.md`), 'utf8')).toContain('model: claude-opus-5');
  });

  it('writes partial text and emits error when the provider fails mid-stream', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel(['part'], { failAfter: true }), system: 's', messages: [], lock: new VaultLock() });
    const events = await collect(job);
    expect(events.at(-1)).toEqual({ type: 'error', message: expect.stringContaining('provider exploded'), partial: true });
    await job.finished;
    expect((await readVault(root)).canvases[0]!.nodes.get(assistant.id)?.body).toBe('part');
  });

  it('writes nothing and emits error with partial=false when it fails before any text', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel([], { failAfter: true }), system: 's', messages: [], lock: new VaultLock() });
    const events = await collect(job);
    expect(events).toEqual([{ type: 'error', message: expect.any(String), partial: false }]);
    await job.finished;
    expect((await readVault(root)).canvases[0]!.nodes.has(assistant.id)).toBe(false);
  });

  it('completes and persists with no subscriber at all (client gone)', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel(['x']), system: 's', messages: [], lock: new VaultLock() });
    await job.finished;
    expect((await readVault(root)).canvases[0]!.nodes.get(assistant.id)?.body).toBe('x');
  });

  it('replays earlier events to a late subscriber', async () => {
    const { root, assistant, layout } = await seeded();
    const job = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant, layout, model: mockModel(['a', 'b']), system: 's', messages: [], lock: new VaultLock() });
    await job.finished;
    const events = await collect(job);
    expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'done']);
  });

  it('two concurrent completions both land in the canvas (lock)', async () => {
    const { root, g, parentId, layout } = await seeded();
    const lock = new VaultLock();
    const mk = (id: string): MessageNode => ({ id, role: 'assistant', model: 'claude-opus-5', parents: [parentId], created: '2026-09-12T10:00:00Z', summary: '', topics: [], body: '' });
    const l2 = { ...layout, x: layout.x + 480 };
    const j1 = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant: mk('01JQ8F5A0B1C2D3E4F5G6H7JAA'), layout, model: mockModel(['one'], { delayMs: 5 }), system: 's', messages: [], lock });
    const j2 = startCompletion({ dataDir: root, slug: 'masterarbeit', assistant: mk('01JQ8F5B0B1C2D3E4F5G6H7JAA'), layout: l2, model: mockModel(['two'], { delayMs: 1 }), system: 's', messages: [], lock });
    await Promise.all([j1.finished, j2.finished]);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.size).toBe(g.nodes.size + 2);
  });
});
```
Create `apps/server/test/tmp.ts` by moving the `tmpDir`/`dirs`/cleanup logic out of `app.test.ts` into a shared helper (`export async function tmpDir()`, `export async function cleanupTmpDirs()`), and make `app.test.ts` import it (keep its `afterAll(cleanupTmpDirs)`).

Append to `apps/server/test/app.test.ts`:
```ts
import { mockModel } from './mock-model';

/** Parse a whole SSE body into [event, data] pairs. */
function parseSse(text: string): { event: string; data: unknown }[] {
  return text.split('\n\n').filter((b) => b.trim() !== '').map((block) => {
    const event = /^event: (.*)$/m.exec(block)![1]!;
    const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    return { event, data: JSON.parse(data) };
  });
}

describe('POST /api/canvases/:slug/messages', () => {
  const headers = { 'content-type': 'application/json' };
  async function appWithModel(deltas: string[]) {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => mockModel(deltas) });
    const dto = await json<{ nodes: { id: string; role: string }[] }>(await app.request('/api/canvases/masterarbeit'));
    return { root, app, lastId: dto.nodes.at(-1)!.id };
  }

  it('writes the user node, streams the assistant, writes it, and returns the event sequence', async () => {
    const { root, app, lastId } = await appWithModel(['Hi', ' there']);
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentId: lastId, content: 'Und weiter?', model: 'claude-opus-5' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['user-node', 'assistant-start', 'delta', 'delta', 'done']);
    const user = events[0]!.data as { id: string; role: string; parents: string[]; body: string; layout: { x: number; y: number } };
    expect(user).toMatchObject({ role: 'user', parents: [lastId], body: 'Und weiter?' });
    const start = events[1]!.data as { id: string; model: string; parents: string[]; layout: { y: number } };
    expect(start).toMatchObject({ model: 'claude-opus-5', parents: [user.id] });
    expect(start.layout.y).toBe(user.layout.y + 280);
    expect(events[2]!.data).toEqual({ text: 'Hi' });
    const done = events[4]!.data as { id: string; body: string; model: string };
    expect(done).toMatchObject({ id: start.id, body: 'Hi there', model: 'claude-opus-5' });
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.get(done.id)?.parents).toEqual([user.id]);
    expect(canvases[0]!.nodes.get(user.id)?.parents).toEqual([lastId]);
  });

  it('creates a root message when parentId is null', async () => {
    const { app } = await appWithModel(['ok']);
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentId: null, content: 'Neu', model: 'claude-opus-5' }) });
    const events = parseSse(await res.text());
    expect((events[0]!.data as { parents: string[] }).parents).toEqual([]);
    expect((events[0]!.data as { layout: { y: number } }).layout.y).toBeGreaterThan(0);
  });

  it('validates input', async () => {
    const { app, lastId } = await appWithModel(['x']);
    const post = (body: unknown, slug = 'masterarbeit') => app.request(`/api/canvases/${slug}/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ parentId: lastId, content: 'x', model: 'claude-opus-5' }, 'nope')).status).toBe(404);
    expect((await post({ parentId: lastId, content: '   ', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentId: lastId, content: 'x', model: 'unknown-model' })).status).toBe(400);
    expect((await post({ parentId: lastId, content: 'x', model: 'claude-sonnet-5' })).status).toBe(200);
    expect((await post({ parentId: '01JQ8F9ZZZZZZZZZZZZZZZZZZZ', content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post('junk')).status).toBe(400);
  });

  it('rejects a model whose provider key is missing', async () => {
    const root = await vaultWithCanvas();
    const app = createApp({ dataDir: root, keys: {}, modelFactory: () => mockModel(['x']) });
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentId: null, content: 'x', model: 'claude-opus-5' }) });
    expect(res.status).toBe(400);
    expect(await json<unknown>(res)).toEqual({ error: 'model claude-opus-5 is not available (missing anthropic API key)' });
  });
});
```
(Adjust `readVault` import in `app.test.ts` from `@chatmind/core`.)

- [ ] **Step 2: Run to verify failure** — FAIL (missing modules).

- [ ] **Step 3: Implement**

`apps/server/src/completion.ts`:
```ts
import { readVault, toNodeDto, writeCanvasFile, writeNode, type ContextMessage, type Layout, type MessageNode, type NodeDto } from '@chatmind/core';
import { streamText, type LanguageModel } from 'ai';
import type { VaultLock } from './vault-lock';

export type CompletionEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; node: NodeDto }
  | { type: 'error'; message: string; partial: boolean };

export interface CompletionJob {
  assistantId: string;
  /** Replays past events, then delivers live ones. Returns an unsubscribe function. */
  subscribe(listener: (e: CompletionEvent) => void): () => void;
  finished: Promise<void>;
}

export interface CompletionOptions {
  dataDir: string;
  slug: string;
  assistant: MessageNode; // body '' — filled from the stream
  layout: Layout;
  model: LanguageModel;
  system: string;
  messages: ContextMessage[];
  lock: VaultLock;
}

/**
 * Drives one model completion independently of any HTTP connection: buffers deltas, writes the node once at the
 * end (also on error after ≥1 delta), and publishes events to subscribers with replay.
 */
export function startCompletion(o: CompletionOptions): CompletionJob {
  const history: CompletionEvent[] = [];
  const listeners = new Set<(e: CompletionEvent) => void>();
  const emit = (e: CompletionEvent): void => {
    history.push(e);
    for (const l of listeners) l(e);
  };
  let buffer = '';

  const persist = (): Promise<NodeDto> =>
    o.lock.run(async () => {
      const { canvases } = await readVault(o.dataDir);
      const graph = canvases.find((g) => g.slug === o.slug);
      if (!graph) throw new Error(`canvas ${o.slug} disappeared`);
      const node: MessageNode = { ...o.assistant, body: buffer };
      graph.nodes.set(node.id, node);
      graph.layout.set(node.id, o.layout);
      await writeNode(graph, node.id, o.dataDir);
      await writeCanvasFile(graph, o.dataDir);
      return toNodeDto(node, o.layout);
    });

  const finished = (async () => {
    try {
      const result = streamText({ model: o.model, system: o.system, messages: o.messages });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          buffer += part.text;
          emit({ type: 'delta', text: part.text });
        } else if (part.type === 'error') {
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      }
      emit({ type: 'done', node: await persist() });
    } catch (err) {
      const partial = buffer.length > 0;
      let message = err instanceof Error ? err.message : String(err);
      if (partial) {
        try {
          await persist();
        } catch (writeErr) {
          message += `; and writing the partial node failed: ${String(writeErr)}`;
        }
      }
      emit({ type: 'error', message, partial });
    }
  })();

  return {
    assistantId: o.assistant.id,
    subscribe(listener) {
      for (const e of history) listener(e);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    finished,
  };
}
```
Check `fullStream` part names in `node_modules/ai/dist/index.d.ts` (`text-delta` with `.text` on ai@5+; older used `textDelta`) and adapt.

In `app.ts` add (imports from core: `buildContext`, `isoTimestamp`, `newId`, `placeChild`, `toNodeDto`, `writeCanvasFile`, `writeNode`, `type MessageNode`, `type SendRequest`; `streamSSE` from `hono/streaming`; `startCompletion`, `type CompletionJob`; `findModel`, `isAvailable`):
```ts
const jobs = new Map<string, CompletionJob>();

app.post('/api/canvases/:slug/messages', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<SendRequest> | null;
  const { canvases } = await readOrEmpty(dataDir);
  const graph = canvases.find((g) => g.slug === c.req.param('slug'));
  if (!graph) return c.json({ error: 'canvas not found' }, 404);
  if (!body || typeof body !== 'object') return c.json({ error: 'body must be a JSON object' }, 400);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (content === '') return c.json({ error: 'content must not be empty' }, 400);
  const parentId = body.parentId === null || body.parentId === undefined ? null : String(body.parentId);
  if (parentId !== null && !graph.nodes.has(parentId)) return c.json({ error: 'parentId is not a node of this canvas' }, 400);
  const spec = typeof body.model === 'string' ? findModel(body.model) : undefined;
  if (!spec) return c.json({ error: 'unknown model' }, 400);
  if (!isAvailable(spec, keys)) return c.json({ error: `model ${spec.id} is not available (missing ${spec.provider} API key)` }, 400);

  // 1. user node — written before the model is called
  const userMs = Date.now();
  const user: MessageNode = { id: newId(userMs), role: 'user', parents: parentId === null ? [] : [parentId], created: isoTimestamp(userMs), summary: '', topics: [], body: content };
  const userLayout = placeChild(graph, parentId);
  graph.nodes.set(user.id, user);
  graph.layout.set(user.id, userLayout);
  await lock.run(async () => {
    await writeNode(graph, user.id, dataDir);
    await writeCanvasFile(graph, dataDir);
  });

  // 2. assistant node in memory + context
  const aMs = Date.now();
  const assistant: MessageNode = { id: newId(aMs), role: 'assistant', model: spec.id, parents: [user.id], created: isoTimestamp(aMs), summary: '', topics: [], body: '' };
  const assistantLayout = placeChild(graph, user.id);
  const { system, messages } = buildContext(graph, parentId);
  messages.push({ role: 'user', content });

  // 3. completion runs independently of this response
  const job = startCompletion({ dataDir, slug: graph.slug, assistant, layout: assistantLayout, model: modelFactory(spec), system, messages, lock });
  jobs.set(assistant.id, job);
  void job.finished.finally(() => jobs.delete(assistant.id));

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'user-node', data: JSON.stringify(toNodeDto(user, userLayout)) });
    await stream.writeSSE({ event: 'assistant-start', data: JSON.stringify({ id: assistant.id, model: spec.id, layout: assistantLayout, parents: [user.id], created: assistant.created }) });
    await new Promise<void>((resolve) => {
      const unsubscribe = job.subscribe((e) => {
        const data = e.type === 'delta' ? { text: e.text } : e.type === 'done' ? e.node : { message: e.message, partial: e.partial };
        void stream.writeSSE({ event: e.type, data: JSON.stringify(data) }).catch(() => undefined);
        if (e.type !== 'delta') {
          unsubscribe();
          resolve();
        }
      });
    });
  });
});
```
Register before the `/api/*` 404. Note (known M3 limitation, document in the code comment): the assistant layout is computed against the request-time graph; a completion from another request finishing in between could yield overlapping slots.

- [ ] **Step 4: Run everything, commit**

Run: `pnpm test && pnpm typecheck`
Expected: all green (server ≈ 30 tests).
```bash
git add -A
git commit -m "feat(server): streaming completions via SSE with buffered single write"
```

---

### Task 7: Pure client logic — SSE parser, streaming reducer, keyboard navigation (web)

**Files:**
- Create: `apps/web/src/sse.ts`, `apps/web/src/streams.ts`, `apps/web/src/navigation.ts`
- Test: `apps/web/test/sse.test.ts`, `apps/web/test/streams.test.ts`, `apps/web/test/navigation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }>
  interface StreamState { model: string; text: string; status: 'streaming' | 'error'; error?: string }
  type StreamAction = { type: 'start'; id: string; model: string } | { type: 'delta'; id: string; text: string } | { type: 'done'; id: string } | { type: 'error'; id: string; message: string }
  streamsReducer(state: ReadonlyMap<string, StreamState>, action: StreamAction): Map<string, StreamState>
  applyStreams(dto: CanvasDto, streams: ReadonlyMap<string, StreamState>): CanvasDto   // node bodies replaced by stream text
  type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
  nextSelection(dto: CanvasDto, current: string | null, key: NavKey): string | null
  ```

- [ ] **Step 1: Write the failing tests**

`apps/web/test/sse.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseSseStream } from '../src/sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(ctrl) { for (const c of chunks) ctrl.enqueue(enc.encode(c)); ctrl.close(); } });
}
async function all(chunks: string[]) {
  const out = [];
  for await (const e of parseSseStream(streamOf(chunks))) out.push(e);
  return out;
}

describe('parseSseStream', () => {
  it('parses events split arbitrarily across chunks', async () => {
    expect(await all(['event: delta\nda', 'ta: {"text":"a"}\n\nevent: do', 'ne\ndata: {"id":1}\n\n'])).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'done', data: '{"id":1}' },
    ]);
  });
  it('joins multi-line data, ignores comments, defaults event to "message"', async () => {
    expect(await all([':keepalive\ndata: a\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
  it('flushes a final event without trailing blank line', async () => {
    expect(await all(['event: x\ndata: 1'])).toEqual([{ event: 'x', data: '1' }]);
  });
});
```
`apps/web/test/streams.test.ts`:
```ts
import type { CanvasDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { applyStreams, streamsReducer, type StreamState } from '../src/streams';

describe('streamsReducer', () => {
  it('starts, appends, errors and removes without mutating the previous map', () => {
    const s0 = new Map<string, StreamState>();
    const s1 = streamsReducer(s0, { type: 'start', id: 'a', model: 'm' });
    const s2 = streamsReducer(s1, { type: 'delta', id: 'a', text: 'He' });
    const s3 = streamsReducer(s2, { type: 'delta', id: 'a', text: 'y' });
    expect(s3.get('a')).toEqual({ model: 'm', text: 'Hey', status: 'streaming' });
    expect(s2.get('a')?.text).toBe('He');
    expect(s0.size).toBe(0);
    expect(streamsReducer(s3, { type: 'error', id: 'a', message: 'boom' }).get('a')).toEqual({ model: 'm', text: 'Hey', status: 'error', error: 'boom' });
    expect(streamsReducer(s3, { type: 'done', id: 'a' }).has('a')).toBe(false);
    expect(streamsReducer(s3, { type: 'delta', id: 'zzz', text: 'x' })).toBe(s3);
  });
});

describe('applyStreams', () => {
  const dto: CanvasDto = { slug: 'm', nodes: [{ id: 'a', role: 'assistant', model: 'm', parents: [], created: 'c', summary: '', topics: [], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } }], edges: [], repairs: [] };
  it('replaces bodies of streaming nodes and leaves others untouched', () => {
    const out = applyStreams(dto, new Map([['a', { model: 'm', text: 'live', status: 'streaming' }]]));
    expect(out.nodes[0]!.body).toBe('live');
    expect(applyStreams(dto, new Map())).toBe(dto);
  });
});
```
`apps/web/test/navigation.test.ts`:
```ts
import type { CanvasDto, NodeDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { nextSelection } from '../src/navigation';

const n = (id: string, parents: string[]): NodeDto => ({ id, role: 'user', parents, created: 'c', summary: '', topics: [], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } });
// R1 → A → (B, C); C → D ; second root R2
const dto: CanvasDto = { slug: 'm', nodes: [n('R1', []), n('A', ['R1']), n('B', ['A']), n('C', ['A']), n('D', ['C']), n('R2', [])], edges: [], repairs: [] };

describe('nextSelection', () => {
  it('goes up to the primary parent and stays at a root', () => {
    expect(nextSelection(dto, 'D', 'ArrowUp')).toBe('C');
    expect(nextSelection(dto, 'R1', 'ArrowUp')).toBe('R1');
  });
  it('goes down to the first child (by id) and stays at a leaf', () => {
    expect(nextSelection(dto, 'A', 'ArrowDown')).toBe('B');
    expect(nextSelection(dto, 'B', 'ArrowDown')).toBe('B');
  });
  it('moves between siblings, including between roots, without wrapping', () => {
    expect(nextSelection(dto, 'B', 'ArrowRight')).toBe('C');
    expect(nextSelection(dto, 'C', 'ArrowRight')).toBe('C');
    expect(nextSelection(dto, 'C', 'ArrowLeft')).toBe('B');
    expect(nextSelection(dto, 'R1', 'ArrowRight')).toBe('R2');
  });
  it('selects the first root from nothing on ArrowDown, otherwise stays empty', () => {
    expect(nextSelection(dto, null, 'ArrowDown')).toBe('R1');
    expect(nextSelection(dto, null, 'ArrowUp')).toBeNull();
    expect(nextSelection({ ...dto, nodes: [] }, null, 'ArrowDown')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @chatmind/web test` → FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/sse.ts`:
```ts
export interface SseEvent { event: string; data: string }

/** Minimal text/event-stream parser: `event:` + one or more `data:` lines per blank-line-delimited block. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = function* (block: string): Generator<SseEvent> {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) yield { event, data: data.join('\n') };
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      yield* flush(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== '') yield* flush(buffer);
}
```
`apps/web/src/streams.ts`:
```ts
import type { CanvasDto } from '@chatmind/core';

export interface StreamState { model: string; text: string; status: 'streaming' | 'error'; error?: string }

export type StreamAction =
  | { type: 'start'; id: string; model: string }
  | { type: 'delta'; id: string; text: string }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; message: string };

export function streamsReducer(state: ReadonlyMap<string, StreamState>, action: StreamAction): Map<string, StreamState> {
  const cur = state.get(action.id);
  if (action.type !== 'start' && cur === undefined) return state as Map<string, StreamState>;
  const next = new Map(state);
  switch (action.type) {
    case 'start': next.set(action.id, { model: action.model, text: '', status: 'streaming' }); break;
    case 'delta': next.set(action.id, { ...cur!, text: cur!.text + action.text }); break;
    case 'done': next.delete(action.id); break;
    case 'error': next.set(action.id, { ...cur!, status: 'error', error: action.message }); break;
  }
  return next;
}

/** Overlay live stream text onto the DTO; returns the same object when nothing streams. */
export function applyStreams(dto: CanvasDto, streams: ReadonlyMap<string, StreamState>): CanvasDto {
  if (streams.size === 0) return dto;
  return { ...dto, nodes: dto.nodes.map((n) => (streams.has(n.id) ? { ...n, body: streams.get(n.id)!.text } : n)) };
}
```
`apps/web/src/navigation.ts`:
```ts
import type { CanvasDto, NodeDto } from '@chatmind/core';

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

const byId = (a: NodeDto, b: NodeDto): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const childrenOf = (dto: CanvasDto, id: string | null): NodeDto[] =>
  dto.nodes.filter((n) => (id === null ? n.parents.length === 0 : n.parents[0] === id)).sort(byId);

/** Spec §7 keyboard model. Unknown/absent selection: only ArrowDown selects the first root. */
export function nextSelection(dto: CanvasDto, current: string | null, key: NavKey): string | null {
  const node = current === null ? undefined : dto.nodes.find((n) => n.id === current);
  if (!node) return key === 'ArrowDown' ? (childrenOf(dto, null)[0]?.id ?? null) : null;
  const parentId = node.parents[0] ?? null;
  switch (key) {
    case 'ArrowUp': return parentId ?? node.id;
    case 'ArrowDown': return childrenOf(dto, node.id)[0]?.id ?? node.id;
    case 'ArrowLeft':
    case 'ArrowRight': {
      const siblings = childrenOf(dto, parentId);
      const i = siblings.findIndex((n) => n.id === node.id);
      const j = key === 'ArrowLeft' ? i - 1 : i + 1;
      return siblings[j]?.id ?? node.id;
    }
  }
}
```

- [ ] **Step 4: Run, commit**

Run: `pnpm --filter @chatmind/web test && pnpm typecheck`
```bash
git add apps/web/src/sse.ts apps/web/src/streams.ts apps/web/src/navigation.ts apps/web/test/sse.test.ts apps/web/test/streams.test.ts apps/web/test/navigation.test.ts
git commit -m "feat(web): SSE parser, streaming reducer, keyboard navigation"
```

---

### Task 8: Composer, send flow, streaming visuals, camera, new canvas (web)

**Files:**
- Create: `apps/web/src/Composer.tsx`
- Modify: `apps/web/src/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/GraphView.tsx`, `apps/web/src/MessageNode.tsx`, `apps/web/src/NodePanel.tsx`, `apps/web/src/flow.ts`, `apps/web/src/styles.css`
- Test: `apps/web/test/Composer.test.tsx`, `apps/web/test/App.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 7 modules; `ModelDto`, `SendRequest`, `NodeDto` types; `nextSelection`.
- Produces:
  ```ts
  // api.ts
  fetchModels(): Promise<ModelDto[]>; createCanvas(name: string): Promise<CanvasSummaryDto>; sendMessage(slug: string, req: SendRequest): Promise<Response>
  // Composer.tsx
  <Composer target={NodeDto|null} models={ModelDto[]} model={string} onModelChange={(id)=>void} onSend={(content)=>Promise<void>} sending={boolean} errorLine={string|null} onEscape={()=>void} textareaRef={RefObject<HTMLTextAreaElement>} />
  // flow.ts
  toFlowNodes(dto, streams?: ReadonlyMap<string, StreamState>)  // data gains streaming?: boolean; error?: string
  // GraphView.tsx
  <GraphView … focusIds={string[] | null} />   // pans (fitView on those nodes, duration 300, zoom kept ≤ current) whenever focusIds changes to non-null
  ```

- [ ] **Step 1: Write the failing Composer test**

`apps/web/test/Composer.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/Composer';

const models = [
  { id: 'claude-opus-5', provider: 'anthropic' as const, label: 'Claude Opus 5', available: true },
  { id: 'claude-sonnet-5', provider: 'anthropic' as const, label: 'Claude Sonnet 5', available: true },
  { id: 'x', provider: 'openai' as const, label: 'Unavailable', available: false },
];
const target = { id: 'A', role: 'user' as const, parents: [], created: 'c', summary: 'Ursprungsfrage', topics: [], body: '', layout: { x: 0, y: 0, width: 400, height: 200 } };

function setup(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(async () => undefined);
  const onEscape = vi.fn();
  const onModelChange = vi.fn();
  render(<Composer target={target} models={models} model="claude-opus-5" onModelChange={onModelChange} onSend={onSend} sending={false} errorLine={null} onEscape={onEscape} textareaRef={createRef<HTMLTextAreaElement>()} {...over} />);
  return { onSend, onEscape, onModelChange };
}

describe('Composer', () => {
  it('shows the target, only available models, and the active one', () => {
    setup();
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Ursprungsfrage');
    expect(screen.getByRole('radio', { name: 'Claude Opus 5' })).toBeChecked();
    expect(screen.queryByRole('radio', { name: 'Unavailable' })).toBeNull();
  });
  it('says "New root message" without a target', () => {
    setup({ target: null });
    expect(screen.getByText('New root message')).toBeInTheDocument();
  });
  it('sends on Cmd+Enter / Ctrl+Enter with trimmed text and clears; plain Enter does not send', async () => {
    const { onSend } = setup();
    const box = screen.getByRole('textbox');
    await userEvent.type(box, '  Hallo  ');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith('Hallo');
    await screen.findByDisplayValue('');
    await userEvent.type(box, 'Zwei');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenLastCalledWith('Zwei');
  });
  it('does not send empty text; Escape calls onEscape; model chips call onModelChange', async () => {
    const { onSend, onEscape, onModelChange } = setup();
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Sonnet 5' }));
    expect(onModelChange).toHaveBeenCalledWith('claude-sonnet-5');
  });
  it('shows the no-provider hint and disables sending when no model is available', () => {
    setup({ models: [models[2]!] });
    expect(screen.getByText(/No provider configured/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
  it('shows the error line', () => {
    setup({ errorLine: 'boom' });
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (module missing).

- [ ] **Step 3: Implement the composer and API helpers**

`apps/web/src/api.ts` — add:
```ts
import type { ModelDto, SendRequest } from '@chatmind/core';

export function fetchModels(): Promise<ModelDto[]> {
  return getJson('/api/models');
}

export async function createCanvas(name: string): Promise<CanvasSummaryDto> {
  const res = await fetch('/api/canvases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`);
  return (await res.json()) as CanvasSummaryDto;
}

/** Returns the raw Response so the caller can read the SSE body. */
export function sendMessage(slug: string, req: SendRequest): Promise<Response> {
  return fetch(`/api/canvases/${encodeURIComponent(slug)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
}
```
`apps/web/src/Composer.tsx`:
```tsx
import type { ModelDto, NodeDto } from '@chatmind/core';
import { useState, type KeyboardEvent, type RefObject } from 'react';
import { nodeTitle } from './flow';

export interface ComposerProps {
  target: NodeDto | null;
  models: ModelDto[];
  model: string;
  onModelChange: (id: string) => void;
  onSend: (content: string) => Promise<void>;
  sending: boolean;
  errorLine: string | null;
  onEscape: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function Composer({ target, models, model, onModelChange, onSend, sending, errorLine, onEscape, textareaRef }: ComposerProps) {
  const [text, setText] = useState('');
  const available = models.filter((m) => m.available);
  const canSend = available.length > 0 && text.trim() !== '' && !sending;

  const submit = (): void => {
    if (!canSend) return;
    const content = text.trim();
    setText('');
    void onSend(content);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
    }
  };

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {errorLine && <p className="composer-error" role="alert">{errorLine}</p>}
      <div className="composer-row">
        <span className="target">{target ? <>Replying to: <strong>{nodeTitle(target)}</strong></> : 'New root message'}</span>
        {available.length === 0 ? (
          <span className="no-provider">No provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY (or ~/.config/chatmind/env) and restart chatmind</span>
        ) : (
          <fieldset className="models" aria-label="Model">
            {available.map((m) => (
              <label key={m.id} className={m.id === model ? 'chip active' : 'chip'}>
                <input type="radio" name="model" value={m.id} checked={m.id === model} onChange={() => onModelChange(m.id)} />
                {m.label}
              </label>
            ))}
          </fieldset>
        )}
      </div>
      <div className="composer-row">
        <textarea ref={textareaRef} rows={2} value={text} placeholder="Write a message… (⌘⏎ to send, Esc to return to the graph)" onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} disabled={available.length === 0} />
        <button type="submit" disabled={!canSend}>Send</button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Streaming visuals, camera, and App wiring**

`apps/web/src/flow.ts` — extend:
```ts
import type { StreamState } from './streams';
export type MessageNodeData = { role: NodeDto['role']; model?: string; summary: string; body: string; created: string; streaming?: boolean; error?: string };
export function toFlowNodes(dto: CanvasDto, streams?: ReadonlyMap<string, StreamState>): MessageFlowNode[] {
  return dto.nodes.map((n) => {
    const s = streams?.get(n.id);
    const data: MessageNodeData = { role: n.role, summary: n.summary, body: n.body, created: n.created };
    if (n.model !== undefined) data.model = n.model;
    if (s?.status === 'streaming') data.streaming = true;
    if (s?.status === 'error') data.error = s.error ?? 'error';
    return { id: n.id, type: 'message', position: { x: n.layout.x, y: n.layout.y }, width: n.layout.width, height: n.layout.height, draggable: false, connectable: false, data };
  });
}
```
`apps/web/src/MessageNode.tsx` — class list becomes `` `message-node role-${data.role}${selected ? ' selected' : ''}${data.streaming ? ' streaming' : ''}${data.error ? ' error' : ''}` `` and, when `data.error`, render `<p className="node-error">{data.error}</p>` after the preview; when streaming with empty body, preview shows `…`.

`apps/web/src/GraphView.tsx` — wrap in `ReactFlowProvider` and add a camera effect:
```tsx
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import type { StreamState } from './streams';

interface Props { canvas: CanvasDto; streams: ReadonlyMap<string, StreamState>; selectedId: string | null; onSelect: (id: string | null) => void; focusIds: string[] | null; }

function Camera({ focusIds }: { focusIds: string[] | null }) {
  const rf = useReactFlow();
  useEffect(() => {
    if (!focusIds || focusIds.length === 0) return;
    const zoom = rf.getZoom();
    void rf.fitView({ nodes: focusIds.map((id) => ({ id })), padding: 0.4, duration: 300, minZoom: Math.min(zoom, 1), maxZoom: zoom });
  }, [focusIds, rf]);
  return null;
}

function Inner({ canvas, streams, selectedId, onSelect, focusIds }: Props) {
  const nodes = useMemo(() => toFlowNodes(canvas, streams).map((n) => ({ ...n, selected: n.id === selectedId })), [canvas, streams, selectedId]);
  const edges = useMemo(() => toFlowEdges(canvas), [canvas]);
  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView nodesDraggable={false} nodesConnectable={false} minZoom={0.1} onNodeClick={(_, node) => onSelect(node.id)} onPaneClick={() => onSelect(null)} proOptions={{ hideAttribution: true }}>
      <Background />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
      <Camera focusIds={focusIds} />
    </ReactFlow>
  );
}

export function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
```
(Check `fitView` option names against `node_modules/@xyflow/react/dist/esm/index.d.ts`; in v12 it accepts `{ nodes, padding, duration, minZoom, maxZoom }`.)

`apps/web/src/NodePanel.tsx` — accept `streamError?: string | null` and render `<p className="composer-error" role="alert">{streamError}</p>` above the body when set.

`apps/web/src/App.tsx` — full replacement:
```tsx
import type { CanvasDto, CanvasSummaryDto, ModelDto, NodeDto } from '@chatmind/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createCanvas, fetchCanvas, fetchCanvases, fetchModels, sendMessage } from './api';
import { Composer } from './Composer';
import { GraphView } from './GraphView';
import { nextSelection, type NavKey } from './navigation';
import { NodePanel } from './NodePanel';
import { parseSseStream } from './sse';
import { applyStreams, streamsReducer, type StreamState } from './streams';

const MODEL_KEY = 'chatmind.model';
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export function App() {
  const [canvases, setCanvases] = useState<CanvasSummaryDto[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<CanvasDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelDto[]>([]);
  const [model, setModel] = useState<string>(() => { try { return localStorage.getItem(MODEL_KEY) ?? ''; } catch { return ''; } });
  const [streams, setStreams] = useState<ReadonlyMap<string, StreamState>>(new Map());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [focusIds, setFocusIds] = useState<string[] | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const graphRef = useRef<HTMLElement>(null);

  const reloadCanvases = useCallback(async () => {
    const list = await fetchCanvases();
    setCanvases(list);
    return list;
  }, []);

  useEffect(() => {
    Promise.all([reloadCanvases(), fetchModels()])
      .then(([list, ms]) => {
        setModels(ms);
        const fromUrl = new URLSearchParams(window.location.search).get('canvas');
        setSlug(list.find((c) => c.slug === fromUrl)?.slug ?? list[0]?.slug ?? null);
        const available = ms.filter((m) => m.available);
        setModel((cur) => (available.some((m) => m.id === cur) ? cur : (available[0]?.id ?? '')));
      })
      .catch((e: unknown) => setError(String(e)));
  }, [reloadCanvases]);

  useEffect(() => {
    if (slug === null) return;
    let cancelled = false;
    setCanvas(null);
    setCanvasError(null);
    setSelectedId(null);
    setStreams(new Map());
    setFocusIds(null);
    fetchCanvas(slug)
      .then((c) => { if (!cancelled) setCanvas(c); })
      .catch((e: unknown) => { if (!cancelled) setCanvasError(String(e)); });
    return () => { cancelled = true; };
  }, [slug]);

  const chooseModel = (id: string): void => {
    setModel(id);
    try { localStorage.setItem(MODEL_KEY, id); } catch { /* per-viewer convenience only */ }
  };

  // Graph-level keyboard model (spec §7). Ignored while typing in an input/textarea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (!canvas) return;
      if (NAV_KEYS.has(e.key)) {
        e.preventDefault();
        const next = nextSelection(canvas, selectedId, e.key as NavKey);
        setSelectedId(next);
        if (next) setFocusIds([next]);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        textareaRef.current?.focus();
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canvas, selectedId]);

  const send = async (content: string): Promise<void> => {
    if (!slug || !canvas) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await sendMessage(slug, { parentId: selectedId, content, model });
      if (!res.ok || !res.body) {
        const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`;
        setSendError(`Could not send: ${msg}`);
        return;
      }
      for await (const ev of parseSseStream(res.body)) {
        const data = JSON.parse(ev.data) as never;
        switch (ev.event) {
          case 'user-node': {
            const node = data as NodeDto;
            setCanvas((c) => (c ? { ...c, nodes: [...c.nodes, node], edges: node.parents[0] ? [...c.edges, { id: `e-${node.parents[0]}-${node.id}`, from: node.parents[0], to: node.id }] : c.edges } : c));
            break;
          }
          case 'assistant-start': {
            const s = data as { id: string; model: string; layout: NodeDto['layout']; parents: string[]; created: string };
            const node: NodeDto = { id: s.id, role: 'assistant', model: s.model, parents: s.parents, created: s.created, summary: '', topics: [], body: '', layout: s.layout };
            setCanvas((c) => (c ? { ...c, nodes: [...c.nodes, node], edges: [...c.edges, { id: `e-${s.parents[0]}-${s.id}`, from: s.parents[0]!, to: s.id }] } : c));
            setStreams((st) => streamsReducer(st, { type: 'start', id: s.id, model: s.model }));
            setSelectedId(s.id);
            setFocusIds([s.parents[0]!, s.id]);
            break;
          }
          case 'delta': {
            const d = data as { text: string };
            setStreams((st) => { const id = [...st.keys()].at(-1); return id ? streamsReducer(st, { type: 'delta', id, text: d.text }) : st; });
            break;
          }
          case 'done': {
            const node = data as NodeDto;
            setCanvas((c) => (c ? { ...c, nodes: c.nodes.map((n) => (n.id === node.id ? node : n)) } : c));
            setStreams((st) => streamsReducer(st, { type: 'done', id: node.id }));
            break;
          }
          case 'error': {
            const err = data as { message: string; partial: boolean };
            setStreams((st) => { const id = [...st.keys()].at(-1); return id ? streamsReducer(st, { type: 'error', id, message: err.message }) : st; });
            break;
          }
        }
      }
    } catch (e) {
      setSendError(`Could not send: ${String(e)}`);
    } finally {
      setSending(false);
    }
  };
```
Note on `delta`/`error` routing: the SSE stream of one send only ever concerns one assistant id, so track it in a local `let assistantId: string | null = null` set on `assistant-start` and use that instead of `[...st.keys()].at(-1)` — do that (the snippet above is the fallback; prefer the local variable).

Render part (replacing the old return):
```tsx
  if (error) return <main className="empty">Could not reach the chatmind server: {error}</main>;
  if (canvases === null) return <main className="empty">Loading…</main>;

  const live = canvas ? applyStreams(canvas, streams) : null;
  const selected = live?.nodes.find((n) => n.id === selectedId) ?? null;
  const selectedStream = selectedId ? streams.get(selectedId) : undefined;

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Canvases">
        <h1>chatmind</h1>
        <ul>
          {canvases.map((c) => (
            <li key={c.slug}>
              <button type="button" className={c.slug === slug ? 'active' : ''} onClick={() => setSlug(c.slug)}>
                {c.slug} <span className="count">{c.nodeCount}</span>
              </button>
            </li>
          ))}
        </ul>
        {newName === null ? (
          <button type="button" className="new-canvas" onClick={() => setNewName('')}>+ New canvas</button>
        ) : (
          <form className="new-canvas-form" onSubmit={async (e) => { e.preventDefault(); try { const created = await createCanvas(newName); await reloadCanvases(); setNewName(null); setSlug(created.slug); } catch (err) { setSendError(`Could not create canvas: ${String(err)}`); } }}>
            <input autoFocus aria-label="Canvas name" value={newName} placeholder="Canvas name" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setNewName(null); }} />
            <button type="submit" disabled={newName.trim() === ''}>Create</button>
          </form>
        )}
        {canvases.length === 0 && <p className="hint">No canvases yet — create one above.</p>}
      </nav>
      <main className="graph" ref={graphRef} tabIndex={-1}>
        {canvasError ? (
          <p className="empty" role="alert">Could not load canvas "{slug}": {canvasError}</p>
        ) : live ? (
          <>
            {live.repairs.length > 0 && (
              <div className="banner" role="status">{live.repairs.length} repair{live.repairs.length === 1 ? '' : 's'} pending — run <code>pnpm cli check</code></div>
            )}
            <GraphView canvas={live} streams={streams} selectedId={selectedId} onSelect={setSelectedId} focusIds={focusIds} />
            <span hidden data-testid="canvas-loaded">{live.nodes.length} nodes</span>
          </>
        ) : slug ? (
          <p className="empty">Loading canvas…</p>
        ) : (
          <p className="empty">Create a canvas to start.</p>
        )}
        {slug && (
          <Composer target={selected} models={models} model={model} onModelChange={chooseModel} onSend={send} sending={sending} errorLine={sendError} onEscape={() => { textareaRef.current?.blur(); graphRef.current?.focus(); }} textareaRef={textareaRef} />
        )}
      </main>
      <NodePanel node={selected} streamError={selectedStream?.status === 'error' ? (selectedStream.error ?? 'error') : null} />
    </div>
  );
}
```
Append to `apps/web/src/styles.css`:
```css
.graph { display: flex; flex-direction: column; }
.graph > .react-flow { flex: 1; min-height: 0; }
.composer { border-top: 1px solid var(--border); background: var(--panel); padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.composer-row { display: flex; gap: 8px; align-items: center; }
.composer textarea { flex: 1; resize: vertical; min-height: 44px; max-height: 200px; font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); }
.composer button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--accent); color: #fff; cursor: pointer; }
.composer button:disabled { opacity: 0.5; cursor: default; }
.composer .target { color: var(--muted); font-size: 12px; flex: 1; }
.composer .models { display: flex; gap: 4px; border: 0; padding: 0; margin: 0; }
.composer .chip { font-size: 12px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; cursor: pointer; }
.composer .chip.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.composer .chip input { position: absolute; opacity: 0; width: 0; height: 0; }
.composer .no-provider, .composer-error { color: #b42318; font-size: 12px; margin: 0; }
.message-node.streaming { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--accent); } 50% { box-shadow: 0 0 0 3px var(--accent); } }
.message-node.error { border-color: #b42318; }
.node-error { color: #b42318; font-size: 11px; margin: 0; }
.new-canvas { margin-top: 8px; }
.new-canvas-form { display: flex; gap: 4px; margin-top: 8px; }
.new-canvas-form input { flex: 1; min-width: 0; }
.hint { color: var(--muted); font-size: 12px; }
```

- [ ] **Step 5: Extend the App tests**

In `apps/web/test/App.test.tsx`, extend `stubFetch()` so `/api/models` returns `[{ id: 'claude-opus-5', provider: 'anthropic', label: 'Claude Opus 5', available: true }]` and `POST …/messages` returns an SSE `Response` built from a `ReadableStream` of this text (ids: user `01JQ8F6000000000000000000A`, assistant `01JQ8F6000000000000000000B`):
```
event: user-node
data: {"id":"01JQ8F6000000000000000000A","role":"user","parents":["01JQ8F3K2M9XZP4V7NBHRCAAAA"],"created":"c","summary":"","topics":[],"body":"Und weiter?","layout":{"x":0,"y":560,"width":400,"height":200}}

event: assistant-start
data: {"id":"01JQ8F6000000000000000000B","model":"claude-opus-5","layout":{"x":0,"y":840,"width":400,"height":200},"parents":["01JQ8F6000000000000000000A"],"created":"c"}

event: delta
data: {"text":"Hel"}

event: delta
data: {"text":"lo"}

event: done
data: {"id":"01JQ8F6000000000000000000B","role":"assistant","model":"claude-opus-5","parents":["01JQ8F6000000000000000000A"],"created":"c","summary":"","topics":[],"body":"Hello","layout":{"x":0,"y":840,"width":400,"height":200}}

```
and add:
```tsx
  it('sends from the composer and shows the streamed answer', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Zentroid'));           // select node B as target
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Und weiter?');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('4 nodes'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Hello' })).toBeInTheDocument(); // assistant selected → panel shows it
    const sent = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith('/messages'));
    expect(JSON.parse((sent![1] as RequestInit).body as string)).toEqual({ parentId: '01JQ8F3K2M9XZP4V7NBHRCAAAA', content: 'Und weiter?', model: 'claude-opus-5' });
  });

  it('navigates with arrow keys and focuses the composer on Enter', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.keyDown(window, { key: 'ArrowDown' });               // first root (A)
    expect(await screen.findByText(/Replying to:/)).toHaveTextContent('Ursprungsfrage');
    fireEvent.keyDown(window, { key: 'ArrowDown' });               // child B
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Zentroid');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('textbox')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.getByRole('textbox')).not.toHaveFocus();
  });

  it('creates a new canvas from the sidebar', async () => {
    stubFetch(); // extend the stub: POST /api/canvases → 201 {slug:'neu',nodeCount:0}; afterwards GET /api/canvases includes it and GET /api/canvases/neu → empty canvas
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: '+ New canvas' }));
    await userEvent.type(screen.getByLabelText('Canvas name'), 'Neu');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('button', { name: /^neu/ })).toHaveClass('active');
  });
```
(The existing "renders the graph and opens a node" test keeps passing; the old empty-state test changes: with zero canvases the sidebar now shows "No canvases yet — create one above." — update that assertion.)

- [ ] **Step 6: Run everything, build**

Run: `pnpm test && pnpm typecheck && pnpm --filter @chatmind/web build`
Expected: green. If the jsdom/React Flow camera effect throws on `fitView` (no layout in jsdom), guard `Camera` with `if (typeof ResizeObserver === 'undefined') return;` is NOT the fix — instead wrap the `fitView` call in `try/catch` and keep it; report.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): composer, keyboard model, streaming nodes, camera, new canvas"
```

---

### Task 9: Manual M3 gate — keyboard-only branching conversation

Manual; the milestone's done condition. Do not proceed to Task 10 before it is complete.

- [ ] **Step 1: Keys and start**

Ask the user to provide at least one key: `ANTHROPIC_API_KEY` (and optionally `OPENROUTER_API_KEY`/`OPENAI_API_KEY`) either exported in the shell that runs `pnpm dev` or in `~/.config/chatmind/env`. Run `pnpm dev`; the server log must list the providers. Open `http://localhost:5173`.

- [ ] **Step 2: Ask the user to verify (no mouse after step 1)**

1. Press `↓` → the first node of `masterarbeit` is selected, composer says "Replying to: …".
2. Press `Enter`, type a follow-up, `⌘⏎`: user node appears immediately below, an assistant card with pulsing border streams text; the camera pans once; the panel shows the growing text.
3. Press `Esc` (composer → graph), `↑` twice, `Enter`, type another message, choose another model with the mouse-free way (Tab to the chips? — if chips aren't keyboard-reachable, note it), `⌘⏎` → a **second branch** appears to the right.
4. `←`/`→` move between the two branches; `↑` returns to the common parent.
5. Sidebar "+ New canvas" → name → the empty canvas opens; composer says "New root message"; send → root node + answer.
6. Open Obsidian: the new nodes and edges are there, the branch renders side by side, the new canvas exists. Run `pnpm cli check` → no repairs.
7. Kill the network mid-stream (or use an invalid key for one provider) → the error state shows and any partial text is kept.

- [ ] **Step 3: Record findings and fix**

Write `docs/superpowers/notes/2026-09-12-m3-gate-findings.md` (browser, providers used, each step yes/no, issues, changes, verdict). Fix what the user reported (TDD for logic), rerun `pnpm test && pnpm typecheck`, commit.

---

### Task 10: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

Add after "## Run":
```markdown
## API keys

chatmind reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY` from the environment, falling back to `~/.config/chatmind/env` (one `KEY=VALUE` per line). At least one is needed to chat; the composer lists only models whose provider key is present. Keys never go into the data folder.
```
Change the Status line to `Status: cycle 3 (composer, branching, streaming). No merge/summaries yet.` and add to "## Run" a line `Keyboard: ↑↓←→ move between nodes, Enter → composer, ⌘⏎ send, Esc back.`

- [ ] **Step 2: Verify, commit**

Run: `pnpm test && pnpm typecheck`
```bash
git add README.md
git commit -m "docs: API keys and keyboard usage"
```

---

## Self-review against the spec

- §2 decisions: AI SDK + three providers (T4), one model per send (T6/T8), keys (T4), new canvas (T5/T8), SSE via fetch (T6/T7/T8), write policy + lock (T5/T6), layout (T1), camera (T8), keyboard (T7/T8), context (T2), summaries empty (T6 nodes).
- §4 API: `GET /api/models` (T4), `POST /api/canvases` (T5), `POST …/messages` events/validation/semantics (T6).
- §5 layout property (T1). §6 context (T2). §7 frontend behaviours (T8). §8 tests (T1–T8 + gate T9).
- Names consistent: `placeChild`, `buildContext`, `writeNode`/`writeCanvasFile`, `toNodeDto`, `ModelDto`/`SendRequest`, `loadKeys`, `MODELS`/`findModel`/`isAvailable`/`modelDtos`, `createModelFactory`/`ModelFactory`, `VaultLock.run`, `startCompletion`/`CompletionEvent`/`CompletionJob`, `parseSseStream`, `streamsReducer`/`applyStreams`/`StreamState`, `nextSelection`, `Composer` props, `GraphView` `streams`/`focusIds`, `NodePanel` `streamError`.
- Known limitation recorded in code (T6): concurrent completions may get overlapping slots.
