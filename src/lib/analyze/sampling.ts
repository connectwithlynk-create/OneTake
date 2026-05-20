/**
 * Pick frame-sample timestamps for the analysis pipeline.
 *
 * The native frame extractor streams byte ranges per timestamp, so the
 * cost scales linearly with the number of samples. We want enough density
 * to catch fast cuts (reels often have 0.5-1.0s shots) without bloating
 * bandwidth or memory.
 *
 * Defaults: ~1 sample per 500ms, clamped to [20, 80]. For a 30s reel
 * that's 60 frames; for a 6s reel it's 20; for a 90s long-form upload
 * it caps at 80 so the bridge transfer stays small.
 */
export interface SamplingOptions {
  /** Target gap between samples in ms. Default 500. */
  intervalMs?: number;
  /** Floor on total samples. Default 20. */
  minSamples?: number;
  /** Ceiling on total samples. Default 80. */
  maxSamples?: number;
  /** Trim from start to avoid pre-roll frames (intros, black). Default 100ms. */
  startOffsetMs?: number;
  /** Trim from end to avoid trailing black. Default 100ms. */
  endOffsetMs?: number;
}

export function pickSampleTimestamps(
  durationMs: number,
  opts: SamplingOptions = {}
): number[] {
  const interval = opts.intervalMs ?? 500;
  const min = opts.minSamples ?? 20;
  const max = opts.maxSamples ?? 80;
  const startOff = opts.startOffsetMs ?? 100;
  const endOff = opts.endOffsetMs ?? 100;

  const usable = Math.max(0, durationMs - startOff - endOff);
  if (usable <= 0) return [];

  let n = Math.round(usable / interval);
  if (n < min) n = Math.min(min, Math.max(2, Math.round(usable / 50)));
  if (n > max) n = max;

  const step = usable / (n - 1 || 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round(startOff + i * step));
  }
  return out;
}
