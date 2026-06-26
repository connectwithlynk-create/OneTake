import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, utilityProcess } from 'electron';
import OpenAI from 'openai';
import { pathToFileURL } from 'url';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { join, resolve } from 'path';

// Electron allows exactly ONE registerSchemesAsPrivileged call per
// process — a second call replaces the first, silently stripping the
// earlier schemes' privileges. All custom schemes register here.
// The protocol.handle wiring for each runs after app.whenReady (below).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-video',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      // Lets a crossOrigin <video> CORS-fetch this scheme (needed to feed a
      // Web Audio gain node so the original audio can be boosted above 100%).
      corsEnabled: true,
    },
  },
  // capture://files/<hash>.mp4 → reads from .library/captures/<hash>.mp4
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
  // sfx://files/<filename>.mp3 → reads from resources/myinstants/audio.
  // Lets the reel-mode preview play placed SFX live (export still mixes
  // them into the final mp4 separately).
  {
    scheme: 'sfx',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

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
import { detectOverlayPattern } from './analyze/overlay-pattern';
import {
  generateEditingBrief,
  generateCollectionBrief,
  type EditingBrief,
} from './analyze/brief';
import { summarizeCaptionStyles } from './analyze/caption-style';
import { buildContentVocabulary } from './analyze/content-vocab';
import {
  loadCachedAnalysis,
  loadLibrary,
  saveLibrary,
  loadCollections,
  saveCollectionReels,
  createCollection,
  renameCollection,
  deleteCollection,
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
  loadCachedPlanMeta,
  planCacheKey,
  saveCachedPlan,
} from './analyze/plan-cache';
import { scriptToTranscriptWords } from './analyze/script-words';
import {
  estimatePlanSpokenWords,
  hydratePlanSpokenWords,
  transcriptTextScore,
} from './analyze/subtitle-backfill';
import {
  synthesize,
  type SceneAnimation,
  type SelectedMedia,
  type ShotPlan,
  type SuggestedEdit,
} from './analyze/synthesize';
import { verifyOptionLikelihoods } from './analyze/verify-options';
import { transcribeReel, type TranscriptWord } from './analyze/transcribe';
import { extractReelAudio, SAMPLE_RATE_VAD } from './analyze/audio';
import {
  continueShot,
  curate,
  researchShot,
  type CuratorClarificationRequest,
} from './curator';
import type { AgentTrace, CurationResult, MediaCandidate, ShotCuration } from './curator/types';
import {
  curationCacheKey,
  loadCachedCuration,
  saveCachedCuration,
} from './curator/curation-cache';
import { rewriteShotIdea } from './curator/rewrite-shot';
import {
  autoCaptureCuration,
  filterExistingCurationScreenshots,
} from './curator/auto-capture';
import { filterCurationRelevance } from './curator/relevance';
import { fetchReelThumbnail } from './reel-thumbnail';
import { resolveReel } from './resolver';
import { CAPTURES_DIR_PATH } from './curator/web-record';
import type { ScrollStyle } from './curator/web-record';
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
import { exportReel, type ExportProgress } from './export';
import {
  buildSfxTimeline,
  resolveSfxTimelineUrls,
  dominantCueBucket,
  resolveSfxCue,
  searchSfxLibrary,
} from './export/sfx-resolve';
import { runPlanAgent } from './agent-plan-edit';

const PREVIEW_VIDEOS_DIR_PATH = resolve(
  process.cwd(),
  '.library',
  'preview-videos',
);
const SOURCE_VIDEOS_DIR_PATH = resolve(
  process.cwd(),
  '.library',
  'source-videos',
);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Request ids whose export the user cancelled mid-run; the frame loop polls
// this between frames and aborts.
const cancelledExports = new Set<string>();

function streamVideoFileResponse(
  request: Request,
  filepath: string,
): Response {
  if (!existsSync(filepath)) return new Response('Not Found', { status: 404 });
  const stat = statSync(filepath);
  const size = stat.size;
  const range = request.headers.get('range');
  const headers = new Headers();
  headers.set('Content-Type', contentTypeForVideoPath(filepath));
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      return new Response('Range Not Satisfiable', { status: 416, headers });
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response('Range Not Satisfiable', { status: 416, headers });
    }
    const boundedEnd = Math.min(end, size - 1);
    headers.set('Content-Length', String(boundedEnd - start + 1));
    headers.set('Content-Range', `bytes ${start}-${boundedEnd}/${size}`);
    return new Response(
      Readable.toWeb(createReadStream(filepath, { start, end: boundedEnd })) as ReadableStream,
      { status: 206, headers },
    );
  }
  headers.set('Content-Length', String(size));
  return new Response(
    Readable.toWeb(createReadStream(filepath)) as ReadableStream,
    { status: 200, headers },
  );
}

// ---------- pasted media store ----------
//
// Images/videos the user pastes into the app are written to the captures
// dir (served via capture://) and tracked in a small global JSON store so
// they persist across reloads and appear in the media library for any
// plan. Global (not plan-scoped): a pasted asset is the user's own media.
interface PastedMediaEntry {
  id: string;
  url: string;
  kind: 'image' | 'video';
  mime: string;
  name: string | null;
  added_at: number;
}

