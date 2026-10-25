# Cycle 1 (M0 + M1): Vault Writer & Reader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `@chatmind/core` library that writes a conversation graph as an Obsidian-compatible vault (Markdown nodes + JSON Canvas) and reads it back losslessly with self-repair, plus a CLI that imports a linear transcript (M0) and reports repairs (M1).

**Architecture:** `packages/core` holds pure logic with no framework dependencies: canonical serializers for node files and `graph.canvas`, a writer that only touches files whose bytes change, and a reader that never throws and never writes but returns a `Repair[]` report. `apps/cli` is a thin wrapper (`import-transcript`, `check`). Frontmatter `parents` is the single source of truth for structure; canvas edges and file paths are derived and repaired on load.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript (strict, `moduleResolution: Bundler`, run via `tsx`), vitest, fast-check, `js-yaml`, `ulid`.

**Spec:** `docs/superpowers/specs/2026-09-11-chatmind-vault-format-design.md` — read §3 (invariants), §7–§10 (model, formats, reader, writer) before starting any task.

## Global Constraints

- Node `>=22` (`.nvmrc` = `22`); pnpm workspaces; every package `"type": "module"`.
- `@chatmind/core` may depend only on `js-yaml`, `ulid` and Node built-ins. No HTTP, React, SQLite.
- `.canvas` files are JSON Canvas 1.0 only — no custom keys (spec §3.2).
- Identity is the ULID in frontmatter, never the filename (spec §3.3). The writer never renames or deletes files.
- Frontmatter `parents` is authoritative for edges; canvas edges are derived (spec §3.6).
- The reader never throws except when `root` is missing/unreadable, and never writes (spec §9).
- Canonical node file format exactly as spec §8.1; filename rules §8.2; canvas format §8.3.
- Data dir resolution: `--data-dir` → `CHATMIND_DATA_DIR` → `~/Documents/chatmind` (spec §11).
- No API keys anywhere in this cycle. No ESLint/Prettier in this cycle.
- TDD: every task writes the failing test first. Commit after every task with the attribution trailer from the session.

## File Map

| Path | Responsibility |
|---|---|
| `pnpm-workspace.yaml`, `package.json`, `.nvmrc`, `tsconfig.base.json` | Workspace, shared TS config, root scripts (`test`, `typecheck`, `cli`) |
| `packages/core/src/types.ts` | `MessageNode`, `Layout`, `CanvasGraph`, `ForeignCanvasContent`, `Repair` |
| `packages/core/src/ids.ts` | `newId`, `isUlid`, `isoTimestamp`, `slug`, `nodeFileName` |
| `packages/core/src/frontmatter.ts` | `serializeNodeFile`, `parseNodeFile`, `normalizeBody`, `normalizeSummary` |
| `packages/core/src/canvas.ts` | `serializeCanvas`, `parseCanvas`, `edgeId`, `derivedEdges` |
| `packages/core/src/layout.ts` | Size constants, `placeholderLayout`, `columnLayout` |
| `packages/core/src/chain.ts` | `linearGraph` — transcript messages → `CanvasGraph` |
| `packages/core/src/vault/paths.ts` | `resolveDataDir`, `listCanvasFolders`, `walkMarkdownFiles`, `toVaultPath`, `exists` |
| `packages/core/src/vault/write.ts` | `writeCanvas`, `writeIfChanged`, `sortedNodes` |
| `packages/core/src/vault/read.ts` | `readVault` + repair logic |
| `packages/core/src/index.ts` | Public exports |
| `packages/core/test/helpers.ts` | Fixed ULIDs, `tmpDir`, `readTree`, `node`, `sampleGraph` |
| `packages/core/test/*.test.ts` | One test file per source module + `roundtrip.test.ts` |
| `apps/cli/src/index.ts` | Arg parsing, command dispatch |
| `apps/cli/src/transcript.ts` | `parseTranscript` validation |
| `apps/cli/src/import-transcript.ts`, `apps/cli/src/check.ts` | The two commands |
| `apps/cli/fixtures/transcript.json` | M0 fixture |
| `docs/superpowers/notes/2026-09-11-m0-obsidian-findings.md` | Result of the manual Obsidian gate |

---

### Task 1: Workspace scaffold

**Files:**
- Create: `pnpm-workspace.yaml`, `.nvmrc`, `tsconfig.base.json`, `package.json` (root)
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: root scripts `pnpm test`, `pnpm typecheck`, `pnpm cli`; `@chatmind/core` package whose `main`/`types` point at `./src/index.ts`.

- [ ] **Step 1: Write workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
```

`.nvmrc`:
```
22
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

Root `package.json`:
```json
{
  "name": "chatmind",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck",
    "cli": "pnpm --filter @chatmind/cli run start"
  }
}
```

Append to `.gitignore`:
```
dist/
*.tsbuildinfo
```

- [ ] **Step 2: Write the core package**

`packages/core/package.json`:
```json
{
  "name": "@chatmind/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/core/src/index.ts`:
```ts
export const VERSION = '0.0.0';
```

- [ ] **Step 3: Write the smoke test**

`packages/core/test/smoke.test.ts`:
```ts
import { expect, it } from 'vitest';
import { VERSION } from '../src/index';

it('exports a version', () => {
  expect(VERSION).toBe('0.0.0');
});
```

- [ ] **Step 4: Install dependencies**

Run from repo root (dev tooling lives at the workspace root; runtime deps in `core`):
```bash
pnpm add -Dw typescript @types/node @types/js-yaml vitest fast-check tsx
pnpm --filter @chatmind/core add js-yaml ulid
```
Expected: `pnpm-lock.yaml` created, `node_modules/` at root and in `packages/core`.

- [ ] **Step 5: Run test and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 1 test passes in `@chatmind/core`; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace with @chatmind/core"
```

---

### Task 2: IDs, timestamps, slugs

**Files:**
- Create: `packages/core/src/ids.ts`
- Test: `packages/core/test/ids.test.ts`

**Interfaces:**
- Produces:
  - `newId(now?: number): string` — monotonic ULID
  - `isUlid(v: unknown): v is string`
  - `isoTimestamp(ms: number): string` — `YYYY-MM-DDTHH:MM:SSZ` (no milliseconds)
  - `slug(text: string): string`, `SLUG_MAX = 48`
  - `nodeFileName(id: string, summary: string): string` — `{id}-{slug}.md` or `{id}.md`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/ids.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SLUG_MAX, isUlid, isoTimestamp, newId, nodeFileName, slug } from '../src/ids';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';

describe('slug', () => {
  it('lowercases and dashes words', () => {
    expect(slug('Zentroid-Ansatz skaliert besser')).toBe('zentroid-ansatz-skaliert-besser');
  });
  it('transliterates German umlauts and sharp s', () => {
    expect(slug('Über Größe & Maß')).toBe('ueber-groesse-mass');
  });
  it('strips other diacritics', () => {
    expect(slug('Café résumé')).toBe('cafe-resume');
  });
  it('collapses punctuation and trims dashes', () => {
    expect(slug('  Hallo: Welt!! ')).toBe('hallo-welt');
  });
  it('returns empty for empty or symbol-only input', () => {
    expect(slug('')).toBe('');
    expect(slug('???')).toBe('');
  });
  it('caps at SLUG_MAX on a word boundary', () => {
    const s = slug('one two three four five six seven eight nine ten eleven twelve');
    expect(s.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(s.endsWith('-')).toBe(false);
    expect(s).toBe('one-two-three-four-five-six-seven-eight-nine-ten');
  });
  it('never cuts inside a word', () => {
    expect(slug('a'.repeat(40) + ' ' + 'b'.repeat(20))).toBe('a'.repeat(40));
  });
});

describe('newId / isUlid', () => {
  it('produces valid, monotonically increasing ULIDs', () => {
    const a = newId(1_000);
    const b = newId(1_000);
    const c = newId(2_000);
    expect(isUlid(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });
  it('rejects non-ULIDs', () => {
    expect(isUlid('nope')).toBe(false);
    expect(isUlid(A.toLowerCase())).toBe(false);
    expect(isUlid(42)).toBe(false);
  });
});

describe('isoTimestamp', () => {
  it('formats UTC without milliseconds', () => {
    expect(isoTimestamp(Date.UTC(2026, 2, 14, 10, 42, 3, 123))).toBe('2026-03-14T10:42:03Z');
  });
});

describe('nodeFileName', () => {
  it('joins id and slug', () => {
    expect(nodeFileName(A, 'Zentroid Ansatz')).toBe(`${A}-zentroid-ansatz.md`);
  });
  it('uses the bare id for an empty summary', () => {
    expect(nodeFileName(A, '')).toBe(`${A}.md`);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core test`
Expected: FAIL — cannot resolve `../src/ids`.

- [ ] **Step 3: Implement**

`packages/core/src/ids.ts`:
```ts
import { monotonicFactory } from 'ulid';

const nextUlid = monotonicFactory();

/** Time-sortable ULID; monotonic within the process so same-millisecond ids still sort by creation. */
export function newId(now: number = Date.now()): string {
  return nextUlid(now);
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(v: unknown): v is string {
  return typeof v === 'string' && ULID_RE.test(v);
}

/** ISO-8601 UTC without milliseconds, e.g. 2026-03-14T10:42:03Z */
export function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const SLUG_MAX = 48;

const TRANSLIT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

export function slug(text: string): string {
  const dashed = text
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => TRANSLIT[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (dashed.length <= SLUG_MAX) return dashed;
  const cut = dashed.slice(0, SLUG_MAX);
  if (dashed[SLUG_MAX] === '-') return cut;
  const lastDash = cut.lastIndexOf('-');
  return lastDash > 0 ? cut.slice(0, lastDash) : cut;
}

export function nodeFileName(id: string, summary: string): string {
  const s = slug(summary);
  return s === '' ? `${id}.md` : `${id}-${s}.md`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chatmind/core test`
Expected: all `ids` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ids.ts packages/core/test/ids.test.ts
git commit -m "feat(core): ULID ids, timestamps and filename slugs"
```

---

### Task 3: Types and canonical node-file serializer/parser

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/frontmatter.ts`
- Test: `packages/core/test/frontmatter.test.ts`

**Interfaces:**
- Produces (types.ts): `NodeId`, `Role`, `MessageNode`, `Layout`, `ForeignCanvasContent`, `CanvasGraph`, `Repair` exactly as below.
- Produces (frontmatter.ts):
  - `serializeNodeFile(node: MessageNode, canvasSlug: string): string`
  - `parseNodeFile(text: string): ParseResult` where `ParseResult = { ok: true; node: MessageNode; canvas: string | undefined; defaulted: string[] } | { ok: false; reason: string }`
  - `normalizeBody(body: string): string`, `normalizeSummary(s: string): string`

- [ ] **Step 1: Write types**

`packages/core/src/types.ts`:
```ts
export type NodeId = string; // ULID
export type Role = 'user' | 'assistant';

export interface MessageNode {
  id: NodeId;
  role: Role;
  model?: string; // assistant only
  parents: NodeId[]; // always an array; root = []; first entry is the primary parent
  created: string; // ISO-8601 UTC without milliseconds
  summary: string; // '' until M5 fills it
  topics: string[];
  body: string;
}

export interface Layout {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Canvas content that is not ours (text/group/link nodes and edges touching them), preserved verbatim. */
export interface ForeignCanvasContent {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

export interface CanvasGraph {
  slug: string; // folder name
  nodes: Map<NodeId, MessageNode>;
  layout: Map<NodeId, Layout>;
  paths: Map<NodeId, string>; // current vault-relative posix path of each node file
  foreign: ForeignCanvasContent;
}

export type Repair =
  | { kind: 'unparseable-node'; path: string; reason: string }
  | { kind: 'defaulted-field'; id: NodeId; field: string }
  | { kind: 'duplicate-id'; id: NodeId; kept: string; dropped: string }
  | { kind: 'canvas-missing'; canvas: string }
  | { kind: 'canvas-corrupt'; canvas: string; reason: string }
  | { kind: 'path-repaired'; id: NodeId; from: string; to: string }
  | { kind: 'canvas-id-repaired'; id: NodeId; canvasNodeId: string }
  | { kind: 'orphan-canvas-node'; canvas: string; canvasNodeId: string; file: string }
  | { kind: 'layout-missing'; id: NodeId }
  | { kind: 'dangling-parent'; id: NodeId; parent: NodeId }
  | { kind: 'edge-mismatch'; canvas: string; detail: string };
```

- [ ] **Step 2: Write the failing tests**

