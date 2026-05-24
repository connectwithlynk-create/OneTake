// Acoustic type classification for detected SFX onsets.
//
// Identity matching (cosine-MFCC, Shazam-style peak-hash) both failed
// for impulse SFX layered under voiceover — there isn't enough signal
// in a quiet ding under voice to identify exactly which library entry
// it is. But the BROAD CATEGORY of the sound (bell-impulse vs
// noisy-impulse vs sweep vs vocal stinger) is recoverable from
// hand-crafted acoustic features computed on the same ±200ms window.
//
// Key trick: the input audio is voice + SFX, but the SFX detector
// already gave us the precise onset. Use a spectrum DELTA: subtract
// the pre-onset baseline spectrum (~100 ms before the onset = voice
// only) from the onset-peak spectrum. What's left is dominantly the
// SFX itself. All spectral features (centroid, flatness, band ratios)
// run on the delta, not the raw mixed spectrum.
//
// For OneTake's autocut, knowing the type is arguably more useful than
// knowing the exact file: the autocut can pick any bell from any
// library when matching a "uses 15 bell-impulse sounds" creator
// fingerprint, instead of being tied to one specific SFX source.
//
// Pure DSP, no model dependency.

const SAMPLE_RATE = 16000;
/** STFT window for classification — short enough to localize transients
 *  (32 ms) but still gives 257 useful freq bins. */
const FFT_SIZE = 512;
/** 4 ms hop for fine temporal resolution on attack/decay envelopes. */
const HOP = 64;
const NUM_BINS = FFT_SIZE / 2;
const NYQUIST = SAMPLE_RATE / 2;

/** Pre-onset window for baseline (voice-only) spectrum estimation, ms. */
const BASELINE_MS_BEFORE = 100;
/** Post-onset window to find the SFX peak and characterize spectrum, ms. */
const PEAK_SEARCH_MS_AFTER = 80;
/** ±200 ms slice extracted around the onset for the classifier. */
const CLASSIFY_HALF_WINDOW_MS = 200;

export type SfxType =
  | 'impulse_tonal'
  | 'impulse_noisy'
  | 'sweep'
  | 'vocal'
  | 'sustained'
  | 'other';

export const SFX_TYPES: SfxType[] = [
  'impulse_tonal',
  'impulse_noisy',
  'sweep',
  'vocal',
  'sustained',
  'other',
];

export interface SfxClassification {
  type: SfxType;
  /** Heuristic confidence in [0, 1] — how well the features fit the
   *  bucket. Low confidence == sound sits between categories. */
  confidence: number;
  /** Raw acoustic features for debugging / future ML upgrades. */
  features: SfxFeatures;
}

export interface SfxFeatures {
  /** RMS at the peak frame after the onset. */
  peak_rms: number;
  /** RMS of the pre-onset baseline (voice-only proxy). */
  baseline_rms: number;
  /** peak_rms / baseline_rms — how much above baseline the SFX rose. */
  spike_ratio: number;
  /** Spectral centroid (Hz) of the SFX delta-spectrum (onset - baseline).
   *  Tells you where the SFX's added energy is concentrated. */
  delta_centroid_hz: number;
  /** Spectral flatness of the delta-spectrum, [0,1]. Tonal = low,
   *  noise = high. */
  delta_flatness: number;
  /** Fraction of the delta-spectrum energy in 200-1500 Hz (vocal formant
   *  range). High = vocal stinger. */
  delta_voice_band_ratio: number;
  /** Fraction of the delta-spectrum energy above 3 kHz (impulse band). */
  delta_high_band_ratio: number;
}

// ---------- FFT (radix-2 Cooley-Tukey, same as shazam.ts) ----------
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wCos = Math.cos(ang);
    const wSin = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k++) {
        const tr = wr * re[i + k + half] - wi * im[i + k + half];
        const ti = wr * im[i + k + half] + wi * re[i + k + half];
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] = re[i + k] + tr;
        im[i + k] = im[i + k] + ti;
        const nwr = wr * wCos - wi * wSin;
        wi = wr * wSin + wi * wCos;
        wr = nwr;
      }
    }
  }
}

const WINDOW = (() => {
  const w = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  return w;
})();

/** RMS per HOP-sized frame (no window — for envelope tracking). */
function rmsEnvelope(samples: Float32Array): Float32Array {
  const n = samples.length;
  if (n < HOP) return new Float32Array(0);
  const numFrames = Math.floor(n / HOP);
  const out = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const start = f * HOP;
    for (let i = 0; i < HOP; i++) {
      const v = samples[start + i];
      sum += v * v;
    }
    out[f] = Math.sqrt(sum / HOP);
  }
  return out;
}

