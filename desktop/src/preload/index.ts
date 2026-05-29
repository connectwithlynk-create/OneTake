import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Reel resolution + per-reel analysis (existing).
  resolveReel: (url: string) => ipcRenderer.invoke('resolve-reel', url),
  analyzeReel: (input: { playableUrl: string; durationMs: number }) =>
    ipcRenderer.invoke('analyze-reel', input),

  // Analyze-tab history (recent analyses).
  listAnalyzeHistory: () => ipcRenderer.invoke('list-analyze-history'),
  recordAnalysis: (input: unknown) =>
    ipcRenderer.invoke('record-analysis', input),
  deleteAnalyzeHistory: (url: string) =>
    ipcRenderer.invoke('delete-analyze-history', url),

  // Inspiration → curation workflow.
  loadLibrary: () => ipcRenderer.invoke('load-library'),
  saveLibrary: (reels: unknown) => ipcRenderer.invoke('save-library', reels),
  loadCachedAnalysis: (url: string) =>
    ipcRenderer.invoke('load-cached-analysis', url),
  hydrateLibraryReel: (url: string) =>
    ipcRenderer.invoke('hydrate-library-reel', url),
  pickVideoFile: () => ipcRenderer.invoke('pick-video-file'),
  fetchReelThumbnail: (url: string) =>
    ipcRenderer.invoke('fetch-reel-thumbnail', url),
  synthesizePlan: (input: {
    library: unknown;
    target: unknown;
    allowCopyrightedMedia?: boolean;
    userInstructions?: string;
  }) => ipcRenderer.invoke('synthesize-plan', input),
  listCachedPlans: () => ipcRenderer.invoke('list-cached-plans'),
  loadCachedPlan: (key: string) => ipcRenderer.invoke('load-cached-plan', key),
  savePlan: (plan: unknown) => ipcRenderer.invoke('save-plan', plan),
  curatePlan: (plan: unknown) => ipcRenderer.invoke('curate-plan', plan),
  stopCurate: () => ipcRenderer.invoke('stop-curate'),
  curateShot: (input: {
    plan: unknown;
    shot_idx: number;
    user_prompt?: string;
  }) => ipcRenderer.invoke('curate-shot', input),
  regenerateShot: (input: { shot_idx: number; user_prompt: string }) =>
    ipcRenderer.invoke('regenerate-shot', input),
  continueShot: (input: { shot_idx: number; user_prompt: string }) =>
    ipcRenderer.invoke('continue-shot', input),
  extractClips: (input: {
    request_id: string;
    candidate_url: string;
    source_page?: string | null;
    shot_idx: number;
    broll_description: string;
    spoken_during: string;
    shot_duration_ms?: number | null;
    force?: boolean;
  }) => ipcRenderer.invoke('extract-clips', input),
  onExtractClipsProgress: (
    cb: (payload: { request_id: string; event: unknown }) => void,
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { request_id: string; event: unknown },
    ): void => cb(payload);
    ipcRenderer.on('extract-clips-progress', handler);
    return () => ipcRenderer.removeListener('extract-clips-progress', handler);
  },
  recordPage: (input: {
    request_id: string;
    candidate_url: string;
    shot_idx: number;
    broll_description: string;
    spoken_during: string;
    shot_duration_ms?: number | null;
  }) => ipcRenderer.invoke('record-page', input),
  onRecordPageProgress: (
    cb: (payload: { request_id: string; event: unknown }) => void,
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { request_id: string; event: unknown },
    ): void => cb(payload);
    ipcRenderer.on('record-page-progress', handler);
    return () => ipcRenderer.removeListener('record-page-progress', handler);
  },
  screenshotPage: (input: {
    request_id: string;
    candidate_url: string;
    shot_idx: number;
    broll_description: string;
  }) => ipcRenderer.invoke('screenshot-page', input),
  onScreenshotPageProgress: (
    cb: (payload: { request_id: string; event: unknown }) => void,
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { request_id: string; event: unknown },
    ): void => cb(payload);
    ipcRenderer.on('screenshot-page-progress', handler);
    return () =>
      ipcRenderer.removeListener('screenshot-page-progress', handler);
  },
  videoScreenshots: (input: {
    request_id: string;
    candidate_url: string;
    source_page?: string | null;
    shot_idx: number;
    broll_description: string;
    spoken_during: string;
    shot_duration_ms?: number | null;
    force?: boolean;
  }) => ipcRenderer.invoke('video-screenshots', input),
  onVideoScreenshotsProgress: (
    cb: (payload: { request_id: string; event: unknown }) => void,
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { request_id: string; event: unknown },
    ): void => cb(payload);
    ipcRenderer.on('video-screenshots-progress', handler);
    return () =>
      ipcRenderer.removeListener('video-screenshots-progress', handler);
  },

  // Streaming progress channels (curator + synthesizer). Each returns
  // an unsubscribe function so React effects can clean up on unmount.
  onCurateProgress: (
    cb: (payload: { curation: unknown; completed: number; total: number }) => void,
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { curation: unknown; completed: number; total: number },
    ): void => cb(payload);
    ipcRenderer.on('curate-progress', handler);
    return () => ipcRenderer.removeListener('curate-progress', handler);
  },
  onSynthesizeProgress: (cb: (payload: unknown) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown): void =>
      cb(payload);
    ipcRenderer.on('synthesize-progress', handler);
    return () => ipcRenderer.removeListener('synthesize-progress', handler);
  },
  onCuratorTurn: (cb: (payload: unknown) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown): void =>
      cb(payload);
    ipcRenderer.on('curator-turn', handler);
    return () => ipcRenderer.removeListener('curator-turn', handler);
  },
  // Curator clarification: bidirectional. The main process emits
  // 'curator-clarification-request' when the agent calls
  // ask_user_clarification; the renderer replies via
  // 'curator-clarification-reply' (invoke) once the user clicks an option.
  onCuratorClarification: (cb: (payload: unknown) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown): void =>
      cb(payload);
    ipcRenderer.on('curator-clarification-request', handler);
    return () =>
      ipcRenderer.removeListener('curator-clarification-request', handler);
  },
  replyCuratorClarification: (input: { request_id: string; answer: string }) =>
    ipcRenderer.invoke('curator-clarification-reply', input),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
