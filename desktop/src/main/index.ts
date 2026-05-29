import { app, BrowserWindow, dialog, ipcMain, net, protocol, utilityProcess } from 'electron';
import { pathToFileURL } from 'url';
import { existsSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'path';

// Load .env into process.env so OPENAI_API_KEY etc. are available to
// the main process (Whisper, synthesis, curator, vision captioning).
// CLI scripts do this via scripts/_env.ts; without doing it here the
// app silently has no API key even when the CLI works fine.
(function loadEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(__dirname, '../../.env'),
    resolve(__dirname, '../../../.env'),
    resolve(__dirname, '../../../../.env'),
  ];
  console.log('[main] cwd=', process.cwd(), 'dirname=', __dirname);
  console.log('[main] .env candidates:', candidates);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    if (
      typeof (process as { loadEnvFile?: (p: string) => void }).loadEnvFile !==
      'function'
    ) {
      console.error('[main] process.loadEnvFile not available (need Node ≥20)');
      return;
    }
    try {
      (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(
        path,
      );
      console.log('[main] loaded .env from', path);
      console.log(
        '[main] env keys present:',
        [
          'OPENAI_API_KEY',
          'ANTHROPIC_API_KEY',
          'YT_DLP_PATH',
          'YTDLP_COOKIES_FROM_BROWSER',
          'YTDLP_COOKIES_FILE',
        ]
          .map((k) => `${k}=${process.env[k] ? 'YES' : 'no'}`)
          .join(' '),
      );
      return;
    } catch (err) {
      console.error('[main] .env load failed:', err);
    }
  }
  console.warn(
    '[main] no .env found; OPENAI_API_KEY must be in the shell env',
  );
})();

import type { ReelAnalysisInput, ReelAnalysisResult } from './analyze';
import { assembleFingerprint } from './analyze/fingerprint';
import { buildContentVocabulary } from './analyze/content-vocab';
import {
  loadCachedAnalysis,
  loadLibrary,
  saveLibrary,
  type LibraryReel,
  type ReelTag,
} from './analyze/library';
import {
  listAnalyzeHistory,
  recordAnalysis,
  deleteAnalyzeHistory,
  type RecordAnalysisInput,
} from './analyze/analyze-history';
import {
  describeTarget,
  listCachedPlans,
  loadCachedPlan,
  planCacheKey,
  saveCachedPlan,
} from './analyze/plan-cache';
import { scriptToTranscriptWords } from './analyze/script-words';
import { synthesize, type SuggestedEdit } from './analyze/synthesize';
import { verifyOptionLikelihoods } from './analyze/verify-options';
import { transcribeReel, type TranscriptWord } from './analyze/transcribe';
import { extractReelAudio } from './analyze/audio';
import {
  continueShot,
  curate,
  researchShot,
  type CuratorClarificationRequest,
} from './curator';
import type { AgentTrace, CurationResult, ShotCuration } from './curator/types';
import {
  curationCacheKey,
  loadCachedCuration,
  saveCachedCuration,
} from './curator/curation-cache';
import { rewriteShotIdea } from './curator/rewrite-shot';
import { fetchReelThumbnail } from './reel-thumbnail';
import { resolveReel } from './resolver';
import { CAPTURES_DIR_PATH } from './curator/web-record';
import {
  EXTRACTED_CLIPS_DIR_PATH,
  extractClips,
  type ExtractClipsInput,
  type ExtractProgressEvent,
} from './extract-clips';
import {
  recordPage,
  type RecordPageInput,
  type RecordProgressEvent,
} from './record-page';
import {
  screenshotPage,
  type ScreenshotPageInput,
  type ScreenshotProgressEvent,
} from './screenshot-page';
import {
  videoScreenshots,
  type VideoFramesInput,
  type VideoFrameProgressEvent,
} from './video-frames';

// Register the capture:// scheme as privileged BEFORE app.whenReady so
// it can serve <video> sources with byte-range support. The actual
// protocol.handle wiring runs after app is ready (below in app.whenReady).
// capture://files/<hash>.mp4 → reads from .library/captures/<hash>.mp4
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'capture',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
  {
    scheme: 'clips',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

// Analysis (ffmpeg + tesseract.js worker threads) hangs when run on the
// main process. Run it in a utilityProcess - a clean Node child - and
// relay the result. Also keeps the UI responsive during the ~20-40s job.
function runAnalysis(input: ReelAnalysisInput): Promise<ReelAnalysisResult> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'analyzer.js'));
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    timer = setTimeout(
      () => finish(() => reject(new Error('analysis timed out'))),
      180_000,
    );
    child.on(
      'message',
      (msg: { ok: boolean; result?: unknown; error?: string }) => {
        finish(() =>
          msg?.ok
            ? resolve(msg.result as ReelAnalysisResult)
            : reject(new Error(msg?.error ?? 'analysis failed')),
        );
      },
    );
    child.on('exit', (code) => {
      finish(() => reject(new Error(`analyzer exited (code ${code})`)));
    });
    child.on('spawn', () => child.postMessage(input));
  });
}

