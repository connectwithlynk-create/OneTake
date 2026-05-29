// Project-scoped edit timeline, persisted as JSON on `projects.timeline_json`.
//
// The clips table holds recordings (raw media + analysis: file_uri, duration,
// transcript_words, verdict/tag). The editor never mutates those rows. Edit
// operations (trim, split, reorder, volume, effects, delete, exclude) live in
// the timeline instead — a row per occurrence on the timeline, referencing a
// source clip by id. Splits and duplicates just produce new timeline rows
// pointing at the same source.

import { getDb } from './db';
import { id as newId } from './id';
import { listClips } from './repo';
import type { Clip, ClipTag, SyncStatus, Verdict } from './types';

/** Persisted shape — what lives in `projects.timeline_json`. */
export interface TimelineRow {
  /** Stable id for this timeline occurrence. NOT a clips.id. */
  id: string;
  /** Recording this row pulls media from (→ clips.id). */
  source_clip_id: string;
  in_ms: number | null;
  out_ms: number | null;
  audio_volume: number;
  mirrored: number; // 0 | 1
  excluded: number; // 0 | 1
  audio_detached: number; // 0 | 1
  effects_json: string | null;
}

interface TimelineJson {
  version: 1;
  rows: TimelineRow[];
}

/** A timeline row joined with read-only metadata from its source clip.
 *  Shape-compatible with `Clip` so existing helpers (lineifyProject,
 *  getEffects, captions, etc.) keep working unchanged. */
export interface TimelineClip extends TimelineRow {
  project_id: string;
  file_uri: string;
  duration_ms: number;
  transcript_words: string | null;
  transcript: string | null;
  name: string | null;
  verdict: Verdict;
  tag: ClipTag;
  meta_tags: string | null;
  verdict_overridden: number;
  tag_overridden: number;
  order_index: number;
  created_at: number;
  expires_at: number | null;
  remote_path: string | null;
  owner: string | null;
  updated_at: number;
  sync_status: SyncStatus;
}

/** Read the project's timeline. On first open of a project (no
 *  timeline_json yet) the timeline is seeded from the project's
 *  recordings in their order_index order, and the seed is written so
 *  subsequent opens are stable. */
export async function loadTimeline(projectId: string): Promise<TimelineRow[]> {
  const db = await getDb();
  const projRow = await db.getFirstAsync<{ timeline_json: string | null }>(
    'SELECT timeline_json FROM projects WHERE id = ?',
    projectId
  );

  if (projRow?.timeline_json) {
    try {
      const parsed = JSON.parse(projRow.timeline_json) as TimelineJson;
      if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
    } catch {
      /* fall through to reseed */
    }
  }

  const clips = await listClips(projectId);
  const seeded = clips.map(rowFromClip);
  // Persist the seed so a deletion on the timeline doesn't get
  // un-deleted by a re-seed on next open.
  await saveTimeline(projectId, seeded);
  return seeded;
}

/** Persist a list of timeline rows. Order is array order. */
export async function saveTimeline(
  projectId: string,
  rows: TimelineRow[]
): Promise<void> {
  const db = await getDb();
  const json: TimelineJson = { version: 1, rows };
  await db.runAsync(
    'UPDATE projects SET timeline_json = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(json),
    Date.now(),
    projectId
  );
}

/** Build a fresh timeline row from a freshly-imported / recorded clip. */
export function rowFromClip(c: Clip): TimelineRow {
  return {
    id: newId(),
    source_clip_id: c.id,
    in_ms: c.in_ms,
    out_ms: c.out_ms,
    audio_volume: c.audio_volume ?? 1,
    mirrored: c.mirrored === 1 ? 1 : 0,
    excluded: c.excluded === 1 ? 1 : 0,
    audio_detached: c.audio_detached === 1 ? 1 : 0,
    effects_json: c.effects_json,
  };
}

/** Hydrate a row with the latest source-clip metadata. Drop the row
 *  (caller's responsibility — returns null) if the source recording is
 *  gone, since there's nothing to play. */
export function hydrate(row: TimelineRow, src: Clip): TimelineClip {
  return {
    ...row,
    project_id: src.project_id,
    file_uri: src.file_uri,
    duration_ms: src.duration_ms,
    transcript_words: src.transcript_words,
    transcript: src.transcript,
    name: src.name,
    verdict: src.verdict,
    tag: src.tag,
    meta_tags: src.meta_tags,
    verdict_overridden: src.verdict_overridden,
    tag_overridden: src.tag_overridden,
    order_index: src.order_index,
    created_at: src.created_at,
    expires_at: src.expires_at,
    remote_path: src.remote_path,
    owner: src.owner,
    updated_at: src.updated_at,
    sync_status: src.sync_status,
  };
}

/** Split a hydrated timeline clip into two rows at the given local
 *  offset (relative to the clip's effective in_ms). Both rows reference
 *  the same source recording. */
export function splitRow(
  c: TimelineClip,
  atLocalMs: number
): [TimelineRow, TimelineRow] | null {
  const inMs = c.in_ms ?? 0;
  const outMs = c.out_ms ?? c.duration_ms;
  const cut = inMs + Math.max(1, Math.min(atLocalMs, outMs - inMs - 1));
  if (cut <= inMs || cut >= outMs) return null;
  const left: TimelineRow = {
    id: c.id, // keep the left half's id stable so selection survives
    source_clip_id: c.source_clip_id,
    in_ms: inMs,
    out_ms: cut,
    audio_volume: c.audio_volume,
    mirrored: c.mirrored,
    excluded: c.excluded,
    audio_detached: c.audio_detached,
    effects_json: c.effects_json,
  };
  const right: TimelineRow = {
    id: newId(),
    source_clip_id: c.source_clip_id,
    in_ms: cut,
    out_ms: outMs,
    audio_volume: c.audio_volume,
    mirrored: c.mirrored,
    excluded: c.excluded,
    audio_detached: c.audio_detached,
    effects_json: c.effects_json,
  };
  return [left, right];
}

/** Apply a partial patch to a row, producing a new row (immutable). */
export function patchRow(r: TimelineRow, patch: Partial<TimelineRow>): TimelineRow {
  return { ...r, ...patch };
}
