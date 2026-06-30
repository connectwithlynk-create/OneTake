/**
 * Captions derived from a clip's transcript_words (word-level timings
 * from server transcription). Groups words into short lines on a
 * pause-aware schedule so they read naturally on screen.
 *
 * No persistence yet — every panel render derives from transcript_words
 * on the fly. Per-line edits / hides will land in a sidecar JSON later.
 */

import type { Clip, WordTiming } from './types';

export type CaptionStyle =
  | 'karaoke'
  | 'bold'
  | 'pop'
  | 'subtle'
  | 'bar'
  | 'typeout';

export const CAPTION_STYLES: CaptionStyle[] = [
  'karaoke',
  'bold',
  'pop',
  'subtle',
  'bar',
  'typeout',
];

export interface CaptionLine {
  /** Clip-local start/end in milliseconds. */
  startMs: number;
  endMs: number;
  /** Words composing this line, in order. */
  words: WordTiming[];
  /** Joined text for quick rendering. */
  text: string;
}

/** Group word timings into caption lines. Targets ~3–5 words per line
 *  with a soft break on pauses > pauseMs or when the line gets too
 *  long. Returns an empty array if the clip has no transcript. */
export function lineifyClip(clip: Clip, opts?: {
  maxWordsPerLine?: number;
  pauseMs?: number;
  maxLineMs?: number;
}): CaptionLine[] {
  const maxWords = opts?.maxWordsPerLine ?? 5;
  const pauseMs = opts?.pauseMs ?? 350;
  const maxLineMs = opts?.maxLineMs ?? 2500;

  if (!clip.transcript_words) return [];
  let words: WordTiming[];
  try {
    const parsed = JSON.parse(clip.transcript_words) as WordTiming[];
    words = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
  if (words.length === 0) return [];

  const lines: CaptionLine[] = [];
  let cur: WordTiming[] = [];

  const flush = () => {
    if (cur.length === 0) return;
    const startMs = Math.round(cur[0].s * 1000);
    const endMs = Math.round(cur[cur.length - 1].e * 1000);
    lines.push({
      startMs,
      endMs,
      words: cur,
      text: cur.map((w) => w.w).join(' '),
    });
    cur = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    // Break on long pauses between this word and the previous one.
    if (prev && (w.s - prev.e) * 1000 > pauseMs) {
      flush();
    }
    cur.push(w);
    if (cur.length >= maxWords) {
      flush();
      continue;
    }
    // Break on long line-spans so a sustained sentence doesn't sit on
    // screen for too long.
    if (
      cur.length > 0 &&
      (cur[cur.length - 1].e - cur[0].s) * 1000 > maxLineMs
    ) {
      flush();
    }
  }
  flush();

  return lines;
}

/** Build the composed-timeline view of every project clip's captions:
 *  lines remapped from clip-local time into global timeline ms.
 *  `cumulativeMs[i]` is the composed start of clips[i]. */
export function lineifyProject(
  clips: Clip[],
  cumulativeMs: number[]
): CaptionLine[] {
  const out: CaptionLine[] = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const inMs = c.in_ms ?? 0;
    const compStart = cumulativeMs[i] ?? 0;
    const lines = lineifyClip(c);
    for (const ln of lines) {
      const localStart = ln.startMs;
      const localEnd = ln.endMs;
      // Drop the line if it falls outside the clip's trim window.
      const outMs = c.out_ms ?? c.duration_ms;
      if (localEnd < inMs || localStart > outMs) continue;
      const clampedLocalStart = Math.max(localStart, inMs);
      const clampedLocalEnd = Math.min(localEnd, outMs);
      const words = ln.words
        .filter((w) => w.e * 1000 >= inMs && w.s * 1000 <= outMs)
        .map((w) => ({
          ...w,
          s: (compStart + (Math.max(w.s * 1000, inMs) - inMs)) / 1000,
          e: (compStart + (Math.min(w.e * 1000, outMs) - inMs)) / 1000,
        }));
      out.push({
        startMs: compStart + (clampedLocalStart - inMs),
        endMs: compStart + (clampedLocalEnd - inMs),
        words,
        text: words.map((w) => w.w).join(' '),
      });
    }
  }
  return out;
}

/** Active line for a given composed-timeline ms, or null if no caption
 *  is on at that moment. */
export function activeLineAt(
  lines: CaptionLine[],
  ms: number
): CaptionLine | null {
  for (const l of lines) {
    if (ms >= l.startMs && ms <= l.endMs) return l;
  }
  return null;
}
