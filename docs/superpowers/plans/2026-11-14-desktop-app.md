# Plan — Desktop app (Electron)

Spec: `docs/superpowers/specs/2026-11-14-chatmind-desktop-app-design.md`. Branch `feat/desktop-app`, one pull request. Every task ends with `pnpm typecheck && pnpm test` green.

1. **Data folder from the env file** (spec §1): in the server and the CLI, `--data-dir` → process env → env file → default. Both pass the merged `loadEnv()` to `resolveDataDir`, whose env precedence is already tested.
2. **`updateEnvFile`** in `packages/index/src/env-file.ts`: replace in place, append, remove with `null`, keep comments and unknown keys, values with spaces or `#` quoted. Round-trips through `parseEnvFile`.
3. **`startServer`** (spec §2): move the bootstrap out of `apps/server/src/index.ts`. Test: start on port 0 with a tmp vault and `noIndex`, `GET /api/canvases` answers, `close()` frees the port and can be called twice, a taken port rejects with `EADDRINUSE`.
4. **`apps/desktop` skeleton**: package.json (electron, electron-builder, esbuild as dev deps), tsconfig, vitest; `pnpm-workspace.yaml` `allowBuilds: electron`.
5. **Pure modules + tests**: `ports.ts`, `config.ts`, `window-state.ts`.
6. **Main process**: `server.ts`, `main.ts` (single instance, window, navigation guard, menu, log file, quit sequence).
7. **Settings window**: `settings.html`, `settings.ts`, `preload.ts`, IPC `settings:load|save|choose-folder`; save → env file → `restart()` → reload.
8. **Packaging**: `scripts/build.mjs` (esbuild bundle + staging folder with web build and the native packages copied from the pnpm tree; no rebuild, they are N-API), `electron-builder.config.cjs`, root scripts `desktop`, `desktop:dist`; `.gitignore` for `build/` and `release/`.
9. **Smoke test** against a scratch HOME (never the user's env file or vault): packed app starts, serves the UI, the settings window saves to the scratch env file, a restart picks up the new data folder, quit ends the process.
10. **CI**: macOS job that builds `--dir`.
11. **Docs**: README (desktop section), `docs/usage.md`, tick the idea in `feature-ideen.md` once merged.
