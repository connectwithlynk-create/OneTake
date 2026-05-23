// Face detection via tfjs BlazeFace on the WASM backend (no native build).
// Runs in the analyzer utilityProcess. The detector is loaded once and
// reused; tfjs model data is fetched on first use and is small.
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import * as faceDetection from '@tensorflow-models/face-detection';

// The face-detection package fetches its tfjs model from tfhub on every
// detector load. That CDN call sometimes hangs cold-start - freezing the
// whole analyzer. Intercept the request and serve the cached files from
// desktop/resources/models/face-detector/ so it never touches the network
// in normal operation. Override the dir with FACE_DETECTOR_MODEL_DIR.
function installFaceModelCache(): void {
  const g = globalThis as unknown as { __faceModelCachePatched?: boolean };
  if (g.__faceModelCachePatched) return;
  g.__faceModelCachePatched = true;
  const cacheDir =
    process.env.FACE_DETECTOR_MODEL_DIR ||
    join(__dirname, '../../resources/models/face-detector');
  const PREFIX =
    'https://tfhub.dev/mediapipe/tfjs-model/face_detection/short/1/';
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : (input as { url?: string })?.url ?? '';
    if (typeof url === 'string' && url.startsWith(PREFIX)) {
      const fname = url.slice(PREFIX.length).split('?')[0];
      const filePath = join(cacheDir, fname);
      if (existsSync(filePath)) {
        const buf = readFileSync(filePath);
        const type = fname.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream';
        return new Response(buf, {
          status: 200,
          headers: { 'content-type': type },
        });
      }
    }
    return orig(input as RequestInfo, init as RequestInit | undefined);
  }) as typeof globalThis.fetch;
}

let detectorPromise: Promise<faceDetection.FaceDetector> | null = null;

function getDetector(): Promise<faceDetection.FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      installFaceModelCache();
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

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface FaceDetection {
  box: FaceBox;
  /** Midpoint of the two eye keypoints; null if keypoints unavailable. */
  eyeMid: Point | null;
  /** Mouth-centre keypoint; null if unavailable. */
  mouth: Point | null;
}

function rgbaToRgb(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

/** Largest detected face - box plus eye/mouth keypoints. Null on no face
 *  or error, so one bad frame never aborts analysis. */
export async function detectFaceData(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<FaceDetection | null> {
  try {
    const detector = await getDetector();
    const input = tf.tensor3d(
      rgbaToRgb(rgba, width, height),
      [height, width, 3],
      'int32',
    );
    const faces = await detector.estimateFaces(input);
    input.dispose();
    if (faces.length === 0) return null;
    let best = faces[0];
    for (const f of faces) {
      if (f.box.width * f.box.height > best.box.width * best.box.height) {
        best = f;
      }
    }
    const kp = (name: string): Point | undefined => {
      const k = best.keypoints?.find((p) => p.name === name);
      return k ? { x: k.x, y: k.y } : undefined;
    };
    const le = kp('leftEye');
    const re = kp('rightEye');
    const mc = kp('mouthCenter');
    return {
      box: {
        x: best.box.xMin,
        y: best.box.yMin,
        w: best.box.width,
        h: best.box.height,
      },
      eyeMid:
        le && re ? { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 } : null,
      mouth: mc ?? null,
    };
  } catch {
    return null;
  }
}

/** True if any face is present in the frame. */
export async function detectFace(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<boolean> {
  return (await detectFaceData(rgba, width, height)) !== null;
}
