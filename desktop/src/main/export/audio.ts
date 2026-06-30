import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { SuggestedEdit, ShotPlan, SelectedMedia } from '../analyze/synthesize';
import {
  resolveSfxByType,
  resolveSfxCue,
  buildSfxTimeline,
  dominantCueBucket,
} from './sfx-resolve';
import type { SfxType } from '../analyze/sfx-classify';
import { extractReelAudio } from '../analyze/audio';
import { transcribeReel } from '../analyze/transcribe';

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const CAPTURES_DIR = resolve(process.cwd(), '.library', 'captures');
const EXTRACTED_CLIPS_DIR = resolve(process.cwd(), '.library', 'extracted-clips');

/** Map a renderer media URL back to a local filesystem path ffmpeg can read.
 *  Remote (http) media is intentionally unsupported here — those clips are
 *  usually muted stock and downloading them is out of scope for the audio bed. */
function urlToLocalPath(url: string): string | null {
  if (!url) return null;
  if (url.startsWith('local-video://')) {
    try {
      const u = new URL(url);
      const encoded = u.pathname.replace(/^\/+/, '').replace(/\.[a-z0-9]+$/i, '');
      return encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : null;
    } catch {
      return null;
    }
  }
  if (url.startsWith('capture://files/')) {
    const rel = url.slice('capture://files/'.length).replace(/^\/+/, '');
    const p = join(CAPTURES_DIR, rel);
    return p.startsWith(CAPTURES_DIR) && existsSync(p) ? p : null;
  }
  if (url.startsWith('clips://files/')) {
    const rel = url.slice('clips://files/'.length).replace(/^\/+/, '');
    const p = join(EXTRACTED_CLIPS_DIR, rel);
    return p.startsWith(EXTRACTED_CLIPS_DIR) && existsSync(p) ? p : null;
  }
  return null;
}

