// Fingerprint assembly: combine per-reel analysis across N reels in a
// collection into a single CollectionFingerprint that the autocut +
// script-gen pipelines can consume.
//
// Pure function over ReelAnalysisResult[] — no I/O, no IPC, no
// persistence. The renderer (or any downstream consumer) calls this
// after the analyzer has produced per-reel results.
import type { ReelAnalysisResult } from './analyze';
import { clusterHooks, type HookArchetype } from './hook-cluster';
import { SFX_TYPES, type SfxType } from './sfx-classify';
import {
  CLIP_TYPES,
  FRAME_REGIONS,
  OVERLAY_KINDS,
  OVERLAY_MOTIONS,
  type ClipType,
  type FrameRegion,
  type OverlayKind,
  type OverlayMotion,
  type ReelShot,
} from './types';

export type { HookArchetype } from './hook-cluster';

/** Bump when the fingerprint shape or aggregation semantics change. */
export const FINGERPRINT_VERSION = 2;

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

  // ---- Media overlays (stickers / GIFs / images / PiP / emoji) ----
  /** Fraction of shots across the collection that contain at least one
   *  media overlay (creator-equal-weighted: mean of per-reel rates). */
  media_overlay_pct: number;
  /** Overlays per minute across the collection (mean of per-reel rates). */
  overlays_per_min: number;
  /** Distribution across overlay kinds, averaged across reels that
   *  had any overlays. Null when no reel in the collection had any. */
  overlay_kind_distribution: Record<OverlayKind, number> | null;
  /** Distribution across overlay motion (static / animated), averaged
   *  across reels that had any overlays. Null when none. */
  overlay_motion_distribution: Record<OverlayMotion, number> | null;
  /** Distribution across the 3x3 grid for overlay centroids, averaged
   *  across reels that had any overlays. Null when none. */
  overlay_region_distribution: Record<FrameRegion, number> | null;
  /** Dominant grid cell when one wins >50% of overlays collection-wide,
   *  else 'mixed'. Null when no overlays. */
  overlay_region_dominant: FrameRegion | 'mixed' | null;

  // ---- Audio pillar ----
  voiceover_pct: number;
  music_pct: number;
  audio_silence_pct: number;
  audio_energy_mean: number;
  /** SFX onsets per minute across the collection (mean of per-reel rates). */
  sfx_per_min: number;
  /** Fraction of shot starts that have an SFX onset within ±200ms,
   *  averaged across reels. The "whoosh-on-every-cut" signature. */
  cuts_with_sfx_pct: number;
  /** Of all SFX onsets in the collection, the fraction that land near a
   *  shot boundary. Tells you whether this creator uses SFX as
   *  transition stings or as ambient embellishment. */
  sfx_at_cuts_pct: number;
  /** Distribution of detected SFX onsets across acoustic types
   *  (impulse_tonal, impulse_noisy, sweep, vocal, sustained, other),
   *  fractions summing to ~1. Empty categories are present with value
   *  0 so the shape is stable. Tells you "creator uses bells + whooshes"
   *  even when exact-library identity isn't recoverable. */
  sfx_type_distribution: Record<SfxType, number>;
  /** Total SFX onsets in the collection used to compute the distribution. */
  sfx_classified_total: number;

  // ---- Hooks ----
  /** Spoken hook (Whisper transcript of the first ~5s of each reel),
   *  with OCR fallback when speech is unavailable. In reel order.
   *  This is the source the hook-archetype clustering reads from. */
  hook_speeches: string[];
  /** OCR'd text from the first shot's frame — kept for the text-overlay
   *  pillar but no longer used as the hook source. In reel order. */
  hook_texts: string[];
  /** LLM-clustered reusable hook templates with weight + examples.
   *  Null when clustering wasn't run (no API key) or failed. When
   *  null, callers should fall back to hook_speeches. */
  hook_archetypes: HookArchetype[] | null;

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