`packages/core/test/frontmatter.test.ts`:
```ts
import fc from 'fast-check';
import { decodeTime } from 'ulid';
import { describe, expect, it } from 'vitest';
import { normalizeBody, normalizeSummary, parseNodeFile, serializeNodeFile } from '../src/frontmatter';
import { isoTimestamp } from '../src/ids';
import type { MessageNode } from '../src/types';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';

function node(over: Partial<MessageNode> & { id: string }): MessageNode {
  return { role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Body.', ...over };
}

describe('serializeNodeFile', () => {
  it('writes canonical key order with flow arrays and one blank line before the body', () => {
    const text = serializeNodeFile(
      node({ id: B, role: 'assistant', model: 'claude-sonnet-4-6', parents: [A], summary: 'Zentroid-Ansatz skaliert besser', body: 'Full body.' }),
      'masterarbeit',
    );
    expect(text).toBe(
      `---
id: ${B}
canvas: masterarbeit
role: assistant
model: claude-sonnet-4-6
parents: [${A}]
created: 2026-03-14T10:42:03Z
summary: Zentroid-Ansatz skaliert besser
topics: []
---

Full body.
`,
    );
  });

  it('omits model for user role even if set', () => {
    expect(serializeNodeFile(node({ id: A, model: 'x' }), 'c')).not.toContain('model:');
  });

  it('writes an empty summary as an empty single-quoted string', () => {
    expect(serializeNodeFile(node({ id: A }), 'c')).toContain("summary: ''\n");
  });

  it('quotes summaries YAML would otherwise misread', () => {
    expect(serializeNodeFile(node({ id: A, summary: 'Zwei Optionen: A oder B' }), 'c')).toContain("summary: 'Zwei Optionen: A oder B'\n");
    expect(serializeNodeFile(node({ id: A, summary: 'true' }), 'c')).toContain("summary: 'true'\n");
  });

  it('keeps umlauts unescaped', () => {
    expect(serializeNodeFile(node({ id: A, summary: 'Größe zählt' }), 'c')).toContain('summary: Größe zählt\n');
  });

  it('collapses summary whitespace onto one line', () => {
    expect(serializeNodeFile(node({ id: A, summary: '  a  b\nc ' }), 'c')).toContain('summary: a b c\n');
  });

  it('strips leading blank lines and trailing whitespace from the body', () => {
    expect(serializeNodeFile(node({ id: A, body: '\n\n  # Title\n\ntext   \n\n' }), 'c')).toMatch(/---\n\n {2}# Title\n\ntext\n$/);
  });

  it('writes no body section for an empty body', () => {
    const text = serializeNodeFile(node({ id: A, body: '   \n' }), 'c');
    expect(text.endsWith('topics: []\n---\n')).toBe(true);
  });

  it('writes multiple parents and topics in flow style', () => {
    const text = serializeNodeFile(node({ id: A, parents: [A, B], topics: ['eval', 'metrik'] }), 'c');
    expect(text).toContain(`parents: [${A}, ${B}]\n`);
    expect(text).toContain('topics: [eval, metrik]\n');
  });
});

describe('parseNodeFile', () => {
  it('parses canonical output back to the same node', () => {
    const n = node({ id: B, role: 'assistant', model: 'm', parents: [A], summary: 'S', topics: ['t'], body: 'Line 1\n\nLine 2' });
    const r = parseNodeFile(serializeNodeFile(n, 'masterarbeit'));
    expect(r).toEqual({ ok: true, node: n, canvas: 'masterarbeit', defaulted: [] });
  });

  it('accepts CRLF, block-style arrays and a BOM', () => {
    const text = `\uFEFF---\r\nid: ${A}\r\ncanvas: c\r\nrole: user\r\nparents:\r\n  - ${B}\r\ncreated: 2026-01-01T00:00:00Z\r\nsummary: s\r\ntopics:\r\n  - t\r\n---\r\n\r\nBody\r\n`;
    const r = parseNodeFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.node.parents).toEqual([B]);
    expect(r.node.topics).toEqual(['t']);
    expect(r.node.body).toBe('Body');
    expect(r.defaulted).toEqual([]);
  });

  it('keeps a quoted created value as a string', () => {
    const r = parseNodeFile(`---\nid: ${A}\nrole: user\nparents: []\ncreated: "2026-01-01T00:00:00Z"\nsummary: ''\ntopics: []\n---\n`);
    expect(r.ok && r.node.created).toBe('2026-01-01T00:00:00Z');
  });

  it('defaults missing fields and reports them', () => {
    const r = parseNodeFile(`---\nid: ${A}\n---\nHi\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.node).toEqual({ id: A, role: 'user', parents: [], created: isoTimestamp(decodeTime(A)), summary: '', topics: [], body: 'Hi' });
    expect(r.defaulted.sort()).toEqual(['created', 'parents', 'role', 'summary', 'topics']);
    expect(r.canvas).toBeUndefined();
  });

  it('normalises a scalar parents value to an array', () => {
    const r = parseNodeFile(`---\nid: ${A}\nrole: user\nparents: ${B}\ncreated: x\nsummary: s\ntopics: []\n---\n`);
    expect(r.ok && r.node.parents).toEqual([B]);
    expect(r.ok && r.defaulted).toEqual(['parents']);
  });

  it('fails without frontmatter', () => {
    expect(parseNodeFile('# Just a note\n')).toEqual({ ok: false, reason: 'no frontmatter block' });
  });

  it('fails on invalid YAML', () => {
    const r = parseNodeFile('---\nid: [unclosed\n---\n');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^invalid YAML/);
  });

  it('fails on a missing or invalid id', () => {
    expect(parseNodeFile('---\nrole: user\n---\n')).toEqual({ ok: false, reason: 'missing or invalid id' });
    expect(parseNodeFile('---\nid: nope\n---\n')).toEqual({ ok: false, reason: 'missing or invalid id' });
  });

  it('fails when frontmatter is not a mapping', () => {
    expect(parseNodeFile('---\n- a\n- b\n---\n')).toEqual({ ok: false, reason: 'frontmatter is not a mapping' });
  });
});

describe('normalizers', () => {
  it('normalizeBody', () => {
    expect(normalizeBody('\n \n x \n\n')).toBe(' x');
    expect(normalizeBody('')).toBe('');
  });
  it('normalizeSummary', () => {
    expect(normalizeSummary(' a \n b ')).toBe('a b');
  });
});

// --- property tests -------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulidArb = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 26, maxLength: 26 }).map((cs) => cs.join(''));
const createdArb = fc.integer({ min: 0, max: 4_102_444_800_000 }).map(isoTimestamp);
const roleModelArb = fc.oneof(
  fc.record({ role: fc.constant<'user'>('user') }),
  fc.record({ role: fc.constant<'assistant'>('assistant'), model: fc.string({ minLength: 1 }) }),
);
const nodeArb: fc.Arbitrary<MessageNode> = fc
  .record({
    id: ulidArb,
    parents: fc.array(ulidArb, { maxLength: 3 }),
    created: createdArb,
    summary: fc.string(),
    topics: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
    body: fc.array(fc.string(), { maxLength: 5 }).map((lines) => lines.join('\n')),
  })
  .chain((base) => roleModelArb.map((rm) => ({ ...base, ...rm })));

function canonical(n: MessageNode): MessageNode {
  return { ...n, summary: normalizeSummary(n.summary), body: normalizeBody(n.body) };
}

describe('round-trip properties', () => {
  it('parse(serialize(n)) equals the canonical form of n', () => {
    fc.assert(
      fc.property(nodeArb, (n) => {
        const r = parseNodeFile(serializeNodeFile(n, 'c'));
        expect(r).toEqual({ ok: true, node: canonical(n), canvas: 'c', defaulted: [] });
      }),
    );
  });

  it('serialize is idempotent under parse', () => {
    fc.assert(
      fc.property(nodeArb, (n) => {
        const once = serializeNodeFile(n, 'c');
        const r = parseNodeFile(once);
        if (!r.ok) throw new Error(r.reason);
        expect(serializeNodeFile(r.node, 'c')).toBe(once);
      }),
    );
  });
});
```

Note: when `created` is absent it is derived from the ULID's embedded timestamp (`decodeTime` from `ulid`), which is why the test computes the expectation rather than hard-coding a date.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @chatmind/core test`
Expected: FAIL — cannot resolve `../src/frontmatter`.

- [ ] **Step 4: Implement**

`packages/core/src/frontmatter.ts`:
```ts
import yaml from 'js-yaml';
import { decodeTime } from 'ulid';
import { isUlid, isoTimestamp } from './ids';
import type { MessageNode, NodeId, Role } from './types';

export type ParseResult =
  | { ok: true; node: MessageNode; canvas: string | undefined; defaulted: string[] }
  | { ok: false; reason: string };

/** Strip leading blank lines and trailing whitespace; the body never carries either. */
export function normalizeBody(body: string): string {
  return body.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

/** A summary is one line: collapse all whitespace runs to a single space. */
export function normalizeSummary(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const DUMP_OPTIONS: yaml.DumpOptions = {
  schema: yaml.JSON_SCHEMA,
  flowLevel: 1, // top-level mapping in block style, arrays inside it in flow style
  lineWidth: -1, // never fold long strings
  noRefs: true,
};

export function serializeNodeFile(node: MessageNode, canvasSlug: string): string {
  // Insertion order is the canonical key order (spec §8.1).
  const data: Record<string, unknown> = { id: node.id, canvas: canvasSlug, role: node.role };
  if (node.role === 'assistant' && node.model !== undefined) data.model = node.model;
  data.parents = node.parents;
  data.created = node.created;
  data.summary = normalizeSummary(node.summary);
  data.topics = node.topics;

  const body = normalizeBody(node.body);
  const header = `---\n${yaml.dump(data, DUMP_OPTIONS)}---\n`;
  return body === '' ? header : `${header}\n${body}\n`;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

export function parseNodeFile(rawText: string): ParseResult {
  const text = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { ok: false, reason: 'no frontmatter block' };

  let data: unknown;
  try {
    data = yaml.load(match[1] ?? '', { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    return { ok: false, reason: `invalid YAML: ${(err as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'frontmatter is not a mapping' };
  }
  const fm = data as Record<string, unknown>;
  if (!isUlid(fm.id)) return { ok: false, reason: 'missing or invalid id' };
  const id = fm.id;
  const defaulted: string[] = [];

  let role: Role = 'user';
  if (fm.role === 'user' || fm.role === 'assistant') role = fm.role;
  else defaulted.push('role');

  let parents: NodeId[];
  if (Array.isArray(fm.parents)) parents = fm.parents.map(String);
  else {
    parents = fm.parents == null ? [] : [String(fm.parents)];
    defaulted.push('parents');
  }

  let created: string;
  if (typeof fm.created === 'string') created = fm.created;
  else {
    created = isoTimestamp(decodeTime(id));
    defaulted.push('created');
  }

  let summary: string;
  if (typeof fm.summary === 'string') summary = fm.summary;
  else if (fm.summary == null) {
    summary = '';
    defaulted.push('summary');
  } else summary = String(fm.summary);

  let topics: string[];
  if (Array.isArray(fm.topics)) topics = fm.topics.map(String);
  else {
    topics = [];
    defaulted.push('topics');
  }

  const node: MessageNode = { id, role, parents, created, summary, topics, body: normalizeBody(text.slice(match[0].length)) };
  if (typeof fm.model === 'string') node.model = fm.model;
  const canvas = typeof fm.canvas === 'string' ? fm.canvas : undefined;
  return { ok: true, node, canvas, defaulted };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @chatmind/core test`
Expected: all `frontmatter` tests PASS, including both property tests (100 runs each by default). If the property test finds a counterexample, fix the serializer/parser — do not weaken the arbitrary. Known candidates: a summary consisting only of whitespace (must serialize as `''`), a `model` string js-yaml quotes (fine — parsing restores it).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: exit 0.

```bash
git add packages/core/src/types.ts packages/core/src/frontmatter.ts packages/core/test/frontmatter.test.ts
git commit -m "feat(core): domain types and canonical node-file serializer/parser"
```

---

### Task 4: JSON Canvas serializer/parser

**Files:**
- Create: `packages/core/src/canvas.ts`
- Test: `packages/core/test/canvas.test.ts`

**Interfaces:**
- Consumes: `CanvasGraph`, `ForeignCanvasContent`, `NodeId` from `types.ts`.
- Produces:
  - `interface CanvasFileNode { id: string; file: string; x: number; y: number; width: number; height: number }`
  - `interface CanvasEdge { id: string; fromNode: string; toNode: string }`
  - `interface CanvasContent { fileNodes: CanvasFileNode[]; edges: CanvasEdge[]; foreign: ForeignCanvasContent }`
  - `type RawCanvas = { ok: true; nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } | { ok: false; reason: string }`
  - `edgeId(from: NodeId, to: NodeId): string` → `e-{from}-{to}`
  - `derivedEdges(graph: CanvasGraph): CanvasEdge[]` — from `parents`, skipping parents not in `graph.nodes`, sorted by id
  - `serializeCanvas(content: CanvasContent): string`
  - `parseCanvas(text: string): RawCanvas`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/canvas.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { derivedEdges, edgeId, parseCanvas, serializeCanvas } from '../src/canvas';
import type { CanvasGraph, MessageNode } from '../src/types';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';
const C = '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA';
const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';

function node(over: Partial<MessageNode> & { id: string }): MessageNode {
  return { role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Body.', ...over };
}

function graph(nodes: MessageNode[]): CanvasGraph {
  return { slug: 'm', nodes: new Map(nodes.map((n) => [n.id, n])), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
}

const twoNodes = {
  fileNodes: [
    { id: A, file: 'm/nodes/a.md', x: 0, y: 0, width: 400, height: 200 },
    { id: B, file: 'm/nodes/b.md', x: 0, y: 280, width: 400, height: 200 },
  ],
  edges: [{ id: edgeId(A, B), fromNode: A, toNode: B }],
  foreign: { nodes: [], edges: [] },
};

describe('serializeCanvas', () => {
  it('writes Obsidian-style tab-indented JSON with one object per line', () => {
    expect(serializeCanvas(twoNodes)).toBe(
      `{
\t"nodes":[
\t\t{"id":"${A}","type":"file","file":"m/nodes/a.md","x":0,"y":0,"width":400,"height":200},
\t\t{"id":"${B}","type":"file","file":"m/nodes/b.md","x":0,"y":280,"width":400,"height":200}
\t],
\t"edges":[
\t\t{"id":"e-${A}-${B}","fromNode":"${A}","fromSide":"bottom","toNode":"${B}","toSide":"top"}
\t]
}`,
    );
  });

  it('writes empty arrays compactly', () => {
    expect(serializeCanvas({ fileNodes: [], edges: [], foreign: { nodes: [], edges: [] } })).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}');
  });

  it('appends foreign nodes and edges verbatim after ours', () => {
    const text = serializeCanvas({
      ...twoNodes,
      foreign: {
        nodes: [{ id: 'abc123', type: 'text', text: 'note', x: 1, y: 2, width: 3, height: 4, color: '2' }],
        edges: [{ id: 'xyz', fromNode: 'abc123', toNode: A, label: 'see' }],
      },
    });
    const lines = text.split('\n');
    expect(lines[4]).toBe('\t\t{"id":"abc123","type":"text","text":"note","x":1,"y":2,"width":3,"height":4,"color":"2"}');
    expect(lines[8]).toBe('\t\t{"id":"xyz","fromNode":"abc123","toNode":"' + A + '","label":"see"}');
  });

  it('is valid JSON', () => {
    expect(() => JSON.parse(serializeCanvas(twoNodes))).not.toThrow();
  });
});

describe('parseCanvas', () => {
  it('returns nodes and edges of a valid canvas', () => {
    const r = parseCanvas(serializeCanvas(twoNodes));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]).toEqual({ id: A, type: 'file', file: 'm/nodes/a.md', x: 0, y: 0, width: 400, height: 200 });
    expect(r.edges).toEqual([{ id: edgeId(A, B), fromNode: A, fromSide: 'bottom', toNode: B, toSide: 'top' }]);
  });

  it('treats missing arrays as empty and drops non-object entries', () => {
    expect(parseCanvas('{}')).toEqual({ ok: true, nodes: [], edges: [] });
    expect(parseCanvas('{"nodes":[1,"x",null,{"id":"a"}]}')).toEqual({ ok: true, nodes: [{ id: 'a' }], edges: [] });
  });

  it('rejects invalid JSON and non-object roots', () => {
    const bad = parseCanvas('{nope');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toMatch(/^invalid JSON/);
    expect(parseCanvas('[]')).toEqual({ ok: false, reason: 'top level is not an object' });
    expect(parseCanvas('null')).toEqual({ ok: false, reason: 'top level is not an object' });
  });
});

describe('derivedEdges', () => {
  it('derives one edge per known parent, sorted by id, skipping dangling parents', () => {
    const g = graph([
      node({ id: A }),
      node({ id: B, parents: [A] }),
      node({ id: C, parents: [A] }),
      node({ id: D, parents: [C, B, '01JQ8F9ZZZZZZZZZZZZZZZZZZZ'] }),
    ]);
    expect(derivedEdges(g)).toEqual([
      { id: edgeId(A, B), fromNode: A, toNode: B },
      { id: edgeId(A, C), fromNode: A, toNode: C },
      { id: edgeId(B, D), fromNode: B, toNode: D },
      { id: edgeId(C, D), fromNode: C, toNode: D },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core test`
