import { File } from 'expo-file-system';
import type * as SQLite from 'expo-sqlite';

import { autoMetaTags, autoName, stringifyMeta } from './autotag';
import { getDb } from './db';
import { ephemeralExpiry } from './ephemeral';
import {
  deleteClipFile,
  deleteOverlayMediaFile,
  resolveClipUri,
} from './filestore';
import { id } from './id';
import { palette } from '../theme';
import type {
  Clip,
  ClipTag,
  Collection,
  Inspiration,
  MetaTag,
  Overlay,
  OverlayKind,
  Project,
  ProjectStatus,
  ProjectType,
  ReelPlatform,
  Verdict,
} from './types';

/** Mark a row changed: bump the sync clock and flag it for the next push.
 *  `table` is always an internal constant, never user input. */
async function touch(
  db: SQLite.SQLiteDatabase,
  table: 'projects' | 'clips' | 'collections' | 'inspiration' | 'overlays',
  rowId: string
) {
  await db.runAsync(
    `UPDATE ${table} SET updated_at = ?, sync_status = 'local' WHERE id = ?`,
    Date.now(),
    rowId
  );
}

// ----- Projects -----

export async function createProject(
  type: ProjectType,
  title: string,
  prompt?: string
): Promise<Project> {
  const db = await getDb();
  const now = Date.now();
  const p: Project = {
    id: id(),
    type,
    title: title.trim() || (type === 'prompt' ? 'Prompt project' : 'Untitled'),
    status: 'recording',
    prompt: prompt?.trim() || null,
    created_at: now,
    owner: null,
    updated_at: now,
    sync_status: 'local',
    captions_enabled: 1,
    caption_style: 'karaoke',
    transitions_json: null,
    beats_json: null,
  };
  await db.runAsync(
    'INSERT INTO projects (id, type, title, status, prompt, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    p.id,
    p.type,
    p.title,
    p.status,
    p.prompt,
    p.created_at,
    p.updated_at,
    p.sync_status
  );
  return p;
}

/** Stable dedicated project that device-imported clips land in. */
export async function ensureImportProject(): Promise<string> {
  const db = await getDb();
  const existing = await db.getFirstAsync<Project>(
    "SELECT id FROM projects WHERE id = 'imported'"
  );
  if (existing) return 'imported';
  const now = Date.now();
  await db.runAsync(
    "INSERT INTO projects (id, type, title, status, prompt, created_at, updated_at, sync_status) VALUES ('imported','talkinghead','Imported clips','recording',NULL,?,?,'local')",
    now,
    now
  );
  return 'imported';
}

export async function listProjects(): Promise<Project[]> {
  const db = await getDb();
  return db.getAllAsync<Project>(
    'SELECT * FROM projects ORDER BY created_at DESC'
  );
}

export async function getProject(pid: string): Promise<Project | null> {
  const db = await getDb();
  return db.getFirstAsync<Project>('SELECT * FROM projects WHERE id = ?', pid);
}

export async function renameProject(pid: string, title: string) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE projects SET title = ? WHERE id = ?',
    title.trim() || 'Untitled',
    pid
  );
  await touch(db, 'projects', pid);
}

export async function setProjectStatus(pid: string, status: ProjectStatus) {
  const db = await getDb();
  await db.runAsync('UPDATE projects SET status = ? WHERE id = ?', status, pid);
  await touch(db, 'projects', pid);
}

export async function setCaptionSettings(
  pid: string,
  patch: { enabled?: 0 | 1; style?: string }
) {
  const db = await getDb();
  if (patch.enabled !== undefined) {
    await db.runAsync(
      'UPDATE projects SET captions_enabled = ? WHERE id = ?',
      patch.enabled,
      pid
    );
  }
  if (patch.style !== undefined) {
    await db.runAsync(
      'UPDATE projects SET caption_style = ? WHERE id = ?',
      patch.style,
      pid
    );
  }
  await touch(db, 'projects', pid);
}


export async function deleteProject(pid: string) {
  const db = await getDb();
  const clips = await listClips(pid);
  clips.forEach((c) => deleteClipFile(c.file_uri));
  await db.runAsync('DELETE FROM clips WHERE project_id = ?', pid);
  await db.runAsync('DELETE FROM projects WHERE id = ?', pid);
}

// ----- Clips -----

