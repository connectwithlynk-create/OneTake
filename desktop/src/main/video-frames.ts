// Pick the most relevant still frames from a web_video candidate's
// source and extract them as PNGs. Mirrors extract-clips, but produces
// single-frame screenshots instead of mp4 slices. Pipeline:
//   1. downloadSource (yt-dlp or resolve a local capture:// / clips://
//      / file:// URL).
//   2. probeMp4 — duration + whether the source has audio.
//   3. If audio: transcribe + ask gpt-4o-mini for up to N timestamp
//      "moments" with reasons. If no audio: detectScenes and use shot
//      start times.
//   4. ffmpeg -ss <ts> -frames:v 1 writes each frame as a PNG into
//      .library/captures/<key>-<i>.png (served via capture://).
// Result + cache lands in .library/extracted-clips/<key>/frames.json
// so re-clicks are instant for the same (URL, shot, broll, spoken).

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { promisify } from 'util';
import { resolve as resolvePath, join } from 'path';
import OpenAI from 'openai';
import { detectScenes, type Shot } from './analyze/scene-detect';
import { spokenWindow, type TranscriptWord } from './analyze/transcribe';
import { CAPTURES_DIR_PATH } from './curator/web-record';
import {
  downloadSource,
  probeMp4,
  resolveDownloadUrl,
  transcribeSource,
} from './extract-clips';

const execFileAsync = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FRAMES_INDEX_DIR = resolvePath(
  process.cwd(),
  '.library',
  'extracted-clips',
);

const MAX_FRAMES = 6;
const RANK_MODEL = 'gpt-4o-mini';
// Scenes shorter than this are usually transitions / flashes — not
// good frame candidates. Skip them.
const MIN_SCENE_MS = 600;
// Minimum gap between two picked frames. Even if the LLM picks
// adjacent scenes whose midpoints happen to be close, dedupe.
const MIN_FRAME_GAP_MS = 1500;

export type VideoFrameStage =
  | 'cache_check'
  | 'download'
  | 'transcribe'
  | 'rank'
  | 'scenes'
  | 'capture'
  | 'done'
  | 'error';

export interface VideoFramePick {
  timestamp_ms: number;
  reason: string;
}

export interface VideoFrame {
  frame_id: string;
  timestamp_ms: number;
  reason: string;
  image_url: string;
  image_path: string;
}

export interface CandidateScene {
  scene_idx: number;
  start_ms: number;
  end_ms: number;
  /** Words spoken during this scene. Empty string when no audio or
   *  no speech overlaps. */
  spoken_text: string;
}

export interface VideoFrameProgressEvent {
  stage: VideoFrameStage;
  message: string;
  detail?: {
    scenes?: CandidateScene[];
    picks?: VideoFramePick[];
    cached?: boolean;
  };
}

export type VideoFrameProgressFn = (e: VideoFrameProgressEvent) => void;

export interface VideoFramesInput {
  candidate_url: string;
  /** The page the candidate was found on. Used to override
   *  candidate_url for the actual download when source_page is a
   *  video-host URL (FB/IG/TikTok/YouTube/etc.) — old capture://
   *  recordings often captured a platform auth-wall modal instead of
   *  the actual video, and yt-dlp on the original URL is more
   *  reliable. */
  source_page?: string | null;
  shot_idx: number;
  broll_description: string;
  spoken_during: string;
  shot_duration_ms?: number | null;
  /** When true, skip the cached frames.json and re-run scene detect +
   *  rank + ffmpeg extract. The Re-screenshot button sets this. */
  force?: boolean;
}

export interface VideoFramesResult {
  ok: true;
  frames: VideoFrame[];
  source_mp4_path: string;
  from_cache: boolean;
}

export interface VideoFramesFailure {
  ok: false;
  error: string;
  stage: 'download' | 'transcribe' | 'rank' | 'scenes' | 'capture';
}

export type VideoFramesResponse = VideoFramesResult | VideoFramesFailure;

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Cache key. "_frames" prefix keeps it from colliding with the same
 *  source's clip extractions in the parallel extract-clips cache. */
