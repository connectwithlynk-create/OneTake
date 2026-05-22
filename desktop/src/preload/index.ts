import { contextBridge, ipcRenderer } from 'electron';

const api = {
  resolveReel: (url: string) => ipcRenderer.invoke('resolve-reel', url),
  analyzeReel: (input: { playableUrl: string; durationMs: number }) =>
    ipcRenderer.invoke('analyze-reel', input),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
