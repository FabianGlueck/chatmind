# Contributing to chatmind

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and suggesting features

Open an [issue](https://github.com/FabianGlueck/chatmind/issues/new/choose). For bugs, include your OS, Node version, the provider/model you used, and the steps to reproduce. Never paste API keys or private conversations — a minimal canvas made up for the report is best.

## Development setup

```bash
nvm use              # Node 22.22+ (see .nvmrc)
pnpm install
pnpm dev             # API on :3210 + Vite on :5173
```

Point the server at a throwaway vault while you work so your own data stays untouched:

```bash
pnpm --filter @chatmind/server dev --data-dir /tmp/chatmind-dev --no-index
```

Before every commit:

```bash
pnpm typecheck && pnpm test
```

## Project layout

| Package | |
|---|---|
| `packages/core` | Pure logic: graph, context assembly, vault reader/writer |
| `packages/index` | Background indexer (summaries, embeddings, topics, links, memories) |
| `apps/server` | Hono API, SSE streaming via the Vercel AI SDK |
| `apps/web` | Vite + React 19 + @xyflow/react |
| `apps/cli` | Import, check and indexer diagnostics |

## Ground rules

chatmind treats the user's vault as the source of truth, so a few invariants are non-negotiable — breaking one would require a vault migration. They are listed in [`CLAUDE.md`](CLAUDE.md) and specified in [the vault format design](docs/superpowers/specs/2026-09-11-chatmind-vault-format-design.md). In short:

- Files are the truth; anything in SQLite is derived and disposable.
- `graph.canvas` stays pure JSON Canvas 1.0 — no custom keys.
- Identity is the ULID in frontmatter, never the filename; `parents` in frontmatter is the only source of structure.
- Nothing in the vault is deleted — removed turns move to `.trash/`.
- API keys never go into the data folder or the repo.

Please open an issue before a change that touches the vault format.

Code conventions:

- `apps/web` imports runtime code only from `@chatmind/core/graph` (the browser-safe entry).
- `@chatmind/index` has no network dependency; LLM and embedding calls are injected.
- Browser and server share the same core functions for context assembly — never reimplement them on one side.
- Compact TypeScript, doc comments that cite the spec section, tests first. There is no ESLint/Prettier; match the surrounding code.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(web): …`, `fix(server): …`).

Larger features follow the same path as the existing milestones: a short design spec in `docs/superpowers/specs/`, then the implementation. For a big change, opening an issue first to agree on the design saves everyone time.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
