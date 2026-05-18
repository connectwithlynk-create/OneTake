import type { ClipTag, Verdict } from './types';

/**
 * On-device clip rating.
 *
 * MVP heuristic stub. The real implementation (PRD FR-RATE-2) runs native
 * analysis: face / eyes (MLKit), blur (Laplacian variance), audio RMS /
 * clipping, speech presence. That requires native modules and is out of
 * scope for the basic build. This deterministic placeholder produces a
 * plausible verdict from the signals available in JS (clip duration plus a
 * stable per-clip pseudo-signal) so the capture -> review loop is fully
 * exercisable. Swap this module out, not its callers.
 */

function pseudo(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 0..1
  return ((h >>> 0) % 1000) / 1000;
}

export interface RatingInput {
  clipId: string;
  durationMs: number;
  /** Project default; user can still override the tag afterwards. */
  defaultTag: ClipTag;
}

export interface Rating {
  verdict: Verdict;
  tag: ClipTag;
}

export function rateClip({ clipId, durationMs, defaultTag }: RatingInput): Rating {
  const r = pseudo(clipId);

  // Too short to be usable.
  if (durationMs < 1200) return { verdict: 'dud', tag: defaultTag };

  // Sweet spot 4-30s scores higher; very long drifts down.
  const secs = durationMs / 1000;
  let score = r;
  if (secs >= 4 && secs <= 30) score += 0.25;
  if (secs > 45) score -= 0.2;

  const verdict: Verdict = score >= 0.7 ? 'perfect' : score >= 0.42 ? 'keep' : 'dud';
  return { verdict, tag: defaultTag };
}
