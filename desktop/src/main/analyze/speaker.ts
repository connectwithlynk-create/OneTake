// Path A speaker detection: tells the reel's real speaker from a b-roll
// talking head by running the Light-ASD active-speaker model. Per shot it
// extracts the 25fps face crops + the aligned MFCC audio, runs the ONNX
// model, and averages the per-frame speaking probability. A b-roll talking
// head's lips don't track the reel's audio, so it scores low.
import { join } from 'path';
import * as ort from 'onnxruntime-web';
import { extractAudioPCM } from './audio';
import { extractFaceCrops } from './face-crops';
import { mfcc } from './mfcc';
import type { Shot } from './scene-detect';

export type SpeakerVerdict = 'speaker' | 'broll' | 'no_face' | 'unknown';

export interface ShotSpeakerInfo {
  verdict: SpeakerVerdict;
  /** Confidence in the verdict, [0,1]. */
  confidence: number;
  /** Mean Light-ASD speaking probability for the shot, [0,1]. */
  asd_score: number;
}

const MODEL_PATH =
  process.env.LIGHT_ASD_MODEL_PATH ||
  join(__dirname, '../../resources/models/light-asd.onnx');
const MAX_WINDOW_MS = 2500; // cap the per-shot analysis window
const MIN_FACE_RATIO = 0.5; // below this, no usable face track
const MIN_VID_FRAMES = 8; // shorter than this, the model can't judge
const SPEAKER_THRESHOLD = 0.5; // mean ASD score at/above -> speaker
const BROLL_THRESHOLD = 0.35; // below -> b-roll talking head; between -> unknown

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_PATH).then((s) => {
      console.error('[speaker] Light-ASD ONNX session ready');
      return s;
    });
  }
  return sessionPromise;
}

// Run Light-ASD on one shot's crops + MFCC. Audio is 100 fps, video 25 fps,
// so they're truncated to a common length at a 4:1 ratio. Returns the mean
// per-frame speaking probability, or null if the shot is too short.
async function runModel(
  crops: Float32Array,
  numVid: number,
  mfccData: Float32Array,
  numAud: number,
): Promise<number | null> {
  const lenSec = Math.min(numAud / 100, numVid / 25);
  const tv = Math.floor(lenSec * 25);
  if (tv < MIN_VID_FRAMES) return null;
  const ta = tv * 4;

  const session = await getSession();
  const visual = new ort.Tensor(
    'float32',
    crops.slice(0, tv * 112 * 112),
    [1, tv, 112, 112],
  );
  const audio = new ort.Tensor(
    'float32',
    mfccData.slice(0, ta * 13),
    [1, ta, 13],
  );
  const out = await session.run({ audio, visual });
  const scores = out[session.outputNames[0]].data as Float32Array;
  if (scores.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < scores.length; i++) sum += scores[i];
  return sum / scores.length;
}

/** Per-shot speaker verdict, aligned 1:1 with `shots`. Best-effort per
 *  shot - a failure yields an 'unknown' verdict, never an exception. */
export async function detectSpeaker(
  url: string,
  shots: Shot[],
): Promise<ShotSpeakerInfo[]> {
  const out: ShotSpeakerInfo[] = [];
  for (const shot of shots) {
    const durMs = Math.min(shot.end_ms - shot.start_ms, MAX_WINDOW_MS);
    try {
      const faces = await extractFaceCrops(url, shot.start_ms, durMs);
      if (faces.numFrames === 0 || faces.faceRatio < MIN_FACE_RATIO) {
        out.push({
          verdict: 'no_face',
          confidence: 1 - faces.faceRatio,
          asd_score: 0,
        });
        continue;
      }
      const pcm = await extractAudioPCM(url, shot.start_ms, durMs);
      const { data: mfccData, frames: numAud } = mfcc(pcm);
      const score = await runModel(
        faces.crops,
        faces.numFrames,
        mfccData,
        numAud,
      );
      if (score === null) {
        out.push({ verdict: 'unknown', confidence: 0, asd_score: 0 });
        continue;
      }
      let verdict: SpeakerVerdict;
      if (score >= SPEAKER_THRESHOLD) verdict = 'speaker';
      else if (score < BROLL_THRESHOLD) verdict = 'broll';
      else verdict = 'unknown';
      out.push({
        verdict,
        confidence: Math.min(1, Math.abs(score - 0.5) * 2),
        asd_score: score,
      });
    } catch (err) {
      console.error(
        '[speaker] shot failed:',
        err instanceof Error ? err.message : String(err),
      );
      out.push({ verdict: 'unknown', confidence: 0, asd_score: 0 });
    }
  }
  return out;
}
