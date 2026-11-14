import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveDataDir } from '@chatmind/core';
import { loadEnv, loadKeys } from './keys';
import { listenerPid, portInUseMessage, watchParent } from './lifecycle';
import { startServer, type RunningServer } from './start';

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
// Desktop spec §1: --data-dir → process env → key file → ~/Documents/chatmind.
const dataDir = resolveDataDir(values['data-dir'] === undefined ? undefined : path.resolve(invokedFrom, values['data-dir']), env);
const port = Number(values.port ?? process.env.CHATMIND_PORT ?? 3210);
// `--static` is given relative to the server package (see package.json "start"), not the invoking shell.
const staticDir = values.static === undefined ? undefined : path.resolve(import.meta.dirname, '..', values.static);

let server: RunningServer;
try {
  server = await startServer({ dataDir, port, staticDir, noIndex: values['no-index'], env, keys: await loadKeys() });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
  console.error(portInUseMessage(port, listenerPid(port)));
  process.exit(1);
}

// Spec M5 §8: stop watching, let the current reconcile finish (bounded inside close()), close the db.
// `process.once` only dedupes the same signal, so a SIGTERM arriving while a SIGINT shutdown is still
// awaiting close() must not start a second, concurrent shutdown (double close, possible unhandled rejection).
// The port is released first, so a restart never races a slow reconcile; a hung close is cut off after SHUTDOWN_MS.
const SHUTDOWN_MS = 12_000;
let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => {
    console.error(`shutdown took over ${SHUTDOWN_MS / 1000} s — exiting anyway`);
    process.exit(1);
  }, SHUTDOWN_MS).unref();
  try {
    await server.close();
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
