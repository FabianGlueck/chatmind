# Cycle 2 (M2): Read-only Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Hono API server and a Vite/React/React-Flow frontend that make a cycle-1 vault navigable in the browser: pick a canvas, pan/zoom, click a node, read it.

**Architecture:** `@chatmind/core` gains a JSON DTO layer (`dto.ts`). `apps/server` (Hono) reads the vault per request via `readVault` and serves `CanvasDto`s; in prod it also serves the built frontend. `apps/web` (Vite + React 19 + `@xyflow/react`) maps `CanvasDto` → React Flow nodes/edges with a pure function and renders a read-only graph plus a markdown panel. Web imports only types from core.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript strict, Hono + `@hono/node-server`, Vite, React 19, `@xyflow/react`, `react-markdown`, vitest (+ jsdom, Testing Library for web).

**Spec:** `docs/superpowers/specs/2026-09-12-chatmind-m2-read-only-frontend-design.md` (M2), on top of `docs/superpowers/specs/2026-09-11-chatmind-vault-format-design.md` (invariants).

## Global Constraints

- Node `>=22` (`.nvmrc` = `22`), pnpm workspaces, every package `"type": "module"`; Node binary for shells: `put Node 22 and pnpm on `PATH` (e.g. `nvm use`)`.
- `@chatmind/core` runtime deps stay `js-yaml`, `ulid`, Node built-ins. `apps/web` imports from `@chatmind/core` with `import type` only.
- The server never writes to the vault; it reads via `readVault` on every request. It creates the data dir on start if absent (spec §11).
- Ports: API `3210` (`CHATMIND_PORT`), Vite dev `5173`. Data dir resolution unchanged: `--data-dir` → `CHATMIND_DATA_DIR` → `~/Documents/chatmind`.
- React Flow positions = canvas coordinates 1:1. Read-only: `nodesDraggable={false}`, `nodesConnectable={false}`.
- UI strings in English. No router, no state library, no CSS framework, no auth, no watcher.
- Install latest versions with `pnpm add` (no manual pins). Library APIs below are written against Hono 4, `@xyflow/react` 12, Vite 6+, React 19; if an installed major differs and an API moved, adapt minimally and report the change.
- TDD per task; commit per task with the session's attribution trailer.

## File Map

| Path | Responsibility |
|---|---|
| `packages/core/src/dto.ts` | `NodeDto`, `EdgeDto`, `CanvasDto`, `CanvasSummaryDto`, `toCanvasDto`, `toCanvasSummaryDto`, `repairsForCanvas` |
| `apps/server/src/app.ts` | `createApp({ dataDir, staticDir? })` — routes only |
| `apps/server/src/index.ts` | process entry: args/env, mkdir data dir, `serve()` |
| `apps/web/vite.config.ts`, `index.html`, `src/main.tsx` | Vite scaffold, `/api` proxy |
| `apps/web/src/api.ts` | fetch helpers |
| `apps/web/src/flow.ts` | pure `CanvasDto` → React Flow mapping |
| `apps/web/src/MessageNode.tsx`, `GraphView.tsx`, `NodePanel.tsx`, `App.tsx`, `styles.css` | UI |
| `apps/web/test/setup.ts` | jsdom mocks for React Flow |
| root `package.json` | `dev`, `build`, `start` scripts |

---

### Task 1: DTO layer in core

**Files:**
- Create: `packages/core/src/dto.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/dto.test.ts`

