# M6 implementation notes — 2026-09-21

Status for whoever picks this up next (human or agent). Companion to `2026-09-21-m5-implementation-notes.md`.

## Where M6 stands

- Implemented on `main`, commits `83d028b..aaadf8c` (11 commits; plan `docs/superpowers/plans/2026-09-21-cycle-6-m6-topics.md`, spec `docs/superpowers/specs/2026-09-21-chatmind-m6-topics-design.md`). Typecheck clean, 406 tests green (core 161, index 89, cli 7, server 56, web 93).
- The spec needed **no** amendment: everything it prescribes is implemented as written. The deviations below are refinements found in review, all inside the spec's contract.
- Every task had a scoped review (task reports and diffs in `.superpowers/sdd/2026-09-21-cycle-6-m6-topics/`); two tasks needed one fix round each (Task 5 `locate()`, Task 6 failure counter / `replyId` / `allTopics`), both re-reviewed clean.
- **Paid dry run done (2026-09-22)** on a throwaway 10-node vault with the user's OpenRouter key — numbers below. The five things it had to establish all held, with one caveat about how often the namer is called.
- Manual gate on the user's own vault is **open** — checklist at the end; findings go to `docs/superpowers/notes/2026-09-21-m6-gate-findings.md`.

## Deviations from the spec as first written (spec unchanged, all compatible)

- `writeback.ts` has one private `locate()` helper that does `readCanvas` + the `vanished` / `body-changed` guards for both the M5 summary/rename writeback and `writeTopic`; the spec's §6 wording implied two copies of the guard block. Drift between them would silently break the guard contract.
- A written topic does **not** clear the shared `MAX_FAILURES` counter (a written topic is never re-planned, and clearing it would reset a summary failure counted earlier in the same run).
- `Candidate` carries `replyId`, so a user node's vector and the summary the namer sees come from the same assistant reply.
- `allTopics` (what the namer is told already exists, and what `foldTopic` folds against) is the union of the canvas's `topicOf` values and the centroid topics — a hand-set topic on a node without a vector is therefore visible to the namer, as spec §4's "topic set = every `topics[0]` in the canvas" requires.
- `IndexerOptions.now?: () => number` was added (optional, passed through to `reconcile`): the spec only put the injectable clock on `ReconcileDeps`, but the `Indexer` tests need it too, or every freshly written user node defers for `USER_WAIT_MS` and keeps the retry timer alive.
- **Gap, fixed in the review fix wave:** `TopicPhaseReport.asked` counted the namer calls, but `reconcile` dropped it — `Report`, `/api/index/status` and `index status` showed only `topics` (assigned), so there was no way to see from the running server how often the LLM was asked. The dry-run numbers below had to be reconstructed offline (a scratch script replaying `prepareCanvas`/`assignTopic` over the stored vectors). `Report.asked` now surfaces the namer-call count, and the topic phase logs `topics: N assigned, M asked, K deferred` once per run when it did anything — a real run's ask rate is a log read now, not a reconstruction.

## Rulings made during implementation (controller decisions, not the user's)

1. Task 6 committed the server/CLI compile fixes for the new `namer` option so `pnpm typecheck` stays green at every commit; Task 7 only re-verified them.
2. `report.gaveUp` may double-count a node that is both a given-up summarize job and a given-up topic candidate — accepted (a counter, not a control flow).
3. The topic phase runs canvases serially with no concurrency, as the spec says; with the namer asked only a few times per canvas this is not worth parallelising.
4. The dry run judges every candidate against the topics **already in the vault** and does not simulate the topics a real run would found as it walks the canvas. A whole unindexed strand therefore prints as `would ask`. Documented in the README so the output is not misread.

## Deferred minors (none blocks the gate)

