// Face detection via tfjs BlazeFace on the WASM backend (no native build).
// Runs in the analyzer utilityProcess. The detector is loaded once and
// reused; tfjs model data is fetched on first use and is small.
import { dirname, join } from 'path';
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import * as faceDetection from '@tensorflow-models/face-detection';

let detectorPromise: Promise<faceDetection.FaceDetector> | null = null;

function getDetector(): Promise<faceDetection.FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const wasmDir =
        join(
          dirname(
            require.resolve('@tensorflow/tfjs-backend-wasm/package.json'),
          ),
          'dist',
        ) + '/';
      setWasmPaths(wasmDir);
      await tf.setBackend('wasm');
      await tf.ready();
      console.error('[face] tfjs wasm backend ready');
      const detector = await faceDetection.createDetector(
        faceDetection.SupportedModels.MediaPipeFaceDetector,
        { runtime: 'tfjs' },
      );
      console.error('[face] detector ready');
      return detector;
    })();
  }
  return detectorPromise;
}

/** True if any face is present in the frame. Best-effort: false on error
 *  so one bad frame never aborts analysis. */
export async function detectFace(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<boolean> {
  try {
    const detector = await getDetector();
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    const input = tf.tensor3d(rgb, [height, width, 3], 'int32');
    const faces = await detector.estimateFaces(input);
    input.dispose();
    return faces.length > 0;
  } catch {
    return false;
  }
}
