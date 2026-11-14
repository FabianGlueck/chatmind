import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveDataDir, VaultLock } from '@chatmind/core';
import { serve } from '@hono/node-server';
import { createApp, type VaultHost } from './app';
import { loadEnv, loadKeys } from './keys';
import { listenerPid, portInUseMessage, watchParent } from './lifecycle';
import { canPickFolder, pickFolder } from './folder-picker';
import { openSession } from './session';
import { loadSettings, rememberDataDir } from './settings';

const invokedFrom = process.env.INIT_CWD ?? process.cwd();
const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    port: { type: 'string' },
    static: { type: 'string' },
    'no-index': { type: 'boolean' },
    // Dev only (package.json "dev"): exit when `tsx watch` dies without signalling us — see lifecycle.ts.
    'exit-with-parent': { type: 'boolean' },
  },
});

const env = await loadEnv();
const keys = await loadKeys();
const lock = new VaultLock();
const saved = await loadSettings();
// Precedence (spec vault-switcher §3): --data-dir > CHATMIND_DATA_DIR (environment or ~/.config/chatmind/env) > the UI's saved choice > default.
const flagDir = values['data-dir'] === undefined ? undefined : path.resolve(invokedFrom, values['data-dir']);
const overridden = flagDir !== undefined || !!env.CHATMIND_DATA_DIR;
const dataDir = resolveDataDir(flagDir, overridden ? env : { ...env, ...(saved.dataDir ? { CHATMIND_DATA_DIR: saved.dataDir } : {}) });
const port = Number(values.port ?? process.env.CHATMIND_PORT ?? 3210);
// `--static` is given relative to the server package (see package.json "start"), not the invoking shell.
const staticDir = values.static === undefined ? undefined : path.resolve(import.meta.dirname, '..', values.static);

const ctx = { keys, env, noIndex: !!values['no-index'], lock };
const host: VaultHost = {
  current: await openSession(dataDir, ctx),
  overridden,
  open: (dir) => openSession(dir, ctx),
  recent: async () => (await loadSettings()).recent,
  remember: async (dir) => (await rememberDataDir(dir)).recent,
  ...(canPickFolder ? { pick: pickFolder } : {}),
};

const app = createApp({ ...host.current, staticDir, keys, lock, vault: host });
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`chatmind server on http://127.0.0.1:${port}  data dir: ${dataDir}${staticDir ? `  serving ${staticDir}` : ''}`);
  console.log(`providers: ${Object.keys(keys).join(', ') || 'none (set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or MISTRAL_API_KEY, or ~/.config/chatmind/env)'}`);
  for (const line of host.current.describe) console.log(line);
  // Only once the port is ours: a second server that fails to listen must never index the vault next to the first.
  host.current.start();
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(portInUseMessage(port, listenerPid(port)));
  void host.current.close().finally(() => process.exit(1));
});

// Spec M5 §8: stop watching, let the current reconcile finish (bounded inside close()), close the db.
// `process.once` only dedupes the same signal, so a SIGTERM arriving while a SIGINT shutdown is still
// awaiting close() must not start a second, concurrent shutdown (double close, possible unhandled rejection).
// The port is released first, so a restart never races a slow reconcile; a hung close is cut off after SHUTDOWN_MS.
const SHUTDOWN_MS = 12_000;
let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  (server as { closeAllConnections?: () => void }).closeAllConnections?.(); // open SSE streams would hold it otherwise
  setTimeout(() => {
    console.error(`shutdown took over ${SHUTDOWN_MS / 1000} s — exiting anyway`);
    process.exit(1);
  }, SHUTDOWN_MS).unref();
  try {
    await host.current.close();
  } finally {
    process.exit(0);
  }
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
if (values['exit-with-parent']) {
  watchParent({
    onGone: () => {
      console.error('parent process gone — shutting down');
      void shutdown();
    },
  });
}
