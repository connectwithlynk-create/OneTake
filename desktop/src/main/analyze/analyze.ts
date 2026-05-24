import { annotateShots } from './annotate';
import { extractFrames } from './frame-extractor';
import { detectScenes } from './scene-detect';
import { detectSpeaker, type ShotSpeakerInfo } from './speaker';
import { CLIP_TYPES, type ClipType, type ReelShot } from './types';

/** Bump when the analysis algorithm changes meaningfully. */
export const ANALYSIS_VERSION = 6;

export interface ReelAnalysisInput {
  playableUrl: string;
  durationMs: number;
}

/** Per-reel structured output. */
export interface ReelAnalysisResult {
  shots: ReelShot[];
  hook_text: string | null;
  hook_duration_ms: number | null;
  median_shot_ms: number;
  cuts_per_sec: number;
  talking_pct: number;
  broll_pct: number;
  text_overlay_pct: number;
  /** Fraction of shots whose on-screen face is the reel's real speaker
   *  (lip movement tracks the audio). */
  real_speaker_pct: number;
  /** Fraction of shots that are a b-roll talking head - a face whose
   *  lips do NOT track the reel's audio. */
  broll_talking_head_pct: number;
  /** Duration-weighted share of each clip type, summing to ~1. Empty
   *  categories are present with value 0 so the shape is stable. */
  clip_type_distribution: Record<ClipType, number>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function emptyClipDistribution(): Record<ClipType, number> {
  return Object.fromEntries(CLIP_TYPES.map((t) => [t, 0])) as Record<
    ClipType,
    number
  >;
}

/** Compute the aggregate metrics from a list of annotated shots. Pure. */
export function deriveMetrics(
  shots: ReelShot[],
  durationMs: number,
): Omit<ReelAnalysisResult, 'shots'> {
  if (shots.length === 0) {
    return {
      hook_text: null,
      hook_duration_ms: null,
      median_shot_ms: 0,
      cuts_per_sec: 0,
      talking_pct: 0,
      broll_pct: 0,
      text_overlay_pct: 0,
      real_speaker_pct: 0,
      broll_talking_head_pct: 0,
      clip_type_distribution: emptyClipDistribution(),
    };
  }
  const durations = shots.map((s) => s.end_ms - s.start_ms);
  const totalDur = durations.reduce((a, b) => a + b, 0) || durationMs || 1;
  const talkingDur = shots
    .filter((s) => s.has_face)
    .reduce((sum, s) => sum + (s.end_ms - s.start_ms), 0);
  const textShots = shots.filter(
    (s) => s.ocr_text !== null && s.ocr_text.length > 0,
  ).length;
  const cuts = Math.max(0, shots.length - 1);
  const realSpeaker = shots.filter(
    (s) => s.speaker_verdict === 'speaker',
  ).length;
  const brollHead = shots.filter(
    (s) => s.speaker_verdict === 'broll',
  ).length;

  const clipDist = emptyClipDistribution();
  for (const s of shots) {
    clipDist[s.clip_type] += (s.end_ms - s.start_ms) / totalDur;
  }

  const hook = shots[0];
  return {
    hook_text: hook.ocr_text,
    hook_duration_ms: hook.end_ms - hook.start_ms,
    median_shot_ms: median(durations),
    cuts_per_sec: durationMs > 0 ? cuts / (durationMs / 1000) : 0,
    talking_pct: talkingDur / totalDur,
    broll_pct: 1 - talkingDur / totalDur,
    text_overlay_pct: textShots / shots.length,
    real_speaker_pct: realSpeaker / shots.length,
    broll_talking_head_pct: brollHead / shots.length,
    clip_type_distribution: clipDist,
  };
}

/**
 * Run the analysis pipeline on a streamable video URL.
 *
 * Pipeline: ffmpeg scene detection -> real shot boundaries -> one
 * representative frame per shot (face detection) -> Light-ASD speaker
 * detection per shot -> OCR each -> derive aggregate metrics.
 */
export async function analyzeReel(
  input: ReelAnalysisInput,
): Promise<ReelAnalysisResult> {
  if (input.durationMs <= 0) {
    return { shots: [], ...deriveMetrics([], 0) };
  }
  console.error('[analyze] start, duration', input.durationMs, 'ms');
  const shots = await detectScenes(input.playableUrl, input.durationMs);
  console.error('[analyze] detected', shots.length, 'shots');
  const midpoints = shots.map((s) => Math.round((s.start_ms + s.end_ms) / 2));
  const frames = await extractFrames(input.playableUrl, midpoints);
  console.error(
    '[analyze] extracted',
    frames.filter(Boolean).length,
    'of',
    shots.length,
    'rep frames',
  );

  // Speaker detection (SyncNet) - best-effort; never aborts the pipeline.
  // Pass the rep-frame face flags so no-face shots skip the heavy work.
  let speaker: ShotSpeakerInfo[];
  try {
    const hasFaceHints = frames.map((f) => f?.hasFace ?? false);
    speaker = await detectSpeaker(input.playableUrl, shots, hasFaceHints);
  } catch (err) {
    console.error(
      '[analyze] speaker detection failed:',
      err instanceof Error ? err.message : String(err),
    );
    speaker = shots.map(() => ({
      verdict: 'unknown' as const,
      confidence: 0,
      sync_conf: 0,
    }));
  }
  console.error('[analyze] speaker detection done');

  const annotated = await annotateShots(frames, shots, speaker);
  console.error('[analyze] annotation done');
  return { shots: annotated, ...deriveMetrics(annotated, input.durationMs) };
}