/** Single-frame magnitude spectrum at frame index `peakSample`
 *  (in original sample coords). Returns NUM_BINS magnitudes. */
function spectrumAtSample(
  samples: Float32Array,
  centerSample: number,
): Float32Array | null {
  const start = Math.max(0, centerSample - FFT_SIZE / 2);
  if (start + FFT_SIZE > samples.length) return null;
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    re[i] = samples[start + i] * WINDOW[i];
    im[i] = 0;
  }
  fft(re, im);
  const out = new Float32Array(NUM_BINS);
  for (let b = 0; b < NUM_BINS; b++) {
    out[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
  }
  return out;
}

/** Average several magnitude spectra cell-wise. Returns null when the
 *  input list is empty or contains all-null entries. */
function averageSpectra(
  samples: Float32Array,
  centerSamples: number[],
): Float32Array | null {
  let count = 0;
  const sum = new Float32Array(NUM_BINS);
  for (const cs of centerSamples) {
    const s = spectrumAtSample(samples, cs);
    if (!s) continue;
    for (let b = 0; b < NUM_BINS; b++) sum[b] += s[b];
    count++;
  }
  if (count === 0) return null;
  for (let b = 0; b < NUM_BINS; b++) sum[b] /= count;
  return sum;
}

/** Build the SFX features for a slice centered on the onset. Pre-onset
 *  baseline is averaged across `BASELINE_MS_BEFORE`; peak is the loudest
 *  frame within `PEAK_SEARCH_MS_AFTER`. The delta spectrum (peak minus
 *  baseline, clamped >= 0) carries the SFX-only character. */
function extractFeatures(
  samples: Float32Array,
  onsetSampleInSlice: number,
): SfxFeatures | null {
  const env = rmsEnvelope(samples);
  if (env.length === 0) return null;

  const onsetFrame = Math.round(onsetSampleInSlice / HOP);
  // Baseline window: frames whose centers fall in
  // [onset - BASELINE_MS_BEFORE - 20, onset - 20] (avoid attack ramp).
  const baselineFrames: number[] = [];
  const baselineEnd = onsetFrame - Math.round((20 / 1000) * SAMPLE_RATE / HOP);
  const baselineStart =
    baselineEnd -
    Math.max(1, Math.round((BASELINE_MS_BEFORE / 1000) * SAMPLE_RATE / HOP));
  for (let f = Math.max(0, baselineStart); f < Math.max(0, baselineEnd); f++) {
    baselineFrames.push(f);
  }
  let baselineSum = 0;
  for (const f of baselineFrames) baselineSum += env[f] ?? 0;
  const baselineRms =
    baselineFrames.length > 0 ? baselineSum / baselineFrames.length : 0;

  // Peak: loudest frame in [onset, onset + PEAK_SEARCH_MS_AFTER].
  const searchEnd = Math.min(
    env.length - 1,
    onsetFrame +
      Math.round((PEAK_SEARCH_MS_AFTER / 1000) * SAMPLE_RATE / HOP),
  );
  let peakFrame = onsetFrame;
  let peakRms = 0;
  for (let f = Math.max(0, onsetFrame); f <= searchEnd; f++) {
    if (env[f] > peakRms) {
      peakRms = env[f];
      peakFrame = f;
    }
  }
  if (peakRms === 0) return null;
  const spikeRatio = baselineRms > 0 ? peakRms / baselineRms : peakRms / 1e-6;

  // Baseline spectrum: average across the baseline frames' centers.
  const baselineSpec = averageSpectra(
    samples,
    baselineFrames.map((f) => f * HOP + HOP / 2),
  );
  const peakSpec = spectrumAtSample(samples, peakFrame * HOP + HOP / 2);
  if (!peakSpec) return null;

  // Delta spectrum = peak - baseline, clamped >= 0. Isolates the SFX.
  const delta = new Float32Array(NUM_BINS);
  for (let b = 0; b < NUM_BINS; b++) {
    const v = peakSpec[b] - (baselineSpec ? baselineSpec[b] : 0);
    delta[b] = v > 0 ? v : 0;
  }

  let totalMag = 0;
  let centroidNum = 0;
  let voiceBandSum = 0;
  let highBandSum = 0;
  let geoLogSum = 0;
  let geoCount = 0;
  const binHz = NYQUIST / NUM_BINS;
  for (let b = 1; b < NUM_BINS; b++) {
    const m = delta[b];
    const fz = b * binHz;
    totalMag += m;
    centroidNum += m * fz;
    if (fz >= 200 && fz <= 1500) voiceBandSum += m;
    if (fz >= 3000) highBandSum += m;
    if (m > 1e-10) {
      geoLogSum += Math.log(m);
      geoCount++;
    }
  }
  const centroid = totalMag > 0 ? centroidNum / totalMag : 0;
  const voiceBandRatio = totalMag > 0 ? voiceBandSum / totalMag : 0;
  const highBandRatio = totalMag > 0 ? highBandSum / totalMag : 0;
  const arithMean = totalMag / (NUM_BINS - 1);
  const geoMean = geoCount > 0 ? Math.exp(geoLogSum / geoCount) : 0;
  const flatness = arithMean > 0 ? geoMean / arithMean : 0;

  return {
    peak_rms: peakRms,
    baseline_rms: baselineRms,
    spike_ratio: spikeRatio,
    delta_centroid_hz: centroid,
    delta_flatness: flatness,
    delta_voice_band_ratio: voiceBandRatio,
    delta_high_band_ratio: highBandRatio,
  };
}

