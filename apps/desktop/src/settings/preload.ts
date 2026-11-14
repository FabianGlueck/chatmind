import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type SettingsApi } from './api';

const api: SettingsApi = {
  load: () => ipcRenderer.invoke(CHANNELS.load),
  chooseFolder: (current) => ipcRenderer.invoke(CHANNELS.chooseFolder, current),
  save: (form) => ipcRenderer.invoke(CHANNELS.save, form),
  close: () => ipcRenderer.send(CHANNELS.close),
};
contextBridge.exposeInMainWorld('chatmind', api);
