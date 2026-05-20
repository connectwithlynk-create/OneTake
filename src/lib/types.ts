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
  /** Manual-edit trim in ms (null = no trim, use full clip). */
  in_ms: number | null;
  out_ms: number | null;
  /** 0..1 multiplier applied during in-app preview (not baked into file). */
  audio_volume: number;
  /** JSON of [{w, s, e}] word timings from Deepgram. Drives subtitles. */
  transcript_words: string | null;
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

export type OverlayKind = 'text' | 'image' | 'video';

/** Project-level overlay (rendered over preview in [start_ms, end_ms]).
 *  Either a text overlay (text+color+size) or a media overlay (file_uri+scale).
 *  Media overlays sit on top of the main clip track; their file lives under
 *  the app document dir alongside clip files. */
export interface Overlay extends SyncFields {
  id: string;
  project_id: string;
  kind: OverlayKind;
  text: string; // empty string for media overlays
  /** Relative path under app document dir for image/video overlays. Null for text. */
  file_uri: string | null;
  start_ms: number;
  end_ms: number;
  x: number; // 0..1 normalized
  y: number; // 0..1 normalized
  color: string;
  /** Font size px for text; for media this column is unused (see `scale`). */
  size: number;
  /** Media overlay width as a fraction of the preview width (0..1).
   *  Unused for text overlays. */
  scale: number;
  created_at: number;
}

/** Compact word timing for subtitles ({w}ord, {s}tart sec, {e}nd sec). */
export interface WordTiming {
  w: string;
  s: number;
  e: number;
}

export interface Inspiration extends SyncFields {
  id: string;
  collection_id: string;
  source_url: string;
  thumb_color: string;
  note: string | null;
  added_at: number;
}