- Fixed in the review fix wave: `db.ts`'s class doc said "a schema version mismatch drops everything" — v1 → v2 has been additive since M6. Still true and unfixed: `openReadonly` on a still-schema-1 file yields rows whose `topic_written` is `undefined`, not `null` (no readonly consumer reads it yet); no test that `allVectors()` is empty on a readonly handle without the vec extension.
- **Frontmatter passthrough (out of scope for M6):** the first indexed run writes `topics:` into every node that still has `topics: []`, and `serializeNodeFile` rebuilds each file's frontmatter from the canonical eight keys (`id, canvas, role, model, parents, created, summary, topics`) — any other key the user added in Obsidian (`tags:`, `aliases:`, …) is silently dropped. M5 already had this for the files it touched; M6 widens it to files M5 never touched, notably a node whose summary the user wrote by hand and that had no reason to be rewritten before now. A real fix needs a passthrough design (read the vault's unknown keys, carry them through `serializeNodeFile` unchanged) — not attempted here. See the gate checklist's warning below for the mitigation until then.
- `cosine` and `TopicCentroids.add` do not validate operand length (a dim mismatch would silently produce nonsense); `TopicCentroids.all()` is recomputed per `assignTopic` call (O(topics·dim) per node — fine at this scale).
- The `QUOTES` regex is duplicated between `summary.ts` and `topics.ts`; the `Entry`-building line is duplicated between `index-status.ts` and `index-topics.ts`; the topic embedder fake is duplicated between the index and CLI tests.
- Created-order sorting compares ISO strings (a hand-edited offset or milliseconds would sort wrongly; the deferral check uses `Date.parse`). A user node's centroid contribution is `mean(user, reply)` in the run that assigns it but the user vector alone when the topic set is reseeded from the frontmatter on a later run.
- Test gaps: `writeTopic` does not snapshot `graph.canvas` bytes to prove it is untouched; the dry-run test does not re-read the hand-set-topic node; the dry run's `deferred` print branch is untested and hardcodes `user`; no Indexer-level test that `pending.topics` alone keeps the retry timer alive.
- Web: an active topic whose last node disappears on a live refetch stays active — everything dims with no pressed button left (`Esc` recovers). The card falls back to the `topic-0` colour on a palette miss while the panel falls back to neutral (inert, both read the same palette). `gap: 6px` applies to every card header, not only `.has-topic`.
- The topic click shares `focusIds` with the send loop and the nav keys (last write wins).

## Paid dry run — 2026-09-22