export async function addClip(
  projectId: string,
  fileUri: string,
  durationMs: number,
  verdict: Verdict,
  tag: ClipTag,
  clipId: string
): Promise<Clip> {
  const db = await getDb();
  const countRow = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) as c FROM clips WHERE project_id = ?',
    projectId
  );
  const tagCountRow = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) as c FROM clips WHERE project_id = ? AND tag = ?',
    projectId,
    tag
  );
  const now = Date.now();
  const meta = autoMetaTags(clipId, tag);
  const name = autoName(tag, (tagCountRow?.c ?? 0) + 1, meta);
  const clip: Clip = {
    id: clipId,
    project_id: projectId,
    order_index: countRow?.c ?? 0,
    file_uri: fileUri,
    duration_ms: durationMs,
    verdict,
    verdict_overridden: 0,
    tag,
    tag_overridden: 0,
    excluded: 0,
    expires_at: ephemeralExpiry(verdict),
    remote_path: null,
    created_at: now,
    owner: null,
    updated_at: now,
    sync_status: 'local',
    name,
    meta_tags: stringifyMeta(meta),
    transcript: null,
    mirrored: 0,
    in_ms: null,
    out_ms: null,
    audio_volume: 1.0,
    audio_detached: 0,
    transcript_words: null,
    effects_json: null,
  };
  await db.runAsync(
    `INSERT INTO clips
       (id, project_id, order_index, file_uri, duration_ms, verdict, verdict_overridden, tag, tag_overridden, excluded, expires_at, created_at, updated_at, sync_status, name, meta_tags, transcript, mirrored, audio_volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    clip.id,
    clip.project_id,
    clip.order_index,
    clip.file_uri,
    clip.duration_ms,
    clip.verdict,
    clip.verdict_overridden,
    clip.tag,
    clip.tag_overridden,
    clip.excluded,
    clip.expires_at,
    clip.created_at,
    clip.updated_at,
    clip.sync_status,
    clip.name,
    clip.meta_tags,
    clip.transcript,
    clip.mirrored,
    clip.audio_volume
  );
  return clip;
}

export async function listClips(projectId: string): Promise<Clip[]> {
  const db = await getDb();
  return db.getAllAsync<Clip>(
    'SELECT * FROM clips WHERE project_id = ? ORDER BY order_index ASC',
    projectId
  );
}

export type ClipWithProject = Clip & {
  project_title: string;
  project_type: string;
};

export async function listAllClips(): Promise<ClipWithProject[]> {
  const db = await getDb();
  return db.getAllAsync<ClipWithProject>(
    `SELECT c.*, p.title AS project_title, p.type AS project_type
       FROM clips c
       JOIN projects p ON p.id = c.project_id
      ORDER BY c.created_at DESC`
  );
}

export interface Analytics {
  projects: number;
  projectsByStatus: { recording: number; processing: number; ready: number };
  clips: number;
  verdicts: { dud: number; keep: number; perfect: number };
  tags: { talking: number; broll: number };
  keepers: number;
  verdictOverrideRate: number;
  tagOverrideRate: number;
  totalFootageMs: number;
  collections: number;
  reels: number;
}

export async function getAnalytics(): Promise<Analytics> {
  const db = await getDb();
  const one = async (sql: string) =>
    (await db.getFirstAsync<{ n: number }>(sql))?.n ?? 0;

  const [
    projects,
    recording,
    processing,
    ready,
    clips,
    dud,
    keep,
    perfect,
    talking,
    broll,
    vOver,
    tOver,
    footage,
    collections,
    reels,
  ] = await Promise.all([
    one('SELECT COUNT(*) n FROM projects'),
    one("SELECT COUNT(*) n FROM projects WHERE status='recording'"),
    one("SELECT COUNT(*) n FROM projects WHERE status='processing'"),
    one("SELECT COUNT(*) n FROM projects WHERE status='ready'"),
    one('SELECT COUNT(*) n FROM clips'),
    one("SELECT COUNT(*) n FROM clips WHERE verdict='dud'"),
    one("SELECT COUNT(*) n FROM clips WHERE verdict='keep'"),
    one("SELECT COUNT(*) n FROM clips WHERE verdict='perfect'"),
    one("SELECT COUNT(*) n FROM clips WHERE tag='talking'"),
    one("SELECT COUNT(*) n FROM clips WHERE tag='broll'"),
    one('SELECT COUNT(*) n FROM clips WHERE verdict_overridden=1'),
    one('SELECT COUNT(*) n FROM clips WHERE tag_overridden=1'),
    one('SELECT COALESCE(SUM(duration_ms),0) n FROM clips'),
    one('SELECT COUNT(*) n FROM collections'),
    one("SELECT COUNT(*) n FROM inspiration WHERE collection_id != ''"),
  ]);

  return {
    projects,
    projectsByStatus: { recording, processing, ready },
    clips,
    verdicts: { dud, keep, perfect },
    tags: { talking, broll },
    keepers: keep + perfect,
    verdictOverrideRate: clips ? vOver / clips : 0,
    tagOverrideRate: clips ? tOver / clips : 0,
    totalFootageMs: footage,
    collections,
    reels,
  };
}

export async function setVerdict(clipId: string, verdict: Verdict) {
  const db = await getDb();
  // Re-rating drives ephemerality: dud => expires, keep/perfect => saved.
  await db.runAsync(
    'UPDATE clips SET verdict = ?, verdict_overridden = 1, expires_at = ? WHERE id = ?',
    verdict,
    ephemeralExpiry(verdict),
    clipId
  );
  await touch(db, 'clips', clipId);
}

export async function setTag(clipId: string, tag: ClipTag) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET tag = ?, tag_overridden = 1 WHERE id = ?',
    tag,
    clipId
  );
  await touch(db, 'clips', clipId);
}

/** Drop clip rows whose source file no longer exists on disk. Called
 *  on editor mount as a self-heal so a previously-buggy deleteClip
 *  (which orphaned files referenced by splits / duplicates) doesn't
 *  brick the editor forever. Returns the number of rows removed. */
export async function pruneMissingClips(projectId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; file_uri: string }>(
    'SELECT id, file_uri FROM clips WHERE project_id = ?',
    projectId
  );
  let removed = 0;
  for (const r of rows) {
    if (!r.file_uri) {
      await db.runAsync('DELETE FROM clips WHERE id = ?', r.id);
      removed += 1;
      continue;
    }
    // Use expo-file-system synchronously via the same resolver the
    // native player would. If the file doesn't exist, the clip is
    // unplayable and can't recover; drop the row.
    let exists = false;
    try {
      exists = new File(resolveClipUri(r.file_uri)).exists;
    } catch {
      exists = false;
    }
    if (!exists) {
      await db.runAsync('DELETE FROM clips WHERE id = ?', r.id);
      // Cascade-drop any subject overlay pointing at this clip too.
      await db.runAsync(
        "DELETE FROM overlays WHERE source_clip_id = ? AND kind = 'subject'",
        r.id
      );
      removed += 1;
    }
  }
  return removed;
}

export async function deleteClip(clipId: string, fileUri: string) {
  const db = await getDb();
  // Drop the row first so the reference count we read next doesn't
  // include this clip.
  await db.runAsync('DELETE FROM clips WHERE id = ?', clipId);
  // Cascade: cutout's subject overlay shares the source's file_uri.
  await db.runAsync(
    "DELETE FROM overlays WHERE source_clip_id = ? AND kind = 'subject'",
    clipId
  );
  // Only delete the underlying file when nothing else references it.
  // Splits + duplicates produce multiple clip rows that point at the
  // same file_uri; killing the file too early breaks the surviving
  // clips with a "video failed to load" the next time the editor
  // opens. Subject overlays and audio-only / media overlays may also
  // reference the file.
  const clipRefs = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM clips WHERE file_uri = ?',
    fileUri
  );
  const overlayRefs = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM overlays WHERE file_uri = ?',
    fileUri
  );
  if ((clipRefs?.c ?? 0) === 0 && (overlayRefs?.c ?? 0) === 0) {
    deleteClipFile(fileUri);
  }
}

export async function setClipMetaTags(clipId: string, tags: MetaTag[]) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET meta_tags = ? WHERE id = ?',
    stringifyMeta(tags),
    clipId
  );
  await touch(db, 'clips', clipId);
}

export async function getClip(clipId: string): Promise<Clip | null> {
  const db = await getDb();
  return db.getFirstAsync<Clip>('SELECT * FROM clips WHERE id = ?', clipId);
}

export async function setClipTrim(
  clipId: string,
  inMs: number | null,
  outMs: number | null
) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET in_ms = ?, out_ms = ? WHERE id = ?',
    inMs,
    outMs,
    clipId
  );
  await touch(db, 'clips', clipId);
}

export async function setClipVolume(clipId: string, volume: number) {
  const db = await getDb();
  const v = Math.max(0, Math.min(1, volume));
  await db.runAsync(
    'UPDATE clips SET audio_volume = ? WHERE id = ?',
    v,
    clipId
  );
  await touch(db, 'clips', clipId);
}

export async function setClipAudioDetached(clipId: string, detached: 0 | 1) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET audio_detached = ? WHERE id = ?',
    detached,
    clipId
  );
  await touch(db, 'clips', clipId);
}

export async function setClipTranscriptWords(clipId: string, wordsJson: string) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET transcript_words = ? WHERE id = ?',
    wordsJson,
    clipId
  );
  await touch(db, 'clips', clipId);
}

/**
 * Split a clip in two at a local offset (ms within the *effective* clip,
 * measured from the current in_ms). Both halves keep the same source file;
 * we just adjust in_ms / out_ms and insert a new row. order_index of all
 * subsequent clips in the project is bumped by 1. Returns the new clip id,
 * or null if the split would leave either half shorter than 200ms.
 */
export async function splitClipAt(
  clipId: string,
  atLocalMs: number
): Promise<string | null> {
  const db = await getDb();
  const c = await db.getFirstAsync<Clip>(
    'SELECT * FROM clips WHERE id = ?',
    clipId
  );
  if (!c) return null;
  const inMs = c.in_ms ?? 0;
  const outMs = c.out_ms ?? c.duration_ms;
  const splitAbs = Math.round(inMs + Math.max(0, atLocalMs));
  if (splitAbs <= inMs + 200) return null;
  if (splitAbs >= outMs - 200) return null;
  const now = Date.now();
  const newId = id();
  await db.withTransactionAsync(async () => {
    // shift subsequent clips down by one to make room
    await db.runAsync(
      "UPDATE clips SET order_index = order_index + 1, updated_at = ?, sync_status = 'local' WHERE project_id = ? AND order_index > ?",
      now,
      c.project_id,
      c.order_index
    );
    // insert the second half (carries the same media, takes splitAbs..outMs)
    await db.runAsync(
      `INSERT INTO clips
         (id, project_id, order_index, file_uri, duration_ms, verdict, verdict_overridden, tag, tag_overridden, excluded, expires_at, created_at, updated_at, sync_status, name, meta_tags, transcript, mirrored, in_ms, out_ms, audio_volume, audio_detached, transcript_words)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId,
      c.project_id,
      c.order_index + 1,
      c.file_uri,
      c.duration_ms,
      c.verdict,
      c.verdict_overridden,
      c.tag,
      c.tag_overridden,
      c.excluded,
      c.expires_at,
      now,
      now,
      'local',
      c.name,
      c.meta_tags,
      c.transcript,
      c.mirrored,
      splitAbs,
      outMs,
      c.audio_volume,
      c.audio_detached,
      c.transcript_words
    );
    // shrink the first half to in..splitAbs
    await db.runAsync(
      "UPDATE clips SET in_ms = ?, out_ms = ?, updated_at = ?, sync_status = 'local' WHERE id = ?",
      inMs,
      splitAbs,
      now,
      clipId
    );
  });
  return newId;
}

