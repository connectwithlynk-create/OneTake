import { execFile } from 'child_process';
import { promisify } from 'util';
import { annotateShots } from './annotate';
import {
  audioMetricsForShots,
  extractReelAudio,
  type ShotAudio,
} from './audio';
import { detectCaptionStyle } from './caption-style';
import { extractShotFrames, type ExtractedFrame } from './frame-extractor';
import { detectScenes } from './scene-detect';
import {
  detectSfxOnsets,
  sfxAtCutsRatio,
  shotSfxMetrics,
  type ShotSfx,
} from './sfx';
import { classifyOnset } from './sfx-classify';
import {
  audioSetModelAvailable,
  classifyOnsetsAudioSet,
} from './sfx-audioset';
import {
  analyzeSfxContext,
  type SfxContext,
  type TypedSfxEvent,
} from './sfx-context';
import { captionShots, type ShotFramesForCaption } from './shot-caption';
import { spokenWindow, transcribeReel } from './transcribe';
import type { SfxClassifiedEvent } from './types';
import type { SfxFeatures } from './sfx-classify';
import { detectSpeaker, type ShotSpeakerInfo } from './speaker';
import { runVAD, speechMaskFromProbs } from './vad';
import {
  CLIP_TYPES,
  FRAME_REGIONS,
  OVERLAY_KINDS,
  OVERLAY_MOTIONS,
  CAMERA_MOTION_KINDS,
  type ClipType,
  type FrameRegion,
  type OverlayKind,
  type OverlayMotion,
  type CameraMotionKind,
  type ReelShot,
  type CaptionStyleProfile,
} from './types';
import { detectAllMotion } from './motion';
import {
  buildClipnosisStyleSignature,
  type ClipnosisStyleSignature,
} from './style-signature';

/** Zeroed acoustic features, used when a model-classified onset couldn't
 *  also produce heuristic features (e.g. window clamped at the buffer
 *  edge). Keeps SfxClassifiedEvent.features non-null. */
const EMPTY_SFX_FEATURES: SfxFeatures = {
  peak_rms: 0,
  baseline_rms: 0,
  spike_ratio: 0,
  delta_centroid_hz: 0,
  delta_flatness: 0,
  delta_voice_band_ratio: 0,
  delta_high_band_ratio: 0,
};

/** Bump when the analysis algorithm changes meaningfully. */
export const ANALYSIS_VERSION = 32;

type TextRole = NonNullable<ReelShot['text_moments'][number]['role']>;

const IMAGE_TEXT_VISUAL_RE =
  /\b(invitation|flyer|poster|card|slide|screenshot|screen grab|tweet|post|profile|article|headline|document|chart|graph|logo|badge|sticker|callout|panel)\b/i;
const LAYERED_VISUAL_RE =
  /\b(overlaid|overlay|floating|foreground|insert|card|panel|top media|bottom media|split|picture[\s-]*in[\s-]*picture|pip)\b/i;

function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
}

function transcriptOverlap(text: string, spoken: string): number {
  const words = wordTokens(text);
  if (words.length === 0) return 0;
  const spokenSet = new Set(wordTokens(spoken));
  if (spokenSet.size === 0) return 0;
  let matched = 0;
  for (const word of words) if (spokenSet.has(word)) matched += 1;
  return matched / words.length;
}

function looksLikeImageTextShot(shot: ReelShot): boolean {
  const visual = shot.visual_caption ?? '';
  return IMAGE_TEXT_VISUAL_RE.test(visual);
}