function getSelections(shot: ShotPlan): SelectedMedia[] {
  const raw = shot.selected_media as
    | SelectedMedia[]
    | SelectedMedia
    | null
    | undefined;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

async function hasAudioStream(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      path,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

interface AudioElement {
  /** ffmpeg input file path. */
  path: string;
  /** ms into the reel timeline where this element starts. */
  delayMs: number;
  /** source in-point (ms) for trimming, or 0. */
  inMs: number;
  /** how long to play (ms), or null to play to end of source. */
  durMs: number | null;
  /** linear gain. */
  volume: number;
}

/** Collect b-roll-clip audio elements to mix under the narration. SFX are
 *  NOT placed here — they live on their own transcript-driven timeline
 *  (see buildSfxTimeline / collectTimelineSfx), independent of shots. */
function collectElements(plan: SuggestedEdit): AudioElement[] {
  const out: AudioElement[] = [];
  for (const shot of plan.shots ?? []) {
    // B-roll clip audio (ducked), one segment per video pick.
    const picks = getSelections(shot);
    const pickDurationMs =
      picks.length > 0
        ? Math.max(250, Math.round(shot.duration_ms / picks.length))
        : 0;
    picks.forEach((pick, i) => {
      if (pick.kind !== 'video') return;
      const path = urlToLocalPath(pick.url);
      if (!path) return;
      out.push({
        path,
        delayMs: shot.start_ms + i * pickDurationMs,
        inMs: pick.playback_start_ms ?? 0,
        durMs: pickDurationMs || shot.duration_ms,
        volume: plan.music_volume ?? 0.25,
      });
    });
  }
  return out;
}

/** Place the reel's SFX timeline — transcript-driven, shot-independent.
 *  SFX land on the narration's word onsets at the creator's cadence (denser
 *  through the hook when the pattern escalates). One sound per type, repeated,
 *  so a cadence reads as a deliberate rhythm (the same ding on each beat). */
function collectTimelineSfx(
  plan: SuggestedEdit,
  words: { start_ms: number }[],
): AudioElement[] {
  // Hand-edited events (from the timeline) are the source of truth; else
  // generate from the transcript + inspiration cadence.
  let timeline: { ms: number; type: SfxType; sound?: string; volume?: number }[];
  if (plan.sfx_events && plan.sfx_events.length > 0) {
    timeline = plan.sfx_events;
  } else {
    const firstShot = plan.shots?.[0];
    const hookMs = firstShot
      ? firstShot.start_ms + firstShot.duration_ms
      : 5000;
    timeline = buildSfxTimeline(
      words,
      plan.sfx_plan ?? null,
      hookMs,
      dominantCueBucket((plan.shots ?? []).map((s) => s.sfx_cue)),
      plan.sfx_override ?? null,
    );
  }
  if (timeline.length === 0) return [];
  const baseVolume = plan.sfx_volume ?? 0.5;
  const lead = plan.sfx_lead_ms ?? 0; // fire this many ms before the word
  const cache = new Map<string, string | null>();
  const out: AudioElement[] = [];
  for (const ev of timeline) {
    // A specific named sound resolves to that exact clip; else by bucket.
    const key = ev.sound ? `q:${ev.sound}` : `t:${ev.type}`;
    let path = cache.get(key);
    if (path === undefined) {
      path = ev.sound ? resolveSfxCue(ev.sound) : resolveSfxByType(ev.type);
      cache.set(key, path);
    }
    if (!path) continue;
    out.push({
      path,
      delayMs: Math.max(0, ev.ms - lead),
      inMs: 0,
      durMs: null,
      // Per-event gain wins; else the plan-wide SFX level.
      volume: typeof ev.volume === 'number' ? ev.volume : baseVolume,
    });
  }
  return out;
}

export interface BuildAudioResult {
  /** true when an audio track was produced; false when there was nothing
   *  to render (no narration, no b-roll audio, no SFX). */
  hasAudio: boolean;
}

/** Build a single AAC audio track (narration bed + ducked b-roll + SFX) of
 *  exactly the reel's duration, written to outPath. Returns hasAudio=false
 *  when there is no source audio at all (caller then keeps the silent video). */
export async function buildAudioTrack(
  plan: SuggestedEdit,
  outPath: string,
  narrationSource: string | null = null,
): Promise<BuildAudioResult> {
  const durMs = Math.max(1, plan.total_duration_ms || 0);
  const durSec = durMs / 1000;

  // Narration source: the resolved target video the caller passed (falls back
  // to the plan's own target_video_path for local_video targets).
  const candidate = narrationSource || plan.target_video_path || null;
  const narrationPath =
    candidate && existsSync(candidate) ? candidate : null;
  const narrationHasAudio = narrationPath
    ? await hasAudioStream(narrationPath)
    : false;

  // Drop any element whose source has no audio stream — otherwise its
  // [n:a] filter label matches no streams and ffmpeg aborts the whole mix.
  // (Many b-roll clips / screen recordings are silent; SFX mp3s pass.)
  const rawElements = collectElements(plan);

  // SFX timeline. Hand-edited events are placed directly (no transcript
  // needed). Otherwise transcribe the narration and place SFX on word
  // onsets per the learned cadence (shot-independent).
  try {
    if (plan.sfx_events && plan.sfx_events.length > 0) {
      const timelineSfx = collectTimelineSfx(plan, []);
      rawElements.push(...timelineSfx);
      console.error('[export-sfx] placed', timelineSfx.length, 'hand-edited SFX');
    } else if (narrationHasAudio && narrationPath) {
      const samples = await extractReelAudio(narrationPath);
      const tr = samples ? await transcribeReel(samples) : null;
      if (tr && tr.words.length > 0) {
        const timelineSfx = collectTimelineSfx(plan, tr.words);
        rawElements.push(...timelineSfx);
        console.error(
          '[export-sfx] placed',
          timelineSfx.length,
          'timeline SFX over',
          tr.words.length,
          'narration words',
        );
      }
    }
  } catch (err) {
    console.error(
      '[export-sfx] timeline placement failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  const elements: AudioElement[] = [];
  for (const el of rawElements) {
    if (await hasAudioStream(el.path)) elements.push(el);
  }
  if (!narrationHasAudio && elements.length === 0) {
    return { hasAudio: false };
  }

  const inputs: string[] = [];
  const filters: string[] = [];
  const mixLabels: string[] = [];
  let idx = 0;

  if (narrationHasAudio && narrationPath) {
    // Original video audio gain (voiceover/talking-head). Default 1 = unchanged.
    const narrationVol = plan.narration_volume ?? 1;
    inputs.push('-i', narrationPath);
    filters.push(
      `[${idx}:a]atrim=0:${durSec.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,volume=${narrationVol}[a${idx}]`,
    );
    mixLabels.push(`[a${idx}]`);
    idx++;
  }

  for (const el of elements) {
    inputs.push('-i', el.path);
    const trim =
      el.durMs != null
        ? `atrim=${(el.inMs / 1000).toFixed(3)}:${((el.inMs + el.durMs) / 1000).toFixed(3)},`
        : el.inMs > 0
          ? `atrim=${(el.inMs / 1000).toFixed(3)},`
          : '';
    const delay = Math.max(0, Math.round(el.delayMs));
    filters.push(
      `[${idx}:a]${trim}asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,` +
        `volume=${el.volume},adelay=${delay}|${delay}[a${idx}]`,
    );
    mixLabels.push(`[a${idx}]`);
    idx++;
  }

  let filterComplex: string;
  if (mixLabels.length === 1) {
    // Single source — still cap to duration via the trimmed/processed label.
    filterComplex =
      filters.join(';') + `;${mixLabels[0]}alimiter=limit=0.95[mix]`;
  } else {
    filterComplex =
      filters.join(';') +
      `;${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:dropout_transition=0,` +
      `alimiter=limit=0.95[mix]`;
  }

  const args = [
    '-y',
    ...inputs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[mix]',
    '-t',
    durSec.toFixed(3),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    outPath,
  ];

  await runFfmpeg(args, 'audio');
  return { hasAudio: true };
}

/** Mux a silent video with an audio track into the final mp4. */
export async function muxVideoAudio(
  videoPath: string,
  audioPath: string,
  outPath: string,
): Promise<void> {
  await runFfmpeg(
    [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      outPath,
    ],
    'mux',
  );
}

function runFfmpeg(args: string[], label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`ffmpeg(${label}) exited ${code}: ${err.slice(-2000)}`)),
    );
  });
}
