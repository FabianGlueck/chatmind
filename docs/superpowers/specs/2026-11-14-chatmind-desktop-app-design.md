# chatmind — Desktop app (Electron)

Date: 2026-11-14. From the user's idea list ("electron-app für den desktop — server im main-prozess, web-build im fenster; native module (better-sqlite3, sqlite-vec) für electron bauen, ordnerwahl und api-keys per einstellungsseite, signieren/notarisieren für macos"). Then: "bitte mach dir selbst spec usw für die electron app und setze das um. arbeite selbstständig bis du einen fertigen MR hast". Not part of the cycle-1 roadmap, so this spec has no milestone number. It works in a pull request on `feat/desktop-app`, because the user asked for an MR.

The goal is a double-clickable chatmind for macOS: no terminal, no `pnpm`. It is the same app as `pnpm start`: the Hono server and the built web UI, now in a native window. It adds a settings window for the data folder, API keys and the indexer. The vault format, the API and the web UI do not change.

## 1. Decisions

| Topic | Decision |
|---|---|
| Package | New workspace package `apps/desktop` (`@chatmind/desktop`): Electron 45, electron-builder 26, esbuild for the main-process bundle. |
| Server | Runs **in the Electron main process** on `127.0.0.1`, the same code as `pnpm start`. The bootstrap moves out of `apps/server/src/index.ts` into `startServer()` (§2), which the CLI entry and the desktop app share. |
| Transport | Plain HTTP on localhost, loaded into a `BrowserWindow`. No custom protocol: SSE, `EventSource`, the origin check in `app.ts` and streaming work unchanged. |
| Port | Fixed default **3211**, so the app can run next to a `pnpm start` on 3210. If it is taken, the app tries 3212…3220. The port stays fixed because the web UI keeps per-origin `localStorage` (panel width, view state), and a random port would reset it on every launch. |
| One instance | `app.requestSingleInstanceLock()`. A second launch focuses the first window instead of starting a second server and indexer on the same vault. |
| Settings storage | **`~/.config/chatmind/env`**, the file the server and CLI already read (spec M5 §2). The desktop app has no settings store of its own: data folder (`CHATMIND_DATA_DIR`), the four API keys and `CHATMIND_NO_INDEX` are written there. Keys still never go into the vault or the repo (§3 invariant). |
| Data folder from the env file | Bug fix: the README promises "settings are read from the environment, then from `~/.config/chatmind/env`", but `CHATMIND_DATA_DIR` was read from the process environment only. The server and the CLI now resolve it from the merged env: `--data-dir` → process env → env file → `~/Documents/chatmind`. Without this, a data folder chosen in the desktop app would be ignored by `pnpm cli check`. `CHATMIND_PORT` stays process-env only for the server; the desktop app ignores it (§1 Port). |
| Settings window | Opens with ⌘, and automatically on first launch when no provider key is set. Fields: data folder (shown, "Choose…" opens a folder dialog), Anthropic / OpenAI / Mistral / OpenRouter key, "Run the indexer on this computer" (checkbox ↔ `CHATMIND_NO_INDEX`). Key values never reach the window, only whether a key is set: a typed key replaces it, "Remove" clears it, an untouched field keeps it. A value that comes from the process environment wins over the file (that rule already exists) and is shown read-only with a note. "Save" writes only what changed, restarts the server in-process on the same port, then reloads the main window. |
| Editing the env file | One pure function `updateEnvFile(text, changes)` in `@chatmind/index/env-file.ts` (spec M5 §2: the one place the file is handled). It replaces a key's line in place, appends new keys, removes keys set to `null`, and keeps comments, blank lines and unknown keys. The file is written with mode `0600`, and its folder is created if missing. |
| Window security | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` for both windows. The main window has no preload and no IPC. Navigation away from the server origin is blocked, and links and `window.open` go to the default browser. The settings window gets a preload exposing exactly `load`, `save` and `chooseFolder` over IPC. |
| Menu | macOS app menu (About, Settings… ⌘,, Hide, Quit), File (Open Data Folder in Finder, Open in Obsidian via `obsidian://open?path=`), Edit (standard roles, so copy/paste works), View (Reload, Zoom, Toggle DevTools), Window, Help (Show Log File). |
| Window state | Size and position are remembered in Electron's `userData` (`window.json`), written on window close and on quit (`app.exit` closes no windows). A position no longer on any screen is dropped. This is app state, not vault data and not settings. |
| Log | Every console line of the main process (server and indexer) also goes to `<logs>/chatmind.log` (Electron's `app.getPath('logs')`, `~/Library/Logs/chatmind` on macOS), so a user without a terminal can see "index: off (no OPENROUTER_API_KEY)". Help → Show Log File opens it. |
| Shutdown | `before-quit` runs the same order as the CLI shutdown (spec M5 §8): close the server, the watcher, the indexer (bounded), links and the placer, with a 12 s cut-off. |
| Native modules | `better-sqlite3` 13 ships N-API prebuilds, and N-API is ABI-stable, so the same binary loads in Node and in Electron. That was checked: Electron 45 loads `better-sqlite3` and `sqlite-vec` from the pnpm tree unchanged. **Nothing is rebuilt.** Packaging uses a **staging folder** `apps/desktop/build/app/`. It holds the bundled `main.cjs`, `preload.cjs`, `settings.html`/`settings.js`, the copied web build, and the two native packages plus their declared dependencies (`node-addon-api`, the host's `sqlite-vec-<os>-<arch>`), copied from the pnpm tree at the lockfile's versions. Every dependency must be present, because otherwise electron-builder's dependency walk falls back to the workspace and packs all of it. Its `package.json` lists only the two native packages. electron-builder runs with `npmRebuild: false` and `asar: false`: sqlite-vec hands SQLite a file path to its `.dylib`, and native code cannot read from inside an asar archive. Everything else is bundled by esbuild. |
| Targets | macOS `dmg` + `zip` for the host architecture. Windows (`nsis`) and Linux (`AppImage`) are configured but untested. |
| Signing | **Not in this MR**: it needs the user's Apple Developer account. The build is unsigned (`identity: null`), and the docs explain how to open it anyway. electron-builder picks up `CSC_LINK`/`APPLE_ID…` later without code changes. |
| CI | One new job on `macos-latest` builds the unpacked app (`--dir`) and loads `better-sqlite3` + `sqlite-vec` with the packed app's own binary (`ELECTRON_RUN_AS_NODE`), so packaging breakage shows up in pull requests. Actions are pinned by SHA like the existing ones. |

## 2. `startServer` (apps/server)

```ts
export interface StartOptions {
  dataDir: string; port: number; staticDir?: string; noIndex?: boolean;
  env: Record<string, string>; keys: Keys;          // already loaded by the caller
  log?: (line: string) => void; error?: (line: string) => void;  // default console
}
export interface RunningServer { port: number; dataDir: string; close(): Promise<void> }
export function startServer(o: StartOptions): Promise<RunningServer>;  // rejects with code EADDRINUSE when the port is taken
```

It does everything `index.ts` did between parsing the arguments and the signal handlers: create the data folder, watcher, indexer and placer, links, `createApp`, `serve`, and the startup lines. The indexer starts only once the port is listening (unchanged rule). `close()` is idempotent and does the shutdown sequence without `process.exit`. `index.ts` keeps argument parsing, the port-in-use message, signals, `--exit-with-parent` and the exit codes.

## 3. Desktop main process (apps/desktop/src)

- `main.ts`: Electron wiring (single-instance lock, menu, windows, IPC, quit).
- `config.ts` (pure, tested): settings form ⇄ env-file changes; which fields come from the process env; first-launch check (no key).
- `ports.ts` (tested): first free port in `3211…3220`.
- `server.ts`: `start()` resolves the config (`loadEnv`, `loadKeys`, data folder with the same rule as §1), tries the ports, and calls `startServer`. `restart()` closes and starts again.
- `window-state.ts` (tested): load and save bounds, clamped to a sane minimum size.
- `settings/`: `settings.html` + `settings.ts` (renderer, no framework), `preload.ts`.

## 4. Scripts

- `pnpm desktop` builds the web UI, bundles the main process, packs the unpacked app (`--dir`, under `apps/desktop/release/`) and opens it.
- `pnpm desktop:dist` does the same, then makes `dmg` and `zip` under `apps/desktop/release/`.
- `apps/desktop` takes part in `pnpm typecheck` and `pnpm test` like every package. Its tests need no Electron binary: the Electron-only module `main.ts` is not imported by tests.

## 5. Not covered

- Code signing and notarisation, auto-update, an app icon of its own (Electron's default for now).
- Running `pnpm start` and the desktop app on the **same** vault at once: two servers, two indexers. The single-instance lock covers only the desktop app. This is documented, not enforced.
- A settings page inside the web UI for the browser version (`pnpm start`).
