// Audio extraction + analysis.
//   - extractAudioPCM: per-window int16-as-float samples for SyncNet's MFCC
//   - extractReelAudio: whole-reel mono float32 in [-1, 1] for RMS/VAD
//   - audioMetricsForShots: per-shot RMS / silence / peak from the
//     whole-reel buffer (one ffmpeg call instead of N per-shot calls)
import { execFile } from 'child_process';
import type { Shot } from './scene-detect';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SAMPLE_RATE_VAD = 16000;
/** ~30ms frame at 16 kHz. Used both as RMS window and as the silence
 *  detection granularity. Matches Silero VAD's expected frame size for
 *  pass 2, so the same buffer feeds both. */
const FRAME_SAMPLES = 480;
/** Per-frame RMS below this counts as silent. Float samples in [-1, 1];
 *  0.01 is roughly -40 dBFS, a common "near silence" threshold. */
const SILENCE_RMS = 0.01;

/**
 * Extract a window of audio as 16 kHz mono samples. Returns the raw int16
 * sample VALUES as floats (NOT normalized to [-1,1]) - python_speech_features
 * (and therefore Light-ASD's MFCC) is computed on the int16 wav samples.
 */
export function extractAudioPCM(
  url: string,
  startMs: number,
  durMs: number,
): Promise<Float32Array> {
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      [
        '-nostdin', '-loglevel', 'error',
        '-ss', (startMs / 1000).toFixed(3),
        '-i', url,
        '-t', (durMs / 1000).toFixed(3),
        '-ac', '1',
        '-ar', '16000',
        '-f', 's16le',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      (err, stdout) => {
        const buf = stdout as unknown as Buffer;
        if (err || !buf || buf.length < 2) {
          resolve(new Float32Array(0));
          return;
        }
        const n = buf.length >> 1;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = buf.readInt16LE(i * 2);
        }
        resolve(out);
      },
    );
  });
}

export interface ShotAudio {
  /** Mean RMS amplitude across the shot's 30ms frames, in [0, 1]. */
  rms_mean: number;
  /** Fraction of the shot's frames whose RMS < SILENCE_RMS, in [0, 1]. */
  silence_pct: number;
  /** Peak per-frame RMS in the shot, in [0, 1]. */
  peak_rms: number;
}

/** Extract the entire reel's audio as float32 mono samples in [-1, 1]
 *  at 16 kHz. Returns null on failure (no audio, ffmpeg error). */
export async function extractReelAudio(
  url: string,
): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        url,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE_VAD),
        '-f',
        's16le',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => {
        const buf = stdout as unknown as Buffer;
        if (err || !buf || buf.length === 0) {
          resolve(null);
          return;
        }
        const samples = new Float32Array(buf.length / 2);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = buf.readInt16LE(i * 2) / 32768;
        }
        resolve(samples);
      },
    );
  });
}

function rms(samples: Float32Array, start: number, end: number): number {
  const clampedEnd = Math.min(end, samples.length);
  let sum = 0;
  let n = 0;
  for (let i = start; i < clampedEnd; i++) {
    sum += samples[i] * samples[i];
    n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/** Compute per-shot audio metrics from the reel's full sample buffer. */
export function audioMetricsForShots(
  samples: Float32Array,
  shots: Shot[],
): ShotAudio[] {
  return shots.map((shot) => {
    const startSample = Math.floor(
      (shot.start_ms / 1000) * SAMPLE_RATE_VAD,
    );
    const endSample = Math.floor((shot.end_ms / 1000) * SAMPLE_RATE_VAD);
    if (endSample <= startSample || startSample >= samples.length) {
      return { rms_mean: 0, silence_pct: 1, peak_rms: 0 };
    }
    let sumRms = 0;
    let silentFrames = 0;
    let peak = 0;
    let frames = 0;
    for (let s = startSample; s < endSample; s += FRAME_SAMPLES) {
      const r = rms(samples, s, s + FRAME_SAMPLES);
      sumRms += r;
      if (r < SILENCE_RMS) silentFrames++;
      if (r > peak) peak = r;
      frames++;
    }
    return {
      rms_mean: frames > 0 ? sumRms / frames : 0,
      silence_pct: frames > 0 ? silentFrames / frames : 1,
      peak_rms: peak,
    };
  });
}
