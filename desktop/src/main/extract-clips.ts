// Extract relevant sub-clips from a third-party web_video candidate
// (YouTube / Vimeo / TikTok / Instagram / etc.) so the editor can drop
// them into a planned shot. Pipeline:
//   1. yt-dlp downloads the full mp4 to .library/source-videos/<hash>.mp4
//   2. extractReelAudio → Whisper transcribeReel produces word-level
//      timestamps (cached as JSON next to the mp4).
//   3. gpt-4o-mini ranks the transcript and returns up to N {start_ms,
//      end_ms, reason} ranges most relevant to the shot's broll +
//      spoken_during.
//   4. detectScenes finds cut boundaries; each picked range's edges
//      are snapped to the nearest cut within ±1s for a clean trim.
//   5. ffmpeg slices each range into .library/extracted-clips/<key>/<i>.mp4.
// All stages cache on disk; re-clicking the button is fast.

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';
import OpenAI from 'openai';
import { extractReelAudio } from './analyze/audio';
import { detectScenes } from './analyze/scene-detect';
import { transcribeReel, type TranscriptWord } from './analyze/transcribe';
import { CAPTURES_DIR_PATH, isVideoHostUrl } from './curator/web-record';

const execFileAsync = promisify(execFile);

const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const SOURCE_VIDEOS_DIR = resolve(process.cwd(), '.library', 'source-videos');
const EXTRACTED_CLIPS_DIR = resolve(process.cwd(), '.library', 'extracted-clips');

const MAX_CLIPS = 5;
const MIN_CLIP_MS = 3000;
const MAX_CLIP_MS = 10000;
// Window the LLM gets to play with when snapping clip edges to scene cuts.
const SCENE_SNAP_TOLERANCE_MS = 1000;

const RANK_MODEL = 'gpt-4o-mini';

export interface ExtractedClip {
  /** Stable ID derived from the source mp4 hash + index. */
  clip_id: string;
  /** start/end in the SOURCE video's timeline. */
  start_ms: number;
  end_ms: number;
  /** Why the LLM picked this range. Surfaced under the clip in the UI. */
  reason: string;
  /** clips:// URL the renderer can drop into a <video> tag. */
  clip_url: string;
  /** Absolute path on disk (useful when promoting into a candidate). */
  file_path: string;
}

/** Stage label for the progress stream the renderer subscribes to. */
export type ExtractStage =
  | 'cache_check'
  | 'download'
  | 'transcribe'
  | 'rank'
  | 'scenes'
  | 'extract'
  | 'done'
  | 'error';

export interface ExtractProgressEvent {
  stage: ExtractStage;
  /** Human-readable line shown in the live log under the button. */
  message: string;
  /** Optional structured payload — currently used to surface the LLM's
   *  raw ranked ranges + the windowed transcript that was actually
   *  shown to the model. The renderer hides this behind a disclosure. */
  detail?: {
    transcript_windows?: { start_ms: number; end_ms: number; text: string }[];
    ranges?: { start_ms: number; end_ms: number; reason: string }[];
    scene_cuts_ms?: number[];
    cached?: boolean;
    /** Numerator for the per-clip ffmpeg loop (extract stage only). */
    completed?: number;
    total?: number;
  };
}

export type ExtractProgressFn = (e: ExtractProgressEvent) => void;

export interface ExtractClipsInput {
  /** Original candidate URL (YouTube watch link, Vimeo, etc.). */
  candidate_url: string;
  /** The page the candidate was found on. When this is a video-host
   *  URL (YouTube / Vimeo / FB / IG / TikTok / etc.) we prefer it
   *  over candidate_url for the actual download — old curator
   *  recordings of the same content may have captured an auth-wall
   *  modal instead of the video. */
  source_page?: string | null;
  /** Shot index — only used for cache scoping + filename layout. */
  shot_idx: number;
  /** What the user wants from this shot — the model uses this to
   *  decide which transcript spans are relevant. */
  broll_description: string;
  /** What's being said over this shot in the planned reel. Helps the
   *  model anchor on topical / thematic matches. */
  spoken_during: string;
  /** Optional planned shot duration to scope clip length suggestions. */
  shot_duration_ms?: number | null;
  /** When true, skip the on-disk result cache and re-run every stage.
   *  The Re-extract button in the renderer sets this so the user can
   *  force a fresh pipeline pass (e.g., after editing the shot's
   *  broll_description or after a bad cache from a previous bug). */
  force?: boolean;
}

