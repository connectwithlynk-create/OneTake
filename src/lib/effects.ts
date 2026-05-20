/**
 * Helpers for the per-clip ClipEffects bag (stored as JSON in
 * clips.effects_json) and similar JSON blobs on projects/overlays.
 *
 * Treat the JSON as additive: a missing key means "use the default";
 * a present key (even 0 / false) is an explicit setting.
 */

import { getDb } from './db';
import type {
  ClipEffects,
  Clip,
  OverlayKeyframe,
  ProjectTransition,
} from './types';

/** Parse a JSON blob into a typed object. Returns the fallback on any
 *  read / parse error so a corrupt write can't brick the editor. */
function readJson<T extends object>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getEffects(c: Clip): ClipEffects {
  return readJson<ClipEffects>(c.effects_json, {});
}

/** Default values for a sliders panel that wants concrete numbers. */
export const EFFECT_DEFAULTS = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  sharpness: 0,
  warmth: 0,
  shadows: 0,
  highlights: 0,
} as const;

export async function patchClipEffects(
  clipId: string,
  patch: Partial<ClipEffects>
): Promise<ClipEffects> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ effects_json: string | null }>(
    'SELECT effects_json FROM clips WHERE id = ?',
    clipId
  );
  const merged: ClipEffects = {
    ...readJson<ClipEffects>(row?.effects_json, {}),
    ...patch,
  };
  await db.runAsync(
    'UPDATE clips SET effects_json = ? WHERE id = ?',
    JSON.stringify(merged),
    clipId
  );
  await db.runAsync(
    "UPDATE clips SET updated_at = ?, sync_status = 'local' WHERE id = ?",
    Date.now(),
    clipId
  );
  return merged;
}

/** Filter presets that the Filters panel exposes. Each preset is just a
 *  bundle of ClipEffects values; selecting one overwrites the listed
 *  fields and sets filterPreset for the active highlight. */
export const FILTER_PRESETS: Record<
  string,
  { label: string; effects: Partial<ClipEffects> }
> = {
  none: { label: 'Original', effects: { brightness: 0, contrast: 1, saturation: 1, warmth: 0, shadows: 0, highlights: 0 } },
  film: { label: 'Film', effects: { contrast: 1.15, saturation: 0.92, warmth: 0.2, shadows: -0.1, highlights: -0.05 } },
  noir: { label: 'Noir', effects: { contrast: 1.35, saturation: 0, warmth: -0.05, shadows: -0.15, highlights: 0.05 } },
  vintage: { label: 'Vintage', effects: { contrast: 0.95, saturation: 0.7, warmth: 0.3, shadows: 0.15, highlights: -0.1 } },
  vivid: { label: 'Vivid', effects: { contrast: 1.18, saturation: 1.35, warmth: 0.0, shadows: 0, highlights: 0 } },
  cool: { label: 'Cool', effects: { warmth: -0.25, saturation: 1.05, contrast: 1.05, shadows: -0.05, highlights: 0.05 } },
  warm: { label: 'Warm', effects: { warmth: 0.3, saturation: 1.05, contrast: 1.0, shadows: 0.05, highlights: -0.02 } },
  fade: { label: 'Fade', effects: { contrast: 0.8, saturation: 0.85, shadows: 0.2, highlights: 0.1 } },
  punch: { label: 'Punch', effects: { contrast: 1.25, saturation: 1.2, shadows: -0.1, highlights: 0.1 } },
  bw: { label: 'B&W', effects: { saturation: 0, contrast: 1.2 } },
};

export function applyFilterPreset(
  clipId: string,
  presetId: keyof typeof FILTER_PRESETS
): Promise<ClipEffects> {
  const p = FILTER_PRESETS[presetId];
  return patchClipEffects(clipId, { ...p.effects, filterPreset: presetId });
}

// --- Overlay keyframes ---------------------------------------------

export function getKeyframes(raw: string | null): OverlayKeyframe[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as OverlayKeyframe[]) : [];
  } catch {
    return [];
  }
}

