// Speaker detection via SyncNet - a true audio-visual sync model. Per
// shot it runs SyncNet's lip encoder over 5-frame face-crop windows and
// its audio encoder over the matching MFCC windows, then measures how
// well the lip embeddings line up with the audio embeddings (the sync
// confidence). A real speaker's lips track the audio -> high confidence;
// a b-roll talking head's lips don't -> low. This is the distinction
// Light-ASD (active-speaker detection) could not make.
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
  /** Raw SyncNet sync confidence (median offset distance - best offset
   *  distance). Higher = lips track the audio more tightly. */
  sync_conf: number;
}

const MODEL_DIR =
  process.env.SYNCNET_MODEL_DIR ||
  join(__dirname, '../../resources/models');

const DIM = 224;
const PLANE = DIM * DIM;
const LIP_FRAMES = 5; // SyncNet lip window length
const AUD_W = 20; // MFCC frames per lip window (4 per video frame)
const EMBED = 1024;
const VSHIFT = 10; // ± offset search range, in frames
const BATCH = 8; // windows per ONNX run

const MAX_WINDOW_MS = 2500; // cap the per-shot analysis window
const MAX_WINDOWS = 48; // cap sync samples per shot
const MIN_WINDOWS = 8; // fewer than this -> can't judge
const MIN_FACE_RATIO = 0.5; // below this, no usable face track

// SyncNet sync-confidence thresholds (tunable - calibrate against reels).
const SPEAKER_CONF = 3.0;
const BROLL_CONF = 1.5;

interface Sessions {
  lip: ort.InferenceSession;
  aud: ort.InferenceSession;
}

let sessionsPromise: Promise<Sessions> | null = null;

function getSessions(): Promise<Sessions> {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      const lip = await ort.InferenceSession.create(
        join(MODEL_DIR, 'syncnet-lip.onnx'),
      );
      const aud = await ort.InferenceSession.create(
        join(MODEL_DIR, 'syncnet-aud.onnx'),
      );
      console.error('[speaker] SyncNet sessions ready');
      return { lip, aud };
    })();
  }
  return sessionsPromise;
}

// Run both encoders over all window positions; returns flat nWin x 1024
// lip and audio embedding arrays.
async function embedWindows(
  sessions: Sessions,
  crops: Float32Array,
  mfccData: Float32Array,
  nWin: number,
): Promise<{ lip: Float32Array; aud: Float32Array }> {
  const lip = new Float32Array(nWin * EMBED);
  const aud = new Float32Array(nWin * EMBED);

  for (let i0 = 0; i0 < nWin; i0 += BATCH) {
    const n = Math.min(BATCH, nWin - i0);

    const lipData = new Float32Array(n * 3 * LIP_FRAMES * PLANE);
    const audData = new Float32Array(n * 13 * AUD_W);
    for (let w = 0; w < n; w++) {
      const gi = i0 + w;
      for (let c = 0; c < 3; c++) {
        for (let f = 0; f < LIP_FRAMES; f++) {
          const src = (gi + f) * 3 * PLANE + c * PLANE;
          const dst =
            w * (3 * LIP_FRAMES * PLANE) + c * (LIP_FRAMES * PLANE) + f * PLANE;
          lipData.set(crops.subarray(src, src + PLANE), dst);
        }
      }
      for (let c = 0; c < 13; c++) {
        for (let t = 0; t < AUD_W; t++) {
          audData[w * 13 * AUD_W + c * AUD_W + t] =
            mfccData[(gi * 4 + t) * 13 + c];
        }
      }
    }

    const lipOut = await sessions.lip.run({
      lip: new ort.Tensor('float32', lipData, [n, 3, LIP_FRAMES, DIM, DIM]),
    });
    lip.set(
      lipOut[sessions.lip.outputNames[0]].data as Float32Array,
      i0 * EMBED,
    );

    const audOut = await sessions.aud.run({
      aud: new ort.Tensor('float32', audData, [n, 1, 13, AUD_W]),
    });
    aud.set(
      audOut[sessions.aud.outputNames[0]].data as Float32Array,
      i0 * EMBED,
    );
  }
  return { lip, aud };
}

