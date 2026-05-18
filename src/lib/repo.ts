import { getDb } from './db';
import { deleteClipFile } from './filestore';
import { id } from './id';
import { palette } from '../theme';
import type {
  Clip,
  ClipTag,
  Collection,
  Inspiration,
  Project,
  ProjectStatus,
  ProjectType,
  Verdict,
} from './types';

// ----- Projects -----

export async function createProject(
  type: ProjectType,
  title: string,
  prompt?: string
): Promise<Project> {
  const db = await getDb();
  const p: Project = {
    id: id(),
    type,
    title: title.trim() || (type === 'prompt' ? 'Prompt project' : 'Untitled'),
    status: 'recording',
    prompt: prompt?.trim() || null,
    created_at: Date.now(),
  };
  await db.runAsync(
    'INSERT INTO projects (id, type, title, status, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    p.id,
    p.type,
    p.title,
    p.status,
    p.prompt,
    p.created_at
  );
  return p;
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

export async function setProjectStatus(pid: string, status: ProjectStatus) {
  const db = await getDb();
  await db.runAsync('UPDATE projects SET status = ? WHERE id = ?', status, pid);
}

export async function setProjectPrompt(pid: string, prompt: string) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE projects SET prompt = ? WHERE id = ?',
    prompt.trim(),
    pid
  );
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
    created_at: Date.now(),
  };
  await db.runAsync(
    `INSERT INTO clips
       (id, project_id, order_index, file_uri, duration_ms, verdict, verdict_overridden, tag, tag_overridden, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    clip.id,
    clip.project_id,
    clip.order_index,
    clip.file_uri,
    clip.duration_ms,
    clip.verdict,
    clip.verdict_overridden,
    clip.tag,
    clip.tag_overridden,
    clip.created_at
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

export async function setVerdict(clipId: string, verdict: Verdict) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET verdict = ?, verdict_overridden = 1 WHERE id = ?',
    verdict,
    clipId
  );
}

export async function setTag(clipId: string, tag: ClipTag) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE clips SET tag = ?, tag_overridden = 1 WHERE id = ?',
    tag,
    clipId
  );
}

export async function deleteClip(clipId: string, fileUri: string) {
  const db = await getDb();
  deleteClipFile(fileUri);
  await db.runAsync('DELETE FROM clips WHERE id = ?', clipId);
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
  const c: Collection = { id: id(), name: name.trim() || 'Untitled', created_at: Date.now() };
  await db.runAsync(
    'INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)',
    c.id,
    c.name,
    c.created_at
  );
  return c;
}

export async function renameCollection(cid: string, name: string) {
  const db = await getDb();
  await db.runAsync('UPDATE collections SET name = ? WHERE id = ?', name.trim(), cid);
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

export async function addInspiration(
  collectionId: string,
  sourceUrl: string,
  note?: string
): Promise<Inspiration> {
  const db = await getDb();
  const item: Inspiration = {
    id: id(),
    collection_id: collectionId,
    source_url: sourceUrl.trim(),
    thumb_color: THUMBS[Math.floor(Math.random() * THUMBS.length)],
    note: note?.trim() || null,
    added_at: Date.now(),
  };
  await db.runAsync(
    'INSERT INTO inspiration (id, collection_id, source_url, thumb_color, note, added_at) VALUES (?, ?, ?, ?, ?, ?)',
    item.id,
    item.collection_id,
    item.source_url,
    item.thumb_color,
    item.note,
    item.added_at
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
}

export async function deleteInspiration(itemId: string) {
  const db = await getDb();
  await db.runAsync('DELETE FROM inspiration WHERE id = ?', itemId);
}