function classifyTextMomentRole(
  shot: ReelShot,
  text: ReelShot['text_moments'][number],
): { role: TextRole; confidence: number } {
  const clean = text.text.replace(/\s+/g, ' ').trim();
  if (clean.length < 3 || !/[A-Za-z0-9]/.test(clean)) {
    return { role: 'unknown', confidence: 0.25 };
  }
  const [row, col] = text.region.split('_');
  const overlap = transcriptOverlap(clean, shot.spoken_window);
  const imageTextShot = looksLikeImageTextShot(shot);
  const area = Math.max(0, text.bbox.w * text.bbox.h);
  const centered = col === 'center';
  const subtitleBand = row === 'bottom' || row === 'middle';

  if (overlap >= 0.45 && subtitleBand && centered) {
    return { role: 'subtitle', confidence: Math.min(0.98, 0.62 + overlap * 0.35) };
  }
  if (overlap >= 0.65 && subtitleBand) {
    return { role: 'subtitle', confidence: Math.min(0.95, 0.55 + overlap * 0.35) };
  }
  if (imageTextShot && (row === 'top' || row === 'middle' || area > 0.015)) {
    return { role: 'image_text', confidence: 0.86 };
  }
  if (row === 'top' && overlap < 0.25) {
    return { role: 'title', confidence: 0.72 };
  }
  if (overlap < 0.18 && area > 0.02) {
    return { role: 'image_text', confidence: 0.68 };
  }
  if (overlap >= 0.35 && subtitleBand) {
    return { role: 'subtitle', confidence: 0.68 };
  }
  return { role: 'unknown', confidence: 0.4 };
}