function framesKey(input: VideoFramesInput): string {
  return createHash('sha256')
    .update('frames:')
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

function frameUrl(fileName: string): string {
  return `capture://files/${fileName}`;
}

/** Build CandidateScene[] from detected shots + transcript words.
 *  Scenes shorter than MIN_SCENE_MS are filtered out. If no scenes
 *  were detected (single-shot video), the entire duration is sliced
 *  into evenly-sized chunks so the user still gets visual variety. */
function buildCandidateScenes(
  shots: Shot[],
  durationMs: number,
  words: TranscriptWord[],
): CandidateScene[] {
  const usable = shots.filter((s) => s.end_ms - s.start_ms >= MIN_SCENE_MS);
  // Single-scene video (or scdet got nothing usable) → synthesize
  // pseudo-scenes by even slicing so we have visual diversity even
  // without real cut data.
  if (usable.length <= 1 && durationMs > 0) {
    const synth: Shot[] = [];
    const n = MAX_FRAMES + 1;
    for (let i = 0; i < n; i++) {
      const start_ms = Math.floor((i * durationMs) / n);
      const end_ms = Math.floor(((i + 1) * durationMs) / n);
      if (end_ms - start_ms >= MIN_SCENE_MS) {
        synth.push({ start_ms, end_ms });
      }
    }
    return synth.map((s, i) => ({
      scene_idx: i,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      spoken_text: words.length ? spokenWindow(words, s.start_ms, s.end_ms) : '',
    }));
  }
  return usable.map((s, i) => ({
    scene_idx: i,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    spoken_text: words.length ? spokenWindow(words, s.start_ms, s.end_ms) : '',
  }));
}

/** Ask gpt-4o-mini which scenes (visually distinct segments) contain
 *  the most relevant frame for the planned shot. Each pick refers to
 *  a scene_idx; the midpoint of that scene becomes the screenshot
 *  timestamp. Falls back to evenly-spaced scenes when no API key. */
async function rankScenes(
  input: VideoFramesInput,
  scenes: CandidateScene[],
): Promise<{ ok: true; picks: VideoFramePick[] } | { ok: false; error: string }> {
  if (scenes.length === 0) return { ok: true, picks: [] };

  const midpoint = (s: CandidateScene): number =>
    Math.round((s.start_ms + s.end_ms) / 2);

  const fallback = (): { ok: true; picks: VideoFramePick[] } => {
    // Evenly spread MAX_FRAMES scenes across the full set.
    const step = Math.max(1, Math.floor(scenes.length / MAX_FRAMES));
    const picks: VideoFramePick[] = [];
    for (let i = 0; i < scenes.length && picks.length < MAX_FRAMES; i += step) {
      const s = scenes[i];
      picks.push({
        timestamp_ms: midpoint(s),
        reason: `scene ${s.scene_idx + 1} midpoint (visually distinct)`,
      });
    }
    return { ok: true, picks };
  };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback();

  const client = new OpenAI({ apiKey });
  const sceneBlock = scenes
    .map((s) => {
      const sp = s.spoken_text.trim().slice(0, 200);
      return `[${s.scene_idx}] ${(s.start_ms / 1000).toFixed(1)}s–${(s.end_ms / 1000).toFixed(1)}s spoken=${sp ? `"${sp}"` : '(silence)'}`;
    })
    .join('\n');
  const userMessage = [
    `You're picking still-frame screenshots from a source video for a planned shot in a short-form Reel. Each candidate below is a SCENE — a visually distinct segment between cuts in the source. The frame midpoint of each picked scene becomes the screenshot, so each pick produces a visually different image.`,
    ``,
    `PLANNED SHOT:`,
    `- visual idea (b-roll description): ${input.broll_description || '(none specified)'}`,
    `- voiceover over this shot: "${input.spoken_during || '(none)'}"`,
    input.shot_duration_ms
      ? `- target shot duration: ${(input.shot_duration_ms / 1000).toFixed(1)}s`
      : '',
    ``,
    `CANDIDATE SCENES (timestamps in source-video time):`,
    sceneBlock,
    ``,
    `Pick up to ${MAX_FRAMES} scenes whose visual is most likely to support the planned shot. Use the spoken text to infer what's on screen: when the speaker describes the product / a demo / a result, that scene likely SHOWS that thing. Silent scenes are often b-roll / cutaways. Choose DIFFERENT scenes — do NOT pick adjacent scenes that probably look similar.`,
    ``,
    `Return strict JSON only:`,
    `{ "picks": [ { "scene_idx": <int>, "reason": "<one short sentence on what this frame likely shows>" }, ... ] }`,
    `If nothing in the scene list looks relevant, pick scenes spread across the video so the user has diverse options.`,
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
            'You pick scenes from a source video to use as still-frame screenshots. Output strict JSON only.',
        },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
    });
    const text = resp.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text) as {
      picks?: { scene_idx?: number; reason?: string }[];
    };
    const raw = Array.isArray(parsed.picks) ? parsed.picks : [];
    const seenIdx = new Set<number>();
    const seenTs: number[] = [];
    const picks: VideoFramePick[] = [];
    for (const p of raw) {
      const idx = Number(p.scene_idx);
      if (!Number.isFinite(idx)) continue;
      if (seenIdx.has(idx)) continue;
      const scene = scenes.find((s) => s.scene_idx === idx);
      if (!scene) continue;
      const ts = midpoint(scene);
      // Dedupe close-together picks (LLM occasionally picks adjacent
      // micro-scenes that look identical).
      if (seenTs.some((t) => Math.abs(t - ts) < MIN_FRAME_GAP_MS)) continue;
      seenIdx.add(idx);
      seenTs.push(ts);
      picks.push({
        timestamp_ms: ts,
        reason: String(p.reason ?? '').slice(0, 240),
      });
      if (picks.length >= MAX_FRAMES) break;
    }
    return picks.length > 0 ? { ok: true, picks } : fallback();
  } catch (e) {
    return {
      ok: false,
      error: `rank LLM failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** ffmpeg single-frame extract. Seeks before -i so the seek is fast,
 *  then writes exactly one PNG at the requested timestamp. */
async function extractFrame(
  sourceMp4: string,
  timestamp_ms: number,
  outPath: string,
): Promise<void> {
  await execFileAsync(
    FFMPEG,
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      (timestamp_ms / 1000).toFixed(3),
      '-i',
      sourceMp4,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outPath,
    ],
    { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
  );
}

interface CachedFrames {
  picks: { timestamp_ms: number; reason: string; file: string }[];
  source_mp4_path: string;
}

export async function videoScreenshots(
  input: VideoFramesInput,
  onProgress?: VideoFrameProgressFn,
): Promise<VideoFramesResponse> {
  const emit = (e: VideoFrameProgressEvent): void => {
    try {
      onProgress?.(e);
    } catch {
      /* fire-and-forget */
    }
  };

  const key = framesKey(input);
  const cacheDir = join(FRAMES_INDEX_DIR, key);
  const cacheJson = join(cacheDir, 'frames.json');

  if (input.force) {
    emit({
      stage: 'cache_check',
      message: `force flag set — skipping cache and re-running every stage`,
    });
  } else {
    emit({
      stage: 'cache_check',
      message: `cache key ${key} — checking .library/extracted-clips/${key}/frames.json`,
    });
  }

  if (!input.force && existsSync(cacheJson)) {
    try {
      const cached = JSON.parse(readFileSync(cacheJson, 'utf8')) as CachedFrames;
      const frames: VideoFrame[] = cached.picks
        .filter((p) => existsSync(join(CAPTURES_DIR_PATH, p.file)))
        .map((p, i) => ({
          frame_id: `${key}-${i}`,
          timestamp_ms: p.timestamp_ms,
          reason: p.reason,
          image_url: frameUrl(p.file),
          image_path: join(CAPTURES_DIR_PATH, p.file),
        }));
      if (frames.length > 0) {
        emit({
          stage: 'done',
          message: `loaded ${frames.length} frame(s) from cache`,
          detail: { cached: true },
        });
        return {
          ok: true,
          frames,
          source_mp4_path: cached.source_mp4_path,
          from_cache: true,
        };
      }
    } catch {
      /* corrupt cache — rebuild */
    }
  }

  // 1. Download / resolve source. Prefer source_page when it's a
  // video-host URL — see resolveDownloadUrl for why.
  const dl_src = resolveDownloadUrl(input);
  if (dl_src.replaced) {
    emit({
      stage: 'download',
      message: `prefer source_page (${dl_src.url}) — yt-dlp will fetch the real video instead of slicing the cached recording`,
    });
  }
  emit({
    stage: 'download',
    message: `resolving ${dl_src.url}`,
  });
  const dl = await downloadSource(dl_src.url);
  if (!dl.ok) {
    emit({ stage: 'error', message: `download failed — ${dl.error}` });
    return { ok: false, error: dl.error, stage: 'download' };
  }
  emit({ stage: 'download', message: `source ready at ${dl.path}` });

  // 2. Probe.
  const probe = await probeMp4(dl.path);
  const durationMs = probe.durationMs;

  // 3. Detect scenes — these are the visually distinct units. Every
  // pick targets one scene's midpoint so the screenshots are
  // guaranteed to differ from each other, not cluster around one shot.
  emit({
    stage: 'scenes',
    message: 'running ffmpeg scdet to find scene boundaries',
  });
  let shots: Shot[] = [];
  try {
    shots = await detectScenes(dl.path, durationMs || 0);
  } catch {
    /* best-effort — buildCandidateScenes will synthesize even slices */
  }

  // 4. Transcribe (best-effort) so we can label each scene with what
  // was said during it. Silent / non-speech sources just get empty
  // spoken_text per scene — still rankable by time position.
  let words: TranscriptWord[] = [];
  if (probe.hasAudio) {
    emit({
      stage: 'transcribe',
      message: 'extracting audio + transcribing with whisper (word-level)',
    });
    const tx = await transcribeSource(dl.path);
    if (tx.ok) {
      words = tx.words;
      emit({
        stage: 'transcribe',
        message: `${words.length} word(s) transcribed`,
      });
    } else {
      emit({
        stage: 'transcribe',
        message: `transcribe failed (${tx.error}) — scenes will be ranked by position only`,
      });
    }
  } else {
    emit({
      stage: 'transcribe',
      message: 'source has no audio — scenes will be ranked by position only',
    });
  }

  const scenes = buildCandidateScenes(shots, durationMs, words);
  emit({
    stage: 'scenes',
    message: `${scenes.length} candidate scene(s) (≥${(MIN_SCENE_MS / 1000).toFixed(1)}s each)${
      shots.length <= 1 ? ' — single-shot source, synthesized even slices' : ''
    }`,
    detail: { scenes },
  });

  // 5. Rank scenes — LLM picks based on spoken text + visual diversity.
  emit({
    stage: 'rank',
    message: `asking ${RANK_MODEL} which scenes match "${input.broll_description}"`,
  });
  const ranked = await rankScenes(input, scenes);
  if (!ranked.ok) {
    emit({ stage: 'error', message: `rank failed — ${ranked.error}` });
    return { ok: false, error: ranked.error, stage: 'rank' };
  }
  const picks = ranked.picks;
  emit({
    stage: 'rank',
    message: `${picks.length} scene pick(s) — each will be captured at its midpoint`,
    detail: { picks },
  });

  if (picks.length === 0) {
    // Couldn't pick anything — source may be too short.
    ensureDir(cacheDir);
    writeFileSync(
      cacheJson,
      JSON.stringify(
        { picks: [], source_mp4_path: dl.path } satisfies CachedFrames,
        null,
        2,
      ),
      'utf8',
    );
    emit({ stage: 'done', message: 'no frames to capture' });
    return { ok: true, frames: [], source_mp4_path: dl.path, from_cache: false };
  }

  // 4. Extract frames.
  ensureDir(cacheDir);
  ensureDir(CAPTURES_DIR_PATH);
  const cached: CachedFrames['picks'] = [];
  const frames: VideoFrame[] = [];
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const file = `${key}-${i}.png`;
    const outPath = join(CAPTURES_DIR_PATH, file);
    emit({
      stage: 'capture',
      message: `frame ${i + 1}/${picks.length} @ ${(p.timestamp_ms / 1000).toFixed(2)}s — ${p.reason}`,
    });
    try {
      await extractFrame(dl.path, p.timestamp_ms, outPath);
    } catch (e) {
      const msg = `ffmpeg frame extract failed: ${e instanceof Error ? e.message : String(e)}`;
      emit({ stage: 'error', message: msg });
      return { ok: false, error: msg, stage: 'capture' };
    }
    cached.push({ timestamp_ms: p.timestamp_ms, reason: p.reason, file });
    frames.push({
      frame_id: `${key}-${i}`,
      timestamp_ms: p.timestamp_ms,
      reason: p.reason,
      image_url: frameUrl(file),
      image_path: outPath,
    });
  }

  writeFileSync(
    cacheJson,
    JSON.stringify(
      { picks: cached, source_mp4_path: dl.path } satisfies CachedFrames,
      null,
      2,
    ),
    'utf8',
  );

  emit({
    stage: 'done',
    message: `${frames.length} frame(s) captured`,
  });
  return { ok: true, frames, source_mp4_path: dl.path, from_cache: false };
}
