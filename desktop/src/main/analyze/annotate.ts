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

/** Normalize a face bbox by frame dimensions. Coords may be slightly
 *  negative or exceed 1 when an edge-framed face extends past the visible
 *  frame — that's accurate, not a bug, and consumers should handle it. */
function normalizeBBox(
  box: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): NormBBox {
  return {
    x: box.x / width,
    y: box.y / height,
    w: box.w / width,
    h: box.h / height,
  };
}

/** Pure derivation: underlying-video category from face presence + speaker
 *  verdict. Text overlay is orthogonal (carried in ocr_text), not part of
 *  the clip type.
 *
 *  The rep frame is the BEST face detection from multi-frame sampling
 *  (see extractShotFrames), so hasFace=true is a strong signal. We trust
 *  it over speaker_verdict='no_face' — the latter only means face-crops
 *  bailed in its 2.5s window (motion blur, brief occlusion), not that
 *  there's no face. A bailed-face-crops shot is still a face shot;
 *  we just couldn't compute sync, so the verdict is 'unknown'-shaped. */
export function classifyClipType(
  hasFace: boolean,
  speakerVerdict: SpeakerVerdict,
): ClipType {
  if (!hasFace) {
    return 'broll_visual';
  }
  switch (speakerVerdict) {
    case 'speaker':
      return 'talking_head';
    case 'broll':
      return 'broll_talking_head';
    case 'no_face':
      // Multi-frame rep saw a face; SyncNet face-crops bailed. Face shot
      // of unknown speaker status.
      return 'talking_head_unknown';
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
    let text_bbox: NormBBox | null = null;
    let text_region: FrameRegion | null = null;
    if (rep?.jpegBase64) {
      try {
        const ocr = await recognizeText(rep.jpegBase64);
        ocrText = ocr.text.length > 0 ? ocr.text : null;
        if (ocr.textBox && rep.width > 0 && rep.height > 0) {
          text_bbox = normalizeBBox(ocr.textBox, rep.width, rep.height);
          text_region = regionForXY(
            text_bbox.x + text_bbox.w / 2,
            text_bbox.y + text_bbox.h / 2,
          );
        }
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
      text_bbox,
      text_region,
    });
  }
  return out;
}