/**
 * Duplicate a clip onto the timeline right after the original. Carries the
 * same file_uri, trim, mirror, and verdict; gets a fresh id and order_index.
 * Subsequent clips bump down by 1. Returns the new clip id.
 */
export async function duplicateClip(clipId: string): Promise<string | null> {
  const db = await getDb();
  const c = await db.getFirstAsync<Clip>(
    'SELECT * FROM clips WHERE id = ?',
    clipId
  );
  if (!c) return null;
  const now = Date.now();
  const newId = id();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "UPDATE clips SET order_index = order_index + 1, updated_at = ?, sync_status = 'local' WHERE project_id = ? AND order_index > ?",
      now,
      c.project_id,
      c.order_index
    );
    await db.runAsync(
      `INSERT INTO clips
         (id, project_id, order_index, file_uri, duration_ms, verdict, verdict_overridden, tag, tag_overridden, excluded, expires_at, created_at, updated_at, sync_status, name, meta_tags, transcript, mirrored, in_ms, out_ms, audio_volume, audio_detached, transcript_words)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId,
      c.project_id,
      c.order_index + 1,
      c.file_uri,
      c.duration_ms,
      c.verdict,
      c.verdict_overridden,
      c.tag,
      c.tag_overridden,
      c.excluded,
      c.expires_at,
      now,
      now,
      'local',
      c.name,
      c.meta_tags,
      c.transcript,
      c.mirrored,
      c.in_ms,
      c.out_ms,
      c.audio_volume,
      c.audio_detached,
      c.transcript_words
    );
  });
  return newId;
}

/** Swap a clip's source file (e.g. picker → different take). Resets trim
 *  to the new file's full duration and clears the transcript since the
 *  text no longer matches the source. */
export async function replaceClipFile(
  clipId: string,
  fileUri: string,
  durationMs: number
) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET file_uri = ?, duration_ms = ?, in_ms = NULL, out_ms = NULL, transcript = NULL, transcript_words = NULL WHERE id = ?',
    fileUri,
    durationMs,
    clipId
  );
  await touch(db, 'clips', clipId);
}

/** Slip: keep the clip's *timeline* duration but shift WHICH portion of
 *  the source plays inside it. Pass deltaMs (positive = scroll later in
 *  source). The window stays the same length; clamp against the source
 *  duration so it doesn't run off the ends. */
export async function slipClip(clipId: string, deltaMs: number) {
  const db = await getDb();
  const c = await db.getFirstAsync<Clip>(
    'SELECT * FROM clips WHERE id = ?',
    clipId
  );
  if (!c) return;
  const inMs = c.in_ms ?? 0;
  const outMs = c.out_ms ?? c.duration_ms;
  const window = outMs - inMs;
  let newIn = inMs + Math.round(deltaMs);
  let newOut = newIn + window;
  if (newIn < 0) {
    newIn = 0;
    newOut = window;
  }
  if (newOut > c.duration_ms) {
    newOut = c.duration_ms;
    newIn = newOut - window;
  }
  await db.runAsync(
    'UPDATE clips SET in_ms = ?, out_ms = ? WHERE id = ?',
    newIn,
    newOut,
    clipId
  );
  await touch(db, 'clips', clipId);
}

/** Rewrite order_index for a project's clips to the supplied id order. */
export async function reorderProjectClips(
  projectId: string,
  idsInOrder: string[]
) {
  const db = await getDb();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < idsInOrder.length; i++) {
      await db.runAsync(
        "UPDATE clips SET order_index = ?, updated_at = ?, sync_status = 'local' WHERE id = ? AND project_id = ?",
        i,
        now,
        idsInOrder[i],
        projectId
      );
    }
  });
}

// ----- Overlays (project-level text overlays for the editor) -----

export async function listOverlays(projectId: string): Promise<Overlay[]> {
  const db = await getDb();
  return db.getAllAsync<Overlay>(
    'SELECT * FROM overlays WHERE project_id = ? ORDER BY start_ms ASC, created_at ASC',
    projectId
  );
}

export async function addOverlay(
  projectId: string,
  args: {
    kind?: OverlayKind;
    text?: string;
    file_uri?: string | null;
    start_ms: number;
    end_ms: number;
    x?: number;
    y?: number;
    color?: string;
    size?: number;
    scale?: number;
    source_clip_id?: string | null;
  }
): Promise<Overlay> {
  const db = await getDb();
  const now = Date.now();
  const kind: OverlayKind = args.kind ?? 'text';
  // Media overlays default to a centered, larger position so they read as
  // picture-in-picture rather than a footer caption. Subject overlays
  // default to FULL-SIZE so they align with the source frame.
  const defaultY = kind === 'text' ? 0.82 : 0.5;
  const defaultScale = kind === 'subject' ? 1 : args.scale ?? 0.4;
  const o: Overlay = {
    id: id(),
    project_id: projectId,
    kind,
    text: args.text ?? '',
    file_uri: args.file_uri ?? null,
    start_ms: args.start_ms,
    end_ms: args.end_ms,
    x: args.x ?? 0.5,
    y: args.y ?? defaultY,
    color: args.color ?? '#ffffff',
    size: args.size ?? 22,
    scale: defaultScale,
    keyframes_json: null,
    source_clip_id: args.source_clip_id ?? null,
    created_at: now,
    owner: null,
    updated_at: now,
    sync_status: 'local',
  };
  await db.runAsync(
    `INSERT INTO overlays (id, project_id, kind, text, file_uri, start_ms, end_ms, x, y, color, size, scale, source_clip_id, created_at, updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')`,
    o.id,
    o.project_id,
    o.kind,
    o.text,
    o.file_uri,
    o.start_ms,
    o.end_ms,
    o.x,
    o.y,
    o.color,
    o.size,
    o.scale,
    o.source_clip_id,
    o.created_at,
    o.updated_at
  );
  return o;
}