/** Count each onset's acoustic-type classification and return the
 *  per-type fraction (sums to ~1). */
function collectSfxTypeDistribution(
  allShots: ReelShot[],
): { dist: Record<SfxType, number>; total: number } {
  const counts = Object.fromEntries(
    SFX_TYPES.map((t) => [t, 0]),
  ) as Record<SfxType, number>;
  let total = 0;
  for (const shot of allShots) {
    for (const ev of shot.sfx_classifications) {
      counts[ev.type]++;
      total++;
    }
  }
  if (total === 0) {
    return { dist: counts, total: 0 };
  }
  const dist = Object.fromEntries(
    SFX_TYPES.map((t) => [t, counts[t] / total]),
  ) as Record<SfxType, number>;
  return { dist, total };
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
/** Async variant that also calls Claude to cluster the hooks into
 *  archetypes. Falls back to the pure-function output (with
 *  hook_archetypes=null) if no ANTHROPIC_API_KEY is set or the call
 *  fails — clustering is opt-in, not load-bearing. */
export async function assembleFingerprintWithHooks(
  reels: ReelAnalysisResult[],
): Promise<CollectionFingerprint> {
  const fp = assembleFingerprint(reels);
  if (fp.hook_speeches.length === 0) return fp;
  const archetypes = await clusterHooks(fp.hook_speeches);
  return { ...fp, hook_archetypes: archetypes };
}

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

  // Overlay aggregates — average per-reel distributions across only the
  // reels that actually had any overlays, so a few overlay-free reels
  // don't dilute the kind/motion/region shape.
  const overlayReels = reels.filter(
    (r) => r.overlay_kind_distribution !== null,
  );
  const overlayKindDist = meanDistribution(
    overlayReels.map(
      (r) => r.overlay_kind_distribution as Record<OverlayKind, number>,
    ),
    OVERLAY_KINDS,
  );
  const overlayMotionDist = meanDistribution(
    overlayReels.map(
      (r) => r.overlay_motion_distribution as Record<OverlayMotion, number>,
    ),
    OVERLAY_MOTIONS,
  );
  const overlayRegionDist = meanDistribution(
    overlayReels.map(
      (r) => r.overlay_region_distribution as Record<FrameRegion, number>,
    ),
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

    media_overlay_pct: mean(reels.map((r) => r.media_overlay_pct)),
    overlays_per_min: mean(reels.map((r) => r.overlays_per_min)),
    overlay_kind_distribution: overlayKindDist,
    overlay_motion_distribution: overlayMotionDist,
    overlay_region_distribution: overlayRegionDist,
    overlay_region_dominant: pickDominant(overlayRegionDist),

    voiceover_pct: mean(reels.map((r) => r.voiceover_pct)),
    music_pct: mean(reels.map((r) => r.music_pct)),
    audio_silence_pct: mean(reels.map((r) => r.audio_silence_pct)),
    audio_energy_mean: mean(reels.map((r) => r.audio_energy_mean)),
    sfx_per_min: mean(reels.map((r) => r.sfx_per_min)),
    cuts_with_sfx_pct: mean(reels.map((r) => r.cuts_with_sfx_pct)),
    sfx_at_cuts_pct: mean(reels.map((r) => r.sfx_at_cuts_pct)),
    ...(() => {
      const { dist, total } = collectSfxTypeDistribution(allShots);
      return { sfx_type_distribution: dist, sfx_classified_total: total };
    })(),

    hook_speeches: reels
      .map((r) => r.hook_speech ?? r.hook_text)
      .filter((t): t is string => t !== null && t.length > 0),
    hook_texts: reels
      .map((r) => r.hook_text)
      .filter((t): t is string => t !== null && t.length > 0),
    // Filled in by assembleFingerprintWithHooks when an API key is
    // available; pure-function callers get null and can fall back to
    // hook_speeches.
    hook_archetypes: null,

    beat_template: buildBeatTemplate(allShots),
  };
}
