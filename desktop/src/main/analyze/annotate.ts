import type { ExtractedFrame } from './frame-extractor';
import { recognizeText } from './ocr';
import type { Shot } from './scene-detect';
import type { ShotSpeakerInfo, SpeakerVerdict } from './speaker';
import type {
  ClipType,
  FrameRegion,
  NormBBox,
  ReelShot,
} from './types';

/** Map a normalized centroid (x,y in [0,1]) to one of 9 grid cells. */
export function regionForXY(x: number, y: number): FrameRegion {
  const row: 'top' | 'middle' | 'bottom' =
    y < 1 / 3 ? 'top' : y < 2 / 3 ? 'middle' : 'bottom';
  const col: 'left' | 'center' | 'right' =
    x < 1 / 3 ? 'left' : x < 2 / 3 ? 'center' : 'right';
  return `${row}_${col}` as FrameRegion;
}

/** Normalize a face bbox by frame dimensions and clamp to [0,1]. */
function normalizeBBox(
  box: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): NormBBox {
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  return {
    x: clamp(box.x / width),
    y: clamp(box.y / height),
    w: clamp(box.w / width),
    h: clamp(box.h / height),
  };
}

/** Pure derivation: underlying-video category from face presence + speaker
 *  verdict. Text overlay is orthogonal (carried in ocr_text), not part of
 *  the clip type. When the speaker pipeline returns 'no_face' that's
 *  authoritative — its 2.5s windowed face detection beats a single rep
 *  frame, which can fire on a one-frame partial or BlazeFace false-positive. */
export function classifyClipType(
  hasFace: boolean,
  speakerVerdict: SpeakerVerdict,
): ClipType {
  if (!hasFace || speakerVerdict === 'no_face') {
    return 'broll_visual';
  }
  switch (speakerVerdict) {
    case 'speaker':
      return 'talking_head';
    case 'broll':
      return 'broll_talking_head';
    default:
      return 'talking_head_unknown';
  }
}

/**
 * Annotate each shot with face presence, OCR text, and speaker verdict.
 * `frames` and `speaker` are both aligned 1:1 with `shots`: frames[i] is
 * shot i's representative frame (or null), speaker[i] is its speaker-vs-
 * b-roll verdict. OCR runs once per shot, on the representative frame.
 */
export async function annotateShots(
  frames: (ExtractedFrame | null)[],
  shots: Shot[],
  speaker: ShotSpeakerInfo[],
): Promise<ReelShot[]> {
  const out: ReelShot[] = [];
  for (let i = 0; i < shots.length; i++) {
    const rep = frames[i];
    let ocrText: string | null = null;
    if (rep?.jpegBase64) {
      try {
        const raw = await recognizeText(rep.jpegBase64);
        const trimmed = raw.trim();
        ocrText = trimmed.length > 0 ? trimmed : null;
      } catch {
        ocrText = null;
      }
    }
    const sp = speaker[i];
    const hasFace = rep?.face != null;
    const verdict = sp?.verdict ?? 'unknown';
    let face_bbox: NormBBox | null = null;
    let face_region: FrameRegion | null = null;
    if (rep?.face && rep.width > 0 && rep.height > 0) {
      face_bbox = normalizeBBox(rep.face.box, rep.width, rep.height);
      face_region = regionForXY(
        face_bbox.x + face_bbox.w / 2,
        face_bbox.y + face_bbox.h / 2,
      );
    }
    out.push({
      start_ms: shots[i].start_ms,
      end_ms: shots[i].end_ms,
      has_face: hasFace,
      ocr_text: ocrText,
      speaker_verdict: verdict,
      speaker_confidence: sp?.confidence ?? 0,
      sync_conf: sp?.sync_conf ?? 0,
      clip_type: classifyClipType(hasFace, verdict),
      face_bbox,
      face_region,
    });
  }
  return out;
}
