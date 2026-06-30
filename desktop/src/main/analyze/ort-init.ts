// Shared onnxruntime-web runtime config. Import and call initOrt() before
// the FIRST InferenceSession.create in any module (speaker, vad, yolo).
//
// Why this exists: onnxruntime-web leaves numThreads/simd undefined by
// default and resolves the thread count at session-create time from
// navigator.hardwareConcurrency. In a plain-Node process (tsx scripts)
// that yields a multi-threaded WASM session. In Electron's utilityProcess
// — where the built analyzer runs — navigator is unavailable, so it falls
// back to a SINGLE-threaded session and SyncNet/YOLO run several times
// slower, blowing past the analyzer timeout. Setting numThreads + simd
// explicitly makes the packaged app match script-speed.
import * as ort from 'onnxruntime-web';
import { cpus } from 'os';
import { dirname } from 'path';

let configured = false;

export function initOrt(): void {
  if (configured) return;
  configured = true;
  try {
    // The .wasm assets live next to the resolved node build in dist/.
    // Point ort at them explicitly so the externalized/packaged analyzer
    // never fails to locate the SIMD-threaded binary.
    ort.env.wasm.wasmPaths = dirname(require.resolve('onnxruntime-web')) + '/';
  } catch {
    // Fall back to ort's own resolution if require.resolve fails.
  }
  // Cap threads to leave headroom for ffmpeg + the rest of the pipeline.
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, cpus().length - 2));
  ort.env.wasm.simd = true;
}