function classifyTextMomentRoles(shots: ReelShot[]): void {
  for (const shot of shots) {
    for (const text of shot.text_moments) {
      const classified = classifyTextMomentRole(shot, text);
      text.role = classified.role;
      text.role_confidence = classified.confidence;
    }
  }
}

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
  /** Whisper transcript of the first ~5 seconds of audio — the
   *  SPOKEN hook. Preferred over OCR hook_text for clustering because
   *  it captures the creator's actual opening words, not whatever text
   *  overlay happened to land at the start. Null when no OPENAI_API_KEY
   *  is set or the transcription call failed. */
  hook_speech: string | null;
  /** SFX onsets per minute, computed from total events / reel duration. */
  sfx_per_min: number;
  /** Fraction of shot starts that have an SFX onset within ±200ms — the
   *  "whoosh on every cut" signature. */
  cuts_with_sfx_pct: number;
  /** Of all SFX onsets, the fraction that land near a shot boundary. */
  sfx_at_cuts_pct: number;
  /** How this reel uses SFX relative to the spoken transcript + structure
   *  (cadence, hook escalation, which moments get a hit) — see
   *  sfx-context.ts. Null when no audio/transcript was available. */
  sfx_context: SfxContext | null;
  /** Fraction of shots that contain at least one media overlay
   *  (sticker / GIF / image / PiP video / emoji graphic). Text
   *  captions are NOT counted here — see text_overlay_pct for those. */
  media_overlay_pct: number;
  /** Total detected overlays per minute of reel duration. */
  overlays_per_min: number;
  /** Distribution across OverlayKind, fraction of detected overlays in
   *  each bucket. Empty buckets present with value 0 so the shape is
   *  stable. Null when no overlays were detected. */
  overlay_kind_distribution: Record<OverlayKind, number> | null;
  /** Distribution across OverlayMotion (static / animated), fraction of
   *  detected overlays in each bucket. Null when no overlays. */
  overlay_motion_distribution: Record<OverlayMotion, number> | null;
  /** Distribution across the 3x3 grid for overlay centroids. Null when
   *  no overlays. */
  overlay_region_distribution: Record<FrameRegion, number> | null;
  /** Fraction of shots in each measured camera-motion bucket (optical
   *  flow). Buckets always present with value 0 for a stable shape.
   *  Null when no shots had a motion estimate. */
  camera_motion_distribution: Record<CameraMotionKind, number> | null;
  /** The single motion bucket covering >40% of shots, 'mixed' when none
   *  dominates, or null when no estimates. ('none' can be dominant — a
   *  reel of static holds.) */
  camera_motion_dominant: CameraMotionKind | 'mixed' | null;
  /** Mean detection confidence across shots that had an estimate, [0,1].
   *  Null when no estimates. */
  camera_motion_confidence: number | null;
  /** Spoken-word caption (burned-in subtitle) style for the reel —
   *  position, word-by-word vs sentence chunking, active-word highlight,
   *  casing, animation, font/color. `present: false` when the reel has no
   *  spoken-word captions. Null when no OPENAI_API_KEY or the vision call
   *  failed. Filled in by analyzeReel — deriveMetrics is pure and can't
   *  run the vision pass. */
  caption_style: CaptionStyleProfile | null;
  /** Clipnosis-owned fusion layer over detector outputs: rhythm grammar,
   *  L1/L2/L3 layer grammar, script-to-visual triggers, and reproduction
   *  rules. This is the product's proprietary edit fingerprint. */
  style_signature: ClipnosisStyleSignature | null;
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
      hook_speech: null,
      sfx_per_min: 0,
      cuts_with_sfx_pct: 0,
      sfx_at_cuts_pct: 0,
      sfx_context: null,
      media_overlay_pct: 0,
      overlays_per_min: 0,
      overlay_kind_distribution: null,
      overlay_motion_distribution: null,
      overlay_region_distribution: null,
      camera_motion_distribution: null,
      camera_motion_dominant: null,
      camera_motion_confidence: null,
      caption_style: null,
      style_signature: null,
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

  // Overlay aggregates - count overlay INSTANCES across all shots,
  // mirroring how text aggregates count text moments. A long shot with
  // multiple overlays contributes each one to the distributions.
  const allOverlays = shots.flatMap((s) => s.overlays);
  const shotsWithOverlay = shots.filter((s) => s.overlays.length > 0).length;
  let overlayKindDist: Record<OverlayKind, number> | null = null;
  let overlayMotionDist: Record<OverlayMotion, number> | null = null;
  let overlayRegionDist: Record<FrameRegion, number> | null = null;
  if (allOverlays.length > 0) {
    const k = Object.fromEntries(OVERLAY_KINDS.map((x) => [x, 0])) as Record<
      OverlayKind,
      number
    >;
    const m = Object.fromEntries(OVERLAY_MOTIONS.map((x) => [x, 0])) as Record<
      OverlayMotion,
      number
    >;
    const r = Object.fromEntries(FRAME_REGIONS.map((x) => [x, 0])) as Record<
      FrameRegion,
      number
    >;
    for (const o of allOverlays) {
      k[o.kind]++;
      m[o.motion]++;
      r[o.region]++;
    }
    const n = allOverlays.length;
    for (const key of OVERLAY_KINDS) k[key] /= n;
    for (const key of OVERLAY_MOTIONS) m[key] /= n;
    for (const key of FRAME_REGIONS) r[key] /= n;
    overlayKindDist = k;
    overlayMotionDist = m;
    overlayRegionDist = r;
  }

  // Camera-motion aggregates — fraction of shots in each measured bucket.
  // Only shots that produced an estimate count toward the denominator, so
  // a reel where flow couldn't run isn't reported as all-static.
  const motionShots = shots.filter((s) => s.detected_motion !== null);
  let cameraMotionDist: Record<CameraMotionKind, number> | null = null;
  let cameraMotionDominant: CameraMotionKind | 'mixed' | null = null;
  let cameraMotionConfidence: number | null = null;
  if (motionShots.length > 0) {
    const c = Object.fromEntries(
      CAMERA_MOTION_KINDS.map((x) => [x, 0]),
    ) as Record<CameraMotionKind, number>;
    let confSum = 0;
    for (const s of motionShots) {
      const m = s.detected_motion!;
      c[m.kind]++;
      confSum += m.confidence;
    }
    const total = motionShots.length;
    const [topKind, topCount] = Object.entries(c).sort(
      ([, a], [, b]) => b - a,
    )[0] as [CameraMotionKind, number];
    cameraMotionDominant = topCount / total > 0.4 ? topKind : 'mixed';
    for (const key of CAMERA_MOTION_KINDS) c[key] /= total;
    cameraMotionDist = c;
    cameraMotionConfidence = confSum / total;
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
    // hook_speech filled in by analyzeReel (deriveMetrics is pure).
    hook_speech: null,
    sfx_per_min: sfxPerMin,
    cuts_with_sfx_pct: cutsWithSfxPct,
    // Filled in by analyzeReel - deriveMetrics can't see the raw events.
    sfx_at_cuts_pct: 0,
    sfx_context: null,
    media_overlay_pct: shotsWithOverlay / shots.length,
    overlays_per_min:
      totalDur > 0 ? (allOverlays.length * 60_000) / totalDur : 0,
    overlay_kind_distribution: overlayKindDist,
    overlay_motion_distribution: overlayMotionDist,
    overlay_region_distribution: overlayRegionDist,
    camera_motion_distribution: cameraMotionDist,
    camera_motion_dominant: cameraMotionDominant,
    camera_motion_confidence: cameraMotionConfidence,
    // Filled in by analyzeReel — deriveMetrics can't run the vision pass.
    caption_style: null,
    // Filled in by analyzeReel after caption style + SFX context are known.
    style_signature: null,
  };
}

