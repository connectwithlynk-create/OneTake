/// <reference types="vite/client" />
// vite/client provides ambient declarations for side-effect asset imports
// (e.g. `import './App.css'`) so `tsc --noEmit` doesn't choke on them.

export type ExportProgressEvent =
  | { phase: 'frames'; done: number; total: number }
  | { phase: 'audio' }
  | { phase: 'mux' }
  | { phase: 'done'; outPath: string }
  | { phase: 'error'; error: string };

export type ExportReelResponse =
  | {
      ok: true;
      out_path: string;
      url: string | null;
      has_audio: boolean;
      frames: number;
    }
  | { ok: false; error: string };

export interface ResolvedReel {
  platform: 'youtube' | 'tiktok' | 'instagram' | 'unknown';
  playable_url: string;
  playable_url_expires_at: number | null;
  duration_ms: number;
  width: number | null;
  height: number | null;
  caption_text: string | null;
}

export type ResolveResult = ResolvedReel | { error: string };

/** An image/video the user pasted into the app, saved to the captures
 *  dir and tracked so it appears in the media library. */
export interface PastedMediaEntry {
  id: string;
  url: string;
  kind: 'image' | 'video';
  mime: string;
  name: string | null;
  added_at: number;
}

export type ClipType =
  | 'talking_head'
  | 'broll_talking_head'
  | 'talking_head_unknown'
  | 'broll_visual';

export type FrameRegion =
  | 'top_left'
  | 'top_center'
  | 'top_right'
  | 'middle_left'
  | 'middle_center'
  | 'middle_right'
  | 'bottom_left'
  | 'bottom_center'
  | 'bottom_right';

export interface NormBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReelShot {
  start_ms: number;
  end_ms: number;
  has_face: boolean;
  ocr_text: string | null;
  speaker_verdict: 'speaker' | 'broll' | 'no_face' | 'unknown';
  speaker_confidence: number;
  sync_conf: number;
  clip_type: ClipType;
  face_bbox: NormBBox | null;
  face_region: FrameRegion | null;
  text_moments: TextMoment[];
  audio_rms_mean: number;
  audio_peak_rms: number;
  audio_silence_pct: number;
  audio_speech_pct: number;
  audio_music_pct: number;
  sfx_count: number;
  sfx_at_start: boolean;
  sfx_classifications: SfxClassifiedEvent[];
  overlays: MediaOverlay[];
  visual_caption: string | null;
  spoken_window: string;
  detected_motion: DetectedMotion | null;
}

export type CameraMotionKind =
  | 'none'
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_left'
  | 'pan_right'
  | 'ken_burns';

export interface DetectedMotion {
  kind: CameraMotionKind;
  confidence: number;
  zoom_rate: number;
  pan_x: number;
  pan_y: number;
}

export type OverlayKind =
  | 'image'
  | 'sticker'
  | 'gif'
  | 'pip_video'
  | 'emoji_graphic';

export type OverlayMotion = 'static' | 'animated';

export interface MediaOverlay {
  start_ms: number;
  end_ms: number;
  bbox: NormBBox;
  region: FrameRegion;
  kind: OverlayKind;
  motion: OverlayMotion;
  spoken_window: string;
  thumb_b64: string | null;
}

export type SfxType =
  | 'impulse_tonal'
  | 'impulse_noisy'
  | 'sweep'
  | 'vocal'
  | 'sustained'
  | 'other';

export interface SfxClassifiedEvent {
  ms: number;
  type: SfxType;
  confidence: number;
  features: {
    rise_time_ms: number;
    decay_90_ms: number;
    duration_above_floor_ms: number;
    spectral_centroid_hz: number;
    spectral_flatness: number;
    voice_band_ratio: number;
    peak_rms: number;
  };
  /** Which classifier produced this event. */
  source: 'model' | 'heuristic';
  /** AudioSet event name for model events, e.g. "Whoosh, swoosh, swish". */
  label?: string;
  /** Top AudioSet labels (descending) for model events. */
  labels?: { label: string; score: number }[];
}

export interface TextMoment {
  text: string;
  bbox: NormBBox;
  region: FrameRegion;
}

export type CaptionPosition =
  | 'center'
  | 'lower_third'
  | 'bottom'
  | 'top'
  | 'varies';
export type CaptionChunking = 'word_by_word' | 'phrase' | 'sentence' | 'mixed';
export type CaptionEmphasis =
  | 'active_word_highlight'
  | 'keyword_highlight'
  | 'none';
export type CaptionCasing =
  | 'uppercase'
  | 'title_case'
  | 'sentence_case'
  | 'mixed';
export type CaptionAnimation =
  | 'pop'
  | 'karaoke_fill'
  | 'fade'
  | 'typewriter'
  | 'static'
  | 'none';
