import type { ShotPlan, TranscriptWord } from './global';

export const MIN_SHOT_MS = 200;

function validWords(words: TranscriptWord[] | undefined): TranscriptWord[] {
  return (words ?? [])
    .filter(
      (word) =>
        typeof word.text === 'string' &&
        Number.isFinite(word.start_ms) &&
        Number.isFinite(word.end_ms) &&
        word.end_ms > word.start_ms,
    )
    .slice()
    .sort((a, b) => a.start_ms - b.start_ms);
}

function uniqueWords(words: TranscriptWord[]): TranscriptWord[] {
  const seen = new Set<string>();
  const out: TranscriptWord[] = [];
  for (const word of words) {
    const key = `${word.start_ms}:${word.end_ms}:${word.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}

function wordsText(words: TranscriptWord[]): string {
  return words
    .map((word) => word.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampBoundary(
  left: ShotPlan,
  right: ShotPlan,
  ms: number,
  minShotMs = MIN_SHOT_MS,
): number {
  const lo = left.start_ms + minShotMs;
  const hi = right.end_ms - minShotMs;
  return Math.max(lo, Math.min(hi, Math.round(ms)));
}

export function snapBoundaryToTranscript(
  left: ShotPlan,
  right: ShotPlan,
  ms: number,
  minShotMs = MIN_SHOT_MS,
): number {
  const clamped = clampBoundary(left, right, ms, minShotMs);
  const lo = left.start_ms + minShotMs;
  const hi = right.end_ms - minShotMs;
  const words = uniqueWords([
    ...validWords(left.spoken_words),
    ...validWords(right.spoken_words),
  ]);
  if (words.length === 0) return clamped;

  const containing = words.find(
    (word) => clamped > word.start_ms && clamped < word.end_ms,
  );
  if (containing && containing.end_ms >= lo && containing.end_ms <= hi) {
    return containing.end_ms;
  }

  const candidates = words
    .flatMap((word) => [word.start_ms, word.end_ms])
    .filter((candidate) => candidate >= lo && candidate <= hi);
  let best = clamped;
  let bestDelta = 121;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - clamped);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  return best;
}

export function splitAdjacentShotsAtTranscriptBoundary(
  left: ShotPlan,
  right: ShotPlan,
  edgeMs: number,
): { left: ShotPlan; right: ShotPlan } {
  const edge = Math.round(edgeMs);
  const combined = uniqueWords([
    ...validWords(left.spoken_words),
    ...validWords(right.spoken_words),
  ]);
  const leftWords = combined.filter((word) => word.end_ms <= edge);
  const rightWords = combined.filter((word) => word.start_ms >= edge);
  const hasTimedWords = combined.length > 0;
  return {
    left: {
      ...left,
      end_ms: edge,
      duration_ms: edge - left.start_ms,
      ...(hasTimedWords
        ? { spoken_words: leftWords, spoken_during: wordsText(leftWords) }
        : {}),
    },
    right: {
      ...right,
      start_ms: edge,
      duration_ms: right.end_ms - edge,
      ...(hasTimedWords
        ? { spoken_words: rightWords, spoken_during: wordsText(rightWords) }
        : {}),
    },
  };
}

export function alignShotEndsToTranscript(
  shots: ShotPlan[],
  minShotMs = MIN_SHOT_MS,
): { shots: ShotPlan[]; changed: boolean } {
  if (shots.length < 2) return { shots, changed: false };
  const next = shots.slice();
  let changed = false;

  for (let i = 0; i < next.length - 1; i++) {
    const left = next[i];
    const right = next[i + 1];
    const leftWords = validWords(left.spoken_words);
    const lastWordEnd = leftWords[leftWords.length - 1]?.end_ms;
    if (!lastWordEnd || lastWordEnd <= left.end_ms) continue;
    const edge = clampBoundary(left, right, lastWordEnd, minShotMs);
    if (edge === left.end_ms) continue;
    next[i] = { ...left, end_ms: edge, duration_ms: edge - left.start_ms };
    next[i + 1] = {
      ...right,
      start_ms: edge,
      duration_ms: right.end_ms - edge,
    };
    changed = true;
  }

  return changed ? { shots: next, changed } : { shots, changed: false };
}
