# Cycle 4 (M4): Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user selects several nodes as the targets of one message; the model answers with all of their branches in context (common prefix once, then labelled blocks); every node entering the prompt is highlighted and individually excludable; a token meter shows what will be sent; the resulting user node carries all parents and survives round-trip + Obsidian.

**Architecture:** Core gains a browser-safe entry (`@chatmind/core/graph`) exposing pure graph logic on a structural `GraphLike` view, so browser and server run the *same* `contextSet`/`buildContext`/`promptTokens`. `buildContext` grows from "ancestor chain + instruction" to "common prefix as turns + one user turn with preamble, `##`-labelled blocks and the instruction". The server's send endpoint takes `parentIds`/`excludedIds` and validates them with core's `validateTargets`. The web app separates cursor (navigation) from targets (ordered) and exclusions, renders badges, a ghost merge node, dashed secondary edges, and a token meter in the composer.

**Tech Stack:** as cycles 1–3 (TypeScript, pnpm workspaces, vitest, fast-check, Hono, React 19, `@xyflow/react` 12, AI SDK 7). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-13-chatmind-m4-merge-design.md` (binding), on top of the cycle-1 spec (invariants), the M2 spec and the M3 spec.

## Global Constraints

- Node `>=22.22.2`; shells: `put Node 22 and pnpm on `PATH` (e.g. `nvm use`)`.
- `@chatmind/core` runtime deps stay `js-yaml`, `ulid`, Node built-ins. `apps/web` imports runtime code **only** from `@chatmind/core/graph` (never from the default entry, which pulls `node:fs`).
- Files are the truth; `parents` in frontmatter is the only source of structure (cycle-1 §3.1/§3.6). Reader never writes, never deletes structure.
- Invariant: `role: assistant` ⇒ `parents.length === 1` — reported by the reader as `assistant-parents`, never enforced by mutation.
- `parents[0]` is layout only; the context builder treats all parents symmetrically, their order = block order.
- Context format (spec §4.4): prefix turns, then **one** user turn = preamble + `## label` blocks (`**Role:** body` lines) + instruction. Single target = byte-identical to the M3 prompt. Preamble texts and role labels exactly as in spec §4.4.
- Tokens: `estimateTokens = ceil(len / 3.5)`, `promptTokens` over the rendered prompt (+4 per message), budget = `contextTokens − 16 000`. Over budget ⇒ Send disabled. No automatic compression.
- API: `{ parentIds: string[]; excludedIds?: string[]; content; model }`; `parentIds: []` = root. No `parentId` compatibility.
- Keyboard: as M3 plus `Space` = toggle participation of the cursor node; `Esc` clears cursor, targets and exclusions. Moving the cursor never changes targets/exclusions.
- UI copy: English by default; the preamble, role labels, block fallback labels, merge placeholder, over-budget line, ghost text and context badge follow `detectLanguage` (`'de' | 'en'`).
- TDD per task; commit per task with the session's attribution trailer:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0123duu1q9V4tEHvb1XTKJRY
  ```
- Run `pnpm typecheck && pnpm test` at the end of every task before committing.

## File Map

| Path | Responsibility |
|---|---|
| `packages/core/package.json` | `exports`: `.` (full) and `./graph` (browser-safe) |
| `packages/core/src/graph.ts` | browser-safe re-exports (types, `graph-like`, `layout`, `title`, `context`, `language`, `tokens`) |
| `packages/core/src/graph-like.ts` | `NodeLike`, `GraphLike`, `graphLikeFromDto` |
| `packages/core/src/title.ts` | `nodeTitle` (moved from web) |
| `packages/core/src/layout.ts` | signatures generalised to `GraphLike` |
| `packages/core/src/context.ts` | `ancestorChain`, `isAncestor`, `contextSet`, `validateTargets`, `blockLabels`, `buildContext`, `PREAMBLE`, `ROLE_LABELS` |
| `packages/core/src/language.ts` | `detectLanguage`, `Language` |
| `packages/core/src/tokens.ts` | `estimateTokens`, `promptTokens`, `budgetFor`, `formatTokens`, `OUTPUT_RESERVE` |
| `packages/core/src/types.ts` | + `Repair 'assistant-parents'` |
| `packages/core/src/vault/read.ts` | + assistant-parents check |
| `packages/core/src/dto.ts` | `ModelDto.contextTokens`, `SendRequest.parentIds/excludedIds` |
| `apps/cli/src/check.ts` | + `assistant-parents` line |
| `apps/server/src/models.ts` | `contextTokens` per model |
| `apps/server/src/app.ts` | `POST …/messages` with `parentIds`/`excludedIds` + `validateTargets` |
| `apps/web/src/selection.ts` | `SelectionState`, `clearSelection`, `effectiveTargets`, `toggleParticipation` |
| `apps/web/src/flow.ts` | marks → node flags, ghost node, primary/secondary edges |
| `apps/web/src/GhostNode.tsx` | dashed merge preview card |
| `apps/web/src/MessageNode.tsx` | target badge, context badge (button), excluded dimming |
| `apps/web/src/GraphView.tsx` | ghost node type, ⇧-click, badge click, pane click |
| `apps/web/src/Composer.tsx` | `targets[]` chip, language placeholder, token meter, over-budget gate |
| `apps/web/src/App.tsx` | selection state, Space/Esc, derived context, send with `parentIds` |
| `apps/web/src/styles.css` | badges, ghost, secondary edges, meter |

---

### Task 1: Browser-safe core entry, `GraphLike`, `nodeTitle` in core

**Files:**
- Modify: `packages/core/package.json`
- Create: `packages/core/src/graph.ts`, `packages/core/src/graph-like.ts`, `packages/core/src/title.ts`
- Modify: `packages/core/src/layout.ts`, `packages/core/src/context.ts`, `packages/core/src/index.ts`
- Modify: `apps/web/src/flow.ts`
- Test: `packages/core/test/graph-like.test.ts`, `packages/core/test/title.test.ts`, `apps/web/test/flow.test.ts`

**Interfaces:**
- Consumes: `CanvasDto`, `NodeDto` (`dto.ts`), `Layout`, `NodeId`, `Role`, `MessageNode` (`types.ts`).
- Produces:
  ```ts
  // graph-like.ts
  interface NodeLike { id: NodeId; role: Role; parents: NodeId[]; body: string; summary: string }
  interface GraphLike<N extends NodeLike = NodeLike> { nodes: ReadonlyMap<NodeId, N>; layout: ReadonlyMap<NodeId, Layout> }
  graphLikeFromDto(dto: CanvasDto): GraphLike<NodeDto>
  // title.ts
  nodeTitle(n: { summary: string; body: string }): string
  // layout.ts (same behaviour, wider types)
  childrenOf<N extends NodeLike>(graph: GraphLike<N>, id: NodeId): N[]
  rootsOf<N extends NodeLike>(graph: GraphLike<N>): N[]
  subtreeExtentRight(graph: GraphLike, id: NodeId): number
  placeChild(graph: GraphLike, parentId: NodeId | null): Layout
  // context.ts
  ancestorChain<N extends NodeLike>(graph: GraphLike<N>, id: NodeId): N[]
  ```
  Module specifier `@chatmind/core/graph` resolves in web, server and vitest.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/graph-like.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { CanvasDto } from '../src/dto';
import { graphLikeFromDto } from '../src/graph-like';
import { placeChild } from '../src/layout';

const dto: CanvasDto = {
  slug: 'm',
  nodes: [
    { id: 'A', role: 'user', parents: [], created: 'c', summary: 'Frage', topics: [], body: 'Body A', layout: { x: 0, y: 0, width: 400, height: 200 } },
    { id: 'B', role: 'assistant', model: 'm1', parents: ['A'], created: 'c', summary: '', topics: [], body: 'Body B', layout: { x: 0, y: 280, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-A-B', from: 'A', to: 'B' }],
  repairs: [],
};

describe('graphLikeFromDto', () => {
  it('indexes nodes and layouts by id, keeping the DTO objects', () => {
    const g = graphLikeFromDto(dto);
    expect([...g.nodes.keys()]).toEqual(['A', 'B']);
    expect(g.nodes.get('B')).toBe(dto.nodes[1]);
    expect(g.layout.get('B')).toEqual({ x: 0, y: 280, width: 400, height: 200 });
  });
  it('is accepted by the layout functions', () => {
    expect(placeChild(graphLikeFromDto(dto), 'B')).toEqual({ x: 0, y: 560, width: 400, height: 200 });
  });
});
```

`packages/core/test/title.test.ts` (moved from `apps/web/test/flow.test.ts`):
```ts
import { describe, expect, it } from 'vitest';
import { nodeTitle } from '../src/title';

describe('nodeTitle', () => {
  it('prefers the summary', () => expect(nodeTitle({ summary: 'S', body: 'B' })).toBe('S'));
  it('falls back to the first non-empty body line, capped at 80 chars', () => {
    expect(nodeTitle({ summary: '', body: '\n\nErste Zeile\nZweite' })).toBe('Erste Zeile');
    expect(nodeTitle({ summary: '', body: 'x'.repeat(100) })).toBe('x'.repeat(79) + '…');
  });
  it('is "(empty)" for an empty message', () => expect(nodeTitle({ summary: '', body: '  ' })).toBe('(empty)'));
});
```

In `apps/web/test/flow.test.ts`: delete the `describe('nodeTitle', …)` block and drop `nodeTitle` from the import (it moves to core; `flow.ts` keeps re-exporting it for the components).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/core test -- graph-like title`
Expected: FAIL — `Cannot find module '../src/graph-like'` / `'../src/title'`.

- [ ] **Step 3: Implement**

`packages/core/src/graph-like.ts`:
```ts
import type { CanvasDto, NodeDto } from './dto';
import type { Layout, NodeId, Role } from './types';

/**
 * The structural view the pure graph functions (layout, context, tokens) need. `CanvasGraph` satisfies it,
 * and the browser builds one from a `CanvasDto` — so both sides run the same code on the same shape.
 */
export interface NodeLike {
  id: NodeId;
  role: Role;
  parents: NodeId[];
  body: string;
  summary: string;
}

export interface GraphLike<N extends NodeLike = NodeLike> {
  nodes: ReadonlyMap<NodeId, N>;
  layout: ReadonlyMap<NodeId, Layout>;
}

export function graphLikeFromDto(dto: CanvasDto): GraphLike<NodeDto> {
  return {
    nodes: new Map(dto.nodes.map((n) => [n.id, n])),
    layout: new Map(dto.nodes.map((n) => [n.id, n.layout])),
  };
}
```

`packages/core/src/title.ts` (moved verbatim from `apps/web/src/flow.ts`):
```ts
const TITLE_MAX = 80;

/** Summary if present, else the first non-empty body line (capped), else "(empty)". */
export function nodeTitle(n: { summary: string; body: string }): string {
  if (n.summary !== '') return n.summary;
  const line = n.body.split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (line === undefined) return '(empty)';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}
```

`packages/core/src/layout.ts` — replace the imports and the four signatures (bodies unchanged):
```ts
import type { GraphLike, NodeLike } from './graph-like';
import type { Layout, NodeId } from './types';
// placeholderLayout: change the first parameter type to `node: { parents: NodeId[] }` (MessageNode still fits).
// byId: make it generic — `function byId<N extends { id: string }>(a: N, b: N): number`.
export function childrenOf<N extends NodeLike>(graph: GraphLike<N>, id: NodeId): N[] { /* unchanged body */ }
export function rootsOf<N extends NodeLike>(graph: GraphLike<N>): N[] { /* unchanged body */ }
export function subtreeExtentRight(graph: GraphLike, id: NodeId): number { /* unchanged body */ }
export function placeChild(graph: GraphLike, parentId: NodeId | null): Layout { /* unchanged body */ }
```
(`columnLayout` and `rectsOverlap` are untouched. Remove the now-unused `CanvasGraph`/`MessageNode` type imports.)

`packages/core/src/context.ts` — widen `ancestorChain` and `buildContext` (the M3 `buildContext` signature stays until Task 3):
```ts
import type { GraphLike, NodeLike } from './graph-like';
import type { NodeId, Role } from './types';

