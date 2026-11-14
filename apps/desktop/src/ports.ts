/** Desktop spec §1: the fixed port first (per-origin localStorage survives a relaunch), then the next few. */
export const DESKTOP_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 3211 + i);

/**
 * Calls `start` with each port in turn until one does not reject with `EADDRINUSE`. Any other error, and
 * `EADDRINUSE` on the last port, propagates.
 */
export async function onFirstFreePort<T>(ports: readonly number[], start: (port: number) => Promise<T>): Promise<T> {
  for (const [i, port] of ports.entries()) {
    try {
      return await start(port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i === ports.length - 1) throw err;
    }
  }
  throw new Error('no ports to try');
}
