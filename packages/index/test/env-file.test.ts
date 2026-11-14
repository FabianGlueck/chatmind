import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultEnvFile, loadEnv, parseEnvFile, updateEnvFile, writeEnvFile } from '../src/env-file';

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

describe('updateEnvFile (desktop spec §1)', () => {
  it('replaces in place, appends new keys, removes null ones, keeps comments and other keys', () => {
    const text = '# my keys\nANTHROPIC_API_KEY=old\n\nCHATMIND_TOPIC_T=0.4\nCHATMIND_NO_INDEX=1\n';
    expect(updateEnvFile(text, { ANTHROPIC_API_KEY: 'new', CHATMIND_NO_INDEX: null, OPENAI_API_KEY: 'o' }))
      .toBe('# my keys\nANTHROPIC_API_KEY=new\n\nCHATMIND_TOPIC_T=0.4\nOPENAI_API_KEY=o\n');
  });
  it('collapses duplicates of a changed key into its first line and leaves commented-out lines alone', () => {
    expect(updateEnvFile('#A=c\nA=1\nB=2\nA=3\n', { A: 'x' })).toBe('#A=c\nA=x\nB=2\n');
  });
  it('starts from an empty file and ends empty when everything goes', () => {
    expect(updateEnvFile('', { A: '1' })).toBe('A=1\n');
    expect(updateEnvFile('A=1\n', { A: null })).toBe('');
    expect(updateEnvFile('', { A: null })).toBe('');
  });
  it('quotes what parseEnvFile would trim or unquote, so every value reads back unchanged', () => {
    for (const v of [' lead', 'trail ', '"quoted"', "'single'", 'a=b#c', '/Users/x/My Vault', '']) {
      expect(parseEnvFile(updateEnvFile('', { K: v })).K ?? '').toBe(v);
    }
  });
  it('rejects invalid keys and multi-line values', () => {
    expect(() => updateEnvFile('', { lower: 'x' })).toThrow(/invalid key/);
    expect(() => updateEnvFile('', { A: 'x\ny' })).toThrow(/single line/);
  });
});

describe('writeEnvFile', () => {
  it('creates the folder and a 0600 file, and tightens an existing one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-envw-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'env');
    await writeEnvFile({ A: '1' }, file);
    expect(await fs.readFile(file, 'utf8')).toBe('A=1\n');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await fs.chmod(file, 0o644);
    await writeEnvFile({ B: '2' }, file);
    expect(await fs.readFile(file, 'utf8')).toBe('A=1\nB=2\n');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
