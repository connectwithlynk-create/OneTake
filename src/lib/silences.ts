/**
 * Cut Silences: analyze transcript_words and tighten each clip by
 * trimming long quiet gaps. Conservative — only trims gaps > 500ms and
 * never reduces a clip below 300ms.
 *
 * Strategy for v1: instead of splitting a clip into N pieces (which
 * would clutter the timeline), find the largest internal silence and
 * trim the clip's in/out to skip past either head or tail silence
 * first; surface a count of removed silences for the user.
 *
 * A future pass can do full silence-split: split the clip at each long
 * silence into N segments, leaving the gaps out of the composition.
 */

import { setClipTrim } from './repo';
import type { Clip, WordTiming } from './types';

export interface CutSilencesResult {
  removedMs: number;
  trimmedClips: number;
}

function parseWords(raw: string | null): WordTiming[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as WordTiming[]) : [];
  } catch {
    return [];
  }
}

/** For one clip: find the head silence (before the first word) and
 *  the tail silence (after the last word). Trim them off if > pauseMs.
 *  Returns the new in/out (clip-local ms). */
export function tightenHeadTail(
  clip: Clip,
  pauseMs = 500
): { newIn: number; newOut: number; removed: number } | null {
  const words = parseWords(clip.transcript_words);
  if (words.length === 0) return null;
  const curIn = clip.in_ms ?? 0;
  const curOut = clip.out_ms ?? clip.duration_ms;
  const firstStart = Math.round(words[0].s * 1000);
  const lastEnd = Math.round(words[words.length - 1].e * 1000);

  let newIn = curIn;
  let newOut = curOut;
  let removed = 0;

  if (firstStart - curIn > pauseMs) {
    const adj = firstStart - 100; // keep 100ms breath
    if (adj > newIn && newOut - adj > 300) {
      removed += adj - newIn;
      newIn = adj;
    }
  }
  if (curOut - lastEnd > pauseMs) {
    const adj = lastEnd + 100;
    if (adj < newOut && adj - newIn > 300) {
      removed += newOut - adj;
      newOut = adj;
    }
  }

  if (removed === 0) return null;
  return { newIn, newOut, removed };
}

export async function cutSilencesInProject(
  clips: Clip[],
  pauseMs = 500
): Promise<CutSilencesResult> {
  let totalRemoved = 0;
  let trimmed = 0;
  for (const c of clips) {
    const r = tightenHeadTail(c, pauseMs);
    if (r) {
      await setClipTrim(c.id, r.newIn, r.newOut);
      totalRemoved += r.removed;
      trimmed += 1;
    }
  }
  return { removedMs: totalRemoved, trimmedClips: trimmed };
}
