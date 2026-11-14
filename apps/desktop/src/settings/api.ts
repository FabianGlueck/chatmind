import type { SettingsForm, SettingsView } from '../config';

/** Desktop spec §1: all the settings window may do, exposed by preload.ts as `window.chatmind`. */
export interface SettingsApi {
  load(): Promise<SettingsView>;
  chooseFolder(current: string): Promise<string | null>;
  save(form: SettingsForm): Promise<{ ok: true } | { ok: false; error: string }>;
  close(): void;
}

export const CHANNELS = { load: 'settings:load', chooseFolder: 'settings:choose-folder', save: 'settings:save', close: 'settings:close' } as const;
