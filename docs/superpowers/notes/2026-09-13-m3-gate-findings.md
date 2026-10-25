# M3 manual gate findings — 2026-09-13

- Browser: the user's default macOS browser
- Providers used: OpenRouter (key in `~/.config/chatmind/env`); server log listed `providers: openrouter`
- Models used: `anthropic/claude-sonnet-5`, `google/gemini-3.8-flash`
- Step 1 (keys and start): pass
- Step 2 item 1 (`↓` selects first node, composer says "Replying to: …"): pass
- Step 2 item 2 (`Enter`, type, `⌘⏎` → user node + streaming assistant card + one camera pan): pass
- Step 2 item 3 (`Esc`/`↑`/`↑`/`Enter`, type, choose another model mouse-free, `⌘⏎` → second branch to the right): pass
- Step 2 item 4 (`←/→` between the two branches; `↑` to the common parent): pass
- Step 2 item 5 ("+ New canvas" → name → empty canvas opens, composer says "New root message", send → root node + answer): pass
- Step 2 item 6 (Obsidian shows the new nodes/edges, branch renders side by side, new canvas exists; `pnpm cli check` clean): pass — no repairs (masterarbeit 11 nodes + two new canvases)
- Step 2 item 7 (kill the network mid-stream / invalid key → error state shown, partial text kept): Not manually exercised. Covered by automated tests: `apps/server/test/completion.test.ts` (partial text persisted on provider error; no node without text), `apps/server/test/app.test.ts` (fast-failure SSE `error` with `partial:false`), `apps/web/test/App.test.tsx` (stream ends without `done` → node marked errored; 500 keeps typed text).
- Issues found:
  1. Model chips are keyboard-reachable (Shift+Tab from the textarea, then ←/→ switch) but have no visible focus indicator, so they look unreachable.
  2. The new-canvas inline input is invisible — neither the placeholder nor typed text can be seen until Enter.
  3. User preference: Enter should send, Shift+Enter should insert a newline (Cmd/Ctrl+Enter had been the only way to send).
- Changes made (commit `0525519` — `fix(web): visible chip focus, styled new-canvas input, Enter sends / Shift+Enter newline`):
  1. `.composer .chip:focus-within` outline + a `⇧⇥ then ←→ to change model` hint next to the chips.
  2. Styled `.new-canvas-form input`/`button` like the composer's textarea/button (border, padding, background).
  3. `Composer` onKeyDown: plain Enter (no Shift) sends; Shift+Enter falls through to a newline; Cmd/Ctrl+Enter still sends. Placeholder and spec §2/§7 updated to match.
- What was verified manually: the milestone's done condition — a keyboard-only branching conversation (selection, send, branch, navigate between branches, model switch, new canvas) confirmed correct both in the app and in Obsidian/`pnpm cli check`. Item 7 (mid-stream failure) was not part of that manual run and relies on the automated coverage above instead.
- Verdict: M3 done condition met