interface RemixProfile {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  reel_id: string;
  source_summary: string;
  prompt_count: number;
  preference_instructions: string;
}
const PASTED_MEDIA_STORE = resolve(
  process.cwd(),
  '.library',
  'pasted-media.json',
);
const REMIX_PROFILE_STORE = resolve(
  process.cwd(),
  '.library',
  'remix-profiles.json',
);
function readPastedMediaStore(): PastedMediaEntry[] {
  try {
    if (!existsSync(PASTED_MEDIA_STORE)) return [];
    const raw = JSON.parse(readFileSync(PASTED_MEDIA_STORE, 'utf8'));
    return Array.isArray(raw) ? (raw as PastedMediaEntry[]) : [];
  } catch {
    return [];
  }
}
function writePastedMediaStore(entries: PastedMediaEntry[]): void {
  try {
    writeFileSync(PASTED_MEDIA_STORE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error(
      '[pasted-media] failed to write store:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
function extForMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
  };
  return map[mime] ?? (mime.startsWith('video/') ? 'mp4' : 'png');
}

function readRemixProfiles(): RemixProfile[] {
  try {
    if (!existsSync(REMIX_PROFILE_STORE)) return [];
    const raw = JSON.parse(readFileSync(REMIX_PROFILE_STORE, 'utf8'));
    return Array.isArray(raw) ? (raw as RemixProfile[]) : [];
  } catch {
    return [];
  }
}

function writeRemixProfiles(profiles: RemixProfile[]): void {
  mkdirSync(resolve(process.cwd(), '.library'), { recursive: true });
  writeFileSync(REMIX_PROFILE_STORE, JSON.stringify(profiles, null, 2));
}

function readPromptLogForReel(reelId: string): import('./analyze/synthesize').PromptLogEntry[] {
  try {
    const path = resolve(process.cwd(), '.library', 'prompt-log.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as import('./analyze/synthesize').PromptLogEntry;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is import('./analyze/synthesize').PromptLogEntry =>
          !!entry && entry.reel_id === reelId && !!entry.text?.trim(),
      );
  } catch {
    return [];
  }
}

function remixPreferenceInstructions(
  plan: SuggestedEdit,
  prompts: import('./analyze/synthesize').PromptLogEntry[],
): string {
  const lines: string[] = [
    'REMIX PROFILE: Reuse the saved editing preferences from this prior reel.',
    `Prior style summary: ${plan.style_summary}`,
  ];
  if (plan.subtitle_spec) {
    lines.push(
      `Subtitle preference: ${plan.subtitle_spec.preset_label || plan.subtitle_spec.preset_id}; ` +
        `${plan.subtitle_spec.position}; ${plan.subtitle_spec.chunking}; ` +
        `${plan.subtitle_spec.text_treatment}; text ${plan.subtitle_spec.text_color}; ` +
        `highlight ${plan.subtitle_spec.highlight_color ?? 'none'}.`,
    );
  }
  if (plan.sfx_override) {
    lines.push(`SFX override preference: ${JSON.stringify(plan.sfx_override)}.`);
  }
  if (plan.sfx_volume != null || plan.sfx_lead_ms != null) {
    lines.push(
      `SFX mix preference: volume ${plan.sfx_volume ?? 'default'}, lead_ms ${plan.sfx_lead_ms ?? 0}.`,
    );
  }
  if (plan.music_volume != null || plan.narration_volume != null) {
    lines.push(
      `Audio mix preference: music ${plan.music_volume ?? 'default'}, narration ${plan.narration_volume ?? 'default'}.`,
    );
  }
  const motionCounts = new Map<string, number>();
  for (const shot of plan.shots) {
    motionCounts.set(
      shot.scene_animation,
      (motionCounts.get(shot.scene_animation) ?? 0) + 1,
    );
  }
  const motion = Array.from(motionCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}:${count}`)
    .join(', ');
  if (motion) lines.push(`Motion preference by prior shot count: ${motion}.`);
  const recent = prompts
    .slice(-20)
    .map((p) => `[${p.source}${p.shot_idx != null ? ` shot ${p.shot_idx + 1}` : ''}] ${p.text}`);
  if (recent.length > 0) {
    lines.push('User prompt history to honor as preferences:');
    lines.push(...recent.map((p) => `- ${p}`));
  }
  lines.push(
    'Apply these preferences to the new target where they fit. Do not copy old subject matter unless the new target asks for it.',
  );
  return lines.join('\n');
}

// capture:// and clips:// privileges are registered in the single
// registerSchemesAsPrivileged call at the top of this file.

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
      300_000,
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
  force = false,
): Promise<
  | {
      url: string;
      analysis: ReelAnalysisResult;
      from_cache: boolean;
      caption_text?: string | null;
    }
  | { url: string; error: string }
> {
  // `force` re-runs the analyzer even when a cached result exists,
  // overwriting the cache — used by the per-reel "re-analyze" action in
  // the inspiration library so users can pick up analyzer changes (e.g.
  // new subtitle-style fields) without bumping ANALYSIS_VERSION.
  if (!force) {
    const cached = loadCachedAnalysis(url);
    if (cached) return { url, analysis: cached, from_cache: true };
  }
  const resolved = await resolveReel(url);
  if ('error' in resolved) return { url, error: resolved.error };
  try {
    const analysis = await runAnalysis({
      playableUrl: resolved.playable_url,
      durationMs: resolved.duration_ms,
    });
    // Don't cache a 0-shot analysis: that only happens when the analyzer
    // couldn't read the video (bad/expired playable URL, 0 duration with
    // a failed probe). Caching it would serve the broken empty result on
    // every later run until the cache is manually cleared. Return it so
    // the UI shows "0 shots", but leave the cache empty so the next
    // attempt re-analyzes.
    if (analysis.shots.length === 0) {
      return { url, analysis, from_cache: false };
    }
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
    return {
      url,
      analysis,
      from_cache: false,
      caption_text: resolved.caption_text,
    };
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

/** Produce transcript words plus the media duration they live on. */
async function resolveTargetWords(
  target: TargetInput | undefined,
): Promise<{ words: TranscriptWord[]; durationMs: number }> {
  if (!target) {
    throw new Error(
      'Could not recover the original target. Go back to Your video and enter the target again.',
    );
  }
  if (target.kind === 'script') {
    const text = target.text?.trim();
    if (!text) throw new Error('script text is empty');
    const words = scriptToTranscriptWords(text);
    return { words, durationMs: words[words.length - 1]?.end_ms ?? 0 };
  }
  // Both reel_url and local_video go through ffmpeg → Whisper.
  let audioSource: string;
  let resolvedDurationMs: number | null = null;
  if (target.kind === 'reel_url') {
    const resolved = await resolveReel(target.url);
    if ('error' in resolved) throw new Error(resolved.error);
    audioSource = resolved.playable_url;
    resolvedDurationMs = resolved.duration_ms;
  } else {
    audioSource = target.filePath;
  }
  const samples = await extractReelAudio(audioSource);
  if (!samples) throw new Error('audio extraction failed for target');
  const transcript = await transcribeReel(samples);
  if (!transcript) {
    throw new Error('transcription failed (need OPENAI_API_KEY)');
  }
  const audioDurationMs = Math.round((samples.length / SAMPLE_RATE_VAD) * 1000);
  return {
    words: transcript.words,
    durationMs: Math.max(
      resolvedDurationMs ?? 0,
      audioDurationMs,
      transcript.words[transcript.words.length - 1]?.end_ms ?? 0,
    ),
  };
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

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

function contentSourceKind(text: string): string {
  const t = text.toLowerCase();
  if (/\b(screen recording|website|homepage|browser|dashboard|app|ui|interface|landing page)\b/.test(t)) {
    return 'screen recordings / product UI';
  }
  if (/\b(tweet|x post|linkedin|instagram|tiktok|social|profile|post)\b/.test(t)) {
    return 'social posts / profile screenshots';
  }
  if (/\b(podcast|interview|stage|conference|talk|speaking|microphone)\b/.test(t)) {
    return 'founder/interview/stage clips';
  }
  if (/\b(photo|portrait|headshot|image|screenshot)\b/.test(t)) {
    return 'photos / screenshots';
  }
  if (/\b(product|device|robot|car|drone|prototype|hardware)\b/.test(t)) {
    return 'product or object b-roll';
  }
  if (/\b(chart|graph|map|document|paper|article|news|headline)\b/.test(t)) {
    return 'documents, articles, charts';
  }
  return 'general visual b-roll';
}

function shotStructureKind(shot: ReelAnalysisResult['shots'][number]): string {
  const text = `${shot.visual_caption ?? ''} ${shot.ocr_text ?? ''}`.toLowerCase();
  const hasOverlay = shot.overlays.length > 0;
  const overlayKinds = new Set(shot.overlays.map((o) => o.kind));
  if (/\b(top|upper)\b/.test(text) && /\b(media|image|video|screenshot|panel|half)\b/.test(text)) return 'top media layout';
  if (/\b(bottom|lower)\b/.test(text) && /\b(media|image|video|screenshot|panel|half)\b/.test(text)) return 'bottom media layout';
  if (/\b(top|bottom)\b/.test(text) && /\b(split|panel|half|above|below)\b/.test(text)) return 'top/bottom split layout';
  if (/\b(actual[\s-]*size|uncropped|contained|letterbox|full screenshot|screenshot)\b/.test(text)) return 'actual-size screenshot';
  if (/\b(screen recording|website|homepage|browser|dashboard|app|ui|interface)\b/.test(text)) return 'full-screen screen recording';
  if (hasOverlay && overlayKinds.has('pip_video')) return 'PiP overlay shot';
  if (hasOverlay) return 'overlay shot';
  if (shot.clip_type === 'talking_head' || shot.clip_type === 'talking_head_unknown') {
    return shot.face_region ? `talking-head ${shot.face_region.replace(/_/g, ' ')}` : 'talking-head full frame';
  }
  if (shot.clip_type === 'broll_talking_head') {
    return shot.face_region ? `b-roll talking ${shot.face_region.replace(/_/g, ' ')}` : 'b-roll talking full frame';
  }
  return 'full-screen b-roll';
}

function topCounts(values: string[], max = 4): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([label, count]) => `${count}/${values.length} ${label}`);
}

function buildStrictAnalysisBrief(input: {
  style: ReelAnalysisResult[];
  content: ReelAnalysisResult[];
  structure: ReelAnalysisResult[];
}): EditingBrief {
  const style = input.style.length > 0 ? input.style : [...input.content, ...input.structure];
  const content = input.content.length > 0 ? input.content : style;
  const structure = input.structure.length > 0 ? input.structure : style;

  const allStyleShots = style.flatMap((a) => a.shots);
  const allContentCaptions = content.flatMap((a) =>
    a.shots.map((s) => s.visual_caption).filter((s): s is string => !!s),
  );
  const sourceKinds = topCounts(allContentCaptions.map(contentSourceKind), 5);
  const structureLayouts = structure.map((analysis) =>
    analysis.shots.map(shotStructureKind),
  );
  const structureDirectives: string[] = [];
  for (const kinds of structureLayouts) {
    if (kinds.length === 0) continue;
    const counts = new Map<string, number>();
    for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const [dominantKind, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const total = kinds.length;
    const firstKind = kinds[0];
    const lastKind = kinds[kinds.length - 1];
    if (dominantCount >= Math.max(2, Math.ceil(total * 0.7))) {
      structureDirectives.push(`Use the repeated shot structure: ${dominantCount}/${total} shots are ${dominantKind}.`);
    }
    if (total >= 2 && dominantCount >= total - 1 && lastKind !== dominantKind) {
      structureDirectives.push(`Preserve the final-shot layout switch: last shot becomes ${lastKind}.`);
    } else if (total >= 3 && firstKind !== lastKind) {
      structureDirectives.push(`Preserve the start/end layout arc: starts as ${firstKind}, ends as ${lastKind}.`);
    }
    const overlayCount = kinds.filter((k) => /overlay/.test(k)).length;
    if (overlayCount === total) structureDirectives.push('Every shot should be treated as an overlay-style shot.');
    else if (overlayCount >= Math.ceil(total * 0.7)) structureDirectives.push(`Most shots should be overlay-style shots (${overlayCount}/${total}).`);
    structureDirectives.push(`Per-shot layout sequence to mirror: ${kinds.map((kind, i) => `shot ${i + 1} ${kind}`).join(' -> ')}.`);
  }

  const clipTypes = topCounts(
    allStyleShots.map((s) => s.clip_type.replace(/_/g, ' ')),
    4,
  );
  const textPct = style.length
    ? style.reduce((sum, a) => sum + a.text_overlay_pct, 0) / style.length
    : 0;
  const sfxPerMin = style.length
    ? style.reduce((sum, a) => sum + a.sfx_per_min, 0) / style.length
    : 0;

  return {
    summary:
      'STRICT EDIT ANALYSIS: The plan must follow these observed source, layout, structure, caption, motion, and sound patterns. Treat these as hard constraints unless the target transcript makes a specific shot impossible.',
    sections: [
      {
        title: 'Strict Content Sources',
        tag: 'mandatory source pools',
        directives: [
          sourceKinds.length > 0
            ? `Build b-roll ideas from these observed source categories: ${sourceKinds.join('; ')}.`
            : 'Build b-roll ideas from concrete, acquirable web sources.',
          'For each shot, create subject-specific ideas from these source pools; do not substitute generic stock-style visuals unless stock is explicitly enabled and the references actually use it.',
          'Each shot still needs multiple options, but the first option should match the strongest observed source category for that script beat.',
        ],
      },
      {
        title: 'Strict Shot Structure',
        tag: 'mandatory per-shot layouts',
        directives:
          structureDirectives.length > 0
            ? structureDirectives
            : ['Follow the per-shot structure from the structure references; preserve dominant layout, first-shot treatment, final-shot treatment, and overlay usage.'],
      },
      {
        title: 'Strict Style',
        tag: 'mandatory look and sound',
        directives: [
          clipTypes.length > 0 ? `Match this clip-type mix: ${clipTypes.join('; ')}.` : 'Match the detected clip-type mix.',
          `Match text/caption density around ${pct(textPct)} of shots unless the target content clearly needs fewer.`,
          `Match sound design around ${sfxPerMin.toFixed(1)} SFX/min; place hits on the same kind of moments as the references.`,
        ],
      },
    ],
    script_map: [],
    ai_generated: false,
  };
}

function mergeBriefs(generated: EditingBrief | null, strict: EditingBrief): EditingBrief {
  if (!generated) return strict;
  return {
    summary: `${strict.summary}\n${generated.summary ?? ''}`.trim(),
    sections: [...strict.sections, ...generated.sections],
    script_map: generated.script_map,
    ai_generated: generated.ai_generated,
  };
}

/** Synthesize the edit plan. Takes the hydrated library (URLs + tags +
 *  analyses) plus a target input (URL / script text / local video).
 *  Calls onProgress with milestone events + streaming chunks so the
 *  UI can show live status. */
async function synthesizePlan(
  input: {
    library: { url: string; tags: ReelTag[]; analysis: ReelAnalysisResult }[];
    target?: TargetInput;
    allowCopyrightedMedia?: boolean;
    userInstructions?: string;
    reuseLastTarget?: boolean;
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
  let target = input.target;
  if (!target && input.reuseLastTarget && lastPlanCacheKey) {
    const meta = loadCachedPlanMeta(lastPlanCacheKey);
    if (meta?.target_kind === 'reel_url' && meta.target_label.trim()) {
      target = { kind: 'reel_url', url: meta.target_label.trim() };
    } else if (
      meta?.target_kind === 'local_video' &&
      meta.target_file_path &&
      meta.target_file_path.trim()
    ) {
      target = { kind: 'local_video', filePath: meta.target_file_path };
    }
    if (!target) {
      const lastPlan = loadCachedPlan(lastPlanCacheKey);
      const text = lastPlan?.shots
        .map((shot) => shot.spoken_during.trim())
        .filter(Boolean)
        .join(' ');
      if (text) target = { kind: 'script', text };
    }
  }
  if (!target) {
    throw new Error(
      'Could not recover the original target. Go back to Your video and enter the target again.',
    );
  }
  emit({
    stage: 'transcribing',
    message:
      target.kind === 'script'
        ? 'Estimating word timestamps from script…'
        : target.kind === 'reel_url'
          ? 'Resolving + transcribing target reel…'
          : 'Extracting audio + transcribing local file…',
  });
  const { words, durationMs: targetDurationMs } = await resolveTargetWords(target);
  const targetPreviewPath =
    target.kind === 'local_video'
      ? await prepareLocalVideoPreview(target.filePath)
      : null;
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
  const contentTagged = input.library.filter((r) =>
    r.tags.includes('content_reference'),
  );
  const structureTagged = input.library.filter((r) =>
    r.tags.includes('structure_reference'),
  );
  const metricsSource = styleTagged.length > 0 ? styleTagged : input.library;
  const metrics = assembleFingerprint(metricsSource.map((r) => r.analysis));
  const vocabSource = input.library.filter((r) =>
    r.tags.includes('content_reference'),
  );
  // Subtitle/caption style is a CONTENT signal — derive it from the
  // content-tagged reels (the look we want to reproduce), not the
  // style/pacing reels. Falls back to the metrics source when no reel is
  // content-tagged so the fingerprint always carries a caption summary.
  const subtitleSource = vocabSource.length > 0 ? vocabSource : metricsSource;
  metrics.caption_style = summarizeCaptionStyles(
    subtitleSource.map((r) => r.analysis.caption_style),
  );
  const vocab = buildContentVocabulary(
    vocabSource.map((r) => ({ url: r.url, tags: r.tags, analysis: r.analysis }) as LibraryReel),
  );

  // Cache check — hash of inputs that fully determine the plan. If
  // we've synthesized this exact bundle before, return it instantly
  // and skip the LLM call.
  const allowCopyrighted = input.allowCopyrightedMedia === true;
  const userInstructions = (input.userInstructions ?? '').trim();
  const strictAnalysisBrief = buildStrictAnalysisBrief({
    style: (styleTagged.length > 0 ? styleTagged : input.library).map((r) => r.analysis),
    content: (contentTagged.length > 0 ? contentTagged : input.library).map((r) => r.analysis),
    structure: (structureTagged.length > 0 ? structureTagged : input.library).map((r) => r.analysis),
  });
  const cacheKey = planCacheKey({
    words,
    targetDurationMs,
    inspirationReels: inspiration,
    metrics,
    allowCopyrighted,
    userInstructions: `${userInstructions}\n\n[strict_edit_analysis]\n${JSON.stringify(strictAnalysisBrief)}`,
  });
  lastPlanCacheKey = cacheKey;
  let cached = loadCachedPlan(cacheKey);
  if (cached) {
    const hydrated = hydratePlanSpokenWords(cached, words);
    cached = hydrated.plan;
    if (targetPreviewPath) cached.target_video_path = targetPreviewPath;
    if (hydrated.changed || cached.target_video_path) saveCachedPlan(cacheKey, cached);
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

  // Media-overlay pattern (script-mapped) — derived from the style reels
  // and fed into the plan so overlays land where the inspiration puts
  // them. Computed only on a cache miss (the reels already key the cache),
  // so cache hits above don't pay for the LLM call. Best-effort: null when
  // there are no media overlays / no key / the call fails.
  metrics.overlay_pattern = await detectOverlayPattern(
    metricsSource.map((r) => r.analysis),
  );

  // The editing BRIEF — the analysis playbook — generated for the style
  // reels and fed into the plan so the planner follows its editorial
  // directions, not just the raw metrics. Cache-miss only (same as the
  // overlay pattern). Best-effort: null when no shots / no key.
  const generatedBrief = await generateCollectionBrief(
    metricsSource.map((r) => r.analysis),
  );
  const editingBrief = mergeBriefs(generatedBrief, strictAnalysisBrief);

  emit({
    stage: 'generating',
    message: 'Calling LLM to generate the plan…',
    received_chars: 0,
  });
  const plan = await synthesize({
    transcript: words,
    targetDurationMs,
    inspirationReels: inspiration,
    metrics,
    vocabulary: vocab,
    brief: editingBrief,
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
  if (targetPreviewPath) plan.target_video_path = targetPreviewPath;

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
    target_label: describeTarget(target),
    target_kind: target.kind,
    target_file_path:
      target.kind === 'local_video' ? target.filePath : null,
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

/** Batch picker for creating one editing project per selected file. */
async function pickVideoFiles(): Promise<string[]> {
  const result = await dialog.showOpenDialog({
    title: 'Batch upload videos or audio files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Video / audio',
        extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mp3', 'm4a', 'wav', 'aac', 'ogg'],
      },
    ],
  });
  return result.canceled ? [] : result.filePaths;
}

function localVideoUrl(filePath: string): string | null {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const encoded = Buffer.from(filePath, 'utf8').toString('base64url');
  return `local-video://file/${encoded}.mp4`;
}

async function prepareLocalVideoPreview(filePath: string): Promise<string> {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('local video path is empty');
  }
  if (!existsSync(filePath)) {
    throw new Error(`local video not found: ${filePath}`);
  }
  mkdirSync(PREVIEW_VIDEOS_DIR_PATH, { recursive: true });
  const key = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  const outPath = join(PREVIEW_VIDEOS_DIR_PATH, `${key}.mp4`);
  if (existsSync(outPath)) return outPath;

  await new Promise<void>((resolvePromise, reject) => {
    const args = [
      '-y',
      '-i',
      filePath,
      '-map',
      '0:v:0',
      '-an',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-movflags',
      '+faststart',
      outPath,
    ];
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (buf) => {
      stderr += String(buf);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && existsSync(outPath)) resolvePromise();
      else reject(new Error(`ffmpeg preview transcode failed: ${stderr}`));
    });
  });
  return outPath;
}

