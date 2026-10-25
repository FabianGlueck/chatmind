import { execFileSync } from 'node:child_process';

/**
 * Calls `onGone` once when the process is reparented (its parent died without signalling it). `tsx watch` has
 * left a server behind this way, still holding the port with no parent (2026-09-24, notes M7). Returns `stop`.
 */
export function watchParent({ ppid = () => process.ppid, onGone, everyMs = 2000 }: { ppid?: () => number; onGone: () => void; everyMs?: number }): () => void {
  const initial = ppid();
  const timer = setInterval(() => {
    if (ppid() === initial) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref(); // never keeps the process alive on its own
  return () => clearInterval(timer);
}

/** The pid listening on `port` on this machine, or null when lsof is unavailable or finds none. */
export function listenerPid(port: number): string | null {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

export function portInUseMessage(port: number, pid: string | null): string {
  return pid === null
    ? `port ${port} is already in use. Find the holder with: lsof -nP -iTCP:${port} -sTCP:LISTEN`
    : `port ${port} is already in use by pid ${pid} — probably an older chatmind server. Stop it with: kill ${pid}`;
}
