import type { ExtractedFrame } from 'expo-frame-extractor';

/**
 * Shot-boundary detection from a list of dHash-tagged frames.
 *
 * Algorithm: compute Hamming distance between consecutive frames'
 * 64-bit dhashes; mark a boundary where distance exceeds an adaptive
 * threshold (max of an absolute floor and a multiple of the rolling
 * median). Merge boundaries that produce shots shorter than the
 * minimum so we don't fragment fast-cutting clips into noise.
 *
 * Returns shot boundaries with timestamps drawn from the input frames
 * (so the boundaries align with frames we already have, ready to be
 * fed into OCR / face detection in task #5).
 */
export interface ShotBoundary {
  start_ms: number;
  end_ms: number;
  /** Index into the input frames array of the frame nearest the middle
   *  of this shot. Use this frame for OCR + face detection downstream. */
  representativeFrameIndex: number;
}

export interface ShotDetectionOptions {
  /** Absolute Hamming-distance threshold (out of 64). Default 18. */
  absoluteThreshold?: number;
  /** Multiplier on the rolling median diff. Default 2.5. */
  adaptiveMultiplier?: number;
  /** Window size for the rolling median, in frames. Default 8. */
  medianWindow?: number;
  /** Drop shots shorter than this. Default 250ms. */
  minShotMs?: number;
  /** Treat reel end as the last shot's end. Default reads from
   *  the final frame's timestamp. */
  durationMs?: number;
}

/** Parse a 16-char hex string into a BigInt. Fast-path for the
 *  64-bit dhashes the native module emits. */
function hexToBigInt(hex: string): bigint {
  // BigInt('0x...') is fine for 16-char inputs (~280ns each); fast enough
  // for the ~60-80 frames we process per reel.
  return BigInt('0x' + hex);
}

/** Kernighan's bit count, runs in O(set bits). */
function popcount64(n: bigint): number {
  let c = 0;
  let v = n;
  while (v) {
    v &= v - 1n;
    c++;
  }
  return c;
}

function hammingDistance(aHex: string, bHex: string): number {
  return popcount64(hexToBigInt(aHex) ^ hexToBigInt(bHex));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function detectShots(
  frames: ExtractedFrame[],
  opts: ShotDetectionOptions = {}
): ShotBoundary[] {
  if (frames.length === 0) return [];
  if (frames.length === 1) {
    return [
      {
        start_ms: 0,
        end_ms: opts.durationMs ?? frames[0].timestampMs,
        representativeFrameIndex: 0,
      },
    ];
  }

  const absThresh = opts.absoluteThreshold ?? 18;
  const adaptiveMult = opts.adaptiveMultiplier ?? 2.5;
  const window = opts.medianWindow ?? 8;
  const minShotMs = opts.minShotMs ?? 250;
  const totalDur = opts.durationMs ?? frames[frames.length - 1].timestampMs;

  // Per-gap Hamming distance.
  const diffs: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    diffs.push(hammingDistance(frames[i - 1].dhashHex, frames[i].dhashHex));
  }

  // Adaptive threshold: max(absolute, multiplier * rolling-median).
  // The rolling median ignores spikes, so a few cuts don't lift the
  // floor enough to mask subsequent ones.
  const isBoundary: boolean[] = diffs.map((d, i) => {
    const lo = Math.max(0, i - window);
    const hi = Math.min(diffs.length, i + window + 1);
    const mid = median(diffs.slice(lo, hi));
    const t = Math.max(absThresh, mid * adaptiveMult);
    return d > t;
  });

  // Boundary indices = frame indices where a cut precedes them.
  // Always include 0 (start) implicitly via the first shot.
  const boundaryFrameIndices: number[] = [0];
  for (let i = 0; i < isBoundary.length; i++) {
    if (isBoundary[i]) boundaryFrameIndices.push(i + 1);
  }

  // Emit shots; each shot spans [frames[bIdx[k]].ts, frames[bIdx[k+1]].ts).
  const shots: ShotBoundary[] = [];
  for (let k = 0; k < boundaryFrameIndices.length; k++) {
    const startIdx = boundaryFrameIndices[k];
    const endIdx =
      k + 1 < boundaryFrameIndices.length
        ? boundaryFrameIndices[k + 1] - 1
        : frames.length - 1;
    const startMs = k === 0 ? 0 : frames[startIdx].timestampMs;
    const endMs =
      k + 1 < boundaryFrameIndices.length
        ? frames[boundaryFrameIndices[k + 1]].timestampMs
        : totalDur;
    const midIdx = Math.floor((startIdx + endIdx) / 2);
    shots.push({
      start_ms: Math.round(startMs),
      end_ms: Math.round(endMs),
      representativeFrameIndex: midIdx,
    });
  }

  // Merge short shots into the next: this drops detector noise on
  // fast-motion scenes where intra-shot motion exceeds the threshold.
  const merged: ShotBoundary[] = [];
  for (const s of shots) {
    const dur = s.end_ms - s.start_ms;
    if (dur < minShotMs && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.end_ms = s.end_ms;
      // keep the longer shot's representative (usually the merged-into)
      continue;
    }
    merged.push({ ...s });
  }

  return merged;
}
