# chatmind — Using a vault with Obsidian Sync

Date: 2026-11-14. From the user ("kann man chatmind so benutzen, dass es synchronisiert wird via obsidian sync?" → "setze das notwendige gerne um und dokumentiere"). Not a roadmap milestone: one reader fix and documentation. No vault-format change.

## 1. How Obsidian Sync treats a chatmind vault

From the Obsidian help (sync/settings, sync/troubleshoot, checked 2026-11-14):

| Sync behaviour | Effect on chatmind |
|---|---|
| Files and folders starting with `.` are not synced (only `.obsidian` is). | `.app/index.db` stays per device. That is correct: it is derived and rebuilt on start (§3 invariant). `.trash/` stays on the device that deleted or compressed; the other devices just see the files disappear. |
| Markdown files are merged with diff-match-patch (default "Automatically merge"). | Node and memory files edited on two devices before syncing get merged. Two different `summary` lines can end up garbled; the reader repairs what it can. |
| All other files, canvases included, are "last modified wins". | Concurrent edits to `graph.canvas` lose the other device's positions. Structure is safe, since it lives in frontmatter `parents`; nodes without a canvas entry get a placeholder layout (`layout-missing`). |
| With "Create conflict file" (Obsidian 1.9.7+, set per device), a conflict writes `<name> (Conflicted copy <device> <YYYYMMDDHHMM>).md` next to the original. The original keeps the remote version. | The copy has the same frontmatter `id` (or `topic`) as the original. See §2. |
| Images are synced by default (selective sync); "other file types" are opt-in. | `attachments/` (M13) holds images only, so it syncs with the defaults. |

## 2. Reader fix: a conflict copy never wins

Before: duplicate `id` → first by sorted path wins (vault-format spec §9 step 1), and the same rule picked a memory per topic (M15 §1). `"<ULID> (Conflicted copy …).md"` sorts before `"<ULID>.md"` and before `"<ULID>-<slug>.md"`, because a space (0x20) comes before `.` (0x2e) and `-` (0x2d). So the reader kept the conflict copy, and every later write (summary writeback, edit, rename) went to the copy.

Now:

- **Nodes:** of the files sharing an `id`, one named the way chatmind names it (`{ULID}.md` or `{ULID}-{slug}.md` with a `slug()`-shaped slug, i.e. a name `nodeFileName` could have produced for that id) beats any other. Within each group, the first by sorted path still wins. The other files are reported as `duplicate-id` as before and never touched.
- **Memories:** a file whose basename is `slug()`-shaped (`<slug>.md`, `<slug>-2.md`, as `memoryPath` names them) beats any other for the same topic, then first by path. The others are reported as `duplicate-memory`.

The reader still never writes or deletes (§3 invariant). Conflict copies stay on disk until the user merges or deletes them by hand. `pnpm cli check` lists them.

## 3. One indexer per vault

The indexer renames `{ULID}.md` to `{ULID}-{slug}.md` once and writes `summary`/`topics`. Two indexers on two devices can each rename the same new node before the other's rename arrives, and then the vault holds two own-named files for one id. Their summaries also come from separate model calls, so the Markdown merge may garble them.

The rule is to run the indexer on one device only and start the others with `--no-index` / `CHATMIND_NO_INDEX=1`. There is no automatic lock. A lock file in `.app/` would not sync, a visible one would be a vault-format change, and sync latency would make either unreliable anyway.

## 4. Not covered

- Live co-editing of one canvas on two devices. Work on one device at a time and let Obsidian sync before switching.
- Mobile: Obsidian on a phone can read and edit the files, but the chatmind server needs Node and does not run there.
- Restoring from `.trash/` on a device other than the one that deleted. Use Obsidian Sync's version history instead.