function filenameFromTargetLabel(label: string | undefined): string | null {
  const match = (label ?? '').match(/^File:\s*(.+)$/);
  return match?.[1]?.trim() || null;
}

function readTranscriptWordsFile(path: string): TranscriptWord[] | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const words = Array.isArray(raw?.words) ? raw.words : null;
    if (!words) return null;
    const parsed = words
      .map((word: unknown): TranscriptWord | null => {
        const candidate = word as Partial<TranscriptWord>;
        if (
          typeof candidate.text !== 'string' ||
          !Number.isFinite(candidate.start_ms) ||
          !Number.isFinite(candidate.end_ms) ||
          (candidate.end_ms ?? 0) <= (candidate.start_ms ?? 0)
        ) {
          return null;
        }
        return {
          text: candidate.text,
          start_ms: candidate.start_ms,
          end_ms: candidate.end_ms,
        } as TranscriptWord;
      })
      .filter((word: TranscriptWord | null): word is TranscriptWord => word != null);
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function findCachedTranscriptWords(plan: SuggestedEdit): TranscriptWord[] | null {
  if (!existsSync(SOURCE_VIDEOS_DIR_PATH)) return null;
  let best: { words: TranscriptWord[]; score: number } | null = null;
  for (const name of readdirSync(SOURCE_VIDEOS_DIR_PATH)) {
    if (!name.endsWith('.transcript.json')) continue;
    const words = readTranscriptWordsFile(join(SOURCE_VIDEOS_DIR_PATH, name));
    if (!words) continue;
    const score = transcriptTextScore(plan, words);
    if (!best || score > best.score) best = { words, score };
  }
  return best && best.score >= 0.65 ? best.words : null;
}

