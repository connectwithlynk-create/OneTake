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

/** Dominant in-shot CAMERA motion, measured by the optical-flow pass
 *  (motion.ts). Mirrors the editor's scene-animation presets minus
 *  'punch_in' (a stylistic fast-zoom variant flow can't distinguish from
 *  a plain zoom_in). 'none' = static hold. */
export type CameraMotionKind =
  | 'none'
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_left'
  | 'pan_right'
  | 'ken_burns';

export const CAMERA_MOTION_KINDS: CameraMotionKind[] = [
  'none',
  'zoom_in',
  'zoom_out',
  'pan_left',
  'pan_right',
  'ken_burns',
];

/** Measured camera motion for one shot. Magnitudes are fractions summed
 *  across the shot's sampled span (~the middle two-thirds of the shot),
 *  so they approximate the total move over the shot. */
export interface DetectedMotion {
  /** Classified dominant motion. */
  kind: CameraMotionKind;
  /** Confidence in the classification, [0,1] — from flow magnitude,
   *  block inlier ratio, and directional consistency across frame pairs. */
  confidence: number;
  /** Total fractional scale change across the shot. >0 zooms in, <0 out. */
  zoom_rate: number;
  /** Total horizontal drift as a fraction of frame width. >0 = content
   *  moved right (pan_right). */
  pan_x: number;
  /** Total vertical drift as a fraction of frame height. >0 = content
   *  moved down. */
  pan_y: number;
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
  /** Best-effort role classification. `subtitle` means spoken-word
   *  caption text that should inform caption style. `image_text` means
   *  words embedded inside a screenshot/card/poster/image layer. */
  role?: 'subtitle' | 'image_text' | 'title' | 'unknown';
  /** Confidence for `role`, 0-1. */
  role_confidence?: number;
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

/** Burned-in SPOKEN-WORD caption (subtitle) style — the auto-generated
 *  "transcribe my talking" captions creators add (CapCut / Hormozi
 *  style). These are orthogonal to titles, lower-third name tags, and
 *  sticker text, which live in `text_moments`. See caption-style.ts. */
export type CaptionPosition =
  | 'center'
  | 'lower_third'
  | 'bottom'
  | 'top'
  | 'varies';
export type CaptionChunking = 'word_by_word' | 'phrase' | 'sentence' | 'mixed';
export type CaptionEmphasis =
  | 'active_word_highlight'
  | 'keyword_highlight'
  | 'none';
export type CaptionCasing =
  | 'uppercase'
  | 'title_case'
  | 'sentence_case'
  | 'mixed';
export type CaptionAnimation =
  | 'pop'
  | 'karaoke_fill'
  | 'fade'
  | 'typewriter'
  | 'static'
  | 'none';
/** On-screen caption text size relative to frame height: small (<5%),
 *  medium (5-9%), large (>=9% — Hormozi-style big captions). */
export type CaptionFontSize = 'small' | 'medium' | 'large';
/** How the caption text is made legible against the video:
 *  - bordered:     glyphs have an outline/stroke (e.g. yellow text, black edge)
 *  - backgrounded: text sits on a solid color box/block behind it
 *  - clear:        plain text, no outline or box (maybe a soft drop shadow) */
export type CaptionTreatment = 'bordered' | 'backgrounded' | 'clear';

/** Detected spoken-word caption style for one reel. `present` is false
 *  when the reel burns in no spoken-word captions, in which case the
 *  remaining fields hold defaults and should be ignored. Produced by a
 *  vision pass over caption-bearing frames (caption-style.ts). */
export interface CaptionStyleProfile {
  present: boolean;
  position: CaptionPosition;
  chunking: CaptionChunking;
  /** Typical number of words shown on screen at once before the caption
   *  swaps to the next group. Concrete companion to `chunking`
   *  (word_by_word ≈ 1-2, phrase ≈ 3-5, sentence ≈ 6+). 0 when absent. */
  words_per_chunk: number;
  /** On-screen text size relative to frame height. */
  font_size: CaptionFontSize;
  emphasis: CaptionEmphasis;
  casing: CaptionCasing;
  animation: CaptionAnimation;
  /** Free-text font look, e.g. "bold rounded sans with black stroke". */
  font_descriptor: string;
  /** Closest real font matched against the downloaded font library — id
   *  from FONT_CATALOG (font-catalog.ts), '' when none matched. Picked by
   *  the vision model against a rendered reference sheet, so it names a
   *  real, reproducible font instead of guessing. */
  font_family: string;
  /** Display name of font_family, e.g. "Anton". '' when none. */
  font_family_name: string;
  /** Base text color, e.g. "white". */
  text_color: string;
  /** How the text is made legible: outline, solid box, or neither. */
  text_treatment: CaptionTreatment;
  /** The treatment's color — the outline color (bordered) or the box
   *  color (backgrounded). Null when treatment is clear. */
  treatment_color: string | null;
  /** Active/keyword highlight color; null when there is no emphasis color. */
  highlight_color: string | null;
  has_emoji: boolean;
  /** Concise human label, e.g. "word-by-word karaoke highlight". */
  style_label: string;
  /** Closest premade subtitle style (id from SUBTITLE_PRESETS), chosen
   *  by matching the detected attributes against the catalog. Empty when
   *  no captions. See subtitle-presets.ts. */
  matched_preset: string;
  /** Display label of the matched preset. */
  preset_label: string;
  /** How well the matched preset fit, 0-1 (weighted attribute overlap). */
  preset_confidence: number;
}

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
  /** Dominant camera motion measured by optical flow (motion.ts), or
   *  null when the pass was skipped or couldn't estimate (too few
   *  decodable frames / no reliable block fit). */
  detected_motion: DetectedMotion | null;
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
  /** Coarse acoustic category. When `source === 'model'` this is the
   *  AudioSet label mapped onto the bucket; otherwise it's the heuristic
   *  classifier's own bucket. */
  type: SfxType;
  /** Confidence in [0, 1]. For model events this is the top AudioSet
   *  delta score; for heuristic events it's the rule-fit confidence. */
  confidence: number;
  /** Raw features that drove the heuristic classification — useful for
   *  debugging and future ML upgrades. */
  features: SfxFeatures;
  /** Which classifier produced this event. 'model' = PANNs CNN14 AudioSet
   *  tagging (sfx-audioset.ts); 'heuristic' = delta-spectrum rules
   *  (sfx-classify.ts), used as fallback when the model is absent or had
   *  no confident non-speech label. */
  source: 'model' | 'heuristic';
  /** Human-readable AudioSet event name, e.g. "Whoosh, swoosh, swish".
   *  Present only for `source === 'model'` events. */
  label?: string;
  /** Top AudioSet labels (descending by delta score) for model events.
   *  Lets downstream reasoning see the runner-up types. Empty/omitted
   *  for heuristic events. */
  labels?: { label: string; score: number }[];
}
