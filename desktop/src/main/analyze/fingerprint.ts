// Fingerprint assembly: combine per-reel analysis across N reels in a
// collection into a single CollectionFingerprint that the autocut +
// script-gen pipelines can consume.
//
// Pure function over ReelAnalysisResult[] — no I/O, no IPC, no
// persistence. The renderer (or any downstream consumer) calls this
// after the analyzer has produced per-reel results.
import type { ReelAnalysisResult } from './analyze';
import {
  CLIP_TYPES,
  FRAME_REGIONS,
  type ClipType,
  type FrameRegion,
  type ReelShot,
} from './types';

/** Bump when the fingerprint shape or aggregation semantics change. */
export const FINGERPRINT_VERSION = 1;

/** One canonical "beat" the creator uses — derived by grouping shots
 *  across the collection by clip_type and computing per-bucket stats.
 *  The autocut consumes this to slot user clips at matching durations
 *  / with matching text/face properties; script gen uses it to keep
 *  beats aligned to the creator's typical rhythm. */
export interface FingerprintBeat {
  clip_type: ClipType;
  /** Median shot duration for shots of this clip_type, in ms. */
  duration_p50_ms: number;
  /** Number of shots in the collection that contributed to this beat. */
  n_shots: number;
  /** Probability the shot has a text overlay. */
  has_text_p: number;
  /** Probability the shot has a face. */
  has_face_p: number;
  /** Probability the shot is the real speaker (sync-confirmed). */
  is_speaker_p: number;
}

export interface CollectionFingerprint {
  fingerprint_version: number;
  computed_at: number;

  /** How many reels contributed to this fingerprint. */
  n_reels: number;
  /** Total shots aggregated across all reels. */
  n_shots: number;

  // ---- Pacing ----
  /** Median of per-reel median_shot_ms — typical shot length for this
   *  creator across their work. */
  median_shot_ms: number;
  /** Mean of per-reel cuts_per_sec. */
  cuts_per_sec: number;

  // ---- Clip type mix ----
  /** Distribution across clip types, averaged across reels
   *  (duration-weighted per reel, simple mean across reels). */
  clip_type_distribution: Record<ClipType, number>;
  real_speaker_pct: number;
  broll_talking_head_pct: number;

  // ---- Face composition ----
  /** Mean face_size_median across reels that have faces. Null when no
   *  reel in the collection contained any face. */
  face_size_median: number | null;
  /** Distribution across the 3x3 grid, averaged across face-bearing
   *  reels. Null when none had faces. */
  face_region_distribution: Record<FrameRegion, number> | null;
  /** Dominant grid cell when one wins >50% of face shots collection-wide,
   *  else 'mixed'. Null when no faces. */
  face_region_dominant: FrameRegion | 'mixed' | null;

  // ---- Text overlay layout ----
  text_overlay_pct: number;
  text_region_distribution: Record<FrameRegion, number> | null;
  text_region_dominant: FrameRegion | 'mixed' | null;

  // ---- Audio pillar ----
  voiceover_pct: number;
  music_pct: number;
  audio_silence_pct: number;
  audio_energy_mean: number;

  // ---- Hooks ----
  /** Hook text from the first shot of each reel — raw strings, no
   *  clustering yet (future: cluster into archetypes). */
  hook_texts: string[];

