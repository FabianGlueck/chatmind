# chatmind

Non-linear chat over an Obsidian vault: every message is a node on a canvas, replies can branch from any node, branches can be merged. Storage is a plain folder that Obsidian opens as a vault.

Status: personal project, under active development (milestone M17 — editing cards). Expect rough edges; the vault format is stable (see the design spec).

Requirements: Node 22.22+, pnpm, and an API key for at least one of Anthropic, OpenAI or OpenRouter. Obsidian is optional — it is only needed to browse the vault outside the app.

## Setup

```bash
nvm use            # Node 22.22+ (see .nvmrc)
pnpm install
pnpm test
```

## Run

```bash
pnpm dev             # API on :3210 + Vite on :5173 — open http://localhost:5173
pnpm build && pnpm start   # single process on :3210 serving the built frontend
```

Keyboard: ↑↓←→ move between nodes, Space add/remove the node as a merge target (or exclude a highlighted ancestor), Enter → composer, ⏎ send / ⇧⏎ newline, Esc clear selection / back to graph, ⇧⇥ + ←→ change model. ⇧-click adds a target with the mouse.

Arranging and deleting (M8): drag a card to move it; ⌘-click (Ctrl elsewhere) or ⌘-drag on the empty canvas builds a move selection that drags together. Delete/Backspace (or "Delete turn" in the panel) removes the cursor's turn — question and answer together — or every turn in the move selection, after a confirmation. The files go to `<data-dir>/.trash/`; whatever hung below the turn is reconnected to what was above it. Positions are written to `graph.canvas` (x/y only), so Obsidian shows the same layout. A card that is still streaming cannot be moved or deleted.

Chat view (M9): press V (or use the Canvas | Chat switch) to read the cursor's strand as a plain chat — root to cursor, then on to the end along the branch you last took there (otherwise the newest). ‹ 1/2 › and ←/→ switch branches at a fork, ↑/↓ walk the strand, merged-in branches sit as collapsed blocks before the merge message. Cursor, merge targets, composer and all keys are shared with the canvas; the view is kept in the URL (`view=chat`).

Images (M13): paste a screenshot into the composer (⌘V), drop image files onto it or pick them with 📎 — PNG, JPEG, GIF or WebP, at most 6 per message; large images are scaled down to 2048 px in the browser. They are written to `<canvas>/attachments/<ULID>.<ext>` and embedded at the end of the question as `![[<ULID>.png]]`, so Obsidian shows them too. Every later message in that strand sends them to the model again (≈ 1.6k tokens each in the counter). Attachment files are never deleted: after a delete or compress they stay in `attachments/`.

New strands next to their topic (M14): a new root message (nothing selected) that clearly belongs to a topic of the canvas starts right of that topic's cards (or below them, when the right is taken) instead of at the far right. The server embeds the question when it is sent (with the indexer on) and compares it with the topic centres; when that is unclear — short or misspelled questions — the summary model decides from the topic names and examples (about 1–2 s before the card appears). A question that fits no topic, or a provider that is too slow, keeps the old placement. Nothing already on the canvas moves.

