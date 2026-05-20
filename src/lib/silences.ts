/**
 * Cut Silences: analyze transcript_words and propose head/tail trims
 * for each clip. The editor shows these proposals as red highlights
 * on each clip cell and gates the actual commit behind an explicit
 * Accept — so a wrong tolerance value can't blow away the user's edit.
 *
 * Conservative defaults: only flags gaps > pauseMs and never proposes
 * a residual clip shorter than 300ms.
 *
 * A future pass can do full silence-split: split the clip at each long
 * internal silence into N segments, leaving the gaps out of the
 * composition. v1 sticks to head/tail because internal cuts would
 * require restructuring the timeline.
 */

import { setClipTrim } from './repo';
import type { Clip, WordTiming } from './types';

/** What Cut Silences proposes to do to one clip. Always returned in
 *  CLIP-LOCAL milliseconds (matches in_ms / out_ms semantics). */
export interface SilenceProposal {
  clipId: string;
  /** The clip's current trim before we touch it. */
  curIn: number;
  curOut: number;
  /** Proposed new trim. */
  newIn: number;
  newOut: number;
  /** How much of the head we'd remove (curIn..newIn). 0 if none. */
  headRemovedMs: number;
  /** How much of the tail we'd remove (newOut..curOut). 0 if none. */
  tailRemovedMs: number;
}

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

/** Compute a per-clip proposal: head silence before the first word and
 *  tail silence after the last word, trimmed if > pauseMs. Keeps a
 *  100ms breath around speech and refuses to shrink a clip below
 *  300ms. Returns null when the clip has no transcript. */
export function proposeForClip(
  clip: Clip,
  pauseMs = 500
): SilenceProposal | null {
  const words = parseWords(clip.transcript_words);
  if (words.length === 0) return null;
  const curIn = clip.in_ms ?? 0;
  const curOut = clip.out_ms ?? clip.duration_ms;
  const firstStart = Math.round(words[0].s * 1000);
  const lastEnd = Math.round(words[words.length - 1].e * 1000);

  let newIn = curIn;
  let newOut = curOut;
  let headRemoved = 0;
  let tailRemoved = 0;

  if (firstStart - curIn > pauseMs) {
    const adj = firstStart - 100; // keep 100ms breath
    if (adj > newIn && newOut - adj > 300) {
      headRemoved = adj - newIn;
      newIn = adj;
    }
  }
  if (curOut - lastEnd > pauseMs) {
    const adj = lastEnd + 100;
    if (adj < newOut && adj - newIn > 300) {
      tailRemoved = newOut - adj;
      newOut = adj;
    }
  }

  return {
    clipId: clip.id,
    curIn,
    curOut,
    newIn,
    newOut,
    headRemovedMs: headRemoved,
    tailRemovedMs: tailRemoved,
  };
}

/** Compute proposals for every clip in the project. Returns only the
 *  proposals where SOMETHING would change so the UI can iterate them
 *  without filtering. */
export function analyzeProjectSilences(
  clips: Clip[],
  pauseMs = 500
): SilenceProposal[] {
  const out: SilenceProposal[] = [];
  for (const c of clips) {
    const p = proposeForClip(c, pauseMs);
    if (!p) continue;
    if (p.headRemovedMs === 0 && p.tailRemovedMs === 0) continue;
    out.push(p);
  }
  return out;
}

/** Commit a set of proposals. */
export async function applySilenceProposals(
  proposals: SilenceProposal[]
): Promise<CutSilencesResult> {
  let totalRemoved = 0;
  let trimmed = 0;
  for (const p of proposals) {
    const removed = p.headRemovedMs + p.tailRemovedMs;
    if (removed <= 0) continue;
    await setClipTrim(p.clipId, p.newIn, p.newOut);
    totalRemoved += removed;
    trimmed += 1;
  }
  return { removedMs: totalRemoved, trimmedClips: trimmed };
}

/** Backwards-compatible one-shot: analyze + apply. Kept so older
 *  callers (and tests) don't have to thread proposals manually. */
export async function cutSilencesInProject(
  clips: Clip[],
  pauseMs = 500
): Promise<CutSilencesResult> {
  return applySilenceProposals(analyzeProjectSilences(clips, pauseMs));
}
