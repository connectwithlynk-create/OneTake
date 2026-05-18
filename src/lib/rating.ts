import type { ClipTag, Verdict } from './types';

/**
 * On-device clip rating + talking/b-roll detection.
 *
 * Tag detection is real signal-based inference (no LLM, no model): it uses
 * the actual capture signals available - which camera lens the user pointed
 * and where the clip came from - because that is how a talking-head shot and
 * a b-roll shot genuinely differ in practice:
 *   - front lens, recorded   -> the user is on camera talking  => talking
 *   - back lens, recorded    -> filming the world for cutaways  => b-roll
 *   - imported from library  -> almost always supplemental      => b-roll
 *   - too short to be a take                                    => b-roll
 *
 * The verdict (dud/keep/perfect) is still a heuristic placeholder (duration
 * + a stable per-clip pseudo-signal); true quality needs native A/V analysis
 * (PRD FR-RATE-2). Swap that part out, not the callers.
 */

function pseudo(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

export type ClipSource = 'recorded' | 'imported';
export type Facing = 'front' | 'back';

export interface RatingInput {
  clipId: string;
  durationMs: number;
  source: ClipSource;
  /** The lens used, when recorded in-app. Absent for imports. */
  facing?: Facing;
  /** Real audio-metering verdict: speech present in the clip. undefined =
   *  detection unavailable -> fall back to the lens heuristic. */
  hasSpeech?: boolean;
}

export interface Rating {
  verdict: Verdict;
  tag: ClipTag;
}

/** Infer talking vs b-roll. Speech detection wins (lens-independent);
 *  the lens/source heuristic is only the fallback when audio detection
 *  was unavailable (e.g. imports, or the meter could not run). */
export function detectTag({
  durationMs,
  source,
  facing,
  hasSpeech,
}: Pick<
  RatingInput,
  'durationMs' | 'source' | 'facing' | 'hasSpeech'
>): ClipTag {
  // Sub-2s clips are almost never a talking take.
  if (durationMs < 2000) return 'broll';
  // Real audio signal beats any metadata guess - works on any lens, even
  // when someone else is filming you talking.
  if (hasSpeech === true) return 'talking';
  if (hasSpeech === false) return 'broll';
  // Fallback (imports, or metering unavailable): front selfie lens = talking.
  if (source === 'recorded' && facing === 'front') return 'talking';
  return 'broll';
}

export function rateClip(input: RatingInput): Rating {
  const { clipId, durationMs } = input;
  const tag = detectTag(input);

  if (durationMs < 1200) return { verdict: 'dud', tag };

  const r = pseudo(clipId);
  const secs = durationMs / 1000;
  let score = r;
  if (secs >= 4 && secs <= 30) score += 0.25;
  if (secs > 45) score -= 0.2;

  const verdict: Verdict =
    score >= 0.7 ? 'perfect' : score >= 0.42 ? 'keep' : 'dud';
  return { verdict, tag };
}