function backfillPlanSpokenWords(
  plan: SuggestedEdit,
): { plan: SuggestedEdit; changed: boolean } {
  const cachedWords = findCachedTranscriptWords(plan);
  if (cachedWords) return hydratePlanSpokenWords(plan, cachedWords);

  return hydratePlanSpokenWords(plan, estimatePlanSpokenWords(plan));
}

async function backfillTargetVideoPath(
  key: string,
  plan: SuggestedEdit,
): Promise<SuggestedEdit> {
  if (plan.target_video_path && existsSync(plan.target_video_path)) return plan;
  const meta = loadCachedPlanMeta(key);
  if (meta?.target_kind !== 'local_video') return plan;
  const filename = filenameFromTargetLabel(meta.target_label);
  if (meta.target_file_path && existsSync(meta.target_file_path)) {
    try {
      const previewPath = await prepareLocalVideoPreview(meta.target_file_path);
      return { ...plan, target_video_path: previewPath };
    } catch {
      return { ...plan, target_video_path: meta.target_file_path };
    }
  }
  if (!filename) return plan;

  // First reuse another current-version plan created from the same file.
  for (const entry of listCachedPlans()) {
    if (entry.key === key || entry.target_label !== meta.target_label) continue;
    const sibling = loadCachedPlan(entry.key);
    const p = sibling?.target_video_path;
    if (p && existsSync(p)) {
      return { ...plan, target_video_path: p };
    }
  }

  // Older sidecars only stored "File: <basename>". Try common locations.
  const candidates = [
    join(app.getPath('downloads'), filename),
    join(process.cwd(), '.library', 'source-videos', filename),
    join(process.cwd(), '.library', 'captures', filename),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const previewPath = await prepareLocalVideoPreview(candidate);
      return { ...plan, target_video_path: previewPath };
    } catch {
      return { ...plan, target_video_path: candidate };
    }
  }

  // Last pass: scan preview-videos for any existing MP4. If there is
  // exactly one, use it as best-effort for legacy single-upload sessions.
  if (existsSync(PREVIEW_VIDEOS_DIR_PATH)) {
    const previews = readdirSync(PREVIEW_VIDEOS_DIR_PATH)
      .filter((name) => name.endsWith('.mp4'))
      .map((name) => join(PREVIEW_VIDEOS_DIR_PATH, name));
    if (previews.length === 1) {
      return { ...plan, target_video_path: previews[0] };
    }
  }
  return plan;
}

type AutoAssignLibraryItem = {
  id: string;
  sourceShotIdx: number;
  media: SelectedMedia;
  title: string;
  notes: string;
};

function candidateMediaItems(
  candidate: MediaCandidate,
  sourceShotIdx: number,
  prefix: string,
): AutoAssignLibraryItem[] {
  const out: AutoAssignLibraryItem[] = [];
  const base = {
    sourceShotIdx,
    title: candidate.title ?? '',
    notes: candidate.notes ?? '',
  };
  if (candidate.auto_recording_url) {
    out.push({
      ...base,
      id: `${prefix}:recording`,
      media: {
        url: candidate.auto_recording_url,
        kind: 'video',
        origin: 'page_recording',
        from_candidate_url: candidate.url,
        reason: candidate.notes ?? null,
      },
    });
  }
  for (const [i, shot] of (candidate.auto_screenshots ?? []).entries()) {
    out.push({
      ...base,
      id: `${prefix}:screenshot:${i}`,
      title: candidate.title ? `${candidate.title} screenshot ${i + 1}` : `screenshot ${i + 1}`,
      media: {
        url: shot.image_url,
        kind: 'image',
        origin: 'page_screenshot',
        from_candidate_url: candidate.url,
        reason: candidate.notes ?? null,
      },
    });
  }
  if (out.length === 0 && candidate.source !== 'web_page') {
    out.push({
      ...base,
      id: `${prefix}:candidate`,
      media: {
        url: candidate.url,
        kind:
          candidate.source === 'web_image' || candidate.source === 'generated_image'
            ? 'image'
            : 'video',
        origin: 'original_candidate',
        from_candidate_url: candidate.url,
        reason: candidate.notes ?? null,
      },
    });
  }
  return out;
}

function buildAutoAssignLibrary(curation: CurationResult): AutoAssignLibraryItem[] {
  const seen = new Set<string>();
  const out: AutoAssignLibraryItem[] = [];
  const add = (items: AutoAssignLibraryItem[]): void => {
    for (const item of items) {
      if (seen.has(item.media.url)) continue;
      seen.add(item.media.url);
      out.push(item);
    }
  };
  for (const shot of curation.shots) {
    shot.candidates.forEach((c, i) =>
      add(candidateMediaItems(c, shot.shot_idx, `shot${shot.shot_idx}:cand${i}`)),
    );
    shot.alternatives?.forEach((alt, ai) =>
      alt.candidates.forEach((c, i) =>
        add(
          candidateMediaItems(
            { ...c, notes: c.notes ?? alt.broll_description },
            shot.shot_idx,
            `shot${shot.shot_idx}:alt${ai}:cand${i}`,
          ),
        ),
      ),
    );
  }
  return out.slice(0, 140);
}

