# chatmind M15 — Topic memories

Date: 2026-09-25. Builds on M5 (indexer), M6 (topics), M4 (context), M11 (compress). The user asked for "memories" per topic of a canvas, visible and editable in the right sidebar, that can be included as a system prompt when a new message is sent. Decided with the user: generated automatically and **append-only**; contents are **facts and decisions**; in the composer the memory of the reply target's topic is **preselected and can be deselected**, a new strand starts with none, any topic's memory can be added.

## 1. File format

One Markdown file per topic: `<canvas>/memories/<slug(topic)>.md`, visible and editable in Obsidian.

```markdown
---
topic: Kaggle Titanic Tutorial
covered: [01M3BV9TH9SQ6HV09KSTSWFSNF, 01M3BVBPW9V8Z0EXKRPSJYCS4M]
---

- Einsteiger in Data Science; arbeitet das Kaggle-Titanic-Tutorial durch.
- test.csv wird nie zum Training benutzt, aber identisch vorverarbeitet.
```

- **Identity** is `topic` in the frontmatter (as the ULID is for nodes), matched with `topicKey` (case, diacritics, `-`/`_` folded). The file name is only where a new file goes; a name collision gets `-2`, `-3`…
- **`covered`** lists the user-node ids of every turn already distilled into this memory — the truth about "already done" lives in the file, so deleting `.app/index.db` never duplicates bullets.
- The **body** is free Markdown; the indexer only ever appends to its end. A hand-written file (with `covered: []` or without `covered`) is adopted: the indexer appends facts from every turn of that topic.
- The reader skips `<canvas>/memories/` when scanning nodes (it reported them as unparseable nodes before) and reads the memories into `CanvasGraph.memories`. A file without a `topic` is ignored (reported as `unparseable-memory`). Two files for the same topic: the first by path wins, the other is reported (`duplicate-memory`).
- **Nothing is ever deleted or renamed**: a memory whose topic vanished (renamed in Obsidian, `retopic`) stays as it is; the new topic grows a new memory. The user can move bullets or change `topic:` by hand.

## 2. Generation (indexer, append-only)

A new phase after topics, per canvas, per topic:

- **Turn** = a user node with `topics[0] = T` and at least one assistant child with a non-empty body (the first, by id). A turn is **due** when its user-node id is not in `covered` of T's memory (or T has no memory yet).
- All due turns of a topic go into one `MemoryWriter` call (injected like `Summarizer`, implemented in `apps/server/src/index-providers.ts` with the summary model, `reasoning.effort = 'minimal'`, `maxOutputTokens: 1000`): the existing memory body, then the due turns in `created` order (question and answer, each cut to 3 000 characters).
- `MEMORY_SYSTEM` (fixed, English): extract only what stays true and matters for later conversations on this subject — facts about the user and their project, decisions, preferences, constraints, conclusions; not the course of the conversation, not general knowledge the model already has, nothing already in the memory. One short bullet per item (`- `), in the language of the conversation; reply `NONE` if nothing qualifies.
- `parseMemoryBullets(text)`: the lines that start with `- ` / `* ` / `•` / `–` or a number (`1.`, `2)`), normalised to `- `, at most `MAX_BULLETS = 8` per call. An explicit `NONE` → nothing to append, the turns are covered. *Amended 2026-09-25:* an answer with neither bullets nor `NONE` is a failure (retried), never a silent "nothing" that covers the turns for good.
- *Amended 2026-09-25 (gate: "Lokale Hugging-Face-Modelle" got an empty memory with all 9 turns covered):* the first `MEMORY_SYSTEM` said "leave out general knowledge"; on a topic of plain how-does-X-work questions the model answered NONE in 3 of 10 calls. The wording now asks for "the conclusions and concrete findings the conversation arrived at (the specific answer to what the user asked)" and leaves out only "generic background the user did not ask about"; NONE only if there is nothing of the kind at all. Same input: 0 of 10 NONE, 8 bullets on the findings (sizes per parameter, GGUF workflow, `model_type`…); the Kaggle settings topic unchanged (4–8 bullets).
- **Write** (one lock turn, `writeMemory`): re-read the memory file; append the bullets to the body (blank line before, if the body is not empty); add the turn ids to `covered` — also when there were no bullets, so a turn is judged once. A new memory is created at the slug path. Only `topic` / `covered` / body are written; bytes unchanged → no write.
- Failures count like the other phases (`MAX_FAILURES`, key `memory:<canvas>:<topicKey>`, hash = the due turn ids); `Report.memories` (bullets appended), `pending.memories` (topics still due) join the retry timer and `chatmind index status`.
- Cost: one call per topic with new turns per indexer run; backfill of an existing vault ≈ one call per topic.

