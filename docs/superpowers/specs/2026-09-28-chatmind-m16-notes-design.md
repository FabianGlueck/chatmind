# chatmind M16 — Notes on the canvas

Date: 2026-09-28. From `feature-ideen.md` ("inhalte auf den canvas legen, ohne dass sie direkt ans llm gehen … liegen erstmal nur da; man kann dann nodes andocken und fragen dazu stellen"). Builds on M3 (send, placement), M4 (context, merge), M8 (delete), M9 (chat view), M11 (compress), M12 (token chips), M15 (PUT with `base`).

Decided with the user: content is **text** — typed, pasted, or a dropped `.md`/`.txt` file (no PDFs, no images in this milestone); a note is created by a **"+ Note" button**, by **⌘V on the canvas** and by **dropping a file onto the canvas**; a note is **editable in the panel**.

## 1. Decisions

| Topic | Decision |
|---|---|
| What a note is | A node with `role: note` — its own file in `nodes/`, a file node in `graph.canvas`, visible in Obsidian like every message. It is created without parents (a root) and never gets an answer of its own: creating one calls no LLM. |
| Docking | A note is a reply target like any node. A question sent to it has the note as `parents[0]`, so the note enters that strand's context and every later turn's below it. To bring a note into an existing strand, the user merges (M4): note + answer as targets. Nothing else is needed — `validateTargets`, the ghost merge node and the highlight work unchanged. |
| Content | Markdown text, at most `MAX_NOTE_CHARS = 400_000` (≈ 100k tokens; server → 400 above). Must not be empty after trim. A dropped file's text becomes the body verbatim (its own frontmatter included); accepted are `.md`, `.markdown`, `.txt` and any `text/*` file. |
| Editing | Only a note's body is editable in chatmind. Answers already given stay as they are; the next send sees the new text. |
| Language | The note header in the prompt (§4) follows `detectLanguage` like the role labels. |

## 2. Vault format

```markdown
---
id: 01M4…
canvas: masterarbeit
role: note
parents: []
created: 2026-09-28T10:42:03Z
summary: ''
topics: []
---

The pasted text.
```

- `Role = 'user' | 'assistant' | 'note'`. Key order and all other rules as in spec §8.1; `model` is never written for a note.
- The reader accepts `role: note`; any other unknown role still defaults to `user` (`defaulted-field`), as before.
- A hand-edited note with parents is read as it is (structure is never deleted); chatmind only ever creates notes as roots.
- Filename, summary and rename-once as for every node (M5): `{ULID}.md`, later `{ULID}-{slug}.md`.

## 3. Server

- **`POST /api/canvases/:slug/notes`** `{ body: string, at?: { x, y } }` → 201 `NodeDto`. One lock turn: re-read, create the node (`parents: []`), layout, `writeNode` + `writeCanvasFile`. Layout: with `at`, `placeAt(graph, at)` — a `NODE_WIDTH × NODE_HEIGHT` card at `at` if it keeps `NODE_GAP / 2` clear of every card, else the nearest such spot on a half-card grid around it (nothing existing moves; the first probe put notes on top of the strand under the viewport centre); without `at`, `placeChild(graph, null)` (the next free root slot). Empty or oversized body, bad `at` → 400; unknown canvas → 404.
- **`PUT /api/canvases/:slug/nodes/:id`** `{ body: string, base: string }` → 200 `NodeDto`. Only for `role: note` (else 400). `base` is the body the editor started from; if the file's body differs → 409 (same as M15 memories). Writes only the body; `summary` and `topics` stay. Bytes unchanged → no write.
- The watcher already reports `.md` changes → the browser refetches as for any change.

## 4. Context

- `buildContext` renders a note as a **user message** with a header, never as a bare user turn:
  ```
  <NOTE_HEADER[lang]>

  <body>
  ```
  `NOTE_HEADER = { de: 'Notiz, die der Nutzer auf den Canvas gelegt hat (keine Nachricht an dich):', en: 'A note the user placed on the canvas (not a message to you):' }`.
- Adjacent user messages are **not** joined: the prompt already has them today (a user node as target is followed by the instruction, spec M3), so a note followed by its question is two user messages and every existing prompt stays byte-identical.
- In **merge blocks** a note renders as `**Notiz:** <body>` / `**Note:** <body>` (`ROLE_LABELS.note`). A block's label (`blockLabels`) is the note's summary or title as for any node.
- `promptTokens` needs no change: it counts what `buildContext` built, so the meter and the M12 chips include the header. Browser and server share the one function, as always.

## 5. The rest of the system

| Part | Behaviour |
|---|---|
| Delete (M8) | `turnOf(note) = [note]`. Questions docked to it keep their answers; `spliceOut` makes them roots (the note had no parents) — their strands lose the note from the context. The delete dialog shows this as for any node. |
| Compress (M11) | A note is never part of a turn, so `turnsAmong` skips it; it is never compressed. A run below a note keeps the note as the new first question's parent. |
| Indexer (M5/M6) | Summary and embedding as for every node; the summarizer sees `Written by: note (text the user placed on the canvas)`. After an edit the summary is redone if it is still ours (the existing `content_hash` rule). A note gets a topic like any node without an answer (its own vector; no `USER_WAIT_MS` wait — that is for questions awaiting their answer). |
| Memories (M15) | A note is not a turn; nothing is distilled from it. A question below it is, as before. |
| Semantic links (M7) | Notes join assistant nodes as link participants (their own vector), so a note shows related answers and appears as related to them. |
| Placement (M14) | Unchanged: it is for new strands started by a question; a note goes where the user put it. |

## 6. Web

- **Creating.** A "+ Note" button next to the `Canvas | Chat` switch opens a dialog with a textarea (Save = ⌘Enter, Cancel = Esc); the note lands at the centre of the viewport (canvas view) or at the next free root slot (chat view). **⌘V** while the canvas has focus (not the composer, not an input) creates a note from the pasted text at the pointer position if it is over the canvas, else the viewport centre; a paste with no text does nothing. **Dropping** one or more text files onto the canvas creates one note per file, side by side from the drop point (`NODE_WIDTH + NODE_GAP` apart, each then nudged to a free spot); other files are ignored with a short notice. After creating, the (last) new note becomes the cursor, so the composer targets it straight away.
- **Card.** A note card has its own look (`role-note`: paper colour, 📄 in the header instead of the role/model) and shows title and token chip like other cards.
- **Panel.** A note shows its body with an "Edit" button → textarea, Save / Cancel; 409 → "The note changed meanwhile" and reload, as the memory editor (reuse its component where it fits).
- **Chat view.** A note appears in the strand as a message with the `note` label and the same look.
- **Composer.** Unchanged. Targeting a note is targeting a node.

## 7. Invariants (CLAUDE.md amended)

- `role: note` is created without parents and never has an answer of its own.
- A note's body is the only node body chatmind rewrites after creation: the user's edit (PUT with a `base` check), nothing else.
- The note header joins the list of strings that follow `detectLanguage`.

## Tests

Core: `role: note` parses/serialises (no `model`), unknown roles still default; `buildContext` with a note in the chain, as direct target, inside a merge block; `placeAt`; `turnOf`/`spliceOut` with a note; `compressionSections` skips notes. Index: a note is summarised and gets a topic without waiting; links include notes. Server: POST (with/without `at`, empty, too large, 404), PUT (update, 409 on changed base, 400 for non-notes), a send targeting a note puts the header + body into the prompt. Web: "+ Note" dialog creates a note and sets the cursor; paste on the canvas creates one, paste in the composer does not; file drop creates one per text file; panel edit/save/409. Look, paste and drop at the manual gate.
