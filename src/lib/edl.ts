/**
 * EditDecisionList (EDL): the render-target-agnostic description of a cut.
 *
 * Nothing here names FFmpeg, AVFoundation, or a server. The renderer is a
 * pure function of (Edl, source files, music manifest). This is what lets the
 * timeline UI be built before the export path is wired, and lets the v2
 * on-device fast path drop in with zero schema changes.
 *
 * v1 only populates the `video` track + (optionally) one caption preset.
 * `speed`, `transitionOut`, `overlays`, and `audio` fields exist in the schema
 * for forward-compat but are unused by the v1 UI/worker.
 *
 * See design doc: rahulpeesa-main-design-20260518-*.md (EDL Data Model).
 */

/** Bump when the EDL shape changes. The read path migrates < CURRENT and
 *  discards-and-rebuilds anything missing/unknown/> CURRENT (never crash,
 *  never clobber with a partial). */
export const EDL_VERSION = 1 as const;

export type CaptionPreset = 'caption-bold' | 'caption-block';
export type TransitionType = 'xfade';

export interface Transition {
  type: TransitionType;
  durMs: number;
}

/** One segment of one source clip on the timeline. A "split" is two entries
 *  with the same clipId and adjacent, non-overlapping [inMs,outMs) ranges. */
export interface VideoEntry {
  clipId: string;
  /** Clip-relative trim start, ms. */
  inMs: number;
  /** Clip-relative trim end, ms (exclusive). */
  outMs: number;
  /** 1.0 = realtime. v1 always 1.0. */
  speed: number;
  /** Only valid on a boundary between entries with *different* clipId.
   *  Null on a split boundary (same clipId) and in all of v1. */
  transitionOut: Transition | null;
}

export interface TextOverlay {
  type: 'text';
  text: string;
  /** Timeline-relative, ms. */
  startMs: number;
  endMs: number;
  /** Normalized 0..1 anchor in the frame. */
  x: number;
  y: number;
  preset: CaptionPreset;
}

export interface MusicTrack {
  type: 'music';
  /** Resolves against the bundled music manifest (v1.1). */
  assetId: string;
  /** Timeline-relative start, ms. */
  startMs: number;
  gainDb: number;
  duckUnderSpeech: boolean;
}

export interface Edl {
  version: typeof EDL_VERSION;
  tracks: {
    video: VideoEntry[];
    overlays: TextOverlay[];
    audio: MusicTrack[];
  };
}

/** An empty but valid EDL (no clips survived the auto-cut, or a fresh edit). */
export function emptyEdl(): Edl {
  return { version: EDL_VERSION, tracks: { video: [], overlays: [], audio: [] } };
}