## 3. Compress and delete

- **Compress (M11)**: the new turns replace old ones. For every memory of the canvas, a new user node whose covered old user nodes were **all** in `covered` is added to `covered` (the server does this after `replaceNodes`, same lock turn) — the compressed turns are not distilled a second time.
- **Delete (M8)**: memories are untouched; the facts stay (the user can edit them away).

## 4. Using memories (context)

- `buildContext(graph, targets, excluded, instruction, memories?)` — `memories: { topic, body }[]`; each non-empty one is appended to the system prompt:
  ```
  <SYSTEM_PROMPT>

  Memory of the topic "<topic>" — facts and decisions from earlier conversations on this canvas; rely on them where relevant:
  <body>
  ```
  Shared by browser (token meter) and server (the send), as every context function (CLAUDE.md).
- `SendRequest.memoryTopics?: string[]` — the server reads the memories from the files (not from the request), unknown topics are ignored.
- **Composer**: a row of memory chips under the target line. Defaults when the targets change: the topics (`topics[0]`) of the targets that have a memory, deduplicated; a new strand (no targets) starts with none. A chip's ✕ deselects it; "+ Memory" opens the list of the canvas's memories to add one. The token meter includes the selected memories.

## 5. Right sidebar

- **NodePanel**: below the body, a "Memory · <topic>" section for the node's topic: the memory as Markdown, "Edit" switches to a textarea with Save / Cancel. No memory yet → "No memory yet" and "Edit" creates one.
- **Topic active, no node selected** (M6 highlight): the panel shows that topic's memory with the same editor.
- **Save**: `PUT /api/canvases/:slug/memories` `{ topic, body, base }` — `base` is the body the editor started from; if the file's body changed meanwhile (indexer appended, Obsidian edit) → 409 and the panel says so and reloads. `covered` is kept; a new file starts with `covered: []`. An empty body is allowed (the file stays).
- Live: the watcher already reports `.md` changes in the canvas folder → the browser refetches, `CanvasDto.memories` updates.

## 6. DTO

`CanvasDto.memories: { topic: string; body: string; covered: number }[]`.

## 7. Invariants (CLAUDE.md amended)

The indexer additionally writes memory files under `<canvas>/memories/` — append-only to the body, plus `covered`; the user's PUT and the compress carry-over are the other writers. Memory files are never deleted or renamed.

## Verification

On a copy of the user's vault the indexer wrote a memory for every topic in one run (pandas: 4, hugginface: 3, …). "Kaggle Notebook Einstellungen" holds exactly the durable facts (account not phone-verified → no internet/GPU, persistence off, interest in code assistants); "Trainings- und Testdaten" the decisions (never train on test.csv, same preprocessing, validation split). "Kaggle Titanic Tutorial" also picked up some general description of the tutorial — the user trims such lines by hand. In the browser the panel shows the memory in the topic colour, the composer preselects the reply target's memory, and the token meter includes it.

## Tests

Core: parse/serialise memory files, the reader skips `memories/` and fills `graph.memories`, duplicates/unparseable reported; `buildContext` with memories (system prompt, tokens). Index: due turns per topic, one call per topic, append + covered, NONE covers without bullets, hand-written file adopted, failures, pending. Server: PUT (create, update, 409 on a changed base), send with `memoryTopics` puts the memory into the system prompt, compress carries `covered`. Web: composer chips (defaults from targets, deselect, add), panel section view/edit/save/409.