/** Create the "subject" overlay representing a cutout-extracted person
 *  layer above the source clip. The overlay shares the clip's media
 *  and its time range on the composed timeline. The native engine
 *  recognises kind='subject' / source_clip_id and applies Vision
 *  person-segmentation when rendering its frames. */
export async function createSubjectOverlay(
  projectId: string,
  sourceClipId: string,
  startMs: number,
  endMs: number,
  fileUri: string
): Promise<Overlay> {
  return addOverlay(projectId, {
    kind: 'subject',
    file_uri: fileUri,
    start_ms: startMs,
    end_ms: endMs,
    source_clip_id: sourceClipId,
    // Centered, full-size so it perfectly overlays the source until
    // the user drags it somewhere new.
    x: 0.5,
    y: 0.5,
    scale: 1,
  });
}

/** Find the subject overlay (if any) attached to this source clip. */
export async function findSubjectOverlayFor(
  clipId: string
): Promise<Overlay | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Overlay>(
    "SELECT * FROM overlays WHERE source_clip_id = ? AND kind = 'subject' LIMIT 1",
    clipId
  );
  return row ?? null;
}

/** Drop a subject overlay (if present) for the given source clip. */
export async function removeSubjectOverlayFor(clipId: string) {
  const db = await getDb();
  await db.runAsync(
    "DELETE FROM overlays WHERE source_clip_id = ? AND kind = 'subject'",
    clipId
  );
}

