import type { ExtractedFrame } from './frame-extractor';
import { recognizeText } from './ocr';
import type { Shot } from './scene-detect';
import type { ShotSpeakerInfo } from './speaker';
import type { ReelShot } from './types';

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
    out.push({
      start_ms: shots[i].start_ms,
      end_ms: shots[i].end_ms,
      has_face: rep?.hasFace ?? false,
      ocr_text: ocrText,
      speaker_verdict: sp?.verdict ?? 'unknown',
      speaker_confidence: sp?.confidence ?? 0,
      asd_score: sp?.asd_score ?? 0,
    });
  }
  return out;
}
