import type { ExtractedFrame } from './frame-extractor';
import { recognizeText } from './ocr';
import type { Shot } from './scene-detect';
import type { ShotSpeakerInfo, SpeakerVerdict } from './speaker';
import type { ClipType, ReelShot } from './types';

/** Pure derivation: shot category from face presence, OCR text, and
 *  speaker verdict. See ClipType doc for category meanings. */
export function classifyClipType(
  hasFace: boolean,
  ocrText: string | null,
  speakerVerdict: SpeakerVerdict,
): ClipType {
  if (!hasFace) {
    return ocrText && ocrText.length > 0 ? 'text_card' : 'broll_visual';
  }
  switch (speakerVerdict) {
    case 'speaker':
      return 'talking_head';
    case 'broll':
      return 'broll_talking_head';
    default:
      // 'unknown', or 'no_face' (defensive — shouldn't fire when hasFace)
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
      clip_type: classifyClipType(hasFace, ocrText, verdict),
    });
  }
  return out;
}
