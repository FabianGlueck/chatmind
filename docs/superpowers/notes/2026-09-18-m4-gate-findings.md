# M4 manual gate findings — 2026-09-18

- Run by: the user, on the user's default macOS browser + Obsidian, with the real provider key.
- Build under test: `311019e` (cycle 4 complete: 16 commits, typecheck clean, 265 tests green).
- Done condition (spec §1): a merge of two branches with complementary content produces a usable proposal that draws on both; the multi-parent structure survives round-trip and Obsidian. **Reported by the user as working ("sonst funktioniert alles").** Individual checklist items (badges, exclusion, meter, ghost slot, follow-up reply, `pnpm cli check`, Obsidian edges, reload, last-target-off regression) were not itemised in the user's report.
- Issues found: none in the merge flow itself.
- Product feedback collected during the gate lives in `docs/user-feedback/feedback.md` (UX: new-canvas input still hard to see, streaming indicator too subtle / show the stream in the panel, markdown rendering on cards, resizable right panel; note ends mid-sentence) and `docs/user-feedback/feature-ideen.md` (chat mode for a strand, draggable cards, image upload, LLM tools such as tables). None is M4 scope; candidates for the next cycle.
- Verdict: M4 done condition met.
