# chatmind M14 — A new strand starts next to its topic

Date: 2026-09-25. Builds on M3 (placement), M5 (embeddings), M6 (topics). The user asked: when a new strand is started (nothing in context), place it next to an existing topic it fits, instead of at the far right.

## Decisions

| Topic | Decision |
|---|---|
| When | Only a new root message (`parentIds: []`). Replies and merges keep `placeChild`. |
| Timing | At send, before the user node is written — the layout logic never moves an existing node afterwards (cycle-1 §3), so waiting for the indexer's topic is not an option. |
| Which topic | The server embeds the typed text (same embedder and truncation as the indexer; images are left out), centres it with the vault mean (`MIN_CENTER` as in M6), and runs the indexer's own `assignTopic` against the canvas's topic centroids with no parent topic. Only an `assign` counts. A bare question is a weaker signal than the question + answer the indexer judges (the pandas join question: 0.32 to its topic, below `T_ASSIGN = 0.35`), so placement has its own bar: best ≥ `T_PLACE = 0.25` with `PLACE_MARGIN = 0.08` daylight. Calibrated on the user's pandas canvas with 14 questions: fitting ones 0.26–0.56 (margin ≥ 0.09) are placed, unrelated ones reach at most 0.21; very short or jargon questions ("loc vs iloc") carry too little signal. *Amended the same day (gate: the user's "was ist das titanik turorial?" scored 0.12 and went to the far right):* such an unclear case goes to the **judge** (below). |
| Judge | When the embedding is unclear (or unavailable), the summary model (`reasoning.effort = 'minimal'`, `maxOutputTokens: 200`) gets `PLACE_SYSTEM` — "the same specific subject, not merely the same field; the question may be short or misspelled, read it charitably; reply with a listed topic name or NONE" — and `placePrompt`: up to 8 topics, closest first, with two example summaries each, then the question. `parseJudgement` accepts only a listed name (folded like topic names); NONE or anything else → old placement. Timeout `JUDGE_TIMEOUT_MS = 3000`. Checked on the pandas canvas with 12 questions: 12 of 12 right (the typo question, "loc vs iloc", Excel import, Titanic features/ages to their topics; overfitting, transformers, spas, Python install, a poem → NONE). Latency before the card appears: ~0.4 s when the embedding decides, ~1.4–2 s with the judge. |
| Where | `densestStrand` picks the topic's cards in the strand (root) that holds most of them (tie: the newest), so a topic spread over several strands anchors where most of it lives; `placeNear(graph, ids)` (core, pure) then works over the layouts of those cards: first right of their rightmost edge at the height of their top card; else below their lowest card in their leftmost column, moving down a row at a time. A slot counts only if its lane — the slot and `LANE_ROWS` rows below it — overlaps nothing, so the strand has room to grow. |
| Fallbacks | No indexer (no OpenRouter key, `--no-index`), a canvas without topics, an empty text (images only), the judge saying NONE, being slow or failing → `placeChild(graph, null)` as before. An embedding that fails, is slow (`EMBED_TIMEOUT_MS = 2000`) or has the wrong dimension, or a missing `index.db`, skips straight to the judge. `TopicPlacer.pick` never throws; the send never fails because of placement. |
| Topic | The placement does not write a topic. The indexer assigns it later as always (question + answer); in rare borderline cases it can differ from the one the placement used. |
| Lock | The topic decision (embedding, maybe the judge) runs before the vault lock on a freshly read canvas; inside the lock only the slot is computed, on the fresh graph (a topic that vanished meanwhile leaves no cards → old placement). |
| Camera | Unchanged: after `assistant-start` the browser fits the new question and answer, wherever they landed. |

## Verification

A replay on a copy of the user's vault (topics reassigned, real embedder): a pandas join question started right of "Pandas Befehle", a Kaggle GPU question right of "Kaggle Einstellungen" at that topic's top row, a question about spas at the far right as before. After the judge: "was ist das titanik turorial?" right of the Kaggle Titanic strand, "Was ist Overfitting?" at the far right.

## Tests

Core: `densestStrand`; `placeNear` right of the topic, below when the right is taken, further down when below is taken, `null` without layouts. Server: `TopicPlacer.pick` — a clear embedding decides without the judge; an unclear one asks the judge (closest topics first, examples); NONE, unlisted, slow, failing or no judge → `null`; a failing, slow or mismatched embedding or no index still asks the judge; empty text or no topics call nothing. `placePrompt`, `parseJudgement`. A root send lands next to the topic's cards, a reply never asks the placer, `null` keeps the old placement.
