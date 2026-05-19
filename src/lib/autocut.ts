/**
 * Deterministic auto-cut: Clip[] -> initial Edl.
 *
 * This is the headline feature ("open the editor and it already edited
 * itself"). It MUST be deterministic and pure: same clips in, byte-identical
 * EDL out, no I/O, no Date.now(), no mutation of the input array.
 *
 * Algorithm (design doc: "Auto-cut algorithm"):
 *   1. Drop clips where verdict === 'dud' AND verdict_overridden === 0.
 *      A user-overridden dud is KEPT (respects manual intent).
 *   2. Drop clips where excluded === 1 (existing manual-edit signal).
 *   3. Partition survivors into 'talking' and 'broll' by tag.
 *   4. Order: all talking first, then all broll. Within each group sort by
 *      order_index asc, tie-break created_at asc, final tie-break id asc
 *      (guarantees a total order so the output is fully deterministic even
 *      when order_index and created_at both collide).
 *   5. v1 does NOT reorder by verdict. verdict only gates inclusion, not
 *      order, so the captured narrative stays coherent. Documented here so a
 *      future change is a conscious decision, not a silent "improvement".
 *   6. Each surviving clip -> one VideoEntry: inMs=0, outMs=duration_ms,
 *      speed=1.0, transitionOut=null. No overlays, no audio.
 */

import type { Clip } from './types';
import { emptyEdl, type Edl, type VideoEntry } from './edl';

function survives(c: Clip): boolean {
  if (c.excluded === 1) return false;
  if (c.verdict === 'dud' && c.verdict_overridden === 0) return false;
  return true;
}

/** Total-order comparator within a tag group. */
function byCaptureOrder(a: Clip, b: Clip): number {
  if (a.order_index !== b.order_index) return a.order_index - b.order_index;
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toVideoEntry(c: Clip): VideoEntry {
  return {
    clipId: c.id,
    inMs: 0,
    outMs: c.duration_ms,
    speed: 1.0,
    transitionOut: null,
  };
}

/**
 * Build the initial cut. Pure: does not mutate `clips`.
 * Empty input (or nothing survives) returns a valid empty EDL.
 */
export function buildAutoCut(clips: Clip[]): Edl {
  const kept = clips.filter(survives);

  const talking = kept
    .filter((c) => c.tag === 'talking')
    .slice()
    .sort(byCaptureOrder);
  const broll = kept
    .filter((c) => c.tag === 'broll')
    .slice()
    .sort(byCaptureOrder);

  const video = [...talking, ...broll].map(toVideoEntry);

  if (video.length === 0) return emptyEdl();
  const edl = emptyEdl();
  edl.tracks.video = video;
  return edl;
}