Setup: throwaway vault (`--data-dir <scratch>/vault --port 3299`, never the user's vault), one canvas, 10 German nodes: six on "Methodenkapitel einer Masterarbeit" (u/a ×3), then a split off the fourth node into four nodes on "Sauerteig/Roggenbrot" (u/a ×2). Models as shipped: `openai/gpt-5.6-luna` for summaries **and** the namer, `openai/text-embedding-3-small`/1536. 10 vectors ⇒ **centring on** (`MIN_CENTER = 8`).

**Result of the first run** (fresh `.app`): 10 embedded, 10 summarized, 10 renamed once, 10 topics — `index status`: `10 nodes, 10 embedded, 10 summarized, 10 topics, pending embed 0, pending summary 0, pending topics 0`. Two topics, exactly along the split:

- nodes 1–6 → `Methodenkapitel qualitative`
- nodes 7–10 → `Sauerteigbrot backen`

**Model behaviour.** Both names are German (the content's language, as specified), two words, noun phrases, no quotes, no trailing period, well under `TOPIC_MAX = 40`. No near-duplicate name was invented for an existing topic, and the re-assignment run below produced the *same* name a second time. Nothing had to be folded or cleaned.

**Decisions and similarities** (cosine to the topic centroid on centred vectors, in `created` order; namer calls marked ASK — reconstructed offline, see the gap above):

| node | role | parent topic | sim | decision |
|---|---|---|---|---|
| 1 | user | – | (no topics) | **ASK** → founds `Methodenkapitel qualitative` |
| 2 | assistant | Methodenkapitel qualitative | 0.851 | assign |
| 3 | user | Methodenkapitel qualitative | 0.093 | **ASK** → same topic |
| 4 | assistant | Methodenkapitel qualitative | 0.485 | assign |
| 5 | user | Methodenkapitel qualitative | −0.111 | **ASK** → same topic |
| 6 | assistant | Methodenkapitel qualitative | 0.241 | assign |
| 7 | user (the split) | Methodenkapitel qualitative | −0.761 | **ASK** → founds `Sauerteigbrot backen` |
| 8 | assistant | Sauerteigbrot backen | 0.838 (other: −0.681) | assign |
| 9 | user | Sauerteigbrot backen | 0.355 (other: −0.771) | assign |
| 10 | assistant | Sauerteigbrot backen | 0.746 (other: −0.765) | assign |

**4 namer calls for 10 nodes**, all four answered correctly. Bands: same topic **−0.11 … 0.85**, different topic **−0.68 … −0.82** — a wide, clean gap.

**The five checks.**

1. *First node founds a named topic* — yes (`Methodenkapitel qualitative`, from `ask([])`).
2. *A continuing chain inherits without further namer calls* — **partly.** Every assistant node inherited silently (5 of 5), and so did user node 9 (0.355, via the parent prior). But two **on-topic user** nodes (3 and 5) scored 0.093 and −0.111 to their own topic's centroid, below `T_INHERIT = 0.15`, and went to the namer — which returned the parent's topic both times. So the chain keeps its topic, but in this small vault at the price of a model call for some on-topic user nodes. Of the four calls, two were unavoidable (founding the canvas's first topic, and the subject change); two were this effect. In the re-assignment run below (the topic already exists with a centroid of its own) the same strand cost **1 call for 4 nodes**.
3. *A strand that changes subject founds a second topic* — yes, at −0.761 to the parent's topic, `ask` → `Sauerteigbrot backen`.
4. *`chatmind index topics --dry-run` prints similarities that make the thresholds look sane* — yes. With the four bread nodes blanked, it printed one topic, four candidates, similarities −0.75 … −0.82, all `would ask` (correct: their topic no longer exists on disk). With everything assigned it prints `2 topics (…), 0 candidates, 0 deferred`. Output format and the read-only/no-network/exit-0 promise all hold.
5. *Deleting `.app/index.db` and restarting writes no topic* — yes. `index.db` (and the `-wal`/`-shm` sidecars) deleted, server restarted: the run reported `embedded 10, summarized 0, renamed 0, topics 0`, and a `shasum` over all 11 vault files was **byte-identical** before and after.

Also checked: blanking `topics: []` on four nodes made the next start re-assign them (same name, 1 namer call, **no second rename**, strand A untouched) — the re-assignment path the user will use to correct a bad cut.

**Cost.** Not surfaced anywhere in the app. ~15 summary-model calls (10 summaries + 5 namer calls) at the ~$0.00004/call measured for this model in M5, plus ~20 short embeddings — well under one cent for the whole dry run.

**Not exercised by the dry run:** the schema 1 → 2 migration (the scratch `index.db` was created fresh at schema 2; the migration is covered by a unit test and will be exercised for real by the user's existing `index.db` at the gate — watch the first startup for a reconcile crash) and the browser UI (covered by tests and a separate probe).

## Thresholds in force (defaults — `packages/index/src/topics.ts`, tunable since 2026-09-22)

```
MIN_CENTER     = 8      no mean-centring below this many stored vectors
INHERIT_MARGIN = 0.05   the parent's topic may trail the best by this much
T_INHERIT      = 0.15   …and must still be at least this similar
T_ASSIGN       = 0.35   assign without the LLM only above this
ASSIGN_MARGIN  = 0.10   …and with this much daylight to the runner-up
```

**Recommendation for the gate (deliberately not applied — the user's call):** `T_INHERIT = 0.15` is the constant the dry run actually stressed, and it sits *inside* the same-topic band (on-topic user nodes scored 0.093 and −0.111). Lowering it to `0.0` would have removed one of the four namer calls, `−0.3` both avoidable ones, without changing a single assignment — the subject change was at −0.76, so there is a lot of room before a strand would wrongly keep a stale topic. Two reasons to leave it alone anyway: the extra calls were correct 4/4 and cost fractions of a cent, and ten vectors in two clusters is the worst case for centring (μ sits between the clusters and pushes every similarity down), so these numbers are not representative of a large vault. Decide it on the user's own vault: **after** the first indexed start (so real topics exist to compare against), blank one strand's `topics:` and run `pnpm cli index topics --dry-run` there — look at where its on-topic nodes land, and only then move `T_INHERIT`. Run before the first start instead and there is nothing yet to compare against: every node still has `topics: []`, so every candidate prints `(no topics) | → would ask []` with no similarity to read at all. `T_ASSIGN` and `ASSIGN_MARGIN` were never stressed (two far-apart topics) — leave them until a vault with many close topics says otherwise.

**Follow-up, 2026-09-22 (user asked for a finer split).** The four thresholds are no longer compile-time constants: `CHATMIND_TOPIC_INHERIT`, `CHATMIND_TOPIC_INHERIT_MARGIN`, `CHATMIND_TOPIC_ASSIGN` and `CHATMIND_TOPIC_ASSIGN_MARGIN` override them (`topicSettings` in `@chatmind/index`, one source for the server and the dry run); nonsense or out-of-range values fall back to the default and the startup line names whatever differs. `pnpm cli index retopic --canvas <slug>` blanks the topics the indexer wrote — matched against `topic_written`, so the user's own are left alone — and the running indexer assigns them again. **The shipped defaults are unchanged**, for the reasons above; the user tunes their own vault via the environment. Order matters and is documented in the README: set the environment, restart the server, *then* `retopic`, or the still-running indexer re-assigns with the old values. Starting point for "finer" is `CHATMIND_TOPIC_INHERIT=0.30`.

## Gate checklist for the user (own vault, real key)

Before starting the server the first time, `git`-less safety net: keep a copy of the vault or be ready to blank `topics:`; the indexer never touches a non-empty `topics`.

**Frontmatter warning, read before step 2:** the first indexed run writes `topics:` into every node
that still has `topics: []`, and the writer rebuilds each file's frontmatter from the canonical eight
keys (`id, canvas, role, model, parents, created, summary, topics`) — any other key you added in
Obsidian (`tags:`, `aliases:`, …) is silently dropped, including on nodes M5 never touched (e.g. a node
whose summary you wrote by hand). There is no passthrough yet (tracked as a follow-up above). Check the
vault for frontmatter keys outside those eight before the first indexed start, and rely on the copy/blank
safety net above if you find any you care about.

1. `pnpm cli index topics --dry-run` **before** the first indexed start — a smoke test only, not
   calibration: does it read the vault and `.app/index.db` and exit 0? On an unindexed vault every node
   still has `topics: []`, so every candidate has nothing to compare against and prints `(no topics) | →
   would ask []` — there are no similarities to read yet. The real calibration run is step 8, below.
2. Start `pnpm dev`, let the indexer run. Watch the first startup for errors (the M5 `index.db` migrates in place to schema 2; nothing is re-embedded).
3. `pnpm cli index status`: every canvas should end at `topics` = number of nodes with a body, `pending topics 0` (a user node whose reply is younger than 2 minutes may legitimately show as pending for a moment).
4. **Are the topics usable?** Names and, more importantly, the cuts: does a strand that changes subject get its own topic, and do two strands on the same subject share one? This is the milestone's done condition — if the cuts are wrong, say where, and the thresholds get calibrated (see the recommendation above).
5. In the browser: cards carry a coloured left border and the topic name in the header; the panel's topic pill has the same colour; the sidebar's "Topics" list shows every topic with a colour dot and a node count.
6. Click a topic: its nodes stay bright, everything else dims, the camera fits the topic. Click again → off. `Esc` → off (and only the *next* `Esc` clears the selection). Switch canvas → the highlight is gone.
7. Set a topic by hand in Obsidian on a node (`topics: [Mein Thema]`), save, wait for a run → it is still there, unchanged.
8. **The real calibration run:** blank one strand's `topics:` (`topics: []`), save, then immediately run
   `pnpm cli index topics --dry-run` before the indexer's next pass — now the canvas has real topics to
   compare against and the similarity columns mean something; read them against `T_INHERIT`/`T_ASSIGN`
   (see the recommendation above) before touching either constant. Then let the indexer run → the strand
   is re-assigned, and the file is **not** renamed again.
9. Delete `.app/index.db`, `index.db-wal`, `index.db-shm`, restart → the vault is re-embedded but **no** `topics:` in any file changes.
10. `pnpm cli check` → clean (exit 0).

Findings go to `docs/superpowers/notes/2026-09-21-m6-gate-findings.md`.