/** Pick the URL to actually download. If source_page is a video-host
 *  URL (FB / IG / TikTok / YouTube / Vimeo / etc.) we trust yt-dlp on
 *  it more than whatever the candidate URL points at — capture:// URLs
 *  produced by the curator before the video-host passthrough was
 *  added often captured the platform's auth-wall modal rather than
 *  the actual video. Returns candidate_url for any non-video-host
 *  flow (marketing pages, articles, local mp4s). */
export function resolveDownloadUrl(input: {
  candidate_url: string;
  source_page?: string | null;
}): { url: string; replaced: boolean } {
  const src = input.source_page?.trim();
  if (src && isVideoHostUrl(src) && src !== input.candidate_url) {
    return { url: src, replaced: true };
  }
  return { url: input.candidate_url, replaced: false };
}

export interface ExtractClipsResult {
  ok: true;
  clips: ExtractedClip[];
  /** Echo of the source mp4 path so the renderer can re-fetch later. */
  source_mp4_path: string;
  /** True when the result was loaded entirely from disk without
   *  re-running yt-dlp / Whisper / ffmpeg. */
  from_cache: boolean;
}

export interface ExtractClipsFailure {
  ok: false;
  error: string;
  /** Stage that failed, so the renderer can show a useful message. */
  stage:
    | 'download'
    | 'audio'
    | 'transcribe'
    | 'rank'
    | 'scenes'
    | 'extract'
    | 'config';
}

export type ExtractClipsResponse = ExtractClipsResult | ExtractClipsFailure;

/** Stable, filesystem-safe hash of a URL — used to key the cached mp4
 *  and transcript so concurrent extractions for the same URL share work. */
function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** Cache key for one extraction job. Folds the shot's intent into the
 *  hash so two different shots on the same source video don't trample
 *  each other's clip output. */
function extractionKey(input: ExtractClipsInput): string {
  return createHash('sha256')
    .update(input.candidate_url)
    .update('\n')
    .update(String(input.shot_idx))
    .update('\n')
    .update(input.broll_description)
    .update('\n')
    .update(input.spoken_during)
    .digest('hex')
    .slice(0, 16);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Resolve a candidate URL to a local mp4 path when it points at an
 *  asset we've already produced (curator recordings via capture://, our
 *  own extracted clips via clips://, or any file:// URL). Returns null
 *  when the URL needs the yt-dlp path. */
function resolveLocalMp4(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'capture:') {
      const filename = u.pathname.replace(/^\/+/, '');
      if (!filename) return null;
      const filepath = join(CAPTURES_DIR_PATH, filename);
      return filepath.startsWith(CAPTURES_DIR_PATH) ? filepath : null;
    }
    if (u.protocol === 'clips:') {
      const rel = u.pathname.replace(/^\/+/, '');
      if (!rel) return null;
      const filepath = join(EXTRACTED_CLIPS_DIR, rel);
      return filepath.startsWith(EXTRACTED_CLIPS_DIR) ? filepath : null;
    }
    if (u.protocol === 'file:') {
      return fileURLToPath(u);
    }
  } catch {
    /* not a parseable URL — fall through */
  }
  return null;
}

/** Download the candidate URL as a 720p mp4 via yt-dlp. Skips when the
 *  cached mp4 already exists. When the URL points at one of our own
 *  local schemes (capture://, clips://, file://), returns the on-disk
 *  path directly without invoking yt-dlp — those mp4s are already on
 *  disk and yt-dlp would error with "Unsupported url scheme". */
