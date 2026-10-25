# chatmind M17 — Editing cards, by hand and with the model

Date: 2026-10-04. From the user ("ich will, dass ich einzelne zettel bearbeiten kann … sowohl manuell, also wie so ein markdown editor. aber auch mit dem LLM … eine nachricht / zettel markieren können und dann einen modus haben, bei dem ich dem chatfenster sagen kann, was er daran verändern soll"). Builds on M4 (context), M9 (chat view), M12 (token meter), M15 (PUT with `base`), M16 (note editor).

Decided with the user: **every** card is editable — question, answer and note. An edit rewrites the card **in place, without keeping the old text** (no copy in `.trash/`). A model edit streams into a **preview** that the user accepts or discards; only accepting writes. The model sees the card **and the strand above it** (the same context a reply to the card's parents would get).

## 1. Decisions

| Topic | Decision |
|---|---|
| What is editable | The body of any node (`user`, `assistant`, `note`). Nothing else: `parents`, `role`, `model`, `created`, `topics` and the layout stay. |
| Old text | Overwritten. Not copied anywhere — the user's choice; Obsidian's own file recovery / git are the safety net. |
| Below the card | Untouched. Answers below an edited question keep hanging under it, even if they no longer match; the next send sees the new text. |
| Summary, embedding, topic | The indexer's existing rules: the body hash changes, so the embedding is redone, and the summary too if it is still ours (`summary_for_hash`). `topics` stay (the indexer only writes them when empty). The file is not renamed again (rename-once). |
| Memories (M15) | Untouched. A turn already distilled stays in `covered`; what was distilled from its old text stays in the memory until the user edits it. |
| Images (M13) | A user body's `![[<ULID>.<ext>]]` embeds are plain text to the editor. Removing one leaves the file in `attachments/` (never deleted), as for a deleted node. |
| While streaming | A card whose answer is still streaming — the assistant node and its question — cannot be edited (409). |
| Model edit target | Exactly one card: the cursor. Merge targets play no part in edit mode. |

## 2. Manual editing

- **Panel.** Every card in the panel gets an "Edit" button (pencil, next to compress/delete). It opens the existing note editor — generalised from `NoteEditor` to `NodeEditor` — a Markdown textarea with Save (⌘Enter) / Cancel (Esc). 409 → "The card changed meanwhile" and the current text is shown, as for notes and memories today. Empty after trim → "A card cannot be empty — delete it instead."
- **Chat view.** Each message gets the same Edit action in its hover actions; the textarea replaces the message body in place (the panel may be folded there, see the double-click change).
- Rendering after save is the normal path: the PUT returns the `NodeDto`, the canvas state updates, the watcher event refetches.

## 3. Model editing

### 3.1 The mode

- The composer gets a mode switch **Reply | Edit** (a small segmented control next to the model picker). **E** on the canvas/chat (same key scope as Enter) switches to Edit and focuses the textarea; Esc in an empty edit-mode composer goes back to Reply.
- In Edit mode the composer header reads "Edit: <card title>" instead of the target chips, the placeholder is "What should change?" (DE: „Was soll sich ändern?“ — follows `detectLanguage`), and the send button reads "Rewrite". Image attach is disabled. Memories are not offered.
- The token meter counts the edit prompt (§3.3) through the same core function as the server.

### 3.2 The preview

- Sending streams the new text into a **preview box** that sits above the composer (so it works in both views and with the panel folded). It shows the new text rendered as Markdown, with a "Changes" toggle that shows a word diff against the current body (`diffWords` from the `diff` package — new dependency in `apps/web` only).
- Buttons: **Accept** (⌘Enter) → `PUT /nodes/:id` with `base` = the body the edit started from; **Discard** (Esc); **Edit by hand** → opens the manual editor (§2) pre-filled with the preview text, same `base`.
- **Refine:** while a preview is open the composer stays in Edit mode; another instruction rewrites *the preview* (not the original) — the request carries the preview text as `draft`. `base` stays the original body, so Accept still checks against what the file held when the edit started.
- 409 on Accept → the preview stays, with "The card changed meanwhile — discard, or accept to overwrite the new version" and an Overwrite button that re-sends with the new `base`.
- Switching canvas or moving the cursor to another card discards an open preview (with no confirm; it was never written).

### 3.3 Context and prompt

New in core (`packages/core/src/edit.ts`), shared by browser and server:

```ts
export function buildEditContext(graph: GraphLike, id: NodeId, instruction: string, draft?: string): BuiltContext
```

- Context = `buildContext(graph, node.parents, [], <edit request>)` — the strand above the card exactly as a reply to its parents would see it (a merge question's blocks included). A root (a note, a first question) has no context.
- The edit request is the last user message:
  ```
  <EDIT_HEADER[lang] with the role label>

  <<<
  <draft ?? body>
  >>>

  <instruction>
  ```
  `EDIT_HEADER = { de: 'Überarbeite diese {role} nach der Anweisung unten. Antworte nur mit dem neuen Text — ohne Vorrede, ohne Begleitkommentar, ohne die <<< >>> Marker.', en: 'Rewrite this {role} following the instruction below. Reply with the new text only — no preamble, no comments, no <<< >>> markers.' }`, `{role}` = question / answer / note (DE: Frage / Antwort / Notiz).
- The system prompt is the normal one (no memories).
- `promptTokens` on the result drives the meter; nothing else to count.

## 4. Server

- **`PUT /api/canvases/:slug/nodes/:id`** `{ body, base }` — as M16, but for every role. 409 also when the node or its question is in `inFlight`. Limit `MAX_NOTE_CHARS` for every role (renamed `MAX_BODY_CHARS`; the old name stays exported as an alias). An unchanged body is not written.
- **`POST /api/canvases/:slug/nodes/:id/rewrite`** `{ instruction: string, model: string, draft?: string }` → SSE: `delta { text }`, then `done { text }` or `error { message, partial }`. Writes **nothing**. Validation as for a send (unknown/unavailable model 400, empty instruction 400, unknown node 404, streaming card 409). The stream is tied to the HTTP request (unlike a send, there is nothing to persist if the client goes away): an abort stops the model call.
- The rewritten text is `normalizeBody`-ed and stripped of a leading/trailing `<<<` / `>>>` line if the model echoed them anyway.

## 5. Invariants (CLAUDE.md amended)

- Replace "a note's body is the only node body rewritten after creation, and only by the user's edit" with: **a node's body is rewritten after creation only by the user's edit (PUT with a `base` check) — typed by hand or a model rewrite the user accepted.** Nothing else rewrites a body; a model rewrite never writes on its own.
- `role: assistant` ⇒ exactly one parent: unchanged (an edit never touches `parents`).
- The edit header and the edit placeholder join the list of strings that follow `detectLanguage`.

## 6. The title (summary), by hand

Added 2026-10-05 at the user's request ("ich will auch die zusammenfassung, also das was als titel auf der karte angezeigt wird, manuell bearbeiten können").

- **Panel.** The heading is its own button ("Edit title"): a click turns it into a one-line input. Enter or leaving the field saves, Esc cancels. Not while the card streams.
- **Rules.** One line (`cleanSummaryInput`: whitespace runs → one space, trimmed), at most `MAX_SUMMARY_CHARS = 250` (the indexer's `SUMMARY_MAX`). **Empty** clears the summary, so the indexer writes a new one.
- **Indexer.** Unchanged: it re-summarises only an empty summary or one that is still its own (`summary_written`). A typed summary is not its own, so a later body edit leaves it as it is; clearing it brings the automatic one back. A file not yet renamed gets its slug from the typed summary (rename-once as always).
- **Server.** `PUT /api/canvases/:slug/nodes/:id/summary` `{ summary, base }` → 200 `NodeDto`; `base` = the summary the edit started from, 409 `{ error: 'the summary changed meanwhile', summary }` if the file differs; 409 while streaming; 400 wrong types / too long; 404. Writes only `summary`; an unchanged one is not written.
- **Invariant.** The user's edit (PUT with a `base` check) joins the indexer as a writer of `summary`.

## Tests

Core: `buildEditContext` for an answer (its question in the context, the answer in the request), a question under a merge, a root note (no context), with `draft`; DE/EN headers. Server: PUT for user/assistant/note, 409 on changed base, 409 while streaming, 400 empty/too large; rewrite streams deltas and `done`, writes no file, 404/400/409, abort stops the call, marker stripping. Web: Edit button opens the editor for a question and an answer; save/409; E switches the composer to Edit mode and Esc back; Rewrite shows the preview, Accept PUTs with the original `base`, Discard writes nothing, refine sends `draft`, cursor move discards. Look and the diff toggle at the manual gate.
