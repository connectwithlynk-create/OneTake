import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Reel resolution + per-reel analysis (existing).
  resolveReel: (url: string) => ipcRenderer.invoke('resolve-reel', url),
  // Persistent per-reel prompt log (drives the future "remix" profile).
  recordPrompt: (entry: {
    at: number;
    reel_id: string;
    source: string;
    text: string;
    shot_idx?: number | null;
  }): Promise<boolean> => ipcRenderer.invoke('record-prompt', entry),
  getPromptLog: (reelId?: string): Promise<unknown[]> =>
    ipcRenderer.invoke('get-prompt-log', reelId),
  listRemixProfiles: (): Promise<unknown[]> =>
    ipcRenderer.invoke('list-remix-profiles'),
  saveRemixProfile: (input: {
    plan: unknown;
    name?: string | null;
  }): Promise<unknown> => ipcRenderer.invoke('save-remix-profile', input),
  // Preview SFX by name (returns a playable sfx:// URL).
  resolveSfxUrl: (query: string): Promise<string | null> =>
    ipcRenderer.invoke('resolve-sfx-url', query),
  searchSfxLibrary: (
    query: string,
  ): Promise<{ name: string; label: string | null; score: number }[]> =>
    ipcRenderer.invoke('search-sfx-library', query),
  // Command-bar agent: tool-calling loop; returns the plan to adopt + reply.
  agentEditPlan: (arg: {
    command: string;
    plan: unknown;
    narrationPath?: string | null;
  }): Promise<{
    plan: unknown;
    reply: string;
    actions: { kind: 'find_clip'; query: string; shot_idx: number | null }[];
    toolLog: string[];
    clarify?: { question: string; options: string[] } | null;
    sounds?: { name: string; label: string | null }[];
  }> => ipcRenderer.invoke('agent-edit-plan', arg),
  // Transcript-driven SFX timeline (shot-independent) for live preview.
  getSfxTimeline: (arg: {
    narrationPath: string;
    shots: { sfx_cue: string | null; start_ms: number; duration_ms: number }[];
    sfxPlan: unknown;
    override?: unknown;
    events?:
      | { ms: number; type: string; sound?: string; volume?: number }[]
      | null;
  }): Promise<
    {
      ms: number;
      url: string;
      word: string;
      type: string;
      sound?: string;
      volume?: number;
    }[]
  > => ipcRenderer.invoke('get-sfx-timeline', arg),
  analyzeReel: (input: { playableUrl: string; durationMs: number }) =>
    ipcRenderer.invoke('analyze-reel', input),
  generateBrief: (input: { analysis: unknown; durationMs: number }) =>
    ipcRenderer.invoke('generate-brief', input),

  // Analyze-tab history (recent analyses).
  listAnalyzeHistory: () => ipcRenderer.invoke('list-analyze-history'),
  recordAnalysis: (input: unknown) =>
    ipcRenderer.invoke('record-analysis', input),
  deleteAnalyzeHistory: (url: string) =>
    ipcRenderer.invoke('delete-analyze-history', url),

  // Inspiration → curation workflow.
  loadLibrary: () => ipcRenderer.invoke('load-library'),
  saveLibrary: (reels: unknown) => ipcRenderer.invoke('save-library', reels),
  listCollections: () => ipcRenderer.invoke('list-collections'),
  createCollection: (name: string) =>
    ipcRenderer.invoke('create-collection', name),
  renameCollection: (id: string, name: string) =>
    ipcRenderer.invoke('rename-collection', id, name),
  deleteCollection: (id: string) =>
    ipcRenderer.invoke('delete-collection', id),
  saveCollectionReels: (id: string, reels: unknown) =>
    ipcRenderer.invoke('save-collection-reels', id, reels),
  loadCachedAnalysis: (url: string) =>
    ipcRenderer.invoke('load-cached-analysis', url),
  hydrateLibraryReel: (url: string, force?: boolean) =>
    ipcRenderer.invoke('hydrate-library-reel', url, force),
  pickVideoFile: () => ipcRenderer.invoke('pick-video-file'),
  pickVideoFiles: () => ipcRenderer.invoke('pick-video-files'),
  prepareLocalVideoPreview: (filePath: string) =>
    ipcRenderer.invoke('prepare-local-video-preview', filePath),
  localVideoUrl: (filePath: string) =>
    ipcRenderer.invoke('local-video-url', filePath),
  fetchReelThumbnail: (url: string) =>
    ipcRenderer.invoke('fetch-reel-thumbnail', url),
  synthesizePlan: (input: {
    library: unknown;
    target?: unknown;
    allowCopyrightedMedia?: boolean;
    userInstructions?: string;
    reuseLastTarget?: boolean;
  }) => ipcRenderer.invoke('synthesize-plan', input),
  listCachedPlans: () => ipcRenderer.invoke('list-cached-plans'),
  loadCachedPlan: (key: string) => ipcRenderer.invoke('load-cached-plan', key),
  savePlan: (plan: unknown) => ipcRenderer.invoke('save-plan', plan),
  curatePlan: (plan: unknown, options?: { force?: boolean; userPrompt?: string }) =>
    ipcRenderer.invoke('curate-plan', plan, options),
  filterExistingScreenshots: (input: { plan: unknown; curation: unknown }) =>
    ipcRenderer.invoke('filter-existing-screenshots', input),
  autoAssignMedia: (input: { plan: unknown; curation: unknown }) =>
    ipcRenderer.invoke('auto-assign-media', input),
  stopCurate: () => ipcRenderer.invoke('stop-curate'),
  curateShot: (input: {
    plan: unknown;
    shot_idx: number;
    user_prompt?: string;
  }) => ipcRenderer.invoke('curate-shot', input),
  // Research a user-described clip and APPEND it to the shot's
  // candidates (additive — unlike curateShot/regenerate which replace).
  addShotClip: (input: {
    plan: unknown;
    shot_idx: number;
    description: string;
  }) => ipcRenderer.invoke('add-shot-clip', input),
  // Save an image/video pasted into the app to the media library.
  savePastedMedia: (input: {
    data: string;
    mime: string;
    name?: string | null;
  }) => ipcRenderer.invoke('save-pasted-media', input),
  listPastedMedia: () => ipcRenderer.invoke('list-pasted-media'),
  regenerateShot: (input: { shot_idx: number; user_prompt: string }) =>
    ipcRenderer.invoke('regenerate-shot', input),
  rewriteShotIdeas: (input: {
    plan: unknown;
    shot_idxs?: number[];
    user_prompt: string;
  }) => ipcRenderer.invoke('rewrite-shot-ideas', input),
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
  // Streaming per-shot partials: fired as soon as a shot's research
  // lands (candidates, footage pending) and again after each
  // candidate's auto-capture finishes. Supersedes nothing — the final
  // curate-progress / awaited result for the shot replaces it.
  onCurateShotPartial: (
    cb: (payload: { curation: unknown }) => void,
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { curation: unknown },
    ): void => cb(payload);
    ipcRenderer.on('curate-shot-partial', handler);
    return () => ipcRenderer.removeListener('curate-shot-partial', handler);
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
  // Open a suggested URL (clarification "visit" link) in the user's
  // default browser via the main process.
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  getFontDataUrl: (id: string) =>
    ipcRenderer.invoke('get-font-data-url', id) as Promise<string | null>,
  // Render the current plan into an mp4. Resolves with the output path + a
  // local-video:// url the renderer can play.
  exportReel: (input: {
    request_id: string;
    plan: unknown;
    curation: unknown;
    fps?: number;
    target_video_url?: string | null;
    target_video_path?: string | null;
  }) => ipcRenderer.invoke('export-reel', input),
  stopExport: (request_id: string) =>
    ipcRenderer.invoke('stop-export', request_id),
  onExportProgress: (
    cb: (payload: { request_id: string; event: unknown }) => void,
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { request_id: string; event: unknown },
    ): void => cb(payload);
    ipcRenderer.on('export-progress', handler);
    return () => ipcRenderer.removeListener('export-progress', handler);
  },
  showItemInFolder: (filePath: string) =>
    ipcRenderer.invoke('show-item-in-folder', filePath),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