**Interfaces:**
- Consumes: `CanvasGraph`, `Layout`, `MessageNode`, `Repair` (`types.ts`); `derivedEdges` (`canvas.ts`); `canvasOrder` (`vault/write.ts`); `placeholderLayout` (`layout.ts`).
- Produces:
  ```ts
  interface NodeDto { id: string; role: 'user'|'assistant'; model?: string; parents: string[]; created: string; summary: string; topics: string[]; body: string; layout: Layout }
  interface EdgeDto { id: string; from: string; to: string }
  interface CanvasDto { slug: string; nodes: NodeDto[]; edges: EdgeDto[]; repairs: Repair[] }
  interface CanvasSummaryDto { slug: string; nodeCount: number }
  toCanvasDto(graph: CanvasGraph, repairs: Repair[]): CanvasDto
  toCanvasSummaryDto(graph: CanvasGraph): CanvasSummaryDto
  repairsForCanvas(graph: CanvasGraph, repairs: Repair[]): Repair[]
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/dto.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { repairsForCanvas, toCanvasDto, toCanvasSummaryDto } from '../src/dto';
import type { Repair } from '../src/types';
import { A, B, C, node, sampleGraph } from './helpers';

describe('toCanvasDto', () => {
  it('flattens nodes in canvas order with layout, and derives edges', () => {
    const g = sampleGraph();
    const dto = toCanvasDto(g, []);
    expect(dto.slug).toBe('masterarbeit');
    expect(dto.nodes.map((n) => n.id)).toEqual([A, B, C]);
    expect(dto.nodes[1]).toEqual({
      id: B, role: 'assistant', model: 'claude-sonnet-4-6', parents: [A], created: '2026-03-14T10:42:03Z',
      summary: 'Zentroid-Ansatz skaliert besser', topics: [], body: 'Zentroid statt Re-Clustering.\n\nBegründung folgt.',
      layout: { x: 0, y: 280, width: 400, height: 200 },
    });
    expect(dto.edges).toEqual([
      { id: `e-${A}-${B}`, from: A, to: B },
      { id: `e-${B}-${C}`, from: B, to: C },
    ]);
    expect(dto.repairs).toEqual([]);
  });

  it('omits the model key for user nodes and gives layout-less nodes a placeholder', () => {
    const g = sampleGraph();
    g.layout.delete(C);
    const dto = toCanvasDto(g, []);
    const c = dto.nodes.find((n) => n.id === C)!;
    expect('model' in c).toBe(false);
    expect(c.layout).toEqual({ x: 0, y: 560, width: 400, height: 200 });
  });

  it('follows graph.layout insertion order (canvas order), new nodes last', () => {
    const g = sampleGraph();
    const b = g.layout.get(B)!;
    g.layout.delete(B);
    g.layout.set(B, b);
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    g.nodes.set(D, node({ id: D, parents: [C] }));
    expect(toCanvasDto(g, []).nodes.map((n) => n.id)).toEqual([A, C, B, D]);
  });

  it('is JSON-serialisable without loss', () => {
    const dto = toCanvasDto(sampleGraph(), []);
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  });
});

describe('toCanvasSummaryDto', () => {
  it('reports slug and node count', () => {
    expect(toCanvasSummaryDto(sampleGraph())).toEqual({ slug: 'masterarbeit', nodeCount: 3 });
  });
});

describe('repairsForCanvas', () => {
  it('keeps repairs addressed to this canvas by slug, node id or path', () => {
    const g = sampleGraph();
    const repairs: Repair[] = [
      { kind: 'canvas-missing', canvas: 'masterarbeit' },
      { kind: 'canvas-missing', canvas: 'other' },
      { kind: 'layout-missing', id: A },
      { kind: 'layout-missing', id: '01JQ8F9ZZZZZZZZZZZZZZZZZZZ' },
      { kind: 'unparseable-node', path: 'masterarbeit/nodes/junk.md', reason: 'x' },
      { kind: 'unparseable-node', path: 'other/nodes/junk.md', reason: 'x' },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: 'd' },
      { kind: 'dangling-parent', id: C, parent: 'X' },
    ];
    expect(repairsForCanvas(g, repairs)).toEqual([
      { kind: 'canvas-missing', canvas: 'masterarbeit' },
      { kind: 'layout-missing', id: A },
      { kind: 'unparseable-node', path: 'masterarbeit/nodes/junk.md', reason: 'x' },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: 'd' },
      { kind: 'dangling-parent', id: C, parent: 'X' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core exec vitest run test/dto.test.ts`
Expected: FAIL — cannot resolve `../src/dto`.

- [ ] **Step 3: Implement**

`packages/core/src/dto.ts`:
```ts
import { derivedEdges } from './canvas';
import { placeholderLayout } from './layout';
import type { CanvasGraph, Layout, Repair, Role } from './types';
import { canvasOrder } from './vault/write';

/** JSON-safe projection of a MessageNode plus its canvas position. */
export interface NodeDto {
  id: string;
  role: Role;
  model?: string;
  parents: string[];
  created: string;
  summary: string;
  topics: string[];
  body: string;
  layout: Layout;
}

export interface EdgeDto {
  id: string;
  from: string;
  to: string;
}

export interface CanvasDto {
  slug: string;
  nodes: NodeDto[];
  edges: EdgeDto[];
  repairs: Repair[];
}

export interface CanvasSummaryDto {
  slug: string;
  nodeCount: number;
}

/** Nodes in canvas order (spec §10), every node with a layout; edges derived from `parents` (spec §3.6). */
export function toCanvasDto(graph: CanvasGraph, repairs: Repair[]): CanvasDto {
  const nodes: NodeDto[] = [];
  for (const n of canvasOrder(graph)) {
    const dto: NodeDto = {
      id: n.id,
      role: n.role,
      parents: [...n.parents],
      created: n.created,
      summary: n.summary,
      topics: [...n.topics],
      body: n.body,
      layout: graph.layout.get(n.id) ?? placeholderLayout(n, graph.layout),
    };
    if (n.model !== undefined) dto.model = n.model;
    nodes.push(dto);
  }
  const edges = derivedEdges(graph).map((e) => ({ id: e.id, from: e.fromNode, to: e.toNode }));
  return { slug: graph.slug, nodes, edges, repairs: repairsForCanvas(graph, repairs) };
}

export function toCanvasSummaryDto(graph: CanvasGraph): CanvasSummaryDto {
  return { slug: graph.slug, nodeCount: graph.nodes.size };
}

/** The subset of a vault's repairs that concern this canvas. */
export function repairsForCanvas(graph: CanvasGraph, repairs: Repair[]): Repair[] {
  return repairs.filter((r) => {
    if ('canvas' in r) return r.canvas === graph.slug;
    if ('path' in r) return r.path.startsWith(`${graph.slug}/`);
    return graph.nodes.has(r.id);
  });
}
```

Note: `toCanvasDto` uses `placeholderLayout` for nodes without a layout but does **not** write into `graph.layout` (a DTO projection has no side effects); the ordering of such nodes still comes from `canvasOrder`, which lists them last by id.