export async function updateOverlay(
  overlayId: string,
  patch: Partial<
    Pick<
      Overlay,
      | 'text'
      | 'start_ms'
      | 'end_ms'
      | 'x'
      | 'y'
      | 'color'
      | 'size'
      | 'scale'
    >
  >
) {
  const db = await getDb();
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => patch[k]);
  await db.runAsync(
    `UPDATE overlays SET ${sets} WHERE id = ?`,
    ...(vals as (string | number)[]),
    overlayId
  );
  await touch(db, 'overlays', overlayId);
}

export async function deleteOverlay(overlayId: string) {
  const db = await getDb();
  // Reclaim the on-disk media file for image/video overlays so deleted
  // overlays don't leave orphan files in the app document dir.
  const row = await db.getFirstAsync<{ file_uri: string | null }>(
    'SELECT file_uri FROM overlays WHERE id = ?',
    overlayId
  );
  await db.runAsync('DELETE FROM overlays WHERE id = ?', overlayId);
  if (row?.file_uri) deleteOverlayMediaFile(row.file_uri);
}

export async function setClipMirrored(clipId: string, mirrored: 0 | 1) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET mirrored = ? WHERE id = ?',
    mirrored,
    clipId
  );
  await touch(db, 'clips', clipId);
}

export async function setClipRemotePath(clipId: string, path: string) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET remote_path = ? WHERE id = ?',
    path,
    clipId
  );
}

