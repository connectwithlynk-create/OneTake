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

export type CaptionStyle =
  | 'karaoke'
  | 'bold'
  | 'pop'
  | 'subtle'
  | 'bar'
  | 'typeout';

export interface Project extends SyncFields {
  id: string;
  type: ProjectType;
  title: string;
  status: ProjectStatus;
  prompt: string | null;
  created_at: number;
  /** 1 = render captions over the preview, 0 = hide. */
  captions_enabled: number;
  /** Caption style preset. */
  caption_style: CaptionStyle;
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
  /** 1 = audio is shown as a detached block on the audio track. The audio
   *  still plays from the same source file; this is presentation-only so
   *  the user can see / select / mute audio independently of the video. */
  audio_detached: number;
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
  /** JSON CollectionFingerprint, null until at least one reel in the
   *  collection has analysis_status='ready'. Recomputed on each new
   *  analyzed reel or telemetry update. */
  fingerprint_json: string | null;
  fingerprint_updated_at: number | null;
  n_analyzed: number;
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

export type ReelPlatform = 'youtube' | 'tiktok' | 'instagram' | 'unknown';
export type AnalysisStatus = 'idle' | 'queued' | 'running' | 'ready' | 'failed';
export type SwipeVerdict = 'left' | 'right';

/** One detected shot inside a reel. start/end in ms from reel origin.
 *  has_face = on-device detector picked up a face in the representative
 *  frame (talking-head heuristic). ocr_text = on-screen text from that
 *  frame (often the baked-in hook); null if none read. */
export interface ReelShot {
  start_ms: number;
  end_ms: number;
  has_face: boolean;
  ocr_text: string | null;
}

/** Collection-level rollup of the analyzed reels' style. The beat template
 *  is the bridge to script-gen + auto-edit: an ordered sequence of modal
 *  slots that user clips can be slotted into. */
export interface CollectionFingerprint {
  n_reels: number;
  median_shot_ms: number;
  cuts_per_sec: number;
  talking_pct: number;
  broll_pct: number;
  text_overlay_pct: number;
  /** Free-text archetypes clustered from hook_text across reels (e.g.
   *  "POV", "question", "stat", "dialogue"). */
  hook_archetypes: string[];
  /** Ordered modal slots that approximate the cluster's beat structure. */
  beat_template: {
    duration_p50_ms: number;
    shot_type: 'talking' | 'broll' | 'mixed';
    has_text_p: number;
  }[];
}

export interface Inspiration extends SyncFields {
  id: string;
  collection_id: string;
  source_url: string;
  thumb_color: string;
  note: string | null;
  added_at: number;
  /** Detected from source_url. 'unknown' until a resolver tags it. */
  platform: ReelPlatform;
  /** Streamable CDN URL from the resolver. Short-lived; re-resolve when
   *  now() > playable_url_expires_at. */
  playable_url: string | null;
  playable_url_expires_at: number | null;
  /** Raw media facts from the resolver (filled at resolve time). */
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  /** Platform-provided spoken transcript (e.g. YT auto-captions). Null
   *  if the platform doesn't expose one for this reel. */
  caption_text: string | null;
  /** Analysis pipeline state machine. */
  analysis_status: AnalysisStatus;
  analysis_version: number;
  analyzed_at: number | null;
  analysis_error: string | null;
  /** JSON ReelShot[] - the per-shot output of the on-device pipeline. */
  shots_json: string | null;
  /** OCR text from the first ~1.5s (the visual hook). */
  hook_text: string | null;
  /** Time from reel start to first detected cut. */
  hook_duration_ms: number | null;
  median_shot_ms: number | null;
  cuts_per_sec: number | null;
  /** Fraction of duration where has_face=true. */
  talking_pct: number | null;
  broll_pct: number | null;
  /** Fraction of shots with non-empty ocr_text. */
  text_overlay_pct: number | null;
  /** Swipe-deck telemetry (filled by task #8). Defaulted so old rows are
   *  comparable in the fingerprint roll-up without a backfill. */
  watch_pct: number;
  replay_count: number;
  time_on_card_ms: number;
  swipe_verdict: SwipeVerdict | null;
}
