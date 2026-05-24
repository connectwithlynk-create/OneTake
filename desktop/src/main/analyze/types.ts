import type { SpeakerVerdict } from './speaker';

/** Editorial category of a shot's underlying video content. Text overlay
 *  is orthogonal (most UGC shots have one) — see `ocr_text` per-shot
 *  and `text_overlay_pct` on the result for that signal.
 *  - talking_head: creator on camera, lip-synced with audio (real speaker)
 *  - broll_talking_head: face on camera, NOT lip-synced (someone else's clip)
 *  - talking_head_unknown: face on camera, sync ambiguous (model unsure)
 *  - broll_visual: no face — product shot, scene, ambient cutaway, or
 *    text-on-color card (we can't distinguish without OCR-bbox + background
 *    analysis; left as a future split)
 */
export type ClipType =
  | 'talking_head'
  | 'broll_talking_head'
  | 'talking_head_unknown'
  | 'broll_visual';

export const CLIP_TYPES: ClipType[] = [
  'talking_head',
  'broll_talking_head',
  'talking_head_unknown',
  'broll_visual',
];

/** Normalized bounding box (0-1 in both axes), origin top-left. */
export interface NormBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One observed text-overlay moment within a shot. Text overlays often
 *  swap during a single underlying b-roll shot (top headline → bottom
 *  caption → off), so a shot can have multiple distinct moments. */
export interface TextMoment {
  /** Recognized text in this moment. */
  text: string;
  /** Normalized union bbox of the text. */
  bbox: NormBBox;
  /** 3x3 grid cell of the bbox centroid. */
  region: FrameRegion;
}

/** 3x3 grid cell a face/text centroid sits in. Naming is row_column with
 *  rows top/middle/bottom (y) and columns left/center/right (x). */
export type FrameRegion =
  | 'top_left'
  | 'top_center'
  | 'top_right'
  | 'middle_left'
  | 'middle_center'
  | 'middle_right'
  | 'bottom_left'
  | 'bottom_center'
  | 'bottom_right';

export const FRAME_REGIONS: FrameRegion[] = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'middle_center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
];

/** One detected shot with its annotation. Field names mirror the
 *  analysis result so persistence stays a 1:1 write. */
export interface ReelShot {
  start_ms: number;
  end_ms: number;
  has_face: boolean;
  ocr_text: string | null;
  /** Whether the shot's on-screen face is the reel's real speaker, a
   *  b-roll talking head, no face at all, or undetermined. See speaker.ts. */
  speaker_verdict: SpeakerVerdict;
  /** Confidence in speaker_verdict, [0,1]. */
  speaker_confidence: number;
  /** Raw SyncNet sync confidence for the shot (higher = lips track the
   *  audio more tightly). */
  sync_conf: number;
  /** Editorial clip type derived from has_face + ocr_text + speaker_verdict. */
  clip_type: ClipType;
  /** Largest face bbox on the rep frame, normalized 0-1, or null. */
  face_bbox: NormBBox | null;
  /** 3x3 grid cell the face centroid sits in. Null if no face. */
  face_region: FrameRegion | null;
  /** All distinct text-overlay moments observed across the shot's sample
   *  frames (in sample-timestamp order). Empty when no text was found. */
  text_moments: TextMoment[];
  /** Mean RMS amplitude in the shot, [0, 1]. */
  audio_rms_mean: number;
  /** Peak per-frame RMS amplitude in the shot, [0, 1]. */
  audio_peak_rms: number;
  /** Fraction of the shot's 32ms frames below silence threshold, [0, 1]. */
  audio_silence_pct: number;
  /** Fraction of the shot's 32ms frames flagged as speech by Silero
   *  VAD (post-hysteresis), [0, 1]. */
  audio_speech_pct: number;
  /** Fraction of the shot's 32ms frames that are audible non-speech
   *  (music, ambient, SFX), [0, 1]. */
  audio_music_pct: number;
  /** Number of SFX onsets (sharp non-speech energy spikes) inside the
   *  shot's time range. */
  sfx_count: number;
  /** True when an SFX onset is within ±200ms of the shot's start —
   *  the canonical "whoosh on the cut" pattern. */
  sfx_at_start: boolean;
  /** For each SFX onset in this shot (in onset-time order), the top-k
   *  best library matches sorted by similarity descending. Empty per
   *  onset when no library / no qualifying matches. */
  sfx_matches: SfxMatchPerEvent[];
}

export interface SfxMatchPerEvent {
  /** Onset time in ms from reel start. */
  ms: number;
  /** Top library matches for this onset. */
  matches: SfxMatchEntry[];
}

export interface SfxMatchEntry {
  slug: string;
  name: string;
  source_url: string;
  /** Cosine similarity in [-1, 1]. */
  similarity: number;
}