/** Just stash the transcript text - leave tag/name alone (used when the
 *  user manually overrode the tag and we want their choice to stick). */
export async function setClipTranscriptText(
  clipId: string,
  transcript: string
) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET transcript = ? WHERE id = ?',
    transcript,
    clipId
  );
  await touch(db, 'clips', clipId);
}

/** Apply a server transcript: stores it and the tag/name it implies. */
export async function setClipTranscription(
  clipId: string,
  transcript: string,
  tag: ClipTag,
  name: string
) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET transcript = ?, tag = ?, name = ? WHERE id = ?',
    transcript,
    tag,
    name,
    clipId
  );
  await touch(db, 'clips', clipId);
}

export async function renameClip(clipId: string, name: string) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET name = ? WHERE id = ?',
    name.trim() || null,
    clipId
  );
  await touch(db, 'clips', clipId);
}

export async function setClipExcluded(clipId: string, excluded: 0 | 1) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET excluded = ? WHERE id = ?',
    excluded,
    clipId
  );
  await touch(db, 'clips', clipId);
}

/** Sweep ephemeral takes whose window has passed: delete file + row.
 *  Returns how many were reclaimed. */
export async function gcExpiredClips(): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  const rows = await db.getAllAsync<Clip>(
    'SELECT * FROM clips WHERE expires_at IS NOT NULL AND expires_at < ?',
    now
  );
  for (const c of rows) deleteClipFile(c.file_uri);
  const r = await db.runAsync(
    'DELETE FROM clips WHERE expires_at IS NOT NULL AND expires_at < ?',
    now
  );
  return r.changes ?? rows.length;
}