export type CaptionFontSize = 'small' | 'medium' | 'large';
export type CaptionTreatment = 'bordered' | 'backgrounded' | 'clear';

export interface TranscriptWord {
  text: string;
  start_ms: number;
  end_ms: number;
}

/** Spoken-word caption (burned-in subtitle) style for one reel. */
export interface CaptionStyleProfile {
  present: boolean;
  position: CaptionPosition;
  chunking: CaptionChunking;
  /** Typical word count on screen at once before the caption swaps. */
  words_per_chunk: number;
  font_size: CaptionFontSize;
  emphasis: CaptionEmphasis;
  casing: CaptionCasing;
  animation: CaptionAnimation;
  font_descriptor: string;
  /** Closest matched real font (id from the font library), '' if none. */
  font_family: string;
  font_family_name: string;
  text_color: string;
  text_treatment: CaptionTreatment;
  treatment_color: string | null;
  highlight_color: string | null;
  has_emoji: boolean;
  style_label: string;
  /** Closest premade subtitle preset id (see subtitle-presets.ts). */
  matched_preset: string;
  preset_label: string;
  preset_confidence: number;
}

export interface SfxContextSignals {
  sfx_count: number;
  word_count: number;
  sfx_per_word: number;
  on_word_pct: number;
  hook_density_per_s: number;
  body_density_per_s: number;
  hook_escalation: number;
  hook_dominant_type: SfxType | null;
  body_dominant_type: SfxType | null;
}

export interface SfxContextRule {
  trigger: string;
  sfx_type: SfxType;
  example?: string;
}

export interface SfxContext {
  signals: SfxContextSignals;
  pattern_summary: string;
  rules: SfxContextRule[];
  llm: boolean;
}

export interface SfxCollectionPattern {
  signals: SfxContextSignals;
  rules: (SfxContextRule & { reel_count: number })[];
  summaries: string[];
  n_reels: number;
}

export interface ReelAnalysisResult {
  shots: ReelShot[];
  hook_text: string | null;
  hook_duration_ms: number | null;
  median_shot_ms: number;
  cuts_per_sec: number;
  talking_pct: number;
  broll_pct: number;
  text_overlay_pct: number;
  real_speaker_pct: number;
  broll_talking_head_pct: number;
  clip_type_distribution: Record<ClipType, number>;
  face_region_dominant: FrameRegion | 'mixed' | null;
  face_region_distribution: Record<FrameRegion, number> | null;
  face_size_median: number | null;
  text_region_dominant: FrameRegion | 'mixed' | null;
  text_region_distribution: Record<FrameRegion, number> | null;
  audio_energy_mean: number;
  audio_energy_std: number;
  audio_silence_pct: number;
  voiceover_pct: number;
  music_pct: number;
  hook_speech: string | null;
  sfx_per_min: number;
  cuts_with_sfx_pct: number;
  sfx_at_cuts_pct: number;
  sfx_type_distribution: Record<SfxType, number>;
  sfx_classified_total: number;
  sfx_label_distribution: { label: string; fraction: number; count: number }[];
  /** Per-reel SFX-in-context pattern (cadence / hook / moments). */
  sfx_context?: SfxContext | null;
  /** Collection-level aggregated SFX pattern (present on fingerprints). */
  sfx_pattern?: SfxCollectionPattern | null;
  media_overlay_pct: number;
  overlays_per_min: number;
  overlay_kind_distribution: Record<OverlayKind, number> | null;
  overlay_motion_distribution: Record<OverlayMotion, number> | null;
  overlay_region_distribution: Record<FrameRegion, number> | null;
  camera_motion_distribution: Record<CameraMotionKind, number> | null;
  camera_motion_dominant: CameraMotionKind | 'mixed' | null;
  camera_motion_confidence: number | null;
  caption_style: CaptionStyleProfile | null;
}

export interface HookArchetype {
  template: string;
  weight: number;
  examples: string[];
  description: string;
}

// ---- Inspiration → curation workflow types ----

export interface Collection {
  id: string;
  name: string;
  created_at: number;
  reels: { url: string; tags: ReelTag[] }[];
}

export type ReelTag =
  | 'style_reference'
  | 'content_reference'
  | 'structure_reference';

export interface LibraryReel {
  url: string;
  tags: ReelTag[];
  analysis?: ReelAnalysisResult;
  /** Set after hydrateLibraryReel. */
  hydrated?: boolean;
  /** Set when hydration loaded from cache (no fresh analyze pass). */
  from_cache?: boolean;
  /** Set when hydration failed. */
  error?: string;
}

export type AssetMethod =
  | 'web_capture'
  | 'library_search'
  | 'stock_search'
  | 'generate_image'
  | 'manual';

