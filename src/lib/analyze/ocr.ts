import { recognizeText } from 'expo-frame-extractor';
import type { ExtractedFrame } from 'expo-frame-extractor';

import type { ReelShot } from '../types';
import type { ShotBoundary } from './shots';

/**
 * Fill in OCR text and face presence per shot.
 *
 * `has_face` comes from the per-frame face detector that ran inside
 * extractFrames (cheap, ~10-30ms per frame). `ocr_text` is computed
 * here, lazily, ONLY for each shot's representative frame - text
 * recognition is the expensive step (~50-200ms per frame), so we
 * deliberately skip the non-representative frames.
 *
 * If OCR returns the empty string for a shot we store null, so callers
 * can do `shot.ocr_text != null` to mean "this shot carries on-screen
 * text" without confusing whitespace-only matches.
 */
export async function annotateShots(
  frames: ExtractedFrame[],
  shotBounds: ShotBoundary[]
): Promise<ReelShot[]> {
  const out: ReelShot[] = [];
  for (const sb of shotBounds) {
    const rep = frames[sb.representativeFrameIndex];
    let ocrText: string | null = null;
    if (rep?.jpegBase64) {
      try {
        const raw = await recognizeText(rep.jpegBase64);
        const trimmed = raw.trim();
        ocrText = trimmed.length > 0 ? trimmed : null;
      } catch {
        // OCR is best-effort; one frame failing must not kill the
        // whole analysis. The shot still gets recorded without text.
        ocrText = null;
      }
    }
    out.push({
      start_ms: sb.start_ms,
      end_ms: sb.end_ms,
      has_face: rep?.hasFace ?? false,
      ocr_text: ocrText,
    });
  }
  return out;
}