/** Rule-based classifier on the SFX delta features. The onset detector
 *  already confirmed an impulse fired — this routine only labels its
 *  spectral character. Rules favor common UGC vocabulary
 *  (bell-dings, claps, whooshes, vocal stingers). */
function classify(features: SfxFeatures): { type: SfxType; confidence: number } {
  const f = features;
  // 1. Vocal stinger ("wow", "yeah", spoken stab): voice-band energy
  //    dominates the delta and outweighs high-band content.
  if (
    f.delta_voice_band_ratio > 0.4 &&
    f.delta_voice_band_ratio > f.delta_high_band_ratio * 1.5
  ) {
    return {
      type: 'vocal',
      confidence: Math.min(1, f.delta_voice_band_ratio),
    };
  }

  // 2. Tonal impulse (bell, ding, beep): peaky spectrum, high-band dominant.
  if (f.delta_flatness < 0.25 && f.delta_high_band_ratio > 0.3) {
    return {
      type: 'impulse_tonal',
      confidence: Math.min(
        1,
        0.6 + (0.25 - f.delta_flatness) * 1.5,
      ),
    };
  }

  // 3. Noisy impulse (clap, snap, glitch): flat-ish wideband delta.
  if (f.delta_flatness > 0.45 && f.delta_high_band_ratio > 0.25) {
    return {
      type: 'impulse_noisy',
      confidence: Math.min(1, 0.6 + (f.delta_flatness - 0.45) * 1.5),
    };
  }

  // 4. Sweep (whoosh, riser): broadband with significant low-mid content,
  //    not particularly tonal.
  if (
    f.delta_centroid_hz > 1500 &&
    f.delta_high_band_ratio > 0.4 &&
    f.delta_flatness > 0.2 &&
    f.delta_flatness < 0.5
  ) {
    return { type: 'sweep', confidence: 0.6 };
  }

  // 5. Borderline cases — default to tonal impulse with lower confidence
  //    since onset detection (HPF'd ratio spike) implies a clean transient,
  //    and tonal impulses dominate UGC SFX vocabulary.
  if (f.delta_flatness < 0.35) {
    return { type: 'impulse_tonal', confidence: 0.45 };
  }
  return { type: 'other', confidence: 0.3 };
}

/** Slice ±CLASSIFY_HALF_WINDOW_MS around `onsetMs` (clamped to buffer)
 *  and run the delta-spectrum classifier. Returns null when the slice
 *  is too short to extract features. */
export function classifyOnset(
  samples: Float32Array,
  onsetMs: number,
): SfxClassification | null {
  const center = Math.round((onsetMs / 1000) * SAMPLE_RATE);
  const half = Math.round((CLASSIFY_HALF_WINDOW_MS / 1000) * SAMPLE_RATE);
  const start = Math.max(0, center - half);
  const end = Math.min(samples.length, center + half);
  if (end - start < FFT_SIZE) return null;
  const slice = samples.slice(start, end);
  // Onset position within the slice: typically half-way (center)
  // unless we clamped at the buffer start.
  const onsetSampleInSlice = center - start;
  const features = extractFeatures(slice, onsetSampleInSlice);
  if (!features) return null;
  const { type, confidence } = classify(features);
  return { type, confidence, features };
}