/** Hydrate one library reel: cache hit returns immediately; otherwise
 *  resolve + run analyzer (via utilityProcess) + save to cache. The
 *  renderer drives the library-hydration loop one URL at a time so
 *  the UI can show per-reel progress. */
async function hydrateOneReel(
  url: string,
): Promise<
  | { url: string; analysis: ReelAnalysisResult; from_cache: boolean }
  | { url: string; error: string }
> {
  const cached = loadCachedAnalysis(url);
  if (cached) return { url, analysis: cached, from_cache: true };
  const resolved = await resolveReel(url);
  if ('error' in resolved) return { url, error: resolved.error };
  try {
    const analysis = await runAnalysis({
      playableUrl: resolved.playable_url,
      durationMs: resolved.duration_ms,
    });
    // ensureAnalysis's cache write lives in library.ts and runs in
    // the same Node process — but the analyzer ran in a child, so we
    // write here. (Avoids importing fs into the analyzer.)
    const { writeFileSync, existsSync, mkdirSync } = await import('fs');
    const { resolve, join } = await import('path');
    const { createHash } = await import('crypto');
    const { ANALYSIS_VERSION } = await import('./analyze');
    const CACHE_DIR = resolve(process.cwd(), '.library', 'cache');
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
    writeFileSync(
      join(CACHE_DIR, `${key}-v${ANALYSIS_VERSION}.json`),
      JSON.stringify(analysis, null, 2),
    );
    return { url, analysis, from_cache: false };
  } catch (err) {
    return {
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Discriminated target input. Three modes:
 *   - reel_url:    a hosted reel URL → resolve + extract audio + Whisper
 *   - script:      raw script text → estimate word timestamps locally
 *   - local_video: a file path picked via dialog → ffmpeg audio + Whisper
 */
export type TargetInput =
  | { kind: 'reel_url'; url: string }
  | { kind: 'script'; text: string }
  | { kind: 'local_video'; filePath: string };

/** Produce TranscriptWord[] for any target kind. */
async function resolveTargetWords(target: TargetInput): Promise<TranscriptWord[]> {
  if (target.kind === 'script') {
    const text = target.text?.trim();
    if (!text) throw new Error('script text is empty');
    return scriptToTranscriptWords(text);
  }
  // Both reel_url and local_video go through ffmpeg → Whisper.
  let audioSource: string;
  if (target.kind === 'reel_url') {
    const resolved = await resolveReel(target.url);
    if ('error' in resolved) throw new Error(resolved.error);
    audioSource = resolved.playable_url;
  } else {
    audioSource = target.filePath;
  }
  const samples = await extractReelAudio(audioSource);
  if (!samples) throw new Error('audio extraction failed for target');
  const transcript = await transcribeReel(samples);
  if (!transcript) {
    throw new Error('transcription failed (need OPENAI_API_KEY)');
  }
  return transcript.words;
}

export type SynthesizeProgress =
  | { stage: 'transcribing'; message: string }
  | { stage: 'building_context'; message: string }
  | { stage: 'cache_hit'; message: string }
  | { stage: 'generating'; message: string; received_chars: number }
  | { stage: 'verifying'; message: string }
  | { stage: 'done'; message: string };

/** Most-recently synthesized / loaded plan's cache key. The renderer
 *  doesn't know how plan cache keys are derived (input hash), so the
 *  main process tracks the key it last produced/loaded — the
 *  save-plan IPC writes back to that slot when the user edits the
 *  plan in the UI. */
let lastPlanCacheKey: string | null = null;

/** Synthesize the edit plan. Takes the hydrated library (URLs + tags +
 *  analyses) plus a target input (URL / script text / local video).
 *  Calls onProgress with milestone events + streaming chunks so the
 *  UI can show live status. */
async function synthesizePlan(
  input: {
    library: { url: string; tags: ReelTag[]; analysis: ReelAnalysisResult }[];
    target: TargetInput;
    allowCopyrightedMedia?: boolean;
    userInstructions?: string;
  },
  onProgress?: (p: SynthesizeProgress) => void,
): Promise<SuggestedEdit> {
  const emit = (p: SynthesizeProgress): void => {
    try {
      onProgress?.(p);
    } catch {
      /* progress callback failures must not break synthesis */
    }
  };
  emit({
    stage: 'transcribing',
    message:
      input.target.kind === 'script'
        ? 'Estimating word timestamps from script…'
        : input.target.kind === 'reel_url'
          ? 'Resolving + transcribing target reel…'
          : 'Extracting audio + transcribing local file…',
  });
  const words = await resolveTargetWords(input.target);
  if (words.length === 0) {
    throw new Error('target produced no transcript words');
  }
  emit({
    stage: 'building_context',
    message: `Built ${words.length}-word transcript; assembling inspiration context…`,
  });

  const inspiration = input.library.map((r) => {
    const tags: string[] = [];
    if (r.tags.includes('style_reference')) tags.push('STYLE');
    if (r.tags.includes('content_reference')) tags.push('CONTENT');
    if (r.tags.includes('structure_reference')) tags.push('STRUCTURE');
    return { url: r.url, analysis: r.analysis, tags };
  });

  const styleTagged = input.library.filter((r) =>
    r.tags.includes('style_reference'),
  );
  const metricsSource = styleTagged.length > 0 ? styleTagged : input.library;
  const metrics = assembleFingerprint(metricsSource.map((r) => r.analysis));
  const vocabSource = input.library.filter((r) =>
    r.tags.includes('content_reference'),
  );
  const vocab = buildContentVocabulary(
    vocabSource.map((r) => ({ url: r.url, tags: r.tags, analysis: r.analysis }) as LibraryReel),
  );

  // Cache check — hash of inputs that fully determine the plan. If
  // we've synthesized this exact bundle before, return it instantly
  // and skip the LLM call.
  const allowCopyrighted = input.allowCopyrightedMedia === true;
  const userInstructions = (input.userInstructions ?? '').trim();
  const cacheKey = planCacheKey({
    words,
    inspirationReels: inspiration,
    metrics,
    allowCopyrighted,
    userInstructions,
  });
  lastPlanCacheKey = cacheKey;
  const cached = loadCachedPlan(cacheKey);
  if (cached) {
    emit({
      stage: 'cache_hit',
      message: `Loaded cached plan (${cached.shots.length} shot(s)) — key ${cacheKey}.`,
    });
    emit({
      stage: 'done',
      message: `Plan ready — ${cached.shots.length} shot(s).`,
    });
    return cached;
  }

  emit({
    stage: 'generating',
    message: 'Calling LLM to generate the plan…',
    received_chars: 0,
  });
  const plan = await synthesize({
    transcript: words,
    inspirationReels: inspiration,
    metrics,
    vocabulary: vocab,
    allowCopyrightedMedia: allowCopyrighted,
    userInstructions,
    onStream: (received) => {
      emit({
        stage: 'generating',
        message: `Streaming plan from LLM…`,
        received_chars: received,
      });
    },
  });
  if (!plan) throw new Error('synthesis failed (need OPENAI_API_KEY)');

  // Verification pass — score searchable options based on actual
  // surface-level web search. Non-search methods stay null.
  emit({
    stage: 'verifying',
    message: 'Running web search to score acquirability of each option…',
  });
  await verifyOptionLikelihoods(plan, (msg) => {
    emit({ stage: 'verifying', message: msg });
  });

  saveCachedPlan(cacheKey, plan, {
    target_label: describeTarget(input.target),
    target_kind: input.target.kind,
    library_urls: input.library.map((r) => r.url),
    allow_copyrighted: allowCopyrighted,
    user_instructions: userInstructions,
  });
  emit({
    stage: 'done',
    message: `Plan ready — ${plan.shots.length} shot(s).`,
  });
  return plan;
}

/** File picker for the local-video target mode. Returns the absolute
 *  path the user picked, or null if they cancelled. */
async function pickVideoFile(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Pick a video or audio file for the target',
    properties: ['openFile'],
    filters: [
      {
        name: 'Video / audio',
        extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mp3', 'm4a', 'wav', 'aac', 'ogg'],
      },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0d0d0f',
    title: 'OneTake',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  // electron-vite sets ELECTRON_RENDERER_URL in dev (Vite dev server);
  // in a packaged build it's absent and we load the built HTML.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  // Serve recorded mp4s from .library/captures via capture://files/<hash>.mp4.
  // The path traversal guard rejects any URL that escapes CAPTURES_DIR_PATH
  // after resolution — only files inside the captures dir can be served.
  protocol.handle('capture', async (request) => {
    try {
      const url = new URL(request.url);
      // Treat host as "files"; path is /<hash>.mp4
      const filename = url.pathname.replace(/^\/+/, '');
      if (!filename) {
        return new Response('Bad Request', { status: 400 });
      }
      const filepath = join(CAPTURES_DIR_PATH, filename);
      // Guard: must stay inside CAPTURES_DIR_PATH.
      if (!filepath.startsWith(CAPTURES_DIR_PATH)) {
        return new Response('Forbidden', { status: 403 });
      }
      const upstream = await net.fetch(pathToFileURL(filepath).toString());
      // Disable browser caching: capture://files/<hash>.mp4 paths are
      // reused across re-records (same hash → same path, overwritten
      // bytes). Without no-store the renderer keeps playing the FIRST
      // recording it cached for that hash even after we've written
      // new bytes to disk — so a user re-recording after a config
      // change (e.g., mobile-mode fix) would still see the broken
      // pre-fix mp4. Force a fresh fetch every time.
      const headers = new Headers(upstream.headers);
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      headers.set('Pragma', 'no-cache');
      headers.set('Expires', '0');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (err) {
      return new Response(
        `capture handler error: ${err instanceof Error ? err.message : String(err)}`,
        { status: 500 },
      );
    }
  });

  // Serve extracted sub-clips from .library/extracted-clips via
  // clips://files/<key>/<n>.mp4. Same path-traversal guard as capture://.
  protocol.handle('clips', async (request) => {
    try {
      const url = new URL(request.url);
      const rel = url.pathname.replace(/^\/+/, '');
      if (!rel) return new Response('Bad Request', { status: 400 });
      const filepath = join(EXTRACTED_CLIPS_DIR_PATH, rel);
      if (!filepath.startsWith(EXTRACTED_CLIPS_DIR_PATH)) {
        return new Response('Forbidden', { status: 403 });
      }
      const upstream = await net.fetch(pathToFileURL(filepath).toString());
      const headers = new Headers(upstream.headers);
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (err) {
      return new Response(
        `clips handler error: ${err instanceof Error ? err.message : String(err)}`,
        { status: 500 },
      );
    }
  });

  ipcMain.handle(
    'extract-clips',
    (e, input: ExtractClipsInput & { request_id: string }) =>
      extractClips(input, (ev: ExtractProgressEvent) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send('extract-clips-progress', {
            request_id: input.request_id,
            event: ev,
          });
        }
      }),
  );

  ipcMain.handle(
    'record-page',
    (e, input: RecordPageInput & { request_id: string }) =>
      recordPage(input, (ev: RecordProgressEvent) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send('record-page-progress', {
            request_id: input.request_id,
            event: ev,
          });
        }
      }),
  );

  ipcMain.handle(
    'screenshot-page',
    (e, input: ScreenshotPageInput & { request_id: string }) =>
      screenshotPage(input, (ev: ScreenshotProgressEvent) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send('screenshot-page-progress', {
            request_id: input.request_id,
            event: ev,
          });
        }
      }),
  );

  ipcMain.handle(
    'video-screenshots',
    (e, input: VideoFramesInput & { request_id: string }) =>
      videoScreenshots(input, (ev: VideoFrameProgressEvent) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send('video-screenshots-progress', {
            request_id: input.request_id,
            event: ev,
          });
        }
      }),
  );

  ipcMain.handle('resolve-reel', (_e, url: string) => resolveReel(url));
  ipcMain.handle('analyze-reel', (_e, input: ReelAnalysisInput) =>
    runAnalysis(input),
  );

  // ---- analyze-tab history ----
  // The renderer records each completed analysis (writing the heavy
  // result to the shared cache + a lightweight history entry) and lists
  // / deletes past analyses for the "Recent analyses" panel.
  ipcMain.handle('list-analyze-history', () => listAnalyzeHistory());
  ipcMain.handle('record-analysis', (_e, input: RecordAnalysisInput) =>
    recordAnalysis(input),
  );
  ipcMain.handle('delete-analyze-history', (_e, url: string) =>
    deleteAnalyzeHistory(url),
  );

  // ---- inspiration → curation workflow ----
  // Library list (URLs + tags) persisted to .library/library.json.
  ipcMain.handle('load-library', () => loadLibrary());
  ipcMain.handle(
    'save-library',
    (_e, reels: { url: string; tags: ReelTag[] }[]) => {
      saveLibrary(reels.map((r) => ({ url: r.url, tags: r.tags })));
    },
  );
  // Cache-only lookup so the renderer can hydrate from disk on app
  // start without triggering a (slow) analyzer pass for uncached reels.
  ipcMain.handle('load-cached-analysis', (_e, url: string) =>
    loadCachedAnalysis(url),
  );
  ipcMain.handle('hydrate-library-reel', (_e, url: string) =>
    hydrateOneReel(url),
  );
  ipcMain.handle('pick-video-file', () => pickVideoFile());
  ipcMain.handle('fetch-reel-thumbnail', (_e, url: string) =>
    fetchReelThumbnail(url),
  );
  ipcMain.handle(
    'synthesize-plan',
    (e, input: Parameters<typeof synthesizePlan>[0]) =>
      synthesizePlan(input, (p) => {
        if (!e.sender.isDestroyed()) e.sender.send('synthesize-progress', p);
      }),
  );
  // Browse past synthesized plans + load one by key (so the user can
  // pick from a dropdown instead of re-running synthesis).
  ipcMain.handle('list-cached-plans', () => listCachedPlans());
  // Loading a past plan ALSO loads its companion curation when one
  // exists on disk — the curation cache is keyed by the plan's shot
  // content (curationCacheKey), so as long as the user hasn't edited
  // the plan since the curation was saved, the candidates restore
  // verbatim. Also primes the lastCuration* state so the per-shot
  // regen / "Edit result" / bulk fill-in flows work without forcing
  // a re-curate first.
  ipcMain.handle(
    'load-cached-plan',
    (
      _e,
      key: string,
    ): {
      plan: SuggestedEdit;
      curation: CurationResult | null;
    } | null => {
      const plan = loadCachedPlan(key);
      if (!plan) return null;
      lastPlanCacheKey = key;
      const cKey = curationCacheKey(plan);
      const curation = loadCachedCuration(cKey);
      // Switching to a different plan invalidates any in-memory agent
      // conversations from the previous session. Clear them so
      // "Edit result" can't resume an out-of-context chat.
      resetShotInputsIfPlanChanged(cKey);
      if (curation) {
        lastCurationPlan = plan;
        lastCurationKey = cKey;
        lastCuration = curation;
      } else {
        // No curation for this plan — clear any stale in-memory state
        // so the UI starts from a clean slate.
        lastCurationPlan = null;
        lastCurationKey = null;
        lastCuration = null;
      }
      return { plan, curation };
    },
  );
  // Persist edits the user made to the in-memory plan back to the
  // existing cache slot. Sidecar metadata is left untouched (target,
  // library, created_at don't change just because shots were edited).
  ipcMain.handle(
    'save-plan',
    (_e, plan: SuggestedEdit): { ok: boolean; error?: string } => {
      if (!lastPlanCacheKey) {
        return {
          ok: false,
          error: 'No plan in memory yet — synthesize or load one first.',
        };
      }
      try {
        saveCachedPlan(lastPlanCacheKey, plan);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
  // Session-scoped state for the running curation:
  //   - inflightCurateController: AbortController for stop-curate. Set
  //     while curate() is running, cleared on finish/error.
  //   - lastCurationPlan / lastCuration: kept so the per-shot
  //     regenerate handler can run without the renderer re-shipping the
  //     entire plan back across IPC and so we can re-save the curation
  //     cache after a regen.
  let inflightCurateController: AbortController | null = null;
  let lastCurationPlan: SuggestedEdit | null = null;
  let lastCurationKey: string | null = null;
  let lastCuration: CurationResult | null = null;
  /** Per-shot agent conversation state — stored only in memory so the
   *  "Edit result" UI can continue the same agent session with a
   *  follow-up user message instead of running a fresh agent loop.
   *  Cleared whenever the curation key changes (new plan / re-curate
   *  all). Keyed by shot_idx. */
  const shotInputs = new Map<number, unknown[]>();
  /** Reset the per-shot input map when the active curation plan
   *  changes, so a "continue" call after a new synthesis can't
   *  resurrect a stale conversation from the previous plan. */
  const resetShotInputsIfPlanChanged = (key: string): void => {
    if (lastCurationKey !== key) shotInputs.clear();
  };

  /** Pending ask_user_clarification requests, keyed by a per-request
   *  UUID. When the agent calls the tool, we send the question to the
   *  renderer and stash the promise resolver here; the renderer replies
   *  via the 'curator-clarification-reply' invoke handler which looks
   *  up the resolver and fulfils it. */
  const pendingClarifications = new Map<
    string,
    {
      resolve: (value: { answer: string }) => void;
      reject: (err: Error) => void;
    }
  >();

  ipcMain.handle(
    'curator-clarification-reply',
    (
      _e,
      input: { request_id: string; answer: string },
    ): { ok: boolean } => {
      const pending = pendingClarifications.get(input.request_id);
      if (!pending) return { ok: false };
      pendingClarifications.delete(input.request_id);
      pending.resolve({ answer: input.answer });
      return { ok: true };
    },
  );

  /** Build the per-call clarification callback that researchShot /
   *  continueShot expect. Sends the request to the renderer, parks on
   *  the resolver, and ties the wait to the AbortController so user
   *  cancel breaks out of the park. */
  function makeClarificationCallback(
    e: Electron.IpcMainInvokeEvent,
    signal: AbortSignal,
  ): (req: CuratorClarificationRequest) => Promise<{ answer: string }> {
    return (req) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        if (e.sender.isDestroyed()) {
          reject(new Error('renderer_destroyed'));
          return;
        }
        const request_id = randomUUID();
        const onAbort = (): void => {
          if (pendingClarifications.delete(request_id)) {
            reject(new Error('aborted'));
          }
        };
        pendingClarifications.set(request_id, {
          resolve: (v) => {
            signal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          reject: (err) => {
            signal.removeEventListener('abort', onAbort);
            reject(err);
          },
        });
        signal.addEventListener('abort', onAbort, { once: true });
        e.sender.send('curator-clarification-request', {
          request_id,
          shot_idx: req.shot_idx,
          question: req.question,
          options: req.options,
          reason: req.reason,
        });
      });
  }

  ipcMain.handle('curate-plan', async (e, plan: SuggestedEdit) => {
    const key = curationCacheKey(plan);
    // If the plan changed (different cache key), drop any per-shot
    // conversation state so "continue" can't resurrect a stale agent
    // session from a previous plan.
    resetShotInputsIfPlanChanged(key);
    // Pick the seed: in-memory state (which captures any per-shot
    // curations the user just ran) wins over the on-disk cache, since
    // it's the more recent. Falls back to disk when the renderer
    // restarted or no per-shot work has happened yet.
    let seed: CurationResult | null =
      lastCurationKey === key ? lastCuration : null;
    if (!seed) seed = loadCachedCuration(key);
    const controller = new AbortController();
    inflightCurateController = controller;
    try {
      const result = await curate(plan, {
        concurrency: 4,
        signal: controller.signal,
        existingResults: seed,
        onShotComplete: (curation, completed, total) => {
          if (!e.sender.isDestroyed()) {
            e.sender.send('curate-progress', { curation, completed, total });
          }
        },
        onTurn: (event) => {
          if (!e.sender.isDestroyed()) {
            e.sender.send('curator-turn', event);
          }
        },
        onClarification: makeClarificationCallback(e, controller.signal),
        onShotInput: (shotIdx, finalInput) => {
          console.log(
            `[curate-plan] stored ${finalInput.length} input items for shot ${shotIdx}`,
          );
          shotInputs.set(shotIdx, finalInput);
        },
      });
      // Only persist a complete (non-aborted) run; otherwise the cache
      // would lock in a half-run and we'd never reach a clean state.
      if (!controller.signal.aborted) {
        saveCachedCuration(key, result);
      }
      lastCurationPlan = plan;
      lastCurationKey = key;
      lastCuration = result;
      return result;
    } finally {
      if (inflightCurateController === controller) {
        inflightCurateController = null;
      }
    }
  });

  // Curate a single shot. Used when the user wants per-shot control
  // instead of bulk "Approve & curate". Updates the in-memory curation
  // state (initializing it from scratch when needed) so a subsequent
  // bulk run will skip this shot.
  ipcMain.handle(
    'curate-shot',
    async (
      e,
      input: { plan: SuggestedEdit; shot_idx: number; user_prompt?: string },
    ): Promise<{
      curation: ShotCuration;
      trace: AgentTrace;
    } | { error: string }> => {
      const plan = input.plan;
      const shot = plan.shots.find((s) => s.shot_idx === input.shot_idx);
      if (!shot) return { error: `Shot ${input.shot_idx} not in plan.` };
      const key = curationCacheKey(plan);
      resetShotInputsIfPlanChanged(key);
      // Initialize the in-memory curation if we haven't seen this plan
      // yet (first per-shot run on a fresh plan). Empty shots array;
      // it grows as the user curates individual shots.
      if (lastCurationKey !== key || !lastCuration) {
        // Try disk cache first so we don't drop prior bulk curations
        // when the renderer restarted.
        lastCuration = loadCachedCuration(key) ?? {
          shots: [],
          traces: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          duration_ms: 0,
        };
        lastCurationKey = key;
        lastCurationPlan = plan;
      }
      const controller = new AbortController();
      inflightCurateController = controller;
      try {
        const userPrompt = (input.user_prompt ?? '').trim();
        const { curation, trace, usage, final_input } = await researchShot(
          shot,
          plan,
          {
            signal: controller.signal,
            extraUserPrompt: userPrompt || undefined,
            onTurn: (event) => {
              if (!e.sender.isDestroyed()) {
                e.sender.send('curator-turn', event);
              }
            },
            onClarification: makeClarificationCallback(e, controller.signal),
          },
        );
        // Save the agent's conversation so the user can hit "Edit
        // result" later to continue this same session.
        if (final_input.length > 0) {
          console.log(
            `[curate-shot] stored ${final_input.length} input items for shot ${input.shot_idx}`,
          );
          shotInputs.set(input.shot_idx, final_input);
        } else {
          console.log(
            `[curate-shot] WARNING: empty final_input for shot ${input.shot_idx} — Edit result won't be available`,
          );
        }
        const finalCuration: ShotCuration = {
          ...curation,
          shot_idx: input.shot_idx,
        };
        const finalTrace: AgentTrace = { ...trace, shot_idx: input.shot_idx };
        const lc = lastCuration;
        // Upsert by shot_idx.
        const existingIdx = lc.shots.findIndex(
          (s) => s.shot_idx === input.shot_idx,
        );
        if (existingIdx >= 0) {
          lc.shots[existingIdx] = finalCuration;
          if (lc.traces) lc.traces[existingIdx] = finalTrace;
        } else {
          lc.shots.push(finalCuration);
          if (lc.traces) lc.traces.push(finalTrace);
        }
        lc.usage.input_tokens += usage.input_tokens;
        lc.usage.output_tokens += usage.output_tokens;
        lc.usage.total_tokens += usage.total_tokens;
        // Persist so a renderer reload picks up the partial state.
        if (!controller.signal.aborted) {
          saveCachedCuration(key, lc);
        }
        return { curation: finalCuration, trace: finalTrace };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (inflightCurateController === controller) {
          inflightCurateController = null;
        }
      }
    },
  );

  // Stop the in-flight curate run. Idempotent: no-op when nothing is
  // running. Returns true when an active controller was aborted.
  ipcMain.handle('stop-curate', () => {
    if (!inflightCurateController) return false;
    inflightCurateController.abort();
    return true;
  });

  // Per-shot regenerate: rewrite the shot's idea with the user's extra
  // prompt, then re-research it. Updates the in-memory curation +
  // re-saves the curation cache. Returns the new ShotCuration so the
  // renderer can swap it into local state.
  ipcMain.handle(
    'regenerate-shot',
    async (
      e,
      input: { shot_idx: number; user_prompt: string },
    ): Promise<{
      curation: ShotCuration;
      trace: AgentTrace;
    } | { error: string }> => {
      if (!lastCurationPlan || !lastCuration || lastCurationKey === null) {
        return { error: 'No curation in memory — run Approve & curate first.' };
      }
      const plan = lastCurationPlan;
      const shotIdx = input.shot_idx;
      const shot = plan.shots[shotIdx];
      if (!shot) return { error: `Shot ${shotIdx} not in plan.` };
      const userPrompt = (input.user_prompt ?? '').trim();
      const controller = new AbortController();
      inflightCurateController = controller;
      try {
        const reason =
          lastCuration.shots[shotIdx]?.failure_reason ??
          'user requested regeneration';
        const rewritten = await rewriteShotIdea(shot, plan, reason, {
          signal: controller.signal,
          userPrompt,
        });
        // Use the rewritten shot when the LLM produced one; otherwise
        // fall back to the original shot (still respecting the user's
        // prompt via researchShot's extraUserPrompt).
        const shotForResearch = rewritten ?? shot;
        const { curation, trace, final_input } = await researchShot(
          shotForResearch,
          plan,
          {
            signal: controller.signal,
            extraUserPrompt: userPrompt || undefined,
            onTurn: (event) => {
              if (!e.sender.isDestroyed()) {
                e.sender.send('curator-turn', {
                  ...event,
                  shot_idx: shotIdx,
                });
              }
            },
            onClarification: makeClarificationCallback(e, controller.signal),
          },
        );
        // Regenerate started a fresh agent session; replace any prior
        // stored conversation for this shot so a follow-up "Edit
        // result" continues from THIS regen, not the original.
        if (final_input.length > 0) {
          shotInputs.set(shotIdx, final_input);
        }
        const finalCuration: ShotCuration = {
          ...curation,
          shot_idx: shotIdx,
          rewritten_shot: rewritten ?? null,
        };
        const finalTrace: AgentTrace = { ...trace, shot_idx: shotIdx };
        // Mutate the in-memory + on-disk curation so subsequent loads
        // and regens build on the new state.
        lastCuration.shots[shotIdx] = finalCuration;
        if (lastCuration.traces) lastCuration.traces[shotIdx] = finalTrace;
        saveCachedCuration(lastCurationKey, lastCuration);
        return { curation: finalCuration, trace: finalTrace };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (inflightCurateController === controller) {
          inflightCurateController = null;
        }
      }
    },
  );

  // "Edit result" — continue the SAME agent conversation for a shot
  // with a follow-up user instruction, instead of running a fresh
  // session. Requires that the shot was curated at least once in this
  // process (the stored input map is in-memory only). Updates the
  // in-memory curation + saves cache + replaces the stored input so
  // subsequent edits chain off this turn.
  ipcMain.handle(
    'continue-shot',
    async (
      e,
      input: { shot_idx: number; user_prompt: string },
    ): Promise<{
      curation: ShotCuration;
      trace: AgentTrace;
    } | { error: string }> => {
      console.log(
        `[continue-shot] received shot_idx=${input.shot_idx} user_prompt="${(input.user_prompt ?? '').slice(0, 80)}"`,
      );
      console.log(
        `[continue-shot] state: lastCurationPlan=${lastCurationPlan ? 'set' : 'null'} lastCuration=${lastCuration ? `${lastCuration.shots.length} shots` : 'null'} shotInputs.size=${shotInputs.size}`,
      );
      if (!lastCurationPlan || !lastCuration || lastCurationKey === null) {
        const msg = 'No curation in memory — curate the shot first.';
        console.log(`[continue-shot] returning error: ${msg}`);
        return { error: msg };
      }
      const shotIdx = input.shot_idx;
      const shot = lastCurationPlan.shots.find((s) => s.shot_idx === shotIdx);
      if (!shot) {
        const msg = `Shot ${shotIdx} not in plan.`;
        console.log(`[continue-shot] returning error: ${msg}`);
        return { error: msg };
      }
      const prior = shotInputs.get(shotIdx);
      console.log(
        `[continue-shot] prior input for shot ${shotIdx}: ${prior ? `${prior.length} items` : 'undefined (no stored session)'}`,
      );
      if (!prior || prior.length === 0) {
        const msg =
          "No prior agent session for this shot — run 'Curate this shot' first, then 'Edit result' to continue.";
        console.log(`[continue-shot] returning error: ${msg}`);
        return { error: msg };
      }
      console.log(`[continue-shot] calling continueShot for shot ${shotIdx}…`);
      const userPrompt = (input.user_prompt ?? '').trim();
      const controller = new AbortController();
      inflightCurateController = controller;
      try {
        const { curation, trace, final_input } = await continueShot(
          shot,
          prior as Parameters<typeof continueShot>[1],
          userPrompt,
          {
            signal: controller.signal,
            onTurn: (event) => {
              if (!e.sender.isDestroyed()) {
                e.sender.send('curator-turn', {
                  ...event,
                  shot_idx: shotIdx,
                });
              }
            },
            onClarification: makeClarificationCallback(e, controller.signal),
          },
        );
        if (final_input.length > 0) {
          shotInputs.set(shotIdx, final_input);
        }
        const finalCuration: ShotCuration = { ...curation, shot_idx: shotIdx };
        const finalTrace: AgentTrace = { ...trace, shot_idx: shotIdx };
        console.log(
          `[continue-shot] completed: ${finalCuration.candidates.length} candidates, failure_reason=${finalCuration.failure_reason ?? 'null'}`,
        );
        // Upsert into lastCuration (might be partial after individual
        // shot curations — match by shot_idx, don't trust positional).
        const existingIdx = lastCuration.shots.findIndex(
          (s) => s.shot_idx === shotIdx,
        );
        if (existingIdx >= 0) {
          lastCuration.shots[existingIdx] = finalCuration;
          if (lastCuration.traces) lastCuration.traces[existingIdx] = finalTrace;
        } else {
          lastCuration.shots.push(finalCuration);
          if (lastCuration.traces) lastCuration.traces.push(finalTrace);
        }
        if (!controller.signal.aborted) {
          saveCachedCuration(lastCurationKey, lastCuration);
        }
        return { curation: finalCuration, trace: finalTrace };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[continue-shot] threw: ${msg}`);
        return { error: msg };
      } finally {
        if (inflightCurateController === controller) {
          inflightCurateController = null;
        }
      }
    },
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