Expected: FAIL — cannot resolve `../src/canvas`.

- [ ] **Step 3: Implement**

`packages/core/src/canvas.ts`:
```ts
import type { CanvasGraph, ForeignCanvasContent, NodeId } from './types';

export interface CanvasFileNode {
  id: string;
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
}

export interface CanvasContent {
  fileNodes: CanvasFileNode[];
  edges: CanvasEdge[];
  foreign: ForeignCanvasContent;
}

export type RawCanvas =
  | { ok: true; nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  | { ok: false; reason: string };

export function edgeId(from: NodeId, to: NodeId): string {
  return `e-${from}-${to}`;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Structural edges come from frontmatter `parents` only (spec §3.6). Dangling parents produce no edge. */
export function derivedEdges(graph: CanvasGraph): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  for (const node of graph.nodes.values()) {
    for (const parent of node.parents) {
      if (graph.nodes.has(parent)) edges.push({ id: edgeId(parent, node.id), fromNode: parent, toNode: node.id });
    }
  }
  return edges.sort(byId);
}

/**
 * Mimics Obsidian's own canvas formatting: tab-indented arrays, one compact object per line,
 * so that an Obsidian re-save produces no diff. Key order is verified manually in the M0 gate.
 */
export function serializeCanvas(content: CanvasContent): string {
  const nodeLines = [
    ...content.fileNodes.map((n) => JSON.stringify({ id: n.id, type: 'file', file: n.file, x: n.x, y: n.y, width: n.width, height: n.height })),
    ...content.foreign.nodes.map((n) => JSON.stringify(n)),
  ];
  const edgeLines = [
    ...content.edges.map((e) => JSON.stringify({ id: e.id, fromNode: e.fromNode, fromSide: 'bottom', toNode: e.toNode, toSide: 'top' })),
    ...content.foreign.edges.map((e) => JSON.stringify(e)),
  ];
  return `{\n\t"nodes":${block(nodeLines)},\n\t"edges":${block(edgeLines)}\n}`;
}

function block(lines: string[]): string {
  return lines.length === 0 ? '[]' : `[\n${lines.map((l) => `\t\t${l}`).join(',\n')}\n\t]`;
}

export function parseCanvas(text: string): RawCanvas {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'top level is not an object' };
  }
  const { nodes, edges } = data as Record<string, unknown>;
  return { ok: true, nodes: records(nodes), edges: records(edges) };
}

function records(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chatmind/core test`
Expected: all `canvas` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/canvas.ts packages/core/test/canvas.test.ts
git commit -m "feat(core): JSON Canvas serializer/parser with foreign passthrough"
```

---

### Task 5: Layout constants and transcript chain builder

**Files:**
- Create: `packages/core/src/layout.ts`, `packages/core/src/chain.ts`
- Test: `packages/core/test/layout.test.ts`, `packages/core/test/chain.test.ts`

**Interfaces:**
- Consumes: `newId`, `isoTimestamp` (Task 2); `MessageNode`, `Layout`, `CanvasGraph`, `NodeId`, `Role` (Task 3).
- Produces (layout.ts): `NODE_WIDTH = 400`, `NODE_HEIGHT = 200`, `NODE_GAP = 80`, `placeholderLayout(node: MessageNode, layout: ReadonlyMap<NodeId, Layout>): Layout`, `columnLayout(ids: NodeId[]): Map<NodeId, Layout>`
- Produces (chain.ts): `interface TranscriptMessage { role: Role; content: string; summary?: string; model?: string }`, `linearGraph(slug: string, messages: TranscriptMessage[], now?: () => number): CanvasGraph`

- [ ] **Step 1: Write the failing tests**

`packages/core/test/layout.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { NODE_GAP, NODE_HEIGHT, NODE_WIDTH, columnLayout, placeholderLayout } from '../src/layout';
import type { MessageNode } from '../src/types';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';

function node(over: Partial<MessageNode> & { id: string }): MessageNode {
  return { role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: '', ...over };
}

describe('columnLayout', () => {
  it('stacks nodes in one column with a gap', () => {
    expect(columnLayout([A, B])).toEqual(
      new Map([
        [A, { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT }],
        [B, { x: 0, y: NODE_HEIGHT + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT }],
      ]),
    );
  });
});

