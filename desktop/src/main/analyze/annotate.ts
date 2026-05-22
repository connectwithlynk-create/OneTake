import type { ExtractedFrame } from './frame-extractor';
import { recognizeText } from './ocr';
import type { Shot } from './scene-detect';
import type { ReelShot } from './types';

/**
 * Annotate each shot with face presence and OCR text. `frames` is aligned
 * 1:1 with `shots` - frames[i] is shot i's representative frame (or null
 * if extraction failed). OCR runs once per shot, on that frame only.
 */
export async function annotateShots(
  frames: (ExtractedFrame | null)[],
  shots: Shot[],
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
    out.push({
      start_ms: shots[i].start_ms,
      end_ms: shots[i].end_ms,
      has_face: rep?.hasFace ?? false,
      ocr_text: ocrText,
    });
  }
  return out;
}
