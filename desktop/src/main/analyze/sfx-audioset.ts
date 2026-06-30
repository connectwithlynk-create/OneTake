// AudioSet event tagging for detected SFX onsets, via PANNs CNN14 (ONNX).
//
// The heuristic classifier (sfx-classify.ts) only produces 6 coarse
// buckets. To name the actual sound ("Whoosh", "Ding", "Chime", "Whip",
// "Clapping"...) we run PANNs CNN14 — a CNN tagger pretrained on AudioSet
// (527 classes) — over the audio around each onset.
//
// CNN14 was chosen over YAMNet on purpose: its STFT front-end is Conv-
// based, so the torch->ONNX export uses ops onnxruntime-web (WASM) fully
// supports. YAMNet's tf.signal STFT via tf2onnx risks unsupported ops in
// the WASM runtime the rest of the analyzer uses (vad.ts, speaker.ts).
//
// The hard part is that OneTake's SFX are quiet impulses buried under
// continuous voiceover, and AudioSet taggers are trained on dominant/
// isolated sounds — left alone, CNN14 just reports "Speech". Two
// mitigations, matching the delta-spectrum trick the heuristic already
// uses:
//   1. Baseline subtraction: tag BOTH the onset window and a pre-onset
//      (voice-only) window, then subtract. What survives is what the
//      onset ADDED — i.e. the SFX.
//   2. Speech/music suppression: zero the continuous-voiceover and
//      background-music classes before ranking, so a residual "Speech"
//      score can't win.
// When nothing survives confidently (truly buried impulse), the caller
// falls back to the heuristic bucket — see analyze.ts.
import * as ort from 'onnxruntime-web';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { initOrt } from './ort-init';
import { SAMPLE_RATE_VAD, FRAME_SAMPLES } from './audio';
import type { SfxType } from './sfx-classify';

/** PANNs CNN14 sample rate. The analyzer's audio buffer is 16 kHz
 *  (SAMPLE_RATE_VAD); we upsample 2x before inference. */
const MODEL_RATE = 32000;
/** Onset analysis window length (ms). CNN14 global-pools, so any length
 *  works; ~500 ms captures attack + decay of typical impulse SFX. */
const WINDOW_MS = 500;
/** Lead-in before the onset included in the onset window, so the attack
 *  transient isn't clipped. */
const WINDOW_PRE_MS = 100;
/** Pre-onset (voice-only) baseline window length, ms. */
const BASELINE_MS = 500;
/** Gap between the baseline window's end and the onset, to keep the
 *  attack ramp out of the baseline. */
const BASELINE_GAP_MS = 80;
/** How many top labels to surface per onset. */
const TOP_K = 4;
/** Minimum delta score (onset minus baseline, [0,1]) for the top label
 *  to count as a confident model result. Below this the caller falls
 *  back to the heuristic. */
const MIN_CONFIDENCE = 0.06;

const WINDOW_SAMPLES_16 = Math.round((WINDOW_MS / 1000) * SAMPLE_RATE_VAD);
const WINDOW_SAMPLES_32 = WINDOW_SAMPLES_16 * 2;

/** Mirror of the resolveModelDir pattern in vad.ts / speaker.ts. The key
 *  file is panns-cnn14.onnx; produce it with scripts/export-panns.py. */
function resolveModelDir(): string {
  const candidates = [
    process.env.SYNCNET_MODEL_DIR,
    resolve(process.cwd(), 'resources/models'),
    join(__dirname, '../../resources/models'),
    join(__dirname, '../../../resources/models'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(join(c, 'panns-cnn14.onnx'))) return c;
  }
  return candidates[candidates.length - 1];
}

const MODEL_DIR = resolveModelDir();
const MODEL_PATH = join(MODEL_DIR, 'panns-cnn14.onnx');
const CLASSMAP_PATH = join(MODEL_DIR, 'panns-classmap.json');

/** True when the model + classmap are both present on disk. The caller
 *  uses this to skip cleanly (heuristic-only) when the model wasn't
 *  exported, rather than throwing per reel. */
export function audioSetModelAvailable(): boolean {
  return existsSync(MODEL_PATH) && existsSync(CLASSMAP_PATH);
}

