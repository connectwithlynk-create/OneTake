import type { SuggestedEdit } from './synthesize';
import type { TranscriptWord } from './transcribe';

function validWord(word: TranscriptWord): boolean {
  return (
    typeof word.text === 'string' &&
    Number.isFinite(word.start_ms) &&
    Number.isFinite(word.end_ms) &&
    word.end_ms > word.start_ms
  );
}

function normalizeTokens(text: string): string[] {
  return text
    .replace(/[^\p{L}\p{N}'’]+/gu, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function wordsOverlapShot(
  words: TranscriptWord[],
  fromMs: number,
  toMs: number,
): TranscriptWord[] {
  return words.filter((word) => word.end_ms > fromMs && word.start_ms < toMs);
}

function shotNeedsSpokenWords(
  shot: SuggestedEdit['shots'][number],
): boolean {
  return !Array.isArray(shot.spoken_words) || shot.spoken_words.length === 0;
}

export function hydratePlanSpokenWords(
  plan: SuggestedEdit,
  words: TranscriptWord[],
): { plan: SuggestedEdit; changed: boolean } {
  const transcript = words.filter(validWord).sort((a, b) => a.start_ms - b.start_ms);
  if (transcript.length === 0) return { plan, changed: false };

  let changed = false;
  const shots = plan.shots.map((shot) => {
    if (!shotNeedsSpokenWords(shot)) return shot;
    const spokenWords = wordsOverlapShot(transcript, shot.start_ms, shot.end_ms);
    changed = true;
    return { ...shot, spoken_words: spokenWords };
  });

  return changed ? { plan: { ...plan, shots }, changed: true } : { plan, changed: false };
}

export function estimatePlanSpokenWords(plan: SuggestedEdit): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const shot of plan.shots) {
    const tokens = shot.spoken_during.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const span = Math.max(1, shot.end_ms - shot.start_ms);
    const step = span / tokens.length;
    const duration = Math.max(80, Math.min(step * 0.85, span));
    tokens.forEach((text, index) => {
      const start_ms = Math.round(shot.start_ms + step * index);
      const end_ms = Math.min(shot.end_ms, Math.round(start_ms + duration));
      out.push({ text, start_ms, end_ms });
    });
  }
  return out;
}

export function transcriptTextScore(
  plan: SuggestedEdit,
  words: TranscriptWord[],
): number {
  const planTokens = normalizeTokens(
    plan.shots.map((shot) => shot.spoken_during).join(' '),
  );
  const transcriptTokens = normalizeTokens(words.map((word) => word.text).join(' '));
  if (planTokens.length === 0 || transcriptTokens.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const token of transcriptTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  let matched = 0;
  for (const token of planTokens) {
    const count = counts.get(token) ?? 0;
    if (count <= 0) continue;
    matched += 1;
    counts.set(token, count - 1);
  }

  return matched / planTokens.length;
}
