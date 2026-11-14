import { DEFAULT_DATA_DIR } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { envChanges, needsSetup, parseForm, settingsView } from '../src/config';

const FILE = '/home/u/.config/chatmind/env';

describe('settingsView (desktop spec §1)', () => {
  it('reads the file under the process env and never exposes key values', () => {
    const v = settingsView({ OPENAI_API_KEY: 'env-o' }, { ANTHROPIC_API_KEY: 'file-a', CHATMIND_DATA_DIR: '/vault', CHATMIND_NO_INDEX: '1' }, FILE);
    expect(v).toEqual({
      envFile: FILE,
      dataDir: '/vault',
      dataDirFromEnv: false,
      keys: { anthropic: { set: true, fromEnv: false }, openai: { set: true, fromEnv: true }, mistral: { set: false, fromEnv: false }, openrouter: { set: false, fromEnv: false } },
      index: false,
      indexFromEnv: false,
    });
    expect(JSON.stringify(v)).not.toMatch(/file-a|env-o/);
  });
  it('defaults the data folder and turns the indexer on when nothing is set', () => {
    const v = settingsView({}, {}, FILE);
    expect(v.dataDir).toBe(DEFAULT_DATA_DIR);
    expect(v.index).toBe(true);
    expect(needsSetup(v)).toBe(true);
  });
  it('counts an empty process value as unset, like loadEnv', () => {
    const v = settingsView({ ANTHROPIC_API_KEY: '', CHATMIND_DATA_DIR: '' }, { ANTHROPIC_API_KEY: 'a' }, FILE);
    expect(v.keys.anthropic).toEqual({ set: true, fromEnv: false });
    expect(v.dataDirFromEnv).toBe(false);
    expect(needsSetup(v)).toBe(false);
  });
});

describe('envChanges', () => {
  const view = settingsView({}, { ANTHROPIC_API_KEY: 'a', CHATMIND_DATA_DIR: '/vault' }, FILE);

  it('writes nothing for an unchanged form', () => {
    expect(envChanges({ dataDir: '/vault', keys: {}, index: true }, view)).toEqual({});
  });
  it('sets, trims and removes keys; a blank key is a removal', () => {
    expect(envChanges({ dataDir: '/vault', keys: { openai: ' sk-o ', anthropic: null, mistral: '  ' }, index: true }, view))
      .toEqual({ OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: null, MISTRAL_API_KEY: null });
  });
  it('writes a new data folder, and the default one as a removal', () => {
    expect(envChanges({ dataDir: '/other', keys: {}, index: true }, view)).toEqual({ CHATMIND_DATA_DIR: '/other' });
    expect(envChanges({ dataDir: DEFAULT_DATA_DIR, keys: {}, index: true }, view)).toEqual({ CHATMIND_DATA_DIR: null });
  });
  it('maps the indexer checkbox onto CHATMIND_NO_INDEX', () => {
    expect(envChanges({ dataDir: '/vault', keys: {}, index: false }, view)).toEqual({ CHATMIND_NO_INDEX: '1' });
    const off = settingsView({}, { CHATMIND_NO_INDEX: 'true' }, FILE);
    expect(envChanges({ dataDir: off.dataDir, keys: {}, index: true }, off)).toEqual({ CHATMIND_NO_INDEX: null });
  });
  it('leaves alone what the process env sets', () => {
    const env = settingsView({ OPENAI_API_KEY: 'e', CHATMIND_DATA_DIR: '/e', CHATMIND_NO_INDEX: '1' }, {}, FILE);
    expect(envChanges({ dataDir: '/x', keys: { openai: 'new' }, index: true }, env)).toEqual({});
  });
});

describe('parseForm', () => {
  it('keeps the known fields and rejects anything else', () => {
    expect(parseForm({ dataDir: '/v', index: true, keys: { openai: 'k', anthropic: null, other: 'x' } })).toEqual({ dataDir: '/v', index: true, keys: { openai: 'k', anthropic: null } });
    expect(parseForm(null)).toBeNull();
    expect(parseForm({ dataDir: 1, index: true, keys: {} })).toBeNull();
    expect(parseForm({ dataDir: '/v', index: 'yes', keys: {} })).toBeNull();
    expect(parseForm({ dataDir: '/v', index: true, keys: { openai: 3 } })).toBeNull();
  });
});
