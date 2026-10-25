# chatmind M6 — Topics within a canvas

Date: 2026-09-21. Builds on the cycle-1 vault format spec (§3 invariants, §5 frontmatter `topics`, §13 M6, §14 traps) and the M5 index spec (reconcile loop, writeback, live channel). Brainstormed with the user; decisions below are theirs unless marked as defaults.

## 1. Goal and done condition

M6 gives every node one topic: a short name in `topics:` (frontmatter, visible in Obsidian), assigned by the indexer from the M5 embeddings. In the browser, topics colour the cards and a topic list in the sidebar highlights a topic's nodes — orientation on a large canvas. Topics are born automatically: a node that fits no existing topic makes the LLM name a new one. Once assigned, a topic never changes retroactively; the indexer only fills empty `topics`, so a topic set or corrected by hand is never overwritten.

**Done when**, on the user's own vault: every node with a body gets a topic; the topics are usable to the user (names and cuts — this is the threshold calibration, checked with the dry run first); cards are coloured and the topic list highlights; a topic set in Obsidian stays; blanking `topics: []` makes the indexer assign again; deleting `.app/index.db` and restarting changes **no** `topics:` in the vault; a vault round-trip stays byte-identical.

## 2. Decisions

| Topic | Decision |
|---|---|
| Purpose in M6 | Orientation (colour + label on the card) plus a small navigation aid (topic list, click highlights). Not filtering, not context. |
| Where topics come from | The indexer, automatically. An LLM names a new topic when nothing existing fits; the first node of a canvas founds the first topic. Corrections happen in the frontmatter (Obsidian), never through a browser UI (that would be a later milestone). |
| Cardinality | Exactly one topic per node. `topics` stays a `string[]` with one entry; all logic reads `topics[0]`, so multiple topics later extend the assignment, not the format. |
| Assignment | Centroid similarity on mean-centred vectors; the parent's topic gets a head start (structural prior); the LLM decides only when the similarities are ambiguous or nothing is close (roadmap: "centroid assignment with LLM tiebreak"). |
| Splits | The prior applies per child, not per sibling group: one child may stay in the parent's topic while the other founds a new one. |
| User nodes | Judged together with their assistant reply (mean of both vectors) — a topic change usually starts with a short question whose answer carries the content. Without a reply the node waits up to 2 minutes, then is judged alone. |
| Retroactive change | Never. Only nodes with empty `topics` are assigned (the trap in cycle-1 §14: no re-clustering). Existing vaults get topics in `created` order, so topics grow along the history. |
| Marking corrections | Like `summary`: the indexer never touches a non-empty `topics`, so a user's edit is respected without a marker in the file. SQLite remembers which topic *we* wrote (`topic_written`) for status and a later `retopic`. |
| Topic identity | The name string, scoped to the canvas (files are the truth — no topic table as a source). A near-duplicate name from the LLM is folded into the existing one (case/diacritics-insensitive). |
| Thresholds | Named constants with a rationale; start values from a dry run on a scratch vault, calibrated at the gate on the user's vault with `chatmind index topics --dry-run`. *Amended 2026-09-22 (user asked for a finer split):* the constants are the defaults; `CHATMIND_TOPIC_INHERIT`, `_INHERIT_MARGIN`, `_ASSIGN`, `_ASSIGN_MARGIN` override them from the environment or `~/.config/chatmind/env`, read identically by the server and the dry run. |

## 3. Packages and files

