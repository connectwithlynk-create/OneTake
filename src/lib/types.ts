/** Domain types. Mirrors PRD section 14 (data model) plus sync columns. */

export type ProjectType = 'talkinghead' | 'prompt';
export type ProjectStatus = 'recording' | 'processing' | 'ready';
export type Verdict = 'dud' | 'keep' | 'perfect';
export type ClipTag = 'talking' | 'broll';

/** Advanced descriptive tags, esp. for b-roll (what the footage is about). */
export type MetaKind = 'location' | 'action' | 'subject';
export interface MetaTag {
  kind: MetaKind;
  value: string;
}

/** 'local' = created/changed on device, not yet pushed. 'synced' = pushed. */
export type SyncStatus = 'local' | 'synced';

/** Columns every syncable row carries. owner = Clerk user id (null while
 *  signed-out / local-only). */
export interface SyncFields {
  owner: string | null;
  updated_at: number;
  sync_status: SyncStatus;
}

export interface Project extends SyncFields {
  id: string;
  type: ProjectType;
  title: string;
  status: ProjectStatus;
  prompt: string | null;
  created_at: number;
}

export interface Clip extends SyncFields {
  id: string;
  project_id: string;
  order_index: number;
  /** Relative path under the app document dir, e.g. "clips/<id>.mov". */
  file_uri: string;
  duration_ms: number;
  verdict: Verdict;
  verdict_overridden: number; // 0 | 1
  tag: ClipTag;
  tag_overridden: number; // 0 | 1
  excluded: number; // 0 | 1  manual-edit: dropped from the cut
  /** Auto-generated human name, e.g. "Talking 2" or "B-roll · kitchen". */
  name: string | null;
  /** JSON-encoded MetaTag[] (advanced descriptive tags). */
  meta_tags: string | null;
  /** Speech-to-text of the clip's audio (server transcription). Drives
   *  talking/b-roll and the spoken-words title. Null until transcribed. */
  transcript: string | null;
  /** View-time horizontal flip (mirror). The file is never re-encoded -
   *  this only affects how the clip is displayed in the player. 0|1. */
  mirrored: number;
  /** Non-null = ephemeral take; GC'd after this epoch-ms. Null = saved
   *  (Memories): persists and is eligible for cloud backup. */
  expires_at: number | null;
  /** Supabase Storage object key once uploaded. */
  remote_path: string | null;
  created_at: number;
}

export interface Collection extends SyncFields {
  id: string;
  name: string;
  created_at: number;
}

export interface Inspiration extends SyncFields {
  id: string;
  collection_id: string;
  source_url: string;
  thumb_color: string;
  note: string | null;
  added_at: number;
}