function normalizeAnimation(value: unknown, media: SelectedMedia): SceneAnimation {
  const valid: SceneAnimation[] = [
    'none',
    'zoom_in',
    'zoom_out',
    'pan_left',
    'pan_right',
    'ken_burns',
    'punch_in',
  ];
  return valid.includes(value as SceneAnimation)
    ? (value as SceneAnimation)
    : media.kind === 'image'
      ? 'ken_burns'
      : 'zoom_in';
}

async function autoAssignMediaWithAgent(
  plan: SuggestedEdit,
  curation: CurationResult,
): Promise<SuggestedEdit> {
  const items = buildAutoAssignLibrary(curation);
  if (items.length === 0) return plan;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing; cannot run auto-assign agent.');
  const client = new OpenAI({ apiKey });
  const shots = plan.shots.map((s) => ({
    shot_idx: s.shot_idx,
    transcript: s.spoken_during,
    visual_idea: s.broll_description,
    role: s.structure_role,
    duration_s: +(s.duration_ms / 1000).toFixed(1),
  }));
  const library = items.map((item) => ({
    id: item.id,
    kind: item.media.kind,
    origin: item.media.origin,
    from_shot: item.sourceShotIdx,
    title: item.title,
    notes: item.notes,
  }));
  const resp = await client.chat.completions.create({
    model: process.env.ONETAKE_AUTO_ASSIGN_MODEL?.trim() || 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are an editing assistant. Match each shot transcript to the best available media item. Prefer semantic match over source-shot id. Avoid reusing media unless necessary. Choose motion that improves the edit. Output JSON only.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          shots,
          library,
          schema: {
            assignments: [
              {
                shot_idx: 0,
                media_id: 'library id',
                animation:
                  'none|zoom_in|zoom_out|pan_left|pan_right|ken_burns|punch_in',
                zoom_scale: 'number 1.0-1.4',
                reason: 'short rationale',
              },
            ],
          },
        }),
      },
    ],
    temperature: 0.2,
  });
  const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '{}') as {
    assignments?: Array<{
      shot_idx?: number;
      media_id?: string;
      animation?: string;
      zoom_scale?: number;
      reason?: string;
    }>;
  };
  const byId = new Map(items.map((item) => [item.id, item]));
  const assignments = new Map<number, NonNullable<typeof parsed.assignments>[number]>();
  for (const a of parsed.assignments ?? []) {
    const shotIdx = Number(a.shot_idx);
    if (!Number.isFinite(shotIdx) || !a.media_id || !byId.has(a.media_id)) continue;
    assignments.set(shotIdx, a);
  }
  return {
    ...plan,
    shots: plan.shots.map((shot) => {
      const assignment = assignments.get(shot.shot_idx);
      if (!assignment?.media_id) return shot;
      const item = byId.get(assignment.media_id);
      if (!item) return shot;
      const media = {
        ...item.media,
        reason: assignment.reason || item.media.reason,
      };
      const zoom = Number(assignment.zoom_scale);
      return {
        ...shot,
        selected_media: [media],
        scene_animation: normalizeAnimation(assignment.animation, media),
        animation_scale: media.kind === 'image' ? 1.12 : 1.05,
        animation_duration_ms: shot.duration_ms,
        animation_easing: 'ease-in-out',
        zoom_region: shot.zoom_region ?? shot.placement.position,
        zoom_scale: Number.isFinite(zoom)
          ? Math.max(1, Math.min(1.4, zoom))
          : media.kind === 'image'
            ? 1.18
            : 1.08,
      };
    }),
  };
}

