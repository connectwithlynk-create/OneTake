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
  /** For each SFX onset in this shot (in onset-time order), the
   *  acoustic-type classification. Identity matching (which exact
   *  library entry) is not attempted here — see sfx-classify.ts for the
   *  rationale (impulse SFX in heavy voiceover can't be identified
   *  reliably with pure-JS DSP). */
  sfx_classifications: SfxClassifiedEvent[];
  /** Media-object overlays (stickers/GIFs/PiP video/images/emoji
   *  graphics) detected within the shot, distinct from text captions.
   *  Empty when none detected. See overlays.ts. */
  overlays: MediaOverlay[];
  /** One-sentence visual caption of the shot's rep frame, produced by
   *  Claude vision. Covers subject + framing + iconography. Empty
   *  when no ANTHROPIC_API_KEY or the call failed. The content-
   *  vocabulary aggregator searches this field to recommend
   *  "use a shot like X" suggestions in the synthesis engine. */
  visual_caption: string | null;
  /** Transcript words spoken while this shot was on screen, joined.
   *  Empty when no transcript or no spoken audio overlapped. Lets
   *  the synthesis engine learn the mapping between what was said
   *  and what was shown across the collection. */
  spoken_window: string;
}

/** Heuristic media-overlay kind. The classifier looks at inner-bbox
 *  motion and color-palette complexity across the shot's sample frames;
 *  it can't perfectly disambiguate (e.g. a static photo vs a sticker)
 *  but the categories below are what downstream reasoning needs. */
export type OverlayKind =
  | 'image'
  | 'sticker'
  | 'gif'
  | 'pip_video'
  | 'emoji_graphic';

export const OVERLAY_KINDS: OverlayKind[] = [
  'image',
  'sticker',
  'gif',
  'pip_video',
  'emoji_graphic',
];

/** Whether the overlay's own pixels change inside its bbox across the
 *  shot. `static` covers still images/stickers; `animated` covers GIFs
 *  and PiP video. Enter/exit transitions are not classified in v1 —
 *  three sample frames per shot don't give enough temporal resolution. */
export type OverlayMotion = 'static' | 'animated';

export const OVERLAY_MOTIONS: OverlayMotion[] = ['static', 'animated'];

/** One detected media overlay (image/sticker/GIF/PiP/emoji graphic) in
 *  a shot. Text captions are tracked separately in `text_moments` —
 *  they aren't overlays in this sense. */
export interface MediaOverlay {
  /** When this overlay first appears in the reel, ms from reel start. */
  start_ms: number;
  /** When it last appears, ms from reel start. */
  end_ms: number;
  /** Normalized bbox of the overlay region (0-1, origin top-left). */
  bbox: NormBBox;
  /** 3x3 grid cell of the bbox centroid. */
  region: FrameRegion;
  /** Heuristic media kind — see OverlayKind. */
  kind: OverlayKind;
  /** Whether the overlay's pixels move inside its bbox across the shot. */
  motion: OverlayMotion;
  /** Transcript words spoken while this overlay was on screen, joined.
   *  Empty when no spoken audio overlaps the overlay's lifetime, when
   *  transcription was unavailable, or when full-reel transcription
   *  hadn't been wired in yet. The semantic relation (illustrate /
   *  reinforce / label / cta / unrelated) is left for a downstream
   *  reasoning layer to derive from this raw pairing. */
  spoken_window: string;
  /** Base64 JPEG crop of the overlay bbox from a shot sample frame.
   *  Null when no sample frame was available. Lets downstream reasoning
   *  see what the overlay depicts without re-decoding video. */
  thumb_b64: string | null;
}

import type { SfxType, SfxFeatures } from './sfx-classify';
export type { SfxType, SfxFeatures } from './sfx-classify';

export interface SfxClassifiedEvent {
  /** Onset time in ms from reel start. */
  ms: number;
  /** Coarse acoustic category. */
  type: SfxType;
  /** Heuristic confidence in [0, 1]. */
  confidence: number;
  /** Raw features that drove the classification — useful for debugging
   *  and future ML upgrades. */
  features: SfxFeatures;
}
