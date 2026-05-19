import { decode } from 'base64-arraybuffer';
import * as LegacyFS from 'expo-file-system/legacy';

import { getDb } from './db';
import {
  clipRelPath,
  ensureClipsDir,
  resolveClipUri,
} from './filestore';
import { CLIPS_BUCKET, supabase, supabaseConfigured } from './supabase';
import type { Clip, Collection, Inspiration, Project } from './types';

/**
 * Memories sync. Local SQLite is the working cache; Supabase is the backup /
 * cross-device source of truth. Only saved clips (expires_at IS NULL) ever
 * leave the device - ephemeral takes are never uploaded. Best-effort and
 * resilient: a single row/file failure never aborts the run.
 */

export interface SyncResult {
  pushed: number;
  pulled: number;
  uploaded: number;
  downloaded: number;
  ok: boolean;
}

let running = false;

export async function runSync(userId: string): Promise<SyncResult> {
  const res: SyncResult = {
    pushed: 0,
    pulled: 0,
    uploaded: 0,
    downloaded: 0,
    ok: false,
  };
  if (!supabaseConfigured || !userId || running) return res;
  running = true;
  try {
    await push(userId, res);
    await pull(userId, res);
    res.ok = true;
  } catch {
    // swallow - next run retries
  } finally {
    running = false;
  }
  return res;
}

// ---------- push ----------

async function push(userId: string, res: SyncResult) {
  const db = await getDb();

  const projects = await db.getAllAsync<Project>(
    "SELECT * FROM projects WHERE sync_status = 'local'"
  );
  for (const p of projects) {
    try {
      const { error } = await supabase.from('projects').upsert({
        id: p.id,
        user_id: userId,
        type: p.type,
        title: p.title,
        status: p.status,
        prompt: p.prompt,
        created_at: p.created_at,
        updated_at: p.updated_at,
        deleted: false,
      });
      if (!error) {
        await markSynced(db, 'projects', p.id, userId);
        res.pushed++;
      }
    } catch {
      /* keep going */
    }
  }

  const collections = await db.getAllAsync<Collection>(
    "SELECT * FROM collections WHERE sync_status = 'local'"
  );
  for (const c of collections) {
    try {
      const { error } = await supabase.from('collections').upsert({
        id: c.id,
        user_id: userId,
        name: c.name,
        created_at: c.created_at,
        updated_at: c.updated_at,
        deleted: false,
      });
      if (!error) {
        await markSynced(db, 'collections', c.id, userId);
        res.pushed++;
      }
    } catch {
      /* keep going */
    }
  }

  const insp = await db.getAllAsync<Inspiration>(
    "SELECT * FROM inspiration WHERE sync_status = 'local'"
  );
  for (const i of insp) {
    try {
      const { error } = await supabase.from('inspiration').upsert({
        id: i.id,
        user_id: userId,
        collection_id: i.collection_id,
        source_url: i.source_url,
        thumb_color: i.thumb_color,
        note: i.note,
        added_at: i.added_at,
        updated_at: i.updated_at,
        deleted: false,
      });
      if (!error) {
        await markSynced(db, 'inspiration', i.id, userId);
        res.pushed++;
      }
    } catch {
      /* keep going */
    }
  }

  // Only saved clips (no expiry) back up. Ephemeral takes never leave device.
  const clips = await db.getAllAsync<Clip>(
    "SELECT * FROM clips WHERE sync_status = 'local' AND expires_at IS NULL"
  );
  for (const cl of clips) {
    try {
      let storagePath = cl.remote_path;
      if (!storagePath) {
        const uploaded = await uploadClipFile(userId, cl);
        if (uploaded) {
          storagePath = uploaded;
          res.uploaded++;
        }
      }
      const { error } = await supabase.from('clips').upsert({
        id: cl.id,
        user_id: userId,
        project_id: cl.project_id,
        order_index: cl.order_index,
        storage_path: storagePath,
        duration_ms: cl.duration_ms,
        verdict: cl.verdict,
        verdict_overridden: cl.verdict_overridden,
        tag: cl.tag,
        tag_overridden: cl.tag_overridden,
        excluded: cl.excluded,
        transcript: cl.transcript,
        created_at: cl.created_at,
        updated_at: cl.updated_at,
        deleted: false,
      });
      if (!error) {
        await db.runAsync(
          "UPDATE clips SET sync_status = 'synced', owner = ?, remote_path = ? WHERE id = ?",
          userId,
          storagePath,
          cl.id
        );
        res.pushed++;
      }
    } catch {
      /* keep going */
    }
  }
}

export async function uploadClipFile(
  userId: string,
  clip: Clip
): Promise<string | null> {
  try {
    const abs = resolveClipUri(clip.file_uri);
    const info = await LegacyFS.getInfoAsync(abs);
    if (!info.exists) return null;
    const b64 = await LegacyFS.readAsStringAsync(abs, {
      encoding: LegacyFS.EncodingType.Base64,
    });
    const path = `${userId}/${clip.id}.mov`;
    const { error } = await supabase.storage
      .from(CLIPS_BUCKET)
      .upload(path, decode(b64), {
        contentType: 'video/quicktime',
        upsert: true,
      });
    return error ? null : path;
  } catch {
    return null;
  }
}

