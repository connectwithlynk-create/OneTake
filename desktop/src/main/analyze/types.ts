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
}