export async function downloadSource(
  url: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const local = resolveLocalMp4(url);
  if (local) {
    if (!existsSync(local)) {
      return {
        ok: false,
        error: `local source not found on disk: ${local}`,
      };
    }
    return { ok: true, path: local };
  }
  ensureDir(SOURCE_VIDEOS_DIR);
  const path = join(SOURCE_VIDEOS_DIR, `${urlHash(url)}.mp4`);
  if (existsSync(path)) return { ok: true, path };
  try {
    await execFileAsync(
      YT_DLP,
      [
        '--no-warnings',
        '--no-playlist',
        '-f',
        'best[ext=mp4][height<=720][acodec!=none][vcodec!=none]/best[ext=mp4][height<=720]/best[height<=720]/best',
        '--merge-output-format',
        'mp4',
        '-o',
        path,
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 },
    );
    if (!existsSync(path)) {
      return { ok: false, error: 'yt-dlp produced no output file' };
    }
    return { ok: true, path };
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return { ok: false, error: 'yt-dlp not found - install it or set YT_DLP_PATH' };
    }
    const stderr = String(e?.stderr ?? '').trim();
    const last = stderr.split('\n').filter(Boolean).pop();
    return { ok: false, error: last || (e instanceof Error ? e.message : String(e)) };
  }
}

interface CachedTranscript {
  words: TranscriptWord[];
}

/** Whisper word-level transcription of the source mp4. Cached as a
 *  sibling JSON file next to the mp4. */
export async function transcribeSource(
  mp4Path: string,
): Promise<{ ok: true; words: TranscriptWord[] } | { ok: false; error: string }> {
  const cachePath = mp4Path.replace(/\.mp4$/i, '.transcript.json');
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as CachedTranscript;
      return { ok: true, words: cached.words };
    } catch {
      /* fall through to re-transcribe on corrupt cache */
    }
  }
  const samples = await extractReelAudio(mp4Path);
  if (!samples || samples.length === 0) {
    return { ok: false, error: 'failed to extract audio from source video' };
  }
  const transcript = await transcribeReel(samples);
  if (!transcript) {
    return {
      ok: false,
      error: 'transcription failed (missing OPENAI_API_KEY or Whisper error)',
    };
  }
  writeFileSync(
    cachePath,
    JSON.stringify({ words: transcript.words } satisfies CachedTranscript),
    'utf8',
  );
  return { ok: true, words: transcript.words };
}

/** Collapse word-level timestamps into ~5s overlapping windows so the
 *  ranking LLM gets readable chunks instead of token-soup. */
export interface TranscriptWindow {
  start_ms: number;
  end_ms: number;
  text: string;
}
export function windowTranscript(words: TranscriptWord[]): TranscriptWindow[] {
  if (words.length === 0) return [];
  const WIN_MS = 5000;
  const STEP_MS = 2500;
  const total_end = words[words.length - 1].end_ms;
  const out: TranscriptWindow[] = [];
  for (let t = 0; t <= total_end; t += STEP_MS) {
    const slice = words.filter(
      (w) => w.end_ms > t && w.start_ms < t + WIN_MS,
    );
    if (slice.length === 0) continue;
    const start_ms = slice[0].start_ms;
    const end_ms = slice[slice.length - 1].end_ms;
    const text = slice.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
    out.push({ start_ms, end_ms, text });
  }
  return out;
}

interface RankedRange {
  start_ms: number;
  end_ms: number;
  reason: string;
}

/** Ask gpt-4o-mini for up to MAX_CLIPS relevant time ranges in the
 *  transcript. */
