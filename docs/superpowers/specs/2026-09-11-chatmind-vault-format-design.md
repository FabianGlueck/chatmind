# chatmind — Architecture and Vault Format Design

Status: approved in brainstorming, 2026-09-11
Scope of this document: overall architecture (all milestones) plus the detailed design for **Cycle 1 = M0 + M1** (vault writer + vault reader). Later cycles get their own spec/plan pair that builds on this one.

---

## 1. What chatmind is

A local-first chat interface for LLMs where conversations are **graphs, not lists**. The user works on an infinite canvas; every message is a node; a reply can target *any* node, which branches the conversation; several nodes can be **merged** by asking the model to synthesise across them.

Storage is a plain folder that is also a valid **Obsidian vault**: one Markdown file per message, one `graph.canvas` (JSON Canvas 1.0) per canvas. The user may open the folder in Obsidian at any time.

Single user, single machine, no accounts.

### 1.1 Decisions taken in brainstorming

| Question | Decision |
|---|---|
| Project name | `chatmind` (package scope `@chatmind/*`) |
| Data folder | App-owned folder, default `~/Documents/chatmind`, overridable via `CHATMIND_DATA_DIR` or `--data-dir`. Created on first run. The user points Obsidian at it once ("Open folder as vault"). No vault picker in the app; the vault is never "the focus" of the UI. |
| Chat providers (v1) | Anthropic **and** OpenAI from the start, via the Vercel AI SDK. Embeddings via OpenAI `text-embedding-3-small`. |
| Foreign vault notes as nodes | Deferred to v2. |
| Cycle 1 scope | M0 + M1 only. |
| Repo layout | pnpm workspaces: `packages/core` (pure logic) + `apps/cli`. |
| Round-trip verification | Canonical serializer + byte-level comparison for our own output; structural comparison for foreign input. |
| Reader repair policy | Repair in memory, return a `Repair[]` report, never write on read. |
| API keys | Never inside the data folder. From M3 on: environment or `~/.config/chatmind/env`. `.app/config.json` in the data folder holds non-secret settings only. |

---

## 2. Non-goals

No multi-user, no auth, no realtime collaboration, no cloud sync, no RAG over external documents in v1, no mobile, no packaging (Electron/Tauri) until explicitly asked. Shipping target: local Node process + browser at `localhost`.

---

## 3. Hard invariants

Breaking one of these means a migration across users' vaults. Non-negotiable unless the user explicitly overrides.

**3.1 Files are the truth; the index is derived.** Everything in SQLite (`.app/index.db`) must be reconstructible from the vault. Embeddings, centroids, semantic edges, token counts, cached summaries-of-summaries live in SQLite and never in the vault.

**3.2 `.canvas` stays spec-pure.** JSON Canvas 1.0 only: position, size, file reference, edges. No custom keys. Anything non-spec goes into Markdown frontmatter or SQLite.

**3.3 Identity is the ULID in frontmatter, never the filename.** Users rename and move files in Obsidian. `id` in frontmatter is authoritative. Filenames are human-readable labels. `.canvas` file paths and wikilinks are derived artifacts, repaired on load by scanning frontmatter ids. Never fail, never lose an edge.

**3.4 Human-readable goes in frontmatter, machine-only goes in SQLite.** The test is "would an Obsidian user get value from seeing this?" — `summary` yes, a 1024-float vector no.

**3.5 Structural graph and semantic graph are separate.** Structural edges (parent/child, merge) are user-created, deterministic, and the *only* thing that determines LLM context. Semantic edges (embedding similarity) live in SQLite only and never silently enter a prompt. Rendered differently (solid vs. dashed).

**3.6 (new) Frontmatter `parents` is the authoritative source of structural edges.** `graph.canvas` edges are a derived artifact, exactly like file paths in 3.3. Loss of the canvas file costs layout, never structure. Edges drawn by the user in Obsidian do not become `parents` in v1 (candidate v2 feature requiring frontmatter write-back). Likewise `canvas:` in frontmatter is derived from the folder the node lives in.

---

## 4. Stack

TypeScript end to end. Node 22+ (`.nvmrc`), pnpm workspaces.

| Layer | Choice |
|---|---|
| Server (M2+) | Hono or Fastify — whichever is less ceremony |
| Frontend (M2+) | Vite + React 19, `@xyflow/react` |
| Index (M5+) | `better-sqlite3` + `sqlite-vec` |
| File watching (M5+) | `chokidar` |
| Frontmatter | `js-yaml` directly (JSON schema, so `created` stays a string and dump output is fully controlled; `gray-matter` would coerce timestamps to `Date`) |
| IDs | `ulid` |
| LLM calls (M3+) | Vercel AI SDK, Anthropic + OpenAI providers |
| Embeddings (M5+) | OpenAI `text-embedding-3-small` behind `embed(texts): Promise<Float32Array[]>` + `{ model, dim }`; store `model` and `dim` with every vector |
| Tests | vitest, fast-check |

