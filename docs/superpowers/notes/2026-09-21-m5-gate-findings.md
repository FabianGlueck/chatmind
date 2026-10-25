# M5 manual gate findings — 2026-09-21

- Run by: the user, on their own vault with the real OpenRouter key, Obsidian and the default macOS browser.
- Build under test: `953b7f3` (cycle 5: 33 commits since the plan, typecheck clean, 359 tests green).
- Done condition (spec §1): deleting `.app/index.db` and restarting rebuilds it fully; summaries show up live on the cards; files are renamed once in Obsidian; a hand-edited summary is never overwritten. **Reported by the user as passed ("gate ist durch").** Individual checklist items (Obsidian rename with an open file, body edit → browser follows, summary edit stays, card dragged in Obsidian → browser follows, `pnpm cli check`) were not itemised in the user's report.
- Controller checks before the gate: paid dry run on a 3-node scratch vault (summaries, rename once, embeddings, rebuild after deleting the db, regeneration of a blanked summary without a second rename); `vault-changed` → API serves the new summary; see `2026-09-21-m5-implementation-notes.md`.
- Issues found during the gate, all fixed in the same cycle:
  - Reasoning tokens ate the 60-token summary budget → titles cut off. `reasoning.effort = 'minimal'`, budget 200 (`156f695`).
  - The user wanted cards to show only the summary and summaries to be real summaries (1–3 sentences, ≤ 250 chars) instead of titles; panel shows summary + body; `nodeTitle` caps to 80 for labels (`389f56f`).
  - Over-long model output ended in a word-cut `…` → cut back to the last sentence end; prompt asks for ≤ 200 chars (`72af17a`).
  - User summaries repeated the quoted material instead of the question → summarizer receives role and parent context; user messages summarised as intent with a label (`953b7f3`).
- Re-summarising existing nodes: blank `summary:` in the frontmatter (e.g. with `sed`), the running indexer regenerates; files are not renamed again. A `chatmind index resummarize` command (only summaries the indexer wrote, per `summary_written`) was offered and not needed yet — candidate for the feature list.
- Observations, no change: `index.db` is ~6 MB from the start (vec0 chunk preallocation); `index.db-wal`/`-shm` are SQLite WAL sidecars. Both documented in README/notes.
- Verdict: M5 done condition met.