export type BrollAspect = '9:16' | '16:9' | '1:1' | '4:5' | '3:4' | 'original';
export type BrollFit =
  | 'fill'
  | 'contain'
  | 'pip'
  | 'split_top'
  | 'split_bottom'
  | 'split_left'
  | 'split_right';
export type SceneElementKind =
  | 'face_cam'
  | 'sticker'
  | 'logo'
  | 'reaction_gif'
  | 'emoji_burst'
  | 'lower_third'
  | 'other';

export type SceneAnimation =
  | 'none'
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_left'
  | 'pan_right'
  | 'ken_burns'
  | 'punch_in';

export type AnimationEasing = 'ease-in-out' | 'linear' | 'ease-out' | 'ease-in';

export interface ShotAsset {
  method: AssetMethod;
  web_capture: { url: string; focus: string } | null;
  library_search: { query: string } | null;
  stock_search: { query: string } | null;
  generate_image: { prompt: string } | null;
  manual: { instruction: string } | null;
  camera_move: string | null;
}

export type ShotOptionTier = 'ideal' | 'strong' | 'feasible' | 'fallback';

export interface ShotOption {
  tier: ShotOptionTier;
  /** How well this option fits the slot's narrative (0-1). */
  fit_score: number;
  /** Acquirability (0-1) for searchable methods; null for
   *  library_search / manual (depends on user, not on web search). */
  likelihood: number | null;
  broll_description: string;
  asset: ShotAsset;
  placement: {
    aspect: BrollAspect;
    fit: BrollFit;
    position: FrameRegion;
    scale: number;
  };
  source_type: string;
  rationale: string;
}

export interface SelectedMedia {
  url: string;
  kind: 'video' | 'image';
  origin:
    | 'extract_clip'
    | 'video_frame'
    | 'page_screenshot'
    | 'page_recording'
    | 'original_candidate';
  from_candidate_url: string;
  reason?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
  /** User-selected in/out inside this media file. Distinct from start_ms/end_ms,
   *  which are provenance offsets in the original source for extracted clips. */
  playback_start_ms?: number | null;
  playback_end_ms?: number | null;
  timestamp_ms?: number | null;
  scene_animation?: SceneAnimation;
  animation_scale?: number;
  animation_duration_ms?: number;
  animation_easing?: AnimationEasing;
  animation_origin?: FrameRegion;
  /** Free animation focal point, 0-1 across selected media. Overrides
   *  animation_origin when present. */
  animation_x?: number;
  animation_y?: number;
  media_start_zoom?: number;
  zoom_region?: FrameRegion;
  /** Free media zoom focal point, 0-1 across selected media. Overrides
   *  zoom_region when present. */
  zoom_x?: number;
  zoom_y?: number;
  zoom_scale?: number;
}

export interface ShotPlan {
  shot_idx: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  spoken_during: string;
  /** Word-level transcript timing for accurate captions. Optional so older
   *  cached plans continue to load and use estimated timing. */
  spoken_words?: TranscriptWord[];
  structure_role: string;
  /** Ranked shot options (ideal → fallback). Mirror options[0] in
   *  the flat fields below. */
  options: ShotOption[];
  broll_description: string;
  asset: ShotAsset;
  placement: {
    aspect: BrollAspect;
    fit: BrollFit;
    position: FrameRegion;
    scale: number;
  };
  /** Media overlay layers are disabled. Kept for old plan compatibility. */
  has_overlay: boolean;
  additional_elements: Array<{
    kind: SceneElementKind;
    description: string;
    position: FrameRegion;
    animation: string | null;
    layer: number;
    /** Auto-curated real web media for this overlay (image/GIF URL), or
     *  null/absent when not sourceable / not found. */
    resolved_url?: string | null;
    resolved_source_page?: string | null;
  }>;
  source_type: string;
  inspired_by: { url: string; shot_idx: number; pattern: string } | null;
  text_overlay: string;
  text_position: FrameRegion;
  animation_cue: string | null;
  scene_animation: SceneAnimation;
  /** Per-shot intensity multiplier for scene_animation (1 = default). */
  animation_scale?: number;
  /** How long scene_animation plays in ms; runs once then holds (no
   *  loop). Defaults to the shot's duration_ms when absent. */
  animation_duration_ms?: number;
  /** Timing curve for scene_animation (default 'ease-in-out'). */
  animation_easing?: AnimationEasing;
  /** Focal point the motion pivots around (default 'middle_center'). */
  animation_origin?: FrameRegion;
  /** Free animation focal point, 0-1 across selected media. Overrides
   *  animation_origin when present. */
  animation_x?: number;
  animation_y?: number;
  /** Per-shot media zoom focal point. Applied to the actual selected
   *  image/video, independent from motion animation. */
  zoom_region?: FrameRegion;
  /** Free media zoom focal point, 0-1 across selected media. Overrides
   *  zoom_region when present. */
  zoom_x?: number;
  zoom_y?: number;
  /** Per-shot media zoom multiplier (1 = no zoom). */
  zoom_scale?: number;
  /** Starting zoom for motion animations before animated delta applies. */
  media_start_zoom?: number;
  /** Object-position for the original/creator video in split layouts. */
  original_video_position?: FrameRegion;
  /** Split media sizing: fill/crop or contain/original-size. */
  split_media_fit?: 'fill' | 'contain';
  /** Overlay layout stack behavior for multiple selected clips. */
  overlay_stack_mode?: 'accumulate' | 'replace';
  /** Scene animation for the ORIGINAL/creator video in split layouts —
   *  mirrors scene_animation but targets the original-video half. */
  original_scene_animation?: SceneAnimation;
  original_animation_scale?: number;
  original_animation_duration_ms?: number;
  original_animation_easing?: AnimationEasing;
  original_animation_origin?: FrameRegion;
  original_animation_x?: number;
  original_animation_y?: number;
  original_media_start_zoom?: number;
  /** For contain / "Actual size" media: blurred autofill backdrop or
   *  underlying creator video background. */
  contain_background_mode?: 'autofill' | 'show_background';
  /** Per-shot subtitle position override; falls back to subtitle_spec.position
   *  when absent. Lets captions sit differently on different shots. */
  subtitle_position?: CaptionPosition;
  sfx_cue: string | null;
  clip_type: ClipType;
  rationale: string;
  selected_media?: SelectedMedia[];
}