/** Manual-edit reorder: swap a clip's order_index with its neighbor. */
export async function moveClip(clipId: string, dir: 'up' | 'down') {
  const db = await getDb();
  const clip = await db.getFirstAsync<Clip>(
    'SELECT * FROM clips WHERE id = ?',
    clipId
  );
  if (!clip) return;
  const neighbor = await db.getFirstAsync<Clip>(
    dir === 'up'
      ? 'SELECT * FROM clips WHERE project_id = ? AND order_index < ? ORDER BY order_index DESC LIMIT 1'
      : 'SELECT * FROM clips WHERE project_id = ? AND order_index > ? ORDER BY order_index ASC LIMIT 1',
    clip.project_id,
    clip.order_index
  );
  if (!neighbor) return;
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "UPDATE clips SET order_index = ?, updated_at = ?, sync_status = 'local' WHERE id = ?",
      neighbor.order_index,
      now,
      clip.id
    );
    await db.runAsync(
      "UPDATE clips SET order_index = ?, updated_at = ?, sync_status = 'local' WHERE id = ?",
      clip.order_index,
      now,
      neighbor.id
    );
  });
}

// ----- Collections -----

export async function listCollections(): Promise<Collection[]> {
  const db = await getDb();
  return db.getAllAsync<Collection>(
    'SELECT * FROM collections ORDER BY created_at ASC'
  );
}

export async function getCollection(cid: string): Promise<Collection | null> {
  const db = await getDb();
  return db.getFirstAsync<Collection>(
    'SELECT * FROM collections WHERE id = ?',
    cid
  );
}

export async function createCollection(name: string): Promise<Collection> {
  const db = await getDb();
  const now = Date.now();
  const c: Collection = {
    id: id(),
    name: name.trim() || 'Untitled',
    created_at: now,
    owner: null,
    updated_at: now,
    sync_status: 'local',
    fingerprint_json: null,
    fingerprint_updated_at: null,
    n_analyzed: 0,
  };
  await db.runAsync(
    'INSERT INTO collections (id, name, created_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?)',
    c.id,
    c.name,
    c.created_at,
    c.updated_at,
    c.sync_status
  );
  return c;
}

export async function renameCollection(cid: string, name: string) {
  const db = await getDb();
  await db.runAsync('UPDATE collections SET name = ? WHERE id = ?', name.trim(), cid);
  await touch(db, 'collections', cid);
}

export async function deleteCollection(cid: string) {
  const db = await getDb();
  await db.runAsync('DELETE FROM inspiration WHERE collection_id = ?', cid);
  await db.runAsync('DELETE FROM collections WHERE id = ?', cid);
}

export async function collectionCount(cid: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) as c FROM inspiration WHERE collection_id = ?',
    cid
  );
  return row?.c ?? 0;
}

export interface CollectionWithCount {
  collection: Collection;
  count: number;
}

export async function listCollectionsWithCounts(): Promise<CollectionWithCount[]> {
  const cols = await listCollections();
  const out: CollectionWithCount[] = [];
  for (const c of cols) {
    out.push({ collection: c, count: await collectionCount(c.id) });
  }
  return out;
}

export async function unfiledCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ c: number }>(
    "SELECT COUNT(*) as c FROM inspiration WHERE collection_id = ''"
  );
  return row?.c ?? 0;
}

// ----- Inspiration -----

const THUMBS = [palette.purple, palette.yellow, palette.blue, palette.red];

/** Tag the source platform from the host. Cheap host-only check - the
 *  resolver re-confirms once it actually fetches the URL. */
export function detectPlatform(sourceUrl: string): ReelPlatform {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
    if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.endsWith('tiktok.com') || host === 'vm.tiktok.com') return 'tiktok';
    if (host.endsWith('instagram.com')) return 'instagram';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function addInspiration(
  collectionId: string,
  sourceUrl: string,
  note?: string
): Promise<Inspiration> {
  const db = await getDb();
  const now = Date.now();
  const platform = detectPlatform(sourceUrl);
  const item: Inspiration = {
    id: id(),
    collection_id: collectionId,
    source_url: sourceUrl.trim(),
    thumb_color: THUMBS[Math.floor(Math.random() * THUMBS.length)],
    note: note?.trim() || null,
    added_at: now,
    owner: null,
    updated_at: now,
    sync_status: 'local',
    platform,
    playable_url: null,
    playable_url_expires_at: null,
    duration_ms: null,
    width: null,
    height: null,
    caption_text: null,
    analysis_status: 'idle',
    analysis_version: 0,
    analyzed_at: null,
    analysis_error: null,
    shots_json: null,
    hook_text: null,
    hook_duration_ms: null,
    median_shot_ms: null,
    cuts_per_sec: null,
    talking_pct: null,
    broll_pct: null,
    text_overlay_pct: null,
    watch_pct: 0,
    replay_count: 0,
    time_on_card_ms: 0,
    swipe_verdict: null,
  };
  await db.runAsync(
    'INSERT INTO inspiration (id, collection_id, source_url, thumb_color, note, added_at, updated_at, sync_status, platform) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    item.id,
    item.collection_id,
    item.source_url,
    item.thumb_color,
    item.note,
    item.added_at,
    item.updated_at,
    item.sync_status,
    item.platform
  );
  return item;
}