/** AudioSet display names, indexed by class id (0..526). Loaded once. */
let labels: string[] | null = null;
/** Class ids to suppress before ranking: continuous voiceover + generic
 *  background music + non-event filler. Built once from `labels`. */
let suppressed: Set<number> | null = null;

/** Substrings (lowercased) of AudioSet labels to zero out before
 *  ranking. Kept narrow: we suppress the voiceover/music bed and pure
 *  filler, NOT legitimate vocal SFX (shout, cheer, laugh, gasp). */
const SUPPRESS_SUBSTRINGS = [
  'speech',
  'narration',
  'monologue',
  'conversation',
  'babbling',
  'whispering',
  'male speech',
  'female speech',
  'child speech',
  'music',
  'musical instrument',
  'silence',
  'inside, small room',
  'inside, large room',
  'inside, public space',
  'outside, urban',
  'outside, rural',
];

function loadLabels(): string[] {
  if (labels) return labels;
  const raw = JSON.parse(readFileSync(CLASSMAP_PATH, 'utf8')) as
    | { labels: string[] }
    | string[];
  labels = Array.isArray(raw) ? raw : raw.labels;
  suppressed = new Set();
  labels.forEach((name, i) => {
    const lower = name.toLowerCase();
    if (SUPPRESS_SUBSTRINGS.some((s) => lower.includes(s))) {
      suppressed!.add(i);
    }
  });
  return labels;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      initOrt();
      const session = await ort.InferenceSession.create(MODEL_PATH);
      console.error('[sfx-audioset] PANNs CNN14 session ready');
      return session;
    })();
  }
  return sessionPromise;
}

/** Linear 2x upsample (16 kHz -> 32 kHz). CNN14 can't recover content
 *  above the 8 kHz Nyquist of the source, but category-level SFX tagging
 *  is robust to that — the discriminative energy lives below 8 kHz. */
function upsample2x(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length * 2);
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    const b = i + 1 < src.length ? src[i + 1] : a;
    out[2 * i] = a;
    out[2 * i + 1] = 0.5 * (a + b);
  }
  return out;
}

/** Copy a WINDOW_SAMPLES_16-long slice of `samples` starting at `start16`
 *  (16 kHz index, may be negative / past the end -> zero-padded), then
 *  upsample to 32 kHz. Always returns WINDOW_SAMPLES_32 samples. */
function extractWindow32(samples: Float32Array, start16: number): Float32Array {
  const win = new Float32Array(WINDOW_SAMPLES_16);
  for (let i = 0; i < WINDOW_SAMPLES_16; i++) {
    const idx = start16 + i;
    win[i] = idx >= 0 && idx < samples.length ? samples[idx] : 0;
  }
  return upsample2x(win);
}

export interface AudioSetLabel {
  /** AudioSet display name, e.g. "Whoosh, swoosh, swish". */
  label: string;
  /** Delta score (onset minus baseline), clamped to [0,1]. */
  score: number;
}

export interface AudioSetResult {
  /** Top non-suppressed labels by delta score, descending. */
  labels: AudioSetLabel[];
  /** Highest-scoring label name. */
  top: string;
  /** Top delta score, [0,1]. */
  confidence: number;
  /** Top label mapped onto the coarse SfxType bucket, for the existing
   *  fingerprint distribution + heuristic-compatible callers. */
  bucket: SfxType;
}

/** Map an AudioSet display name onto one of the 6 coarse SfxType buckets,
 *  so model-labeled events still slot into sfx_type_distribution. */
export function audioSetLabelToBucket(label: string): SfxType {
  const l = label.toLowerCase();
  // Vocal stingers / human non-speech vocalizations.
  if (
    /\b(shout|yell|whoop|cheer|laugh|giggle|chuckle|gasp|scream|screech|groan|sigh|burp|booing|crying|chatter|sing)\b/.test(
      l,
    )
  ) {
    return 'vocal';
  }
  // Sweeps / whooshes / risers / wind-like.
  if (/(whoosh|swoosh|swish|wind|whistle|sweep|riser)/.test(l)) {
    return 'sweep';
  }
  // Tonal impulses: bells, chimes, dings, beeps, plucked/struck tones.
  if (
    /(bell|chime|ding|gong|glockenspiel|vibraphone|singing bowl|tuning fork|beep|bleep|ping|sine wave|musical note|harp|pluck|mallet|triangle)/.test(
      l,
    )
  ) {
    return 'impulse_tonal';
  }
  // Noisy impulses: claps, snaps, clicks, taps, knocks, whips, glitches.
  if (
    /(clap|snap|click|tick|tap|knock|whip|crack|slap|thump|bang|smack|pop|burst|crackle|static|noise|explos|boom|firework|gunshot|cannon|detonat|slam)/.test(
      l,
    )
  ) {
    return 'impulse_noisy';
  }
  // Sustained beds / drones / hums.
  if (/(drone|hum|buzz|engine|rumble|ambient|background)/.test(l)) {
    return 'sustained';
  }
  return 'other';
}