/** Linear interp between adjacent keyframes for the given composed-
 *  timeline ms. Returns the static x/y/scale/rotation that should be
 *  applied at time t. */
export function interpKeyframes(
  kfs: OverlayKeyframe[],
  tMs: number,
  fallback: { x: number; y: number; scale: number; rotation: number }
): { x: number; y: number; scale: number; rotation: number } {
  if (kfs.length === 0) return fallback;
  // Sort defensively — UI ought to keep them sorted but be safe.
  const sorted = [...kfs].sort((a, b) => a.tMs - b.tMs);
  if (tMs <= sorted[0].tMs) {
    return {
      x: sorted[0].x ?? fallback.x,
      y: sorted[0].y ?? fallback.y,
      scale: sorted[0].scale ?? fallback.scale,
      rotation: sorted[0].rotation ?? fallback.rotation,
    };
  }
  if (tMs >= sorted[sorted.length - 1].tMs) {
    const last = sorted[sorted.length - 1];
    return {
      x: last.x ?? fallback.x,
      y: last.y ?? fallback.y,
      scale: last.scale ?? fallback.scale,
      rotation: last.rotation ?? fallback.rotation,
    };
  }
  // Find the bracketing pair and interp.
  let a = sorted[0];
  let b = sorted[1];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (tMs >= sorted[i].tMs && tMs <= sorted[i + 1].tMs) {
      a = sorted[i];
      b = sorted[i + 1];
      break;
    }
  }
  const span = Math.max(1, b.tMs - a.tMs);
  const u = (tMs - a.tMs) / span;
  const mix = (av: number | undefined, bv: number | undefined, def: number) =>
    (av ?? def) + ((bv ?? def) - (av ?? def)) * u;
  return {
    x: mix(a.x, b.x, fallback.x),
    y: mix(a.y, b.y, fallback.y),
    scale: mix(a.scale, b.scale, fallback.scale),
    rotation: mix(a.rotation, b.rotation, fallback.rotation),
  };
}

export async function setOverlayKeyframes(
  overlayId: string,
  kfs: OverlayKeyframe[]
) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE overlays SET keyframes_json = ? WHERE id = ?',
    kfs.length === 0 ? null : JSON.stringify(kfs),
    overlayId
  );
  await db.runAsync(
    "UPDATE overlays SET updated_at = ?, sync_status = 'local' WHERE id = ?",
    Date.now(),
    overlayId
  );
}

// --- Project transitions + beats ----------------------------------

export function getTransitions(raw: string | null): Record<number, ProjectTransition> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<number, ProjectTransition>) : {};
  } catch {
    return {};
  }
}

export async function setTransition(
  projectId: string,
  boundaryIndex: number,
  t: ProjectTransition | null
) {
  const db = await getDb();
  const row = await db.getFirstAsync<{ transitions_json: string | null }>(
    'SELECT transitions_json FROM projects WHERE id = ?',
    projectId
  );
  const cur = getTransitions(row?.transitions_json ?? null);
  if (t === null || t.kind === 'none') {
    delete cur[boundaryIndex];
  } else {
    cur[boundaryIndex] = t;
  }
  const blob = Object.keys(cur).length === 0 ? null : JSON.stringify(cur);
  await db.runAsync(
    'UPDATE projects SET transitions_json = ? WHERE id = ?',
    blob,
    projectId
  );
  await db.runAsync(
    "UPDATE projects SET updated_at = ?, sync_status = 'local' WHERE id = ?",
    Date.now(),
    projectId
  );
}

export function getBeats(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

export async function setBeats(projectId: string, beats: number[]) {
  const db = await getDb();
  const dedup = Array.from(new Set(beats.map((n) => Math.round(n)))).sort(
    (a, b) => a - b
  );
  await db.runAsync(
    'UPDATE projects SET beats_json = ? WHERE id = ?',
    dedup.length === 0 ? null : JSON.stringify(dedup),
    projectId
  );
  await db.runAsync(
    "UPDATE projects SET updated_at = ?, sync_status = 'local' WHERE id = ?",
    Date.now(),
    projectId
  );
}