export async function listInspiration(collectionId: string): Promise<Inspiration[]> {
  const db = await getDb();
  return db.getAllAsync<Inspiration>(
    'SELECT * FROM inspiration WHERE collection_id = ? ORDER BY added_at DESC',
    collectionId
  );
}

/** Unfiled reels (collection_id = '') waiting to be swiped. */
export async function listUnfiled(): Promise<Inspiration[]> {
  const db = await getDb();
  return db.getAllAsync<Inspiration>(
    "SELECT * FROM inspiration WHERE collection_id = '' ORDER BY added_at DESC"
  );
}

export async function fileInspiration(itemId: string, collectionId: string) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE inspiration SET collection_id = ? WHERE id = ?',
    collectionId,
    itemId
  );
  await touch(db, 'inspiration', itemId);
}

export async function deleteInspiration(itemId: string) {
  const db = await getDb();
  await db.runAsync('DELETE FROM inspiration WHERE id = ?', itemId);
}

export async function getInspiration(itemId: string): Promise<Inspiration | null> {
  const db = await getDb();
  return db.getFirstAsync<Inspiration>(
    'SELECT * FROM inspiration WHERE id = ?',
    itemId
  );
}

/** Output of the URL resolver (task #1). Writes the streamable URL and
 *  raw media facts the analysis pipeline needs. */
export interface ResolvedReel {
  platform?: ReelPlatform;
  playable_url: string;
  playable_url_expires_at: number | null;
  duration_ms: number;
  width: number | null;
  height: number | null;
  caption_text: string | null;
}

export async function setInspirationResolved(
  itemId: string,
  r: ResolvedReel
) {
  const db = await getDb();
  await db.runAsync(
    `UPDATE inspiration
        SET platform = COALESCE(?, platform),
            playable_url = ?,
            playable_url_expires_at = ?,
            duration_ms = ?,
            width = ?,
            height = ?,
            caption_text = ?
      WHERE id = ?`,
    r.platform ?? null,
    r.playable_url,
    r.playable_url_expires_at,
    r.duration_ms,
    r.width,
    r.height,
    r.caption_text,
    itemId
  );
  await touch(db, 'inspiration', itemId);
}

export async function setInspirationAnalysisStatus(
  itemId: string,
  status: 'idle' | 'queued' | 'running' | 'ready' | 'failed',
  error?: string | null
) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE inspiration SET analysis_status = ?, analysis_error = ? WHERE id = ?',
    status,
    error ?? null,
    itemId
  );
  await touch(db, 'inspiration', itemId);
}

/** Persistent shape of analyzeReel's output (matches column names). */
export interface InspirationAnalysisFields {
  shots_json: string;
  hook_text: string | null;
  hook_duration_ms: number | null;
  median_shot_ms: number;
  cuts_per_sec: number;
  talking_pct: number;
  broll_pct: number;
  text_overlay_pct: number;
  analysis_version: number;
}

export async function setInspirationAnalysisResult(
  itemId: string,
  fields: InspirationAnalysisFields
) {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `UPDATE inspiration
        SET shots_json = ?,
            hook_text = ?,
            hook_duration_ms = ?,
            median_shot_ms = ?,
            cuts_per_sec = ?,
            talking_pct = ?,
            broll_pct = ?,
            text_overlay_pct = ?,
            analysis_status = 'ready',
            analysis_error = NULL,
            analysis_version = ?,
            analyzed_at = ?
      WHERE id = ?`,
    fields.shots_json,
    fields.hook_text,
    fields.hook_duration_ms,
    fields.median_shot_ms,
    fields.cuts_per_sec,
    fields.talking_pct,
    fields.broll_pct,
    fields.text_overlay_pct,
    fields.analysis_version,
    now,
    itemId
  );
  await touch(db, 'inspiration', itemId);
}

/** Rows the analysis worker should pick up next, in age order. Skips
 *  rows that have already been analyzed at the current version. */
export async function listInspirationsNeedingAnalysis(
  currentVersion: number,
  limit: number = 5
): Promise<Inspiration[]> {
  const db = await getDb();
  return db.getAllAsync<Inspiration>(
    `SELECT * FROM inspiration
       WHERE analysis_status IN ('idle', 'failed')
         AND analysis_version < ?
       ORDER BY added_at ASC
       LIMIT ?`,
    currentVersion,
    limit
  );
}
