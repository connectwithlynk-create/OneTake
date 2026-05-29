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
}

export interface TextMoment {
  text: string;
  bbox: NormBBox;
  region: FrameRegion;
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
  media_overlay_pct: number;
  overlays_per_min: number;
  overlay_kind_distribution: Record<OverlayKind, number> | null;
  overlay_motion_distribution: Record<OverlayMotion, number> | null;
  overlay_region_distribution: Record<FrameRegion, number> | null;
}

export interface HookArchetype {
  template: string;
  weight: number;
  examples: string[];
  description: string;
}

// ---- Inspiration → curation workflow types ----

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
  timestamp_ms?: number | null;
}

export interface ShotPlan {
  shot_idx: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  spoken_during: string;
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
  additional_elements: Array<{
    kind: SceneElementKind;
    description: string;
    position: FrameRegion;
    animation: string | null;
  }>;
  source_type: string;
  inspired_by: { url: string; shot_idx: number; pattern: string } | null;
  text_overlay: string;
  text_position: FrameRegion;
  animation_cue: string | null;
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
  | { url: string; analysis: ReelAnalysisResult; from_cache: boolean }
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

declare global {
  interface Window {
    api: {
      resolveReel: (url: string) => Promise<ResolveResult>;
      analyzeReel: (input: {
        playableUrl: string;
        durationMs: number;
      }) => Promise<ReelAnalysisResult>;
      loadLibrary: () => Promise<{ url: string; tags: ReelTag[] }[]>;
      saveLibrary: (
        reels: { url: string; tags: ReelTag[] }[],
      ) => Promise<void>;
      loadCachedAnalysis: (url: string) => Promise<ReelAnalysisResult | null>;
      listAnalyzeHistory: () => Promise<AnalyzeHistoryEntry[]>;
      recordAnalysis: (
        input: RecordAnalysisInput,
      ) => Promise<AnalyzeHistoryEntry[]>;
      deleteAnalyzeHistory: (url: string) => Promise<AnalyzeHistoryEntry[]>;
      hydrateLibraryReel: (url: string) => Promise<HydrateLibraryReelResult>;
      pickVideoFile: () => Promise<string | null>;
      fetchReelThumbnail: (url: string) => Promise<string | null>;
      synthesizePlan: (input: {
        library: { url: string; tags: ReelTag[]; analysis: ReelAnalysisResult }[];
        target: TargetInput;
        allowCopyrightedMedia?: boolean;
        userInstructions?: string;
      }) => Promise<SuggestedEdit>;
      listCachedPlans: () => Promise<PlanListEntry[]>;
      loadCachedPlan: (
        key: string,
      ) => Promise<
        | { plan: SuggestedEdit; curation: CurationResult | null }
        | null
      >;
      savePlan: (plan: SuggestedEdit) => Promise<{ ok: boolean; error?: string }>;
      curatePlan: (plan: SuggestedEdit) => Promise<CurationResult>;
      stopCurate: () => Promise<boolean>;
      curateShot: (input: {
        plan: SuggestedEdit;
        shot_idx: number;
        user_prompt?: string;
      }) => Promise<
        | { curation: ShotCuration; trace: AgentTrace }
        | { error: string }
      >;
      regenerateShot: (input: {
        shot_idx: number;
        user_prompt: string;
      }) => Promise<
        | { curation: ShotCuration; trace: AgentTrace }
        | { error: string }
      >;
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
      onSynthesizeProgress: (
        cb: (payload: SynthesizeProgress) => void,
      ) => () => void;
      onCuratorTurn: (
        cb: (payload: CuratorTurnEvent) => void,
      ) => () => void;
      onCuratorClarification: (
        cb: (payload: CuratorClarificationRequest) => void,
      ) => () => void;
      replyCuratorClarification: (input: {
        request_id: string;
        answer: string;
      }) => Promise<{ ok: boolean }>;
    };
  }
}
