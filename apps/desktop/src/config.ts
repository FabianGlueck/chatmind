import { DEFAULT_DATA_DIR, resolveDataDir } from '@chatmind/core';
import { PROVIDERS, type ProviderId } from './providers';

export { PROVIDERS, type ProviderId } from './providers';

/** What the settings window shows. Key values never leave the main process, only whether one is set. */
export interface SettingsView {
  envFile: string;
  dataDir: string;
  dataDirFromEnv: boolean;
  keys: Record<ProviderId, { set: boolean; fromEnv: boolean }>;
  index: boolean;
  indexFromEnv: boolean;
}

/** What the settings window sends back. A key: string = set, null = remove, absent = keep. */
export interface SettingsForm {
  dataDir: string;
  keys: Partial<Record<ProviderId, string | null>>;
  index: boolean;
}

const has = (env: Record<string, string | undefined>, name: string): boolean => (env[name] ?? '') !== '';
const noIndex = (v: string | undefined): boolean => v === '1' || v === 'true'; // as indexSettings reads it

/** The view for `processEnv` over `fileEnv` — the process env wins, as in `loadEnv`. */
export function settingsView(processEnv: Record<string, string | undefined>, fileEnv: Record<string, string>, envFile: string): SettingsView {
  const merged: Record<string, string> = { ...fileEnv };
  for (const [k, v] of Object.entries(processEnv)) if (v) merged[k] = v;
  const keys = Object.fromEntries(PROVIDERS.map((p) => [p.id, { set: has(merged, p.env), fromEnv: has(processEnv, p.env) }])) as SettingsView['keys'];
  return {
    envFile,
    dataDir: resolveDataDir(undefined, merged),
    dataDirFromEnv: has(processEnv, 'CHATMIND_DATA_DIR'),
    keys,
    index: !noIndex(merged.CHATMIND_NO_INDEX),
    indexFromEnv: has(processEnv, 'CHATMIND_NO_INDEX'),
  };
}

/**
 * The key-file changes for `form` against `view`. Fields the process env sets are left alone (the file
 * value would be shadowed anyway); an unchanged field writes nothing. The default data folder is written
 * as a removal, so the file stays minimal.
 */
export function envChanges(form: SettingsForm, view: SettingsView): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const dataDir = form.dataDir.trim();
  if (!view.dataDirFromEnv && dataDir !== '' && dataDir !== view.dataDir) out.CHATMIND_DATA_DIR = dataDir === DEFAULT_DATA_DIR ? null : dataDir;
  for (const p of PROVIDERS) {
    const v = form.keys[p.id];
    if (v === undefined || view.keys[p.id].fromEnv) continue;
    const trimmed = v?.trim() ?? null;
    out[p.env] = trimmed === '' ? null : trimmed;
  }
  if (!view.indexFromEnv && form.index !== view.index) out.CHATMIND_NO_INDEX = form.index ? null : '1';
  return out;
}

/** First launch: no provider key at all, so the composer would list no model. */
export function needsSetup(view: SettingsView): boolean {
  return !PROVIDERS.some((p) => view.keys[p.id].set);
}

/** The form as it arrives over IPC: anything else than the expected shape is null. */
export function parseForm(raw: unknown): SettingsForm | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.dataDir !== 'string' || typeof r.index !== 'boolean' || typeof r.keys !== 'object' || r.keys === null) return null;
  const keys: SettingsForm['keys'] = {};
  for (const p of PROVIDERS) {
    const v = (r.keys as Record<string, unknown>)[p.id];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string') return null;
    keys[p.id] = v;
  }
  return { dataDir: r.dataDir, keys, index: r.index };
}
