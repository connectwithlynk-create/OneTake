// OCR via tesseract.js (pure WASM, no native build). Replaces the native
// recognizeText. One worker is created lazily and reused across frames -
// worker startup loads the wasm core + language data and is expensive.
import { createWorker, PSM, type Worker } from 'tesseract.js';

let workerPromise: Promise<Worker> | null = null;

/** Minimum per-word tesseract confidence (0-100) to count toward the
 *  text bounding-box union. Filters out noise that looks like characters. */
const WORD_CONFIDENCE_MIN = 50;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    console.error('[ocr] creating tesseract worker...');
    workerPromise = createWorker('eng').then(async (w) => {
      // Reel frames are scattered scene-text, not document layout.
      // SPARSE_TEXT finds text anywhere without assuming a page.
      await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      console.error('[ocr] tesseract worker ready');
      return w;
    });
  }
  return workerPromise;
}

/** Pixel-space bounding box (origin top-left). */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One recognized text line with its tight bounding box. Per-line
 *  bboxes (instead of a single union envelope) matter for downstream
 *  consumers that need to know WHERE the text actually is on the
 *  frame — e.g. the overlay detector uses these as exclusion zones,
 *  and a union envelope spanning top caption to bottom caption would
 *  cover the whole frame and falsely exclude every sticker between
 *  them. */
export interface OcrLine {
  text: string;
  bbox: PixelBox;
}

export interface OcrResult {
  /** Concatenated recognized text across all lines (frame-level). */
  text: string;
  /** Per-line recognized text with its bbox. Empty when no qualifying
   *  text was found. Each line's bbox is the union of its
   *  high-confidence (>= WORD_CONFIDENCE_MIN) word bboxes. */
  lines: OcrLine[];
}

/** Run OCR on a single base64 JPEG. Best-effort: returns empty result on
 *  any error so one bad frame never aborts the analysis. */
export async function recognizeText(jpegBase64: string): Promise<OcrResult> {
  if (!jpegBase64) return { text: '', lines: [] };
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(
      Buffer.from(jpegBase64, 'base64'),
      undefined,
      { blocks: true },
    );
    const text = (data.text ?? '').trim();

    const lines: OcrLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          const words: string[] = [];
          for (const word of line.words ?? []) {
            if (!word.bbox || word.confidence < WORD_CONFIDENCE_MIN) continue;
            x0 = Math.min(x0, word.bbox.x0);
            y0 = Math.min(y0, word.bbox.y0);
            x1 = Math.max(x1, word.bbox.x1);
            y1 = Math.max(y1, word.bbox.y1);
            words.push(word.text ?? '');
          }
          if (words.length === 0) continue;
          lines.push({
            text: words.join(' ').trim(),
            bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
          });
        }
      }
    }
    return { text, lines };
  } catch {
    return { text: '', lines: [] };
  }
}
