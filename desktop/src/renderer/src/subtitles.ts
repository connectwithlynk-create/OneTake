import type { ShotPlan, SubtitleSpec, TranscriptWord } from './global';

function applySubtitleCasing(text: string, casing: SubtitleSpec['casing']): string {
  if (casing === 'uppercase') return text.toUpperCase();
  if (casing === 'title_case') {
    return text.replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return text;
}

function normalizeCaptionText(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}'’]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function timedWordsForShot(shot: ShotPlan, cleanedText: string): TranscriptWord[] {
  const timed = (shot.spoken_words ?? [])
    .filter(
      (w) =>
        typeof w.text === 'string' &&
        Number.isFinite(w.start_ms) &&
        Number.isFinite(w.end_ms) &&
        w.end_ms > w.start_ms,
    )
    .slice()
    .sort((a, b) => a.start_ms - b.start_ms);
  if (timed.length === 0) return [];

  // If the user manually edited spoken_during, old word timings would display
  // stale words. Only trust timestamps while they still describe this text.
  const timedText = timed.map((w) => w.text).join(' ');
  return normalizeCaptionText(timedText) === normalizeCaptionText(cleanedText)
    ? timed
    : [];
}

function estimatedActiveWord(
  words: string[],
  shot: ShotPlan,
  playbackMs: number,
): number {
  const naturalWps = 2.8;
  const durationSec = Math.max(0.25, (shot.end_ms - shot.start_ms) / 1000);
  const elapsedSec = Math.max(0, (playbackMs - shot.start_ms) / 1000);
  const wps = Math.max(words.length / durationSec, naturalWps);
  return Math.min(words.length - 1, Math.floor(elapsedSec * wps));
}

function timedActiveWord(words: TranscriptWord[], playbackMs: number): number {
  if (playbackMs <= words[0].start_ms) return 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (playbackMs >= word.start_ms && playbackMs < word.end_ms) return i;
    if (playbackMs < word.start_ms) return Math.max(0, i - 1);
  }
  return words.length - 1;
}

export function subtitleTextForShot(
  text: string,
  spec: SubtitleSpec,
  shot: ShotPlan,
  playbackMs: number,
): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const words = cleaned.split(' ');
  if (spec.chunking === 'sentence') {
    return applySubtitleCasing(cleaned, spec.casing);
  }

  const timedWords = timedWordsForShot(shot, cleaned);
  const activeWord =
    timedWords.length > 0
      ? timedActiveWord(timedWords, playbackMs)
      : estimatedActiveWord(words, shot, playbackMs);
  const group =
    spec.chunking === 'word_by_word'
      ? Math.min(2, Math.max(1, spec.words_per_chunk))
      : Math.max(1, spec.words_per_chunk);
  const start =
    spec.chunking === 'word_by_word'
      ? activeWord
      : Math.min(Math.floor(activeWord / group) * group, Math.max(0, words.length - group));
  return applySubtitleCasing(
    words.slice(start, Math.min(words.length, start + group)).join(' '),
    spec.casing,
  );
}