function contentTypeForVideoPath(filePath: string): string {
  const ext = filePath.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.m4v') return 'video/x-m4v';
  if (ext === '.ogv') return 'video/ogg';
  return 'video/mp4';
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
      // Range-aware streaming is required for Chromium <video> metadata
      // probing and seeking. net.fetch(file://...) can serve the bytes, but
      // does not consistently honor media range requests for custom schemes.
      return streamVideoFileResponse(request, filepath);
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
      return streamVideoFileResponse(request, filepath);
    } catch (err) {
      return new Response(
        `clips handler error: ${err instanceof Error ? err.message : String(err)}`,
        { status: 500 },
      );
    }
  });

  // Serve SFX clips from resources/myinstants/audio via
  // sfx://files/<filename>.mp3 so the reel-mode preview can play them.
  protocol.handle('sfx', async (request) => {
    try {
      const url = new URL(request.url);
      const filename = url.pathname.replace(/^\/+/, '');
      if (!filename) return new Response('Bad Request', { status: 400 });
      const dir = resolve(process.cwd(), 'resources', 'myinstants', 'audio');
      const filepath = join(dir, filename);
      if (!filepath.startsWith(dir)) {
        return new Response('Forbidden', { status: 403 });
      }
      const upstream = await net.fetch(pathToFileURL(filepath).toString());
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: new Headers(upstream.headers),
      });
    } catch (err) {
      return new Response(
        `sfx handler error: ${err instanceof Error ? err.message : String(err)}`,
        { status: 500 },
      );
    }
  });

  protocol.handle('local-video', async (request) => {
    try {
      const url = new URL(request.url);
      const encoded = url.pathname.replace(/^\/+/, '').replace(/\.[a-z0-9]+$/i, '');
      const filepath = encoded
        ? Buffer.from(encoded, 'base64url').toString('utf8')
        : url.searchParams.get('path');
      if (!filepath) return new Response('Bad Request', { status: 400 });
      if (!existsSync(filepath)) return new Response('Not Found', { status: 404 });
      if (!/\.(mp4|mov|webm|mkv|avi|m4v|ogv)$/i.test(filepath)) {
        return new Response('Unsupported Media Type', { status: 415 });
      }
      const stat = statSync(filepath);
      const size = stat.size;
      const range = request.headers.get('range');
      const headers = new Headers();
      headers.set('Content-Type', contentTypeForVideoPath(filepath));
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      headers.set('Accept-Ranges', 'bytes');
      // CORS-clean so a crossOrigin <video> can feed a Web Audio gain node
      // (needed to boost the original audio above 100%) without tainting to
      // silence. Harmless for normal <video> playback.
      headers.set('Access-Control-Allow-Origin', '*');
      if (range) {
        const match = range.match(/bytes=(\d*)-(\d*)/);
        if (!match) {
          return new Response('Range Not Satisfiable', { status: 416, headers });
        }
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : size - 1;
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end < start ||
          start >= size
        ) {
          headers.set('Content-Range', `bytes */${size}`);
          return new Response('Range Not Satisfiable', { status: 416, headers });
        }
        const boundedEnd = Math.min(end, size - 1);
        headers.set('Content-Length', String(boundedEnd - start + 1));
        headers.set('Content-Range', `bytes ${start}-${boundedEnd}/${size}`);
        return new Response(
          Readable.toWeb(createReadStream(filepath, { start, end: boundedEnd })) as ReadableStream,
          { status: 206, headers },
        );
      }
      headers.set('Content-Length', String(size));
      return new Response(
        Readable.toWeb(createReadStream(filepath)) as ReadableStream,
        { status: 200, headers },
      );
    } catch (err) {
      return new Response(
        `local-video handler error: ${err instanceof Error ? err.message : String(err)}`,
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
  // Persistent prompt log — every user prompt (synthesis, plan/curate/shot
  // reprompts, command-bar) appended to .library/prompt-log.jsonl, keyed by
  // reel_id. Feeds the future per-reel "remix" profile; main-side so the
  // agent can read it back.
  const PROMPT_LOG_PATH = resolve(process.cwd(), '.library', 'prompt-log.jsonl');
  ipcMain.handle(
    'record-prompt',
    (_e, entry: import('./analyze/synthesize').PromptLogEntry) => {
      try {
        if (!entry?.text?.trim()) return false;
        mkdirSync(resolve(process.cwd(), '.library'), { recursive: true });
        appendFileSync(PROMPT_LOG_PATH, JSON.stringify(entry) + '\n');
        return true;
      } catch (err) {
        console.error('[prompt-log] write failed:', err);
        return false;
      }
    },
  );
  ipcMain.handle('get-prompt-log', (_e, reelId?: string) => {
    try {
      if (!existsSync(PROMPT_LOG_PATH)) return [];
      const rows = readFileSync(PROMPT_LOG_PATH, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((e): e is import('./analyze/synthesize').PromptLogEntry => !!e);
      return reelId ? rows.filter((e) => e.reel_id === reelId) : rows;
    } catch (err) {
      console.error('[prompt-log] read failed:', err);
      return [];
    }
  });

  ipcMain.handle('list-remix-profiles', () => {
    try {
      return readRemixProfiles();
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    'save-remix-profile',
    (
      _e,
      input: { plan: SuggestedEdit; name?: string | null },
    ): RemixProfile | { error: string } => {
      try {
        const plan = input.plan;
        if (!plan) return { error: 'Build a plan before saving a remix profile.' };
        const reelId =
          plan.reel_id ??
          `legacy-${createHash('sha1')
            .update(JSON.stringify(plan.shots ?? []))
            .digest('hex')
            .slice(0, 16)}`;
        const planForProfile: SuggestedEdit = { ...plan, reel_id: reelId };
        const prompts = readPromptLogForReel(reelId);
        const now = Date.now();
        const existing = readRemixProfiles();
        const id = reelId;
        const sourceSummary =
          plan.structure_sections[0]?.target_fill?.trim() ||
          plan.shots[0]?.spoken_during?.trim() ||
          plan.style_summary?.trim() ||
          'Working reel';
        const profile: RemixProfile = {
          id,
          name:
            input.name?.trim() ||
            sourceSummary.replace(/\s+/g, ' ').slice(0, 70) ||
            `Remix profile ${existing.length + 1}`,
          created_at: existing.find((p) => p.id === id)?.created_at ?? now,
          updated_at: now,
          reel_id: reelId,
          source_summary: sourceSummary,
          prompt_count: prompts.length,
          preference_instructions: remixPreferenceInstructions(planForProfile, prompts),
        };
        const next = [profile, ...existing.filter((p) => p.id !== id)].sort(
          (a, b) => b.updated_at - a.updated_at,
        );
        writeRemixProfiles(next);
        appendFileSync(
          PROMPT_LOG_PATH,
          JSON.stringify({
            at: now,
            reel_id: reelId,
            source: 'save_remix_profile',
            text: `Saved remix profile "${profile.name}".`,
            shot_idx: null,
          } satisfies import('./analyze/synthesize').PromptLogEntry) + '\n',
        );
        return profile;
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Resolve a free-text sound name/query to a playable sfx:// URL so the UI
  // can preview options the agent offers (and timeline markers).
  ipcMain.handle('resolve-sfx-url', (_e, query: string) => {
    const p = resolveSfxCue(query);
    return p ? `sfx://files/${p.split('/').pop()}` : null;
  });
  // Search the SFX library by free text (UI preview lists).
  ipcMain.handle('search-sfx-library', (_e, query: string) =>
    searchSfxLibrary(query, 10),
  );

  // Command-bar agent: tool-calling loop over a working copy of the plan.
  ipcMain.handle(
    'agent-edit-plan',
    (
      _e,
      arg: {
        command: string;
        plan: import('./analyze/synthesize').SuggestedEdit;
        narrationPath?: string | null;
      },
    ) => runPlanAgent(arg.command, arg.plan, arg.narrationPath ?? null),
  );
  // Build the reel's transcript-driven SFX timeline for the live preview:
  // transcribe the narration once (cached per path), place SFX on word
  // onsets per the learned cadence, and return [{ ms, url }] the preview
  // schedules against its playback clock. Shot-independent — mirrors export.
  const sfxTranscriptCache = new Map<string, TranscriptWord[]>();
  ipcMain.handle(
    'get-sfx-timeline',
    async (
      _e,
      arg: {
        narrationPath: string;
        shots: { sfx_cue: string | null; start_ms: number; duration_ms: number }[];
        sfxPlan: import('./analyze/fingerprint').SfxCollectionPattern | null;
        override?: import('./export/sfx-resolve').SfxOverride | null;
        events?: {
          ms: number;
          type: import('./analyze/sfx-classify').SfxType;
          sound?: string;
          volume?: number;
        }[] | null;
      },
    ) => {
      try {
        const { narrationPath, shots, sfxPlan, override, events } = arg;
        // Hand-edited events win — resolve them directly, no transcription.
        if (events && events.length > 0) {
          return resolveSfxTimelineUrls(
            events.map((e) => ({
              ms: e.ms,
              type: e.type,
              ...(e.sound ? { sound: e.sound } : {}),
              ...(typeof e.volume === 'number' ? { volume: e.volume } : {}),
              word: '',
              wordIndex: 0,
            })),
          );
        }
        if (!narrationPath || !existsSync(narrationPath)) return [];
        let words = sfxTranscriptCache.get(narrationPath);
        if (!words) {
          const samples = await extractReelAudio(narrationPath);
          const tr = samples ? await transcribeReel(samples) : null;
          words = tr?.words ?? [];
          sfxTranscriptCache.set(narrationPath, words);
        }
        if (words.length === 0) return [];
        const first = shots?.[0];
        const hookMs = first ? first.start_ms + first.duration_ms : 5000;
        const timeline = buildSfxTimeline(
          words,
          sfxPlan ?? null,
          hookMs,
          dominantCueBucket((shots ?? []).map((s) => s.sfx_cue)),
          override ?? null,
        );
        return resolveSfxTimelineUrls(timeline);
      } catch (err) {
        console.error(
          '[sfx-timeline] failed:',
          err instanceof Error ? err.message : String(err),
        );
        return [];
      }
    },
  );
  ipcMain.handle('analyze-reel', (_e, input: ReelAnalysisInput) =>
    runAnalysis(input),
  );
  // On-demand editing brief from a finished analysis. Pure LLM/text work
  // (no ffmpeg), so it runs in the main process rather than the analyzer
  // utilityProcess. Falls back to a deterministic brief without a key.
  ipcMain.handle(
    'generate-brief',
    (_e, input: { analysis: ReelAnalysisResult; durationMs: number }) =>
      generateEditingBrief(input.analysis, input.durationMs),
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
  // Collections: named groups of inspiration reels, each fingerprinted
  // separately for synthesis. Reels (url + tags) live in the collection;
  // analyses stay in the shared per-URL cache.
  ipcMain.handle('list-collections', () => loadCollections());
  ipcMain.handle('create-collection', (_e, name: string) =>
    createCollection(name),
  );
  ipcMain.handle('rename-collection', (_e, id: string, name: string) =>
    renameCollection(id, name),
  );
  ipcMain.handle('delete-collection', (_e, id: string) =>
    deleteCollection(id),
  );
  ipcMain.handle(
    'save-collection-reels',
    (_e, id: string, reels: { url: string; tags: ReelTag[] }[]) => {
      saveCollectionReels(
        id,
        reels.map((r) => ({ url: r.url, tags: r.tags })),
      );
    },
  );
  // Cache-only lookup so the renderer can hydrate from disk on app
  // start without triggering a (slow) analyzer pass for uncached reels.
  ipcMain.handle('load-cached-analysis', (_e, url: string) =>
    loadCachedAnalysis(url),
  );
  ipcMain.handle('hydrate-library-reel', (_e, url: string, force?: boolean) =>
    hydrateOneReel(url, force === true),
  );
  ipcMain.handle('pick-video-file', () => pickVideoFile());
  ipcMain.handle('pick-video-files', () => pickVideoFiles());
  ipcMain.handle('prepare-local-video-preview', (_e, filePath: string) =>
    prepareLocalVideoPreview(filePath),
  );
  ipcMain.handle('local-video-url', (_e, filePath: string) =>
    localVideoUrl(filePath),
  );
  // Render the current plan into a real vertical mp4: deterministic frame
  // capture (hidden render window) -> silent video, audio bed (narration +
  // ducked b-roll + SFX), then mux. Progress streams over export-progress.
  ipcMain.handle(
    'export-reel',
    async (
      e,
      input: {
        request_id: string;
        plan: SuggestedEdit;
        curation: CurationResult | null;
        fps?: number;
        target_video_url?: string | null;
        target_video_path?: string | null;
      },
    ) => {
      const { request_id, plan, curation, fps } = input;
      cancelledExports.delete(request_id);
      // Prefer the resolved target the preview uses (the plan's own
      // target_video_path is often null for non-local targets).
      const narrationPath =
        input.target_video_path || plan.target_video_path || null;
      // Renderer-loadable URL for the creator video in render shots: local
      // file path -> local-video://, else fall back to the http url.
      const targetVideoUrl = narrationPath
        ? localVideoUrl(narrationPath)
        : input.target_video_url || null;
      try {
        const result = await exportReel({
          plan,
          curation,
          targetVideoUrl,
          narrationPath,
          fps,
          shouldAbort: () => cancelledExports.has(request_id),
          onProgress: (event: ExportProgress) => {
            if (!e.sender.isDestroyed()) {
              e.sender.send('export-progress', { request_id, event });
            }
          },
        });
        return {
          ok: true as const,
          out_path: result.outPath,
          url: localVideoUrl(result.outPath),
          has_audio: result.hasAudio,
          frames: result.frames,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        cancelledExports.delete(request_id);
      }
    },
  );
  ipcMain.handle('stop-export', (_e, request_id: string) => {
    cancelledExports.add(request_id);
  });
  // Reveal a finished export in the OS file manager.
  ipcMain.handle('show-item-in-folder', (_e, filePath: string) => {
    if (typeof filePath === 'string' && existsSync(filePath)) {
      shell.showItemInFolder(filePath);
    }
  });
  // Open a suggested URL in the user's default browser (clarification
  // popup "visit" links). Restricted to http(s) so we never shell out
  // to file:// or other schemes.
  ipcMain.handle('open-external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });
  // Serve a matched caption font as a data URL so the renderer can render
  // the Subtitle-style preview in the ACTUAL font (resources/fonts/<id>.ttf,
  // downloaded by scripts/download-fonts.ts). id is validated as a bare
  // kebab slug — no path traversal. Returns null if the font isn't present.
  ipcMain.handle('get-font-data-url', async (_e, id: string) => {
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) return null;
    const { readFileSync } = await import('fs');
    const candidates = [
      resolve(process.cwd(), 'resources/fonts'),
      join(__dirname, '../../resources/fonts'),
      join(__dirname, '../../../resources/fonts'),
    ];
    for (const dir of candidates) {
      const fp = join(dir, `${id}.ttf`);
      if (existsSync(fp)) {
        try {
          return `data:font/ttf;base64,${readFileSync(fp).toString('base64')}`;
        } catch {
          return null;
        }
      }
    }
    return null;
  });
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
    async (
      _e,
      key: string,
    ): Promise<{
      plan: SuggestedEdit;
      curation: CurationResult | null;
      meta: ReturnType<typeof loadCachedPlanMeta>;
    } | null> => {
      let plan = loadCachedPlan(key);
      if (!plan) return null;
      const meta = loadCachedPlanMeta(key);
      const spokenBackfill = backfillPlanSpokenWords(plan);
      plan = spokenBackfill.plan;
      plan = await backfillTargetVideoPath(key, plan);
      if (spokenBackfill.changed || plan.target_video_path) saveCachedPlan(key, plan);
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
      return { plan, curation, meta };
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

  // Scroll style for auto-recordings is decided by the research agent
  // per candidate (MediaCandidate.recommended_scroll) — it judges the
  // page while it has it open via fetch_page. The old user prompt
  // ("How should I scroll while recording this website?") is gone.

  ipcMain.handle(
    'curate-plan',
    async (
      e,
      plan: SuggestedEdit,
      options?: { force?: boolean; userPrompt?: string },
    ) => {
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
    if (!options?.force && !seed) seed = loadCachedCuration(key);
    if (options?.force) seed = null;
    const controller = new AbortController();
    inflightCurateController = controller;
    try {
      const result = await curate(plan, {
        concurrency: 4,
        signal: controller.signal,
        existingResults: seed,
        extraUserPrompt: options?.userPrompt,
        onShotComplete: (curation, completed, total) => {
          if (!e.sender.isDestroyed()) {
            e.sender.send('curate-progress', { curation, completed, total });
          }
        },
        // Streaming partials: candidates the moment research lands,
        // then footage as each capture finishes. The renderer upserts
        // these into its curation state so clips appear live.
        onShotPartial: (curation) => {
          if (!e.sender.isDestroyed()) {
            e.sender.send('curate-shot-partial', { curation });
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

  ipcMain.handle(
    'filter-existing-screenshots',
    async (
      _e,
      input: { plan: SuggestedEdit; curation: CurationResult },
    ): Promise<CurationResult | { error: string }> => {
      try {
        const key = curationCacheKey(input.plan);
        // First drop whole candidates that are off-topic for their beat
        // (relevance gate), then re-judge the screenshots of the clips
        // that survive.
        const relevant = await filterCurationRelevance(
          input.plan,
          input.curation,
        );
        const filtered = await filterExistingCurationScreenshots(
          relevant,
          input.plan,
        );
        saveCachedCuration(key, filtered);
        lastCurationPlan = input.plan;
        lastCurationKey = key;
        lastCuration = filtered;
        return filtered;
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'auto-assign-media',
    async (
      _e,
      input: { plan: SuggestedEdit; curation: CurationResult },
    ): Promise<SuggestedEdit | { error: string }> => {
      try {
        const next = await autoAssignMediaWithAgent(input.plan, input.curation);
        if (lastPlanCacheKey) saveCachedPlan(lastPlanCacheKey, next);
        if (lastCurationKey === curationCacheKey(input.plan)) {
          lastCurationPlan = next;
        }
        return next;
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

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
        // Stream the researched candidates immediately, then each
        // candidate's footage as its capture lands.
        let partialSnapshot: ShotCuration = {
          ...curation,
          shot_idx: input.shot_idx,
        };
        if (!e.sender.isDestroyed()) {
          e.sender.send('curate-shot-partial', { curation: partialSnapshot });
        }
        const captured = await autoCaptureCuration(
          partialSnapshot,
          {
            shot_idx: input.shot_idx,
            broll_description: shot.broll_description,
            spoken_during: shot.spoken_during,
            shot_duration_ms: shot.duration_ms,
            signal: controller.signal,
            onCandidateCaptured: (candidate, candidateIdx) => {
              if (e.sender.isDestroyed()) return;
              partialSnapshot = {
                ...partialSnapshot,
                candidates: partialSnapshot.candidates.map((c, i) =>
                  i === candidateIdx ? candidate : c,
                ),
              };
              e.sender.send('curate-shot-partial', {
                curation: partialSnapshot,
              });
            },
          },
        );
        const finalCuration: ShotCuration = captured;
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

  // Add-clip: the user describes a SPECIFIC extra clip they want for a
  // shot; the curator researches exactly that and APPENDS the result to
  // the shot's existing candidates (unlike curate-shot / regenerate,
  // which replace). Streams + auto-captures like the other paths.
  ipcMain.handle(
    'add-shot-clip',
    async (
      e,
      input: { plan: SuggestedEdit; shot_idx: number; description: string },
    ): Promise<
      | { curation: ShotCuration; added: number; foundButDuplicate: boolean }
      | { error: string }
    > => {
      const description = (input.description ?? '').trim();
      if (!description) return { error: 'Describe the clip you want to add.' };
      const shot = input.plan.shots.find((s) => s.shot_idx === input.shot_idx);
      if (!shot) return { error: `Shot ${input.shot_idx} not in plan.` };
      const plan = input.plan;
      const key = curationCacheKey(plan);
      resetShotInputsIfPlanChanged(key);
      if (lastCurationKey !== key || !lastCuration) {
        lastCuration = loadCachedCuration(key) ?? {
          shots: [],
          traces: [],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          duration_ms: 0,
        };
        lastCurationKey = key;
        lastCurationPlan = plan;
      }
      const lc = lastCuration;
      const existing = lc.shots.find((s) => s.shot_idx === input.shot_idx);
      const existingCandidates = existing?.candidates ?? [];
      const canon = (raw: string): string => {
        try {
          const u = new URL(raw);
          u.hash = '';
          u.search = '';
          return u.toString().replace(/\/$/, '').toLowerCase();
        } catch {
          return raw.trim().replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
        }
      };
      // Dedupe against EVERY shot's candidates, not just this one — the
      // shared media library grid the user sees collapses duplicate
      // source pages across shots, so a clip already present anywhere
      // wouldn't show as new. Matching that here keeps the "added N"
      // count equal to what actually appears in the library.
      const seen = new Set<string>();
      for (const s of lc.shots) {
        for (const c of s?.candidates ?? []) {
          const k = canon(c.source_page || c.url);
          if (k) seen.add(k);
        }
      }

      const controller = new AbortController();
      inflightCurateController = controller;
      try {
        // Research the user's described clip. Override broll_description so
        // the agent targets exactly what was asked, and reinforce it as a
        // hard constraint via extraUserPrompt.
        const clipShot: ShotPlan = { ...shot, broll_description: description };
        const { curation, usage } = await researchShot(clipShot, plan, {
          signal: controller.signal,
          extraUserPrompt: [
            'ADD CLIP REQUEST — the user wants an ADDITIONAL specific clip for this shot.',
            `Find real web media for exactly this: "${description}".`,
            'This is the primary target and overrides the shot\'s original b-roll idea. Return 1-3 strong candidates for it.',
          ].join('\n'),
          onTurn: (event) => {
            if (!e.sender.isDestroyed()) e.sender.send('curator-turn', event);
          },
          onClarification: makeClarificationCallback(e, controller.signal),
        });
        lc.usage.input_tokens += usage.input_tokens;
        lc.usage.output_tokens += usage.output_tokens;
        lc.usage.total_tokens += usage.total_tokens;

        // Drop any newly-found candidate that duplicates one already on
        // the shot — no point recording the same page twice.
        const freshCuration: ShotCuration = {
          ...curation,
          shot_idx: input.shot_idx,
          candidates: curation.candidates.filter((c) => {
            const k = canon(c.source_page || c.url);
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
          }),
        };

        const mergedNote = existing?.research_notes
          ? `${existing.research_notes} Added clip: "${description}".`
          : `Added clip: "${description}".`;
        const buildMerged = (freshCandidates: ShotCuration['candidates']): ShotCuration => ({
          shot_idx: input.shot_idx,
          research_notes: mergedNote,
          candidates: [...existingCandidates, ...freshCandidates],
          ...(existing?.alternatives ? { alternatives: existing.alternatives } : {}),
          ...(existing?.resolved_overlays
            ? { resolved_overlays: existing.resolved_overlays }
            : {}),
          // Adding a real web clip means the shot is no longer purely
          // "uses your footage", and any prior failure is moot.
          failure_reason: null,
        });

        // Stream the merged set immediately (new candidates, footage
        // pending), then fill each new candidate's footage as it lands.
        let partial = buildMerged(freshCuration.candidates);
        if (!e.sender.isDestroyed()) {
          e.sender.send('curate-shot-partial', { curation: partial });
        }
        const captured = await autoCaptureCuration(freshCuration, {
          shot_idx: input.shot_idx,
          broll_description: description,
          spoken_during: shot.spoken_during,
          shot_duration_ms: shot.duration_ms,
          signal: controller.signal,
          onCandidateCaptured: (candidate, candidateIdx) => {
            if (e.sender.isDestroyed()) return;
            const merged = partial.candidates.slice();
            merged[existingCandidates.length + candidateIdx] = candidate;
            partial = { ...partial, candidates: merged };
            e.sender.send('curate-shot-partial', { curation: partial });
          },
        });

        const finalCuration = buildMerged(captured.candidates);
        const existingIdx = lc.shots.findIndex(
          (s) => s.shot_idx === input.shot_idx,
        );
        const finalTrace: AgentTrace = {
          shot_idx: input.shot_idx,
          turns: [],
          final_text: '',
          finished_at_turn: 0,
          reason: 'completed',
          tokens: { input: 0, output: 0, total: 0 },
        };
        if (existingIdx >= 0) {
          lc.shots[existingIdx] = finalCuration;
        } else {
          lc.shots.push(finalCuration);
          if (lc.traces) lc.traces.push(finalTrace);
        }
        if (!controller.signal.aborted) saveCachedCuration(key, lc);
        const added = captured.candidates.length;
        const foundButDuplicate =
          added === 0 && curation.candidates.length > 0;
        console.log(
          `[add-shot-clip] shot ${input.shot_idx}: agent found ${curation.candidates.length}, added ${added} new clip(s)` +
            (foundButDuplicate ? ' (all were already in the library)' : ''),
        );
        return { curation: finalCuration, added, foundButDuplicate };
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

  // Save an image/video the user pasted into the app: write the bytes to
  // the captures dir (served via capture://) and record it in the global
  // pasted-media store so it persists and shows in the media library.
  ipcMain.handle(
    'save-pasted-media',
    (
      _e,
      input: { data: string; mime: string; name?: string | null },
    ):
      | { entry: PastedMediaEntry }
      | { error: string } => {
      try {
        const mime = (input.mime || '').toLowerCase();
        if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
          return { error: `unsupported clipboard type: ${mime || '(none)'}` };
        }
        const buf = Buffer.from(input.data, 'base64');
        if (buf.length === 0) return { error: 'empty clipboard data' };
        if (!existsSync(CAPTURES_DIR_PATH)) {
          mkdirSync(CAPTURES_DIR_PATH, { recursive: true });
        }
        const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16);
        const filename = `${hash}.${extForMime(mime)}`;
        const filepath = join(CAPTURES_DIR_PATH, filename);
        if (!filepath.startsWith(CAPTURES_DIR_PATH)) {
          return { error: 'path escape' };
        }
        if (!existsSync(filepath)) writeFileSync(filepath, buf);
        const entry: PastedMediaEntry = {
          id: hash,
          url: `capture://files/${filename}`,
          kind: mime.startsWith('video/') ? 'video' : 'image',
          mime,
          name: input.name ?? null,
          added_at: Date.now(),
        };
        const store = readPastedMediaStore();
        if (!store.some((s) => s.id === entry.id)) {
          store.unshift(entry);
          writePastedMediaStore(store);
        }
        console.log(
          `[pasted-media] saved ${entry.kind} ${filename} (${buf.length} bytes)`,
        );
        return { entry };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // List previously-pasted media (drops entries whose file is gone).
  ipcMain.handle('list-pasted-media', (): PastedMediaEntry[] => {
    const store = readPastedMediaStore();
    const live = store.filter((s) => {
      const fn = s.url.replace('capture://files/', '');
      return existsSync(join(CAPTURES_DIR_PATH, fn));
    });
    if (live.length !== store.length) writePastedMediaStore(live);
    return live;
  });

  // Idea-only rewrite: changes shot concepts without requiring an
  // existing curation session or running media research.
  ipcMain.handle(
    'rewrite-shot-ideas',
    async (
      _e,
      input: {
        plan: SuggestedEdit;
        shot_idxs?: number[];
        user_prompt: string;
      },
    ): Promise<{ shots: ShotPlan[] } | { error: string }> => {
      const plan = input.plan;
      const wanted = new Set(
        input.shot_idxs ?? plan.shots.map((s) => s.shot_idx),
      );
      const userPrompt = (input.user_prompt ?? '').trim();
      try {
        const shots: ShotPlan[] = [];
        for (const shot of plan.shots) {
          if (!wanted.has(shot.shot_idx)) continue;
          const rewritten = await rewriteShotIdea(
            shot,
            plan,
            'user requested shot idea regeneration',
            { userPrompt },
          );
          if (rewritten) shots.push(rewritten);
        }
        if (shots.length === 0) {
          return {
            error:
              'No shot ideas were rewritten. Check OPENAI_API_KEY and try a more specific instruction.',
          };
        }
        return { shots };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

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
      // Look up by shot_idx, NOT array position: shot_idx is a stable key
      // and goes non-contiguous once a shot is deleted, so plan.shots[shotIdx]
      // would point at the wrong shot (or out of bounds → "not in plan").
      const shot = plan.shots.find((s) => s.shot_idx === shotIdx);
      if (!shot) return { error: `Shot ${shotIdx} not in plan.` };
      const userPrompt = (input.user_prompt ?? '').trim();
      const controller = new AbortController();
      inflightCurateController = controller;
      try {
        const reason =
          lastCuration.shots.find((s) => s?.shot_idx === shotIdx)
            ?.failure_reason ?? 'user requested regeneration';
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
        const captured = await autoCaptureCuration(
          { ...curation, shot_idx: shotIdx },
          {
            shot_idx: shotIdx,
            broll_description: shotForResearch.broll_description,
            spoken_during: shotForResearch.spoken_during,
            shot_duration_ms: shotForResearch.duration_ms,
            signal: controller.signal,
          },
        );
        const finalCuration: ShotCuration = {
          ...captured,
          rewritten_shot: rewritten ?? null,
        };
        const finalTrace: AgentTrace = { ...trace, shot_idx: shotIdx };
        // Mutate the in-memory + on-disk curation so subsequent loads
        // and regens build on the new state. Upsert by shot_idx (the
        // curation list is keyed by shot_idx, not array position).
        const lc = lastCuration;
        const existingIdx = lc.shots.findIndex((s) => s?.shot_idx === shotIdx);
        if (existingIdx >= 0) {
          lc.shots[existingIdx] = finalCuration;
          if (lc.traces) lc.traces[existingIdx] = finalTrace;
        } else {
          lc.shots.push(finalCuration);
          if (lc.traces) lc.traces.push(finalTrace);
        }
        saveCachedCuration(lastCurationKey, lc);
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
        const finalCuration: ShotCuration = await autoCaptureCuration(
          { ...curation, shot_idx: shotIdx },
          {
            shot_idx: shotIdx,
            broll_description: shot.broll_description,
            spoken_during: shot.spoken_during,
            shot_duration_ms: shot.duration_ms,
            signal: controller.signal,
          },
        );
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
