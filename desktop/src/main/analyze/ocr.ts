// OCR via tesseract.js (pure WASM, no native build). Replaces the native
// recognizeText. One worker is created lazily and reused across frames -
// worker startup loads the wasm core + language data and is expensive.
import { createWorker, PSM, type Worker } from 'tesseract.js';

let workerPromise: Promise<Worker> | null = null;

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

/** Run OCR on a single base64 JPEG. Best-effort: returns '' on any error
 *  so one bad frame never aborts the analysis. */
export async function recognizeText(jpegBase64: string): Promise<string> {
  if (!jpegBase64) return '';
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(
      Buffer.from(jpegBase64, 'base64'),
    );
    return data.text ?? '';
  } catch {
    return '';
  }
}
