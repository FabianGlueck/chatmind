import { resolveDataDir } from '@chatmind/core';
import { loadEnv } from '@chatmind/index';
import { loadKeys } from '@chatmind/server/keys';
import { startServer, type RunningServer } from '@chatmind/server/start';
import { DESKTOP_PORTS, onFirstFreePort } from './ports';

export interface DesktopServerOptions {
  /** The bundled web build. */
  staticDir: string;
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * Desktop spec §3: the in-process server. Settings are re-read on every start, so a restart after the
 * settings window saved picks up the new data folder, keys and indexer switch.
 */
export class DesktopServer {
  private running: RunningServer | undefined;

  constructor(private readonly o: DesktopServerOptions) {}

  get current(): RunningServer | undefined {
    return this.running;
  }

  async start(): Promise<RunningServer> {
    const env = await loadEnv();
    const keys = await loadKeys();
    const dataDir = resolveDataDir(undefined, env); // desktop spec §1: no flags, process env → key file → default
    const { staticDir, log, error } = this.o;
    this.running = await onFirstFreePort(DESKTOP_PORTS, (port) => startServer({ dataDir, port, staticDir, env, keys, log, error }));
    return this.running;
  }

  async restart(): Promise<RunningServer> {
    await this.close();
    return this.start();
  }

  async close(): Promise<void> {
    const r = this.running;
    this.running = undefined;
    await r?.close();
  }
}
