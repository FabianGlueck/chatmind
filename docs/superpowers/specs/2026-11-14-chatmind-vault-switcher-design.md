# chatmind — Choosing the vault folder in the UI

Date: 2026-11-14. From the user ("es ist ein falscher ordner ausgewählt... wo kann ich das konfigurieren?" → "kann man das so machen dass das auswählbar in der UI ist?"). Not a roadmap milestone. No vault-format change.

## 1. Problem

The data folder is resolved once at startup (`--data-dir` → `CHATMIND_DATA_DIR` → `~/Documents/chatmind`, `resolveDataDir`). `index.ts` builds the watcher, indexer, link service and topic placer around it, and `createApp` closes over it. Changing the folder means editing the env file and restarting.

## 2. Behaviour

- The header of the web app shows the current folder (last path segment, full path as tooltip) and opens a small popover: the full path, a list of recently used folders (click to switch) and a text field "Open folder…" with a path input.
- A switch rebuilds everything that hangs on the folder: watcher, indexer, link service, placer. Then the browser reloads its canvas list. The lock (`VaultLock`) is kept.
- The server creates the folder if it does not exist, as at startup (`mkdir -p`). A path that exists but is a file, or cannot be created, is rejected with the reason; the current vault stays active.
- The browser cannot return an absolute path from a folder dialog, so the UI takes a typed or pasted path. `~` expands to the home directory. A native Finder dialog is out of scope.

## 3. Persistence and precedence

`~/.config/chatmind/settings.json` (next to `env`, never in the vault — §3 invariant "nothing foreign in the data folder"):

```json
{ "dataDir": "/abs/path", "recent": ["/abs/path", "/abs/other"] }
```

Startup precedence: `--data-dir` > `CHATMIND_DATA_DIR` > `settings.json` `dataDir` > `~/Documents/chatmind`. When `--data-dir` or the env variable is set, the UI still switches for the running process, and the choice is still written to `settings.json`, but it only takes effect on the next start if neither override is set. The popover says so ("overridden by --data-dir on startup").

`recent` holds at most 8 absolute paths, most recent first, deduplicated. A missing or unparsable file counts as empty; it is never an error. Writes are atomic (temp file + rename).

## 4. API

- `GET /api/vault` → `{ dataDir, recent, overridden: boolean }`.
- `PUT /api/vault` `{ dataDir }` → `200 { dataDir, recent }`; `400` for an invalid path (`{ error }`); `409` while a model completion is streaming in the current vault (`{ error: 'busy' }`).

Switching while a model call streams would write the answer into the old folder after the UI has moved on, so a switch is refused while any completion job is active. The UI shows the message and offers a retry.

## 5. Server structure

`index.ts` moves the wiring into a `VaultSession` (`apps/server/src/session.ts`): `{ dataDir, watcher, indexer?, links, placer?, close() }` built by `openSession(dataDir, ctx)`, where `ctx` carries keys, settings and `--no-index`. `switchTo(dir)` opens the new session first, then swaps it in, then closes the old one; if opening fails, the old session is untouched.

`createApp` receives a `vault: { current(): VaultSession; switchTo(dir): Promise<void>; … }` instead of `dataDir`, `watcher`, `indexer`, `links`, `placer`. Handlers read `vault.current()` at request time. The SSE stream (`/api/events`) subscribes to a vault-level emitter that forwards the current watcher and emits a `vault-switched` event on a switch, so open clients reload. Tests keep passing a plain `dataDir` through a `staticSession(dataDir)` helper.

`completion.ts` already takes `dataDir` as an argument and needs no change; the app tracks active jobs for the `409`.

## 6. Web

`apps/web/src/VaultSwitcher.tsx` (header, popover) and two functions in `api.ts`. On `vault-switched` (own switch or another tab's) the app clears its selection and reloads canvases and index status. No runtime imports from `@chatmind/core` beyond the existing `graph` entry. UI copy is English.

## 7. Tests

- `settings` (core or server): parse tolerance, `recent` cap/dedupe/order, atomic write, precedence.
- `session`: switching opens before closing; a failing open keeps the old session; the old watcher/indexer are closed.
- `app`: `GET/PUT /api/vault` incl. `400` and `409`; after a switch, `/api/canvases` lists the new folder's canvases.
- Web: popover lists recent folders, shows the error text on `400`/`409`.

## 8. Not covered

- Several vaults open at once (tabs on different folders). The server serves one vault at a time.
- A native folder dialog.
- Moving or copying data between vaults.
