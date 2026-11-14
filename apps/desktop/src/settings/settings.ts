import type { SettingsForm, SettingsView } from '../config';
import { PROVIDERS, type ProviderId } from '../providers';
import type { SettingsApi } from './api';

// Desktop spec §1: the settings window. Key values are never shown, only whether one is set; a typed key
// replaces it, "Remove" clears it, an untouched field keeps it.
declare global {
  interface Window { chatmind: SettingsApi }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function main(): Promise<void> {
  const api = window.chatmind;
  const view: SettingsView = await api.load();
  let dataDir = view.dataDir;
  const removed = new Set<ProviderId>();
  const inputs = new Map<ProviderId, HTMLInputElement>();

  // The path is right-to-left so a long one is cut at its start; the marks keep "/" at the end where it belongs.
  const showDataDir = (p: string): void => { $('dataDir').textContent = `\u200E${p}\u200E`; $('dataDir').title = p; };
  showDataDir(dataDir);
  if (view.dataDirFromEnv) {
    $<HTMLButtonElement>('choose').disabled = true;
    $('dataHint').textContent = 'Set by the CHATMIND_DATA_DIR environment variable.';
  }
  $('choose').addEventListener('click', async () => {
    const picked = await api.chooseFolder(dataDir);
    if (picked === null) return;
    dataDir = picked;
    showDataDir(picked);
  });

  const keys = $('keys');
  for (const p of PROVIDERS) {
    const state = view.keys[p.id];
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = p.label;
    label.htmlFor = `key-${p.id}`;
    const input = document.createElement('input');
    input.type = 'password';
    input.id = `key-${p.id}`;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = state.fromEnv ? 'set by the environment' : state.set ? 'set — type to replace' : 'not set';
    input.disabled = state.fromEnv;
    inputs.set(p.id, input);
    row.append(label, input);
    if (state.set && !state.fromEnv) {
      const remove = document.createElement('button');
      remove.className = 'link';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        removed.add(p.id);
        input.value = '';
        input.placeholder = 'will be removed';
        remove.disabled = true;
      });
      input.addEventListener('input', () => {
        removed.delete(p.id);
        remove.disabled = false;
      });
      row.append(remove);
    }
    keys.append(row);
  }

  const index = $<HTMLInputElement>('index');
  index.checked = view.index;
  index.disabled = view.indexFromEnv;
  if (view.indexFromEnv) $('indexHint').textContent = 'Set by the CHATMIND_NO_INDEX environment variable.';
  $('envFile').textContent = `Saved to ${view.envFile}. Saving restarts chatmind's server.`;

  $('cancel').addEventListener('click', () => api.close());
  const save = $<HTMLButtonElement>('save');
  save.addEventListener('click', async () => {
    const form: SettingsForm = { dataDir, keys: {}, index: index.checked };
    for (const [id, input] of inputs) {
      if (removed.has(id)) form.keys[id] = null;
      else if (input.value.trim() !== '') form.keys[id] = input.value;
    }
    save.disabled = true;
    $('error').textContent = '';
    const res = await api.save(form);
    save.disabled = false;
    if (res.ok) api.close();
    else $('error').textContent = res.error;
  });
}

void main().catch((err: unknown) => { $('error').textContent = String(err); });