Do not start with local inference for embeddings. Swapping in Ollama/`bge-m3` later is one implementation of the same interface.

---

## 5. Repository layout

```
chatmind/
  pnpm-workspace.yaml
  .nvmrc                       # 22
  tsconfig.base.json           # strict, ESM, NodeNext
  packages/core/               # @chatmind/core
    src/
      types.ts                 # MessageNode, CanvasGraph, Layout, Repair
      ids.ts                   # ulid(), slug()
      frontmatter.ts           # parseNodeFile / serializeNodeFile
      canvas.ts                # parseCanvas / serializeCanvas
      vault/paths.ts           # data-dir resolution, canvas folder scan
      vault/read.ts            # readVault(root) → { canvases, repairs }
      vault/write.ts           # writeCanvas(graph, root)
    test/
  apps/cli/                    # @chatmind/cli
    src/import-transcript.ts
    src/check.ts
    fixtures/transcript.json
  docs/superpowers/specs/
  docs/superpowers/plans/
```

`@chatmind/core` depends only on `js-yaml`, `ulid`, and Node built-ins. No HTTP, no React, no SQLite. Later apps (`apps/server`, the index) consume `core`; `core` never imports from them.

---

## 6. Vault layout

```
<data-dir>/                    # ~/Documents/chatmind
  masterarbeit/                # one folder per canvas; folder name = canvas slug
    graph.canvas
    nodes/
      01JQ8F2H7T4WKD9M3XBQNA-ursprungsfrage.md
      01JQ8F3K2M9XZP4V7NBHRC-zentroid-ansatz.md
  python-lernen/
    graph.canvas
    nodes/
  .app/
    index.db                   # fully disposable (M5+)
    config.json                # non-secret settings only
```

A canvas is a top-level topic named by the user at creation. Its slug is the folder name.

---

## 7. Domain model (`packages/core/src/types.ts`)

```ts
type NodeId = string;                               // ULID

interface MessageNode {
  id: NodeId;
  role: 'user' | 'assistant';
  model?: string;                                   // assistant only
  parents: NodeId[];                                // always an array; root = []
  created: string;                                  // ISO-8601 UTC, e.g. 2026-03-14T10:42:03Z
  summary: string;                                  // '' allowed until M5 fills it
  topics: string[];
  body: string;
}

interface Layout { x: number; y: number; width: number; height: number }

interface CanvasGraph {
  slug: string;
  nodes: Map<NodeId, MessageNode>;
  layout: Map<NodeId, Layout>;
  paths: Map<NodeId, string>;                       // current vault-relative path of each node file
  foreign: { nodes: unknown[]; edges: unknown[] };  // canvas content that is not ours, preserved verbatim
}

type Repair =
  | { kind: 'unparseable-node'; path: string; reason: string }
  | { kind: 'defaulted-field'; id: NodeId; field: string }
  | { kind: 'duplicate-id'; id: NodeId; kept: string; dropped: string }
  | { kind: 'canvas-missing'; canvas: string }
  | { kind: 'canvas-corrupt'; canvas: string; reason: string }
  | { kind: 'path-repaired'; id: NodeId; from: string; to: string }
  | { kind: 'canvas-id-repaired'; id: NodeId; canvasNodeId: string }   // canvas node matched by file path, not by ULID
  | { kind: 'orphan-canvas-node'; canvas: string; canvasNodeId: string; file: string }
  | { kind: 'duplicate-canvas-node'; canvas: string; canvasNodeId: string; id: NodeId }   // a second canvas entry resolved to a node that already has one; first wins
  | { kind: 'layout-missing'; id: NodeId }
  | { kind: 'dangling-parent'; id: NodeId; parent: NodeId }
  | { kind: 'edge-mismatch'; canvas: string; detail: string };
```

Edges have no representation of their own: they are derived from `parents` (invariant 3.6). `foreign` holds `text`/`group`/`link` canvas nodes and any edge touching one of them; the writer emits them unchanged so a note the user placed next to a conversation in Obsidian survives.

`parents` is always an array, even with one entry. Merge nodes have several; the first entry is the **primary parent** (used for layout from M4 on).

---

## 8. Canonical file formats

### 8.1 Node file

```markdown
---
id: 01JQ8F3K2M9XZP4V7NBHRC
canvas: masterarbeit
role: assistant
model: claude-sonnet-4-6
parents: [01JQ8F2H7T4WKD9M3XBQNA]
created: 2026-03-14T10:42:03Z
summary: Zentroid-Ansatz skaliert besser als Re-Clustering
topics: []
---

Full message body as Markdown.
```