Topic memories (M15): with the indexer on, every topic of a canvas gets a memory — short bullets with the facts and decisions from its turns (about you, your project, what was settled), in `<canvas>/memories/<topic>.md`, visible in Obsidian. The indexer only ever appends to it; edit it freely in the right panel (the memory of the selected card's topic, or of the active topic) or in Obsidian. In the composer, the memory of the reply target's topic is preselected as part of the system prompt (✕ to drop it, "+ Memory" to add another topic's); a new strand starts without. `pnpm cli index status` shows memories and pending ones.

## API keys

chatmind reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY` from the environment, falling back to `~/.config/chatmind/env` (the file name is `env`, not `.env`; one `KEY=VALUE` per line). At least one is needed to chat; the composer lists only models whose provider key is present. Keys never go into the data folder.

## Index (M5–M7)

With an `OPENROUTER_API_KEY` the server runs a background indexer: every node gets a short `summary` (1–3 sentences, ≤ 250 characters; the canvas cards show only this, the panel shows summary and full text)
(written into its frontmatter; the file is renamed once from `<ULID>.md` to `<ULID>-<slug>.md`) and an
embedding in `<data dir>/.app/index.db`. The database is derived and disposable — delete it (all three files:
`index.db`, `index.db-wal`, `index.db-shm` — the latter two are SQLite's write-ahead log and exist while
the server has the database open) and restart to rebuild. The browser follows every change on disk (including edits in Obsidian) through `/api/events`.

- Models: `CHATMIND_SUMMARY_MODEL` (default `openai/gpt-5.6-luna`), `CHATMIND_EMBED_MODEL`
  (default `openai/text-embedding-3-small`) and `CHATMIND_EMBED_DIM` (default `1536`), in the
  environment or `~/.config/chatmind/env`.
- `--no-index` (or `CHATMIND_NO_INDEX=1`) runs the server without the indexer; the watcher and
  `/api/events` stay on.
- `pnpm cli index status [--data-dir <path>]` reports per canvas how many nodes are embedded and
  summarized and what is pending — no network, no writes.
- A summary you edit by hand is never overwritten; a body you edit gets a new embedding and, if the
  summary was generated, a new summary.

### Topics (M6)

The same indexer gives every node exactly one **topic** — a short name in the frontmatter's `topics:`,
visible in Obsidian. A node is filed by the similarity of its embedding to the topics already on its
canvas, with a head start for the topic of its primary parent (`parents[0]`), so a chain that stays on
one subject keeps its topic; when nothing fits or two topics are equally close, the summary model names
the topic instead. The first node of a canvas always founds the first topic. Topics are per canvas and
are never re-assigned retroactively: the indexer only fills a `topics:` that is empty.

- **Correcting a topic:** edit `topics:` in Obsidian — your value is never overwritten. **Re-assigning:**
  blank it (`topics: []`) and the indexer assigns again on its next run, without re-embedding.
- User messages are judged together with their assistant reply (mean of both embeddings); a user node
  without a reply yet waits two minutes and is then judged alone. Waiting nodes show up as
  `pending topics` in `pnpm cli index status`.
- **In the browser:** each topic gets one of ten muted colours — a coloured left border and the topic
  name in the card header, the same colour on the panel's topic pill. The sidebar lists the canvas's
  topics with a colour dot and a node count; clicking one dims every other node and fits the camera to
  that topic's nodes. Click again or press `Esc` to turn the highlight off (`Esc` clears the highlight
  first, the selection on the next press). The highlight is purely visual — selection, composer targets
  and the LLM context are untouched.
- **Calibration:** `pnpm cli index topics --dry-run [--data-dir <path>]` replays the assignment
  read-only against the stored vectors — no network, no writes. It prints the vault's
  vector count, the embedding dimension and whether mean-centring is on (it needs 8 vectors), then per
  canvas its known topics, the number of candidates (nodes with an empty `topics:`) and how many are
  deferred, and per candidate a line
  `<node id> <role> parent <the primary parent's topic> | <top-3 topics with their cosine similarity> | → <decision>`,
  where the decision is `assign <topic>` (no model call) or `would ask [<candidates>]` (the namer would
  decide). It also prints the thresholds in force, so a dry run and the indexer can never disagree. Every candidate is judged against the topics already in the vault —
  the dry run does not simulate the topics a real run would found along the way, so a whole strand
  without topics shows up as `would ask`. This makes it a smoke test, not calibration, on a vault with
  no topics yet (nothing to compare against, so every line prints `(no topics) | → would ask []`); run
  it after topics exist — e.g. right after blanking a strand's `topics:` — to read real similarities.
- **Tuning:** four environment variables move the thresholds (defaults in brackets):
  `CHATMIND_TOPIC_INHERIT` [0.15] — how similar a node must be to its parent's topic to inherit it. This
  is the knob for granularity: raise it and strands break off into new topics sooner.
  `CHATMIND_TOPIC_INHERIT_MARGIN` [0.05] — how far the parent's topic may trail the best one and still win.
  `CHATMIND_TOPIC_ASSIGN` [0.35] — the similarity above which a topic is assigned without asking the model.
  `CHATMIND_TOPIC_ASSIGN_MARGIN` [0.10] — how far ahead of the runner-up that best topic must be.
  A value that is not a number, is empty, or lies outside `[-1, 1]` (or is negative for a margin) falls back
  to the default; the startup line names every threshold that differs, so a typo is visible. Set them in the
  environment or in `~/.config/chatmind/env` (`KEY=VALUE` per line, the same file as the API key) — the server
  and `index topics --dry-run` read both, environment first, so the dry run can never calibrate against
  different values than the indexer uses.
- **Re-assigning after tuning:** `pnpm cli index retopic --canvas <slug> [--data-dir <path>]` blanks
  `topics:` on exactly the nodes whose topic the indexer wrote (`topic_written` in `index.db`) and leaves
  yours untouched. It calls no model; the running indexer notices the change and assigns again. Set the
  environment and restart the server **first** — otherwise the still-running indexer re-assigns with the
  old values. Topics never change retroactively on their own, so this is the only way to re-cut a canvas.
- The first indexed run writes `topics:` into every node still at `topics: []`, and rewrites each such
  file's frontmatter down to the canonical eight keys (`id, canvas, role, model, parents, created,
  summary, topics`) — any other key you added in Obsidian is dropped. Check for extra frontmatter keys
  before the first indexed start if that matters to you.
- `index.db` from M5 migrates in place (schema 1 → 2 adds one column); embeddings and summaries are
  kept, nothing is re-embedded. Deleting `index.db` and restarting re-embeds the vault but changes
  **no** `summary:` and **no** `topics:` in it — the files are the truth.

### Semantic links (M7)

- **What:** select a node and chatmind shows the answers that are related to it by content but not by
  structure. Two answers are linked when each is among the other's `k` nearest (cosine over the
  mean-centred embeddings) and their *score* reaches a threshold. The score is the similarity corrected for
  hubs: an answer that resembles everything around it (common in a canvas where every note has the same
  theme) has its links discounted, so that only pairs that stand out survive. That correction applies only
  within a canvas: across canvases the plain similarity counts, because there the shared theme is what you
  want to be pointed to. The node's own ancestors and
  descendants never count, but siblings do. Only assistant answers take part; selecting a user message
  shows the links of its first answer.
- **In the browser:** links within the canvas are dashed magenta edges from the selected answer, fainter
  the weaker the link. The panel's **Related** section lists every link, other canvases included, with its
  score. Clicking an entry selects it, and one in another canvas opens that canvas on it. The
  browser's Back button returns to where you were, because every canvas switch (the sidebar's too) is now
  a history entry, and the URL carries `?canvas=…&node=…`.
- Nothing is stored. The server computes links per request from `index.db` over its own read-only
  connection, so they also work with `--no-index` as long as an index exists. A new answer gets links
  once it is embedded.
- **Calibration:** `pnpm cli index links --dry-run [--k <n>] [--min <score>] [--data-dir <path>]`
  prints every link in the vault once, grouped by canvas (`<score> (cos <raw similarity>)  <summary> ↔ <summary> [other canvas]`),
  and totals: links, participants, participants without a link, and links per participant. `--k` and `--min`
  try values without touching the environment.
- **Tuning:** `CHATMIND_LINK_K` [5], the number of nearest neighbours each side may have (at most that many
  links per answer), and `CHATMIND_LINK_MIN` [0.30], the minimum score. Set them in the environment or
  in `~/.config/chatmind/env`. Invalid values fall back to the default, and the startup line names any value
  that differs.

## CLI

```bash
pnpm cli import-transcript apps/cli/fixtures/transcript.json --canvas masterarbeit
pnpm cli check       # exit 0 = clean, 3 = repairs pending
pnpm cli index status [--data-dir <path>]
pnpm cli index topics --dry-run [--data-dir <path>]
pnpm cli index retopic --canvas <slug> [--data-dir <path>]
pnpm cli index links --dry-run [--k <n>] [--min <score>] [--data-dir <path>]
```

The data folder is `~/Documents/chatmind` (override with `--data-dir` or `CHATMIND_DATA_DIR`). Open it in Obsidian with "Open folder as vault".

## Docs

- Design: `docs/superpowers/specs/2026-09-11-chatmind-vault-format-design.md`
- M4 design: `docs/superpowers/specs/2026-09-13-chatmind-m4-merge-design.md`
- M5 design: `docs/superpowers/specs/2026-09-18-chatmind-m5-index-design.md`
- M6 design: `docs/superpowers/specs/2026-09-21-chatmind-m6-topics-design.md`
- Plans: `docs/superpowers/plans/`

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `pnpm typecheck && pnpm test`. Design decisions and invariants are documented in `docs/superpowers/specs/` and summarised in `CLAUDE.md` — changes that would break one of the vault invariants need a discussion first.

## License

[MIT](LICENSE) © 2026 Fabian Glück