describe('placeholderLayout', () => {
  it('places a node below its first parent', () => {
    const layout = new Map([[A, { x: 100, y: 50, width: 400, height: 300 }]]);
    expect(placeholderLayout(node({ id: B, parents: [A] }), layout)).toEqual({ x: 100, y: 50 + 300 + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  it('falls back to the origin without a laid-out parent', () => {
    expect(placeholderLayout(node({ id: B, parents: [A] }), new Map())).toEqual({ x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT });
    expect(placeholderLayout(node({ id: A }), new Map())).toEqual({ x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT });
  });
});
```

`packages/core/test/chain.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { linearGraph } from '../src/chain';
import { isUlid } from '../src/ids';
import { NODE_GAP, NODE_HEIGHT } from '../src/layout';

describe('linearGraph', () => {
  const messages = [
    { role: 'user' as const, content: 'Frage', summary: 'Ursprungsfrage' },
    { role: 'assistant' as const, content: 'Antwort', model: 'claude-sonnet-4-6' },
    { role: 'user' as const, content: 'Danke' },
  ];

  it('chains messages by parents in order with increasing ids', () => {
    let t = Date.UTC(2026, 8, 11, 12, 0, 0);
    const g = linearGraph('masterarbeit', messages, () => (t += 1000));
    const ids = [...g.nodes.keys()];
    expect(ids).toHaveLength(3);
    expect(ids.every(isUlid)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    const [a, b, c] = ids as [string, string, string];
    expect(g.nodes.get(a)).toEqual({ id: a, role: 'user', parents: [], created: '2026-09-11T12:00:01Z', summary: 'Ursprungsfrage', topics: [], body: 'Frage' });
    expect(g.nodes.get(b)).toEqual({ id: b, role: 'assistant', model: 'claude-sonnet-4-6', parents: [a], created: '2026-09-11T12:00:02Z', summary: '', topics: [], body: 'Antwort' });
    expect(g.nodes.get(c)?.parents).toEqual([b]);
  });

  it('lays nodes out in a column and leaves paths empty', () => {
    const g = linearGraph('m', messages);
    const ids = [...g.nodes.keys()];
    expect(g.layout.get(ids[2]!)?.y).toBe(2 * (NODE_HEIGHT + NODE_GAP));
    expect(g.paths.size).toBe(0);
    expect(g.slug).toBe('m');
    expect(g.foreign).toEqual({ nodes: [], edges: [] });
  });

  it('ignores model on user messages', () => {
    const g = linearGraph('m', [{ role: 'user', content: 'x', model: 'gpt' }]);
    expect([...g.nodes.values()][0]?.model).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core test`
Expected: FAIL — cannot resolve `../src/layout` / `../src/chain`.

- [ ] **Step 3: Implement**

`packages/core/src/layout.ts`:
```ts
import type { Layout, MessageNode, NodeId } from './types';

export const NODE_WIDTH = 400;
export const NODE_HEIGHT = 200;
export const NODE_GAP = 80;

/** Deliberately naive placement for nodes without a canvas entry; M3 replaces this with the real layout rule. */
export function placeholderLayout(node: MessageNode, layout: ReadonlyMap<NodeId, Layout>): Layout {
  const primary = node.parents[0];
  const parent = primary === undefined ? undefined : layout.get(primary);
  if (parent) return { x: parent.x, y: parent.y + parent.height + NODE_GAP, width: NODE_WIDTH, height: NODE_HEIGHT };
  return { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT };
}

export function columnLayout(ids: NodeId[]): Map<NodeId, Layout> {
  return new Map(ids.map((id, i) => [id, { x: 0, y: i * (NODE_HEIGHT + NODE_GAP), width: NODE_WIDTH, height: NODE_HEIGHT }]));
}
```

`packages/core/src/chain.ts`:
```ts
import { isoTimestamp, newId } from './ids';
import { columnLayout } from './layout';
import type { CanvasGraph, MessageNode, NodeId, Role } from './types';

export interface TranscriptMessage {
  role: Role;
  content: string;
  summary?: string;
  model?: string;
}

/** Turn a linear transcript into a chain graph: each message's parent is the previous one. */
export function linearGraph(slug: string, messages: TranscriptMessage[], now: () => number = Date.now): CanvasGraph {
  const nodes = new Map<NodeId, MessageNode>();
  let prev: NodeId | undefined;
  for (const m of messages) {
    const ms = now();
    const id = newId(ms);
    const node: MessageNode = {
      id,
      role: m.role,
      parents: prev === undefined ? [] : [prev],
      created: isoTimestamp(ms),
      summary: m.summary ?? '',
      topics: [],
      body: m.content,
    };
    if (m.role === 'assistant' && m.model !== undefined) node.model = m.model;
    nodes.set(id, node);
    prev = id;
  }
  return { slug, nodes, layout: columnLayout([...nodes.keys()]), paths: new Map(), foreign: { nodes: [], edges: [] } };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chatmind/core test`
Expected: all `layout` and `chain` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/layout.ts packages/core/src/chain.ts packages/core/test/layout.test.ts packages/core/test/chain.test.ts
git commit -m "feat(core): layout constants and linear transcript chain builder"
```

---

### Task 6: Vault paths and test helpers

**Files:**
- Create: `packages/core/src/vault/paths.ts`, `packages/core/test/helpers.ts`
- Test: `packages/core/test/paths.test.ts`

**Interfaces:**
- Produces (paths.ts): `DEFAULT_DATA_DIR`, `CANVAS_FILE = 'graph.canvas'`, `NODES_DIR = 'nodes'`, `resolveDataDir(explicit?: string, env?: NodeJS.ProcessEnv): string`, `exists(p: string): Promise<boolean>`, `listCanvasFolders(root: string): Promise<string[]>`, `walkMarkdownFiles(dir: string): Promise<string[]>` (absolute, sorted, dot-entries skipped), `toVaultPath(root: string, abs: string): string` (posix, relative)
- Produces (helpers.ts): `A`, `B`, `C` fixed ULIDs, `tmpDir()`, `readTree(root)`, `node(over)`, `sampleGraph()`

- [ ] **Step 1: Write the test helpers**

`packages/core/test/helpers.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanvasGraph, MessageNode } from '../src/types';

export const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
export const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';
export const C = '01JQ8F4Q5R6S7T8V9W0X1Y2ZAA';

export async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-'));
}

/** Every file under root as posix-relative path → content, sorted by path. Dot-entries are skipped. */
export async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.set(path.relative(root, abs).split(path.sep).join('/'), await fs.readFile(abs, 'utf8'));
    }
  }
  await walk(root);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function node(over: Partial<MessageNode> & { id: string }): MessageNode {
  return { role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Body.', ...over };
}

/** A → B → C chain in canvas "masterarbeit", laid out in a column, no paths assigned yet. */
export function sampleGraph(): CanvasGraph {
  const nodes = [
    node({ id: A, summary: 'Ursprungsfrage', body: 'Wie evaluiere ich Topic-Zuordnung?' }),
    node({ id: B, role: 'assistant', model: 'claude-sonnet-4-6', parents: [A], summary: 'Zentroid-Ansatz skaliert besser', body: 'Zentroid statt Re-Clustering.\n\nBegründung folgt.' }),
    node({ id: C, parents: [B], body: 'Danke.' }),
  ];
  return {
    slug: 'masterarbeit',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    layout: new Map([
      [A, { x: 0, y: 0, width: 400, height: 200 }],
      [B, { x: 0, y: 280, width: 400, height: 200 }],
      [C, { x: 0, y: 560, width: 400, height: 200 }],
    ]),
    paths: new Map(),
    foreign: { nodes: [], edges: [] },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/core/test/paths.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DATA_DIR, exists, listCanvasFolders, resolveDataDir, toVaultPath, walkMarkdownFiles } from '../src/vault/paths';
import { tmpDir } from './helpers';

describe('resolveDataDir', () => {
  it('prefers the explicit path, then the env var, then the default', () => {
    expect(resolveDataDir('/x', { CHATMIND_DATA_DIR: '/y' })).toBe('/x');
    expect(resolveDataDir(undefined, { CHATMIND_DATA_DIR: '/y' })).toBe('/y');
    expect(resolveDataDir(undefined, {})).toBe(DEFAULT_DATA_DIR);
    expect(DEFAULT_DATA_DIR).toBe(path.join(os.homedir(), 'Documents', 'chatmind'));
  });
  it('expands a leading ~', () => {
    expect(resolveDataDir('~/foo', {})).toBe(path.join(os.homedir(), 'foo'));
  });
});

describe('listCanvasFolders', () => {
  it('lists folders with a canvas file or a nodes dir, sorted, skipping dot-folders', async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, 'zeta', 'nodes'), { recursive: true });
    await fs.mkdir(path.join(root, 'alpha'));
    await fs.writeFile(path.join(root, 'alpha', 'graph.canvas'), '{}');
    await fs.mkdir(path.join(root, 'empty'));
    await fs.mkdir(path.join(root, '.app'));
    await fs.writeFile(path.join(root, '.app', 'graph.canvas'), '{}');
    await fs.writeFile(path.join(root, 'stray.md'), '');
    expect(await listCanvasFolders(root)).toEqual(['alpha', 'zeta']);
  });
});

describe('walkMarkdownFiles', () => {
  it('finds .md files recursively, sorted, skipping dot-entries and other extensions', async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, 'nodes', 'sub'), { recursive: true });
    await fs.mkdir(path.join(root, '.obsidian'));
    await fs.writeFile(path.join(root, 'nodes', 'b.md'), '');
    await fs.writeFile(path.join(root, 'nodes', 'sub', 'a.md'), '');
    await fs.writeFile(path.join(root, 'nodes', '.hidden.md'), '');
    await fs.writeFile(path.join(root, '.obsidian', 'x.md'), '');
    await fs.writeFile(path.join(root, 'graph.canvas'), '{}');
    await fs.writeFile(path.join(root, 'top.md'), '');
    expect(await walkMarkdownFiles(root)).toEqual([path.join(root, 'nodes', 'b.md'), path.join(root, 'nodes', 'sub', 'a.md'), path.join(root, 'top.md')]);
  });
});

describe('toVaultPath / exists', () => {
  it('produces posix-relative paths', () => {
    expect(toVaultPath('/v', path.join('/v', 'm', 'nodes', 'a.md'))).toBe('m/nodes/a.md');
  });
  it('exists', async () => {
    const root = await tmpDir();
    expect(await exists(root)).toBe(true);
    expect(await exists(path.join(root, 'nope'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @chatmind/core test`
Expected: FAIL — cannot resolve `../src/vault/paths`.

- [ ] **Step 4: Implement**

`packages/core/src/vault/paths.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CANVAS_FILE = 'graph.canvas';
export const NODES_DIR = 'nodes';
export const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Documents', 'chatmind');

/** `--data-dir` → `CHATMIND_DATA_DIR` → `~/Documents/chatmind` (spec §11). */
export function resolveDataDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = explicit ?? env.CHATMIND_DATA_DIR ?? DEFAULT_DATA_DIR;
  return chosen.startsWith('~/') ? path.join(os.homedir(), chosen.slice(2)) : chosen;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Canvas slugs: direct child folders that have a graph.canvas or a nodes/ dir. Dot-folders (.app, .obsidian) are skipped. */
export async function listCanvasFolders(root: string): Promise<string[]> {
  const slugs: string[] = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(root, e.name);
    if ((await exists(path.join(dir, CANVAS_FILE))) || (await exists(path.join(dir, NODES_DIR)))) slugs.push(e.name);
  }
  return slugs.sort();
}

/** Absolute paths of every .md under dir, recursively, sorted; dot-entries skipped. */
export async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMarkdownFiles(abs)));
    else if (e.name.endsWith('.md')) out.push(abs);
  }
  return out.sort();
}

export function toVaultPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @chatmind/core test`
Expected: all `paths` tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/vault/paths.ts packages/core/test/paths.test.ts packages/core/test/helpers.ts
git commit -m "feat(core): data-dir resolution and vault folder scanning"
```

---

### Task 7: Vault writer

**Files:**
- Create: `packages/core/src/vault/write.ts`
- Test: `packages/core/test/write.test.ts`

**Interfaces:**
- Consumes: `serializeNodeFile` (Task 3), `serializeCanvas`, `derivedEdges`, `CanvasFileNode` (Task 4), `placeholderLayout` (Task 5), `nodeFileName` (Task 2), `CANVAS_FILE`, `NODES_DIR` (Task 6).
- Produces: `writeCanvas(graph: CanvasGraph, root: string): Promise<void>` — **mutates** `graph.paths` (newly assigned paths) and `graph.layout` (placeholder layouts) so the graph matches what is on disk; `writeIfChanged(abs: string, content: string): Promise<boolean>`; `sortedNodes(graph: CanvasGraph): MessageNode[]` (by id).

- [ ] **Step 1: Write the failing tests**

`packages/core/test/write.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeNodeFile } from '../src/frontmatter';
import { writeCanvas, writeIfChanged } from '../src/vault/write';
import { A, B, C, readTree, sampleGraph, tmpDir } from './helpers';

describe('writeCanvas', () => {
  it('writes canonical node files under nodes/ and records their paths', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, root);
    const tree = await readTree(root);
    expect([...tree.keys()]).toEqual([
      'masterarbeit/graph.canvas',
      `masterarbeit/nodes/${A}-ursprungsfrage.md`,
      `masterarbeit/nodes/${B}-zentroid-ansatz-skaliert-besser.md`,
      `masterarbeit/nodes/${C}.md`,
    ]);
    expect(tree.get(`masterarbeit/nodes/${B}-zentroid-ansatz-skaliert-besser.md`)).toBe(serializeNodeFile(g.nodes.get(B)!, 'masterarbeit'));
    expect(g.paths.get(C)).toBe(`masterarbeit/nodes/${C}.md`);
  });

  it('writes graph.canvas with file nodes, layout and derived edges', async () => {
    const root = await tmpDir();
    await writeCanvas(sampleGraph(), root);
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
    expect(canvas.nodes).toEqual([
      { id: A, type: 'file', file: `masterarbeit/nodes/${A}-ursprungsfrage.md`, x: 0, y: 0, width: 400, height: 200 },
      { id: B, type: 'file', file: `masterarbeit/nodes/${B}-zentroid-ansatz-skaliert-besser.md`, x: 0, y: 280, width: 400, height: 200 },
      { id: C, type: 'file', file: `masterarbeit/nodes/${C}.md`, x: 0, y: 560, width: 400, height: 200 },
    ]);
    expect(canvas.edges).toEqual([
      { id: `e-${A}-${B}`, fromNode: A, fromSide: 'bottom', toNode: B, toSide: 'top' },
      { id: `e-${B}-${C}`, fromNode: B, fromSide: 'bottom', toNode: C, toSide: 'top' },
    ]);
  });

  it('respects existing paths and never renames', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.paths.set(A, 'masterarbeit/archiv/alte-frage.md');
    await writeCanvas(g, root);
    const tree = await readTree(root);
    expect(tree.has('masterarbeit/archiv/alte-frage.md')).toBe(true);
    expect(tree.has(`masterarbeit/nodes/${A}-ursprungsfrage.md`)).toBe(false);
    const canvas = JSON.parse(tree.get('masterarbeit/graph.canvas')!);
    expect(canvas.nodes[0].file).toBe('masterarbeit/archiv/alte-frage.md');
  });

  it('assigns placeholder layout to nodes without one and records it', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.layout.delete(C);
    await writeCanvas(g, root);
    expect(g.layout.get(C)).toEqual({ x: 0, y: 280 + 200 + 80, width: 400, height: 200 });
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
    expect(canvas.nodes[2].y).toBe(560);
  });

  it('passes foreign canvas content through', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    g.foreign.nodes.push({ id: 'note1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 });
    g.foreign.edges.push({ id: 'fe', fromNode: 'note1', toNode: A });
    await writeCanvas(g, root);
    const canvas = JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
    expect(canvas.nodes[3]).toEqual({ id: 'note1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 });
    expect(canvas.edges[2]).toEqual({ id: 'fe', fromNode: 'note1', toNode: A });
  });

  it('does not touch files whose content is unchanged', async () => {
    const root = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, root);
    const old = new Date('2020-01-01T00:00:00Z');
    for (const rel of [...g.paths.values(), 'masterarbeit/graph.canvas']) await fs.utimes(path.join(root, rel), old, old);
    await writeCanvas(g, root);
    for (const rel of [...g.paths.values(), 'masterarbeit/graph.canvas']) {
      expect((await fs.stat(path.join(root, rel))).mtime).toEqual(old);
    }
  });

  it('leaves no temp files behind', async () => {
    const root = await tmpDir();
    await writeCanvas(sampleGraph(), root);
    const all = await fs.readdir(path.join(root, 'masterarbeit', 'nodes'));
    expect(all.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('writeIfChanged', () => {
  it('returns true on create and change, false when identical', async () => {
    const root = await tmpDir();
    const f = path.join(root, 'deep', 'x.txt');
    expect(await writeIfChanged(f, 'a')).toBe(true);
    expect(await writeIfChanged(f, 'a')).toBe(false);
    expect(await writeIfChanged(f, 'b')).toBe(true);
    expect(await fs.readFile(f, 'utf8')).toBe('b');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core test`
Expected: FAIL — cannot resolve `../src/vault/write`.

- [ ] **Step 3: Implement**

`packages/core/src/vault/write.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { derivedEdges, serializeCanvas, type CanvasFileNode } from '../canvas';
import { serializeNodeFile } from '../frontmatter';
import { nodeFileName } from '../ids';
import { placeholderLayout } from '../layout';
import type { CanvasGraph, MessageNode } from '../types';
import { CANVAS_FILE, NODES_DIR } from './paths';

export function sortedNodes(graph: CanvasGraph): MessageNode[] {
  return [...graph.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Write a canvas folder. Only files whose bytes change are written; nothing is ever renamed or deleted.
 * Side effect on `graph`: newly created nodes get their path recorded in `graph.paths`, nodes without
 * layout get a placeholder recorded in `graph.layout`, so the in-memory graph matches the disk afterwards.
 */
export async function writeCanvas(graph: CanvasGraph, root: string): Promise<void> {
  const { slug } = graph;
  await fs.mkdir(path.join(root, slug, NODES_DIR), { recursive: true });

  const fileNodes: CanvasFileNode[] = [];
  for (const node of sortedNodes(graph)) {
    let rel = graph.paths.get(node.id);
    if (rel === undefined) {
      rel = `${slug}/${NODES_DIR}/${nodeFileName(node.id, node.summary)}`;
      graph.paths.set(node.id, rel);
    }
    await writeIfChanged(path.join(root, rel), serializeNodeFile(node, slug));

    let layout = graph.layout.get(node.id);
    if (layout === undefined) {
      layout = placeholderLayout(node, graph.layout);
      graph.layout.set(node.id, layout);
    }
    fileNodes.push({ id: node.id, file: rel, ...layout });
  }

  const canvas = serializeCanvas({ fileNodes, edges: derivedEdges(graph), foreign: graph.foreign });
  await writeIfChanged(path.join(root, slug, CANVAS_FILE), canvas);
}

/** Atomic write (temp file + rename in the same directory), skipped when the content is already on disk. */
export async function writeIfChanged(abs: string, content: string): Promise<boolean> {
  let existing: string | undefined;
  try {
    existing = await fs.readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing === content) return false;

  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, abs);
  return true;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chatmind/core test`
Expected: all `write` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/vault/write.ts packages/core/test/write.test.ts
git commit -m "feat(core): vault writer with change detection and atomic writes"
```

---

### Task 8: CLI package with `import-transcript` (M0)

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/src/index.ts`, `apps/cli/src/transcript.ts`, `apps/cli/src/import-transcript.ts`, `apps/cli/fixtures/transcript.json`
- Modify: `packages/core/src/index.ts` (replace the placeholder with real exports)
- Test: `apps/cli/test/transcript.test.ts`

**Interfaces:**
- Consumes: `linearGraph`, `TranscriptMessage` (Task 5), `writeCanvas` (Task 7), `resolveDataDir`, `exists` (Task 6).
- Produces: `parseTranscript(raw: unknown): TranscriptMessage[]` (throws `Error` with a message naming the offending message index); `importTranscript(file: string, canvas: string, dataDir?: string): Promise<{ root: string; count: number }>`; CLI entry `pnpm cli import-transcript <file> --canvas <slug> [--data-dir <path>]`.

- [ ] **Step 1: Export the core API**

Replace `packages/core/src/index.ts`:
```ts
export * from './types';
export { newId, isUlid, isoTimestamp, slug, nodeFileName, SLUG_MAX } from './ids';
export { serializeNodeFile, parseNodeFile, normalizeBody, normalizeSummary, type ParseResult } from './frontmatter';
export { serializeCanvas, parseCanvas, edgeId, derivedEdges, type CanvasFileNode, type CanvasEdge, type CanvasContent, type RawCanvas } from './canvas';
export { NODE_WIDTH, NODE_HEIGHT, NODE_GAP, placeholderLayout, columnLayout } from './layout';
export { linearGraph, type TranscriptMessage } from './chain';
export { resolveDataDir, exists, listCanvasFolders, walkMarkdownFiles, toVaultPath, DEFAULT_DATA_DIR, CANVAS_FILE, NODES_DIR } from './vault/paths';
export { writeCanvas, writeIfChanged, sortedNodes } from './vault/write';
```

Delete `packages/core/test/smoke.test.ts` (its `VERSION` export is gone).

- [ ] **Step 2: Create the CLI package**

`apps/cli/package.json`:
```json
{
  "name": "@chatmind/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@chatmind/core": "workspace:*"
  }
}
```

`apps/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `pnpm install`
Expected: `apps/cli/node_modules/@chatmind/core` is a symlink to `packages/core`.

- [ ] **Step 3: Write the failing transcript test**

`apps/cli/test/transcript.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../src/transcript';

describe('parseTranscript', () => {
  it('accepts the documented shape and keeps optional fields only when present', () => {
    expect(parseTranscript({ messages: [{ role: 'user', content: 'a', summary: 's' }, { role: 'assistant', content: 'b', model: 'm' }] })).toEqual([
      { role: 'user', content: 'a', summary: 's' },
      { role: 'assistant', content: 'b', model: 'm' },
    ]);
  });
  it('rejects a missing messages array', () => {
    expect(() => parseTranscript({})).toThrow('transcript must be an object with a "messages" array');
    expect(() => parseTranscript(null)).toThrow('transcript must be an object with a "messages" array');
  });
  it('rejects bad messages with their index', () => {
    expect(() => parseTranscript({ messages: [{ role: 'system', content: 'x' }] })).toThrow('message 0: role must be "user" or "assistant"');
    expect(() => parseTranscript({ messages: [{ role: 'user', content: 'x' }, { role: 'user' }] })).toThrow('message 1: content must be a string');
    expect(() => parseTranscript({ messages: ['x'] })).toThrow('message 0 is not an object');
  });
});
```

Run: `pnpm --filter @chatmind/cli test`
Expected: FAIL — cannot resolve `../src/transcript`.

- [ ] **Step 4: Implement transcript validation, the command, and the entry point**

`apps/cli/src/transcript.ts`:
```ts
import type { TranscriptMessage } from '@chatmind/core';

export function parseTranscript(raw: unknown): TranscriptMessage[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { messages?: unknown }).messages)) {
    throw new Error('transcript must be an object with a "messages" array');
  }
  return (raw as { messages: unknown[] }).messages.map((m, i) => {
    if (typeof m !== 'object' || m === null) throw new Error(`message ${i} is not an object`);
    const { role, content, summary, model } = m as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') throw new Error(`message ${i}: role must be "user" or "assistant"`);
    if (typeof content !== 'string') throw new Error(`message ${i}: content must be a string`);
    const out: TranscriptMessage = { role, content };
    if (typeof summary === 'string') out.summary = summary;
    if (typeof model === 'string') out.model = model;
    return out;
  });
}
```

`apps/cli/src/import-transcript.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exists, linearGraph, resolveDataDir, writeCanvas } from '@chatmind/core';
import { parseTranscript } from './transcript';

export async function importTranscript(file: string, canvas: string, dataDir?: string): Promise<{ root: string; count: number }> {
  const root = resolveDataDir(dataDir);
  const canvasDir = path.join(root, canvas);
  if (await exists(canvasDir)) {
    throw new Error(`canvas "${canvas}" already exists at ${canvasDir} — import-transcript creates new canvases only`);
  }
  const messages = parseTranscript(JSON.parse(await fs.readFile(file, 'utf8')));
  const graph = linearGraph(canvas, messages);
  await fs.mkdir(root, { recursive: true });
  await writeCanvas(graph, root);
  return { root, count: graph.nodes.size };
}
```

`apps/cli/src/index.ts`:
```ts
import path from 'node:path';
import { parseArgs } from 'node:util';
import { importTranscript } from './import-transcript';

const USAGE = `usage:
  chatmind import-transcript <transcript.json> --canvas <slug> [--data-dir <path>]
  chatmind check [--data-dir <path>]

data dir: --data-dir, else $CHATMIND_DATA_DIR, else ~/Documents/chatmind`;

// pnpm runs package scripts with cwd = the package dir; INIT_CWD is where the user actually typed the command.
const invokedFrom = process.env.INIT_CWD ?? process.cwd();

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { canvas: { type: 'string' }, 'data-dir': { type: 'string' } },
  });
  const [command, ...rest] = positionals;
  const dataDir = values['data-dir'] === undefined ? undefined : path.resolve(invokedFrom, values['data-dir']);

  switch (command) {
    case 'import-transcript': {
      const file = rest[0];
      if (file === undefined || values.canvas === undefined) {
        console.error(USAGE);
        return 2;
      }
      const { root, count } = await importTranscript(path.resolve(invokedFrom, file), values.canvas, dataDir);
      console.log(`wrote ${count} nodes to ${path.join(root, values.canvas)}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
```

`apps/cli/fixtures/transcript.json`:
```json
{
  "messages": [
    {
      "role": "user",
      "content": "Ich schreibe meine Masterarbeit über Topic-Zuordnung in Chat-Graphen. Wie evaluiere ich, ob ein neuer Node dem richtigen Topic zugeordnet wurde?",
      "summary": "Wie evaluiert man Topic-Zuordnung in Chat-Graphen?"
    },
    {
      "role": "assistant",
      "model": "claude-sonnet-4-6",
      "content": "Zwei gängige Wege:\n\n1. **Gold-Labels**: Du annotierst eine Stichprobe von Hand und misst Precision/Recall pro Topic.\n2. **Konsistenz**: Du prüfst, ob strukturell benachbarte Nodes (Parent/Child) meist dasselbe Topic tragen.\n\nFür eine Masterarbeit brauchst du (1) als Hauptmetrik; (2) ist ein günstiger Plausibilitätscheck.",
      "summary": "Zwei Optionen: Gold-Labels oder strukturelle Konsistenz"
    },
    {
      "role": "user",
      "content": "Und wenn sich die Topics im Laufe der Zeit verschieben? Bei Re-Clustering ändert sich ja rückwirkend die Zuordnung.",
      "summary": "Problem: Re-Clustering ändert Zuordnungen rückwirkend"
    },
    {
      "role": "assistant",
      "model": "claude-sonnet-4-6",
      "content": "Genau deshalb ist Re-Clustering für interaktive Systeme ungeeignet. Ein **Zentroid-Ansatz** vermeidet das: jedes Topic hat einen Zentroid, neue Nodes werden per Kosinus-Ähnlichkeit zugeordnet, der Zentroid wird als laufender Mittelwert aktualisiert. Bestehende Zuordnungen bleiben stabil.\n\nWichtig: innerhalb eines engen Themas komprimieren sich alle Ähnlichkeiten in ein schmales Band (0,75–0,9). Du musst vor dem Vergleich den Canvas-Zentroid abziehen (Mean-Centering).",
      "summary": "Zentroid-Ansatz mit Mean-Centering skaliert besser als Re-Clustering"
    },
    {
      "role": "user",
      "content": "Danke, das nehme ich als Grundlage für Kapitel 4.",
      "summary": "Zentroid-Ansatz wird Grundlage für Kapitel 4"
    }
  ]
}
```

- [ ] **Step 5: Run tests, typecheck, and the real import into a scratch dir**

Run: `pnpm test && pnpm typecheck`
Expected: `@chatmind/core` and `@chatmind/cli` tests pass; `tsc` exit 0 for both.

Run: `pnpm cli import-transcript apps/cli/fixtures/transcript.json --canvas masterarbeit --data-dir /tmp/chatmind-m0`
Expected output: `wrote 5 nodes to /tmp/chatmind-m0/masterarbeit`.

Run: `ls /tmp/chatmind-m0/masterarbeit/nodes && cat /tmp/chatmind-m0/masterarbeit/graph.canvas`
Expected: five `.md` files named `{ULID}-{slug}.md` in chronological order, and a tab-indented canvas with 5 nodes and 4 edges.

Run again: `pnpm cli import-transcript apps/cli/fixtures/transcript.json --canvas masterarbeit --data-dir /tmp/chatmind-m0`
Expected: exit code 1 with `canvas "masterarbeit" already exists at …`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): import-transcript command and M0 fixture"
```

---

### Task 9: Manual M0 gate — verify in Obsidian

This task is manual and is the milestone's done condition (spec §12). It requires the user (the plan executor stops and asks). Do **not** proceed to Task 10 until it is complete.

**Files:**
- Create: `docs/superpowers/notes/2026-09-11-m0-obsidian-findings.md`
- Possibly modify: `packages/core/src/canvas.ts`, `packages/core/test/canvas.test.ts`, `packages/core/test/write.test.ts`

- [ ] **Step 1: Produce the real data folder**

Run: `pnpm cli import-transcript apps/cli/fixtures/transcript.json --canvas masterarbeit`
Expected: `wrote 5 nodes to /Users/<user>/Documents/chatmind/masterarbeit`.

Run: `cp ~/Documents/chatmind/masterarbeit/graph.canvas /tmp/chatmind-before.canvas`

- [ ] **Step 2: Ask the user to verify in Obsidian**

Ask the user to:
1. Open Obsidian → "Open folder as vault" → `~/Documents/chatmind`. (Choose "trust author" if prompted; there are no plugins.)
2. Open `masterarbeit/graph.canvas`. Confirm: 5 file nodes render, connected top-to-bottom in order, each showing the message body (not raw frontmatter — Obsidian hides properties on file cards).
3. Click a node → the note opens, properties panel shows `id`, `parents`, `summary` etc.
4. Drag one node a few hundred pixels, then drag it back roughly. Wait 2 s (Obsidian autosaves the canvas).
5. Report back what they saw.

- [ ] **Step 3: Diff Obsidian's re-save against our output**

Run: `diff /tmp/chatmind-before.canvas ~/Documents/chatmind/masterarbeit/graph.canvas; echo "exit $?"`

Interpret:
- No diff apart from the moved node's `x`/`y` → serializer matches Obsidian. Done.
- Whole-file diff (indentation, key order, trailing newline) → adjust `serializeCanvas` in `packages/core/src/canvas.ts` to Obsidian's exact style, update the expected strings in `canvas.test.ts` (and `write.test.ts` if it inspects raw text), rerun `pnpm test`.
- Obsidian changed our node `id`s or dropped edges → stop and report; that would contradict spec §5.3 and needs a design decision.

- [ ] **Step 4: Record findings**

`docs/superpowers/notes/2026-09-11-m0-obsidian-findings.md` — write what was observed, verbatim diff (if any), and what was changed in the serializer. Minimum content:
```markdown
# M0 Obsidian findings — 2026-09-11

- Obsidian version: <fill from About dialog>
- Canvas rendered: yes/no — <notes>
- Node cards show body: yes/no
- Edge direction/order correct: yes/no
- Re-save diff: none | <paste diff>
- Serializer changes made: none | <describe>
- Verdict: format decision validated | needs change (<what>)
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: record M0 Obsidian verification findings"
```

---

### Task 10: Reader — node scan and node-level repairs

**Files:**
- Create: `packages/core/src/vault/read.ts`
- Test: `packages/core/test/read.test.ts`

**Interfaces:**
- Consumes: `parseNodeFile` (Task 3), `parseCanvas`, `edgeId`, `derivedEdges` (Task 4), `placeholderLayout` (Task 5), `CANVAS_FILE`, `listCanvasFolders`, `walkMarkdownFiles`, `toVaultPath`, `exists` (Task 6), `writeCanvas` (Task 7, tests only).
- Produces: `interface ReadResult { canvases: CanvasGraph[]; repairs: Repair[] }`, `readVault(root: string): Promise<ReadResult>`. This task implements the node scan fully and a *basic* canvas pass (layout + paths for canvas nodes whose id is a known ULID). Tasks 11 and 12 extend `read.ts` in place.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/read.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decodeTime } from 'ulid';
import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '../src/ids';
import { readVault } from '../src/vault/read';
import { writeCanvas } from '../src/vault/write';
import type { Repair } from '../src/types';
import { A, B, C, sampleGraph, tmpDir } from './helpers';

/** Sorted, compact view of repairs for stable assertions. */
function kinds(repairs: Repair[]): string[] {
  return repairs.map((r) => ('field' in r ? `${r.kind}:${r.field}` : r.kind)).sort();
}

async function writtenVault(): Promise<{ root: string; dir: string }> {
  const root = await tmpDir();
  await writeCanvas(sampleGraph(), root);
  return { root, dir: path.join(root, 'masterarbeit', 'nodes') };
}

describe('readVault — node scan', () => {
  it('reads back a vault written by writeCanvas with no repairs', async () => {
    const { root } = await writtenVault();
    const { canvases, repairs } = await readVault(root);
    expect(repairs).toEqual([]);
    expect(canvases).toHaveLength(1);
    const g = canvases[0]!;
    const expected = sampleGraph();
    expect(g.slug).toBe('masterarbeit');
    expect(g.nodes).toEqual(expected.nodes);
    expect(g.layout).toEqual(expected.layout);
    expect(g.paths.get(A)).toBe(`masterarbeit/nodes/${A}-ursprungsfrage.md`);
    expect(g.foreign).toEqual({ nodes: [], edges: [] });
  });

  it('throws only when root is missing', async () => {
    await expect(readVault('/definitely/not/here')).rejects.toThrow();
  });

  it('returns no canvases for an empty root', async () => {
    expect(await readVault(await tmpDir())).toEqual({ canvases: [], repairs: [] });
  });

  it('reports unparseable files and leaves them out', async () => {
    const { root, dir } = await writtenVault();
    await fs.writeFile(path.join(dir, 'junk.md'), '# no frontmatter\n');
    await fs.writeFile(path.join(dir, 'bad-id.md'), '---\nid: nope\n---\n');
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.nodes.size).toBe(3);
    expect(repairs).toEqual([
      { kind: 'unparseable-node', path: 'masterarbeit/nodes/bad-id.md', reason: 'missing or invalid id' },
      { kind: 'unparseable-node', path: 'masterarbeit/nodes/junk.md', reason: 'no frontmatter block' },
    ]);
  });

  it('defaults missing fields and flags a canvas field that disagrees with the folder', async () => {
    const { root, dir } = await writtenVault();
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    await fs.writeFile(path.join(dir, `${D}.md`), `---\nid: ${D}\ncanvas: other\n---\nHallo\n`);
    const { canvases, repairs } = await readVault(root);
    const d = canvases[0]!.nodes.get(D);
    expect(d).toEqual({ id: D, role: 'user', parents: [], created: isoTimestamp(decodeTime(D)), summary: '', topics: [], body: 'Hallo' });
    expect(kinds(repairs.filter((r) => r.kind === 'defaulted-field'))).toEqual([
      'defaulted-field:canvas',
      'defaulted-field:created',
      'defaulted-field:parents',
      'defaulted-field:role',
      'defaulted-field:summary',
      'defaulted-field:topics',
    ]);
  });

  it('keeps the first of two files sharing an id (by path order) and reports the other', async () => {
    const { root, dir } = await writtenVault();
    const original = `masterarbeit/nodes/${C}.md`;
    await fs.copyFile(path.join(root, original), path.join(dir, `${C}-copy.md`)); // "-" (0x2d) sorts before "." (0x2e), so the copy is kept
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.nodes.size).toBe(3);
    expect(repairs.filter((r) => r.kind === 'duplicate-id')).toEqual([{ kind: 'duplicate-id', id: C, kept: `masterarbeit/nodes/${C}-copy.md`, dropped: original }]);
  });

  it('finds nodes moved into subfolders', async () => {
    const { root, dir } = await writtenVault();
    await fs.mkdir(path.join(dir, 'archiv'));
    await fs.rename(path.join(root, `masterarbeit/nodes/${A}-ursprungsfrage.md`), path.join(dir, 'archiv', 'frage.md'));
    const { canvases } = await readVault(root);
    expect(canvases[0]!.nodes.has(A)).toBe(true);
    expect(canvases[0]!.paths.get(A)).toBe('masterarbeit/nodes/archiv/frage.md');
  });
});
```

Note the duplicate-id test: `${C}-copy.md` sorts *before* `${C}.md` because `-` < `.` in ASCII, so the copy is the one kept. The assertion reflects that deliberately — the rule is "first by sorted path", not "the original". It filters by kind because Task 11 will additionally report the canvas's now-stale path for `C` as `path-repaired`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core test`
Expected: FAIL — cannot resolve `../src/vault/read`.

- [ ] **Step 3: Implement the scan and a basic canvas pass**

`packages/core/src/vault/read.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseCanvas } from '../canvas';
import { parseNodeFile } from '../frontmatter';
import type { CanvasGraph, Layout, NodeId, Repair } from '../types';
import { CANVAS_FILE, listCanvasFolders, toVaultPath, walkMarkdownFiles } from './paths';
import { NODE_HEIGHT, NODE_WIDTH } from '../layout';

export interface ReadResult {
  canvases: CanvasGraph[];
  repairs: Repair[];
}

/**
 * Parse a data folder into graphs. Never throws except when `root` is unreadable; every problem
 * becomes a Repair. Never writes (spec §9).
 */
export async function readVault(root: string): Promise<ReadResult> {
  await fs.access(root);
  const repairs: Repair[] = [];
  const canvases: CanvasGraph[] = [];
  for (const slug of await listCanvasFolders(root)) {
    canvases.push(await readCanvasFolder(root, slug, repairs));
  }
  return { canvases, repairs };
}

async function readCanvasFolder(root: string, slug: string, repairs: Repair[]): Promise<CanvasGraph> {
  const graph: CanvasGraph = { slug, nodes: new Map(), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
  await scanNodes(root, graph, repairs);
  await applyCanvas(root, graph, repairs);
  return graph;
}

/** Step 1 of spec §9: every .md under the canvas folder, indexed by frontmatter id. */
async function scanNodes(root: string, graph: CanvasGraph, repairs: Repair[]): Promise<void> {
  for (const abs of await walkMarkdownFiles(path.join(root, graph.slug))) {
    const rel = toVaultPath(root, abs);
    const parsed = parseNodeFile(await fs.readFile(abs, 'utf8'));
    if (!parsed.ok) {
      repairs.push({ kind: 'unparseable-node', path: rel, reason: parsed.reason });
      continue;
    }
    const { node } = parsed;
    const kept = graph.paths.get(node.id);
    if (kept !== undefined) {
      repairs.push({ kind: 'duplicate-id', id: node.id, kept, dropped: rel });
      continue;
    }
    graph.nodes.set(node.id, node);
    graph.paths.set(node.id, rel);
    for (const field of parsed.defaulted) repairs.push({ kind: 'defaulted-field', id: node.id, field });
    if (parsed.canvas !== graph.slug) repairs.push({ kind: 'defaulted-field', id: node.id, field: 'canvas' });
  }
}

/** Step 2 of spec §9 — basic version: layout for canvas nodes whose id is one of ours. Extended in later tasks. */
async function applyCanvas(root: string, graph: CanvasGraph, repairs: Repair[]): Promise<void> {
  const canvasPath = path.join(root, graph.slug, CANVAS_FILE);
  let text: string;
  try {
    text = await fs.readFile(canvasPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      repairs.push({ kind: 'canvas-missing', canvas: graph.slug });
      return;
    }
    throw err;
  }
  const parsed = parseCanvas(text);
  if (!parsed.ok) {
    repairs.push({ kind: 'canvas-corrupt', canvas: graph.slug, reason: parsed.reason });
    return;
  }
  for (const raw of parsed.nodes) {
    const cid = String(raw.id);
    if (raw.type === 'file' && graph.nodes.has(cid)) graph.layout.set(cid, readLayout(raw));
  }
}

function readLayout(raw: Record<string, unknown>): Layout {
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return { x: num(raw.x, 0), y: num(raw.y, 0), width: num(raw.width, NODE_WIDTH), height: num(raw.height, NODE_HEIGHT) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chatmind/core test`
Expected: all `read` tests PASS. (The moved-file test passes already because paths come from the scan, not from the canvas.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/vault/read.ts packages/core/test/read.test.ts
git commit -m "feat(core): vault reader with node scan and node-level repairs"
```

---

### Task 11: Reader — canvas resolution, foreign passthrough, orphans

**Files:**
- Modify: `packages/core/src/vault/read.ts` (replace `applyCanvas`)
- Test: `packages/core/test/read.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 10; `exists` (Task 6).
- Produces: `applyCanvas` now implements resolution order (a)–(d) from spec §9 step 2, fills `graph.foreign`, and returns `CanvasPass { ours: Map<canvasNodeId, NodeId>; structuralEdges: { from: NodeId; to: NodeId }[] }` for Task 12.

- [ ] **Step 1: Append the failing tests**

Append to `packages/core/test/read.test.ts`:
```ts
describe('readVault — canvas resolution', () => {
  async function canvasJson(root: string): Promise<{ nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }> {
    return JSON.parse(await fs.readFile(path.join(root, 'masterarbeit', 'graph.canvas'), 'utf8'));
  }
  async function writeCanvasJson(root: string, data: unknown): Promise<void> {
    await fs.writeFile(path.join(root, 'masterarbeit', 'graph.canvas'), JSON.stringify(data));
  }

  it('reports a missing canvas and still returns the nodes', async () => {
    const { root } = await writtenVault();
    await fs.unlink(path.join(root, 'masterarbeit', 'graph.canvas'));
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.nodes.size).toBe(3);
    expect(repairs.find((r) => r.kind === 'canvas-missing')).toEqual({ kind: 'canvas-missing', canvas: 'masterarbeit' });
  });

  it('reports a corrupt canvas', async () => {
    const { root } = await writtenVault();
    await fs.writeFile(path.join(root, 'masterarbeit', 'graph.canvas'), '{oops');
    const { repairs } = await readVault(root);
    expect(repairs.some((r) => r.kind === 'canvas-corrupt' && r.canvas === 'masterarbeit')).toBe(true);
  });

  it('repairs the path of a renamed file via the ULID id', async () => {
    const { root, dir } = await writtenVault();
    const from = `masterarbeit/nodes/${A}-ursprungsfrage.md`;
    await fs.rename(path.join(root, from), path.join(dir, 'Meine Frage.md'));
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.paths.get(A)).toBe('masterarbeit/nodes/Meine Frage.md');
    expect(canvases[0]!.layout.get(A)).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(repairs).toEqual([{ kind: 'path-repaired', id: A, from, to: 'masterarbeit/nodes/Meine Frage.md' }]);
  });

  it('matches a canvas node by file path when its id is not ours', async () => {
    const { root } = await writtenVault();
    const canvas = await canvasJson(root);
    canvas.nodes[1]!.id = 'obsidian-random-id';
    await writeCanvasJson(root, canvas);
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.layout.get(B)).toEqual({ x: 0, y: 280, width: 400, height: 200 });
    expect(repairs.filter((r) => r.kind === 'canvas-id-repaired')).toEqual([{ kind: 'canvas-id-repaired', id: B, canvasNodeId: 'obsidian-random-id' }]);
  });

  it('keeps text nodes, foreign file nodes and their edges verbatim', async () => {
    const { root } = await writtenVault();
    await fs.writeFile(path.join(root, 'masterarbeit', 'notiz.md'), '# Freie Notiz\n');
    const canvas = await canvasJson(root);
    const text = { id: 't1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 };
    const note = { id: 'f1', type: 'file', file: 'masterarbeit/notiz.md', x: 500, y: 200, width: 200, height: 100 };
    canvas.nodes.push(text, note);
    canvas.edges.push({ id: 'e1', fromNode: 't1', toNode: A }, { id: 'e2', fromNode: A, toNode: 'f1', label: 'siehe' });
    await writeCanvasJson(root, canvas);
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.foreign).toEqual({
      nodes: [text, note],
      edges: [{ id: 'e1', fromNode: 't1', toNode: A }, { id: 'e2', fromNode: A, toNode: 'f1', label: 'siehe' }],
    });
    // the free note is not a chatmind node: it is reported as unparseable but must not block anything
    expect(kinds(repairs)).toEqual(['unparseable-node']);
  });

  it('rewrites foreign edge endpoints when a canvas id was repaired', async () => {
    const { root } = await writtenVault();
    const canvas = await canvasJson(root);
    canvas.nodes[0]!.id = 'rnd';
    canvas.edges[0]!.fromNode = 'rnd';
    canvas.nodes.push({ id: 't1', type: 'text', text: 'x', x: 0, y: 0, width: 1, height: 1 });
    canvas.edges.push({ id: 'e9', fromNode: 'rnd', toNode: 't1' });
    await writeCanvasJson(root, canvas);
    const { canvases } = await readVault(root);
    expect(canvases[0]!.foreign.edges).toEqual([{ id: 'e9', fromNode: A, toNode: 't1' }]);
  });

  it('drops canvas file nodes whose file is gone and unknown', async () => {
    const { root } = await writtenVault();
    const canvas = await canvasJson(root);
    canvas.nodes.push({ id: 'ghost', type: 'file', file: 'masterarbeit/nodes/gone.md', x: 0, y: 0, width: 1, height: 1 });
    await writeCanvasJson(root, canvas);
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.foreign.nodes).toEqual([]);
    expect(repairs).toEqual([{ kind: 'orphan-canvas-node', canvas: 'masterarbeit', canvasNodeId: 'ghost', file: 'masterarbeit/nodes/gone.md' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core test`
Expected: the new `canvas resolution` tests FAIL (path-repaired, canvas-id-repaired, foreign, orphan not implemented); the earlier tests still pass.

- [ ] **Step 3: Replace `applyCanvas`**

In `packages/core/src/vault/read.ts`, add `exists` to the `./paths` import and replace `applyCanvas` with:
```ts
interface CanvasPass {
  /** canvas node id → our node id, for every canvas node that resolved to one of ours */
  ours: Map<string, NodeId>;
  /** canvas edges between two of our nodes, already resolved to our ids, for checkEdges */
  structuralEdges: { from: NodeId; to: NodeId }[];
}

/** Step 2 of spec §9: resolve canvas nodes in order (a) known ULID, (b) known path, (c) existing foreign file, (d) orphan. */
async function applyCanvas(root: string, graph: CanvasGraph, repairs: Repair[]): Promise<CanvasPass | undefined> {
  const canvasPath = path.join(root, graph.slug, CANVAS_FILE);
  let text: string;
  try {
    text = await fs.readFile(canvasPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      repairs.push({ kind: 'canvas-missing', canvas: graph.slug });
      return undefined;
    }
    throw err;
  }
  const parsed = parseCanvas(text);
  if (!parsed.ok) {
    repairs.push({ kind: 'canvas-corrupt', canvas: graph.slug, reason: parsed.reason });
    return undefined;
  }

  const byPath = new Map<string, NodeId>([...graph.paths].map(([id, p]) => [p, id]));
  const ours = new Map<string, NodeId>();
  const foreignIds = new Set<string>();

  for (const raw of parsed.nodes) {
    const cid = String(raw.id);
    const file = raw.type === 'file' && typeof raw.file === 'string' ? raw.file : undefined;

    // (a) known ULID, (b) known path
    let id: NodeId | undefined;
    if (file !== undefined) {
      if (graph.nodes.has(cid)) id = cid;
      else {
        const byFile = byPath.get(file);
        if (byFile !== undefined) {
          id = byFile;
          repairs.push({ kind: 'canvas-id-repaired', id, canvasNodeId: cid });
        }
      }
    }
    if (id !== undefined && file !== undefined) {
      if (ours.has(cid)) continue; // duplicate canvas entry for the same node: first wins
      ours.set(cid, id);
      const current = graph.paths.get(id) ?? file;
      if (file !== current) repairs.push({ kind: 'path-repaired', id, from: file, to: current });
      graph.layout.set(id, readLayout(raw));
      continue;
    }
    // (d) file node pointing nowhere
    if (file !== undefined && !(await exists(path.join(root, file)))) {
      repairs.push({ kind: 'orphan-canvas-node', canvas: graph.slug, canvasNodeId: cid, file });
      continue;
    }
    // (c) text/group/link nodes and file nodes for notes that are not ours
    graph.foreign.nodes.push(raw);
    foreignIds.add(cid);
  }

  const structuralEdges: { from: NodeId; to: NodeId }[] = [];
  for (const raw of parsed.edges) {
    const from = String(raw.fromNode);
    const to = String(raw.toNode);
    const ourFrom = ours.get(from);
    const ourTo = ours.get(to);
    const known = (x: string): boolean => ours.has(x) || foreignIds.has(x);
    if (ourFrom !== undefined && ourTo !== undefined) {
      structuralEdges.push({ from: ourFrom, to: ourTo });
    } else if (known(from) && known(to)) {
      graph.foreign.edges.push({ ...raw, fromNode: ourFrom ?? from, toNode: ourTo ?? to });
    } else {
      repairs.push({ kind: 'edge-mismatch', canvas: graph.slug, detail: `edge ${String(raw.id)} references unknown node` });
    }
  }
  return { ours, structuralEdges };
}
```

And in `readCanvasFolder` keep `await applyCanvas(root, graph, repairs);` (the return value is used in Task 12).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chatmind/core test`
Expected: all `read` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/vault/read.ts packages/core/test/read.test.ts
git commit -m "feat(core): reader resolves canvas nodes by id/path, preserves foreign content"
```

---

### Task 12: Reader — layout fill, dangling parents, edge comparison

**Files:**
- Modify: `packages/core/src/vault/read.ts`
- Test: `packages/core/test/read.test.ts` (append)

**Interfaces:**
- Consumes: `placeholderLayout` (Task 5), `derivedEdges`, `edgeId` (Task 4), `CanvasPass` (Task 11), `sortedNodes` (Task 7).
- Produces: `readVault` complete per spec §9 steps 3–5.

- [ ] **Step 1: Append the failing tests**

Append to `packages/core/test/read.test.ts`:
```ts
describe('readVault — structure checks', () => {
  it('gives nodes absent from the canvas a placeholder layout below their parent', async () => {
    const { root, dir } = await writtenVault();
    const D = '01JQ8F5A0B1C2D3E4F5G6H7JAA';
    await fs.writeFile(path.join(dir, `${D}.md`), `---\nid: ${D}\ncanvas: masterarbeit\nrole: user\nparents: [${C}]\ncreated: 2026-01-01T00:00:00Z\nsummary: ''\ntopics: []\n---\n\nNeu.\n`);
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.layout.get(D)).toEqual({ x: 0, y: 560 + 200 + 80, width: 400, height: 200 });
    expect(repairs).toEqual([
      { kind: 'layout-missing', id: D },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: `missing in canvas: e-${C}-${D}` },
    ]);
  });

  it('places every node when the canvas is missing, chaining placeholders', async () => {
    const { root } = await writtenVault();
    await fs.unlink(path.join(root, 'masterarbeit', 'graph.canvas'));
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.layout.get(A)).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    expect(canvases[0]!.layout.get(B)).toEqual({ x: 0, y: 280, width: 400, height: 200 });
    expect(canvases[0]!.layout.get(C)).toEqual({ x: 0, y: 560, width: 400, height: 200 });
    expect(kinds(repairs)).toEqual(['canvas-missing', 'layout-missing', 'layout-missing', 'layout-missing']);
  });

  it('reports dangling parents and keeps them in the model', async () => {
    const { root } = await writtenVault();
    const rel = `masterarbeit/nodes/${C}.md`;
    const X = '01JQ8F9ZZZZZZZZZZZZZZZZZZZ';
    const text = await fs.readFile(path.join(root, rel), 'utf8');
    await fs.writeFile(path.join(root, rel), text.replace(`parents: [${B}]`, `parents: [${B}, ${X}]`));
    const { canvases, repairs } = await readVault(root);
    expect(canvases[0]!.nodes.get(C)!.parents).toEqual([B, X]);
    expect(repairs).toEqual([{ kind: 'dangling-parent', id: C, parent: X }]);
  });

  it('reports canvas edges that frontmatter does not back, and vice versa', async () => {
    const { root } = await writtenVault();
    const canvasPath = path.join(root, 'masterarbeit', 'graph.canvas');
    const canvas = JSON.parse(await fs.readFile(canvasPath, 'utf8'));
    canvas.edges = [{ id: 'user-drawn', fromNode: A, toNode: C }]; // drops A→B and B→C, adds A→C
    await fs.writeFile(canvasPath, JSON.stringify(canvas));
    const { repairs } = await readVault(root);
    expect(repairs).toEqual([
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: `missing in canvas: e-${A}-${B}` },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: `missing in canvas: e-${B}-${C}` },
      { kind: 'edge-mismatch', canvas: 'masterarbeit', detail: `not in frontmatter: e-${A}-${C}` },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @chatmind/core test`
Expected: the four new tests FAIL.

- [ ] **Step 3: Implement steps 3–5**

In `packages/core/src/vault/read.ts`, extend imports:
```ts
import { derivedEdges, edgeId, parseCanvas } from '../canvas';
import { NODE_HEIGHT, NODE_WIDTH, placeholderLayout } from '../layout';
import { sortedNodes } from './write';
```

Replace `readCanvasFolder`:
```ts
async function readCanvasFolder(root: string, slug: string, repairs: Repair[]): Promise<CanvasGraph> {
  const graph: CanvasGraph = { slug, nodes: new Map(), layout: new Map(), paths: new Map(), foreign: { nodes: [], edges: [] } };
  await scanNodes(root, graph, repairs);
  const pass = await applyCanvas(root, graph, repairs);
  fillMissingLayout(graph, repairs);
  checkParents(graph, repairs);
  if (pass) checkEdges(graph, pass, repairs);
  return graph;
}
```

Add at the bottom:
```ts
/** Step 3: nodes on disk but not in the canvas. Processed in id order so a parent is placed before its children. */
function fillMissingLayout(graph: CanvasGraph, repairs: Repair[]): void {
  for (const node of sortedNodes(graph)) {
    if (graph.layout.has(node.id)) continue;
    graph.layout.set(node.id, placeholderLayout(node, graph.layout));
    repairs.push({ kind: 'layout-missing', id: node.id });
  }
}

/** Step 4: parents that reference unknown ids stay in the model but are reported. */
function checkParents(graph: CanvasGraph, repairs: Repair[]): void {
  for (const node of sortedNodes(graph)) {
    for (const parent of node.parents) {
      if (!graph.nodes.has(parent)) repairs.push({ kind: 'dangling-parent', id: node.id, parent });
    }
  }
}

/** Step 5: frontmatter wins; differences to the canvas edges are reported only. */
function checkEdges(graph: CanvasGraph, pass: CanvasPass, repairs: Repair[]): void {
  const inCanvas = new Set(pass.structuralEdges.map((e) => edgeId(e.from, e.to)));
  const derived = new Set(derivedEdges(graph).map((e) => e.id));
  for (const id of [...derived].sort()) {
    if (!inCanvas.has(id)) repairs.push({ kind: 'edge-mismatch', canvas: graph.slug, detail: `missing in canvas: ${id}` });
  }
  for (const id of [...inCanvas].sort()) {
    if (!derived.has(id)) repairs.push({ kind: 'edge-mismatch', canvas: graph.slug, detail: `not in frontmatter: ${id}` });
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @chatmind/core test && pnpm typecheck`
Expected: all tests PASS; `tsc` exit 0. If the `layout-missing` test's repair order differs (layout vs edge-mismatch), keep the implementation order (layout → parents → edges) and fix the test expectation only if it contradicts that order.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/vault/read.ts packages/core/test/read.test.ts
git commit -m "feat(core): reader fills missing layout, checks parents and edge consistency"
```

---

### Task 13: Round-trip test and public exports (M1 done condition)

**Files:**
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/roundtrip.test.ts`

**Interfaces:**
- Consumes: `readVault` (Task 12), `writeCanvas` (Task 7), `linearGraph` (Task 5), `parseTranscript` shape (fixture read directly as JSON).
- Produces: `readVault`, `ReadResult` exported from `@chatmind/core`.

- [ ] **Step 1: Export the reader**

Append to `packages/core/src/index.ts`:
```ts
export { readVault, type ReadResult } from './vault/read';
```

- [ ] **Step 2: Write the failing round-trip tests**

`packages/core/test/roundtrip.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { linearGraph } from '../src/chain';
import { readVault } from '../src/vault/read';
import { writeCanvas } from '../src/vault/write';
import type { CanvasGraph, TranscriptMessage } from '../src/index';
import { A, B, readTree, sampleGraph, tmpDir } from './helpers';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/cli/fixtures/transcript.json');

async function fixtureGraph(): Promise<CanvasGraph> {
  const raw = JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as { messages: TranscriptMessage[] };
  let t = Date.UTC(2026, 8, 11, 9, 0, 0);
  return linearGraph('masterarbeit', raw.messages, () => (t += 1000));
}

async function roundTrip(graph: CanvasGraph): Promise<{ rootA: string; rootB: string }> {
  const rootA = await tmpDir();
  const rootB = await tmpDir();
  await writeCanvas(graph, rootA);
  const { canvases, repairs } = await readVault(rootA);
  expect(repairs).toEqual([]);
  await writeCanvas(canvases[0]!, rootB);
  return { rootA, rootB };
}

describe('vault round-trip (M1 done condition)', () => {
  it('write → read → write is byte-identical for the sample graph', async () => {
    const { rootA, rootB } = await roundTrip(sampleGraph());
    expect(await readTree(rootB)).toEqual(await readTree(rootA));
  });

  it('write → read → write is byte-identical for the M0 fixture', async () => {
    const { rootA, rootB } = await roundTrip(await fixtureGraph());
    const tree = await readTree(rootA);
    expect(tree.size).toBe(6); // 5 nodes + canvas
    expect(await readTree(rootB)).toEqual(tree);
  });

  it('re-writing a freshly read vault touches nothing', async () => {
    const root = await tmpDir();
    await writeCanvas(await fixtureGraph(), root);
    const old = new Date('2020-01-01T00:00:00Z');
    const before = await readTree(root);
    for (const rel of before.keys()) await fs.utimes(path.join(root, rel), old, old);
    const { canvases } = await readVault(root);
    await writeCanvas(canvases[0]!, root);
    for (const rel of before.keys()) expect((await fs.stat(path.join(root, rel))).mtime).toEqual(old);
  });

  it('survives rename + move + user text node + lost canvas, converging after one write', async () => {
    const rootA = await tmpDir();
    const g = sampleGraph();
    await writeCanvas(g, rootA);
    // user activity in Obsidian:
    await fs.rename(path.join(rootA, g.paths.get(A)!), path.join(rootA, 'masterarbeit', 'nodes', 'Frage.md'));
    await fs.mkdir(path.join(rootA, 'masterarbeit', 'nodes', 'archiv'));
    await fs.rename(path.join(rootA, g.paths.get(B)!), path.join(rootA, 'masterarbeit', 'nodes', 'archiv', 'antwort.md'));
    const canvasPath = path.join(rootA, 'masterarbeit', 'graph.canvas');
    const canvas = JSON.parse(await fs.readFile(canvasPath, 'utf8'));
    canvas.nodes.push({ id: 't1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 });
    await fs.writeFile(canvasPath, JSON.stringify(canvas));

    const first = await readVault(rootA);
    expect(first.repairs.map((r) => r.kind).sort()).toEqual(['path-repaired', 'path-repaired']);
    expect(first.canvases[0]!.nodes).toEqual(g.nodes);
    await writeCanvas(first.canvases[0]!, rootA); // persists the repairs

    const second = await readVault(rootA);
    expect(second.repairs).toEqual([]);
    expect(second.canvases[0]!.paths.get(A)).toBe('masterarbeit/nodes/Frage.md');
    expect(second.canvases[0]!.paths.get(B)).toBe('masterarbeit/nodes/archiv/antwort.md');
    expect(second.canvases[0]!.foreign.nodes).toEqual([{ id: 't1', type: 'text', text: 'Randnotiz', x: 500, y: 0, width: 200, height: 100 }]);

    // and the lost-canvas case rebuilds layout deterministically
    await fs.unlink(canvasPath);
    const third = await readVault(rootA);
    expect(third.canvases[0]!.nodes).toEqual(g.nodes);
    await writeCanvas(third.canvases[0]!, rootA);
    expect((await readVault(rootA)).repairs).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify**

Run: `pnpm --filter @chatmind/core test`
Expected: all round-trip tests PASS on the first run — every piece is already in place. If one fails, that is a real defect in an earlier task: fix it there (with its own test), not by loosening this test.

- [ ] **Step 4: Full verification**

Run: `pnpm test && pnpm typecheck`
Expected: all packages green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/test/roundtrip.test.ts
git commit -m "test(core): vault round-trip byte-equality (M1 done condition)"
```

---

### Task 14: CLI `check` command and README

**Files:**
- Create: `apps/cli/src/check.ts`
- Modify: `apps/cli/src/index.ts`, `README.md`

**Interfaces:**
- Consumes: `readVault`, `resolveDataDir` from `@chatmind/core`.
- Produces: `check(dataDir?: string): Promise<number>` — prints a one-line summary per canvas and one line per repair; exit code 0 when there are no repairs, 3 otherwise. CLI entry `pnpm cli check [--data-dir <path>]`.

- [ ] **Step 1: Implement**

`apps/cli/src/check.ts`:
```ts
import { readVault, resolveDataDir, type Repair } from '@chatmind/core';

function describe(r: Repair): string {
  switch (r.kind) {
    case 'unparseable-node':
      return `unparseable node   ${r.path} — ${r.reason}`;
    case 'defaulted-field':
      return `defaulted field    ${r.id} → ${r.field}`;
    case 'duplicate-id':
      return `duplicate id       ${r.id} kept ${r.kept}, ignored ${r.dropped}`;
    case 'canvas-missing':
      return `canvas missing     ${r.canvas}/graph.canvas`;
    case 'canvas-corrupt':
      return `canvas corrupt     ${r.canvas}/graph.canvas — ${r.reason}`;
    case 'path-repaired':
      return `path repaired      ${r.id}: ${r.from} → ${r.to}`;
    case 'canvas-id-repaired':
      return `canvas id repaired ${r.canvasNodeId} → ${r.id}`;
    case 'orphan-canvas-node':
      return `orphan canvas node ${r.canvas}: ${r.canvasNodeId} → ${r.file}`;
    case 'layout-missing':
      return `layout missing     ${r.id}`;
    case 'dangling-parent':
      return `dangling parent    ${r.id} → ${r.parent}`;
    case 'edge-mismatch':
      return `edge mismatch      ${r.canvas}: ${r.detail}`;
  }
}

export async function check(dataDir?: string): Promise<number> {
  const root = resolveDataDir(dataDir);
  const { canvases, repairs } = await readVault(root);
  console.log(`data dir: ${root}`);
  for (const c of canvases) console.log(`canvas ${c.slug}: ${c.nodes.size} nodes, ${c.foreign.nodes.length} foreign canvas nodes`);
  if (repairs.length === 0) {
    console.log('no repairs needed');
    return 0;
  }
  console.log(`${repairs.length} repair(s) — applied in memory, written on next save:`);
  for (const r of repairs) console.log(`  ${describe(r)}`);
  return 3;
}
```

Add to `apps/cli/src/index.ts` — import `check` and a new `switch` case before `default`:
```ts
import { check } from './check';
// …
    case 'check':
      return check(dataDir);
```

- [ ] **Step 2: Verify manually against the real data folder**

Run: `pnpm cli check`
Expected: `data dir: /Users/<user>/Documents/chatmind`, `canvas masterarbeit: 5 nodes, 0 foreign canvas nodes`, `no repairs needed`, exit 0. (If Task 9 left Obsidian's re-save in place and it reformatted something, `check` still reports no repairs — formatting is not a repair.)

Then rename one node file in Finder or Obsidian and run `pnpm cli check` again.
Expected: one `path repaired` line, exit 3.

- [ ] **Step 3: Write the README**

Replace `README.md`:
```markdown
# chatmind

Non-linear chat over an Obsidian vault: every message is a node on a canvas, replies can branch from any node, branches can be merged. Storage is a plain folder that Obsidian opens as a vault.

Status: cycle 1 (vault writer + reader). No UI yet.

## Setup

```bash
nvm use            # Node 22
pnpm install
pnpm test
```

## CLI

```bash
pnpm cli import-transcript apps/cli/fixtures/transcript.json --canvas masterarbeit
pnpm cli check
```

The data folder is `~/Documents/chatmind` (override with `--data-dir` or `CHATMIND_DATA_DIR`). Open it in Obsidian with "Open folder as vault".

## Docs

- Design: `docs/superpowers/specs/2026-09-11-chatmind-vault-format-design.md`
- Plans: `docs/superpowers/plans/`
```

- [ ] **Step 4: Full verification and commit**

Run: `pnpm test && pnpm typecheck`
Expected: green.

```bash
git add -A
git commit -m "feat(cli): check command reporting vault repairs; README"
```

---

## Self-review against the spec

- §3.2 spec-pure canvas → Task 4 emits only spec keys; foreign content is passed through, never augmented.
- §3.3 identity via ULID; writer never renames → Task 7 (`paths` respected, tested), Task 11 (path repair by id).
- §3.6 `parents` authoritative → Task 4 `derivedEdges`, Task 12 `checkEdges` reports only.
- §5 repo layout → Tasks 1, 8.
- §7 model incl. `canvas-id-repaired` → Task 3 types, Task 11.
- §8.1/8.2 canonical node file and filename → Tasks 2, 3 (unit + property tests).
- §8.3 canvas format, Obsidian-style, verified manually → Task 4, Task 9.
- §9 reader steps 1–5, never throws, never writes → Tasks 10–12.
- §10 writer: byte-diff, atomic, never delete → Task 7.
- §11 CLI both commands, data-dir resolution, abort on existing canvas → Tasks 6, 8, 14.
- §12 tests: unit, property, integration scenarios (rename, move, lost canvas, corrupt frontmatter, text node, node without canvas entry, merge node via `derivedEdges`, dangling parent), round-trip, manual gate → Tasks 3, 4, 10–13, 9.
- Type names used consistently: `CanvasGraph.paths/layout/foreign`, `Repair` kinds, `CanvasFileNode`, `CanvasPass`, `ReadResult`, `sortedNodes`, `placeholderLayout`, `nodeFileName(id, summary)`.
