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

export interface OcrResult {
  /** Concatenated recognized text. Empty when nothing readable. */
  text: string;
  /** Tight union of high-confidence word bboxes in source-image pixel
   *  coords, or null when no qualifying words were found. */
  textBox: PixelBox | null;
}

/** Run OCR on a single base64 JPEG. Best-effort: returns empty result on
 *  any error so one bad frame never aborts the analysis. The text bbox
 *  is the union of all words with confidence >= WORD_CONFIDENCE_MIN. */
export async function recognizeText(jpegBase64: string): Promise<OcrResult> {
  if (!jpegBase64) return { text: '', textBox: null };
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(
      Buffer.from(jpegBase64, 'base64'),
      undefined,
      { blocks: true },
    );
    const text = (data.text ?? '').trim();

    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let any = false;
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          for (const word of line.words ?? []) {
            if (!word.bbox || word.confidence < WORD_CONFIDENCE_MIN) continue;
            x0 = Math.min(x0, word.bbox.x0);
            y0 = Math.min(y0, word.bbox.y0);
            x1 = Math.max(x1, word.bbox.x1);
            y1 = Math.max(y1, word.bbox.y1);
            any = true;
          }
        }
      }
    }
    const textBox: PixelBox | null = any
      ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      : null;
    return { text, textBox };
  } catch {
    return { text: '', textBox: null };
  }
}
