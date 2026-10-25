import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultEnvFile, loadEnv, parseEnvFile } from '../src/env-file';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

async function fileWith(text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-env-'));
  dirs.push(dir);
  const file = path.join(dir, 'env');
  await fs.writeFile(file, text);
  return file;
}

describe('parseEnvFile', () => {
  it('parses KEY=VALUE, ignores comments and blank lines, strips quotes', () => {
    expect(parseEnvFile('# c\n\nA=1\nB="two"\nC=\'three\'\n  D = 4 \n')).toEqual({ A: '1', B: 'two', C: 'three', D: '4' });
  });
  it('ignores lines that are not an assignment to a shell-style name', () => {
    expect(parseEnvFile('novalue\n=1\nlower=x\nA-B=y\nOK=1')).toEqual({ OK: '1' });
  });
  it('keeps everything after the first = , so a value may contain one', () => {
    expect(parseEnvFile('URL=https://x/y?a=b')).toEqual({ URL: 'https://x/y?a=b' });
  });
});

describe('loadEnv', () => {
  it('merges the file under the process env and drops empty values', async () => {
    const file = await fileWith('FROM_FILE=f\nBOTH=file\nEMPTY_IN_ENV=file\n');
    expect(await loadEnv({ FROM_ENV: 'e', BOTH: 'env', EMPTY_IN_ENV: '' }, file))
      .toEqual({ FROM_FILE: 'f', FROM_ENV: 'e', BOTH: 'env', EMPTY_IN_ENV: 'file' });
  });
  it('is fine with a missing file', async () => {
    expect(await loadEnv({ A: '1' }, path.join(os.tmpdir(), 'chatmind-does-not-exist', 'env'))).toEqual({ A: '1' });
  });
  it('defaults to ~/.config/chatmind/env, resolved when it is called', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-home-'));
    dirs.push(home);
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(defaultEnvFile()).toBe(path.join(home, '.config', 'chatmind', 'env'));
      await fs.mkdir(path.join(home, '.config', 'chatmind'), { recursive: true });
      await fs.writeFile(path.join(home, '.config', 'chatmind', 'env'), 'FROM_HOME=yes\n');
      expect(await loadEnv({})).toEqual({ FROM_HOME: 'yes' });
    } finally {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    }
  });
});
