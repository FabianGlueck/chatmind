import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/start';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

const quiet = { log: () => undefined, error: () => undefined };

describe('startServer (desktop spec §2)', () => {
  it('serves the API on a free port, and close() frees it and may be called twice', async () => {
    const dataDir = await tmpDir();
    const s = await startServer({ dataDir, port: 0, noIndex: true, env: {}, keys: {}, ...quiet });
    expect(s.port).toBeGreaterThan(0);
    expect(s.dataDir).toBe(dataDir);
    const res = await fetch(`http://127.0.0.1:${s.port}/api/canvases`);
    expect(res.status).toBe(200);
    await s.close();
    await s.close();
    await expect(fetch(`http://127.0.0.1:${s.port}/api/canvases`)).rejects.toThrow();
  });

  it('rejects with EADDRINUSE when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(startServer({ dataDir: await tmpDir(), port, noIndex: true, env: {}, keys: {}, ...quiet })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      blocker.close();
    }
  });

  it('names why the indexer is off', async () => {
    const lines: string[] = [];
    const s = await startServer({ dataDir: await tmpDir(), port: 0, env: {}, keys: {}, log: (l) => lines.push(l), error: () => undefined });
    await s.close();
    expect(lines).toContain('index: off (no OPENROUTER_API_KEY)');
  });
});
