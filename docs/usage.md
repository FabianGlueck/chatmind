# Using chatmind

A reference for the browser UI. For setup see the [README](../README.md); for the indexer behind summaries, topics, links and memories see [indexing.md](indexing.md).

## Keyboard

↑↓←→ move between nodes, Space add/remove the node as a merge target (or exclude a highlighted ancestor), Enter → composer, ⏎ send / ⇧⏎ newline, Esc clear selection / back to graph, ⇧⇥ + ←→ change model. ⇧-click adds a target with the mouse.

## Arranging and deleting

Drag a card to move it; ⌘-click (Ctrl elsewhere) or ⌘-drag on the empty canvas builds a move selection that drags together. Delete/Backspace (or "Delete turn" in the panel) removes the cursor's turn — question and answer together — or every turn in the move selection, after a confirmation. The files go to `<data-dir>/.trash/`; whatever hung below the turn is reconnected to what was above it. Positions are written to `graph.canvas` (x/y only), so Obsidian shows the same layout. A card that is still streaming cannot be moved or deleted.

## Chat view

Press V (or use the Canvas | Chat switch) to read the cursor's strand as a plain chat — root to cursor, then on to the end along the branch you last took there (otherwise the newest). ‹ 1/2 › and ←/→ switch branches at a fork, ↑/↓ walk the strand, merged-in branches sit as collapsed blocks before the merge message. Cursor, merge targets, composer and all keys are shared with the canvas; the view is kept in the URL (`view=chat`).

## Images

Paste a screenshot into the composer (⌘V), drop image files onto it or pick them with 📎 — PNG, JPEG, GIF or WebP, at most 6 per message; large images are scaled down to 2048 px in the browser. They are written to `<canvas>/attachments/<ULID>.<ext>` and embedded at the end of the question as `![[<ULID>.png]]`, so Obsidian shows them too. Every later message in that strand sends them to the model again (≈ 1.6k tokens each in the counter). Attachment files are never deleted: after a delete or compress they stay in `attachments/`.

## New strands next to their topic

A new root message (nothing selected) that clearly belongs to a topic of the canvas starts right of that topic's cards (or below them, when the right is taken) instead of at the far right. The server embeds the question when it is sent (with the indexer on) and compares it with the topic centres; when that is unclear — short or misspelled questions — the summary model decides from the topic names and examples (about 1–2 s before the card appears). A question that fits no topic, or a provider that is too slow, keeps the old placement. Nothing already on the canvas moves.

## Topic memories

With the indexer on, every topic of a canvas gets a memory — short bullets with the facts and decisions from its turns (about you, your project, what was settled), in `<canvas>/memories/<topic>.md`, visible in Obsidian. The indexer only ever appends to it; edit it freely in the right panel (the memory of the selected card's topic, or of the active topic) or in Obsidian. In the composer, the memory of the reply target's topic is preselected as part of the system prompt (✕ to drop it, "+ Memory" to add another topic's); a new strand starts without. `pnpm cli index status` shows memories and pending ones.

## Context

What the model sees is the strand from the root to the reply target, plus any merge targets. Those cards are marked *in context* and joined by a dashed thread; every other card steps back. Each context card shows its approximate token count, and the composer shows the total against the model's context window. Space on a highlighted ancestor excludes it from the context.

## Merging

Select several cards as targets (Space or ⇧-click) and send: the new question gets all of them as parents, and the model sees every branch.

## Topic map

Zoom far out and the canvas turns into a map: each topic's cards are covered by a coloured area with the topic name over it. Click a label to zoom into that area.

## Compressing a strand

On a card inside an unbranched stretch of at least two turns, "Compress strand" in the panel has a model rewrite the stretch as at most half as many turns. The new cards take the old ones' place; the originals go to `<data-dir>/.trash/`.

## Notes

"+ Note", ⌘V on the canvas, or dropping a `.md`/`.txt` file creates a note: text that sits on the canvas without being sent to a model. Reply to a note to ask about it, or merge it into an existing strand.

## Editing cards

Every card — question, answer or note — can be edited by hand in the panel or the chat view (the old text is overwritten, not kept). In the composer's **Edit** mode (or with E) you tell the model what to change instead; its rewrite streams into a preview that is written only when you accept it. A card's title (its summary) is editable in the panel as well.
