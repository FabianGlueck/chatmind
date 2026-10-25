import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv, loadKeys, parseEnvFile } from '../src/keys';
import { cleanupTmpDirs, tmpDir } from './tmp';

afterAll(cleanupTmpDirs);

describe('parseEnvFile', () => {
  it('parses KEY=VALUE lines, ignores comments/blank lines, strips quotes', () => {
    expect(parseEnvFile('# c\n\nANTHROPIC_API_KEY=sk-a\nOPENAI_API_KEY="sk-o"\nOPENROUTER_API_KEY=\'sk-r\'\nBAD LINE\n')).toEqual({
      ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o', OPENROUTER_API_KEY: 'sk-r',
    });
  });
});

describe('loadKeys', () => {
  it('prefers env, falls back to the file, ignores a missing file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmind-keys-'));
    const file = path.join(dir, 'env');
    await fs.writeFile(file, 'OPENAI_API_KEY=file-o\nOPENROUTER_API_KEY=file-r\n');
    expect(await loadKeys({ ANTHROPIC_API_KEY: 'env-a', OPENAI_API_KEY: 'env-o' }, file)).toEqual({ anthropic: 'env-a', openai: 'env-o', openrouter: 'file-r' });
    expect(await loadKeys({}, path.join(dir, 'nope'))).toEqual({});
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('treats empty values as unset', async () => {
    expect(await loadKeys({ ANTHROPIC_API_KEY: '' }, '/nonexistent/env')).toEqual({});
  });
});

describe('loadEnv', () => {
  it('merges the key file under the process env and drops empty values', async () => {
    const file = path.join(await tmpDir(), 'env');
    await fs.writeFile(file, 'OPENROUTER_API_KEY=file\nCHATMIND_SUMMARY_MODEL=openai/x\n');
    const env = await loadEnv({ OPENROUTER_API_KEY: 'env', CHATMIND_EMBED_DIM: '' } as NodeJS.ProcessEnv, file);
    expect(env.OPENROUTER_API_KEY).toBe('env');
    expect(env.CHATMIND_SUMMARY_MODEL).toBe('openai/x');
    expect('CHATMIND_EMBED_DIM' in env).toBe(false);
  });
});
