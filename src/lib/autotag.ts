import type { ClipTag, MetaTag } from './types';

/**
 * Auto-naming and advanced auto-tagging.
 *
 * MVP heuristic stub. Real implementation (PRD) would derive these from the
 * transcript + a vision model. This produces stable, plausible names and
 * descriptive tags deterministically from the clip id so the UX (auto names,
 * discreet b-roll tags) is fully exercisable without AI. Swap this module
 * out, not its callers - same contract as rating.ts.
 */

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const LOCATIONS = [
  'kitchen',
  'desk',
  'outdoors',
  'studio',
  'street',
  'cafe',
  'car',
];
const ACTIONS = [
  'typing',
  'walking',
  'cooking',
  'unboxing',
  'pointing',
  'demoing',
  'driving',
];
const SUBJECTS = [
  'product',
  'hands',
  'screen',
  'scenery',
  'face',
  'whiteboard',
  'food',
];

function pick(arr: string[], n: number): string {
  return arr[n % arr.length];
}

/** Talking clips get no descriptive tags; b-roll gets location/action/subject. */
export function autoMetaTags(clipId: string, tag: ClipTag): MetaTag[] {
  if (tag !== 'broll') return [];
  const h = hash(clipId);
  return [
    { kind: 'location', value: pick(LOCATIONS, h) },
    { kind: 'action', value: pick(ACTIONS, h >> 3) },
    { kind: 'subject', value: pick(SUBJECTS, h >> 6) },
  ];
}

/** "Talking 2" / "B-roll · kitchen". seqAmongTag is 1-based. */
export function autoName(
  tag: ClipTag,
  seqAmongTag: number,
  meta: MetaTag[]
): string {
  if (tag === 'talking') return `Talking ${seqAmongTag}`;
  const subj = meta.find((m) => m.kind === 'subject')?.value;
  const loc = meta.find((m) => m.kind === 'location')?.value;
  const label = subj ?? loc;
  return label ? `B-roll · ${label}` : `B-roll ${seqAmongTag}`;
}

export function parseMeta(json: string | null): MetaTag[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as MetaTag[]) : [];
  } catch {
    return [];
  }
}

export function stringifyMeta(tags: MetaTag[]): string {
  return JSON.stringify(tags);
}
