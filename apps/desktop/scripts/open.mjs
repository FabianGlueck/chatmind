// `pnpm desktop`: open the unpacked app electron-builder just made.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const release = path.resolve(import.meta.dirname, '..', 'release');
const unpacked = readdirSync(release).find((d) => /^(mac|mac-arm64|mac-universal|linux-unpacked|win-unpacked)$/.test(d));
if (!unpacked) throw new Error(`no unpacked app under ${release}`);
const dir = path.join(release, unpacked);
if (process.platform === 'darwin') execFileSync('open', [path.join(dir, 'chatmind.app')], { stdio: 'inherit' });
else if (process.platform === 'win32') execFileSync(path.join(dir, 'chatmind.exe'), { stdio: 'inherit' });
else execFileSync(path.join(dir, 'chatmind'), { stdio: 'inherit' });