export interface StructureSection {
  role: string;
  script_template: string;
  target_fill: string;
  target_start_ms: number;
  target_end_ms: number;
  shot_count: number;
  visual_signature: {
    dominant_clip_type: string;
    shot_type_pattern: string;
    placement_pattern: string;
    text_overlay_pattern: string;
    sfx_pattern: string;
    motion_pattern: string;
    scene_elements: string[];
  };
}

export interface SuggestedEdit {
  total_duration_ms: number;
  shots: ShotPlan[];
  structure_sections: StructureSection[];
  structure_confidence: 'high' | 'medium' | 'low';
  structure_rationale: string;
  structure_alternatives: StructureSection[][] | null;
  content_source_patterns: string[];
  style_summary: string;
  content_sources: string[];
  target_metrics: unknown | null;
  subtitle_spec: SubtitleSpec | null;
  target_video_path?: string | null;
  /** Inspiration-derived SFX placement pattern (copied from the
   *  fingerprint). Drives transcript-timeline SFX in preview + export. */
  sfx_plan?: SfxCollectionPattern | null;
  /** Command-bar SFX override (cadence/type), takes precedence over the
   *  inspiration pattern when set. */
  sfx_override?: SfxOverride | null;
  /** Hand-edited SFX timeline (set when the user drags a marker). When
   *  present it's the source of truth — preview + export use it verbatim. */
  sfx_events?:
    | { ms: number; type: SfxType; sound?: string; volume?: number }[]
    | null;
  /** Plan-wide SFX track gain, 0-1 (default 0.5). Per-event `volume` overrides. */
  sfx_volume?: number;
  /** Lead time (ms) to fire each SFX before its word's onset (default 0). */
  sfx_lead_ms?: number;
  /** Stable reel id keying the persistent prompt log (for remix). */
  reel_id?: string;
  /** Background/b-roll audio gain, 0-1 (default 0.25). */
  music_volume?: number;
  /** Original target video's own audio gain, 0-4 (default 1; >1 boosts). */
  narration_volume?: number;
}

export interface SfxOverride {
  cadence?: 'every_word' | 'sparse' | 'normal' | 'off';
  type?: SfxType;
  sound?: string;
}

export interface PromptLogEntry {
  at: number;
  reel_id: string;
  source: string;
  text: string;
  shot_idx?: number | null;
}

export interface RemixProfile {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  reel_id: string;
  source_summary: string;
  prompt_count: number;
  preference_instructions: string;
}

export type PlanEditOp =
  | { op: 'set_motion'; target: 'all' | number[]; animation: SceneAnimation }
  | {
      op: 'set_sfx';
      cadence?: 'every_word' | 'sparse' | 'normal' | 'off';
      type?: SfxType;
    }
  | {
      op: 'set_audio_level';
      track: 'sfx' | 'music';
      value?: number;
      delta?: number;
    }
  | { op: 'set_sfx_timing'; lead_ms: number }
  | { op: 'find_clip'; query: string }
  | { op: 'note'; message: string };

export interface PlanEditResult {
  ops: PlanEditOp[];
  reply: string;
  raw?: string;
}

