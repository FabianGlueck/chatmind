import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs: string[] = [];

/** A fresh temp dir, tracked for cleanup by `cleanupTmpDirs`. */
export async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-server-'));
  dirs.push(d);
  return d;
}

/** Remove every dir handed out by `tmpDir` so far. Call from `afterAll`. */
export async function cleanupTmpDirs(): Promise<void> {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
}