Append to `packages/core/src/index.ts`:
```ts
export { toCanvasDto, toCanvasSummaryDto, repairsForCanvas, type NodeDto, type EdgeDto, type CanvasDto, type CanvasSummaryDto } from './dto';
```
(If `canvasOrder` is not yet exported from the barrel after the cycle-1 fix wave, add it to the `./vault/write` export line.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chatmind/core exec vitest run test/dto.test.ts && pnpm typecheck`
Expected: 6 tests PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/dto.ts packages/core/src/index.ts packages/core/test/dto.test.ts
git commit -m "feat(core): JSON DTO projection of a canvas graph"
```

---

### Task 2: Hono API server

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Test: `apps/server/test/app.test.ts`
- Modify: root `package.json` (scripts)

**Interfaces:**
- Consumes: `readVault`, `resolveDataDir`, `toCanvasDto`, `toCanvasSummaryDto` from `@chatmind/core`; `writeCanvas`, `linearGraph` in tests.
- Produces: `createApp(options: { dataDir: string; staticDir?: string }): Hono`; routes `GET /api/canvases`, `GET /api/canvases/:slug`; static + SPA fallback when `staticDir` is given. Entry `pnpm --filter @chatmind/server start` / root `pnpm start`.

- [ ] **Step 1: Create the package and install**

`apps/server/package.json`:
```json
{
  "name": "@chatmind/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts --static ../web/dist",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@chatmind/core": "workspace:*"
  }
}
```

`apps/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `pnpm --filter @chatmind/server add hono @hono/node-server && pnpm install`
Expected: `hono` and `@hono/node-server` in `apps/server/package.json` dependencies.

- [ ] **Step 2: Write the failing tests**

`apps/server/test/app.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linearGraph, writeCanvas } from '@chatmind/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-server-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

async function vaultWithCanvas(): Promise<string> {
  const root = await tmpDir();
  const g = linearGraph('masterarbeit', [
    { role: 'user', content: 'Frage', summary: 'Ursprungsfrage' },
    { role: 'assistant', content: 'Antwort', model: 'claude-sonnet-4-6' },
  ]);
  await writeCanvas(g, root);
  return root;
}

describe('GET /api/canvases', () => {
  it('lists canvases with node counts', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    const res = await app.request('/api/canvases');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ slug: 'masterarbeit', nodeCount: 2 }]);
  });

  it('returns [] for an empty data dir and for a missing one', async () => {
    const empty = createApp({ dataDir: await tmpDir() });
    expect(await (await empty.request('/api/canvases')).json()).toEqual([]);
    const missing = createApp({ dataDir: path.join(await tmpDir(), 'nope') });
    expect(await (await missing.request('/api/canvases')).json()).toEqual([]);
  });
});

describe('GET /api/canvases/:slug', () => {
  it('returns the canvas dto', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    const res = await app.request('/api/canvases/masterarbeit');
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.slug).toBe('masterarbeit');
    expect(dto.nodes).toHaveLength(2);
    expect(dto.nodes[0].summary).toBe('Ursprungsfrage');
    expect(dto.nodes[0].layout).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(dto.edges).toHaveLength(1);
    expect(dto.repairs).toEqual([]);
  });

  it('404s for an unknown slug', async () => {
    const app = createApp({ dataDir: await vaultWithCanvas() });
    const res = await app.request('/api/canvases/unknown');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'canvas not found' });
  });
});

describe('static frontend', () => {
  it('serves files from staticDir and falls back to index.html', async () => {
    const dist = await tmpDir();
    await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>chatmind</title>');
    await fs.mkdir(path.join(dist, 'assets'));
    await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
    const app = createApp({ dataDir: await tmpDir(), staticDir: dist });
    expect(await (await app.request('/assets/app.js')).text()).toBe('console.log(1)');
    expect(await (await app.request('/')).text()).toContain('<title>chatmind</title>');
    expect(await (await app.request('/some/client/route')).text()).toContain('<title>chatmind</title>');
    expect((await app.request('/api/canvases/unknown')).status).toBe(404); // API still wins
  });

  it('does not serve anything static without staticDir', async () => {
    const app = createApp({ dataDir: await tmpDir() });
    expect((await app.request('/')).status).toBe(404);
  });
});
```

Run: `pnpm --filter @chatmind/server test`
Expected: FAIL — cannot resolve `../src/app`.

- [ ] **Step 3: Implement the app**

`apps/server/src/app.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readVault, toCanvasDto, toCanvasSummaryDto, type ReadResult } from '@chatmind/core';
import { Hono } from 'hono';

export interface AppOptions {
  dataDir: string;
  /** Built frontend (apps/web/dist). When omitted, only /api routes exist. */
  staticDir?: string;
}