export interface PlanAgentResult {
  plan: SuggestedEdit;
  reply: string;
  actions: { kind: 'find_clip'; query: string; shot_idx: number | null }[];
  toolLog: string[];
  clarify?: { question: string; options: string[] } | null;
  sounds?: { name: string; label: string | null }[];
}

/** Concrete burned-in subtitle style for the whole edit, resolved from
 *  the content reels' detected caption style. */
export interface SubtitleSpec {
  enabled: boolean;
  preset_id: string;
  preset_label: string;
  font_family: string;
  font_family_name: string;
  font_size: CaptionFontSize;
  /** Fine size multiplier on top of font_size (1 = preset default). */
  font_scale?: number;
  /** Outline thickness (px at 1x scale) for the 'bordered' treatment. */
  border_width?: number;
  position: CaptionPosition;
  chunking: CaptionChunking;
  words_per_chunk: number;
  casing: CaptionCasing;
  emphasis: CaptionEmphasis;
  animation: CaptionAnimation;
  text_treatment: CaptionTreatment;
  text_color: string;
  treatment_color: string | null;
  highlight_color: string | null;
  has_emoji: boolean;
  low_confidence: boolean;
}

export interface ExtractedClip {
  clip_id: string;
  start_ms: number;
  end_ms: number;
  reason: string;
  clip_url: string;
  file_path: string;
}

export type ExtractStage =
  | 'cache_check'
  | 'download'
  | 'transcribe'
  | 'rank'
  | 'scenes'
  | 'extract'
  | 'done'
  | 'error';

export interface ExtractProgressEvent {
  stage: ExtractStage;
  message: string;
  detail?: {
    transcript_windows?: { start_ms: number; end_ms: number; text: string }[];
    ranges?: { start_ms: number; end_ms: number; reason: string }[];
    scene_cuts_ms?: number[];
    cached?: boolean;
    completed?: number;
    total?: number;
  };
}

export type RecordStage = 'fetch' | 'plan' | 'record' | 'done' | 'error';

export interface RecordedPageSection {
  label: string;
  position_fraction: number;
  height_fraction: number;
}

export interface RecordPageScrollSegment {
  scroll_to: number;
  travel_ms: number;
  hold_ms: number;
}

export interface RecordProgressEvent {
  stage: RecordStage;
  message: string;
  detail?: {
    sections?: RecordedPageSection[];
    segments?: RecordPageScrollSegment[];
    reasoning?: string;
  };
}

export type RecordPageResponse =
  | {
      ok: true;
      recording_url: string;
      recording_path: string;
      duration_ms: number;
      page_title: string | null;
      reasoning: string;
      segments: RecordPageScrollSegment[];
    }
  | {
      ok: false;
      error: string;
      stage: 'fetch' | 'plan' | 'record';
    };

export type ScreenshotStage =
  | 'load'
  | 'scan'
  | 'rank'
  | 'capture'
  | 'done'
  | 'error';

