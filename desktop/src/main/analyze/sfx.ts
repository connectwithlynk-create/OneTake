// SFX (sound effect) detection via high-passed energy onset analysis.
//
// UGC reels frequently layer SFX (whooshes, dings, stings, risers) on
// top of continuous voiceover. Energy onset detection on the raw audio
// can't distinguish those from word onsets, and gating by VAD's speech
// mask drops them entirely (because they fire during speech). The fix:
// high-pass the audio first. Speech is dominantly 100-3000 Hz; UGC SFX
// carry significant energy above ~3 kHz. After HPF the speech baseline
// drops dramatically while SFX onsets stay strong — clean S/N.
//
// No new model — pure signal processing on the audio buffer the VAD
// pipeline already extracted.
import { FRAME_SAMPLES, SAMPLE_RATE_VAD } from './audio';
import type { Shot } from './scene-detect';

/** High-pass cutoff (Hz) applied before onset detection. ~3 kHz strips
 *  most speech-band energy and keeps whoosh/ding/sting content. */
const HPF_CUTOFF_HZ = 3000;
/** Frames averaged into the lagging baseline. ~192ms at 32ms/frame. */
const SMOOTHING_FRAMES = 6;
/** Current-frame RMS / baseline ratio that counts as an onset. */
const ONSET_RATIO = 2.0;
/** Floor on absolute RMS (on the HPF'd signal) at the onset — keeps
 *  quiet-to-less-quiet ratio spikes from firing in near-silence. The
 *  HPF significantly reduces overall amplitude vs raw audio, so the
 *  floor is correspondingly lower. */
const ONSET_MIN_RMS = 0.008;
/** Minimum spacing between detected onsets, in frames. ~96ms. */
const NMS_FRAMES = 3;
/** Window around a shot's start to count an onset as "at-cut", in ms. */
const CUT_ALIGN_MS = 200;

export interface SfxEvent {
  /** Onset time in ms from reel start. */
  ms: number;
  /** RMS at the onset frame, [0, 1]. */
  rms: number;
}

function perFrameRms(samples: Float32Array): Float32Array {
  const n = Math.floor(samples.length / FRAME_SAMPLES);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = i * FRAME_SAMPLES;
    let sum = 0;
    for (let j = 0; j < FRAME_SAMPLES; j++) {
      const v = samples[start + j];
      sum += v * v;
    }
    out[i] = Math.sqrt(sum / FRAME_SAMPLES);
  }
  return out;
}

/** First-order IIR high-pass filter. Cheap, single-pass, attenuates
 *  energy below `cutoffHz`. Good enough for separating SFX (HF
 *  transients) from voice (mid-band). */
function highPass(
  samples: Float32Array,
  cutoffHz: number,
  sampleRate: number,
): Float32Array {
  const RC = 1.0 / (2 * Math.PI * cutoffHz);
  const dt = 1.0 / sampleRate;
  const alpha = RC / (RC + dt);
  const out = new Float32Array(samples.length);
  out[0] = samples[0];
  for (let i = 1; i < samples.length; i++) {
    out[i] = alpha * (out[i - 1] + samples[i] - samples[i - 1]);
  }
  return out;
}

/** Detect SFX-style onsets in the audio buffer. The `speechMask`
 *  parameter is kept for API compatibility but no longer gates onsets
 *  — the high-pass front-end suppresses speech energy enough that we
 *  detect SFX layered over voiceover too. */
export function detectSfxOnsets(
  samples: Float32Array,
  _speechMask?: boolean[],
): SfxEvent[] {
  const hpf = highPass(samples, HPF_CUTOFF_HZ, SAMPLE_RATE_VAD);
  const rms = perFrameRms(hpf);
  const n = rms.length;
  if (n < SMOOTHING_FRAMES + 2) return [];

  // Lagging baseline: rolling mean of the previous SMOOTHING_FRAMES frames.
  const smoothed = new Float32Array(n);
  let runningSum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    runningSum += rms[i];
    count++;
    if (count > SMOOTHING_FRAMES) {
      runningSum -= rms[i - SMOOTHING_FRAMES];
      count = SMOOTHING_FRAMES;
    }
    smoothed[i] = runningSum / count;
  }

  const events: SfxEvent[] = [];
  let lastEventFrame = -NMS_FRAMES - 1;
  for (let i = 1; i < n - 1; i++) {
    if (rms[i] < ONSET_MIN_RMS) continue;
    const baseline = Math.max(smoothed[i - 1], 1e-6);
    const ratio = rms[i] / baseline;
    if (ratio < ONSET_RATIO) continue;
    // Local maximum in the ratio space: prefer the peak frame.
    const ratioPrev = rms[i - 1] / Math.max(smoothed[i - 2] ?? 1e-6, 1e-6);
    const ratioNext = rms[i + 1] / Math.max(smoothed[i] ?? 1e-6, 1e-6);
    if (ratio < ratioPrev || ratio < ratioNext) continue;
    if (i - lastEventFrame < NMS_FRAMES) continue;
    events.push({
      ms: Math.round((i * FRAME_SAMPLES * 1000) / SAMPLE_RATE_VAD),
      rms: rms[i],
    });
    lastEventFrame = i;
  }
  return events;
}

export interface ShotSfx {
  /** Number of SFX events whose onset falls within the shot's range. */
  sfx_count: number;
  /** True when at least one SFX onset is within ±CUT_ALIGN_MS of the
   *  shot's start (the typical "whoosh on the cut" placement). */
  sfx_at_start: boolean;
}

export function shotSfxMetrics(
  events: SfxEvent[],
  shots: Shot[],
): ShotSfx[] {
  return shots.map((shot) => {
    let count = 0;
    let atStart = false;
    for (const e of events) {
      if (e.ms >= shot.start_ms && e.ms < shot.end_ms) count++;
      if (Math.abs(e.ms - shot.start_ms) <= CUT_ALIGN_MS) atStart = true;
    }
    return { sfx_count: count, sfx_at_start: atStart };
  });
}

/** Of the supplied events, return the fraction whose onset is within
 *  ±CUT_ALIGN_MS of ANY shot boundary. Empty events -> 0. */
export function sfxAtCutsRatio(
  events: SfxEvent[],
  shots: Shot[],
): number {
  if (events.length === 0 || shots.length === 0) return 0;
  let aligned = 0;
  // Pre-extract shot starts. Shot 0's start is the reel start, not a
  // cut per se, but an SFX there is still cut-style placement (intro sting).
  const boundaries = shots.map((s) => s.start_ms);
  for (const e of events) {
    for (const b of boundaries) {
      if (Math.abs(e.ms - b) <= CUT_ALIGN_MS) {
        aligned++;
        break;
      }
    }
  }
  return aligned / events.length;
}