/** Run CNN14 over a batch of windows. Returns one [527] score row per
 *  window, in input order. Scores are CNN14's sigmoid clipwise outputs. */
async function tagBatch(windows: Float32Array[]): Promise<Float32Array[]> {
  const session = await getSession();
  const n = windows.length;
  const L = WINDOW_SAMPLES_32;
  const flat = new Float32Array(n * L);
  for (let i = 0; i < n; i++) flat.set(windows[i], i * L);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tensor = new ort.Tensor('float32', flat, [n, L]);
  const out = await session.run({ [inputName]: tensor });
  const scores = out[outputName];
  const data = scores.data as Float32Array;
  const numClasses = data.length / n;
  const rows: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(data.subarray(i * numClasses, (i + 1) * numClasses));
  }
  return rows;
}

/** Tag a list of onset times (ms from reel start) in one batched
 *  inference. Returns one result (or null) per onset, in input order.
 *  Null means no confident non-suppressed label survived baseline
 *  subtraction — the caller should fall back to the heuristic. Returns
 *  all-null (without loading the model) when the model file is absent. */
export async function classifyOnsetsAudioSet(
  samples: Float32Array,
  onsetMsList: number[],
  speechMask?: boolean[],
): Promise<(AudioSetResult | null)[]> {
  if (onsetMsList.length === 0) return [];
  if (!audioSetModelAvailable()) return onsetMsList.map(() => null);

  const names = loadLabels();
  const suppress = suppressed!;

  // Two windows per onset: [onset window, baseline window], interleaved.
  const windows: Float32Array[] = [];
  for (const ms of onsetMsList) {
    const onsetIdx = Math.round((ms / 1000) * SAMPLE_RATE_VAD);
    const onsetStart =
      onsetIdx - Math.round((WINDOW_PRE_MS / 1000) * SAMPLE_RATE_VAD);
    const baselineStart =
      onsetIdx -
      Math.round(((BASELINE_GAP_MS + BASELINE_MS) / 1000) * SAMPLE_RATE_VAD);
    windows.push(extractWindow32(samples, onsetStart));
    windows.push(extractWindow32(samples, baselineStart));
  }

  const rows = await tagBatch(windows);

  return onsetMsList.map((ms, k) => {
    const onsetScores = rows[2 * k];
    const baselineScores = rows[2 * k + 1];
    // Baseline subtraction removes a continuous voiceover bed, but in
    // non-speech regions the pre-onset window contains the SFX itself, so
    // subtracting erases it. Only subtract when the onset frame is speech.
    const frameIdx = Math.floor(
      (ms / 1000) * SAMPLE_RATE_VAD / FRAME_SAMPLES,
    );
    const isSpeech = speechMask ? speechMask[frameIdx] === true : true;
    let topIdx = -1;
    let topDelta = 0;
    const scored: AudioSetLabel[] = [];
    for (let c = 0; c < onsetScores.length; c++) {
      if (suppress.has(c)) continue;
      const delta = isSpeech
        ? onsetScores[c] - baselineScores[c]
        : onsetScores[c];
      if (delta <= 0) continue;
      scored.push({ label: names[c], score: delta });
      if (delta > topDelta) {
        topDelta = delta;
        topIdx = c;
      }
    }
    if (topIdx < 0 || topDelta < MIN_CONFIDENCE) return null;
    scored.sort((a, b) => b.score - a.score);
    const top = names[topIdx];
    return {
      labels: scored.slice(0, TOP_K),
      top,
      confidence: Math.min(1, topDelta),
      bucket: audioSetLabelToBucket(top),
    };
  });
}