// SyncNet confidence: mean lip-vs-audio L2 distance per ± offset; the
// confidence is median(distances) - min(distances). High = the lips line
// up with the audio at a clear offset.
function syncConfidence(
  lip: Float32Array,
  aud: Float32Array,
  nWin: number,
): number {
  const win = 2 * VSHIFT + 1;
  const mdist = new Float64Array(win);
  for (let i = 0; i < nWin; i++) {
    for (let k = 0; k < win; k++) {
      const j = i + k - VSHIFT; // audio index (zero-padded outside range)
      let d = 0;
      if (j >= 0 && j < nWin) {
        for (let e = 0; e < EMBED; e++) {
          const diff = lip[i * EMBED + e] - aud[j * EMBED + e];
          d += diff * diff;
        }
      } else {
        for (let e = 0; e < EMBED; e++) {
          const v = lip[i * EMBED + e];
          d += v * v;
        }
      }
      mdist[k] += Math.sqrt(d);
    }
  }
  let minval = Infinity;
  for (let k = 0; k < win; k++) {
    mdist[k] /= nWin;
    if (mdist[k] < minval) minval = mdist[k];
  }
  const sorted = Array.from(mdist).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  return med - minval;
}

/** Per-shot speaker verdict, aligned 1:1 with `shots`. Best-effort per
 *  shot - a failure yields an 'unknown' verdict, never an exception. */
export async function detectSpeaker(
  url: string,
  shots: Shot[],
  hasFaceHints?: boolean[],
): Promise<ShotSpeakerInfo[]> {
  const out: ShotSpeakerInfo[] = [];
  for (let s = 0; s < shots.length; s++) {
    const shot = shots[s];
    // Fast path: if the shot's rep frame already showed no face, skip the
    // expensive per-shot face-crop window extraction and BlazeFace pass.
    // The rep frame is the shot's midpoint, so this loses nothing for the
    // common case where a shot is consistently no-face.
    if (hasFaceHints && hasFaceHints[s] === false) {
      out.push({ verdict: 'no_face', confidence: 1, sync_conf: 0 });
      continue;
    }
    const durMs = Math.min(shot.end_ms - shot.start_ms, MAX_WINDOW_MS);
    try {
      const faces = await extractFaceCrops(url, shot.start_ms, durMs);
      if (faces.numFrames === 0 || faces.faceRatio < MIN_FACE_RATIO) {
        out.push({
          verdict: 'no_face',
          confidence: 1 - faces.faceRatio,
          sync_conf: 0,
        });
        continue;
      }

      const pcm = await extractAudioPCM(url, shot.start_ms, durMs);
      const { data: mfccData, frames: numAud } = mfcc(pcm);

      let nWin =
        Math.min(
          faces.numFrames - LIP_FRAMES,
          Math.floor((numAud - AUD_W) / 4),
        ) + 1;
      if (nWin < MIN_WINDOWS) {
        out.push({ verdict: 'unknown', confidence: 0, sync_conf: 0 });
        continue;
      }
      if (nWin > MAX_WINDOWS) nWin = MAX_WINDOWS;

      const sessions = await getSessions();
      const { lip, aud } = await embedWindows(
        sessions,
        faces.crops,
        mfccData,
        nWin,
      );
      const conf = syncConfidence(lip, aud, nWin);
      console.error(`[speaker] shot ${s}: sync_conf ${conf.toFixed(3)}`);

      let verdict: SpeakerVerdict;
      if (conf >= SPEAKER_CONF) verdict = 'speaker';
      else if (conf < BROLL_CONF) verdict = 'broll';
      else verdict = 'unknown';
      out.push({
        verdict,
        confidence: Math.min(1, conf / SPEAKER_CONF),
        sync_conf: conf,
      });
    } catch (err) {
      console.error(
        '[speaker] shot failed:',
        err instanceof Error ? err.message : String(err),
      );
      out.push({ verdict: 'unknown', confidence: 0, sync_conf: 0 });
    }
  }
  return out;
}