export function ancestorChain<N extends NodeLike>(graph: GraphLike<N>, id: NodeId): N[] {
  const chain: N[] = [];
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

export function buildContext(graph: GraphLike, parentId: NodeId | null): { system: string; messages: ContextMessage[] } { /* unchanged body */ }
```

`packages/core/src/graph.ts`:
```ts
/**
 * Browser-safe entry (`@chatmind/core/graph`): pure graph logic only. Nothing here may import `node:*`
 * or the vault modules — the web app runs this code on a CanvasDto (spec M4 §4.1).
 */
export type { NodeId, Role, Layout, MessageNode, CanvasGraph, Repair } from './types';
export type { NodeDto, EdgeDto, CanvasDto, CanvasSummaryDto, ModelDto, SendRequest, Provider } from './dto';
export { type NodeLike, type GraphLike, graphLikeFromDto } from './graph-like';
export { NODE_WIDTH, NODE_HEIGHT, NODE_GAP, placeChild, childrenOf, rootsOf, subtreeExtentRight, rectsOverlap } from './layout';
export { nodeTitle } from './title';
export { SYSTEM_PROMPT, ancestorChain, buildContext, type ContextMessage } from './context';
```

`packages/core/src/index.ts` — add:
```ts
export { type NodeLike, type GraphLike, graphLikeFromDto } from './graph-like';
export { nodeTitle } from './title';
```

`packages/core/package.json` — add after `"types"`:
```json
"exports": {
  ".": "./src/index.ts",
  "./graph": "./src/graph.ts"
},
```

`apps/web/src/flow.ts` — remove the local `TITLE_MAX`/`nodeTitle`, and add at the top:
```ts
import { nodeTitle } from '@chatmind/core/graph';
export { nodeTitle };
```
(Keep `import type { CanvasDto, NodeDto } from '@chatmind/core';` — type-only imports from the default entry are fine.)

- [ ] **Step 4: Run tests, typecheck, and a web build**

Run: `pnpm typecheck && pnpm test`
Expected: all green (core: new tests pass, `layout`/`context` tests unchanged; web: `flow.test.ts` passes via the re-export).

Run: `pnpm --filter @chatmind/web build 2>&1 | tee /tmp/web-build.log; grep -i "node:\|externalized" /tmp/web-build.log; echo "exit ${PIPESTATUS[0]}"`
Expected: build succeeds and prints **no** "Module "node:fs" has been externalized" warning. If it does, a runtime import leaked from the default entry — find it with `grep -rn "from '@chatmind/core'" apps/web/src | grep -v "import type"` and route it via `/graph`.

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/web/src/flow.ts apps/web/test/flow.test.ts
git commit -m "feat(core): browser-safe graph entry, GraphLike view, nodeTitle in core"
```

---

### Task 2: `contextSet`, `isAncestor`, `validateTargets` (core)

**Files:**
- Modify: `packages/core/src/context.ts`, `packages/core/src/graph.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/context-set.test.ts`

**Interfaces:**
- Consumes: `ancestorChain`, `GraphLike`, `NodeLike` (Task 1).
- Produces:
  ```ts
  interface ContextSegment<N extends NodeLike = NodeLike> { target: N; nodes: N[] }
  interface ContextSet<N extends NodeLike = NodeLike> { prefix: N[]; segments: ContextSegment<N>[]; all: Set<NodeId>; excluded: Set<NodeId> }
  contextSet<N extends NodeLike>(graph: GraphLike<N>, targets: readonly NodeId[], excluded: readonly NodeId[]): ContextSet<N>
  isAncestor(graph: GraphLike, ancestorId: NodeId, id: NodeId): boolean   // strict: a node is not its own ancestor
  validateTargets(graph: GraphLike, targets: readonly NodeId[], excluded: readonly NodeId[]): string | null
  ```
  Semantics (spec §4.2): `segments` has one entry per *known* target in target order; with one target its `nodes` is empty and `prefix` is the whole chain. Unknown targets are skipped by `contextSet` (validation is `validateTargets`' job). `excluded` in the result is `excluded ∩ all`; `prefix`/`segments` are **not** filtered by it.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/context-set.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { contextSet, isAncestor, validateTargets } from '../src/context';
import type { GraphLike } from '../src/graph-like';
import { node } from './helpers';

// R → U1 → A1 → U1b        (branch 1, three deep)
// R → U2 → A2               (branch 2)
// X → Y                     (separate root)
function graph(): GraphLike {
  const ns = [
    node({ id: 'R', body: 'root question' }),
    node({ id: 'U1', parents: ['R'], body: 'u1' }),
    node({ id: 'A1', role: 'assistant', parents: ['U1'], body: 'a1', summary: 'Gliederung' }),
    node({ id: 'U1b', parents: ['A1'], body: 'u1b' }),
    node({ id: 'U2', parents: ['R'], body: 'u2' }),
    node({ id: 'A2', role: 'assistant', parents: ['U2'], body: 'a2' }),
    node({ id: 'X', body: 'x' }),
    node({ id: 'Y', role: 'assistant', parents: ['X'], body: 'y' }),
  ];
  return { nodes: new Map(ns.map((n) => [n.id, n])), layout: new Map() };
}
const ids = (ns: { id: string }[]) => ns.map((n) => n.id);

describe('contextSet', () => {
  it('one target: the whole chain is the prefix and the segment is empty', () => {
    const s = contextSet(graph(), ['U1b'], []);
    expect(ids(s.prefix)).toEqual(['R', 'U1', 'A1', 'U1b']);
    expect(s.segments).toHaveLength(1);
    expect(s.segments[0]!.target.id).toBe('U1b');
    expect(s.segments[0]!.nodes).toEqual([]);
    expect([...s.all]).toEqual(['R', 'U1', 'A1', 'U1b']);
  });
  it('two siblings: prefix up to the parent, one-node segments in target order', () => {
    const s = contextSet(graph(), ['U2', 'U1'], []);
    expect(ids(s.prefix)).toEqual(['R']);
    expect(s.segments.map((seg) => [seg.target.id, ids(seg.nodes)])).toEqual([['U2', ['U2']], ['U1', ['U1']]]);
  });
  it('deep branches: segments start below the LCA', () => {
    const s = contextSet(graph(), ['U1b', 'A2'], []);
    expect(ids(s.prefix)).toEqual(['R']);
    expect(ids(s.segments[0]!.nodes)).toEqual(['U1', 'A1', 'U1b']);
    expect(ids(s.segments[1]!.nodes)).toEqual(['U2', 'A2']);
    expect(s.all).toEqual(new Set(['R', 'U1', 'A1', 'U1b', 'U2', 'A2']));
  });
  it('no common root: empty prefix, everything in segments', () => {
    const s = contextSet(graph(), ['A1', 'Y'], []);
    expect(s.prefix).toEqual([]);
    expect(ids(s.segments[0]!.nodes)).toEqual(['R', 'U1', 'A1']);
    expect(ids(s.segments[1]!.nodes)).toEqual(['X', 'Y']);
  });
  it('keeps excluded nodes in the structure and reports the ones inside the set', () => {
    const s = contextSet(graph(), ['U1b', 'A2'], ['R', 'A1', 'X']);
    expect(ids(s.prefix)).toEqual(['R']);
    expect(ids(s.segments[0]!.nodes)).toEqual(['U1', 'A1', 'U1b']);
    expect(s.excluded).toEqual(new Set(['R', 'A1']));
  });
  it('skips unknown targets and handles no targets', () => {
    expect(contextSet(graph(), ['nope'], []).segments).toEqual([]);
    expect(contextSet(graph(), [], []).all.size).toBe(0);
  });
});

describe('isAncestor', () => {
  it('follows the primary parent and is strict', () => {
    expect(isAncestor(graph(), 'R', 'U1b')).toBe(true);
    expect(isAncestor(graph(), 'U1b', 'R')).toBe(false);
    expect(isAncestor(graph(), 'U1', 'U1')).toBe(false);
    expect(isAncestor(graph(), 'X', 'U1')).toBe(false);
  });
});

describe('validateTargets', () => {
  it('accepts valid sets', () => {
    expect(validateTargets(graph(), ['U1b', 'A2'], ['R', 'A1'])).toBeNull();
    expect(validateTargets(graph(), [], [])).toBeNull();
    expect(validateTargets(graph(), ['U1b'], [])).toBeNull();
  });
  it('rejects unknown, duplicate and nested targets', () => {
    expect(validateTargets(graph(), ['nope'], [])).toMatch(/unknown node nope/);
    expect(validateTargets(graph(), ['U1', 'U1'], [])).toMatch(/duplicate/);
    expect(validateTargets(graph(), ['U1', 'U1b'], [])).toMatch(/U1 is an ancestor of target U1b/);
  });
  it('rejects exclusions outside the set or on a target', () => {
    expect(validateTargets(graph(), ['U1b'], ['X'])).toMatch(/X is not in the context/);
    expect(validateTargets(graph(), ['U1b'], ['U1b'])).toMatch(/U1b is a target/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/core test -- context-set`
Expected: FAIL — `contextSet`/`isAncestor`/`validateTargets` are not exported.

- [ ] **Step 3: Implement** (append to `packages/core/src/context.ts`)

```ts
export interface ContextSegment<N extends NodeLike = NodeLike> {
  target: N;
  nodes: N[]; // the target's chain below the common prefix, root-side first; ends with the target
}

export interface ContextSet<N extends NodeLike = NodeLike> {
  prefix: N[]; // root → LCA, once; the whole chain for a single target; empty without a common root
  segments: ContextSegment<N>[]; // one per known target, in target order
  all: Set<NodeId>; // every node that enters the prompt before exclusions — the highlight set
  excluded: Set<NodeId>; // excluded ∩ all
}

/**
 * Spec M4 §4.2. Chains per target, longest positionally identical run from the root as the shared prefix,
 * the rest of each chain as its segment. Unknown targets are skipped (validation is validateTargets' job).
 */
export function contextSet<N extends NodeLike>(graph: GraphLike<N>, targets: readonly NodeId[], excluded: readonly NodeId[]): ContextSet<N> {
  const chains = targets.filter((t) => graph.nodes.has(t)).map((t) => ancestorChain(graph, t));
  let common = 0;
  const first = chains[0];
  if (first) {
    while (common < first.length && chains.every((c) => c[common]?.id === first[common]!.id)) common++;
  }
  const prefix = first ? first.slice(0, common) : [];
  const segments = chains.map((c) => ({ target: c[c.length - 1]!, nodes: c.slice(common) }));
  const all = new Set<NodeId>([...prefix, ...segments.flatMap((s) => s.nodes)].map((n) => n.id));
  return { prefix, segments, all, excluded: new Set(excluded.filter((id) => all.has(id))) };
}

/** True when `ancestorId` lies strictly above `id` on `id`'s primary-parent chain. */
export function isAncestor(graph: GraphLike, ancestorId: NodeId, id: NodeId): boolean {
  if (ancestorId === id) return false;
  return ancestorChain(graph, id).some((n) => n.id === ancestorId);
}

/** Spec M4 §4.3 — the rules the server enforces (400) and the selection UI respects. */
export function validateTargets(graph: GraphLike, targets: readonly NodeId[], excluded: readonly NodeId[]): string | null {
  if (new Set(targets).size !== targets.length) return 'duplicate target';
  for (const t of targets) if (!graph.nodes.has(t)) return `unknown node ${t}`;
  for (const t of targets) {
    for (const o of targets) if (o !== t && isAncestor(graph, o, t)) return `target ${o} is an ancestor of target ${t}`;
  }
  const targetSet = new Set(targets);
  const { all } = contextSet(graph, targets, []);
  for (const e of excluded) {
    if (targetSet.has(e)) return `excluded node ${e} is a target`;
    if (!all.has(e)) return `excluded node ${e} is not in the context`;
  }
  return null;
}
```

Exports — `graph.ts` and `index.ts` context line becomes:
```ts
export { SYSTEM_PROMPT, ancestorChain, isAncestor, contextSet, validateTargets, buildContext, type ContextMessage, type ContextSet, type ContextSegment } from './context';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm typecheck && pnpm --filter @chatmind/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): contextSet with LCA prefix and per-target segments; validateTargets"
```

---

### Task 3: Language detection, block labels, merge-aware `buildContext` (core)

**Files:**
- Create: `packages/core/src/language.ts`
- Modify: `packages/core/src/context.ts`, `packages/core/src/graph.ts`, `packages/core/src/index.ts`
- Modify: `apps/server/src/app.ts` (one call site — keep it compiling; the full endpoint change is Task 6)
- Test: `packages/core/test/language.test.ts`, `packages/core/test/context.test.ts` (rewrite the `buildContext` block)

**Interfaces:**
- Consumes: `contextSet`, `nodeTitle`, `SYSTEM_PROMPT`, `ContextMessage`.
- Produces:
  ```ts
  // language.ts
  type Language = 'de' | 'en'
  detectLanguage(texts: readonly string[]): Language
  // context.ts
  const PREAMBLE: Record<Language, string>
  const ROLE_LABELS: Record<Language, Record<Role, string>>
  blockLabels(targets: readonly NodeLike[], lang: Language): string[]
  interface BuiltContext { system: string; messages: ContextMessage[]; language: Language }
  buildContext(graph: GraphLike, targets: readonly NodeId[], excluded: readonly NodeId[], instruction: string): BuiltContext
  ```
  The M3 signature `buildContext(graph, parentId)` is **removed**; `instruction` is now part of the result (last user turn), the caller no longer pushes it.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/language.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/language';

describe('detectLanguage', () => {
  it('detects German by stopword majority', () => {
    expect(detectLanguage(['Die Gliederung ist nicht fertig und das Kapitel fehlt.'])).toBe('de');
  });
  it('detects English by stopword majority', () => {
    expect(detectLanguage(['The outline is not finished and the chapter is missing.'])).toBe('en');
  });
  it('defaults to English on empty input and ties', () => {
    expect(detectLanguage([])).toBe('en');
    expect(detectLanguage(['', '   '])).toBe('en');
    expect(detectLanguage(['der the'])).toBe('en');
  });
  it('pools several texts and ignores case', () => {
    expect(detectLanguage(['DER', 'DIE', 'the'])).toBe('de');
  });
});
```

Replace the whole `describe('buildContext', …)` in `packages/core/test/context.test.ts` with (keep the `ancestorChain` tests; add the imports shown):
```ts
import fc from 'fast-check';
import { PREAMBLE, ROLE_LABELS, SYSTEM_PROMPT, ancestorChain, blockLabels, buildContext, contextSet } from '../src/context';
import type { GraphLike, NodeLike } from '../src/graph-like';

// R → U1 → A1 → U1b ; R → U2 → A2 ; X → Y   (same shape as context-set.test.ts)
function branching(): GraphLike {
  const ns = [
    node({ id: 'R', body: 'root question' }),
    node({ id: 'U1', parents: ['R'], body: 'u1' }),
    node({ id: 'A1', role: 'assistant', parents: ['U1'], body: 'a1' }),
    node({ id: 'U1b', parents: ['A1'], body: 'u1b', summary: 'Gliederung' }),
    node({ id: 'U2', parents: ['R'], body: 'u2' }),
    node({ id: 'A2', role: 'assistant', parents: ['U2'], body: 'Erste Zeile\nZweite Zeile' }),
    node({ id: 'X', body: 'x' }),
    node({ id: 'Y', role: 'assistant', parents: ['X'], body: 'y' }),
  ];
  return { nodes: new Map(ns.map((n) => [n.id, n])), layout: new Map() };
}

describe('buildContext', () => {
  it('root message: system prompt and only the instruction', () => {
    expect(buildContext(sampleGraph(), [], [], 'Neu')).toEqual({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'Neu' }], language: 'en' });
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}|01JQ/);
  });

  it('single target is byte-identical to the M3 prompt: chain root→target, then the instruction', () => {
    const { messages } = buildContext(sampleGraph(), [C], [], 'Und weiter?');
    expect(messages).toEqual([
      { role: 'user', content: 'Wie evaluiere ich Topic-Zuordnung?' },
      { role: 'assistant', content: 'Zentroid statt Re-Clustering.\n\nBegründung folgt.' },
      { role: 'user', content: 'Danke.' },
      { role: 'user', content: 'Und weiter?' },
    ]);
  });

  it('single target with an excluded ancestor drops that turn', () => {
    const { messages } = buildContext(sampleGraph(), [C], [B], 'x');
    expect(messages.map((m) => m.content)).toEqual(['Wie evaluiere ich Topic-Zuordnung?', 'Danke.', 'x']);
  });

  it('two targets: prefix turns, then one user turn with preamble, labelled blocks in target order, instruction last', () => {
    const { messages, language } = buildContext(branching(), ['U1b', 'A2'], [], 'Make a structure proposal from the outline and the content.');
    expect(language).toBe('en');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: 'root question' });
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toBe(
      [
        PREAMBLE.en,
        '## Gliederung\n**User:** u1\n\n**Assistant:** a1\n\n**User:** u1b',
        '## Erste Zeile\n**User:** u2\n\n**Assistant:** Erste Zeile\nZweite Zeile',
        'Make a structure proposal from the outline and the content.',
      ].join('\n\n'),
    );
  });

  it('two targets without a common root: no prefix turns', () => {
    const { messages } = buildContext(branching(), ['A1', 'Y'], [], 'go');
    expect(messages).toHaveLength(1);
    // A1 and Y have no summary → labels come from the body title
    expect(messages[0]!.content).toContain('## a1\n**User:** root question\n\n**User:** u1\n\n**Assistant:** a1');
    expect(messages[0]!.content).toContain('## y\n**User:** x\n\n**Assistant:** y');
  });

  it('excluded nodes are absent from prefix and blocks', () => {
    const { messages } = buildContext(branching(), ['U1b', 'A2'], ['R', 'A1'], 'go');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).not.toContain('root question');
    expect(messages[0]!.content).toContain('## Gliederung\n**User:** u1\n\n**User:** u1b');
  });

  it('switches preamble and role labels to German by content', () => {
    const g = branching();
    g.nodes.get('U1')!.body = 'Die Gliederung ist nicht fertig und das Kapitel fehlt.';
    const { messages, language } = buildContext(g, ['U1b', 'A2'], [], 'Mach mir einen Vorschlag für die Struktur.');
    expect(language).toBe('de');
    expect(messages[1]!.content.startsWith(PREAMBLE.de)).toBe(true);
    expect(messages[1]!.content).toContain(`**${ROLE_LABELS.de.user}:** u1b`);
    expect(messages[1]!.content).toContain(`**${ROLE_LABELS.de.assistant}:** a1`);
  });

  it('property: every non-excluded node of the set appears exactly once, excluded ones never', () => {
    // random trees: node i's primary parent is some j < i or none
    const treeArb = fc.integer({ min: 2, max: 9 }).chain((n) =>
      fc.tuple(...Array.from({ length: n }, (_, i) => (i === 0 ? fc.constant(-1) : fc.integer({ min: -1, max: i - 1 })))),
    );
    fc.assert(
      fc.property(treeArb, fc.array(fc.nat(8), { minLength: 1, maxLength: 4 }), fc.array(fc.nat(8), { maxLength: 3 }), (parents, rawTargets, rawExcluded) => {
        // summaries keep the body marker out of the block labels, so a target's marker appears only in its turn
        const ns: NodeLike[] = parents.map((p, i) => node({ id: `N${i}`, role: i % 2 === 0 ? 'user' : 'assistant', parents: p < 0 ? [] : [`N${p}`], body: `BODY-N${i}-END`, summary: `S${i}` }));
        const g: GraphLike = { nodes: new Map(ns.map((n) => [n.id, n])), layout: new Map() };
        // targets: distinct, none an ancestor of another (drop offenders)
        const targets: string[] = [];
        for (const t of [...new Set(rawTargets.map((i) => `N${i % parents.length}`))]) {
          if (!targets.some((o) => ancestorChain(g, t).some((n) => n.id === o) || ancestorChain(g, o).some((n) => n.id === t))) targets.push(t);
        }
        const set = contextSet(g, targets, []);
        const excluded = [...new Set(rawExcluded.map((i) => `N${i % parents.length}`))].filter((e) => set.all.has(e) && !targets.includes(e));
        const text = buildContext(g, targets, excluded, 'INSTR').messages.map((m) => m.content).join('\n');
        for (const id of set.all) {
          const count = text.split(`BODY-${id}-END`).length - 1;
          expect(count).toBe(excluded.includes(id) ? 0 : 1);
        }
      }),
    );
  });
});

describe('blockLabels', () => {
  it('uses summary, then the body title, then a numbered fallback; disambiguates duplicates; flattens newlines', () => {
    const t = (id: string, summary: string, body: string): NodeLike => ({ id, role: 'user', parents: [], summary, body });
    expect(blockLabels([t('a', 'Gliederung', 'x'), t('b', '', 'Erste\nZweite'), t('c', '', '  ')], 'de')).toEqual(['Gliederung', 'Erste', 'Zweig 3']);
    expect(blockLabels([t('a', '', ''), t('b', '', '')], 'en')).toEqual(['Branch 1', 'Branch 2']);
    expect(blockLabels([t('a', 'Same', ''), t('b', 'Same', ''), t('c', 'Same', '')], 'en')).toEqual(['Same', 'Same (2)', 'Same (3)']);
    expect(blockLabels([t('a', 'Zwei\n  Zeilen', '')], 'en')).toEqual(['Zwei Zeilen']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/core test -- language context`
Expected: FAIL — `../src/language` missing; `buildContext` called with the new arity; `PREAMBLE`/`blockLabels` not exported.

- [ ] **Step 3: Implement**

`packages/core/src/language.ts`:
```ts
export type Language = 'de' | 'en';

// Spec M4 §4.5. 'in' and 'an' are deliberately absent from the English list — both are everyday German
// words too and would bias German text towards English.
const GERMAN = new Set(['der', 'die', 'das', 'und', 'nicht', 'ist', 'ein', 'eine', 'ich', 'mit', 'für', 'auf', 'zu', 'den', 'dem', 'sich', 'auch', 'wie', 'aber', 'oder']);
const ENGLISH = new Set(['the', 'and', 'is', 'of', 'to', 'that', 'it', 'for', 'with', 'as', 'on', 'this', 'are', 'be', 'not', 'by', 'from', 'or']);

/** German when German stopwords outnumber English ones; English otherwise (ties, empty input). */
export function detectLanguage(texts: readonly string[]): Language {
  let de = 0;
  let en = 0;
  for (const word of texts.join(' ').toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (GERMAN.has(word)) de++;
    if (ENGLISH.has(word)) en++;
  }
  return de > en ? 'de' : 'en';
}
```

In `packages/core/src/context.ts`, add imports and replace `buildContext`:
```ts
import { detectLanguage, type Language } from './language';
import { nodeTitle } from './title';

export const PREAMBLE: Record<Language, string> = {
  de: 'Die folgenden Abschnitte stammen aus verschiedenen Zweigen desselben Gesprächs. Sie wurden unabhängig voneinander erkundet und sind keine aufeinanderfolgenden Nachrichten. Nutze sie gemeinsam als Grundlage für die Aufgabe darunter und ziehe aus jedem heran, was dafür relevant ist. Du kannst die Abschnitte über ihre Überschriften referenzieren.',
  en: 'The following sections come from different branches of the same conversation. They were explored independently and are not consecutive messages. Use them together as the basis for the task below, drawing on whatever is relevant from each. You can refer to the sections by their headings.',
};

export const ROLE_LABELS: Record<Language, Record<Role, string>> = {
  de: { user: 'Nutzer', assistant: 'Assistent' },
  en: { user: 'User', assistant: 'Assistant' },
};

const FALLBACK_LABEL: Record<Language, string> = { de: 'Zweig', en: 'Branch' };

/** Spec M4 §4.4 labels: summary → body title → "Zweig n"/"Branch n"; newlines flattened; duplicates suffixed. */
export function blockLabels(targets: readonly NodeLike[], lang: Language): string[] {
  const seen = new Map<string, number>();
  return targets.map((t, i) => {
    const raw = t.summary !== '' ? t.summary : t.body.trim() !== '' ? nodeTitle(t) : `${FALLBACK_LABEL[lang]} ${i + 1}`;
    const base = raw.replace(/\s*\n+\s*/g, ' ').trim();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export interface BuiltContext {
  system: string;
  messages: ContextMessage[];
  language: Language;
}

/**
 * Spec M4 §4.4. Prefix as turns; the last user turn is the instruction alone for ≤1 target, or
 * preamble + labelled blocks + instruction for ≥2. The preamble lives in the user turn on purpose: the
 * merge message is replayed from the ancestor chain on later turns and carries its own framing.
 */
export function buildContext(graph: GraphLike, targets: readonly NodeId[], excluded: readonly NodeId[], instruction: string): BuiltContext {
  const set = contextSet(graph, targets, excluded);
  const keep = (n: NodeLike): boolean => !set.excluded.has(n.id);
  const prefix = set.prefix.filter(keep);
  const segments = set.segments.map((s) => ({ target: s.target, nodes: s.nodes.filter(keep) }));
  const language = detectLanguage([instruction, ...prefix.map((n) => n.body), ...segments.flatMap((s) => s.nodes.map((n) => n.body))]);
  const messages: ContextMessage[] = prefix.map((n) => ({ role: n.role, content: n.body }));
  if (segments.length < 2) {
    messages.push({ role: 'user', content: instruction });
    return { system: SYSTEM_PROMPT, messages, language };
  }
  const labels = blockLabels(segments.map((s) => s.target), language);
  const blocks = segments.map((s, i) => {
    const turns = s.nodes.map((n) => `**${ROLE_LABELS[language][n.role]}:** ${n.body}`);
    return `## ${labels[i]}\n${turns.join('\n\n')}`;
  });
  messages.push({ role: 'user', content: [PREAMBLE[language], ...blocks, instruction].join('\n\n') });
  return { system: SYSTEM_PROMPT, messages, language };
}
```

Exports: in `graph.ts` and `index.ts` extend the context line with `PREAMBLE, ROLE_LABELS, blockLabels, type BuiltContext` and add
```ts
export { detectLanguage, type Language } from './language';
```

Keep the server compiling (final shape comes in Task 6) — in `apps/server/src/app.ts` replace
```ts
const { system, messages } = buildContext(graph, parentId);
messages.push({ role: 'user', content });
```
with
```ts
const { system, messages } = buildContext(graph, parentId === null ? [] : [parentId], [], content);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (server tests unchanged in behaviour: single target ⇒ same prompt).

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/server/src/app.ts
git commit -m "feat(core): merge-aware buildContext with labelled blocks, preamble and language detection"
```

---

### Task 4: Token estimate and budget (core)

**Files:**
- Create: `packages/core/src/tokens.ts`
- Modify: `packages/core/src/graph.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/tokens.test.ts`

**Interfaces:**
- Produces:
  ```ts
  const OUTPUT_RESERVE = 16_000
  estimateTokens(text: string): number                                   // ceil(len / 3.5)
  promptTokens(ctx: { system: string; messages: readonly { content: string }[] }): number   // + 4 per message
  budgetFor(contextTokens: number): number                               // max(contextTokens − OUTPUT_RESERVE, 1)
  formatTokens(n: number): string                                        // 950 → "950", 12 400 → "12.4k", 184 000 → "184k"
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/tokens.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { OUTPUT_RESERVE, budgetFor, estimateTokens, formatTokens, promptTokens } from '../src/tokens';

describe('tokens', () => {
  it('estimates ceil(len / 3.5)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('x'.repeat(35))).toBe(10);
    expect(estimateTokens('x'.repeat(36))).toBe(11);
  });
  it('counts the rendered prompt with a per-message overhead', () => {
    expect(promptTokens({ system: 'x'.repeat(35), messages: [{ content: 'x'.repeat(7) }, { content: '' }] })).toBe(10 + (2 + 4) + (0 + 4));
  });
  it('subtracts the output reserve, never below 1', () => {
    expect(OUTPUT_RESERVE).toBe(16_000);
    expect(budgetFor(200_000)).toBe(184_000);
    expect(budgetFor(100)).toBe(1);
  });
  it('formats compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(9_960)).toBe('10.0k');
    expect(formatTokens(184_000)).toBe('184k');
    expect(formatTokens(1_048_576)).toBe('1049k');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/core test -- tokens`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `packages/core/src/tokens.ts`:
```ts
/** Spec M4 §4.6. A heuristic shared by all providers; the UI shows it with a "~". */
const CHARS_PER_TOKEN = 3.5;
const PER_MESSAGE_OVERHEAD = 4;
export const OUTPUT_RESERVE = 16_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tokens of the rendered prompt — what is actually sent, preamble and labels included. */
export function promptTokens(ctx: { system: string; messages: readonly { content: string }[] }): number {
  return estimateTokens(ctx.system) + ctx.messages.reduce((sum, m) => sum + estimateTokens(m.content) + PER_MESSAGE_OVERHEAD, 0);
}

export function budgetFor(contextTokens: number): number {
  return Math.max(contextTokens - OUTPUT_RESERVE, 1);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
```
Exports in `graph.ts` and `index.ts`:
```ts
export { OUTPUT_RESERVE, estimateTokens, promptTokens, budgetFor, formatTokens } from './tokens';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm typecheck && pnpm --filter @chatmind/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): token estimate, prompt token count, budget and formatting"
```

---

### Task 5: Reader reports `assistant-parents` (core + cli)

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/core/src/vault/read.ts`, `apps/cli/src/check.ts`
- Test: `packages/core/test/read.test.ts` (append)

**Interfaces:**
- Produces: `Repair` variant `{ kind: 'assistant-parents'; id: NodeId; count: number }`.

- [ ] **Step 1: Write the failing test** (append to `packages/core/test/read.test.ts`, inside a new `describe`)

```ts
describe('readVault — assistant parents invariant', () => {
  it('reports an assistant node with two parents and leaves its parents untouched', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    g.nodes.set(D, { id: D, role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Zweite Wurzel.' });
    g.layout.set(D, { x: 480, y: 0, width: 400, height: 200 });
    g.nodes.get(B)!.parents = [A, D];
    await writeCanvas(g, root);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([{ kind: 'assistant-parents', id: B, count: 2 }]);
    expect(canvases[0]!.nodes.get(B)!.parents).toEqual([A, D]);
  });
  it('does not report user nodes with several parents', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.nodes.get(C)!.parents = [B, A];
    await writeCanvas(g, root);
    expect((await readVault(root)).repairs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @chatmind/core test -- read`
Expected: FAIL — `repairs` is `[]` in the first test (and typecheck would reject the new `kind`).

- [ ] **Step 3: Implement**

`packages/core/src/types.ts` — add to the `Repair` union:
```ts
  | { kind: 'assistant-parents'; id: NodeId; count: number }   // role: assistant must have exactly one parent (spec M4 §2); reported only
```

`packages/core/src/vault/read.ts` — extend `checkParents`:
```ts
/** Step 4: parents that reference unknown ids stay in the model but are reported; so does an assistant with ≠1 parents (spec M4). */
function checkParents(graph: CanvasGraph, repairs: Repair[]): void {
  for (const node of sortedNodes(graph)) {
    for (const parent of node.parents) {
      if (!graph.nodes.has(parent)) repairs.push({ kind: 'dangling-parent', id: node.id, parent });
    }
    if (node.role === 'assistant' && node.parents.length !== 1) repairs.push({ kind: 'assistant-parents', id: node.id, count: node.parents.length });
  }
}
```

`apps/cli/src/check.ts` — add a case to `describe`:
```ts
    case 'assistant-parents':
      return `assistant parents  ${r.id} has ${r.count} parents (expected 1)`;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. (If any existing fixture has a root assistant node, `typecheck` passes but a `repairs: []` assertion fails — change that fixture's first message to `role: 'user'`; the invariant is the spec's.)

- [ ] **Step 5: Commit**

```bash
git add packages/core apps/cli/src/check.ts
git commit -m "feat(core): reader reports assistant nodes with other than one parent"
```

---

### Task 6: Server — `contextTokens`, `parentIds`/`excludedIds` send endpoint

**Files:**
- Modify: `packages/core/src/dto.ts`, `apps/server/src/models.ts`, `apps/server/src/app.ts`
- Test: `apps/server/test/app.test.ts` (modify + append), `apps/server/test/models.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: `validateTargets`, `buildContext(graph, targets, excluded, instruction)`, `placeChild`.
- Produces:
  ```ts
  // dto.ts
  interface ModelDto { id; provider; label; available; contextTokens: number }
  interface SendRequest { parentIds: string[]; excludedIds?: string[]; content: string; model: string }
  // models.ts
  interface ModelSpec { id; provider; label; contextTokens: number }
  ```
  `POST /api/canvases/:slug/messages` semantics per spec §5.

- [ ] **Step 1: Look up context windows**

Run:
```bash
curl -s https://openrouter.ai/api/v1/models | node -e '
const want = new Set(["anthropic/claude-opus-5","anthropic/claude-sonnet-5","openai/gpt-6-astra","google/gemini-3.8-flash","openai/gpt-5.6-luna"]);
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ for (const m of JSON.parse(s).data) if (want.has(m.id)) console.log(m.id, m.context_length); });'
```
Record each `context_length` and today's date in a comment in `models.ts`. Use the same number for the direct-provider id of the same model (`claude-opus-5` = `anthropic/claude-opus-5`, etc.). If the lookup is unavailable, use these and say so in the comment: Anthropic models `200000`, OpenAI models `400000`, Gemini `1048576`.

- [ ] **Step 2: Write the failing tests**

Append to `apps/server/test/app.test.ts`, inside `describe('POST /api/canvases/:slug/messages', …)` (the `headers`, `appWithModel`, `parseSse` helpers already exist there):
```ts
  /** R(user) → A(assistant) → U1(user) ; R → U2(user): two sibling branches under A's chain. */
  async function appWithBranches(deltas: string[]) {
    const root = await tmpDir();
    const g = linearGraph('masterarbeit', [
      { role: 'user', content: 'Frage', summary: 'Ursprungsfrage' },
      { role: 'assistant', content: 'Antwort', model: 'claude-sonnet-4-6' },
      { role: 'user', content: 'Gliederung bitte', summary: 'Gliederung' },
    ]);
    const [R, A, U1] = [...g.nodes.keys()];
    const U2 = '01JQ8F7000000000000000000U';
    g.nodes.set(U2, { id: U2, role: 'user', parents: [R!], created: '2026-09-13T10:00:00Z', summary: 'Inhalt', topics: [], body: 'Inhaltliches Brainstorming' });
    g.layout.set(U2, { x: 480, y: 280, width: 400, height: 200 });
    await writeCanvas(g, root);
    const factory = mockModel(deltas);
    const app = createApp({ dataDir: root, keys: { anthropic: 'k' }, modelFactory: () => factory });
    return { root, app, R: R!, A: A!, U1: U1!, U2, factory };
  }

  it('merges two targets: user node has both parents, canvas has both edges, model gets the block prompt', async () => {
    const { root, app, U1, U2, factory } = await appWithBranches(['ok']);
    const res = await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [U1, U2], excludedIds: [], content: 'Combine both into a structure.', model: 'claude-opus-5' }) });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['user-node', 'assistant-start', 'delta', 'done']);
    const user = events[0]!.data as { id: string; parents: string[] };
    expect(user.parents).toEqual([U1, U2]);
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases[0]!.nodes.get(user.id)!.parents).toEqual([U1, U2]);
    const canvasFile = await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8');
    expect(canvasFile).toContain(`"id":"e-${U1}-${user.id}"`);
    expect(canvasFile).toContain(`"id":"e-${U2}-${user.id}"`);
    // the prompt the model saw: prefix (R, A) as turns, then one user turn with both blocks
    // prefix = [R] only (A and U1 are below the LCA), so: R as a turn, then one user turn with both blocks.
    // The AI SDK puts `system` into the prompt as a leading system message — dropped here.
    const call = factory.doStreamCalls[0]!;
    const texts = call.prompt.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, text: Array.isArray(m.content) ? m.content.map((p) => ('text' in p ? p.text : '')).join('') : String(m.content) }));
    expect(texts.map((t) => t.role)).toEqual(['user', 'user']);
    expect(texts[0]!.text).toBe('Frage');
    expect(texts[1]!.text).toContain('## Gliederung\n**Assistant:** Antwort\n\n**User:** Gliederung bitte');
    expect(texts[1]!.text).toContain('## Inhalt\n**User:** Inhaltliches Brainstorming');
    expect(texts[1]!.text.endsWith('Combine both into a structure.')).toBe(true);
  });

  it('honours excludedIds', async () => {
    const { app, R, U1, U2, factory } = await appWithBranches(['ok']);
    await (await app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify({ parentIds: [U1, U2], excludedIds: [R], content: 'go', model: 'claude-opus-5' }) })).text();
    const roles = factory.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system').map((m) => m.role);
    expect(roles).toEqual(['user']); // R dropped from the prefix — only the merge turn remains
  });

  it('rejects invalid target sets with 400', async () => {
    const { app, R, A, U1, U2 } = await appWithBranches(['ok']);
    const post = (body: unknown) => app.request('/api/canvases/masterarbeit/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ parentIds: [A, U1], content: 'x', model: 'claude-opus-5' })).status).toBe(400);           // A is an ancestor of U1
    expect((await post({ parentIds: [U1, '01JQ8F9ZZZZZZZZZZZZZZZZZZZ'], content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentIds: [U1, U1], content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentIds: [U1, U2], excludedIds: [U1], content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentIds: [U1], excludedIds: [U2], content: 'x', model: 'claude-opus-5' })).status).toBe(400); // U2 not in U1's context
    expect((await post({ parentIds: 'nope', content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ parentIds: [U1], excludedIds: 'nope', content: 'x', model: 'claude-opus-5' })).status).toBe(400);
    expect((await post({ content: 'x', model: 'claude-opus-5' })).status).toBe(400);                                  // parentIds missing (no parentId fallback)
    expect((await post({ parentIds: [R], content: 'x', model: 'claude-opus-5' })).status).toBe(200);
  });
```
Then update the existing tests in that `describe` — every `parentId: lastId` becomes `parentIds: [lastId]`, every `parentId: null` becomes `parentIds: []`, and the 400 case `parentId: '01JQ8F9Z…'` becomes `parentIds: ['01JQ8F9ZZZZZZZZZZZZZZZZZZZ']`. Rename the test `'creates a root message when parentId is null'` → `'creates a root message when parentIds is empty'`.

Append to `apps/server/test/models.test.ts` (create the file with the vitest imports if it does not exist):
```ts
import { describe, expect, it } from 'vitest';
import { MODELS, modelDtos } from '../src/models';

describe('models — context windows', () => {
  it('every model has a positive contextTokens that GET /api/models exposes', () => {
    for (const m of MODELS) expect(m.contextTokens).toBeGreaterThan(OUTPUT_RESERVE);
    for (const d of modelDtos({})) expect(typeof d.contextTokens).toBe('number');
  });
});
```
(add `import { OUTPUT_RESERVE } from '@chatmind/core';`)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/server test`
Expected: FAIL — `contextTokens` undefined; merge request returns 400 (`parentIds` unknown to the handler); `doStreamCalls` assertions not reached.

If `factory.doStreamCalls` does not exist on the installed mock class, check `node_modules/ai/dist/test/index.d.ts` for the recorded-calls property name of `MockLanguageModelV3` (it records `doStreamCalls` in AI SDK 5+; adapt the property name only) and report the adaptation.

- [ ] **Step 4: Implement**

`packages/core/src/dto.ts`:
```ts
export interface ModelDto {
  id: string;
  provider: Provider;
  label: string;
  available: boolean;
  contextTokens: number; // the model's context window; the client derives its budget with budgetFor()
}
export interface SendRequest {
  parentIds: string[]; // [] = new root message; ≥2 = merge (spec M4 §5)
  excludedIds?: string[]; // ancestors taken out of the context; must lie inside contextSet(...).all
  content: string;
  model: string;
}
```

`apps/server/src/models.ts` — add `contextTokens` to `ModelSpec` and every entry, with the lookup comment from Step 1:
```ts
export interface ModelSpec { id: string; provider: Provider; label: string; contextTokens: number }
// contextTokens verified <date> via https://openrouter.ai/api/v1/models (`context_length`); direct-provider ids
// use the number of the same model. <or: lookup unavailable — fallback values, see plan Task 6>
export const MODELS: readonly ModelSpec[] = [
  { id: 'claude-opus-5', provider: 'anthropic', label: 'Claude Opus 5', contextTokens: <value> },
  … (every entry)
];
```

`apps/server/src/app.ts` — in the messages handler, replace the `parentId` parsing, the lock block and the context call:
```ts
    const parentIds = Array.isArray(body.parentIds) && body.parentIds.every((p) => typeof p === 'string') ? (body.parentIds as string[]) : null;
    if (parentIds === null) return c.json({ error: 'parentIds must be an array of node ids' }, 400);
    const excludedIds = body.excludedIds === undefined ? [] : Array.isArray(body.excludedIds) && body.excludedIds.every((p) => typeof p === 'string') ? (body.excludedIds as string[]) : null;
    if (excludedIds === null) return c.json({ error: 'excludedIds must be an array of node ids' }, 400);
    // … model checks unchanged …
    const prepared = await lock.run(async () => {
      const { canvases } = await readOrEmpty(dataDir);
      const graph = canvases.find((g) => g.slug === slugParam);
      if (!graph) return { error: 404 as const, message: 'canvas not found' };
      const invalid = validateTargets(graph, parentIds, excludedIds);
      if (invalid !== null) return { error: 400 as const, message: invalid };
      const userMs = Date.now();
      const user: MessageNode = { id: newId(userMs), role: 'user', parents: [...parentIds], created: isoTimestamp(userMs), summary: '', topics: [], body: content };
      const userLayout = placeChild(graph, parentIds[0] ?? null);
      graph.nodes.set(user.id, user);
      graph.layout.set(user.id, userLayout);
      await writeNode(graph, user.id, dataDir);
      await writeCanvasFile(graph, dataDir);
      return { graph, user, userLayout };
    });
    if ('error' in prepared) return c.json({ error: prepared.message }, prepared.error);
    // …
    const { system, messages } = buildContext(graph, parentIds, excludedIds, content);
```
Import `validateTargets` from `@chatmind/core`. Delete the old `parentId` variable and its 400 message.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: server green; web `App.test.tsx` **fails** on the request-body assertion (`parentId` vs `parentIds`) — that is expected and is fixed in Task 10. Note it in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/dto.ts apps/server
git commit -m "feat(server): merge sends via parentIds/excludedIds with validateTargets; model context windows

Web request body still sends parentId; updated in the web task."
```

---

### Task 7: Selection logic (web, pure)

**Files:**
- Create: `apps/web/src/selection.ts`
- Test: `apps/web/test/selection.test.ts`

**Interfaces:**
- Consumes: `contextSet`, `isAncestor`, `GraphLike`, `graphLikeFromDto` from `@chatmind/core/graph`.
- Produces:
  ```ts
  interface SelectionState { cursorId: string | null; targets: string[]; excluded: string[] }
  clearSelection(): SelectionState
  effectiveTargets(s: SelectionState): string[]                       // explicit targets, else [cursor], else []
  toggleParticipation(graph: GraphLike, s: SelectionState, id: string): SelectionState   // the Space semantics (spec §6.1)
  ```

- [ ] **Step 1: Write the failing tests**

`apps/web/test/selection.test.ts`:
```ts
import type { CanvasDto, NodeDto } from '@chatmind/core';
import { graphLikeFromDto } from '@chatmind/core/graph';
import { describe, expect, it } from 'vitest';
import { clearSelection, effectiveTargets, toggleParticipation, type SelectionState } from '../src/selection';

const n = (id: string, parents: string[]): NodeDto => ({ id, role: 'user', parents, created: 'c', summary: '', topics: [], body: 'b', layout: { x: 0, y: 0, width: 400, height: 200 } });
// R → A → (B, C); C → D ; second root R2
const dto: CanvasDto = { slug: 'm', nodes: [n('R', []), n('A', ['R']), n('B', ['A']), n('C', ['A']), n('D', ['C']), n('R2', [])], edges: [], repairs: [] };
const g = graphLikeFromDto(dto);
const s = (over: Partial<SelectionState>): SelectionState => ({ ...clearSelection(), ...over });

describe('effectiveTargets', () => {
  it('uses explicit targets, else the cursor, else nothing', () => {
    expect(effectiveTargets(s({ cursorId: 'A', targets: ['B', 'C'] }))).toEqual(['B', 'C']);
    expect(effectiveTargets(s({ cursorId: 'A' }))).toEqual(['A']);
    expect(effectiveTargets(clearSelection())).toEqual([]);
  });
});

describe('toggleParticipation', () => {
  it('promotes the implicit cursor target to an explicit one', () => {
    expect(toggleParticipation(g, s({ cursorId: 'B' }), 'B')).toEqual(s({ cursorId: 'B', targets: ['B'] }));
  });
  it('appends a free node as a target and removes an existing target', () => {
    const one = s({ cursorId: 'C', targets: ['B'] });
    const two = toggleParticipation(g, one, 'C');
    expect(two.targets).toEqual(['B', 'C']);
    expect(toggleParticipation(g, two, 'B').targets).toEqual(['C']);
  });
  it('excludes and re-includes a highlighted ancestor, making implicit targets explicit', () => {
    const excluded = toggleParticipation(g, s({ cursorId: 'C' }), 'A');
    expect(excluded).toEqual(s({ cursorId: 'C', targets: ['C'], excluded: ['A'] }));
    expect(toggleParticipation(g, excluded, 'A').excluded).toEqual([]);
  });
  it('ignores a descendant of an existing target and unknown ids', () => {
    const st = s({ cursorId: 'D', targets: ['C'] });
    expect(toggleParticipation(g, st, 'D')).toBe(st);
    expect(toggleParticipation(g, st, 'nope')).toBe(st);
  });
  it('prunes exclusions that leave the context when targets change', () => {
    const st = s({ cursorId: 'R2', targets: ['B', 'C'], excluded: ['A', 'R'] });
    const afterC = toggleParticipation(g, st, 'C');
    expect(afterC.excluded).toEqual(['A', 'R']); // still in B's chain
    const afterB = toggleParticipation(g, afterC, 'B');
    expect(afterB.targets).toEqual([]);
    expect(afterB.excluded).toEqual([]); // the implicit target is now the cursor R2, whose chain holds neither
  });
  it('a root without a common ancestor can join as a target', () => {
    expect(toggleParticipation(g, s({ cursorId: 'R2', targets: ['B'] }), 'R2').targets).toEqual(['B', 'R2']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/web test -- selection`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `apps/web/src/selection.ts`:
```ts
import { contextSet, isAncestor, type GraphLike } from '@chatmind/core/graph';

/** Spec M4 §6.1: cursor = what the arrows move; targets = ordered parents of the next message; excluded = ancestors taken out. */
export interface SelectionState {
  cursorId: string | null;
  targets: string[];
  excluded: string[];
}

export function clearSelection(): SelectionState {
  return { cursorId: null, targets: [], excluded: [] };
}

/** Explicit targets win; without any, the cursor is the implicit single target (M3 behaviour). */
export function effectiveTargets(s: SelectionState): string[] {
  if (s.targets.length > 0) return s.targets;
  return s.cursorId === null ? [] : [s.cursorId];
}

/** Drops exclusions that no longer lie inside the context of the current targets. */
function prune(graph: GraphLike, s: SelectionState): SelectionState {
  const { all } = contextSet(graph, effectiveTargets(s), []);
  return { ...s, excluded: s.excluded.filter((e) => all.has(e)) };
}

/**
 * The single "Space" semantics: explicit target → remove; implicit cursor target → make explicit;
 * highlighted ancestor → exclude / re-include; descendant of a target → no-op; anything else → append.
 */
export function toggleParticipation(graph: GraphLike, s: SelectionState, id: string): SelectionState {
  if (!graph.nodes.has(id)) return s;
  if (s.targets.includes(id)) return prune(graph, { ...s, targets: s.targets.filter((t) => t !== id) });
  const targets = effectiveTargets(s);
  if (targets.includes(id)) return { ...s, targets: [id] };
  const { all } = contextSet(graph, targets, s.excluded);
  if (all.has(id)) {
    const excluded = s.excluded.includes(id) ? s.excluded.filter((e) => e !== id) : [...s.excluded, id];
    return { ...s, targets, excluded };
  }
  if (targets.some((t) => isAncestor(graph, t, id))) return s;
  return prune(graph, { ...s, targets: [...targets, id] });
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @chatmind/web typecheck && pnpm --filter @chatmind/web test -- selection`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/selection.ts apps/web/test/selection.test.ts
git commit -m "feat(web): selection state with cursor, ordered targets and exclusions"
```

---

### Task 8: Flow mapping — marks, ghost node, secondary edges (web, pure)

**Files:**
- Modify: `apps/web/src/flow.ts`
- Test: `apps/web/test/flow.test.ts` (append)

**Interfaces:**
- Consumes: `placeChild`, `graphLikeFromDto`, `Language` from `@chatmind/core/graph`; `StreamState`.
- Produces:
  ```ts
  interface FlowMarks { targets: readonly string[]; all: ReadonlySet<string>; excluded: ReadonlySet<string>; language: Language }
  type MessageNodeData = { …existing; targetIndex?: number; inContext?: boolean; excluded?: boolean; language?: Language }
  type GhostNodeData = { count: number; language: Language }
  type GhostFlowNode = Node<GhostNodeData, 'ghost'>
  const GHOST_ID = 'ghost'
  toFlowNodes(dto, streams?, marks?): (MessageFlowNode | GhostFlowNode)[]   // ghost appended when marks.targets.length ≥ 2
  toFlowEdges(dto, marks?): Edge[]                                            // primary: { type: 'smoothstep' }; secondary: { type: 'default', className: 'secondary' }; ghost edges when ≥2 targets
  ```

- [ ] **Step 1: Write the failing tests** (append to `apps/web/test/flow.test.ts`)

```ts
import type { FlowMarks } from '../src/flow';
import { GHOST_ID } from '../src/flow';

// A(user) → B(assistant) ; A → C(user) ; M(user, parents [B, C]) — a merge node already on the canvas
const merged: CanvasDto = {
  slug: 'm',
  nodes: [
    ...dto.nodes,
    { id: 'C', role: 'user', parents: ['A'], created: 'c', summary: 'C', topics: [], body: 'c', layout: { x: 480, y: 300, width: 400, height: 200 } },
    { id: 'M', role: 'user', parents: ['B', 'C'], created: 'c', summary: 'M', topics: [], body: 'm', layout: { x: 10, y: 580, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-A-B', from: 'A', to: 'B' }, { id: 'e-A-C', from: 'A', to: 'C' }, { id: 'e-B-M', from: 'B', to: 'M' }, { id: 'e-C-M', from: 'C', to: 'M' }],
  repairs: [],
};
const marks = (over: Partial<FlowMarks>): FlowMarks => ({ targets: [], all: new Set(), excluded: new Set(), language: 'en', ...over });

describe('toFlowNodes with marks', () => {
  it('flags targets with their 1-based index, context membership and exclusion', () => {
    const nodes = toFlowNodes(merged, undefined, marks({ targets: ['C', 'B'], all: new Set(['A', 'B', 'C']), excluded: new Set(['A']) }));
    const by = (id: string) => nodes.find((n) => n.id === id)!.data as { targetIndex?: number; inContext?: boolean; excluded?: boolean; language?: string };
    expect(by('C').targetIndex).toBe(1);
    expect(by('B').targetIndex).toBe(2);
    expect(by('A')).toMatchObject({ inContext: true, excluded: true, language: 'en' });
    expect('targetIndex' in by('A')).toBe(false);
    expect(by('M').inContext).toBeUndefined();
  });
  it('appends a ghost node under the first target when there are ≥2 targets, and none otherwise', () => {
    const none = toFlowNodes(dto, undefined, marks({ targets: ['B'] }));
    expect(none.some((n) => n.type === 'ghost')).toBe(false);
    const nodes = toFlowNodes(merged, undefined, marks({ targets: ['C', 'B'], language: 'de' }));
    const ghost = nodes.find((n) => n.type === 'ghost')!;
    expect(ghost).toMatchObject({ id: GHOST_ID, type: 'ghost', selectable: false, draggable: false, data: { count: 2, language: 'de' } });
    // placeChild(graph, 'C'): C has no primary children → x = C.x, y = C.y + 200 + 80
    expect(ghost.position).toEqual({ x: 480, y: 580 });
  });
});

describe('toFlowEdges styles', () => {
  it('draws primary edges solid smoothstep and secondary edges as dashed bezier', () => {
    const edges = toFlowEdges(merged);
    expect(edges.find((e) => e.id === 'e-B-M')).toEqual({ id: 'e-B-M', source: 'B', target: 'M', type: 'smoothstep' });
    expect(edges.find((e) => e.id === 'e-C-M')).toEqual({ id: 'e-C-M', source: 'C', target: 'M', type: 'default', className: 'secondary' });
  });
  it('adds one edge per target to the ghost, the first primary', () => {
    const edges = toFlowEdges(merged, marks({ targets: ['C', 'B'] }));
    expect(edges.filter((e) => e.target === GHOST_ID)).toEqual([
      { id: `e-C-${GHOST_ID}`, source: 'C', target: GHOST_ID, type: 'smoothstep' },
      { id: `e-B-${GHOST_ID}`, source: 'B', target: GHOST_ID, type: 'default', className: 'secondary' },
    ]);
    expect(toFlowEdges(merged, marks({ targets: ['C'] })).some((e) => e.target === GHOST_ID)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/web test -- flow`
Expected: FAIL — `FlowMarks`/`GHOST_ID` missing; extra arguments ignored.

- [ ] **Step 3: Implement** — `apps/web/src/flow.ts` becomes:
```ts
import type { CanvasDto, NodeDto } from '@chatmind/core';
import { graphLikeFromDto, nodeTitle, placeChild, type Language } from '@chatmind/core/graph';
import type { Edge, Node } from '@xyflow/react';
import type { StreamState } from './streams';

export { nodeTitle };

export type MessageNodeData = {
  role: NodeDto['role'];
  model?: string;
  summary: string;
  body: string;
  created: string;
  streaming?: boolean;
  error?: string;
  targetIndex?: number; // 1-based position among the merge targets (spec M4 §6.3)
  inContext?: boolean; // enters the prompt (before exclusions)
  excluded?: boolean;
  language?: Language; // for the context badge text; set only when inContext
};

export type MessageFlowNode = Node<MessageNodeData, 'message'>;
export type GhostNodeData = { count: number; language: Language };
export type GhostFlowNode = Node<GhostNodeData, 'ghost'>;
export const GHOST_ID = 'ghost';

/** What the selection contributes to rendering; computed once per selection change in App. */
export interface FlowMarks {
  targets: readonly string[];
  all: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  language: Language;
}

/** Canvas coordinates are React Flow coordinates — no transformation (spec M2 §2). */
export function toFlowNodes(dto: CanvasDto, streams?: ReadonlyMap<string, StreamState>, marks?: FlowMarks): (MessageFlowNode | GhostFlowNode)[] {
  const nodes: (MessageFlowNode | GhostFlowNode)[] = dto.nodes.map((n) => {
    const s = streams?.get(n.id);
    const data: MessageNodeData = { role: n.role, summary: n.summary, body: n.body, created: n.created };
    if (n.model !== undefined) data.model = n.model;
    if (s?.status === 'streaming') data.streaming = true;
    if (s?.status === 'error') data.error = s.error ?? 'error';
    if (marks) {
      const i = marks.targets.indexOf(n.id);
      if (i >= 0) data.targetIndex = i + 1;
      if (marks.all.has(n.id)) {
        data.inContext = true;
        data.language = marks.language;
        if (marks.excluded.has(n.id)) data.excluded = true;
      }
    }
    return { id: n.id, type: 'message', position: { x: n.layout.x, y: n.layout.y }, width: n.layout.width, height: n.layout.height, draggable: false, connectable: false, data };
  });
  if (marks && marks.targets.length >= 2) {
    // Same function the server will call for the real user node, so the preview lands in the real slot.
    const layout = placeChild(graphLikeFromDto(dto), marks.targets[0]!);
    nodes.push({ id: GHOST_ID, type: 'ghost', position: { x: layout.x, y: layout.y }, width: layout.width, height: layout.height, draggable: false, connectable: false, selectable: false, data: { count: marks.targets.length, language: marks.language } });
  }
  return nodes;
}

function edge(id: string, source: string, target: string, primary: boolean): Edge {
  return primary ? { id, source, target, type: 'smoothstep' } : { id, source, target, type: 'default', className: 'secondary' };
}

/** Primary edge = the target's `parents[0]` (solid smoothstep); every other parent edge is dashed bezier (spec M4 §6.3). */
export function toFlowEdges(dto: CanvasDto, marks?: FlowMarks): Edge[] {
  const primaryParent = new Map(dto.nodes.map((n) => [n.id, n.parents[0]]));
  const edges = dto.edges.map((e) => edge(e.id, e.from, e.to, primaryParent.get(e.to) === e.from));
  if (marks && marks.targets.length >= 2) {
    marks.targets.forEach((t, i) => edges.push(edge(`e-${t}-${GHOST_ID}`, t, GHOST_ID, i === 0)));
  }
  return edges;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @chatmind/web typecheck && pnpm --filter @chatmind/web test -- flow`
Expected: PASS (the existing `toFlowEdges` test still matches because `A→B` is primary). If `typecheck` complains that `GraphView` passes a `(MessageFlowNode | GhostFlowNode)[]` where `Node[]` is expected, that is resolved in Task 10; note it and continue.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/flow.ts apps/web/test/flow.test.ts
git commit -m "feat(web): selection marks on flow nodes, ghost merge node, dashed secondary edges"
```

---

### Task 9: Composer — targets chip, language placeholder, token meter (web)

**Files:**
- Modify: `apps/web/src/Composer.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/Composer.test.tsx`

**Interfaces:**
- Consumes: `formatTokens`, `Language` from `@chatmind/core/graph`; `nodeTitle` from `./flow`.
- Produces (props change):
  ```ts
  interface ComposerProps {
    targets: NodeDto[];                    // replaces `target: NodeDto | null`
    language: Language;
    promptTokens: (text: string) => number; // App: promptTokens(buildContext(graph, targets, excluded, text))
    budget: number;                         // budgetFor(model.contextTokens); 0 when no model
    models; model; onModelChange; onSend; sending; errorLine; onEscape; textareaRef   // unchanged
  }
  ```
  Meter element: `role="meter"`, `aria-label="Context tokens"`, `aria-valuenow`, `aria-valuemax`; classes `meter`, `meter warn` (≥80 %), `meter over` (>100 %). Over budget ⇒ `role="alert"` line and Send disabled.

- [ ] **Step 1: Update and extend the tests**

In `apps/web/test/Composer.test.tsx`: change `setup` to render `<Composer targets={[target]} language="en" promptTokens={promptTokens} budget={1000} … />` where `const promptTokens = vi.fn((text: string) => 100 + text.length);` is created in `setup` and returned. Replace the test `'says "New root message" without a target'` with `setup({ targets: [] })`. Then append:
```ts
  it('lists the merge targets in order and switches the placeholder by language', () => {
    const t2 = { ...target, id: 'B', summary: 'Zweiter' };
    const t3 = { ...target, id: 'C', summary: 'Dritter' };
    const t4 = { ...target, id: 'D', summary: 'Vierter' };
    setup({ targets: [target, t2], language: 'de' });
    expect(screen.getByText(/Merging:/)).toHaveTextContent('Merging: Ursprungsfrage, Zweiter');
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', expect.stringContaining('Was soll aus diesen Zweigen entstehen?'));
    cleanup();
    setup({ targets: [target, t2, t3, t4], language: 'en' });
    expect(screen.getByText(/Merging:/)).toHaveTextContent('Merging: Ursprungsfrage, Zweiter, Dritter +1');
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', expect.stringContaining('What should come out of these branches?'));
  });
  it('shows the token meter from promptTokens(text) against the budget', async () => {
    const { promptTokens } = setup({ budget: 1000 });
    const meter = screen.getByRole('meter', { name: 'Context tokens' });
    expect(meter).toHaveAttribute('aria-valuenow', '100');
    expect(meter).toHaveAttribute('aria-valuemax', '1000');
    expect(meter).toHaveTextContent('~100 / 1.0k');
    await userEvent.type(screen.getByRole('textbox'), 'abc');
    expect(promptTokens).toHaveBeenLastCalledWith('abc');
    expect(meter).toHaveAttribute('aria-valuenow', '103');
  });
  it('turns amber at 80 % and blocks sending over budget with a hint', async () => {
    setup({ budget: 120 });
    expect(screen.getByRole('meter')).toHaveClass('warn');
    cleanup();
    const { onSend } = setup({ budget: 90, language: 'de' });
    expect(screen.getByRole('meter')).toHaveClass('over');
    expect(screen.getByRole('alert')).toHaveTextContent('Über Budget — Nodes abwählen');
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Hallo');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
```
(add `cleanup` to the `@testing-library/react` import.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/web test -- Composer`
Expected: FAIL — unknown props / missing meter.

- [ ] **Step 3: Implement** — `apps/web/src/Composer.tsx`:
```tsx
import type { ModelDto, NodeDto } from '@chatmind/core';
import { formatTokens, type Language } from '@chatmind/core/graph';
import { useState, type FormEvent, type KeyboardEvent, type ReactElement, type RefObject } from 'react';
import { nodeTitle } from './flow';

export interface ComposerProps {
  targets: NodeDto[];
  language: Language;
  /** Tokens of the full prompt for the given instruction text (spec M4 §6.4) — App binds graph, targets and exclusions. */
  promptTokens: (text: string) => number;
  budget: number;
  models: ModelDto[];
  model: string;
  onModelChange: (id: string) => void;
  /** Resolves true once the send was accepted (so the composer can clear); false to keep the typed text. */
  onSend: (content: string) => Promise<boolean>;
  sending: boolean;
  errorLine: string | null;
  onEscape: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

const AUTOGROW_MAX = 200;
const MAX_LISTED_TARGETS = 3;
const PLACEHOLDER = {
  single: 'Write a message… (⏎ send, ⇧⏎ newline, Esc back to graph)',
  merge: { de: 'Was soll aus diesen Zweigen entstehen? (⏎ senden, ⇧⏎ neue Zeile)', en: 'What should come out of these branches? (⏎ send, ⇧⏎ newline)' },
};
const OVER_BUDGET: Record<Language, string> = {
  de: 'Über Budget — Nodes abwählen (Space auf einem hervorgehobenen Node)',
  en: 'Over budget — deselect nodes (Space on a highlighted node)',
};

function targetLine(targets: NodeDto[]): ReactElement {
  if (targets.length === 0) return <>New root message</>;
  if (targets.length === 1) return <>Replying to: <strong>{nodeTitle(targets[0]!)}</strong></>;
  const listed = targets.slice(0, MAX_LISTED_TARGETS).map((t) => nodeTitle(t)).join(', ');
  const more = targets.length - MAX_LISTED_TARGETS;
  return <>Merging: <strong>{listed}</strong>{more > 0 ? ` +${more}` : ''}</>;
}

export function Composer({ targets, language, promptTokens, budget, models, model, onModelChange, onSend, sending, errorLine, onEscape, textareaRef }: ComposerProps) {
  const [text, setText] = useState('');
  const available = models.filter((m) => m.available);
  const used = promptTokens(text);
  const over = used > budget;
  const warn = !over && budget > 0 && used / budget >= 0.8;
  const canSend = available.length > 0 && text.trim() !== '' && !sending && !over;
  const merging = targets.length >= 2;

  const submit = (): void => { /* unchanged */ };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => { /* unchanged */ };
  const onInput = (e: FormEvent<HTMLTextAreaElement>): void => { /* unchanged */ };

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {errorLine && <p className="composer-error" role="alert">{errorLine}</p>}
      {over && <p className="composer-error" role="alert">{OVER_BUDGET[language]}</p>}
      <div className="composer-row">
        <span className="target">{targetLine(targets)}</span>
        <div className={`meter${over ? ' over' : warn ? ' warn' : ''}`} role="meter" aria-label="Context tokens" aria-valuenow={used} aria-valuemin={0} aria-valuemax={budget}>
          <span className="bar"><span className="fill" style={{ width: `${budget > 0 ? Math.min(100, (used / budget) * 100) : 100}%` }} /></span>
          <span className="meter-text">~{formatTokens(used)} / {formatTokens(budget)}</span>
        </div>
        {/* model chips + hint unchanged */}
      </div>
      <div className="composer-row">
        <textarea ref={textareaRef} rows={2} value={text} placeholder={merging ? PLACEHOLDER.merge[language] : PLACEHOLDER.single} onChange={(e) => setText(e.target.value)} onInput={onInput} onKeyDown={onKeyDown} disabled={available.length === 0} />
        <button type="submit" disabled={!canSend}>Send</button>
      </div>
    </form>
  );
}
```
Append to `apps/web/src/styles.css`:
```css
.composer .meter { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.composer .meter .bar { width: 80px; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; display: inline-block; }
.composer .meter .fill { display: block; height: 100%; background: var(--accent); }
.composer .meter.warn .fill { background: #d97706; }
.composer .meter.over .fill { background: #b42318; }
.composer .meter.over .meter-text { color: #b42318; }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @chatmind/web test -- Composer`
Expected: PASS. (`typecheck` of the web package fails on `App.tsx` until Task 10 — expected.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/Composer.tsx apps/web/src/styles.css apps/web/test/Composer.test.tsx
git commit -m "feat(web): composer lists merge targets, language placeholder, token meter with budget gate"
```

---

### Task 10: Wiring — selection state, Space/Esc, badges, ghost, graph interactions, send (web)

**Files:**
- Create: `apps/web/src/GhostNode.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/GraphView.tsx`, `apps/web/src/MessageNode.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/App.test.tsx`

**Interfaces:**
- Consumes: `SelectionState`, `clearSelection`, `effectiveTargets`, `toggleParticipation` (Task 7); `FlowMarks`, `GHOST_ID`, `GhostFlowNode` (Task 8); `Composer` props (Task 9); `graphLikeFromDto`, `contextSet`, `buildContext`, `promptTokens`, `budgetFor` from `@chatmind/core/graph`.
- Produces:
  ```ts
  // GraphView props
  interface Props { canvas: CanvasDto; streams; marks: FlowMarks; cursorId: string | null; focusIds: string[] | null;
                    onCursor: (id: string) => void; onToggle: (id: string) => void; onClear: () => void }
  ```
  Click on a message card → `onCursor`; ⇧-click or click on `.context-badge` → `onToggle`; click on the pane → `onClear`; ghost ignores clicks.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/App.test.tsx`:
1. Add `contextTokens: 200_000` to the `models` fixture entry.
2. Add a third canvas with two sibling branches and register it in `stubFetch`:
```ts
const canvases = [
  { slug: 'masterarbeit', nodeCount: 2 },
  { slug: 'python-lernen', nodeCount: 1 },
  { slug: 'zweige', nodeCount: 3 },
];
// A(user) → B(assistant) ; A → C(user): two branches under A
const zweige = {
  slug: 'zweige',
  nodes: [
    { id: '01JQ8F2H7T4WKD9M3XBQNAAAAA', role: 'user', parents: [], created: 'c', summary: 'Ursprungsfrage', topics: [], body: 'Wie evaluiere ich?', layout: { x: 0, y: 0, width: 400, height: 200 } },
    { id: '01JQ8F3K2M9XZP4V7NBHRCAAAA', role: 'assistant', model: 'claude-sonnet-4-6', parents: ['01JQ8F2H7T4WKD9M3XBQNAAAAA'], created: 'c', summary: 'Zentroid', topics: [], body: 'Zentroid statt Re-Clustering.', layout: { x: 0, y: 280, width: 400, height: 200 } },
    { id: '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA', role: 'user', parents: ['01JQ8F2H7T4WKD9M3XBQNAAAAA'], created: 'c', summary: 'Inhalt', topics: [], body: 'Inhaltliches Brainstorming.', layout: { x: 480, y: 280, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-a-b', from: '01JQ8F2H7T4WKD9M3XBQNAAAAA', to: '01JQ8F3K2M9XZP4V7NBHRCAAAA' }, { id: 'e-a-c', from: '01JQ8F2H7T4WKD9M3XBQNAAAAA', to: '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA' }],
  repairs: [],
};
```
   In `stubFetch`'s final `body` expression add `url.endsWith('/zweige') ? zweige :` before the `extraCanvasBodies` fallback.
3. Update the existing send assertion to the new body:
```ts
    expect(JSON.parse((sent![1] as RequestInit).body as string)).toEqual({ parentIds: ['01JQ8F3K2M9XZP4V7NBHRCAAAA'], excludedIds: [], content: 'Und weiter?', model: 'claude-opus-5' });
```
4. Append:
```ts
  async function openZweige(): Promise<void> {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /zweige/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('3 nodes'));
  }
  const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';
  const C = '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA';

  it('Space on two sibling nodes builds a merge: ghost, "Merging" chip, meter, and the request carries parentIds', async () => {
    await openZweige();
    fireEvent.keyDown(window, { key: 'ArrowDown' });   // A
    fireEvent.keyDown(window, { key: 'ArrowDown' });   // B
    fireEvent.keyDown(window, { key: ' ' });           // target B
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Zentroid');
    fireEvent.keyDown(window, { key: 'ArrowRight' });  // cursor C — targets unchanged
    expect(screen.getByText(/Replying to:/)).toHaveTextContent('Zentroid');
    fireEvent.keyDown(window, { key: ' ' });           // target C
    expect(screen.getByText(/Merging:/)).toHaveTextContent('Merging: Zentroid, Inhalt');
    // the fixture bodies are German ("Wie evaluiere ich?") → ghost text and badges are German
    expect(await screen.findByText('Merge · 2 Zweige')).toBeInTheDocument();
    expect(screen.getAllByText('im Kontext')).toHaveLength(1); // A only — targets B and C carry number badges instead
    expect(Number(screen.getByRole('meter').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'Combine.');
    fireEvent.keyDown(box, { key: 'Enter' });
    const sent = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith('/messages'));
    expect(JSON.parse((sent![1] as RequestInit).body as string)).toEqual({ parentIds: [B, C], excludedIds: [], content: 'Combine.', model: 'claude-opus-5' });
    await waitFor(() => expect(screen.queryByText('Merge · 2 Zweige')).toBeNull()); // selection cleared on send
  });

  it('Space on a highlighted ancestor excludes it; the badge click re-includes it; Esc clears everything', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));   // cursor B (implicit target)
    fireEvent.keyDown(window, { key: ' ' });                // make B an explicit target — otherwise moving the cursor moves the target
    fireEvent.keyDown(window, { key: 'ArrowUp' });          // cursor A, target stays B
    const before = Number(screen.getByRole('meter').getAttribute('aria-valuenow'));
    fireEvent.keyDown(window, { key: ' ' });                // A is in B's context → exclude
    expect(screen.getByRole('button', { name: /im Kontext/ })).toHaveClass('excluded');
    expect(Number(screen.getByRole('meter').getAttribute('aria-valuenow'))).toBeLessThan(before);
    fireEvent.click(screen.getByRole('button', { name: /im Kontext/ }));  // badge click → re-include
    expect(screen.getByRole('button', { name: /im Kontext/ })).not.toHaveClass('excluded');
    expect(Number(screen.getByRole('meter').getAttribute('aria-valuenow'))).toBe(before);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText('New root message')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /im Kontext/ })).toBeNull();
  });

  it('shift-click adds a target with the mouse', async () => {
    await openZweige();
    fireEvent.click(await screen.findByText('Zentroid'));
    fireEvent.click(screen.getByText('Inhalt'), { shiftKey: true });
    expect(screen.getByText(/Merging:/)).toHaveTextContent('Merging: Zentroid, Inhalt');
  });

  it('blocks sending over budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/models') return new Response(JSON.stringify([{ ...models[0], contextTokens: 16_010 }]), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/canvases') return new Response(JSON.stringify(canvases), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/masterarbeit')) return new Response(JSON.stringify(masterarbeit), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('not found', { status: 404 });
    }));
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    fireEvent.click(await screen.findByText('Zentroid'));
    expect(screen.getByRole('meter')).toHaveClass('over');
    expect(screen.getByRole('alert')).toHaveTextContent('Über Budget'); // German fixture bodies
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @chatmind/web test -- App`
Expected: FAIL — Space does nothing, no ghost, request body still `parentId`.

- [ ] **Step 3: Implement**

`apps/web/src/GhostNode.tsx`:
```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GhostFlowNode } from './flow';

/** Preview of the merge user node that a send would create (spec M4 §6.3). */
export function GhostNode({ data }: NodeProps<GhostFlowNode>) {
  return (
    <div className="ghost-node">
      <Handle type="target" position={Position.Top} />
      {data.language === 'de' ? `Merge · ${data.count} Zweige` : `Merge · ${data.count} branches`}
    </div>
  );
}
```

`apps/web/src/MessageNode.tsx` — add the badges:
```tsx
const CONTEXT_BADGE = { de: 'im Kontext', en: 'in context' } as const;

export function MessageNode({ data, selected }: NodeProps<MessageFlowNode>) {
  const preview = /* unchanged */;
  const cls = `message-node role-${data.role}${selected ? ' selected' : ''}${data.streaming ? ' streaming' : ''}${data.error ? ' error' : ''}${data.inContext ? ' in-context' : ''}${data.excluded ? ' excluded' : ''}`;
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} />
      {data.targetIndex !== undefined && <span className="target-badge" aria-label={`target ${data.targetIndex}`}>{data.targetIndex}</span>}
      <header>
        <span className="role">{data.model ? `${data.role} · ${data.model}` : data.role}</span>
        {data.inContext && data.targetIndex === undefined && (
          // Clicking bubbles to GraphView's onNodeClick, which recognises `.context-badge` and toggles exclusion.
          <button type="button" className={`context-badge${data.excluded ? ' excluded' : ''}`}>{CONTEXT_BADGE[data.language ?? 'en']}</button>
        )}
        <time dateTime={data.created}>{data.created.slice(0, 10)}</time>
      </header>
      {/* title, preview, error, source handle unchanged */}
    </div>
  );
}
```
(The badge is shown on context nodes that are not themselves targets — targets carry the number badge instead.)

`apps/web/src/GraphView.tsx`:
```tsx
import type { CanvasDto } from '@chatmind/core';
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo } from 'react';
import { GHOST_ID, toFlowEdges, toFlowNodes, type FlowMarks } from './flow';
import { GhostNode } from './GhostNode';
import { MessageNode } from './MessageNode';
import type { StreamState } from './streams';

const nodeTypes = { message: MessageNode, ghost: GhostNode };

interface Props {
  canvas: CanvasDto;
  streams: ReadonlyMap<string, StreamState>;
  marks: FlowMarks;
  cursorId: string | null;
  focusIds: string[] | null;
  onCursor: (id: string) => void;
  onToggle: (id: string) => void;
  onClear: () => void;
}

function Camera(/* unchanged */) {}

function Inner({ canvas, streams, marks, cursorId, focusIds, onCursor, onToggle, onClear }: Props) {
  const nodes = useMemo(() => toFlowNodes(canvas, streams, marks).map((n) => ({ ...n, selected: n.id === cursorId })), [canvas, streams, marks, cursorId]);
  const edges = useMemo(() => toFlowEdges(canvas, marks), [canvas, marks]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.1}
      onNodeClick={(event, node) => {
        if (node.id === GHOST_ID) return;
        const badge = (event.target as HTMLElement).closest('.context-badge');
        if (badge !== null || event.shiftKey) onToggle(node.id);
        else onCursor(node.id);
      }}
      onPaneClick={onClear}
      proOptions={{ hideAttribution: true }}
    >
      {/* Background, Controls, MiniMap, Camera unchanged */}
    </ReactFlow>
  );
}
```

`apps/web/src/App.tsx` — the changes, in order:

1. Imports:
```ts
import { budgetFor, buildContext, contextSet, graphLikeFromDto, promptTokens } from '@chatmind/core/graph';
import type { FlowMarks } from './flow';
import { clearSelection, effectiveTargets, toggleParticipation, type SelectionState } from './selection';
```
2. State: replace `const [selectedId, setSelectedId] = useState<string | null>(null);` with
```ts
const [selection, setSelection] = useState<SelectionState>(clearSelection);
const setCursor = (id: string | null): void => setSelection((s) => ({ ...s, cursorId: id }));
```
   `keyStateRef` becomes `useRef<{ canvas: CanvasDto | null; selection: SelectionState }>({ canvas: null, selection: clearSelection() })`, and its sync effect depends on `[canvas, selection]`.
3. On canvas switch (`useEffect` on `slug`): `setSelection(clearSelection())` instead of `setSelectedId(null)`.
4. Key handler body (add `' '` handling; `Esc` clears everything):
```ts
      const { canvas: cur, selection: sel } = keyStateRef.current;
      if (!cur) return;
      if (NAV_KEYS.has(e.key)) {
        e.preventDefault();
        const next = nextSelection(cur, sel.cursorId, e.key as NavKey);
        setCursor(next);
        if (next) setFocusIds([next]);
      } else if (e.key === ' ') {
        if (sel.cursorId === null) return;
        e.preventDefault();
        const id = sel.cursorId;
        setSelection((s) => toggleParticipation(graphLikeFromDto(cur), s, id));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        textareaRef.current?.focus();
      } else if (e.key === 'Escape') {
        setSelection(clearSelection());
      }
```
5. In `consume`: `setSelectedId(s.id)` → `setCursor(s.id)`; `setSelectedId(parentId)` → `setCursor(parentId)`.
6. In `send`:
```ts
      const res = await sendMessage(sendSlug, { parentIds: effectiveTargets(selection), excludedIds: selection.excluded, content, model });
      // … on !res.ok unchanged …
      setSelection(clearSelection());
      void consume(sendSlug, res.body);
      return true;
```
7. Derived values before the JSX (after `live`):
```ts
  const graphLike = useMemo(() => (live ? graphLikeFromDto(live) : null), [live]);
  const targets = effectiveTargets(selection);
  const built = useMemo(() => (graphLike ? buildContext(graphLike, targets, selection.excluded, '') : null), [graphLike, selection]);
  const marks: FlowMarks = useMemo(() => {
    const set = graphLike ? contextSet(graphLike, targets, selection.excluded) : null;
    return { targets, all: set?.all ?? new Set(), excluded: set?.excluded ?? new Set(), language: built?.language ?? 'en' };
  }, [graphLike, selection, built]);
  const countTokens = useCallback((text: string): number => (graphLike ? promptTokens(buildContext(graphLike, targets, selection.excluded, text)) : 0), [graphLike, selection]);
  const activeModel = models.find((m) => m.id === model);
  const budget = activeModel ? budgetFor(activeModel.contextTokens) : 0;
  const selected = live?.nodes.find((n) => n.id === selection.cursorId) ?? null;
  const selectedStream = selection.cursorId ? streams.get(selection.cursorId) : undefined;
  const targetNodes = live ? targets.map((id) => live.nodes.find((n) => n.id === id)).filter((n): n is NodeDto => n !== undefined) : [];
```
   (`targets` is derived from `selection`, so `selection` is the memo dependency; add `useMemo` to the react import. `live` must be memoised too — `const live = useMemo(() => (canvas ? applyStreams(canvas, streams) : null), [canvas, streams]);` — otherwise `graphLike` recomputes every render.)
8. JSX: `<GraphView canvas={live} streams={streams} marks={marks} cursorId={selection.cursorId} focusIds={focusIds} onCursor={setCursor} onToggle={(id) => setSelection((s) => toggleParticipation(graphLike!, s, id))} onClear={() => setSelection(clearSelection())} />` and `<Composer targets={targetNodes} language={marks.language} promptTokens={countTokens} budget={budget} … />` (remove the `target=` prop). `NodePanel` keeps `node={selected}`.

Append to `apps/web/src/styles.css`:
```css
.message-node { position: relative; }
.message-node.in-context { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.message-node.excluded { opacity: 0.45; }
.target-badge { position: absolute; top: -10px; left: -10px; width: 22px; height: 22px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 12px; font-weight: 600; display: grid; place-items: center; box-shadow: 0 0 0 2px var(--bg); }
.context-badge { font: inherit; font-size: 10px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; }
.context-badge.excluded { text-decoration: line-through; border-color: var(--muted); color: var(--muted); }
.ghost-node { width: 100%; height: 100%; box-sizing: border-box; border: 2px dashed var(--accent); border-radius: 8px; background: transparent; color: var(--accent); display: grid; place-items: center; font-size: 13px; }
.react-flow__edge.secondary .react-flow__edge-path { stroke-dasharray: 6 4; opacity: 0.6; }
```

- [ ] **Step 4: Run everything**

Run: `pnpm typecheck && pnpm test`
Expected: PASS across core, cli, server, web (including the previously failing request-body assertion).

If React Flow's `onNodeClick` in jsdom does not deliver `event.target` as the badge element for `fireEvent.click(badgeButton)`, verify by logging `event.target` once; the click on the `<button>` bubbles through the node wrapper where React Flow attaches the handler, so `closest('.context-badge')` finds it. If it still fails, attach a plain React `onClick` to the badge that calls `event.stopPropagation()` and dispatches a `CustomEvent('chatmind:toggle', { bubbles: true, detail: nodeId })` caught by a listener on the graph pane in `GraphView` — and report the deviation.

- [ ] **Step 5: Run the app once by hand**

Run: `pnpm dev`, open http://localhost:5173, select two sibling nodes with Space, confirm: numbered badges, "in context" badge on the shared ancestor, dashed ghost card with dashed second edge, meter value, "Merging:" chip; Space on the ancestor dims it and lowers the meter; Esc clears. Send needs a provider key — the full run is the gate task; here only the visuals are checked. Fix any visual glitch in `styles.css` before committing.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): multi-select with Space/shift-click, context badges, ghost merge node, merge sends"
```

---

### Task 11: Manual M4 gate — two-branch merge, round-trip, Obsidian

**Files:**
- Create: `docs/superpowers/notes/2026-09-13-m4-gate-findings.md`

- [ ] **Step 1: Prepare**

`pnpm test && pnpm typecheck` green. Start with `pnpm dev`. Open the `masterarbeit` canvas (or create one) and make sure two **independent** branches exist: one that ends in an outline-like message, one that ends in a content brainstorm (send them in M3 style if missing; a few messages each is enough).

- [ ] **Step 2: Walk the done condition** (spec §1) and record each item as pass/fail in the notes file:

1. Navigate with the arrows to the tip of branch 1, `Space`; arrows to the tip of branch 2, `Space`. Ghost appears under the first target with two edges (second dashed); composer says "Merging: ‹1›, ‹2›"; meter shows a value; the shared ancestors (if any) carry "in context"/"im Kontext".
2. Move the cursor to an exploratory ancestor in branch 1 and press `Space`: it dims, the meter drops. Press `Space` again: it returns.
3. Exclude at least one node, type an instruction ("Mach aus der Gliederung und dem Brainstorming einen Strukturvorschlag" or the English equivalent) and send. The user node lands on the ghost's slot, the assistant streams below it.
4. Read the answer: it draws recognisably on **both** branches and refers to the block labels (the card titles). Record one or two quotes.
5. `↓` onto the new assistant node, `Enter`, send a normal follow-up: it answers in the context of the merge (the preamble/blocks are replayed from the chain).
6. `pnpm cli check` → "no repairs needed". Open the vault in Obsidian: the merge node shows two incoming edges; open the node file: `parents: [id1, id2]`.
7. Reload the browser: the merge node renders with one solid and one dashed edge; `↑` from it goes to the first target.

- [ ] **Step 3: Fix what fails**

Any failure → fix with a test (TDD), commit `fix(...)`, re-run the failing item. List issues + fixes in the notes file, like `2026-09-13-m3-gate-findings.md`.

- [ ] **Step 4: Write the notes and commit**

```bash
git add docs/superpowers/notes/2026-09-13-m4-gate-findings.md
git commit -m "docs: record M4 gate findings"
```

---

### Task 12: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

- Status line: `Status: cycle 4 (merge). No summaries/embeddings yet.`
- Keyboard line: `Keyboard: ↑↓←→ move between nodes, Space add/remove the node as a merge target (or exclude a highlighted ancestor), Enter → composer, ⏎ send / ⇧⏎ newline, Esc clear selection / back to graph, ⇧⇥ + ←→ change model. ⇧-click adds a target with the mouse.`
- Add under Docs: `- M4 design: docs/superpowers/specs/2026-09-13-chatmind-m4-merge-design.md`

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README for merge (cycle 4)"
```

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| §2 data model, `parents` order, assistant invariant | 5 (reader), 6 (user node parents) |
| §4.1 browser-safe entry, `GraphLike` | 1 |
| §4.2 `contextSet` / §4.3 `validateTargets` | 2 |
| §4.4 `buildContext`, labels, preamble, roles / §4.5 language | 3 |
| §4.6 tokens | 4 |
| §4.7 reader repair | 5 |
| §5 API + `contextTokens` | 6 |
| §6.1 selection state / §6.2 input model | 7, 10 |
| §6.3 badges, ghost, edge styles | 8, 10 |
| §6.4 composer chip, placeholder, meter, send | 9, 10 |
| §7 layout unchanged | — (no change; ghost uses `placeChild`) |
| §8 tests | each task; property test in 3; manual gate 11 |
| §9 not in M4 | nothing here builds it |

Known deviations from the spec text, decided here and reflected back into the spec in the same commit: `detectLanguage` lives in `language.ts` (spec file map said `context.ts`); the English stopword list omits `in`/`an`; a single target yields one segment with empty `nodes` rather than "no segments"; the context badge is shown only on non-target context nodes (targets carry the number badge).
