// Silero VAD (Voice Activity Detection) via onnxruntime-web — pure WASM,
// same pattern as SyncNet. Per 32ms / 512-sample frame at 16 kHz, the
// model emits a speech probability; we feed back the LSTM state for the
// next frame and apply hysteresis to mark contiguous speech segments.
//
// Model source: github.com/snakers4/silero-vad (MIT). Path defaults to
// the same SYNCNET_MODEL_DIR as the other ONNX models.
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import * as ort from 'onnxruntime-web';
import { initOrt } from './ort-init';
import { FRAME_SAMPLES, SAMPLE_RATE_VAD } from './audio';

/** Same dev/prod model-dir resolution as speaker.ts — tries env var,
 *  cwd, then __dirname at two depths. */
function resolveModelDir(): string {
  const candidates = [
    process.env.SYNCNET_MODEL_DIR,
    resolve(process.cwd(), 'resources/models'),
    join(__dirname, '../../resources/models'),
    join(__dirname, '../../../resources/models'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(join(c, 'silero_vad.onnx'))) return c;
  }
  return candidates[candidates.length - 1];
}

const MODEL_DIR = resolveModelDir();

/** Silero VAD LSTM state size: [2, 1, 128] = 256 floats. */
const STATE_SIZE = 2 * 1 * 128;

/** Silero VAD v5 requires a prepended context buffer of the previous
 *  64 samples (for 16 kHz). The ONNX expects 576-sample input
 *  (64 context + 512 current). This is handled outside the model by
 *  the Python wrapper; we replicate that here. */
const CONTEXT_SIZE = 64;

/** Speech enters at `>= ENTER` probability and stays until `< LEAVE`.
 *  Hysteresis prevents flapping between speech/non-speech at the boundary. */
const ENTER_THRESHOLD = 0.5;
const LEAVE_THRESHOLD = 0.35;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      initOrt();
      const session = await ort.InferenceSession.create(
        join(MODEL_DIR, 'silero_vad.onnx'),
      );
      console.error('[vad] Silero VAD session ready');
      return session;
    })();
  }
  return sessionPromise;
}

/** Run Silero VAD over the entire reel buffer, frame-by-frame.
 *  Returns one speech probability per FRAME_SAMPLES chunk, or null if
 *  the model couldn't be loaded. Stateful — feeds LSTM state forward. */
export async function runVAD(
  samples: Float32Array,
): Promise<Float32Array | null> {
  let session: ort.InferenceSession;
  try {
    session = await getSession();
  } catch (err) {
    console.error(
      '[vad] failed to load model:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  const numFrames = Math.floor(samples.length / FRAME_SAMPLES);
  if (numFrames === 0) return new Float32Array(0);

  const probs = new Float32Array(numFrames);
  let state = new Float32Array(STATE_SIZE);
  let context = new Float32Array(CONTEXT_SIZE);
  const srTensor = new ort.Tensor(
    'int64',
    new BigInt64Array([BigInt(SAMPLE_RATE_VAD)]),
    [],
  );
  const inputLen = CONTEXT_SIZE + FRAME_SAMPLES;
  const [outName, stateOutName] = session.outputNames;

  for (let i = 0; i < numFrames; i++) {
    const start = i * FRAME_SAMPLES;
    // Build [context_64 | chunk_512] = 576 samples, as v5 expects.
    const fullInput = new Float32Array(inputLen);
    fullInput.set(context, 0);
    for (let j = 0; j < FRAME_SAMPLES; j++) {
      fullInput[CONTEXT_SIZE + j] = samples[start + j];
    }
    const inputTensor = new ort.Tensor('float32', fullInput, [1, inputLen]);
    const stateTensor = new ort.Tensor('float32', state, [2, 1, 128]);

    const result = await session.run({
      input: inputTensor,
      state: stateTensor,
      sr: srTensor,
    });

    probs[i] = (result[outName].data as Float32Array)[0];
    state = new Float32Array(result[stateOutName].data as Float32Array);
    // Context for next frame = last CONTEXT_SIZE samples of THIS chunk.
    context = new Float32Array(CONTEXT_SIZE);
    for (let j = 0; j < CONTEXT_SIZE; j++) {
      context[j] = samples[start + FRAME_SAMPLES - CONTEXT_SIZE + j];
    }
  }

  return probs;
}

/** Apply hysteresis to per-frame VAD probabilities to mark contiguous
 *  speech regions. Returns a boolean per frame, aligned 1:1 with `probs`. */
export function speechMaskFromProbs(probs: Float32Array): boolean[] {
  const out = new Array<boolean>(probs.length).fill(false);
  let inSpeech = false;
  for (let i = 0; i < probs.length; i++) {
    if (inSpeech) {
      if (probs[i] < LEAVE_THRESHOLD) inSpeech = false;
    } else {
      if (probs[i] >= ENTER_THRESHOLD) inSpeech = true;
    }
    out[i] = inSpeech;
  }
  return out;
}