```
packages/core/src/vault/read.ts    + readCanvas(root, slug): one canvas folder (wrapper around readCanvasFolder)
packages/index/src/topics.ts       assignTopic (pure), centring, centroids, cleanTopic, name folding, TOPIC_SYSTEM + topicPrompt
packages/index/src/plan.ts         + planTopicJobs(entries, rows)
packages/index/src/reconcile.ts    + topic phase after summaries and renames; Report/pending.topics
packages/index/src/writeback.ts    + writeTopic(job, deps); both writebacks read one canvas via readCanvas
packages/index/src/db.ts           SCHEMA_VERSION 2, nodes.topic_written, allVectors(), setTopic()
packages/index/src/types.ts        TopicInput, TopicNamer, Report.topics, pending.topics
apps/server/src/index-providers.ts + createTopicNamer(model) (same model as summaries)
apps/server/src/index.ts           wires the namer into the Indexer
apps/cli/src/index-status.ts       shows pending.topics
apps/cli/src/index-topics.ts       chatmind index topics --dry-run
apps/web/src/topics.ts             topicPalette(dto), topicsOf(dto) (pure)
apps/web/src/flow.ts               MessageNodeData.topic / topicIndex / dimmed
apps/web/src/MessageNode.tsx       coloured left border + topic label in the header
apps/web/src/NodePanel.tsx         .topic pill in the topic colour
apps/web/src/App.tsx               topic list in the sidebar, active topic, Esc order, reset on canvas change
apps/web/src/styles.css            --topic-0 … --topic-9 (light + dark), .message-node.dimmed, .topics list
```

`@chatmind/index` keeps having no network dependency. The new injected interface, next to `Summarizer` and `Embedder`:

```ts
export interface TopicInput {
  summary: string;                 // the node's summary (user node: own + reply summary); body start while none exists
  role: 'user' | 'assistant';
  lang: 'de' | 'en';
  parentTopic?: string;
  candidates: { name: string; examples: string[] }[];  // top-3 by similarity + the parent's topic, each with up to 3 summaries
  allTopics: string[];             // every topic of the canvas, so the model does not invent a duplicate under another name
}
export interface TopicNamer { (input: TopicInput): Promise<string> }  // returns a topic name
```

`apps/web` reads topics from the existing `NodeDto.topics`; **no API change**.

## 4. Assignment (pure, `topics.ts`)

Input per candidate (a node with `topics: []` and a vector): its centred vector, the topic of `parents[0]` if assigned, and the canvas centroids. Output: `{ kind: 'assign', topic }` or `{ kind: 'ask', candidates }` — the latter means the namer decides.

**Vectors.** Cosine similarity on centred vectors `v − μ`, where μ is the mean of every stored vector in the vault (not per canvas — more stable for small canvases). Raw vectors stay in `vec_nodes` as stored by M5; nothing is re-stored (roadmap: "mean-centering at query time over raw stored vectors"). Below `MIN_CENTER = 8` vectors in the vault, no centring: the absolute thresholds then rarely fire and almost everything goes through the namer — only the first nodes of a new vault, acceptable.

**Centroid** of a topic = mean of the centred vectors of its nodes that have one. Topic set = every `topics[0]` in the canvas according to the frontmatter.

**Rules**, in order:

1. The canvas has no topic yet → `ask([])`: the namer founds the first one.
2. Similarity to every centroid; `best`, `second` (`second = −∞` with one topic).
3. **Prior:** the parent's topic `p` exists and `sim(p) ≥ best − INHERIT_MARGIN` and `sim(p) ≥ T_INHERIT` → `assign(p)`.
4. `best ≥ T_ASSIGN` and `best − second ≥ ASSIGN_MARGIN` → `assign(best)`.
5. Otherwise `ask(candidates)`: the top 3 topics by similarity, the parent's topic always included; the namer picks one or proposes a new name.

Start values (defaults, to be calibrated): `INHERIT_MARGIN = 0.05`, `T_INHERIT = 0.15`, `T_ASSIGN = 0.35`, `ASSIGN_MARGIN = 0.10`. Each constant carries a comment with its rationale and the calibration date.

**User nodes.** Vector = normalised mean of the node's own vector and that of its oldest assistant child with a vector (`created` order). No such child and the node is younger than `USER_WAIT_MS = 120 000` (by `created`) → deferred this run, counted in `pending.topics`; the indexer's existing retry timer brings it back. Older → judged alone (the reply failed or never came).

**Order.** Per canvas, serially, in `created` order — a node comes after its `parents[0]` (older by construction, also for merge nodes). Every assignment in a run updates the in-memory topic set and centroids, so later nodes see it. A node whose parent has no topic and is not a candidate (empty body, no vector) simply has no prior.