// ---------- pull (restore on a fresh device) ----------

async function pull(userId: string, res: SyncResult) {
  const db = await getDb();

  const tables = ['projects', 'collections', 'inspiration', 'clips'] as const;
  for (const t of tables) {
    const { data, error } = await supabase
      .from(t)
      .select('*')
      .eq('deleted', false);
    if (error || !data) continue;
    for (const row of data as Record<string, unknown>[]) {
      try {
        const applied = await upsertLocal(db, t, row, userId);
        if (applied) res.pulled++;
        if (t === 'clips') {
          const got = await ensureClipFile(
            row.id as string,
            row.storage_path as string | null
          );
          if (got) res.downloaded++;
        }
      } catch {
        /* keep going */
      }
    }
  }
}

/** Insert a remote row locally if missing, or overwrite if remote is newer. */
async function upsertLocal(
  db: Awaited<ReturnType<typeof getDb>>,
  table: 'projects' | 'collections' | 'inspiration' | 'clips',
  row: Record<string, unknown>,
  userId: string
): Promise<boolean> {
  const id = row.id as string;
  const remoteUpdated = Number(row.updated_at ?? 0);
  const local = await db.getFirstAsync<{ updated_at: number }>(
    `SELECT updated_at FROM ${table} WHERE id = ?`,
    id
  );
  if (local && local.updated_at >= remoteUpdated) return false;

  if (table === 'projects') {
    await db.runAsync(
      `INSERT INTO projects (id, type, title, status, prompt, created_at, owner, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced')
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status,
         prompt=excluded.prompt, updated_at=excluded.updated_at, owner=excluded.owner,
         sync_status='synced'`,
      id,
      row.type as string,
      row.title as string,
      row.status as string,
      (row.prompt as string | null) ?? null,
      Number(row.created_at ?? remoteUpdated),
      userId,
      remoteUpdated
    );
  } else if (table === 'collections') {
    await db.runAsync(
      `INSERT INTO collections (id, name, created_at, owner, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, 'synced')
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at,
         owner=excluded.owner, sync_status='synced'`,
      id,
      row.name as string,
      Number(row.created_at ?? remoteUpdated),
      userId,
      remoteUpdated
    );
  } else if (table === 'inspiration') {
    await db.runAsync(
      `INSERT INTO inspiration (id, collection_id, source_url, thumb_color, note, added_at, owner, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced')
       ON CONFLICT(id) DO UPDATE SET collection_id=excluded.collection_id,
         note=excluded.note, updated_at=excluded.updated_at, owner=excluded.owner,
         sync_status='synced'`,
      id,
      row.collection_id as string,
      row.source_url as string,
      row.thumb_color as string,
      (row.note as string | null) ?? null,
      Number(row.added_at ?? remoteUpdated),
      userId,
      remoteUpdated
    );
  } else {
    // clips - restored clips are saved Memories (no expiry)
    await db.runAsync(
      `INSERT INTO clips (id, project_id, order_index, file_uri, duration_ms, verdict,
         verdict_overridden, tag, tag_overridden, excluded, expires_at, remote_path,
         transcript, created_at, owner, updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'synced')
       ON CONFLICT(id) DO UPDATE SET order_index=excluded.order_index,
         verdict=excluded.verdict, tag=excluded.tag, excluded=excluded.excluded,
         remote_path=excluded.remote_path, transcript=excluded.transcript,
         updated_at=excluded.updated_at, owner=excluded.owner,
         sync_status='synced'`,
      id,
      row.project_id as string,
      Number(row.order_index ?? 0),
      clipRelPath(id),
      Number(row.duration_ms ?? 0),
      row.verdict as string,
      Number(row.verdict_overridden ?? 0),
      row.tag as string,
      Number(row.tag_overridden ?? 0),
      Number(row.excluded ?? 0),
      (row.storage_path as string | null) ?? null,
      (row.transcript as string | null) ?? null,
      Number(row.created_at ?? remoteUpdated),
      userId,
      remoteUpdated
    );
  }
  return true;
}

/** Download a clip's video from Storage if it is not already on disk. */
async function ensureClipFile(
  clipId: string,
  storagePath: string | null
): Promise<boolean> {
  if (!storagePath) return false;
  try {
    const rel = clipRelPath(clipId);
    const abs = resolveClipUri(rel);
    const info = await LegacyFS.getInfoAsync(abs);
    if (info.exists) return false;
    const { data, error } = await supabase.storage
      .from(CLIPS_BUCKET)
      .createSignedUrl(storagePath, 120);
    if (error || !data?.signedUrl) return false;
    ensureClipsDir();
    const dl = await LegacyFS.downloadAsync(data.signedUrl, abs);
    return dl.status === 200;
  } catch {
    return false;
  }
}

// ---------- helpers ----------

async function markSynced(
  db: Awaited<ReturnType<typeof getDb>>,
  table: 'projects' | 'collections' | 'inspiration',
  rowId: string,
  userId: string
) {
  await db.runAsync(
    `UPDATE ${table} SET sync_status = 'synced', owner = ? WHERE id = ?`,
    userId,
    rowId
  );
}