  // ---- Beat template (autocut / script-gen bridge) ----
  beat_template: FingerprintBeat[];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Build a Record<K, number> with all keys initialized to 0. */
function zeroDist<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

/** Average several non-null distributions cell-wise. Returns null when
 *  the input list is empty. */
function meanDistribution<K extends string>(
  dists: Record<K, number>[],
  keys: readonly K[],
): Record<K, number> | null {
  if (dists.length === 0) return null;
  const out = zeroDist(keys);
  for (const d of dists) {
    for (const k of keys) out[k] += d[k];
  }
  for (const k of keys) out[k] /= dists.length;
  return out;
}

/** Top cell if it wins >50%, else 'mixed'. Null when distribution is null. */
function pickDominant<K extends string>(
  dist: Record<K, number> | null,
): K | 'mixed' | null {
  if (!dist) return null;
  let topKey: K | null = null;
  let topValue = -Infinity;
  for (const k of Object.keys(dist) as K[]) {
    if (dist[k] > topValue) {
      topValue = dist[k];
      topKey = k;
    }
  }
  if (topKey === null) return null;
  return topValue > 0.5 ? topKey : 'mixed';
}

/** Group all shots across reels by clip_type and compute per-bucket
 *  median duration + has_text/face/speaker probabilities. */
function buildBeatTemplate(allShots: ReelShot[]): FingerprintBeat[] {
  const buckets = new Map<ClipType, ReelShot[]>();
  for (const s of allShots) {
    const list = buckets.get(s.clip_type) ?? [];
    list.push(s);
    buckets.set(s.clip_type, list);
  }
  const beats: FingerprintBeat[] = [];
  for (const ct of CLIP_TYPES) {
    const shots = buckets.get(ct) ?? [];
    if (shots.length === 0) continue;
    const durations = shots.map((s) => s.end_ms - s.start_ms);
    beats.push({
      clip_type: ct,
      n_shots: shots.length,
      duration_p50_ms: Math.round(median(durations)),
      has_text_p:
        shots.filter((s) => s.text_moments.length > 0).length / shots.length,
      has_face_p: shots.filter((s) => s.has_face).length / shots.length,
      is_speaker_p:
        shots.filter((s) => s.speaker_verdict === 'speaker').length /
        shots.length,
    });
  }
  // Sort by count descending — most common beats first.
  beats.sort((a, b) => b.n_shots - a.n_shots);
  return beats;
}

/**
 * Build a single style fingerprint from N reels' analysis results.
 * Aggregation rules:
 *  - Percentages / fractions: simple mean across reels (each reel is
 *    one observation of the creator's style, so reels are equal-weighted).
 *  - median_shot_ms: median of per-reel medians (robust to outlier reels).
 *  - Distributions (clip type, face grid, text grid): mean of per-reel
 *    distributions, restricted to reels where the signal exists (e.g.,
 *    face_region only averaged over face-bearing reels).
 *  - beat_template: pooled across ALL shots in the collection.
 */
export function assembleFingerprint(
  reels: ReelAnalysisResult[],
): CollectionFingerprint {
  const allShots: ReelShot[] = reels.flatMap((r) => r.shots);

  const clipDist = meanDistribution(
    reels.map((r) => r.clip_type_distribution),
    CLIP_TYPES,
  ) ?? zeroDist(CLIP_TYPES);

  const faceReels = reels.filter((r) => r.face_region_distribution !== null);
  const faceDist = meanDistribution(
    faceReels.map((r) => r.face_region_distribution as Record<FrameRegion, number>),
    FRAME_REGIONS,
  );
  const faceSizes = reels
    .map((r) => r.face_size_median)
    .filter((v): v is number => v !== null);

  const textReels = reels.filter((r) => r.text_region_distribution !== null);
  const textDist = meanDistribution(
    textReels.map((r) => r.text_region_distribution as Record<FrameRegion, number>),
    FRAME_REGIONS,
  );

  return {
    fingerprint_version: FINGERPRINT_VERSION,
    computed_at: Date.now(),
    n_reels: reels.length,
    n_shots: allShots.length,

    median_shot_ms: Math.round(median(reels.map((r) => r.median_shot_ms))),
    cuts_per_sec: mean(reels.map((r) => r.cuts_per_sec)),

    clip_type_distribution: clipDist,
    real_speaker_pct: mean(reels.map((r) => r.real_speaker_pct)),
    broll_talking_head_pct: mean(reels.map((r) => r.broll_talking_head_pct)),

    face_size_median: faceSizes.length > 0 ? mean(faceSizes) : null,
    face_region_distribution: faceDist,
    face_region_dominant: pickDominant(faceDist),

    text_overlay_pct: mean(reels.map((r) => r.text_overlay_pct)),
    text_region_distribution: textDist,
    text_region_dominant: pickDominant(textDist),

    voiceover_pct: mean(reels.map((r) => r.voiceover_pct)),
    music_pct: mean(reels.map((r) => r.music_pct)),
    audio_silence_pct: mean(reels.map((r) => r.audio_silence_pct)),
    audio_energy_mean: mean(reels.map((r) => r.audio_energy_mean)),

    hook_texts: reels
      .map((r) => r.hook_text)
      .filter((t): t is string => t !== null && t.length > 0),

    beat_template: buildBeatTemplate(allShots),
  };
}
