import type { ExtractedFrame } from './frame-extractor';
import { recognizeText } from './ocr';
import type { Shot } from './scene-detect';
import type { ShotSpeakerInfo, SpeakerVerdict } from './speaker';
import type { ClipType, ReelShot } from './types';

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
    const hasFace = rep?.hasFace ?? false;
    const verdict = sp?.verdict ?? 'unknown';
    out.push({
      start_ms: shots[i].start_ms,
      end_ms: shots[i].end_ms,
      has_face: hasFace,
      ocr_text: ocrText,
      speaker_verdict: verdict,
      speaker_confidence: sp?.confidence ?? 0,
      sync_conf: sp?.sync_conf ?? 0,
      clip_type: classifyClipType(hasFace, verdict),
    });
  }
  return out;
}