export interface ScreenshotRegion {
  id: number;
  kind: 'heading' | 'image';
  preview: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotPick {
  id: number;
  reason: string;
}

export interface CapturedScreenshot {
  screenshot_id: string;
  region_id: number;
  reason: string;
  preview: string;
  kind: 'heading' | 'image';
  image_url: string;
  image_path: string;
  width: number;
  height: number;
}

export interface ScreenshotProgressEvent {
  stage: ScreenshotStage;
  message: string;
  detail?: {
    regions?: ScreenshotRegion[];
    picks?: ScreenshotPick[];
    page_title?: string | null;
  };
}

export type ScreenshotPageResponse =
  | {
      ok: true;
      page_title: string | null;
      screenshots: CapturedScreenshot[];
    }
  | {
      ok: false;
      error: string;
      stage: 'load' | 'scan' | 'rank' | 'capture';
    };

export type VideoFrameStage =
  | 'cache_check'
  | 'download'
  | 'transcribe'
  | 'rank'
  | 'scenes'
  | 'capture'
  | 'done'
  | 'error';

export interface VideoFramePick {
  timestamp_ms: number;
  reason: string;
}

export interface VideoFrame {
  frame_id: string;
  timestamp_ms: number;
  reason: string;
  image_url: string;
  image_path: string;
}

export interface VideoCandidateScene {
  scene_idx: number;
  start_ms: number;
  end_ms: number;
  spoken_text: string;
}

export interface VideoFrameProgressEvent {
  stage: VideoFrameStage;
  message: string;
  detail?: {
    scenes?: VideoCandidateScene[];
    picks?: VideoFramePick[];
    cached?: boolean;
  };
}

export type VideoFramesResponse =
  | {
      ok: true;
      frames: VideoFrame[];
      source_mp4_path: string;
      from_cache: boolean;
    }
  | {
      ok: false;
      error: string;
      stage: 'download' | 'transcribe' | 'rank' | 'scenes' | 'capture';
    };

export type ExtractClipsResponse =
  | {
      ok: true;
      clips: ExtractedClip[];
      source_mp4_path: string;
      from_cache: boolean;
    }
  | {
      ok: false;
      error: string;
      stage:
        | 'download'
        | 'audio'
        | 'transcribe'
        | 'rank'
        | 'scenes'
        | 'extract'
        | 'config';
    };

export interface MediaCandidate {
  source:
    | 'web_image'
    | 'web_video'
    | 'web_page'
    | 'generated_image'
    | 'user_provided'
    | 'unresolved';
  url: string;
  thumbnail_url?: string | null;
  source_page?: string | null;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  recommended_segment_ms?: { start_ms: number; end_ms: number } | null;
  notes?: string | null;
  /** Scroll style the research agent judged best for auto-recording
   *  this web_page candidate. Null/absent → 'slow'. */
  recommended_scroll?: 'linear' | 'slow' | 'hold' | null;
  /** Auto-captured screen recording (capture:// mp4) from the output. */
  auto_recording_url?: string | null;
  /** Auto-captured screenshot stills (capture:// images) from the output. */
  auto_screenshots?: AutoScreenshot[];
}

export interface AutoScreenshot {
  image_url: string;
  image_path?: string | null;
}

export interface AlternativeShot {
  broll_description: string;
  rationale: string;
  candidates: MediaCandidate[];
}

export interface ShotCuration {
  shot_idx: number;
  research_notes: string;
  candidates: MediaCandidate[];
  alternatives?: AlternativeShot[];
  failure_reason?: string | null;
  /** Present when the original shot idea returned no candidates and
   *  was auto-rewritten into a more-acquirable idea. The renderer
   *  prefers this shot's broll_description over the plan's. */
  rewritten_shot?: ShotPlan | null;
  /** Deprecated: media overlay layers are no longer rendered. */
  resolved_overlays?: ShotPlan['additional_elements'] | null;
  /** True when the shot is fulfilled by the user's own footage
   *  (asset.method === 'library_search') and web research was skipped
   *  on purpose — zero candidates is its expected final state. */
  library_fulfilled?: boolean;
}

export interface AgentTurn {
  turn_idx: number;
  message_text: string;
  function_calls: Array<{
    name: string;
    arguments: string;
    result: string;
  }>;
  web_search_calls: number;
}

export interface AgentTrace {
  shot_idx: number;
  turns: AgentTurn[];
  final_text: string;
  finished_at_turn: number;
  reason: 'completed' | 'max_turns_reached' | 'api_error';
  tokens: { input: number; output: number; total: number };
}

export interface CurationResult {
  shots: ShotCuration[];
  traces: AgentTrace[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  duration_ms: number;
  from_cache?: boolean;
}

export type HydrateLibraryReelResult =
  | {
      url: string;
      analysis: ReelAnalysisResult;
      from_cache: boolean;
      caption_text?: string | null;
    }
  | { url: string; error: string };

export type TargetInput =
  | { kind: 'reel_url'; url: string }
  | { kind: 'script'; text: string }
  | { kind: 'local_video'; filePath: string };

export type SynthesizeProgress =
  | { stage: 'transcribing'; message: string }
  | { stage: 'building_context'; message: string }
  | { stage: 'cache_hit'; message: string }
  | { stage: 'generating'; message: string; received_chars: number }
  | { stage: 'verifying'; message: string }
  | { stage: 'done'; message: string };

export interface PlanListEntry {
  key: string;
  version: number;
  created_at: number;
  target_label: string;
  target_kind: 'reel_url' | 'script' | 'local_video';
  target_file_path?: string | null;
  library_urls: string[];
  allow_copyrighted: boolean;
  user_instructions: string;
  shot_count: number;
  hook_preview: string | null;
}

export interface AnalyzeHistoryEntry {
  url: string;
  platform: string;
  duration_ms: number;
  width: number | null;
  height: number | null;
  caption_text: string | null;
  hook: string | null;
  shot_count: number;
  analyzed_at: number;
}

export interface RecordAnalysisInput {
  url: string;
  platform: string;
  duration_ms: number;
  width: number | null;
  height: number | null;
  caption_text: string | null;
  analysis: ReelAnalysisResult;
  analyzed_at: number;
}

export interface CuratorTurnEvent {
  shot_idx: number;
  turn: number;
  total_turns: number;
  tool_calls: Array<{
    name: string;
    summary: string;
    /** Populated on the second emission for this (shot_idx, turn) —
     *  short status of the tool's return value (e.g., "5 results",
     *  "matches=yes score=0.87", "FAILED: auth_wall_redirect"). */
    result_summary?: string;
  }>;
  finished: boolean;
}

export interface CuratorClarificationRequest {
  request_id: string;
  shot_idx: number;
  question: string;
  options: string[];
  reason: string;
}

export interface BriefSection {
  title: string;
  tag?: string;
  directives: string[];
}

export interface ScriptBeat {
  says: string;
  footage: string;
  overlay: string | null;
}

export interface EditingBrief {
  summary: string;
  sections: BriefSection[];
  script_map: ScriptBeat[];
  ai_generated: boolean;
}

declare global {
  interface Window {
    api: {
      resolveReel: (url: string) => Promise<ResolveResult>;
      recordPrompt: (entry: PromptLogEntry) => Promise<boolean>;
      getPromptLog: (reelId?: string) => Promise<PromptLogEntry[]>;
      listRemixProfiles: () => Promise<RemixProfile[]>;
      saveRemixProfile: (input: {
        plan: SuggestedEdit;
        name?: string | null;
      }) => Promise<RemixProfile | { error: string }>;
      resolveSfxUrl: (query: string) => Promise<string | null>;
      searchSfxLibrary: (
        query: string,
      ) => Promise<{ name: string; label: string | null; score: number }[]>;
      agentEditPlan: (arg: {
        command: string;
        plan: SuggestedEdit;
        narrationPath?: string | null;
      }) => Promise<PlanAgentResult>;
      getSfxTimeline: (arg: {
        narrationPath: string;
        shots: {
          sfx_cue: string | null;
          start_ms: number;
          duration_ms: number;
        }[];
        sfxPlan: SfxCollectionPattern | null;
        override?: SfxOverride | null;
        events?:
          | { ms: number; type: SfxType; sound?: string; volume?: number }[]
          | null;
      }) => Promise<
        {
          ms: number;
          url: string;
          word: string;
          type: SfxType;
          sound?: string;
          volume?: number;
        }[]
      >;
      analyzeReel: (input: {
        playableUrl: string;
        durationMs: number;
      }) => Promise<ReelAnalysisResult>;
      generateBrief: (input: {
        analysis: ReelAnalysisResult;
        durationMs: number;
      }) => Promise<EditingBrief>;
      loadLibrary: () => Promise<{ url: string; tags: ReelTag[] }[]>;
      saveLibrary: (
        reels: { url: string; tags: ReelTag[] }[],
      ) => Promise<void>;
      listCollections: () => Promise<Collection[]>;
      createCollection: (name: string) => Promise<Collection>;
      renameCollection: (id: string, name: string) => Promise<Collection[]>;
      deleteCollection: (id: string) => Promise<Collection[]>;
      saveCollectionReels: (
        id: string,
        reels: { url: string; tags: ReelTag[] }[],
      ) => Promise<void>;
      loadCachedAnalysis: (url: string) => Promise<ReelAnalysisResult | null>;
      listAnalyzeHistory: () => Promise<AnalyzeHistoryEntry[]>;
      recordAnalysis: (
        input: RecordAnalysisInput,
      ) => Promise<AnalyzeHistoryEntry[]>;
      deleteAnalyzeHistory: (url: string) => Promise<AnalyzeHistoryEntry[]>;
      hydrateLibraryReel: (
        url: string,
        force?: boolean,
      ) => Promise<HydrateLibraryReelResult>;
      pickVideoFile: () => Promise<string | null>;
      pickVideoFiles: () => Promise<string[]>;
      prepareLocalVideoPreview: (filePath: string) => Promise<string>;
      localVideoUrl: (filePath: string) => Promise<string | null>;
      fetchReelThumbnail: (url: string) => Promise<string | null>;
      synthesizePlan: (input: {
        library: { url: string; tags: ReelTag[]; analysis: ReelAnalysisResult }[];
        target?: TargetInput;
        allowCopyrightedMedia?: boolean;
        userInstructions?: string;
        reuseLastTarget?: boolean;
      }) => Promise<SuggestedEdit>;
      listCachedPlans: () => Promise<PlanListEntry[]>;
      loadCachedPlan: (
        key: string,
      ) => Promise<
        | {
            plan: SuggestedEdit;
            curation: CurationResult | null;
            meta: PlanListEntry | null;
          }
        | null
      >;
      savePlan: (plan: SuggestedEdit) => Promise<{ ok: boolean; error?: string }>;
      curatePlan: (
        plan: SuggestedEdit,
        options?: { force?: boolean; userPrompt?: string },
      ) => Promise<CurationResult>;
      filterExistingScreenshots: (input: {
        plan: SuggestedEdit;
        curation: CurationResult;
      }) => Promise<CurationResult | { error: string }>;
      autoAssignMedia: (input: {
        plan: SuggestedEdit;
        curation: CurationResult;
      }) => Promise<SuggestedEdit | { error: string }>;
      stopCurate: () => Promise<boolean>;
      curateShot: (input: {
        plan: SuggestedEdit;
        shot_idx: number;
        user_prompt?: string;
      }) => Promise<
        | { curation: ShotCuration; trace: AgentTrace }
        | { error: string }
      >;
      addShotClip: (input: {
        plan: SuggestedEdit;
        shot_idx: number;
        description: string;
      }) => Promise<
        | { curation: ShotCuration; added: number; foundButDuplicate: boolean }
        | { error: string }
      >;
      savePastedMedia: (input: {
        data: string;
        mime: string;
        name?: string | null;
      }) => Promise<{ entry: PastedMediaEntry } | { error: string }>;
      listPastedMedia: () => Promise<PastedMediaEntry[]>;
      regenerateShot: (input: {
        shot_idx: number;
        user_prompt: string;
      }) => Promise<
        | { curation: ShotCuration; trace: AgentTrace }
        | { error: string }
      >;
      rewriteShotIdeas: (input: {
        plan: SuggestedEdit;
        shot_idxs?: number[];
        user_prompt: string;
      }) => Promise<{ shots: ShotPlan[] } | { error: string }>;
      continueShot: (input: {
        shot_idx: number;
        user_prompt: string;
      }) => Promise<
        | { curation: ShotCuration; trace: AgentTrace }
        | { error: string }
      >;
      extractClips: (input: {
        request_id: string;
        candidate_url: string;
        source_page?: string | null;
        shot_idx: number;
        broll_description: string;
        spoken_during: string;
        shot_duration_ms?: number | null;
        force?: boolean;
      }) => Promise<ExtractClipsResponse>;
      onExtractClipsProgress: (
        cb: (payload: {
          request_id: string;
          event: ExtractProgressEvent;
        }) => void,
      ) => () => void;
      recordPage: (input: {
        request_id: string;
        candidate_url: string;
        shot_idx: number;
        broll_description: string;
        spoken_during: string;
        shot_duration_ms?: number | null;
      }) => Promise<RecordPageResponse>;
      onRecordPageProgress: (
        cb: (payload: {
          request_id: string;
          event: RecordProgressEvent;
        }) => void,
      ) => () => void;
      screenshotPage: (input: {
        request_id: string;
        candidate_url: string;
        shot_idx: number;
        broll_description: string;
      }) => Promise<ScreenshotPageResponse>;
      onScreenshotPageProgress: (
        cb: (payload: {
          request_id: string;
          event: ScreenshotProgressEvent;
        }) => void,
      ) => () => void;
      videoScreenshots: (input: {
        request_id: string;
        candidate_url: string;
        source_page?: string | null;
        shot_idx: number;
        broll_description: string;
        spoken_during: string;
        shot_duration_ms?: number | null;
        force?: boolean;
      }) => Promise<VideoFramesResponse>;
      onVideoScreenshotsProgress: (
        cb: (payload: {
          request_id: string;
          event: VideoFrameProgressEvent;
        }) => void,
      ) => () => void;
      onCurateProgress: (
        cb: (payload: {
          curation: ShotCuration;
          completed: number;
          total: number;
        }) => void,
      ) => () => void;
      /** Streaming per-shot partials: fired as soon as a shot's
       *  research lands (candidates, footage pending) and again after
       *  each candidate's auto-capture finishes. */
      onCurateShotPartial: (
        cb: (payload: { curation: ShotCuration }) => void,
      ) => () => void;
      onSynthesizeProgress: (
        cb: (payload: SynthesizeProgress) => void,
      ) => () => void;
      onCuratorTurn: (
        cb: (payload: CuratorTurnEvent) => void,
      ) => () => void;
      onCuratorClarification: (
        cb: (payload: CuratorClarificationRequest) => void,
      ) => () => void;
      openExternal: (url: string) => Promise<void>;
      getFontDataUrl: (id: string) => Promise<string | null>;
      replyCuratorClarification: (input: {
        request_id: string;
        answer: string;
      }) => Promise<{ ok: boolean }>;
      exportReel: (input: {
        request_id: string;
        plan: SuggestedEdit;
        curation: CurationResult | null;
        fps?: number;
        target_video_url?: string | null;
        target_video_path?: string | null;
      }) => Promise<ExportReelResponse>;
      stopExport: (request_id: string) => Promise<void>;
      onExportProgress: (
        cb: (payload: { request_id: string; event: ExportProgressEvent }) => void,
      ) => () => void;
      showItemInFolder: (filePath: string) => Promise<void>;
    };
  }
}
