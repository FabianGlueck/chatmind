import { execFile } from 'node:child_process';

/** Spec vault-switcher §2: the browser cannot hand out an absolute path, so the local server opens Finder's folder dialog. */
export const canPickFolder = process.platform === 'darwin';

const SCRIPT = ['activate', 'POSIX path of (choose folder with prompt "Choose the chatmind vault folder")'];

/** The chosen folder, or null when the user cancels (AppleScript error -128). Other failures reject. */
export function pickFolder(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile('osascript', SCRIPT.flatMap((line) => ['-e', line]), (err, stdout, stderr) => {
      if (err) return /-128/.test(stderr) ? resolve(null) : reject(new Error(stderr.trim() || err.message));
      const dir = stdout.trim().replace(/\/$/, '');
      resolve(dir === '' ? null : dir);
    });
  });
}