Rules:
- Key order is fixed: `id, canvas, role, model, parents, created, summary, topics`.
- All keys are always present (`summary: ''`, `topics: []` when empty). Only exception: `model` is omitted for `role: user`.
- Arrays are serialized in flow style (`[a, b]`).
- Exactly one blank line between the closing `---` and the body. Body has trailing whitespace stripped and ends with exactly one `\n`.
- The reader accepts any valid YAML frontmatter (Obsidian may rewrite quoting or array style when the user edits properties). Byte-equality is guaranteed only for chatmind's own output.

### 8.2 Filename

`{ULID}-{slug}.md`. `slug` is derived from `summary`: lowercase, umlauts transliterated (ä→ae, ö→oe, ü→ue, ß→ss), non-alphanumerics collapsed to single `-`, trimmed, max 48 characters. Empty summary → `{ULID}.md`.

The filename is chosen **only when the file is first created**. Afterwards `CanvasGraph.paths` is authoritative; the writer never renames or deletes. (Decided in the M5 spec §6: renamed exactly once, from the bare-ULID name, when a summary exists.)

### 8.3 `graph.canvas`

JSON Canvas 1.0. Canvas node `id` = the message's ULID. Edge `id` = `e-{fromULID}-{toULID}` with full ULIDs. `file` paths are vault-relative (`masterarbeit/nodes/…md`). Sides: `fromSide: "bottom"`, `toSide: "top"`.

Serialization mimics Obsidian's own output (tab indentation, key order `id, type, file, x, y, width, height`; edges `id, fromNode, fromSide, toNode, toSide`) so that an Obsidian re-save produces no diff. Whether this holds is verified manually in M0 (see §12); findings feed back into `serializeCanvas`.

`group` nodes are reserved for topic clusters later; not used in early milestones.

---

## 9. Reader — `readVault(root): Promise<{ canvases: CanvasGraph[]; repairs: Repair[] }>`

A canvas is every direct child folder of `root` that contains `graph.canvas` **or** a `nodes/` folder (canvas file lost → rebuilt from nodes). `.app`, `.obsidian`, and any dot-folder are skipped.

Per canvas, in this order:

1. **Scan nodes** — every `.md` recursively under the canvas folder; parse frontmatter; index by `id`.
   - No frontmatter / no `id` / invalid YAML → `unparseable-node`; file ignored, never touched.
   - Missing fields defaulted (`parents: []`, `topics: []`, `summary: ''`, missing `role` → `'user'`) → `defaulted-field`.
   - `parents` given as scalar → normalised to array, `defaulted-field`.
   - Duplicate `id` → first by sorted path wins, `duplicate-id`.
2. **Parse canvas** — missing → `canvas-missing`; invalid JSON → `canvas-corrupt`; continue with empty layout either way.
   For each `file` node, resolve in this order: (a) canvas node `id` is a known ULID → ours; if its `file` differs from the scanned path, emit `path-repaired`. (b) `file` matches a scanned node path → ours, emit `canvas-id-repaired` (the canvas was written by another tool, e.g. Obsidian dragging the file in). (c) `file` exists on disk but is not one of our nodes → foreign. (d) otherwise `orphan-canvas-node`, entry dropped. Every canvas node that is not a `file` node pointing at one of ours goes to `foreign`, along with every edge that touches a foreign node. A second canvas entry resolving to a node that already has one is dropped with `duplicate-canvas-node` (first entry wins).
3. **Nodes without layout** (on disk, absent from canvas) → placeholder position below the first parent, otherwise at the origin; `layout-missing`. Deliberately naive; M3 replaces this single function with the real layout rule.
4. **`parents` referencing unknown ids** → `dangling-parent`. The reference stays in the model (structure is never deleted); the writer emits no edge for it.
5. **Canvas edges** between our nodes are compared with the edges derived from `parents`; any difference → `edge-mismatch` (report only; frontmatter wins).

The reader never throws except when `root` is missing or unreadable. Everything else is a `Repair`. The reader never writes.

---

## 10. Writer — `writeCanvas(graph: CanvasGraph, root: string): Promise<void>`

- Serializes every node canonically; writes **only if the bytes differ** from what is on disk (no mtime noise for Obsidian or the later chokidar watcher).
- Path = `paths.get(id) ?? nodes/{ULID}-{slug}.md`. Never renames, never deletes.
- Atomic: write to a temp file in the same directory, then `rename`.
- `graph.canvas` = our `file` nodes + edges derived from `parents` (skipping dangling ones) + `foreign` verbatim, in Obsidian formatting. File nodes keep the order of `graph.layout` (= the canvas order as read; Obsidian moves an interacted node to the end of the array as z-order, and re-sorting would rewrite the file after every drag); nodes without a prior canvas entry are appended sorted by id.
- Repairs found by the reader therefore land on disk on the next regular write — and only then.