/**
 * Run the analysis pipeline on a streamable video URL.
 *
 * Pipeline: ffmpeg scene detection -> real shot boundaries -> one
 * representative frame per shot (face detection) -> Light-ASD speaker
 * detection per shot -> OCR each -> derive aggregate metrics.
 */
const execFileAsync = promisify(execFile);

/** Probe a media source's duration (ms) via ffprobe. Returns 0 on
 *  failure. The Instagram browser resolver returns duration_ms = 0
 *  (the media API response it intercepts omits it), so without this the
 *  analyzer would bail on every IG reel — read the duration straight
 *  from the playable stream instead. */
async function probeDurationMs(url: string): Promise<number> {
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        url,
      ],
      { timeout: 30_000 },
    );
    const sec = parseFloat(stdout.trim());
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
  } catch {
    return 0;
  }
}

export async function analyzeReel(
  input: ReelAnalysisInput,
): Promise<ReelAnalysisResult> {
  let durationMs = input.durationMs;
  if (durationMs <= 0) {
    // Resolver gave no duration (e.g. the IG browser resolver) — probe
    // the playable stream directly before giving up.
    durationMs = await probeDurationMs(input.playableUrl);
    console.error('[analyze] probed duration', durationMs, 'ms');
  }
  if (durationMs <= 0) {
    return { shots: [], ...deriveMetrics([], 0) };
  }
  input = { ...input, durationMs };
  console.error('[analyze] start, duration', input.durationMs, 'ms');
  const shots = await detectScenes(input.playableUrl, input.durationMs);
  console.error('[analyze] detected', shots.length, 'shots');
  // Multi-frame sampling: each shot gets several candidate timestamps and
  // we pick the rep frame with the best face detection. We bump samples
  // to 5 here so the first and last samples are spread far enough apart
  // (~17% to ~83% of the shot) to expose motion for the paired-frame
  // captioner — start/end of three samples is too close together for
  // longer shots to show clear motion.
  const shotFrames = await extractShotFrames(input.playableUrl, shots, {
    samplesPerShot: 5,
  });
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

  // The three expensive stages below — SyncNet speaker detection, the
  // audio pipeline (extract → VAD → transcribe → SFX), and per-shot
  // vision captioning — share no data with each other, so they run
  // CONCURRENTLY and join at annotation. Each branch stays best-effort
  // and degrades gracefully on its own, exactly as the serial version did.

  // Speaker detection (SyncNet) - best-effort; never aborts the pipeline.
  // Pass the rep-frame face flags so no-face shots skip the heavy work.
  // This is the single most expensive stage (~3-5s per face shot) and is
  // only used for talking-head/speaker clip typing — irrelevant to
  // subtitle-style or overlay analysis. ANALYZE_SKIP_SPEAKER=1 skips it
  // (verdicts become 'unknown') so caption/style iteration runs fast.
  const skipSpeaker = process.env.ANALYZE_SKIP_SPEAKER === '1';
  const unknownSpeaker = (): ShotSpeakerInfo[] =>
    shots.map(() => ({
      verdict: 'unknown' as const,
      confidence: 0,
      sync_conf: 0,
    }));
  const speakerPromise: Promise<ShotSpeakerInfo[]> = (async () => {
    if (skipSpeaker) {
      console.error(
        '[analyze] speaker detection SKIPPED (ANALYZE_SKIP_SPEAKER)',
      );
      return unknownSpeaker();
    }
    try {
      const hasFaceHints = reps.map((r) => r?.face != null);
      const speaker = await detectSpeaker(
        input.playableUrl,
        shots,
        hasFaceHints,
      );
      console.error('[analyze] speaker detection done');
      return speaker;
    } catch (err) {
      console.error(
        '[analyze] speaker detection failed:',
        err instanceof Error ? err.message : String(err),
      );
      return unknownSpeaker();
    }
  })();

  // Per-shot motion-aware caption via OpenAI vision. We pass the
  // FIRST and LAST sample frames so the LLM can describe in-shot
  // motion (zoom, pan, scroll) instead of treating every shot as a
  // static moment. Falls back to single-frame caption when only one
  // sample is available. Returns all-null when no OPENAI_API_KEY.
  // Needs only the already-extracted frames, so it overlaps the
  // speaker + audio branches.
  const captionsPromise: Promise<(string | null)[]> = (async () => {
    try {
      const captionInputs: (ShotFramesForCaption | null)[] = shotFrames.map(
        (sf) => {
          const valid = sf.samples.filter(
            (s): s is NonNullable<typeof s> => s !== null && !!s.jpegBase64,
          );
          if (valid.length === 0) {
            // Last resort: try the rep frame alone.
            if (sf.rep?.jpegBase64) {
              return { start: sf.rep.jpegBase64, end: sf.rep.jpegBase64 };
            }
            return null;
          }
          const first = valid[0].jpegBase64;
          const last = valid[valid.length - 1].jpegBase64;
          return { start: first, end: last };
        },
      );
      return await captionShots(captionInputs);
    } catch (err) {
      console.error(
        '[shot-caption] batch failed:',
        err instanceof Error ? err.message : String(err),
      );
      return shotFrames.map(() => null);
    }
  })();

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
  const audioPromise = (async () => {
    let shotAudio: ShotAudio[] = audioFallback;
    let shotSfx: ShotSfx[] = shots.map(() => ({
      sfx_count: 0,
      sfx_at_start: false,
    }));
    let sfxClassificationsPerShot: SfxClassifiedEvent[][] = shots.map(
      () => [],
    );
    let sfxAtCutsPct = 0;
    let sfxContext: SfxContext | null = null;
    let hookSpeech: string | null = null;
    let transcriptWords: import('./transcribe').TranscriptWord[] = [];
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

      // Full-reel transcription via Whisper verbose_json. One API call
      // gives us both the hook (derived slice of the first ~5s of
      // words) and the word-level timestamps we use to annotate each
      // detected media overlay with what was being said while it was
      // on screen. Best-effort — returns null when no OPENAI_API_KEY.
      try {
        const transcript = await transcribeReel(samples);
        if (transcript) {
          transcriptWords = transcript.words;
          hookSpeech = transcript.hook.length > 0 ? transcript.hook : null;
          if (hookSpeech) {
            console.error(
              '[hook-speech]',
              `"${hookSpeech.replace(/\s+/g, ' ').slice(0, 80)}"`,
            );
          }
          console.error(
            '[transcribe] reel transcript:',
            transcript.words.length,
            'words',
          );
        }
      } catch (err) {
        console.error(
          '[transcribe] reel transcription failed:',
          err instanceof Error ? err.message : String(err),
        );
      }

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

        // Type classification for each detected onset.
        //
        // The PANNs CNN14 (AudioSet) model is GATED OFF in the reel path
        // by default: it cannot name SFX buried under voiceover — verified
        // 2026-06-10, even SOTA source separation (demucs) recovered 0/23
        // onsets because the SFX energy is ~15-20 dB under the voice and
        // gets destroyed, not exposed. On real reels it produced only
        // garbage false-positives ("Rapping", "Animal"). So reels rely on
        // the delta-spectrum heuristic buckets (which work on buried SFX).
        // The model still earns its keep labeling the CLEAN myinstants SFX
        // library offline — see scripts/index-myinstants-audioset.ts and
        // export/sfx-resolve.ts. Set SFX_MODEL_IN_REELS=1 to re-enable the
        // hybrid for experimentation.
        const onsetMsAll = sfxEvents.map((e) => e.ms);
        const useModel = process.env.SFX_MODEL_IN_REELS === '1';
        const modelResults: Awaited<
          ReturnType<typeof classifyOnsetsAudioSet>
        > = useModel
          ? await classifyOnsetsAudioSet(samples, onsetMsAll, speechMask)
          : onsetMsAll.map(() => null);
        const resultByMs = new Map(
          onsetMsAll.map((ms, i) => [ms, modelResults[i]]),
        );

        sfxClassificationsPerShot = shots.map(() => []);
        let modelEvents = 0;
        let heuristicEvents = 0;
        for (let s = 0; s < shots.length; s++) {
          const shot = shots[s];
          const eventsInShot = sfxEvents.filter(
            (e) => e.ms >= shot.start_ms && e.ms < shot.end_ms,
          );
          const perEvent: SfxClassifiedEvent[] = [];
          for (const ev of eventsInShot) {
            const model = resultByMs.get(ev.ms);
            // Heuristic features are still computed (cheap, pure DSP) so
            // every event carries the raw acoustic features regardless of
            // which classifier won — useful for debugging / future ML.
            const heur = classifyOnset(samples, ev.ms);
            if (model) {
              perEvent.push({
                ms: ev.ms,
                type: model.bucket,
                confidence: model.confidence,
                features:
                  heur?.features ?? EMPTY_SFX_FEATURES,
                source: 'model',
                label: model.top,
                labels: model.labels,
              });
              modelEvents++;
            } else if (heur) {
              perEvent.push({
                ms: ev.ms,
                type: heur.type,
                confidence: heur.confidence,
                features: heur.features,
                source: 'heuristic',
              });
              heuristicEvents++;
            }
          }
          sfxClassificationsPerShot[s] = perEvent;
        }
        console.error(
          '[sfx-classify]',
          modelEvents,
          'by model +',
          heuristicEvents,
          'by heuristic of',
          sfxEvents.length,
          'onsets',
          !useModel
            ? '(model gated off in reels — heuristic only)'
            : audioSetModelAvailable()
              ? ''
              : '(model absent: heuristic-only)',
        );

        // SFX-in-context: correlate the typed onsets with the transcript
        // word stream + structure to recover the USAGE PATTERN (cadence,
        // hook escalation, which moments get a hit). Hook window = the
        // first shot; reel length = analysis duration.
        const typedSfxEvents: TypedSfxEvent[] = sfxClassificationsPerShot
          .flat()
          .map((e) => ({ ms: e.ms, type: e.type }));
        const hookMs = shots[0]?.end_ms ?? 5000;
        sfxContext = await analyzeSfxContext(
          typedSfxEvents,
          transcriptWords,
          shots,
          hookMs,
          input.durationMs,
        );
        console.error(
          '[sfx-context]',
          sfxContext.llm ? 'llm' : 'template',
          '—',
          sfxContext.pattern_summary,
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
    return {
      shotAudio,
      shotSfx,
      sfxClassificationsPerShot,
      sfxAtCutsPct,
      sfxContext,
      hookSpeech,
      transcriptWords,
    };
  })();

  // Join the three concurrent branches.
  const [speaker, audioResult, captions] = await Promise.all([
    speakerPromise,
    audioPromise,
    captionsPromise,
  ]);
  const {
    shotAudio,
    shotSfx,
    sfxClassificationsPerShot,
    sfxAtCutsPct,
    sfxContext,
    hookSpeech,
    transcriptWords,
  } = audioResult;

  const annotated = await annotateShots(
    shotFrames,
    shots,
    speaker,
    shotAudio,
    shotSfx,
    sfxClassificationsPerShot,
  );
  console.error('[analyze] annotation done');

  // Per-shot spoken_window: every shot gets the transcript text that
  // played during its [start_ms, end_ms]. This is the glue the
  // synthesis engine needs — for a target line, find the best-matching
  // shot from the collection by comparing its visual_caption against
  // shots whose spoken_window covers a similar topic.
  if (transcriptWords.length > 0) {
    for (const shot of annotated) {
      shot.spoken_window = spokenWindow(
        transcriptWords,
        shot.start_ms,
        shot.end_ms,
      );
      for (const ov of shot.overlays) {
        ov.spoken_window = spokenWindow(
          transcriptWords,
          ov.start_ms,
          ov.end_ms,
        );
      }
    }
    const shotsWithSpoken = annotated.filter(
      (s) => s.spoken_window.length > 0,
    ).length;
    console.error(
      '[transcribe] mapped transcript onto',
      shotsWithSpoken,
      'of',
      annotated.length,
      'shots',
    );
  }

  // Per-shot camera-motion detection via block-based optical flow on the
  // already-extracted sample frames. Best-effort: failures leave
  // detected_motion null and the pipeline continues. ANALYZE_SKIP_MOTION=1
  // skips it for fast caption/style iteration.
  if (process.env.ANALYZE_SKIP_MOTION === '1') {
    console.error('[motion] detection SKIPPED (ANALYZE_SKIP_MOTION)');
  } else {
    try {
      const motions = detectAllMotion(shotFrames);
      let detected = 0;
      let moving = 0;
      for (let i = 0; i < annotated.length; i++) {
        annotated[i].detected_motion = motions[i] ?? null;
        if (motions[i]) {
          detected++;
          if (motions[i]!.kind !== 'none') moving++;
        }
      }
      console.error(
        '[motion] estimated',
        detected,
        'of',
        annotated.length,
        'shots (',
        moving,
        'with camera motion)',
      );
    } catch (err) {
      console.error(
        '[motion] failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Captions were computed concurrently with speaker + audio above;
  // here we just attach them to the annotated shots.
  {
    let filled = 0;
    for (let i = 0; i < annotated.length; i++) {
      annotated[i].visual_caption = captions[i] ?? null;
      if (captions[i]) filled++;
    }
    if (filled > 0) {
      console.error(
        '[shot-caption] captioned',
        filled,
        'of',
        annotated.length,
        'shots (motion-aware)',
      );
    }
  }

  classifyTextMomentRoles(annotated);
  console.error('[text-role] classified OCR lines as subtitle/image/title/unknown');

  const metrics = deriveMetrics(annotated, input.durationMs);
  // deriveMetrics can't see the raw event list or the transcription
  // result, so we fill those in here.
  metrics.sfx_at_cuts_pct = sfxAtCutsPct;
  metrics.sfx_context = sfxContext;
  metrics.hook_speech = hookSpeech;

  // Spoken-word caption (subtitle) STYLE. OCR already told us WHERE text
  // sits; this vision pass tells us what the captions LOOK like — bold vs
  // thin, white vs colored, all-caps, one-word-at-a-time vs sentences,
  // pop/karaoke animation, emoji. We reuse the already-extracted sample
  // frames (no extra ffmpeg pass), aligned 1:1 with the shots. Best-effort:
  // null when no OPENAI_API_KEY or the call fails.
  try {
    const framesByShot = shotFrames.map((sf) =>
      sf.samples.filter((f): f is ExtractedFrame => f !== null),
    );
    metrics.caption_style = await detectCaptionStyle(annotated, framesByShot);
    if (metrics.caption_style?.present) {
      console.error(
        '[caption-style]',
        metrics.caption_style.style_label || '(captions present)',
      );
    }
  } catch (err) {
    console.error(
      '[caption-style] failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  metrics.style_signature = buildClipnosisStyleSignature({
    shots: annotated,
    durationMs: input.durationMs,
    medianShotMs: metrics.median_shot_ms,
    cutsPerSec: metrics.cuts_per_sec,
    captionStyle: metrics.caption_style,
    sfxContext: metrics.sfx_context,
    sfxPerMin: metrics.sfx_per_min,
    cutsWithSfxPct: metrics.cuts_with_sfx_pct,
  });
  if (metrics.style_signature) {
    console.error(
      '[clipnosis-signature]',
      metrics.style_signature.summary,
      `conf=${Math.round(metrics.style_signature.confidence * 100)}%`,
    );
  }

  return { shots: annotated, ...metrics };
}
