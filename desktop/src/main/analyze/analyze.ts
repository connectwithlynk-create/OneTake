import { annotateShots } from './annotate';
import {
  audioMetricsForShots,
  extractReelAudio,
  type ShotAudio,
} from './audio';
import { extractShotFrames } from './frame-extractor';
import { detectScenes } from './scene-detect';
import {
  detectSfxOnsets,
  sfxAtCutsRatio,
  shotSfxMetrics,
  type ShotSfx,
} from './sfx';
import { detectSpeaker, type ShotSpeakerInfo } from './speaker';
import { runVAD, speechMaskFromProbs } from './vad';
import {
  CLIP_TYPES,
  FRAME_REGIONS,
  type ClipType,
  type FrameRegion,
  type ReelShot,
} from './types';

/** Bump when the analysis algorithm changes meaningfully. */
export const ANALYSIS_VERSION = 15;

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
  /** 3x3 grid cell most face shots sit in, or null if no faces. "mixed"
   *  when no single cell claims a clear majority (>50% of face shots). */
  face_region_dominant: FrameRegion | 'mixed' | null;
  /** Per-cell distribution across the 3x3 grid (face shots only).
   *  Null when there are no face shots. */
  face_region_distribution: Record<FrameRegion, number> | null;
  /** Median face bbox HEIGHT (normalized 0-1) across all face shots — a
   *  proxy for typical face size / closeness. Null if no faces. */
  face_size_median: number | null;
  /** 3x3 grid cell where text overlays most commonly sit. "mixed" when
   *  no cell wins a clear majority. Null when no text was detected. */
  text_region_dominant: FrameRegion | 'mixed' | null;
  /** Per-cell distribution of text overlays across the 3x3 grid (text
   *  shots only). Null when there are no text shots. */
  text_region_distribution: Record<FrameRegion, number> | null;
  /** Duration-weighted mean RMS amplitude across the reel, [0, 1]. */
  audio_energy_mean: number;
  /** Standard deviation of per-shot RMS — dynamic range proxy. Higher =
   *  more variation between loud and quiet shots. */
  audio_energy_std: number;
  /** Fraction of total duration that's near-silent. */
  audio_silence_pct: number;
  /** Fraction of total duration flagged as speech by Silero VAD. */
  voiceover_pct: number;
  /** Fraction of total duration that's audible but non-speech (music,
   *  ambient, SFX) — the "music or other non-vocal" bucket. */
  music_pct: number;
  /** SFX onsets per minute, computed from total events / reel duration. */
  sfx_per_min: number;
  /** Fraction of shot starts that have an SFX onset within ±200ms — the
   *  "whoosh on every cut" signature. */
  cuts_with_sfx_pct: number;
  /** Of all SFX onsets, the fraction that land near a shot boundary. */
  sfx_at_cuts_pct: number;
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
      face_region_dominant: null,
      face_region_distribution: null,
      face_size_median: null,
      text_region_dominant: null,
      text_region_distribution: null,
      audio_energy_mean: 0,
      audio_energy_std: 0,
      audio_silence_pct: 0,
      voiceover_pct: 0,
      music_pct: 0,
      sfx_per_min: 0,
      cuts_with_sfx_pct: 0,
      sfx_at_cuts_pct: 0,
    };
  }
  const durations = shots.map((s) => s.end_ms - s.start_ms);
  const totalDur = durations.reduce((a, b) => a + b, 0) || durationMs || 1;
  const talkingDur = shots
    .filter((s) => s.has_face)
    .reduce((sum, s) => sum + (s.end_ms - s.start_ms), 0);
  const textShots = shots.filter((s) => s.text_moments.length > 0).length;
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

  // Face layout aggregates - face shots only.
  const faceShots = shots.filter((s) => s.face_bbox !== null);
  let faceRegionDominant: FrameRegion | 'mixed' | null = null;
  let faceSizeMedian: number | null = null;
  let faceRegionDistribution: Record<FrameRegion, number> | null = null;
  if (faceShots.length > 0) {
    const regionCounts = Object.fromEntries(
      FRAME_REGIONS.map((r) => [r, 0]),
    ) as Record<FrameRegion, number>;
    for (const s of faceShots) {
      if (s.face_region) regionCounts[s.face_region]++;
    }
    const total = faceShots.length;
    const [topRegion, topCount] = Object.entries(regionCounts).sort(
      ([, a], [, b]) => b - a,
    )[0] as [FrameRegion, number];
    // 9 cells means a strict majority is a strong signal; below that we
    // call it 'mixed' rather than picking a near-tie cell.
    faceRegionDominant = topCount / total > 0.5 ? topRegion : 'mixed';
    faceRegionDistribution = Object.fromEntries(
      FRAME_REGIONS.map((r) => [r, regionCounts[r] / total]),
    ) as Record<FrameRegion, number>;
    const heights = faceShots.map((s) => s.face_bbox?.h ?? 0).sort();
    const mid = Math.floor(heights.length / 2);
    faceSizeMedian =
      heights.length % 2
        ? heights[mid]
        : (heights[mid - 1] + heights[mid]) / 2;
  }

  // Text overlay layout aggregates - count text MOMENTS, not shots. A
  // single long shot may have several text overlays appear in different
  // positions; each contributes a moment to the distribution.
  const allTextMoments = shots.flatMap((s) => s.text_moments);
  let textRegionDominant: FrameRegion | 'mixed' | null = null;
  let textRegionDistribution: Record<FrameRegion, number> | null = null;
  if (allTextMoments.length > 0) {
    const counts = Object.fromEntries(
      FRAME_REGIONS.map((r) => [r, 0]),
    ) as Record<FrameRegion, number>;
    for (const m of allTextMoments) counts[m.region]++;
    const total = allTextMoments.length;
    const [topRegion, topCount] = Object.entries(counts).sort(
      ([, a], [, b]) => b - a,
    )[0] as [FrameRegion, number];
    textRegionDominant = topCount / total > 0.5 ? topRegion : 'mixed';
    textRegionDistribution = Object.fromEntries(
      FRAME_REGIONS.map((r) => [r, counts[r] / total]),
    ) as Record<FrameRegion, number>;
  }

  // Audio aggregates - duration-weighted across shots.
  let weightedRmsSum = 0;
  let weightedSilenceSum = 0;
  let weightedSpeechSum = 0;
  let weightedMusicSum = 0;
  let totalSfx = 0;
  let cutsWithSfx = 0;
  for (const s of shots) {
    const w = (s.end_ms - s.start_ms) / totalDur;
    weightedRmsSum += s.audio_rms_mean * w;
    weightedSilenceSum += s.audio_silence_pct * w;
    weightedSpeechSum += s.audio_speech_pct * w;
    weightedMusicSum += s.audio_music_pct * w;
    totalSfx += s.sfx_count;
    if (s.sfx_at_start) cutsWithSfx++;
  }
  const sfxPerMin = totalDur > 0 ? (totalSfx * 60_000) / totalDur : 0;
  const cutsWithSfxPct = cutsWithSfx / shots.length;
  const audioEnergyMean = weightedRmsSum;
  // Std of per-shot RMS (unweighted) — a usable dynamic-range proxy.
  const rmsValues = shots.map((s) => s.audio_rms_mean);
  const rmsAvg =
    rmsValues.reduce((a, b) => a + b, 0) / Math.max(rmsValues.length, 1);
  const audioEnergyStd = Math.sqrt(
    rmsValues.reduce((acc, v) => acc + (v - rmsAvg) ** 2, 0) /
      Math.max(rmsValues.length, 1),
  );

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
    face_region_dominant: faceRegionDominant,
    face_region_distribution: faceRegionDistribution,
    face_size_median: faceSizeMedian,
    text_region_dominant: textRegionDominant,
    text_region_distribution: textRegionDistribution,
    audio_energy_mean: audioEnergyMean,
    audio_energy_std: audioEnergyStd,
    audio_silence_pct: weightedSilenceSum,
    voiceover_pct: weightedSpeechSum,
    music_pct: weightedMusicSum,
    sfx_per_min: sfxPerMin,
    cuts_with_sfx_pct: cutsWithSfxPct,
    // Filled in by analyzeReel - deriveMetrics can't see the raw events.
    sfx_at_cuts_pct: 0,
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
  // Multi-frame sampling: each shot gets several candidate timestamps and
  // we pick the rep frame with the best face detection. Catches faces
  // that miss the exact midpoint (motion, brief occlusion, position shifts).
  const shotFrames = await extractShotFrames(input.playableUrl, shots);
  const reps = shotFrames.map((sf) => sf.rep);
  const facesFound = reps.filter((r) => r?.face != null).length;
  console.error(
    '[analyze] extracted',
    reps.filter(Boolean).length,
    'of',
    shots.length,
    'rep frames (',
    facesFound,
    'with face)',
  );

  // Speaker detection (SyncNet) - best-effort; never aborts the pipeline.
  // Pass the rep-frame face flags so no-face shots skip the heavy work.
  let speaker: ShotSpeakerInfo[];
  try {
    const hasFaceHints = reps.map((r) => r?.face != null);
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

  // Audio extraction + VAD + SFX + per-shot metrics. Best-effort
  // throughout; never aborts the pipeline. VAD/SFX failures degrade
  // gracefully to RMS-only and zero-SFX respectively.
  const audioFallback: ShotAudio[] = shots.map(() => ({
    rms_mean: 0,
    peak_rms: 0,
    silence_pct: 1,
    speech_pct: 0,
    music_pct: 0,
  }));
  let shotAudio: ShotAudio[] = audioFallback;
  let shotSfx: ShotSfx[] = shots.map(() => ({
    sfx_count: 0,
    sfx_at_start: false,
  }));
  let sfxAtCutsPct = 0;
  try {
    const samples = await extractReelAudio(input.playableUrl);
    if (samples) {
      let speechMask: boolean[] | undefined;
      try {
        const probs = await runVAD(samples);
        if (probs) {
          speechMask = speechMaskFromProbs(probs);
          const speechFrames = speechMask.filter(Boolean).length;
          console.error(
            '[vad] ran on',
            probs.length,
            'frames;',
            speechFrames,
            'flagged as speech',
          );
        }
      } catch (err) {
        console.error(
          '[vad] failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      shotAudio = audioMetricsForShots(samples, shots, speechMask);
      console.error(
        '[audio] extracted',
        samples.length,
        'samples; per-shot metrics done',
      );

      try {
        const sfxEvents = detectSfxOnsets(samples, speechMask);
        shotSfx = shotSfxMetrics(sfxEvents, shots);
        sfxAtCutsPct = sfxAtCutsRatio(sfxEvents, shots);
        console.error(
          '[sfx] detected',
          sfxEvents.length,
          'onsets;',
          (sfxAtCutsPct * 100).toFixed(0) + '% land near a cut',
        );
      } catch (err) {
        console.error(
          '[sfx] failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      console.error('[audio] extraction returned no samples');
    }
  } catch (err) {
    console.error(
      '[audio] failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  const annotated = await annotateShots(
    shotFrames,
    shots,
    speaker,
    shotAudio,
    shotSfx,
  );
  console.error('[analyze] annotation done');
  const metrics = deriveMetrics(annotated, input.durationMs);
  // deriveMetrics can't see the raw event list, so it leaves
  // sfx_at_cuts_pct as 0 - fill it in here.
  metrics.sfx_at_cuts_pct = sfxAtCutsPct;
  return { shots: annotated, ...metrics };
}