---

## 11. CLI (`apps/cli`)

```
pnpm cli import-transcript <transcript.json> --canvas <slug> [--data-dir <path>]
pnpm cli check [--data-dir <path>]
```

- `import-transcript`: reads `{ messages: [{ role, content, summary?, model? }] }`, builds a linear chain (each message's `parents` = previous message), lays it out as one column (`width 400`, `height 200`, gap `80`), writes the canvas. Aborts if the canvas folder already exists (M0 is an import, not a merge).
- `check`: runs `readVault` and prints every `Repair` — the manual tool for seeing what the app detected after renames or moves in Obsidian.
- Data dir resolution: `--data-dir` → `CHATMIND_DATA_DIR` → `~/Documents/chatmind`. Created if absent.

---

## 12. Testing

All automated tests live in `packages/core` (vitest).

- **Unit**: `slug()` (umlauts, length cap, empty); frontmatter serializer (key order, quoting of `:`/`#` in summaries, empty arrays, `model` omission); canvas serializer (formatting, edge ids, foreign passthrough).
- **Property** (fast-check) over generated `MessageNode`s: `parse(serialize(n)) ≡ n` and `serialize(parse(serialize(n))) === serialize(n)`.
- **Integration** in temp directories — scenario → expected `Repair[]` + expected graph: file renamed · file moved to a subfolder · `graph.canvas` deleted · frontmatter corrupted · user-added `text` node in canvas · node on disk without canvas entry · merge node with two parents · dangling parent.
- **Round-trip (M1 done condition)**: `write(read(write(fixture)))` yields byte-identical files.
- **Manual (M0 done condition)**: open `~/Documents/chatmind` in Obsidian; the canvas renders, the chain is connected in order, clicking a file node shows the message. Then move a node and move it back, save, and diff `graph.canvas` against ours: whatever Obsidian reformats is fed back into `serializeCanvas`.

No ESLint/Prettier in this cycle; `tsc --strict` + tests. A formatter is added when a frontend exists.

---

## 13. Milestones (build order, unchanged from the briefing)

Each milestone has an explicit done condition. Do not build ahead.

- **M0 — Vault writer CLI.** Done when the output opens in Obsidian and renders correctly (§12 manual).
- **M1 — Vault reader.** Done when M0's output round-trips byte-identically and the repair scenarios pass.
- **M2 — Read-only frontend.** React Flow renders the graph; pan, zoom, click to read. Done when an M0 vault is navigable in the browser.
- **M3 — Composer and branching.** Persistent composer with visible target node; keyboard-first (arrows / Enter / Cmd+Enter / Esc); streaming via AI SDK; no branch button — every reply targets a node. Deterministic child placement, minimal-subtree movement on collision, camera never jumps unless the user sent something. Buffer streamed tokens, write once on completion. Done when a full branching conversation works without the mouse and the vault opens in Obsidian.
- **M4 — Merge.** Multi-select, ghost merge node, composer targets the merge; highlight every node entering the prompt; token budget meter with summary-compression on overflow; one context strategy (labelled blocks); primary-parent layout with secondary curved edges. Done when a two-branch merge produces a coherent synthesis and survives a round-trip + Obsidian.
- **M5 — Index and embeddings (write-only).** SQLite + sqlite-vec; background summary generation + embedding with `content_hash`, `model`, `dim`; chokidar-triggered re-embedding. Done when deleting `index.db` and restarting rebuilds it fully.
- **M6 — Topics within a canvas.** Centroid assignment with LLM tiebreak; structural prior (inherit parent topic unless similarity drops); mean-centering at query time over raw stored vectors; `topics:` written back; user corrections marked and never overwritten.
- **M7 — Semantic cross-links.** Mutual-kNN + threshold over embeddings, excluding structural neighbours; shown on hover/selection or aggregated per topic; computed on the fly below ~10k nodes.

---

## 14. Known traps

- Filename as identity (3.3). Vectors in frontmatter (3.4). Custom keys in `.canvas` (3.2).
- fsync per streamed token — buffer, write on completion.
- Partitioning the sqlite-vec index by canvas — filter with `WHERE`.
- Camera auto-following streaming nodes.
- Reflowing the whole graph on insert — spatial memory is the point.
- HDBSCAN/BERTopic-style re-clustering — topics must not change retroactively.
- Reader that writes — a folder open in Obsidian is not ours alone.
- API keys inside the data folder.