async function rankRanges(
  input: ExtractClipsInput,
  windows: TranscriptWindow[],
  sourceDurationMs: number,
): Promise<{ ok: true; ranges: RankedRange[] } | { ok: false; error: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'OPENAI_API_KEY not set' };
  }
  if (windows.length === 0) {
    return { ok: true, ranges: [] };
  }
  const client = new OpenAI({ apiKey });
  const transcriptBlock = windows
    .map(
      (w) =>
        `[${(w.start_ms / 1000).toFixed(1)}s–${(w.end_ms / 1000).toFixed(1)}s] ${w.text}`,
    )
    .join('\n');
  const userMessage = [
    `You are picking clips from a source video to fill a planned shot in a new short-form Reel.`,
    ``,
    `PLANNED SHOT:`,
    `- visual idea (b-roll description): ${input.broll_description || '(none specified)'}`,
    `- voiceover over this shot: "${input.spoken_during || '(none)'}"`,
    input.shot_duration_ms
      ? `- target shot duration: ${(input.shot_duration_ms / 1000).toFixed(1)}s`
      : '',
    ``,
    `SOURCE VIDEO TRANSCRIPT (timestamps in source-video time):`,
    transcriptBlock,
    ``,
    `Return up to ${MAX_CLIPS} time ranges from the source video that best match the planned shot's visual idea and topic. Each range should be ${MIN_CLIP_MS / 1000}–${MAX_CLIP_MS / 1000} seconds long. Pick spans where what's being said clearly relates to the planned shot's visual idea or voiceover, OR spans where the speaker is likely showing the relevant subject on screen (e.g., demos, walkthroughs, product visuals).`,
    ``,
    `Return strict JSON with this shape — NOTHING else:`,
    `{ "ranges": [ { "start_ms": <int>, "end_ms": <int>, "reason": "<one sentence>" }, ... ] }`,
    ``,
    `If nothing in the transcript relates to the shot, return { "ranges": [] }.`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const resp = await client.chat.completions.create({
      model: RANK_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You select sub-clips from a source video transcript. Output strict JSON only.',
        },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
    });
    const text = resp.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text) as { ranges?: RankedRange[] };
    const raw = Array.isArray(parsed.ranges) ? parsed.ranges : [];
    const ranges = raw
      .map((r) => ({
        start_ms: Math.max(0, Math.round(Number(r.start_ms) || 0)),
        end_ms: Math.min(
          sourceDurationMs,
          Math.round(Number(r.end_ms) || 0),
        ),
        reason: String(r.reason ?? '').slice(0, 240),
      }))
      .filter((r) => r.end_ms - r.start_ms >= MIN_CLIP_MS / 2)
      // Cap to MAX_CLIP_MS so a verbose LLM doesn't return a 60s
      // "clip" that's really the whole video.
      .map((r) => {
        if (r.end_ms - r.start_ms > MAX_CLIP_MS) {
          return { ...r, end_ms: r.start_ms + MAX_CLIP_MS };
        }
        return r;
      })
      .slice(0, MAX_CLIPS);
    return { ok: true, ranges };
  } catch (e) {
    return {
      ok: false,
      error: `rank LLM failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Snap a value to the nearest cut within ±SCENE_SNAP_TOLERANCE_MS. If
 *  no cut is within that window, return the original value. */
function snapToCut(value_ms: number, cuts_ms: number[]): number {
  let best = value_ms;
  let bestDelta = SCENE_SNAP_TOLERANCE_MS + 1;
  for (const cut of cuts_ms) {
    const delta = Math.abs(cut - value_ms);
    if (delta <= SCENE_SNAP_TOLERANCE_MS && delta < bestDelta) {
      best = cut;
      bestDelta = delta;
    }
  }
  return best;
}

/** Probe source mp4 for duration + whether it carries an audio stream.
 *  ffmpeg with no output target logs Duration + Stream lines to stderr
 *  and exits non-zero; we read stderr from either the success or error
 *  branch. */
export async function probeMp4(
  mp4Path: string,
): Promise<{ durationMs: number; hasAudio: boolean }> {
  const parse = (stderr: string): { durationMs: number; hasAudio: boolean } => {
    let durationMs = 0;
    const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (m) {
      const [, hh, mm, ss] = m;
      durationMs = Math.round(
        (parseInt(hh, 10) * 3600 + parseInt(mm, 10) * 60 + parseFloat(ss)) *
          1000,
      );
    }
    // ffmpeg labels audio streams as "Stream #X:Y[lang]: Audio: ...".
    const hasAudio = /Stream #\d+:\d+(\[[^\]]*\])?(\([^)]+\))?:\s*Audio:/i.test(
      stderr,
    );
    return { durationMs, hasAudio };
  };
  try {
    const { stderr } = await execFileAsync(
      FFMPEG,
      ['-nostdin', '-i', mp4Path],
      { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
    );
    return parse(String(stderr ?? ''));
  } catch (e: any) {
    return parse(String(e?.stderr ?? ''));
  }
}

/** Cut [start, end] from the source mp4 into clipPath via ffmpeg.
 *  Re-encodes (libx264 + aac) so the cut lands frame-accurate at the
 *  requested start — `-c copy` would round to the nearest GOP keyframe
 *  and we'd lose the precision the LLM picked. */
async function ffmpegExtract(
  sourceMp4: string,
  start_ms: number,
  end_ms: number,
  outPath: string,
): Promise<void> {
  const start_s = (start_ms / 1000).toFixed(3);
  const dur_s = ((end_ms - start_ms) / 1000).toFixed(3);
  await execFileAsync(
    FFMPEG,
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      start_s,
      '-i',
      sourceMp4,
      '-t',
      dur_s,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outPath,
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
}

interface CachedExtraction {
  clips: { start_ms: number; end_ms: number; reason: string; file: string }[];
  source_mp4_path: string;
}

/** Map an extracted clip's filename to its clips:// URL. The protocol
 *  handler in main/index.ts joins host+pathname back to disk. */
function clipUrl(extractionKeyHex: string, fileName: string): string {
  return `clips://files/${extractionKeyHex}/${fileName}`;
}

/** Fallback path for sources with no audio (screen recordings, silent
 *  clips). Slices the source at scdet boundaries; if scdet returns too
 *  few cuts, falls back to evenly-spaced chunks so the user still gets
 *  something useful. No LLM ranking — the reason field is descriptive
 *  rather than semantic. */
async function sceneOnlyExtract(
  input: ExtractClipsInput,
  sourceMp4: string,
  durationMs: number,
  outDir: string,
  cacheJson: string,
  key: string,
  emit: (e: ExtractProgressEvent) => void,
): Promise<ExtractClipsResponse> {
  emit({
    stage: 'scenes',
    message: 'detecting scene cuts (scdet) to use as clip boundaries',
  });

  let cuts: number[] = [];
  try {
    const shots = await detectScenes(sourceMp4, durationMs || 0);
    cuts = shots.flatMap((s) => [s.start_ms, s.end_ms]);
  } catch {
    /* scene detection is best-effort */
  }

  // Build a list of (start, end) candidate ranges. Prefer scdet shot
  // boundaries; if scdet returned <2 cuts, fall back to dividing the
  // source into MAX_CLIPS even chunks.
  const cutSet = Array.from(new Set(cuts)).sort((a, b) => a - b);
  let ranges: { start_ms: number; end_ms: number; reason: string }[] = [];
  if (cutSet.length >= 2) {
    emit({
      stage: 'scenes',
      message: `${cutSet.length} cut point(s) detected — building shot-aligned ranges`,
      detail: { scene_cuts_ms: cutSet },
    });
    // Pair consecutive cuts into shot ranges; trim to MIN/MAX bounds.
    for (let i = 0; i < cutSet.length - 1; i++) {
      const start_ms = cutSet[i];
      const rawEnd = cutSet[i + 1];
      const dur = rawEnd - start_ms;
      if (dur < MIN_CLIP_MS / 2) continue;
      const end_ms = Math.min(rawEnd, start_ms + MAX_CLIP_MS);
      ranges.push({
        start_ms,
        end_ms,
        reason: `scene ${ranges.length + 1} (${((end_ms - start_ms) / 1000).toFixed(1)}s)`,
      });
      if (ranges.length >= MAX_CLIPS) break;
    }
  }
  if (ranges.length === 0 && durationMs > MIN_CLIP_MS) {
    emit({
      stage: 'scenes',
      message: `no usable scene cuts — slicing into ${MAX_CLIPS} even chunks`,
    });
    const chunkMs = Math.min(MAX_CLIP_MS, Math.floor(durationMs / MAX_CLIPS));
    for (let i = 0; i < MAX_CLIPS; i++) {
      const start_ms = Math.floor(i * (durationMs / MAX_CLIPS));
      const end_ms = Math.min(durationMs, start_ms + chunkMs);
      if (end_ms - start_ms < MIN_CLIP_MS / 2) break;
      ranges.push({
        start_ms,
        end_ms,
        reason: `chunk ${i + 1}/${MAX_CLIPS} (${((end_ms - start_ms) / 1000).toFixed(1)}s)`,
      });
    }
  }

  if (ranges.length === 0) {
    ensureDir(outDir);
    writeFileSync(
      cacheJson,
      JSON.stringify(
        { clips: [], source_mp4_path: sourceMp4 } satisfies CachedExtraction,
        null,
        2,
      ),
      'utf8',
    );
    emit({
      stage: 'done',
      message: 'source too short / unsegmentable — nothing to extract',
    });
    return { ok: true, clips: [], source_mp4_path: sourceMp4, from_cache: false };
  }

  // Extract each range.
  ensureDir(outDir);
  const cachedClips: CachedExtraction['clips'] = [];
  const outClips: ExtractedClip[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const file = `${i}.mp4`;
    const outPath = join(outDir, file);
    emit({
      stage: 'extract',
      message: `clip ${i + 1}/${ranges.length}: ${(r.start_ms / 1000).toFixed(2)}s → ${(r.end_ms / 1000).toFixed(2)}s — ${r.reason}`,
      detail: { completed: i, total: ranges.length },
    });
    try {
      await ffmpegExtract(sourceMp4, r.start_ms, r.end_ms, outPath);
    } catch (e) {
      const msg = `ffmpeg extract failed: ${e instanceof Error ? e.message : String(e)}`;
      emit({ stage: 'error', message: msg });
      return { ok: false, error: msg, stage: 'extract' };
    }
    cachedClips.push({ start_ms: r.start_ms, end_ms: r.end_ms, reason: r.reason, file });
    outClips.push({
      clip_id: `${key}-${i}`,
      start_ms: r.start_ms,
      end_ms: r.end_ms,
      reason: r.reason,
      clip_url: clipUrl(key, file),
      file_path: outPath,
    });
  }

  writeFileSync(
    cacheJson,
    JSON.stringify(
      { clips: cachedClips, source_mp4_path: sourceMp4 } satisfies CachedExtraction,
      null,
      2,
    ),
    'utf8',
  );

  emit({
    stage: 'done',
    message: `${outClips.length} clip(s) extracted (scene-based, no transcript)`,
  });
  return { ok: true, clips: outClips, source_mp4_path: sourceMp4, from_cache: false };
}

/** Public entry point used by the IPC handler. The optional onProgress
 *  callback receives a stream of stage events the renderer renders as
 *  the "thought process" log. Safe to omit (e.g., when called from a
 *  script) — emit calls are no-ops. */
export async function extractClips(
  input: ExtractClipsInput,
  onProgress?: ExtractProgressFn,
): Promise<ExtractClipsResponse> {
  const emit = (e: ExtractProgressEvent): void => {
    try {
      onProgress?.(e);
    } catch {
      /* progress is fire-and-forget; never break the pipeline */
    }
  };

  const key = extractionKey(input);
  const outDir = join(EXTRACTED_CLIPS_DIR, key);
  const cacheJson = join(outDir, 'result.json');

  if (input.force) {
    emit({
      stage: 'cache_check',
      message: `force flag set — skipping cache and re-running every stage`,
    });
  } else {
    emit({
      stage: 'cache_check',
      message: `cache key ${key} — checking .library/extracted-clips/${key}/result.json`,
    });
  }

  // Cache hit — re-use everything verbatim. Skipped entirely on force.
  if (!input.force && existsSync(cacheJson)) {
    try {
      const cached = JSON.parse(readFileSync(cacheJson, 'utf8')) as CachedExtraction;
      const clips: ExtractedClip[] = cached.clips
        .filter((c) => existsSync(join(outDir, c.file)))
        .map((c, i) => ({
          clip_id: `${key}-${i}`,
          start_ms: c.start_ms,
          end_ms: c.end_ms,
          reason: c.reason,
          clip_url: clipUrl(key, c.file),
          file_path: join(outDir, c.file),
        }));
      if (clips.length > 0) {
        emit({
          stage: 'done',
          message: `loaded ${clips.length} clip(s) from cache — no work needed`,
          detail: { cached: true },
        });
        return {
          ok: true,
          clips,
          source_mp4_path: cached.source_mp4_path,
          from_cache: true,
        };
      }
    } catch {
      /* corrupt cache — fall through and rebuild */
    }
  }

  // 1. Download source. Prefer source_page when it's a video-host
  // URL — cached capture:// recordings from before the video-host
  // passthrough was wired in may show auth-wall modals instead of
  // the actual video.
  const dl_src = resolveDownloadUrl(input);
  if (dl_src.replaced) {
    emit({
      stage: 'download',
      message: `prefer source_page (${dl_src.url}) over capture:// candidate — yt-dlp will fetch the real video`,
    });
  }
  emit({
    stage: 'download',
    message: `yt-dlp downloading ${dl_src.url}`,
  });
  const dl = await downloadSource(dl_src.url);
  if (!dl.ok) {
    emit({ stage: 'error', message: `download failed — ${dl.error}` });
    return { ok: false, error: dl.error, stage: 'download' };
  }
  emit({
    stage: 'download',
    message: `source mp4 ready at ${dl.path}`,
  });

  // 2. Probe — duration + whether the file has an audio stream. Silent
  // recordings (curator's record_url output of a marketing page, our
  // own record-page output, headless screen captures) skip Whisper +
  // the LLM ranker and use scene cuts instead.
  const probe = await probeMp4(dl.path);
  const durationMs = probe.durationMs;
  if (!probe.hasAudio) {
    emit({
      stage: 'transcribe',
      message: `source has no audio stream — falling back to scene-cut segmentation`,
    });
    return await sceneOnlyExtract(
      input,
      dl.path,
      durationMs,
      outDir,
      cacheJson,
      key,
      emit,
    );
  }

  // 3. Transcribe.
  emit({
    stage: 'transcribe',
    message: 'extracting audio + transcribing with whisper (word-level)',
  });
  const tx = await transcribeSource(dl.path);
  if (!tx.ok) {
    emit({ stage: 'error', message: `transcribe failed — ${tx.error}` });
    return { ok: false, error: tx.error, stage: 'transcribe' };
  }
  emit({
    stage: 'transcribe',
    message: `${tx.words.length} words transcribed`,
  });

  const windows = windowTranscript(tx.words);
  emit({
    stage: 'rank',
    message: `built ${windows.length} transcript window(s) (~5s overlapping) · source duration ${(durationMs / 1000).toFixed(1)}s`,
    detail: { transcript_windows: windows },
  });

  // 4. LLM rank.
  emit({
    stage: 'rank',
    message: `asking ${RANK_MODEL} to pick up to ${MAX_CLIPS} relevant ranges for: "${input.broll_description}"`,
  });
  const ranked = await rankRanges(input, windows, durationMs || Number.MAX_SAFE_INTEGER);
  if (!ranked.ok) {
    emit({ stage: 'error', message: `rank failed — ${ranked.error}` });
    return { ok: false, error: ranked.error, stage: 'rank' };
  }
  emit({
    stage: 'rank',
    message:
      ranked.ranges.length === 0
        ? 'model returned 0 ranges — transcript has nothing relevant to this shot'
        : `model picked ${ranked.ranges.length} range(s)`,
    detail: { ranges: ranked.ranges },
  });
  if (ranked.ranges.length === 0) {
    // LLM found nothing relevant — fall back to scene-cut segmentation
    // so the user at least sees the source sliced into navigable
    // chunks. Same path used when there's no audio stream.
    emit({
      stage: 'rank',
      message:
        'no transcript matches — falling back to scene-cut segmentation so the source is still browsable',
    });
    return await sceneOnlyExtract(
      input,
      dl.path,
      durationMs,
      outDir,
      cacheJson,
      key,
      emit,
    );
  }

  // 5. Scene cuts — snap edges to natural boundaries.
  emit({
    stage: 'scenes',
    message: `running ffmpeg scdet to find clean cut points`,
  });
  let cuts: number[] = [];
  try {
    const shots = await detectScenes(dl.path, durationMs || 0);
    cuts = shots.flatMap((s) => [s.start_ms, s.end_ms]);
  } catch {
    /* scene detection is best-effort; skip snap if it fails */
  }
  emit({
    stage: 'scenes',
    message:
      cuts.length === 0
        ? 'no cuts detected (or scdet failed) — using raw LLM boundaries'
        : `${new Set(cuts).size} unique cut point(s) — will snap clip edges within ±${SCENE_SNAP_TOLERANCE_MS}ms`,
    detail: { scene_cuts_ms: cuts },
  });

  // 6. Extract each range.
  ensureDir(outDir);
  const cachedClips: CachedExtraction['clips'] = [];
  const outClips: ExtractedClip[] = [];
  for (let i = 0; i < ranked.ranges.length; i++) {
    const r = ranked.ranges[i];
    const start_ms = Math.max(0, snapToCut(r.start_ms, cuts));
    const end_ms = Math.min(
      durationMs || Number.MAX_SAFE_INTEGER,
      snapToCut(r.end_ms, cuts),
    );
    if (end_ms - start_ms < MIN_CLIP_MS / 2) continue;
    const file = `${i}.mp4`;
    const outPath = join(outDir, file);
    const snapStartDelta = start_ms - r.start_ms;
    const snapEndDelta = end_ms - r.end_ms;
    emit({
      stage: 'extract',
      message: `clip ${i + 1}/${ranked.ranges.length}: ${(start_ms / 1000).toFixed(2)}s → ${(end_ms / 1000).toFixed(2)}s${
        snapStartDelta || snapEndDelta
          ? ` (snapped Δstart ${snapStartDelta >= 0 ? '+' : ''}${snapStartDelta}ms, Δend ${snapEndDelta >= 0 ? '+' : ''}${snapEndDelta}ms)`
          : ''
      } — ${r.reason}`,
      detail: { completed: i, total: ranked.ranges.length },
    });
    try {
      await ffmpegExtract(dl.path, start_ms, end_ms, outPath);
    } catch (e) {
      const msg = `ffmpeg extract failed: ${e instanceof Error ? e.message : String(e)}`;
      emit({ stage: 'error', message: msg });
      return { ok: false, error: msg, stage: 'extract' };
    }
    cachedClips.push({ start_ms, end_ms, reason: r.reason, file });
    outClips.push({
      clip_id: `${key}-${i}`,
      start_ms,
      end_ms,
      reason: r.reason,
      clip_url: clipUrl(key, file),
      file_path: outPath,
    });
  }

  writeFileSync(
    cacheJson,
    JSON.stringify(
      { clips: cachedClips, source_mp4_path: dl.path } satisfies CachedExtraction,
      null,
      2,
    ),
    'utf8',
  );

  emit({
    stage: 'done',
    message: `${outClips.length} clip(s) extracted and cached for re-use`,
  });
  return { ok: true, clips: outClips, source_mp4_path: dl.path, from_cache: false };
}

export const EXTRACTED_CLIPS_DIR_PATH = EXTRACTED_CLIPS_DIR;