**Name folding.** `cleanTopic(raw)`: first line, whitespace collapsed, surrounding quotes and a trailing period stripped, at most `TOPIC_MAX = 40` characters (cut on a word boundary). Then `foldTopic(name, existing)`: compared case- and diacritics-insensitively with `-`/`_` treated as spaces (`Zentroid-Ansatz` ≙ `zentroid ansatz`) → the existing spelling wins. An empty name is an error (counted like a summary failure).

## 5. Naming (LLM)

`createTopicNamer(model)` in `apps/server/src/index-providers.ts`, next to `createSummarizer`: the summary model (`CHATMIND_SUMMARY_MODEL`), `reasoning.effort = 'minimal'`, `maxOutputTokens: 60`. `TOPIC_SYSTEM` is fixed and language-neutral (provider cache hits); the case travels in the user message, built by `topicPrompt(input)` in `@chatmind/index`.

Prompt contract: assign the message to one of the existing topics, or — only if none fits — name a new one. Reply with exactly the topic name, nothing else. A topic name has 1–4 words in the language of the message, names a subject (noun phrase), is not a question and not a sentence. The user message lists the candidates with their example summaries, then `allTopics` as a plain list, then the parent's topic, then the message's summary. With `candidates: []` (first node) the assignment part is omitted.

*Amended 2026-09-25 (user: topics too coarse — a Kaggle strand filed under "Pandas Befehle"):* the namer lumped whenever it was asked, because the prompt said "prefer a candidate" and the namer saw only names and examples, not the evidence. Replaying the indexer on a copy of the vault put the pasted Kaggle tutorial (similarity 0.18 to the pandas centroid, far below `T_ASSIGN`) under "Pandas Befehle" in 3 of 4 runs; the exact logged input did so in 8 of 10 calls. Now `TOPIC_SYSTEM` defines a topic as one specific subject ("as narrow as a chapter heading") and says that sharing a tool, field or keyword is not enough, and `TopicInput` carries two hints the prompt spells out when there are candidates: `startsStrand` (the node has no parent — the user opened a strand of its own) and `distant` (the best similarity is below `T_ASSIGN`). With both, the same input went 10 of 10 to a new topic and the replay 4 of 4 to three topics (Pandas, Kaggle tutorial, Kaggle notebook settings); a pandas question still joins "Pandas Befehle" 10 of 10, and a follow-up stays in its strand's topic.

The namer is called only for `ask` — the first few nodes of each topic; the bulk of a canvas is assigned without a call.

## 6. Indexer integration

**Database.** `SCHEMA_VERSION = 2`. A version-1 file is migrated with `ALTER TABLE nodes ADD COLUMN topic_written TEXT` — no drop, so no re-embedding of the vault. Any other version drops everything as before. New: `allVectors(): Map<id, Float32Array>` (loaded once per run; ~6 KB per node, fine below ~10k nodes) and `setTopic(id, name)`. No topic or centroid table: topics come from the frontmatter, centroids are computed per run (invariant 3.1 — derived data stays disposable).

**Jobs.** `planTopicJobs(entries, rows)`: nodes with `topics.length === 0`, a non-empty body and `embedded_hash === content_hash`. Planned **after** the embed loop (fresh rows), run **after** summaries and renames so the namer sees summaries as examples (a missing summary falls back to the body start, as `parentContextOf` does).

**Run** (`reconcile.ts`, phase implemented in `topics.ts`): per canvas — centre the vectors, build the topic set and centroids from the entries, walk the candidates in `created` order through `assignTopic`; on `ask` call the `TopicNamer` and fold the name; `writeTopic`; on success `db.setTopic(id, name)` and update the in-memory topic set and centroid. Failures use the same `MAX_FAILURES` counter as embed and summary (`gaveUp` until the body changes). Deferred user nodes count in `pending.topics`; the 2-minute rule reads an injectable clock (`ReconcileDeps.now`, default `Date.now`). Canvases run one after another; no concurrency (few calls).

**Writeback.** `writeTopic({ id, canvas, forHash, topic })`: one lock turn — `readCanvas`, guards `vanished` / `body-changed` / `topics-changed` (someone set a topic meanwhile → dropped, their edit wins), `node.topics = [topic]`, `writeNode`. No rename, no `graph.canvas`.