/** Read the vault; a missing data dir is an empty vault, everything else propagates. */
async function readOrEmpty(dataDir: string): Promise<ReadResult> {
  try {
    return await readVault(dataDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { canvases: [], repairs: [] };
    throw err;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function createApp({ dataDir, staticDir }: AppOptions): Hono {
  const app = new Hono();

  app.get('/api/canvases', async (c) => {
    const { canvases } = await readOrEmpty(dataDir);
    return c.json(canvases.map(toCanvasSummaryDto).sort((a, b) => (a.slug < b.slug ? -1 : 1)));
  });

  app.get('/api/canvases/:slug', async (c) => {
    const { canvases, repairs } = await readOrEmpty(dataDir);
    const graph = canvases.find((g) => g.slug === c.req.param('slug'));
    if (!graph) return c.json({ error: 'canvas not found' }, 404);
    return c.json(toCanvasDto(graph, repairs));
  });

  if (staticDir !== undefined) {
    const root = path.resolve(staticDir);
    app.get('/*', async (c) => {
      const requested = path.resolve(root, `.${c.req.path}`);
      const file = requested.startsWith(root + path.sep) && (await isFile(requested)) ? requested : path.join(root, 'index.html');
      try {
        const body = await fs.readFile(file);
        return c.body(body, 200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      } catch {
        return c.notFound();
      }
    });
  }

  return app;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
```

A hand-rolled static handler (≈15 lines) is used instead of `@hono/node-server/serve-static` because the latter resolves `root` relative to `process.cwd()`, which differs between `pnpm start` (package dir) and direct invocation; the SPA fallback is also explicit this way. Keep `@hono/node-server` for `serve()` only.

`apps/server/src/index.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveDataDir } from '@chatmind/core';
import { serve } from '@hono/node-server';
import { createApp } from './app';

const invokedFrom = process.env.INIT_CWD ?? process.cwd();
const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    port: { type: 'string' },
    static: { type: 'string' },
  },
});

const dataDir = resolveDataDir(values['data-dir'] === undefined ? undefined : path.resolve(invokedFrom, values['data-dir']));
const port = Number(values.port ?? process.env.CHATMIND_PORT ?? 3210);
// `--static` is given relative to the server package (see package.json "start"), not the invoking shell.
const staticDir = values.static === undefined ? undefined : path.resolve(import.meta.dirname, '..', values.static);

await fs.mkdir(dataDir, { recursive: true });
const app = createApp({ dataDir, staticDir });
serve({ fetch: app.fetch, port }, () => {
  console.log(`chatmind server on http://localhost:${port}  data dir: ${dataDir}${staticDir ? `  serving ${staticDir}` : ''}`);
});
```

(`import.meta.dirname` exists on Node ≥ 20.11.) If `hono` resolved to a major where `c.body(body, 200, headers)` or `c.req.param()` changed, adapt and report.

Root `package.json` scripts — add:
```json
"dev": "pnpm -r --parallel run dev",
"start": "pnpm --filter @chatmind/server start"
```

- [ ] **Step 4: Run tests, typecheck, and a real start**

Run: `pnpm --filter @chatmind/server test && pnpm typecheck`
Expected: 6 tests PASS; tsc exit 0 for all packages.

Run (background, then curl, then kill): `pnpm --filter @chatmind/server exec tsx src/index.ts --data-dir /tmp/chatmind-m0 --port 3999 & sleep 2; curl -s localhost:3999/api/canvases; kill %1`
Expected: `[{"slug":"masterarbeit","nodeCount":5}]` (the cycle-1 scratch vault; if `/tmp/chatmind-m0` no longer exists, run `pnpm cli import-transcript apps/cli/fixtures/transcript.json --canvas masterarbeit --data-dir /tmp/chatmind-m0` first).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): Hono API serving canvases as JSON, static frontend in prod"
```

---

### Task 3: Web scaffold with API proxy and test setup

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/styles.css`, `apps/web/test/setup.ts`
- Test: `apps/web/test/App.test.tsx`

**Interfaces:**
- Consumes: `CanvasDto`, `CanvasSummaryDto` (types) from `@chatmind/core`.
- Produces: `fetchCanvases(): Promise<CanvasSummaryDto[]>`, `fetchCanvas(slug): Promise<CanvasDto>`; `<App />` that lists canvases and loads the first; `pnpm --filter @chatmind/web dev|build|test|typecheck`.

- [ ] **Step 1: Create the package and install**

`apps/web/package.json`:
```json
{
  "name": "@chatmind/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@chatmind/core": "workspace:*"
  }
}
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client", "node", "@testing-library/jest-dom"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

Run from the repo root:
```bash
pnpm --filter @chatmind/web add react react-dom @xyflow/react react-markdown
pnpm --filter @chatmind/web add -D vite @vitejs/plugin-react @types/react @types/react-dom jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

`apps/web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3210' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    css: false,
  },
});
```
(If the installed vitest requires `/// <reference types="vitest/config" />` or `defineConfig` from `vitest/config` for the `test` key to typecheck, use `import { defineConfig } from 'vitest/config'` — it re-exports Vite's.)

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>chatmind</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/web/src/api.ts`:
```ts
import type { CanvasDto, CanvasSummaryDto } from '@chatmind/core';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export function fetchCanvases(): Promise<CanvasSummaryDto[]> {
  return getJson('/api/canvases');
}

export function fetchCanvas(slug: string): Promise<CanvasDto> {
  return getJson(`/api/canvases/${encodeURIComponent(slug)}`);
}
```

`apps/web/src/App.tsx` (scaffold version; Task 5 extends it):
```tsx
import type { CanvasDto, CanvasSummaryDto } from '@chatmind/core';
import { useEffect, useState } from 'react';
import { fetchCanvas, fetchCanvases } from './api';

