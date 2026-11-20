# chatmind — Quick explanations

Date: 2026-11-14. From the user ("wie könnte ich eine schnelle verständnis frage zu einer antwort machen, also wenn ich z.B. nur ein wort nicht verstehe, aber das soll nicht direkt ein eigenständiger node werden?" → "gerne so umsetzen"). Not a roadmap milestone. No vault-format change.

## 1. Idea

A short explanation of one spot in a card, shown next to it and forgotten when closed. It is written to the vault only when the user keeps it.

## 2. UI

- Marking text inside one card body — the panel (`NodePanel`) or the chat view (`ChatView`), each marked with `data-explain-id` — shows a "?" next to the selection. Not on the canvas cards (marking there would fight with dragging), not in a card whose answer is still streaming, not across two cards, at most `MAX_EXPLAIN_SELECTION = 500` characters.
- "?" opens a popover: the marked text, the streamed explanation, a field for follow-ups (one level, each continues the exchange), "Keep as branch", "Keep as note". Esc or a click outside closes it and stops a running call. Changing the canvas closes it too.
- The model is the composer's current one.
- An explanation that was not kept never enters a later context: the context display would not show it.

## 3. Context (`buildExplainContext`, core)

The strand down to and including the card, as `buildContext(graph, [id], [], …)` builds it for a reply to that card, then one request: `EXPLAIN_HEADER[lang]`, `Spot: »<selection>«`, `In the sentence: »<passage>«` (left out when it equals the selection; the passage is the paragraph, list item or cell around the selection, at most `MAX_EXPLAIN_PASSAGE = 2000` characters) and the question (`EXPLAIN_DEFAULT[lang]` when none was typed). Follow-ups continue as assistant/user turns. The language follows the strand, the selection and the questions (`detectLanguage`).

## 4. `POST /api/canvases/:slug/nodes/:id/explain`

`{ selection, passage?, exchange: { q, a }[] (≤ 20), ask, model }` → SSE `delta` … `done { text }` / `error { message, partial }`, like the M17 rewrite (shared helper `streamPreview`). Writes nothing. `400` for an empty or too long selection, a malformed exchange, an unknown or unavailable model; `404` for an unknown canvas or node; `409` while the card's answer streams.

## 5. `POST /api/canvases/:slug/nodes/:id/explain/keep`

`{ selection, exchange: { q, a }[] (1–20, non-empty answers), model }` → `201 { nodes }`. Writes the exchange as turns below the card, without a model call: the first question is `»<selection>« — <question or EXPLAIN_DEFAULT>` (`explainQuestion`), follow-ups as typed; each answer is an assistant node with the given model and exactly one parent. Layout via `placeChild`. The browser adds the nodes and moves the cursor to the last answer.

"Keep as note" needs no endpoint: the browser creates a note (M16) from the marked text and the exchange.