**`readCanvas(root, slug)`** in core (from the M5 notes): both writebacks read only their canvas instead of the whole vault — the first indexing of an existing vault goes from O(N²) to O(N·k).

**Status and CLI.** `Report.topics` (assigned this run), `pending.topics`, `IndexStatus.pending.topics`; the retry timer's pending sum includes topics. `chatmind index status` shows them. `chatmind index topics --dry-run [--data-dir]` opens vault and `index.db` read-only (as `status` does), runs the assignment for every candidate without writing and without a namer, and prints per node: canvas, id, role, parent topic, the top-3 similarities and the decision (`assign X`, `would ask [A, B]`, `deferred`). Exit 0 always.

**Live.** The writeback fires the watcher → `vault-changed` → the browser refetches and merges; `topics` arrive through the existing DTO.

## 7. Browser UI

**Colours.** Ten muted hues as CSS variables `--topic-0 … --topic-9`, with light and dark values. `topicPalette(dto): Map<name, index>` (pure, `apps/web/src/topics.ts`) assigns indices in order of first appearance in the canvas (earliest `created` among a topic's nodes), cycling from the eleventh topic on; computed once per canvas fetch (`useMemo`). Stable as long as topics do not vanish.

**Card** (`MessageNode`): a 4 px left border in the topic colour and the topic name as a small label at the start of the header (before `role · model`), with a dot in the topic colour, ellipsis-truncated, full name in `title`. No topic → nothing, the card looks as it does today. `selected`, `in-context`, `streaming`, `excluded` are unchanged.

**Panel** (`NodePanel`): the existing `.topic` pill takes the topic colour.

**Topic list.** In the left sidebar below the canvas list, heading "Topics", one entry per topic with colour dot, name and node count, sorted by colour index (= order of appearance). Click → the topic is active: its nodes render normally, all others get `.dimmed` (`opacity: .35`), and the camera fits the topic's nodes (the existing `focusIds` mechanism — a deliberate user action, not auto-follow). Click again or `Esc` → off. Reset on canvas change. The highlight is purely visual: selection, composer targets and context are untouched. `Esc` clears the active topic first if there is one, otherwise behaves as today (clears the selection).

**Copy.** "Topics" is English (UI rule); the topic names are in the language of the content.

## 8. Testing

TDD per package, as before.

- `@chatmind/index` — `assignTopic` pure: no topics → `ask([])`; prior wins on a close call; prior loses when its similarity drops; clear winner → `assign`; two close topics → `ask` with candidates including the parent's topic; centring on/off by vector count. `cleanTopic` and `foldTopic` (case, diacritics, hyphen/underscore, quotes, period, length). `planTopicJobs` (no job without a vector, none with a non-empty `topics`). `writeTopic` guards. Reconcile end-to-end with a fake embedder and namer: a chain → one topic with a single namer call; a split whose second child drifts → a second topic; a user node waits for its reply, is judged alone after 2 minutes (injected clock); a hand-set topic stays; failure counter and `gaveUp`; deleting `index.db` and reconciling again writes no topic. DB migration 1 → 2 keeps vectors and hashes.
- `@chatmind/core` — `readCanvas` returns the same graph and repairs as the matching element of `readVault`.
- `apps/web` — `topicPalette` (order, cycling); the card shows border and label only with a topic; the topic list counts and highlights; `Esc` order; reset on canvas change.
- `apps/server` / `apps/cli` — `topicPrompt` layout; `index status` and `index topics --dry-run` output on a fixture vault with a prepared `index.db`.

## 9. Not in M6

Multiple topics per node (the format allows it; the logic reads `topics[0]`); renaming or merging topics in the browser (approach C — feature list); topic groups as `group` nodes in the canvas; topics across canvases; retroactive re-clustering; topics in the LLM context (invariant 3.5); filtering instead of highlighting; a second namer model. *Amended 2026-09-22:* `chatmind index retopic --canvas <slug>` was added after all — it blanks only the topics the indexer wrote (matched against `topic_written`), so a canvas can be cut again after tuning; see the README.