export function App() {
  const [canvases, setCanvases] = useState<CanvasSummaryDto[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<CanvasDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCanvases()
      .then((list) => {
        setCanvases(list);
        const fromUrl = new URLSearchParams(window.location.search).get('canvas');
        const initial = list.find((c) => c.slug === fromUrl)?.slug ?? list[0]?.slug ?? null;
        setSlug(initial);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (slug === null) return;
    setCanvas(null);
    fetchCanvas(slug).then(setCanvas).catch((e: unknown) => setError(String(e)));
  }, [slug]);

  if (error) return <main className="empty">Could not reach the chatmind server: {error}</main>;
  if (canvases === null) return <main className="empty">Loading…</main>;
  if (canvases.length === 0) return <main className="empty">No canvases yet. Run <code>pnpm cli import-transcript …</code> to create one.</main>;

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
      </nav>
      <main className="graph">{canvas ? <p data-testid="canvas-loaded">{canvas.nodes.length} nodes</p> : <p>Loading canvas…</p>}</main>
    </div>
  );
}
```

`apps/web/src/styles.css`:
```css
:root {
  color-scheme: light dark;
  --bg: #fafafa;
  --fg: #1a1a1a;
  --muted: #666;
  --panel: #fff;
  --border: #ddd;
  --accent: #3b6ef5;
  --user: #e8f0ff;
  --assistant: #f3f3f3;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161616;
    --fg: #e6e6e6;
    --muted: #9a9a9a;
    --panel: #1f1f1f;
    --border: #333;
    --accent: #7aa2ff;
    --user: #1f2a44;
    --assistant: #262626;
  }
}
html, body, #root { height: 100%; margin: 0; background: var(--bg); color: var(--fg); }
.layout { display: grid; grid-template-columns: 220px 1fr 380px; height: 100%; }
.sidebar { border-right: 1px solid var(--border); padding: 12px; overflow: auto; }
.sidebar h1 { font-size: 16px; margin: 4px 0 12px; }
.sidebar ul { list-style: none; padding: 0; margin: 0; }
.sidebar button { width: 100%; text-align: left; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.sidebar button.active { background: var(--accent); color: #fff; }
.sidebar .count { float: right; color: var(--muted); }
.sidebar button.active .count { color: #fff; }
.graph { position: relative; min-width: 0; }
.panel { border-left: 1px solid var(--border); padding: 16px; overflow: auto; background: var(--panel); }
.empty { display: grid; place-items: center; height: 100%; color: var(--muted); }
.banner { position: absolute; top: 8px; left: 8px; z-index: 5; background: #fff3cd; color: #664d03; padding: 6px 10px; border-radius: 6px; font-size: 12px; }
```
(Node-card styles are added in Task 5.)

`apps/web/test/setup.ts` — the jsdom mocks React Flow needs (from the xyflow testing guide):
```ts
import '@testing-library/jest-dom/vitest';

class ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver = ResizeObserver as unknown as typeof window.ResizeObserver;

class DOMMatrixReadOnly {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([1-9.])\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = DOMMatrixReadOnly;

Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { get() { return parseFloat((this as HTMLElement).style.height) || 1; } },
  offsetWidth: { get() { return parseFloat((this as HTMLElement).style.width) || 1; } },
});
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
```

- [ ] **Step 2: Write the failing smoke test**

`apps/web/test/App.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const canvases = [
  { slug: 'masterarbeit', nodeCount: 2 },
  { slug: 'python-lernen', nodeCount: 1 },
];
const masterarbeit = {
  slug: 'masterarbeit',
  nodes: [
    { id: '01JQ8F2H7T4WKD9M3XBQNAAAAA', role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: 'Ursprungsfrage', topics: [], body: 'Wie evaluiere ich?', layout: { x: 0, y: 0, width: 400, height: 200 } },
    { id: '01JQ8F3K2M9XZP4V7NBHRCAAAA', role: 'assistant', model: 'claude-sonnet-4-6', parents: ['01JQ8F2H7T4WKD9M3XBQNAAAAA'], created: '2026-03-14T10:43:03Z', summary: 'Zentroid', topics: [], body: 'Zentroid statt Re-Clustering.', layout: { x: 0, y: 280, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-a-b', from: '01JQ8F2H7T4WKD9M3XBQNAAAAA', to: '01JQ8F3K2M9XZP4V7NBHRCAAAA' }],
  repairs: [],
};
const python = { slug: 'python-lernen', nodes: [], edges: [], repairs: [] };

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url === '/api/canvases' ? canvases : url.endsWith('/masterarbeit') ? masterarbeit : url.endsWith('/python-lernen') ? python : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('lists canvases and loads the first one', async () => {
    stubFetch();
    render(<App />);
    expect(await screen.findByRole('button', { name: /masterarbeit/ })).toHaveClass('active');
    expect(screen.getByRole('button', { name: /python-lernen/ })).not.toHaveClass('active');
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('2 nodes'));
  });

  it('switches canvases on click', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    await userEvent.click(screen.getByRole('button', { name: /python-lernen/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-loaded')).toHaveTextContent('0 nodes'));
  });

  it('shows an empty state when there are no canvases', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    render(<App />);
    expect(await screen.findByText(/No canvases yet/)).toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @chatmind/web test`
Expected: FAIL until `App.tsx`/`api.ts` exist (if you created them in Step 1 already, the tests should PASS — then this step is your GREEN; state which in the report).

- [ ] **Step 3: Verify dev server and build**

Run: `pnpm --filter @chatmind/web test && pnpm typecheck && pnpm --filter @chatmind/web build`
Expected: 3 tests PASS; tsc exit 0; `apps/web/dist/index.html` exists.

Add `apps/web/dist/` to root `.gitignore` if `dist/` is not already covered (it is: `dist/`).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(web): Vite + React scaffold with canvas list and API proxy"
```

---

### Task 4: Pure CanvasDto → React Flow mapping

**Files:**
- Create: `apps/web/src/flow.ts`
- Test: `apps/web/test/flow.test.ts`

**Interfaces:**
- Consumes: `CanvasDto`, `NodeDto` types; `Node`, `Edge` types from `@xyflow/react`.
- Produces:
  ```ts
  type MessageNodeData = { role: 'user'|'assistant'; model?: string; summary: string; body: string; created: string };
  type MessageFlowNode = Node<MessageNodeData, 'message'>;
  toFlowNodes(dto: CanvasDto): MessageFlowNode[];
  toFlowEdges(dto: CanvasDto): Edge[];
  nodeTitle(n: { summary: string; body: string }): string;   // summary or first line of body (≤ 80 chars)
  ```

- [ ] **Step 1: Write the failing tests**

`apps/web/test/flow.test.ts`:
```ts
import type { CanvasDto } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { nodeTitle, toFlowEdges, toFlowNodes } from '../src/flow';

const dto: CanvasDto = {
  slug: 'm',
  nodes: [
    { id: 'A', role: 'user', parents: [], created: '2026-01-01T00:00:00Z', summary: 'Frage', topics: [], body: 'Body A', layout: { x: 10, y: 20, width: 400, height: 200 } },
    { id: 'B', role: 'assistant', model: 'm1', parents: ['A'], created: '2026-01-01T00:01:00Z', summary: '', topics: [], body: 'Erste Zeile\n\nZweite', layout: { x: 10, y: 300, width: 400, height: 200 } },
  ],
  edges: [{ id: 'e-A-B', from: 'A', to: 'B' }],
  repairs: [],
};

describe('toFlowNodes', () => {
  it('maps position and size 1:1 and carries the message data', () => {
    const nodes = toFlowNodes(dto);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      id: 'A', type: 'message', position: { x: 10, y: 20 }, width: 400, height: 200,
      draggable: false, connectable: false,
      data: { role: 'user', summary: 'Frage', body: 'Body A', created: '2026-01-01T00:00:00Z' },
    });
    expect(nodes[1]!.data.model).toBe('m1');
    expect('model' in nodes[0]!.data).toBe(false);
  });
});

describe('toFlowEdges', () => {
  it('maps from/to to source/target with smoothstep type', () => {
    expect(toFlowEdges(dto)).toEqual([{ id: 'e-A-B', source: 'A', target: 'B', type: 'smoothstep' }]);
  });
});

describe('nodeTitle', () => {
  it('prefers the summary', () => expect(nodeTitle({ summary: 'S', body: 'B' })).toBe('S'));
  it('falls back to the first non-empty body line, capped at 80 chars', () => {
    expect(nodeTitle({ summary: '', body: '\n\nErste Zeile\nZweite' })).toBe('Erste Zeile');
    expect(nodeTitle({ summary: '', body: 'x'.repeat(100) })).toBe('x'.repeat(79) + '…');
  });
  it('is "(empty)" for an empty message', () => expect(nodeTitle({ summary: '', body: '  ' })).toBe('(empty)'));
});
```

Run: `pnpm --filter @chatmind/web exec vitest run test/flow.test.ts`
Expected: FAIL — cannot resolve `../src/flow`.

- [ ] **Step 2: Implement**

`apps/web/src/flow.ts`:
```ts
import type { CanvasDto, NodeDto } from '@chatmind/core';
import type { Edge, Node } from '@xyflow/react';

export type MessageNodeData = {
  role: NodeDto['role'];
  model?: string;
  summary: string;
  body: string;
  created: string;
};

export type MessageFlowNode = Node<MessageNodeData, 'message'>;

const TITLE_MAX = 80;

/** Summary if present, else the first non-empty body line (capped), else "(empty)". */
export function nodeTitle(n: { summary: string; body: string }): string {
  if (n.summary !== '') return n.summary;
  const line = n.body.split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (line === undefined) return '(empty)';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** Canvas coordinates are React Flow coordinates — no transformation (spec M2 §2). */
export function toFlowNodes(dto: CanvasDto): MessageFlowNode[] {
  return dto.nodes.map((n) => {
    const data: MessageNodeData = { role: n.role, summary: n.summary, body: n.body, created: n.created };
    if (n.model !== undefined) data.model = n.model;
    return {
      id: n.id,
      type: 'message',
      position: { x: n.layout.x, y: n.layout.y },
      width: n.layout.width,
      height: n.layout.height,
      draggable: false,
      connectable: false,
      data,
    };
  });
}

export function toFlowEdges(dto: CanvasDto): Edge[] {
  return dto.edges.map((e) => ({ id: e.id, source: e.from, target: e.to, type: 'smoothstep' }));
}
```

- [ ] **Step 3: Run to verify pass, commit**

Run: `pnpm --filter @chatmind/web test && pnpm typecheck`
Expected: all web tests PASS; tsc exit 0.

```bash
git add apps/web/src/flow.ts apps/web/test/flow.test.ts
git commit -m "feat(web): pure CanvasDto → React Flow mapping"
```

---

### Task 5: Graph view, node card, node panel

**Files:**
- Create: `apps/web/src/MessageNode.tsx`, `apps/web/src/GraphView.tsx`, `apps/web/src/NodePanel.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/NodePanel.test.tsx`, `apps/web/test/App.test.tsx` (extend)

**Interfaces:**
- Consumes: `toFlowNodes`, `toFlowEdges`, `nodeTitle`, `MessageFlowNode` (Task 4); `CanvasDto`, `NodeDto` types.
- Produces: `<GraphView canvas selectedId onSelect />`, `<NodePanel node />`, `<MessageNode />` registered as node type `'message'`.

- [ ] **Step 1: Write the failing NodePanel test**

`apps/web/test/NodePanel.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NodePanel } from '../src/NodePanel';

const node = {
  id: '01JQ8F3K2M9XZP4V7NBHRCAAAA', role: 'assistant' as const, model: 'claude-sonnet-4-6',
  parents: ['01JQ8F2H7T4WKD9M3XBQNAAAAA'], created: '2026-03-14T10:42:03Z', summary: 'Zentroid',
  topics: ['eval'], body: '# Titel\n\nEin **fetter** Satz.\n\n- eins\n- zwei',
  layout: { x: 0, y: 0, width: 400, height: 200 },
};

describe('NodePanel', () => {
  it('renders metadata and the body as markdown', () => {
    render(<NodePanel node={node} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Zentroid' })).toBeInTheDocument();
    expect(screen.getByText('assistant · claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByText('2026-03-14T10:42:03Z')).toBeInTheDocument();
    expect(screen.getByText('eval')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Titel' })).toBeInTheDocument();
    expect(screen.getByText('fetter').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['eins', 'zwei']);
  });

  it('shows an empty state without a node', () => {
    render(<NodePanel node={null} />);
    expect(screen.getByText('Select a node to read it.')).toBeInTheDocument();
  });
});
```

Run: `pnpm --filter @chatmind/web exec vitest run test/NodePanel.test.tsx`
Expected: FAIL — cannot resolve `../src/NodePanel`.

- [ ] **Step 2: Implement the three components**

`apps/web/src/NodePanel.tsx`:
```tsx
import type { NodeDto } from '@chatmind/core';
import Markdown from 'react-markdown';
import { nodeTitle } from './flow';

export function NodePanel({ node }: { node: NodeDto | null }) {
  if (node === null) return <aside className="panel empty">Select a node to read it.</aside>;
  return (
    <aside className="panel">
      <h2>{nodeTitle(node)}</h2>
      <p className="meta">
        <span className={`role role-${node.role}`}>{node.model ? `${node.role} · ${node.model}` : node.role}</span>
        <br />
        <time dateTime={node.created}>{node.created}</time>
      </p>
      {node.topics.length > 0 && (
        <p className="topics">
          {node.topics.map((t) => (
            <span key={t} className="topic">{t}</span>
          ))}
        </p>
      )}
      <div className="body">
        <Markdown>{node.body}</Markdown>
      </div>
    </aside>
  );
}
```

Note: the test's `'assistant · claude-sonnet-4-6'` text lives in a single `<span>`; `topics` are rendered as separate spans so `getByText('eval')` matches.

`apps/web/src/MessageNode.tsx`:
```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { MessageFlowNode } from './flow';
import { nodeTitle } from './flow';

const PREVIEW_MAX = 200;

export function MessageNode({ data, selected }: NodeProps<MessageFlowNode>) {
  const preview = data.body.length > PREVIEW_MAX ? `${data.body.slice(0, PREVIEW_MAX)}…` : data.body;
  return (
    <div className={`message-node role-${data.role}${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <header>
        <span className="role">{data.model ? `${data.role} · ${data.model}` : data.role}</span>
        <time dateTime={data.created}>{data.created.slice(0, 10)}</time>
      </header>
      <strong className="title">{nodeTitle(data)}</strong>
      <p className="preview">{preview}</p>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
```

`apps/web/src/GraphView.tsx`:
```tsx
import type { CanvasDto } from '@chatmind/core';
import { Background, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { toFlowEdges, toFlowNodes } from './flow';
import { MessageNode } from './MessageNode';

const nodeTypes = { message: MessageNode };

export function GraphView({ canvas, selectedId, onSelect }: { canvas: CanvasDto; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const nodes = useMemo(() => toFlowNodes(canvas).map((n) => ({ ...n, selected: n.id === selectedId })), [canvas, selectedId]);
  const edges = useMemo(() => toFlowEdges(canvas), [canvas]);
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
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
```

Replace the `<main className="graph">…</main>` block in `apps/web/src/App.tsx` and add selection state:
```tsx
// add to imports
import { GraphView } from './GraphView';
import { NodePanel } from './NodePanel';
// add state next to the others
const [selectedId, setSelectedId] = useState<string | null>(null);
// reset selection when the canvas changes: inside the slug effect, before fetchCanvas
setSelectedId(null);
// replace the <main> block:
<main className="graph">
  {canvas ? (
    <>
      {canvas.repairs.length > 0 && (
        <div className="banner" role="status">
          {canvas.repairs.length} repair{canvas.repairs.length === 1 ? '' : 's'} pending — run <code>pnpm cli check</code>
        </div>
      )}
      <GraphView canvas={canvas} selectedId={selectedId} onSelect={setSelectedId} />
      <span hidden data-testid="canvas-loaded">{canvas.nodes.length} nodes</span>
    </>
  ) : (
    <p className="empty">Loading canvas…</p>
  )}
</main>
<NodePanel node={canvas?.nodes.find((n) => n.id === selectedId) ?? null} />
```
(Keep `data-testid="canvas-loaded"` — the Task 3 tests rely on it; `hidden` keeps it out of the UI while `toHaveTextContent` still reads it.)

Append to `apps/web/src/styles.css`:
```css
.message-node { width: 100%; height: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--assistant); color: var(--fg); overflow: hidden; display: flex; flex-direction: column; gap: 4px; }
.message-node.role-user { background: var(--user); }
.message-node.selected { outline: 2px solid var(--accent); }
.message-node header { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
.message-node .title { font-size: 13px; line-height: 1.3; }
.message-node .preview { margin: 0; font-size: 12px; color: var(--muted); white-space: pre-wrap; overflow: hidden; }
.panel h2 { margin-top: 0; font-size: 16px; }
.panel .meta { color: var(--muted); font-size: 12px; }
.panel .topic { display: inline-block; background: var(--assistant); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; margin-right: 4px; font-size: 12px; }
.panel .body { line-height: 1.5; }
.panel .body pre { overflow: auto; background: var(--assistant); padding: 8px; border-radius: 6px; }
```

- [ ] **Step 3: Extend the App smoke test**

Append to the `describe('App')` block in `apps/web/test/App.test.tsx`:
```tsx
  it('renders the graph and opens a node in the panel on click', async () => {
    stubFetch();
    render(<App />);
    await screen.findByTestId('canvas-loaded');
    expect(document.querySelector('.react-flow')).not.toBeNull();
    expect(screen.getByText('Select a node to read it.')).toBeInTheDocument();
    await userEvent.click(await screen.findByText('Ursprungsfrage'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Ursprungsfrage' })).toBeInTheDocument();
    expect(screen.getByText('Wie evaluiere ich?')).toBeInTheDocument();
  });
```

If React Flow does not render node DOM under jsdom despite the `test/setup.ts` mocks (the click target `Ursprungsfrage` never appears), do not delete the assertion: replace the click part with a direct render of `<NodePanel>` already covered elsewhere, keep the `.react-flow` presence check, and report the limitation with the exact failure — the controller will rule.

- [ ] **Step 4: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm --filter @chatmind/web build`
Expected: all packages green; build succeeds; bundle contains no `node:` imports (Vite would fail the build if it did).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): read-only React Flow graph with node cards and markdown panel"
```

---

### Task 6: Manual M2 gate — navigate the real vault in the browser

This task is manual and is the milestone's done condition. Do not proceed to Task 7 until it is complete.

**Files:**
- Create: `docs/superpowers/notes/2026-09-12-m2-browser-findings.md`
- Possibly modify: anything in `apps/web/src` the findings require.

- [ ] **Step 1: Start both processes**

Run from the repo root: `pnpm dev` (starts `@chatmind/server` on 3210 against `~/Documents/chatmind` and Vite on 5173). Expected console lines: `chatmind server on http://localhost:3210  data dir: /Users/<user>/Documents/chatmind` and Vite's `Local: http://localhost:5173/`.

- [ ] **Step 2: Ask the user to verify**

Ask the user to open `http://localhost:5173` and confirm:
1. The sidebar lists `masterarbeit` (5 nodes) and it is selected.
2. Five node cards appear in one column, connected top→bottom, with role badge, title and preview; the layout matches Obsidian's.
3. Pan (drag the background) and zoom (wheel / controls) work; the minimap follows.
4. Clicking a card highlights it and the right panel shows the full message rendered as Markdown (the bold list in message 2).
5. Clicking the background deselects. Resizing the window keeps everything usable.
6. Dark/light follows the system setting.
Ask them to report anything that looks wrong.

- [ ] **Step 3: Record findings and fix**

Write `docs/superpowers/notes/2026-09-12-m2-browser-findings.md`:
```markdown
# M2 browser findings — 2026-09-12

- Browser: <name/version>
- Canvas list + selection: yes/no — <notes>
- Layout matches Obsidian: yes/no
- Pan/zoom/minimap: yes/no
- Click → panel with markdown: yes/no
- Theme follows system: yes/no
- Issues found: none | <list>
- Changes made: none | <describe, with commits>
- Verdict: M2 done condition met | not met (<what>)
```
Fix whatever the user reported (TDD where it is logic; visual tweaks may be untested), rerun `pnpm test && pnpm typecheck`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: record M2 browser verification findings"
```

---

### Task 7: Production path and README

**Files:**
- Modify: root `package.json` (`build` script), `README.md`
- Test: `apps/server/test/app.test.ts` already covers static serving; this task verifies the real `pnpm build && pnpm start`.

- [ ] **Step 1: Add the build script**

Root `package.json` scripts — add `"build": "pnpm --filter @chatmind/web build"`.

- [ ] **Step 2: Verify the single-process mode**

Run: `pnpm build && (pnpm start & sleep 3; curl -s -o /dev/null -w '%{http_code}\n' localhost:3210/; curl -s localhost:3210/api/canvases; kill %1)`
Expected: `200`, then `[{"slug":"masterarbeit","nodeCount":5}]`. Open `http://localhost:3210` yourself in the browser only if the user asks; the curl proves it.

- [ ] **Step 3: README**

Replace the `## CLI` section of `README.md` with:
```markdown
## Run

```bash
pnpm dev             # API on :3210 + Vite on :5173 — open http://localhost:5173
pnpm build && pnpm start   # single process on :3210 serving the built frontend
```

## CLI

```bash
pnpm cli import-transcript apps/cli/fixtures/transcript.json --canvas masterarbeit
pnpm cli check       # exit 0 = clean, 3 = repairs pending
```
```
and change the Status line to `Status: cycle 2 (read-only frontend). No composer yet.`

- [ ] **Step 4: Final verification and commit**

Run: `pnpm test && pnpm typecheck`
Expected: green across core, cli, server, web.

```bash
git add -A
git commit -m "feat: production build/start scripts; README for running the app"
```

---

## Self-review against the spec

- M2 §2 decisions: Hono (T2), two-process dev + one-process prod (T2, T7), Vite/React/React Flow/react-markdown (T3–T5), English UI (T3, T5), REST no cache (T2), DTO + type-only imports (T1, T3), positions 1:1 (T4), system theme (T3 CSS).
- M2 §4 API: list sorted, missing dir → `[]`, 404 shape, static + SPA fallback, API wins over static (T2 tests).
- M2 §5 behaviour: initial selection incl. `?canvas=`, sidebar/graph/panel layout, node card contents and handles, smoothstep edges, repairs banner, read-only flags (T3, T5).
- M2 §6 tests: dto (T1), server routes (T2), flow mapping (T4), NodePanel + App smoke (T3, T5), manual gate (T6).
- Names consistent across tasks: `toCanvasDto/toCanvasSummaryDto/repairsForCanvas`, `createApp`, `fetchCanvases/fetchCanvas`, `toFlowNodes/toFlowEdges/nodeTitle`, `MessageFlowNode`, `GraphView/NodePanel/MessageNode`, `data-testid="canvas-loaded"`.
