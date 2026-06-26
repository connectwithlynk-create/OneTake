// Synthesis / suggestion engine — shot-pacing model.
//
// Mental model: an editor lays down voiceover, then cuts SHOTS on a
// separate visual rhythm. A sentence may span 3 shots; a shot may
// cover 2 sentences. The transcript flows underneath the cuts; it
// doesn't define them.
//
// This engine reflects that:
//   1. Pre-compute the SHOT TIMELINE for the target reel by sampling
//      shot durations from the inspiration's actual shot distribution
//      (preserves variance), tiling until target duration is covered.
//   2. For each shot, attach the transcript words spoken during it.
//   3. Ask the LLM to fill in CONTENT per shot (b-roll, source type,
//      text overlay, SFX cue) — timing is fixed.
//
// This guarantees pacing matches inspiration (a real bug in the
// previous "let LLM derive beats from transcript" approach: it
// produced 0.1s beats unrelated to inspiration cadence).
//
// Inspiration is also INSPIRATION not a literal clip library — the
// LLM extracts content_source_patterns ("screen recording of
// company website") and invents subject-specific content per shot.
import OpenAI from 'openai';
import type { ReelAnalysisResult } from './analyze';
import type { EditingBrief } from './brief';
import type { ContentVocabulary } from './content-vocab';
import { summarizeShot } from './content-vocab';
import type {
  CollectionFingerprint,
  SfxCollectionPattern,
} from './fingerprint';
import type { SfxType } from './sfx-classify';
import { deriveSubtitleSpec, type SubtitleSpec } from './subtitle-spec';
import type { TranscriptWord } from './transcribe';
import type { CaptionPosition, ClipType, FrameRegion, ReelShot } from './types';

// gpt-4o handles the multi-idea schema reliably; mini was emitting 1
// idea per shot or stubbed-empty entries due to truncation + weak
// instruction-following. Cost is ~$0.04/plan vs $0.002 for mini —
// acceptable for the per-plan cost.
const MODEL = 'gpt-4o';
const MAX_TOKENS = 16384;

// ---------- public types ----------

/** Native aspect ratio of the b-roll asset. The editing agent uses
 *  this together with `fit` to know how to place it on the 9:16
 *  reel canvas. */
export type BrollAspect =
  | '9:16'
  | '16:9'
  | '1:1'
  | '4:5'
  | '3:4'
  | 'original';

/** How the b-roll fills the 9:16 reel canvas. */
export type BrollFit =
  | 'fill'        // fullbleed; crop excess
  | 'contain'     // letterbox; preserve aspect
  | 'pip'         // small inset on top of background
  | 'split_top'
  | 'split_bottom'
  | 'split_left'
  | 'split_right';

export interface BrollPlacement {
  aspect: BrollAspect;
  fit: BrollFit;
  /** Where the b-roll sits in the 9:16 canvas. For 'fill' this is
   *  effectively 'middle_center'. For 'pip' and split fits this is
   *  meaningful. */
  position: FrameRegion;
  /** Fraction of canvas area the b-roll occupies, 0-1. 1.0 = full
   *  canvas (fill); ~0.3 = typical PiP; 0.5 = split. */
  scale: number;
}

/** A render-time motion preset applied to a shot's base media (the
 *  b-roll / screen recording / still). These are the canonical "scene
 *  animations" the user can pick per shot — equivalent to the camera
 *  moves a human editor keyframes (Ken Burns push-in, slow pan, punch
 *  zoom). The free-text `animation_cue` / `asset.camera_move` remain as
 *  descriptive hints; this enum is the structured, render+preview-able
 *  form derived from them. */
export type SceneAnimation =
  | 'none'
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_left'
  | 'pan_right'
  | 'ken_burns'
  | 'punch_in';

/** Timing curve for a scene animation. Maps 1:1 to a CSS
 *  animation-timing-function keyword in preview, and to the equivalent
 *  interpolation at render time. */
export type AnimationEasing = 'ease-in-out' | 'linear' | 'ease-out' | 'ease-in';

/** Extra elements composited on top of the b-roll besides the burned-in
 *  text caption. Mirrors what's typically called "stickers, GIFs,
 *  reaction overlays, face cams" in the editor. */
export type SceneElementKind =
  | 'face_cam'
  | 'sticker'
  | 'logo'
  | 'reaction_gif'
  | 'emoji_burst'
  | 'lower_third'
  | 'other';

export interface SceneElement {
  kind: SceneElementKind;
  /** What the element is — described in target-subject terms when
   *  applicable (e.g., "creator's reaction face cam in the corner",
   *  "small Ornadyne logo lockup", "🔥 emoji burst"). */
  description: string;
  position: FrameRegion;
  /** Animation hint (e.g., "scale-in pop", "static", "spinning") or null. */
  animation: string | null;
  /** Stacking order, 1-based. Layer 1 sits closest to the base video;
   *  higher layers paint on top. The editor exposes up to 3 layers. */
  layer: number;
  /** Auto-curated REAL media for this overlay — a web-sourced image/GIF
   *  the curator found to match the element (NEVER AI-generated; web only).
   *  Null/absent when the kind isn't web-sourceable (e.g. face_cam) or
   *  nothing was found, in which case the preview shows a placeholder.
   *  Filled in by curator/overlay-curate.ts. */
  resolved_url?: string | null;
  /** Page the resolved media was found on (provenance). */
  resolved_source_page?: string | null;
}

/** How an editing agent should acquire the b-roll for a shot. The
 *  agent dispatches on `method` and reads the corresponding parameter
 *  block. Exactly one of the parameter fields is populated per method;
 *  the others are null. */
export type AssetMethod =
  | 'web_capture'
  | 'library_search'
  | 'stock_search'
  | 'generate_image'
  | 'manual';

export interface ShotAsset {
  method: AssetMethod;
  /** web_capture: URL the agent navigates to + the visual focus to
   *  capture (which section, what to zoom into, etc.). */
  web_capture: { url: string; focus: string } | null;
  /** library_search: a semantic search query the agent runs against
   *  the user's local footage library. */
  library_search: { query: string } | null;
  /** stock_search: a search query for a stock footage API (Pexels,
   *  Pond5, getty, etc.). */
  stock_search: { query: string } | null;
  /** generate_image: a text-to-image prompt for image generation. */
  generate_image: { prompt: string } | null;
  /** manual: a free-text instruction for the human user when no
   *  automation method fits ("shoot a 2s close-up of the prop"). */
  manual: { instruction: string } | null;
  /** Optional camera move applied at render time. Useful for still
   *  images / static screen recordings (e.g., "zoom in 1.15x over the
   *  shot", "pan left to right", "static"). Null when no move. */
  camera_move: string | null;
}

/** Visual treatment that's characteristic of a structural section —
 *  extracted from the inspiration's actual editing patterns. The
 *  per-shot fill within this section will tend to follow these. */
export interface SectionVisualSignature {
  /** Dominant clip type in this section (talking_head / broll_visual / etc.). */
  dominant_clip_type: string;
  /** Ordered shot-type recipe for this section, preserving the script-positioned
   *  sequence instead of only the dominant bucket. */
  shot_type_pattern: string;
  /** Where the b-roll typically sits — fullbleed, PiP, split, etc. */
  placement_pattern: string;
  /** Text-overlay treatment (e.g., "large center caption, big font",
   *  "small bottom-third caption", "none"). */
  text_overlay_pattern: string;
  /** SFX treatment (e.g., "vocal hit on cut in", "silent open"). */
  sfx_pattern: string;
  /** Animation / motion treatment (e.g., "zoom-in over the shot",
   *  "type-on caption", "static cut"). */
  motion_pattern: string;
  /** Additional scene-element treatments observed in inspiration
   *  for this section ("subscribe sticker appears", "face cam corner"),
   *  empty when none. */
  scene_elements: string[];
}

export interface StructureSection {
  /** Role label — typically 'hook', 'intro', 'body', 'evidence', 'cta',
   *  but the LLM may invent more specific labels when the inspiration
   *  exhibits a clearer pattern. */
  role: string;
  /** The inspiration's literal script template with placeholders for
   *  this section. E.g., "Who's the <descriptor>?" or "This is
   *  <subject>, and they <action>." Built by abstracting the
   *  inspiration's spoken_window text into a fill-in pattern. */
  script_template: string;
  /** What the TARGET transcript literally says for this section —
   *  the words from the target that fit the script_template. E.g.,
   *  "What's this startup that's building robotic surveillance birds?" */
  target_fill: string;
  /** Where this section starts in the target reel (ms). Anchored to
   *  a transcript word boundary. */
  target_start_ms: number;
  /** Where this section ends in the target reel (ms). */
  target_end_ms: number;
  /** Expected number of shots within this section, derived from the
   *  pacing template's shots that fall in target_start_ms..target_end_ms. */
  shot_count: number;
  /** Visual treatment patterns characteristic of this section,
   *  extracted from the inspiration's actual editing. */
  visual_signature: SectionVisualSignature;
}

export type StructureConfidence = 'high' | 'medium' | 'low';

/** A shot-option tier. Reflects how easy the asset is to actually
 *  acquire. The synthesizer emits a small ladder of options per shot
 *  so the editor / curator has fallbacks if the ideal is unobtainable. */
export type ShotOptionTier = 'ideal' | 'strong' | 'feasible' | 'fallback';

/** One b-roll option for a shot slot. The slot's options[] is ranked
 *  ideal → fallback. options[0] is mirrored to the shot's top-level
 *  broll_description / asset / placement / source_type for
 *  backward-compat with downstream consumers (curator, UI). */
export interface ShotOption {
  tier: ShotOptionTier;
  /** How well this option fits the slot's narrative / spoken_during
   *  context, 0-1. Higher = better fit. Always set for every option. */
  fit_score: number;
  /** How easily the asset can be acquired via web search, 0-1, OR
   *  null when the asset method isn't search-based.
   *  - web_capture / stock_search / generate_image → number derived
   *    from a real lightweight search (verify-options.ts post-pass)
   *  - library_search / manual → null (depends on the user's footage
   *    or what they shoot; not searchable)
   *  Higher number = more findable online. */
  likelihood: number | null;
  /** Subject-specific b-roll description for this tier. */
  broll_description: string;
  /** Acquisition spec. */
  asset: ShotAsset;
  /** Canvas composition. */
  placement: BrollPlacement;
  /** Source pattern this option draws from. */
  source_type: string;
  /** One sentence — why this tier was chosen / its tradeoff vs others. */
  rationale: string;
}

/** What the user picked as the final piece of media for a shot. Set
 *  by the renderer when the user clicks "✓ Use this" on any of the
 *  extracted clips / video frames / page screenshots / record-page
 *  output / original candidate. The downstream editor reads this when
 *  composing the final reel. Null when nothing has been picked yet. */
export interface SelectedMedia {
  /** Final URL the editor should use (capture:// / clips:// / http(s)://). */
  url: string;
  /** Whether the editor should treat this as a video clip or a still image. */
  kind: 'video' | 'image';
  /** Origin tag so we can debug / show provenance in the UI. */
  origin:
    | 'extract_clip'
    | 'video_frame'
    | 'page_screenshot'
    | 'page_recording'
    | 'original_candidate';
  /** The candidate URL the selected media was derived from. */
  from_candidate_url: string;
  /** Short rationale — usually the LLM's "reason" for that clip/frame. */
  reason?: string | null;
  /** For sub-clips that came from a longer source: the in/out times
   *  within the source video. Null for full-candidate selections and
   *  for screenshots/frames. */
  start_ms?: number | null;
  end_ms?: number | null;
  /** User-selected in/out inside the selected media file itself. This is
   *  distinct from start_ms/end_ms, which are provenance offsets in the
   *  original source video for extracted clips. */
  playback_start_ms?: number | null;
  playback_end_ms?: number | null;
  /** For single-frame screenshots from a video — the timestamp the
   *  frame was extracted at. */
  timestamp_ms?: number | null;
  scene_animation?: SceneAnimation;
  animation_scale?: number;
  animation_duration_ms?: number;
  animation_easing?: AnimationEasing;
  animation_origin?: FrameRegion;
  animation_x?: number;
  animation_y?: number;
  media_start_zoom?: number;
  zoom_region?: FrameRegion;
  zoom_x?: number;
  zoom_y?: number;
  zoom_scale?: number;
}

export interface ShotPlan {
  shot_idx: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  /** Transcript words playing during this shot — may span multiple
   *  sentences or be empty if the shot lands on silence. */
  spoken_during: string;
  /** Word-level transcript timing for accurate burned-in subtitles.
   *  Timestamps are reel-global ms, matching start_ms/end_ms. */
  spoken_words?: TranscriptWord[];
  /** Which structural section this shot belongs to (matches one of
   *  the SuggestedEdit.structure_sections role labels). */
  structure_role: string;
  /** Ranked list of shot options for this slot. options[0] is the
   *  ideal (lowest likelihood, highest fit); the last entry is the
   *  high-likelihood fallback. The fields below (broll_description,
   *  asset, placement, source_type) mirror options[0] so existing
   *  consumers don't break. */
  options: ShotOption[];
  /** Concrete b-roll to show, in human-readable form. Mirrors
   *  options[0].broll_description. */
  broll_description: string;
  /** Machine-actionable acquisition spec. Mirrors options[0].asset. */
  asset: ShotAsset;
  /** Canvas composition. Mirrors options[0].placement. */
  placement: BrollPlacement;
  /** Media overlay layers are disabled. Kept as a compatibility field for
   *  older plan/caching code; new plans always set false. */
  has_overlay: boolean;
  /** Media overlay layers are disabled. Kept as a compatibility field;
   *  new plans always set []. */
  additional_elements: SceneElement[];
  /** Short label for the content-source pattern this shot draws from.
   *  Mirrors options[0].source_type. */
  source_type: string;
  /** Optional reference to a specific inspiration shot that
   *  exemplifies the source_type — traceability only, not literal reuse. */
  inspired_by: {
    url: string;
    shot_idx: number;
    pattern: string;
  } | null;
  text_overlay: string;
  text_position: FrameRegion;
  /** Free-text motion hint kept for provenance / curator context. */
  animation_cue: string | null;
  /** Structured motion preset applied to the base media at render time
   *  and in the live preview. Derived from the inspiration's motion
   *  pattern (animation_cue / camera_move) during synthesis; the user
   *  can override it with the animation picker. */
  scene_animation: SceneAnimation;
  /** Per-shot intensity multiplier for scene_animation, 1 = the preset's
   *  default magnitude. The user tunes it with the intensity slider;
   *  drives the --anim-intensity CSS var in preview and the keyframe
   *  amount at render time. Optional — defaults to 1 when absent. */
  animation_scale?: number;
  /** How long the scene animation plays, in ms. The motion runs ONCE
   *  over this span then holds on its end state — it does not loop. When
   *  absent it defaults to the shot's full duration (duration_ms), so the
   *  move lasts exactly as long as the shot. The user can shorten it
   *  (motion completes early and holds) via the duration slider. */
  animation_duration_ms?: number;
  /** Timing curve for scene_animation. Optional — defaults to
   *  'ease-in-out' when absent. */
  animation_easing?: AnimationEasing;
  /** Focal point the motion pivots around (transform-origin) — e.g. a
   *  zoom that pushes toward the subject's face. A 3x3 grid cell.
   *  Optional — defaults to 'middle_center'. */
  animation_origin?: FrameRegion;
  animation_x?: number;
  animation_y?: number;
  /** Per-shot media zoom focal point. Applied to selected image/video,
   *  independent from motion animation. Optional — defaults to center. */
  zoom_region?: FrameRegion;
  zoom_x?: number;
  zoom_y?: number;
  /** Per-shot media zoom multiplier, 1 = no zoom. Optional. */
  zoom_scale?: number;
  media_start_zoom?: number;
  original_video_position?: FrameRegion;
  split_media_fit?: 'fill' | 'contain';
  overlay_stack_mode?: 'accumulate' | 'replace';
  /** Scene animation applied to the ORIGINAL/creator video in a split
   *  layout (the half that isn't the b-roll). Mirrors scene_animation
   *  and friends but targets the original-video block. Only meaningful
   *  when placement.fit is a split layout; ignored otherwise. */
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
  /** Per-shot subtitle position override. When set, this shot's burned-in
   *  caption uses this position instead of the plan-wide subtitle_spec.position
   *  — so captions can sit in different places on different shots. Optional;
   *  falls back to the global spec when absent. */
  subtitle_position?: CaptionPosition;
  sfx_cue: string | null;
  clip_type: ClipType;
  rationale: string;
  /** Ordered list of media the user picked for this shot. Each entry
   *  is one click of a "Use this" toggle (any candidate / extracted
   *  clip / video frame / page screenshot / page recording). The
   *  editor splits the shot's duration evenly across the picks at
   *  composition time. Empty / undefined until the user picks
   *  something. */
  selected_media?: SelectedMedia[];
}

export interface SuggestedEdit {
  total_duration_ms: number;
  shots: ShotPlan[];
  /** Detected narrative structure (hook → intro → body → cta etc.)
   *  the inspiration follows, applied to the target. */
  structure_sections: StructureSection[];
  /** How clearly inspiration converged on this structure.
   *  'low' means the user should review / pick. */
  structure_confidence: StructureConfidence;
  /** One-sentence explanation of why this structure was chosen. */
  structure_rationale: string;
  /** When confidence is 'low' / 'medium', alternative structures the
   *  LLM considered. Null when confidence is 'high'. The eval prints
   *  these so the user can override on a follow-up run. */
  structure_alternatives: StructureSection[][] | null;
  /** High-level patterns the LLM extracted from the inspiration. */
  content_source_patterns: string[];
  style_summary: string;
  content_sources: string[];
  target_metrics: CollectionFingerprint | null;
  /** Concrete burned-in subtitle style to apply to the whole edit,
   *  resolved from the content reels' detected caption style. Null when
   *  the inspiration burns in no spoken-word captions. See
   *  subtitle-spec.ts / deriveSubtitleSpec. */
  subtitle_spec: SubtitleSpec | null;
  /** Absolute path to the uploaded target video, when target kind is
   *  local_video. Renderer uses this as the always-loaded base preview. */
  target_video_path?: string | null;
  /** The collection's learned SFX-in-context pattern, copied from the
   *  fingerprint so export can place SFX by cadence/hook/emphasis over the
   *  narration's words (not just one hit per cut). Null when unavailable. */
  sfx_plan?: SfxCollectionPattern | null;
  /** User override of the SFX timeline (via the command bar). When set, it
   *  takes precedence over the inspiration cadence/type. */
  sfx_override?: SfxOverride | null;
  /** Materialized, hand-editable SFX timeline (set once the user drags a
   *  marker on the timeline). When present it is the source of truth for
   *  SFX placement — preview + export use it verbatim, skipping auto
   *  generation. ms = reel-time onset. */
  sfx_events?:
    | { ms: number; type: SfxType; sound?: string; volume?: number }[]
    | null;
  /** Plan-wide SFX track gain, 0-1 (default 0.5). Per-event `volume` on an
   *  sfx_events entry overrides this for that event. Set by the command bar. */
  sfx_volume?: number;
  /** Lead time (ms) to fire each SFX BEFORE its word's spoken onset.
   *  Positive = earlier; negative = later. Default 0 (on the word). */
  sfx_lead_ms?: number;
  /** Stable id for this reel, assigned at first synthesis and carried
   *  through regenerations. Keys the persistent prompt log so a future
   *  "remix" can recover how the user shaped this exact reel. */
  reel_id?: string;
  /** Background/b-roll audio gain, 0-1 (default 0.25). */
  music_volume?: number;
  /** Original target video's own audio gain, 0-1 (default 1). This is the
   *  voiceover/talking-head track the reel is built on. */
  narration_volume?: number;
}

/** One recorded user prompt, for the per-reel prompt history that will
 *  drive "remix". Sources: synthesis, plan regeneration, library curation,
 *  per-shot regenerate/continue, add-clip, and the command-bar agent. */
export interface PromptLogEntry {
  /** Unix ms when the prompt was issued. */
  at: number;
  /** Reel this prompt belongs to (plan.reel_id). */
  reel_id: string;
  /** Where it came from, e.g. 'synthesis' | 'regenerate_plan' | 'curate' |
   *  'regenerate_shot' | 'continue_shot' | 'add_clip' | 'command_bar'. */
  source: string;
  /** The user's text. */
  text: string;
  /** Target shot (array index) when the prompt was shot-scoped. */
  shot_idx?: number | null;
}

/** User SFX override produced by the command-bar agent. */
export interface SfxOverride {
  /** Placement density relative to spoken words. */
  cadence?: 'every_word' | 'sparse' | 'normal' | 'off';
  /** Force a specific SFX acoustic type. */
  type?: SfxType;
  /** Force a specific named library sound (free-text query), e.g. "iphone
   *  message notification" — overrides type. */
  sound?: string;
}

/** A single structured edit the command-bar agent can apply to a plan.
 *  The LLM only chooses ops; the renderer applies them deterministically. */
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
  /** One-line natural-language confirmation of what was done. */
  reply: string;
  /** Raw model output, included only when no ops parsed (for debugging). */
  raw?: string;
}

/** Result of the tool-calling command-bar agent: the (possibly mutated) plan
 *  to adopt, a natural-language reply, queued actions the renderer must run
 *  (e.g. curation), and a tool-call transcript for transparency. */
export interface PlanAgentResult {
  plan: SuggestedEdit;
  reply: string;
  actions: { kind: 'find_clip'; query: string; shot_idx: number | null }[];
  toolLog: string[];
  /** Set when the agent needs the user to disambiguate; the command bar
   *  renders the options and re-runs with the chosen one. */
  clarify?: { question: string; options: string[] } | null;
  /** Library sounds the agent surfaced this run (via search_sfx_library), so
   *  the command bar can let the user preview every one it mentioned. */
  sounds?: { name: string; label: string | null }[];
}

// ---------- shot-timeline planning ----------

interface ShotSlot {
  shot_idx: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  spoken_during: string;
  spoken_words: TranscriptWord[];
}

export interface PacingTemplate {
  /** The inspiration reel whose shot sequence drove the pacing. */
  source_url: string;
  /** That reel's total duration in ms (sum of its shot durations). */
  source_duration_ms: number;
  /** Shot durations in source order, in ms. */
  shot_durations_ms: number[];
}

/** Pick the inspiration reel whose total duration is closest to the
 *  target — that reel's shot count and shot duration sequence become
 *  the pacing template. The new reel will have EXACTLY this many
 *  shots, with durations scaled to fit the target.
 *
 *  Style-tagged reels are preferred since style drives editing
 *  decisions. Falls back to all inspiration when no style-tagged
 *  reels exist, and further falls back to any reel with shots when
 *  even the chosen pool yields nothing usable. */
export function selectPacingTemplate(
  targetDurationMs: number,
  reels: {
    url: string;
    analysis: ReelAnalysisResult;
    tags?: string[];
  }[],
): PacingTemplate | null {
  if (reels.length === 0) return null;
  const styleTagged = reels.filter((r) => r.tags?.includes('STYLE'));
  const pool = styleTagged.length > 0 ? styleTagged : reels;

  /** A pacing template is "healthy" when its longest shot is no more
   *  than 4× its median — past that, scene-detect almost certainly
   *  missed cuts on that reel and the template would produce a
   *  monster long-hold shot when scaled. */
  const isHealthyTemplate = (a: ReelAnalysisResult): boolean => {
    const ds = a.shots.map((s) => s.end_ms - s.start_ms);
    if (ds.length < 2) return false;
    const sorted = [...ds].sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    const longest = sorted[sorted.length - 1];
    return median > 0 && longest <= median * 4;
  };

  const pickClosest = (
    candidates: typeof reels,
    requireHealthy: boolean,
  ): (typeof reels)[number] | null => {
    let best: (typeof reels)[number] | null = null;
    let bestDelta = Infinity;
    for (const r of candidates) {
      if (r.analysis.shots.length === 0) continue;
      if (requireHealthy && !isHealthyTemplate(r.analysis)) continue;
      const dur = r.analysis.shots[r.analysis.shots.length - 1].end_ms;
      const delta = Math.abs(dur - targetDurationMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = r;
      }
    }
    return best;
  };

  // Cascade: healthy style → healthy any → any with shots → any.
  // The last fallback only triggers when every reel in the library
  // has degenerate scene detection; better a bad template than no plan.
  const best =
    pickClosest(pool, true) ??
    pickClosest(reels, true) ??
    pickClosest(pool, false) ??
    pickClosest(reels, false);
  if (!best) return null;
  const lastEnd =
    best.analysis.shots[best.analysis.shots.length - 1].end_ms;
  return {
    source_url: best.url,
    source_duration_ms: lastEnd,
    shot_durations_ms: best.analysis.shots.map(
      (s) => s.end_ms - s.start_ms,
    ),
  };
}

function hasPhraseBoundary(text: string): boolean {
  return /[.!?;:,]$/.test(text.trim());
}

function chooseTranscriptBoundary(
  words: TranscriptWord[],
  startWord: number,
  shotNumber: number,
  shotCount: number,
): number {
  const remainingShots = shotCount - shotNumber - 1;
  const ideal = Math.round(((shotNumber + 1) * words.length) / shotCount);
  const minEnd = startWord + 1;
  const maxEnd = words.length - remainingShots;
  const lo = Math.max(minEnd, ideal - 4);
  const hi = Math.min(maxEnd, ideal + 4);
  let best = Math.max(minEnd, Math.min(maxEnd, ideal));
  let bestScore = Infinity;

  for (let end = lo; end <= hi; end++) {
    const word = words[end - 1];
    const distance = Math.abs(end - ideal);
    const boundaryBonus = hasPhraseBoundary(word.text) ? -6 : 0;
    const duration = word.end_ms - words[startWord].start_ms;
    const shortPenalty = duration < 500 ? 5 : 0;
    const score = distance * 2 + boundaryBonus + shortPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = end;
    }
  }

  return best;
}

/** Build the target reel's shot timeline from transcript word boundaries.
 *  Inspiration still supplies the target shot count, but each cut lands on
 *  a target spoken beat instead of a scaled copy of source shot durations. */
export function planShotTimeline(
  targetDurationMs: number,
  template: PacingTemplate,
  words: TranscriptWord[],
): ShotSlot[] {
  if (
    targetDurationMs <= 0 ||
    template.shot_durations_ms.length === 0 ||
    words.length === 0
  ) {
    return [];
  }
  const shotCount = Math.max(
    1,
    Math.min(template.shot_durations_ms.length, words.length),
  );
  const slots: ShotSlot[] = [];
  let startWord = 0;
  let cursor = 0;
  for (let i = 0; i < shotCount; i++) {
    const isLast = i === shotCount - 1;
    const endWord = isLast
      ? words.length
      : chooseTranscriptBoundary(words, startWord, i, shotCount);
    const end = isLast
      ? targetDurationMs
      : Math.max(
          cursor + 200,
          Math.min(targetDurationMs, words[endWord - 1].end_ms),
        );
    const spokenWords = words.filter(
      (w) => w.end_ms > cursor && w.start_ms < end,
    );
    slots.push({
      shot_idx: slots.length,
      start_ms: cursor,
      end_ms: end,
      duration_ms: end - cursor,
      spoken_during: spokenWords
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      spoken_words: spokenWords,
    });
    cursor = end;
    startWord = endWord;
    if (cursor >= targetDurationMs) break;
  }
  return slots;
}

// ---------- per-shot summary for the LLM prompt ----------

function summarizeStyleShot(shot: ReelShot, idx: number): string {
  const parts: string[] = [];
  parts.push(
    `  [${idx.toString().padStart(2, '0')}] ${(shot.start_ms / 1000).toFixed(2)}s-${(shot.end_ms / 1000).toFixed(2)}s ` +
      `(${((shot.end_ms - shot.start_ms) / 1000).toFixed(2)}s) ${shot.clip_type}`,
  );
  if (shot.visual_caption) parts.push(`       visual: "${shot.visual_caption}"`);
  if (shot.spoken_window) {
    parts.push(`       spoken: "${shot.spoken_window.slice(0, 140)}"`);
  }
  if (shot.ocr_text) {
    parts.push(
      `       text_overlay: "${shot.ocr_text.replace(/\s+/g, ' ').slice(0, 80)}"`,
    );
    if (shot.text_moments.length > 0) {
      parts.push(`       text_region: ${shot.text_moments[0].region}`);
    }
  }
  if (shot.overlays.length > 0) {
    const ovs = shot.overlays
      .map((o) => `${o.kind}/${o.motion}@${o.region}`)
      .join(', ');
    parts.push(`       overlays: ${shot.overlays.length} — ${ovs}`);
  }
  const layoutCues: string[] = [];
  if (shot.clip_type === 'talking_head' || shot.clip_type === 'talking_head_unknown') {
    layoutCues.push(
      `talking_head base${shot.face_region ? `, face_${shot.face_region}` : ''}`,
    );
  } else if (shot.clip_type === 'broll_talking_head') {
    layoutCues.push(
      `broll talking-head clip${shot.face_region ? `, face_${shot.face_region}` : ''}`,
    );
  } else {
    layoutCues.push('visual b-roll base');
  }
  if (shot.text_moments.length > 0) {
    layoutCues.push(`text_${shot.text_moments[0].region}`);
  }
  if (shot.overlays.length > 0) {
    layoutCues.push(
      `media_overlay_${shot.overlays.map((o) => o.region).join('+')}`,
    );
  }
  parts.push(`       layout_cues: ${layoutCues.join(' | ')}`);
  if (shot.sfx_at_start) parts.push(`       sfx_at_cut: yes`);
  if (shot.has_face && shot.face_region) {
    parts.push(`       face: ${shot.face_region}`);
  }
  // Measured camera motion (optical flow). Only surface confident,
  // non-static estimates so the model copies real moves, not flow noise.
  const m = shot.detected_motion;
  if (m && m.kind !== 'none' && m.confidence >= 0.4) {
    parts.push(
      `       camera_motion: ${m.kind} (measured, conf ${m.confidence.toFixed(2)})`,
    );
  }
  return parts.join('\n');
}

function summarizeStyleReel(
  analysis: ReelAnalysisResult,
  url: string,
  idx: number,
  tags: string[],
): string {
  const lines: string[] = [];
  const dur = analysis.shots.length
    ? analysis.shots[analysis.shots.length - 1].end_ms
    : 0;
  const tagLabel = tags.length > 0 ? tags.join('+') : 'INSPIRATION';
  lines.push(`## [${tagLabel}] Reel ${idx + 1}: ${url}`);
  lines.push(
    `- duration: ${(dur / 1000).toFixed(1)}s | ${analysis.shots.length} shots | ` +
      `cuts/sec: ${analysis.cuts_per_sec.toFixed(2)} | ` +
      `median_shot: ${analysis.median_shot_ms}ms`,
  );
  if (analysis.hook_speech) {
    lines.push(`- spoken hook: "${analysis.hook_speech}"`);
  }
  lines.push(
    `- mix: vo=${(analysis.voiceover_pct * 100).toFixed(0)}% / music=${(analysis.music_pct * 100).toFixed(0)}% / ` +
      `text_overlay=${(analysis.text_overlay_pct * 100).toFixed(0)}% / ` +
      `SFX=${analysis.sfx_per_min.toFixed(0)}/min / ` +
      `${(analysis.cuts_with_sfx_pct * 100).toFixed(0)}% cuts have SFX`,
  );
  lines.push(`- shot-by-shot:`);
  for (let i = 0; i < analysis.shots.length; i++) {
    lines.push(summarizeStyleShot(analysis.shots[i], i));
  }
  return lines.join('\n');
}

function summarizeMetrics(fp: CollectionFingerprint): string {
  const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push(`(aggregated across ${fp.n_reels} reel(s), ${fp.n_shots} shots)`);
  lines.push('');
  lines.push('## Clip-type mix (your shot clip_types should approximate this)');
  const sortedClip = Object.entries(fp.clip_type_distribution)
    .filter(([, v]) => v > 0.01)
    .sort(([, a], [, b]) => b - a);
  for (const [k, v] of sortedClip) {
    lines.push(`  ${k.padEnd(22)} ${pct(v)}`);
  }
  lines.push(`  real_speaker_pct       = ${pct(fp.real_speaker_pct)}`);
  lines.push(
    `  broll_talking_head_pct = ${pct(fp.broll_talking_head_pct)}`,
  );
  lines.push('');
  lines.push('## Face composition');
  if (fp.face_region_dominant) {
    lines.push(`  face_region_dominant = ${fp.face_region_dominant}`);
  }
  if (fp.face_size_median !== null) {
    lines.push(
      `  face_size_median (norm height) = ${fp.face_size_median.toFixed(2)}  → ${
        fp.face_size_median > 0.35 ? 'tight close-up' : 'medium / wide framing'
      }`,
    );
  }
  lines.push('');
  lines.push('## Text overlays (burned-in captions)');
  lines.push(
    `  text_overlay_pct = ${pct(fp.text_overlay_pct)}  → fraction of shots that should carry a text overlay`,
  );
  if (fp.text_region_dominant) {
    lines.push(
      `  text_region_dominant = ${fp.text_region_dominant}  → default position when adding text`,
    );
  }
  lines.push('');
  const cap = fp.caption_style;
  if (cap && cap.n_with_captions > 0) {
    lines.push('## Spoken-word captions (burned-in subtitle style)');
    if (cap.matched_preset && cap.matched_preset !== 'mixed') {
      lines.push(
        `  preset = ${cap.preset_label || cap.matched_preset} (${(cap.preset_confidence_avg * 100).toFixed(0)}% fit)  → reproduce THIS premade subtitle style`,
      );
    }
    lines.push(
      `  captions_pct = ${pct(cap.captions_pct)}  → fraction of content reels that burn in spoken-word subtitles (mirror this; add word-level captions to roughly this share of the reel)`,
    );
    lines.push(`  position  = ${cap.position}`);
    lines.push(
      `  chunking  = ${cap.chunking}  → word_by_word = one/two words on screen at a time (karaoke), sentence = full lines`,
    );
    if (cap.words_per_chunk_avg > 0) {
      lines.push(
        `  words_per_group ≈ ${cap.words_per_chunk_avg.toFixed(1)}  → typical word count shown at once before the caption swaps`,
      );
    }
    lines.push(
      `  font_size = ${cap.font_size}  → caption text height vs frame (large = Hormozi-style big bold)`,
    );
    lines.push(
      `  treatment = ${cap.text_treatment}${cap.treatment_color_examples.length ? ` (${cap.treatment_color_examples.join(', ')})` : ''}  → bordered = outline/stroke around glyphs, backgrounded = solid color box behind text, clear = neither`,
    );
    lines.push(
      `  emphasis  = ${cap.emphasis}  → active_word_highlight = recolor/scale the word being spoken`,
    );
    lines.push(`  casing    = ${cap.casing}`);
    lines.push(
      `  animation = ${cap.animation}  → how captions enter/move (pop, karaoke_fill, fade, typewriter, static)`,
    );
    if (cap.has_emoji_pct > 0.2) {
      lines.push(`  emoji in captions = ${pct(cap.has_emoji_pct)}`);
    }
    if (cap.font_descriptors.length > 0) {
      lines.push(`  font look: ${cap.font_descriptors.join('; ')}`);
    }
    if (cap.style_labels.length > 0) {
      lines.push(`  styles seen: ${cap.style_labels.join('; ')}`);
    }
    lines.push('');
  }
  lines.push('## SFX rhythm');
  lines.push(
    `  cuts_with_sfx_pct = ${pct(fp.cuts_with_sfx_pct)}  → fraction of shot cuts that should fire an SFX hit`,
  );
  const sortedSfx = Object.entries(fp.sfx_type_distribution)
    .filter(([, v]) => v > 0.05)
    .sort(([, a], [, b]) => b - a);
  if (sortedSfx.length > 0) {
    lines.push(`  SFX type mix (dominant — match these when choosing sfx_cue):`);
    for (const [k, v] of sortedSfx) {
      lines.push(`    ${k.padEnd(14)} ${pct(v)}`);
    }
  }
  // SFX-in-context pattern: HOW sound effects relate to the spoken script
  // (cadence, hook escalation, which moments get a hit). This is what makes
  // sfx_cue placement match the creator instead of just landing on cuts.
  const sp = fp.sfx_pattern;
  if (sp) {
    const s = sp.signals;
    lines.push('  SFX-in-context pattern (match this when placing sfx_cue):');
    lines.push(
      `    cadence: ~${s.sfx_per_word.toFixed(2)} SFX/word, ` +
        `${pct(s.on_word_pct)} land on a spoken word; ` +
        `hook escalation ${s.hook_escalation >= 0.2 ? 'yes' : 'low'}`,
    );
    for (const r of sp.rules) {
      lines.push(
        `    - ${r.trigger} → ${r.sfx_type}` +
          (r.example ? ` (e.g. "${r.example}")` : ''),
      );
    }
    for (const sum of sp.summaries.slice(0, 3)) {
      lines.push(`    note: ${sum}`);
    }
  }
  if (fp.camera_motion_distribution && fp.camera_motion_pct !== null) {
    lines.push('');
    lines.push('## Camera motion (measured by optical flow on the inspiration)');
    lines.push(
      `  camera_motion_pct = ${pct(fp.camera_motion_pct)}  → fraction of shots that MOVE the frame (zoom/pan); the rest are static holds. Match this share — set scene_animation to "none" on the rest.`,
    );
    if (fp.camera_motion_dominant) {
      lines.push(
        `  camera_motion_dominant = ${fp.camera_motion_dominant}  → the move to reach for when a shot should move`,
      );
    }
    const sortedMotion = Object.entries(fp.camera_motion_distribution)
      .filter(([, v]) => v > 0.01)
      .sort(([, a], [, b]) => b - a);
    if (sortedMotion.length > 0) {
      lines.push(
        `  motion mix: ${sortedMotion.map(([k, v]) => `${k}=${pct(v)}`).join(' | ')}`,
      );
    }
    lines.push(
      `  → set each shot's scene_animation to match this profile; a shot's own "camera_motion: …(measured)" line, when present, is the ground-truth move for that exact shot.`,
    );
  }
  return lines.join('\n');
}

function summarizeShotSlots(slots: ShotSlot[]): string {
  const lines: string[] = [];
  for (const s of slots) {
    lines.push(
      `  shot ${s.shot_idx}: [${(s.start_ms / 1000).toFixed(2)}s - ${(s.end_ms / 1000).toFixed(2)}s] (${(s.duration_ms / 1000).toFixed(2)}s)` +
        (s.spoken_during ? `  spoken: "${s.spoken_during}"` : '  spoken: (silence)'),
    );
  }
  return lines.join('\n');
}

// ---------- prompt ----------

const SYSTEM_PROMPT = `You are an expert short-form video editor planning a new vertical Reel.

You receive:
- INSPIRATION REELS, broken down shot-by-shot. Each carries one or more tags:
    * STYLE — mirror this reel's editing pattern (clip-type mix, text overlay style, SFX placement, hook framing).
    * CONTENT — borrow the kinds of b-roll this reel sources (subject footage, screen recordings, artifacts, etc.).
    * STRUCTURE — copy the narrative structure / script template of this reel (hook → intro → body → cta order, beat ratios, rhetorical pattern).
  A reel can carry any combination. Use ONLY the reels with the matching tag for each step. When NO reel carries a tag, fall back to all inspiration for that step.
- STYLE METRICS — aggregated numerical targets your plan must approximate (clip-type mix, text overlay rate, SFX rate, dominant face/text positions).
- A SHOT TIMELINE — the shot boundaries for the target reel ARE ALREADY DECIDED from the target transcript's spoken beats. Each shot has a fixed start_ms / end_ms / duration_ms / spoken_during.
- Your job is to fill in the CONTENT of each pre-defined shot. Do NOT change shot timing.

CRITICAL: inspiration is INSPIRATION, not a literal clip library. Do NOT copy any inspiration shot's visual caption into your output. Instead:

Step 0 — Detect the SCRIPT STRUCTURE. Look at reels tagged STRUCTURE (or all reels if none have that tag). Read their spoken_window text and find the literal phrasing pattern the creator repeats. Express each section as a TEMPLATE with <placeholders>, not as a generalized summary. Example for a character-intro creator:

  hook   → "Who's the <descriptor> that <bold claim>?"
  intro  → "This is <subject>, and they <one-line action>."
  body   → "<claim 1>. <claim 2>. <claim N>."
  cta    → "Would you <ask>?"

Then MAP that template onto the TARGET transcript. For each section produce:
  - role: short label ("hook", "intro", "body", "cta", or more specific if the inspiration warrants)
  - script_template: the inspiration's literal phrasing with <placeholders>
  - target_fill: the literal target transcript words that fit this section
  - target_start_ms / target_end_ms: where in the target the section starts and ends. Must align to transcript word boundaries (use the word's start_ms / end_ms). Sections must be contiguous and cover the full target transcript.
  - shot_count: number of pre-computed SHOT TIMELINE shots whose start_ms falls in target_start_ms..target_end_ms (count them, don't guess).
  - visual_signature: see below.

Output:
  - structure_sections: ordered array as above. Section time ranges must be contiguous (no gaps, no overlaps) and the last section's target_end_ms must equal the target transcript's end.
  - structure_confidence: 'high' if every inspiration reel clearly follows the same template; 'medium' if mostly aligned; 'low' if structure is ambiguous.
  - structure_rationale: one sentence explaining why this template was chosen.
  - structure_alternatives: when confidence is 'low' or 'medium', list 1-2 alternative templates (same schema). Null when 'high'.

Each section's visual_signature captures the visual treatment characteristic of that section in the inspiration. This is SCRIPT-POSITIONED: derive it from the inspiration shots that occupy the same relative script beat / role, not from the collection average:
  - dominant_clip_type: which clip_type dominates this section in inspiration ('broll_visual', 'talking_head_unknown', etc.)
  - shot_type_pattern: ordered shot recipe for this section, naming the clip_type and shot function for each kind of shot (e.g. 'hook: broll_talking_head close-up → broll_visual proof screen → talking_head_unknown reaction'). This must describe WHICH TYPES OF SHOTS appear WHERE in the section, not just percentages.
  - placement_pattern: how b-roll typically sits on canvas in this section ('fullbleed 9:16', 'face centered full-screen', 'desktop screen recording full-screen/cropped', 'PiP bottom right', 'split-screen top', etc.)
  - text_overlay_pattern: exact caption treatment and preset direction ('Hormozi Big Center: uppercase 1-2 word pop captions with yellow active-word highlight', 'Minimal Lower Third: sentence-case bottom strip', 'none', etc.)
  - sfx_pattern: SFX treatment by moment ('vocal hit on hook cut-in, tonal ding on key number, silent setup beats', not just 'whooshes')
  - motion_pattern: animation / motion treatment using scene_animation language where possible ('mostly static holds; punch_in only on reveal', 'slow zoom_in on proof b-roll', 'type-on caption with static base media', etc.)
  - scene_elements: list of app overlay presets observed or implied for this section, using only these kinds when applicable: face_cam, sticker, logo, reaction_gif, emoji_burst, lower_third, other. Include placement/function in the phrase (e.g. 'reaction_gif top_right on punchline', 'logo lower_third during CTA'), or [] when none.

The per-shot fill in each section must follow that section's visual_signature unless the target content makes it impossible — same clip_type, same base layout pattern, same text/SFX/motion treatment, and only the scene_elements the section signature lists. Do NOT merely match global clip-type percentages: preserve WHERE clip types and layouts occur in the script (hook vs setup vs proof vs punchline vs CTA).

Step 1 — Extract content_source_patterns. Look at reels tagged CONTENT (or all reels if none have that tag). These are observations about WHERE / WHAT KIND OF b-roll the creator pulls from.

STRICT RULES — pattern extraction must be EVIDENCE-BASED:
- A pattern may ONLY appear in your list if at least one inspiration shot above clearly exemplifies it. Look at each shot's visual_caption to verify.
- Do NOT add common-knowledge patterns (stock footage, website screen recordings, social media screenshots, generated images, etc.) unless an inspiration shot ACTUALLY shows that type of content. If every inspiration shot is "subject on stage," your only valid pattern is "lots of subject footage from stage talks."
- This is the most important constraint. The plan must reflect what the creator ACTUALLY does, not what reels in general often do.

CRITICAL — when the inspiration heavily features ONE identifiable person across talking_head + broll_talking_head shots (i.e., the spoken_window names them and the same person appears in the visual_captions across many shots), the pattern should NAME that person and call out that the creator builds reels around them. Don't generalize to "subject filmed on stage." Be specific:

✅ Subject-anchored insights (when an inspiration subject is identifiable):
  - "lots of Tony Chen footage from stage talks — creator builds reels around the named subject themselves"
  - "Pat Mahomes interview clips — creator anchors the reel on the subject's own delivery"

✅ Generic source categories (when no specific subject anchor applies):
  - "screen recording of the subject's website"
  - "stock / archival footage tied to a claim"
  - "close-up of a relevant prop or artifact"
  - "screenshot of the subject's social media profile"

❌ TARGET-subject-baked phrasing (the TARGET's name belongs in broll_description per shot, NEVER in the pattern):
  - "screen recording of Ornadyne's website" → "screen recording of the subject's website"
  - "footage of a government building"         → "stock / archival footage tied to a claim"
  Inspiration subject names are fine; target subject names are not.

Maximum 6 patterns. Each must cite (in your inspired_by per shot) the inspiration shot that exemplifies it. If the inspiration only demonstrates 2 patterns, list 2 — don't pad with plausible-sounding others.

Step 1.5 — For each shot, define its CANVAS COMPOSITION (the editor needs to know how to lay the b-roll out). Choose it from the shot's structure_role + that section's visual_signature + the inspiration shot-by-shot layout_cues:
  - placement.aspect: the b-roll asset's native aspect ratio.
      * "9:16" for vertically shot footage (most subject-on-stage clips)
      * "16:9" for desktop screen recordings, YouTube clips, landscape footage
      * "1:1" for Instagram-style photos
      * "4:5" / "3:4" for portrait photos
      * "original" if you genuinely don't know — agent will infer at render time
  - placement.fit: how to fit it into the 9:16 reel canvas.
      * "fill" — fullbleed, crop to fit. Default for native 9:16 footage.
      * "contain" — letterbox to preserve aspect. Rare in short-form.
      * "pip" — picture-in-picture inset on top of background. Use when asset is secondary.
      * "split_top" / "split_bottom" / "split_left" / "split_right" — half-canvas split.
  - placement.position: where on the canvas the b-roll sits (3x3 grid). "middle_center" for fill; meaningful for pip and split.
  - placement.scale: fraction of canvas area, 0-1. 1.0 = full canvas; ~0.3 = typical PiP; 0.5 = split.

Mirror the inspiration's composition by SCRIPT POSITION. If the inspiration hook is a centered talking head, the target hook should be too; if proof beats use screen recordings, product clips, screenshots, split-screen, or PiP, use those layouts on the matching target proof beats; if CTA returns to talking head or logo card, preserve that transition. If every inspiration shot is fullbleed 9:16, your shots are too. If inspiration uses PiP / split-screen, use it on the same kind of spoken beat, not randomly.

Step 1.7 — MEDIA OVERLAY LAYERS ARE DISABLED. Do not generate sticker/logo/reaction/lower-third/corner-face-cam layers on top of shots. For every shot, set has_overlay=false and additional_elements=[]. The burned-in text caption (text_overlay) is separate and still allowed.

Step 2 — For EACH SHOT in the SHOT TIMELINE: assign a structure_role and emit 3-5 DISTINCT B-ROLL IDEAS in options[]. Aim for 3 strong ideas per shot; never fewer than 2; up to 5 when you genuinely have that many distinct creative directions.

EVERY option must be FULLY POPULATED — every option has its own complete broll_description (one specific sentence), its own asset block, its own placement, its own source_type, its own rationale. broll_description is the SINGLE MOST IMPORTANT field — it's what the user reads. NEVER leave it empty, missing, or with a placeholder. If you find yourself about to emit an option without a real broll_description, instead emit FEWER options that are fully formed. An option with an empty / missing broll_description is treated as invalid and dropped — emitting 2 fully-formed options is strictly better than 5 with empty broll_descriptions.

These are GENUINELY DIFFERENT visual concepts (not three rephrasings of the same shot). Multiple can be tagged tier="ideal" — that signals "these are different equally-strong creative directions, editor picks." Include at least one tier="fallback" safety option that's near-guaranteed-acquirable.

FALLBACK CONSTRAINT — the tier="fallback" option MUST be "web_capture" pointing to a high-confidence existing public URL (the subject's official homepage, their main social profile, a top-of-funnel public page about them). It must be the most acquirable option of the bunch — something the curator can almost certainly retrieve. NOT stock_search (unreliable), NOT a hypothetical web_capture (must be a real specific resource), NOT manual / generative (both banned).

Each option gets:

  fit_score (0-1, ALWAYS set) = how well this idea matches the slot's narrative / spoken_during context. Higher = better fit. Multiple ideas can have similarly high fit_score — that's fine and expected when you have several good ideas.

  likelihood (0-1 OR null) = how easily the asset can actually be found via web search.
    - For asset.method = "web_capture" (and "stock_search" when allowed): leave likelihood as null. A post-synthesis verification pass will run a real web search per option and fill in the score based on what was actually found. Your guess would be redundant and often wrong.
    - For asset.method = "library_search": ALWAYS set likelihood: null. It isn't search-based — it depends on the user's own footage.

Examples for shot's spoken_during "they just got into YC" (subject = Ornadyne):
  {
    "tier": "ideal", "fit_score": 0.95, "likelihood": null,
    "broll_description": "Screen recording of Y Combinator's W26 batch page zooming into Ornadyne's company card.",
    "asset": { "method": "web_capture", "web_capture": { "url": "https://www.ycombinator.com/companies/ornadyne", "focus": "company card with logo and tagline" }, ... }
  },
  {
    "tier": "ideal", "fit_score": 0.90, "likelihood": null,
    "broll_description": "Close-up of the Ornadyne founder speaking about being accepted to YC, framed as social-clip from their Twitter/LinkedIn.",
    "asset": { "method": "web_capture", "web_capture": { "url": "https://twitter.com/ornadyne", ... }, ... }
  },
  {
    "tier": "ideal", "fit_score": 0.85, "likelihood": null,
    "broll_description": "Stock footage of YC orange logo zooming in on a dark background, intercut with batch announcement screenshot.",
    "asset": { "method": "stock_search", "stock_search": { "query": "Y Combinator logo zoom" }, ... }
  },   <- emit a stock_search option like this ONLY when STOCK FOOTAGE POLICY = true; when stock is banned, replace it with another web_capture idea
  {
    "tier": "fallback", "fit_score": 0.55, "likelihood": null,
    "broll_description": "Y Combinator homepage hero with the orange logo, slow push-in.",
    "asset": { "method": "web_capture", "web_capture": { "url": "https://www.ycombinator.com", "focus": "header logo and hero section" }, ... }
  }

The verification pass will run AFTER you finish, replacing the null likelihood with a real number for each searchable option. Do not estimate likelihood yourself.

Banned for ANY option:
  ❌ "Young man on stage with hands clasped" — that's a literal inspiration caption.
  ❌ Subject names from inspiration (e.g., "Tony") in target's broll — those go in inspiration insights, not target shots.

When the inspiration patterns include a subject-anchored insight (e.g., "lots of Tony footage from stage talks"), one of the ideal options should be "lots of [target subject] footage doing the equivalent" — e.g., "Close-up of [target subject founder] speaking on camera about [shot's spoken_during topic]."

Structure-role assignment rules:
  - First shot is always the "hook" role (or whatever you named the opening section).
  - Last shot(s) are the "cta" (or your closing section name).
  - Middle shots follow the order of structure_sections in time. A shot's section is determined by its start_ms relative to the section duration_pct boundaries.
  - structure_role values across all shots must match the role labels in structure_sections exactly.

A shot may have empty spoken_during (silence) — use it for a punchy beat or visual pause.

Step 3 — Match per-shot fields to the STYLE METRICS targets:
  - clip_type distribution across your shots should match metrics' clip_type_distribution AND the script-position pattern learned in Step 0 (which section uses which clip type)
  - style choices must be specific enough for an editing agent: name shot types, caption preset/treatment, app overlay preset kinds, motion presets, and SFX types/cadence. Avoid vague labels like "fast-paced", "dynamic", "engaging", or "similar style" unless followed by concrete shot/caption/overlay/motion/SFX details.
  - placement fields should preserve the creator's layout progression by script role (hook layout, body/proof layout, punchline layout, CTA layout), not just a generic full-screen default
  - fraction of shots with non-empty text_overlay should match text_overlay_pct
  - fraction of shots with non-null sfx_cue should match cuts_with_sfx_pct
  - text_position defaults to text_region_dominant
  - sfx_cue strings should match dominant types in sfx_type_distribution AND follow the SFX-in-context pattern: place sfx_cue on the kinds of MOMENTS its rules describe (e.g. emphasized words, reveals/punchlines, hook build), not just on every cut. Word the cue for the moment (e.g. "ding on the key number", "whoosh into the reveal").

Other rules:
- broll_description must be specific to the TARGET subject (reference target's name, brand, claims).
- source_type = the label you used in content_source_patterns.
- inspired_by points to a specific inspiration shot exemplifying the pattern. Null when none stands out.
- animation_cue captures motion in free text ("zoom-in over the shot", "slide-up text", "type-on caption", "static cut").
- scene_animation is the STRUCTURED motion preset for the base media. GROUND IT in the MEASURED optical-flow signal: the STYLE METRICS "Camera motion" block gives the collection's motion mix + camera_motion_pct, and individual inspiration shots carry a "camera_motion: <kind> (measured)" line when flow detected a real move. Prefer that measured kind for analogous shots, and match camera_motion_pct overall — if only ~30% of inspiration shots move, ~70% of your shots should be scene_animation "none". When no measurement exists, fall back to the inspiration's described motion (visual_signature.motion_pattern + animation_cue + asset.camera_move): gentle push-in / "zoom in 1.1x" → "zoom_in"; pull-back → "zoom_out"; fast/punchy emphasis zoom → "punch_in"; slow horizontal drift → "pan_left"/"pan_right" (match direction); combined scale+pan → "ken_burns"; static cut → "none". Do NOT add motion the inspiration doesn't have — a static-hold creator (low camera_motion_pct) should get mostly "none".
- has_overlay (boolean, REQUIRED on every shot) — always false.
- additional_elements — always [].
- First shot is the hook — match the rhetorical structure of inspiration hooks.
- Don't reuse the same source_type back-to-back. Vary.

CRITICAL — this plan is consumed by an editing agent, not a human. For each shot you MUST also fill an "asset" block describing HOW to acquire the b-roll.

STRICT METHOD CONSTRAINT — asset.method is BOUNDED by ALL of: (a) the patterns you extracted in Step 1, (b) the LIBRARY AVAILABILITY notice, (c) the STOCK FOOTAGE POLICY notice, (d) the GENERATIVE AI POLICY notice in the user message.

(a) Pattern gating:
- If no pattern in your list involves website / online content, you CANNOT use "web_capture" on any shot.
- "stock_search" requires both an explicit user opt-in (see STOCK FOOTAGE POLICY) AND a stock-related pattern. Both must hold.
- All "generate_*" / "ai_*" methods are BANNED on every shot (see GENERATIVE AI POLICY). When you would have reached for image/video generation, use "web_capture" instead (find a real photo/video of the thing).

(b) Library gating:
- If the user message states "library_available: false" → "library_search" is FORBIDDEN. You may not assume the user has footage of anything.
- If the user message states "library_available: true" with a list of items → "library_search" is allowed BUT only when at least one listed library item plausibly matches the spoken context. Don't use library_search for items not in the list.

(c) "manual" is BANNED on every option. There is no shoot-this-fresh fallback. Every shot must source from the web. If you'd be tempted to write "Record yourself nodding at the camera" / "Shoot a close-up of the prop" — instead write a "web_capture" pointing to a REAL existing online resource (the creator's own past social post / interview clip, a stock-like real photo from a press kit, a public news image, etc.). The editor will never accept manual.

Method-by-source_type mapping (use these ONLY when the matching pattern was extracted AND library/web/stock rules permit):
- pattern "subject filmed on stage / in interview / demo" → "library_search" if library has a match, else "web_capture" pointing to a real existing video of the subject (YouTube interview, conference talk page, podcast appearance — when allow_copyrighted_media permits it; otherwise the subject's own posted clip).
- pattern "close-up of a prop / artifact" → "library_search" if library has it; otherwise "web_capture" pointing to a real existing photo of that prop (product page, press image, Wikipedia image, etc.).
- pattern "screen recording of subject's website" → "web_capture" with url + focus.
- pattern "screen recording of an authoritative external site" → "web_capture" with that site's url.
- pattern "screenshot of subject's social media profile" → "web_capture" with profile url.
- pattern "stock / archival footage tied to a claim" → "stock_search" with short query — ONLY if STOCK FOOTAGE POLICY = true; otherwise drop this option / use "web_capture" of a public real source instead.
- pattern "logo / brand asset / product image of an entity" → "web_capture" (the entity's own site/press kit). Never stock for logos.

WEB_CAPTURE FEASIBILITY RULE — this is the most important constraint on what you emit. The asset MUST be something that PLAUSIBLY EXISTS as a real public web resource. The curator agent will go search for it; if the idea is a fabricated composite or a hypothetical specific UI state, the search will fail.

EVERY web_capture must satisfy ALL of:
1. The URL points to a SPECIFIC EXISTING resource (a real homepage, a real article page, a real social profile, a real video) — not "https://example.com" or guessed-up paths. If you don't know the exact URL, give the most likely domain root (e.g., "https://twitter.com/vori_ai") and use focus to describe what to look for there.
2. The focus describes what the curator should find on that resource — based on what REALLY exists publicly, not what you wish existed.
3. NO fabricated composites: don't request "a frame of X's UI showing Y query result" unless you know Y is a real publicly-shown screenshot. Don't request "image of [subject's product] being used by [imagined persona]" unless that exact scene exists in their marketing.
4. NO hypothetical UI states: "close-up of the dashboard at the moment a user adds inventory" is fabricated — the curator can find a real screenshot of the dashboard, but not that specific moment unless the company has posted it.
5. NO directorial composite asks: "X overlaid with the call-to-action message" is post-production, not source acquisition.

BANNED web_capture examples (these failed in practice):
  ❌ "Single closed-up frame of Vori's main brain interface with query options for a store" — fabricated UI state, not a real public screenshot.
  ❌ "Image of Vori's AI control panel used by a bodega owner overlaid with the call-to-action message" — fabricated composite + overlay (post-production).
  ❌ "Photo of the founder shaking hands with a CTO" — assumes a specific scene that may not exist publicly.

GOOD web_capture examples:
  ✅ url="https://vori.com", focus="hero section + product UI screenshot they actually show on their homepage"
  ✅ url="https://twitter.com/vori_ai", focus="most recent pinned/featured post showing the product"
  ✅ url="https://www.ycombinator.com/companies/vori", focus="company card with logo, tagline, and batch info"
  ✅ url="https://www.linkedin.com/in/founder-name", focus="profile photo + headline"
  ✅ url="https://techcrunch.com/2024/05/01/vori-raises-22m/", focus="article hero image and headline" (when copyrighted_media = true)

If you can't think of a web_capture that satisfies this rule for a slot, write a different idea for that slot — don't invent an impossible one.

Also set asset.camera_move when the inspiration suggests motion within a still (e.g., "zoom in 1.15× over the shot", "pan left to right", "static").

For each shot's asset object: include "method" + ONLY the parameter sub-block matching that method (web_capture by default; library_search when library_available; stock_search only when opted in), plus "camera_move". OMIT the other unused method sub-blocks entirely — do not emit them as null. This keeps responses compact so all your options fit in the token budget. Reminder: "manual" is BANNED. ALL "generate_*" methods are BANNED.

Example for a stock_search asset (ONLY when STOCK FOOTAGE POLICY = true):
  "asset": {
    "method": "stock_search",
    "stock_search": { "query": "Y Combinator logo zoom" },
    "camera_move": "static"
  }

Output STRICT JSON only — no markdown fences, no preamble. Schema:
{
  "structure_sections": [
    {
      "role": "<label>",
      "script_template": "<inspiration phrasing with <placeholders>>",
      "target_fill": "<literal target transcript words for this section>",
      "target_start_ms": <int, aligned to a transcript word boundary>,
      "target_end_ms": <int, aligned to a transcript word boundary>,
      "shot_count": <int, count of pre-computed shots in this section>,
      "visual_signature": {
        "dominant_clip_type": "<clip_type>",
        "shot_type_pattern": "<ordered shot recipe with clip types and functions for this script section>",
        "placement_pattern": "<one phrase>",
        "text_overlay_pattern": "<caption preset/treatment, position, chunking, casing, animation>",
        "sfx_pattern": "<SFX type/cadence and the moments that receive hits>",
        "motion_pattern": "<scene_animation/camera move pattern and when it applies>",
        "scene_elements": ["<app overlay preset kind + placement/function>", ...]
      }
    }
  ],
  "structure_confidence": "high|medium|low",
  "structure_rationale": "<one sentence>",
  "structure_alternatives": [
    [ { "role": "...", "script_template": "...", "target_fill": "...", "target_start_ms": ..., "target_end_ms": ..., "shot_count": ..., "visual_signature": { ... } }, ... ]
  ] | null,
  "content_source_patterns": ["<pattern 1>", "<pattern 2>", ...],
  "shots": [
    {
      "shot_idx": <int matching the input shot index>,
      "structure_role": "<one of structure_sections.role>",
      "options": [
        {
          "tier": "ideal",
          "fit_score": 0.95,
          "likelihood": null,
          "broll_description": "<FIRST distinct idea, SUBJECT-SPECIFIC, one sentence>",
          "asset": {
            "method": "web_capture",
            "web_capture": { "url": "...", "focus": "..." },
            "camera_move": "zoom in 1.1x over the shot"
          },
          "placement": { "aspect": "16:9", "fit": "fill", "position": "middle_center", "scale": 1.0 },
          "source_type": "<one of content_source_patterns>",
          "rationale": "<why this is one of the top creative options>"
        },
        {
          "tier": "ideal",
          "fit_score": 0.90,
          "likelihood": null,
          "broll_description": "<SECOND distinct idea — different concept, not a rephrasing>",
          "asset": {
            "method": "web_capture",
            "web_capture": { "url": "https://...", "focus": "..." },
            "camera_move": "static"
          },
          "placement": { "aspect": "9:16", "fit": "fill", "position": "middle_center", "scale": 1.0 },
          "source_type": "<one of content_source_patterns>",
          "rationale": "<why this option, and how it differs from idea 1>"
        },
        {
          "tier": "fallback",
          "fit_score": 0.6,
          "likelihood": null,
          "broll_description": "<THIRD safety option — high-acquirability web source>",
          "asset": {
            "method": "web_capture",
            "web_capture": { "url": "https://<subject's official site>", "focus": "homepage hero or logo lockup" },
            "camera_move": null
          },
          "placement": { "aspect": "9:16", "fit": "fill", "position": "middle_center", "scale": 1.0 },
          "source_type": "<one of content_source_patterns>",
          "rationale": "<safety fallback rationale — why this is near-guaranteed-acquirable>"
        }
        // ... up to 5 total entries. Asset sub-block keys shown above are EXAMPLES —
        // The only valid asset.method values are: "web_capture" (default) and "library_search" (only when
        // library_available = true). "stock_search" is allowed ONLY when STOCK FOOTAGE POLICY = true.
        // "manual" is BANNED. ALL "generate_*" methods are BANNED.
        // NEVER emit empty/placeholder options.
      ],
      "has_overlay": false,
      "additional_elements": [],
      "inspired_by": {
        "url": "<inspiration reel URL>",
        "shot_idx": <int>,
        "pattern": "<one-sentence: what about that shot inspired this choice>"
      } | null,
      "text_overlay": "<string or empty>",
      "text_position": "top_left|top_center|top_right|middle_left|middle_center|middle_right|bottom_left|bottom_center|bottom_right",
      "animation_cue": "<string or null>",
      "scene_animation": "none|zoom_in|zoom_out|pan_left|pan_right|ken_burns|punch_in",
      "sfx_cue": "<short string or null>",
      "clip_type": "talking_head|broll_talking_head|talking_head_unknown|broll_visual",
      "rationale": "<one sentence: why this slot fits the structure_role + spoken_during>"
    }
  ]
}

The "options" array MUST have at least 3 entries per shot (up to 5). The example above shows 3 — match that minimum on every single shot. A shot with 1 option is wrong and will be rejected. Each option's broll_description must be a different creative concept (not the same idea reworded). ALWAYS set likelihood to null in your output. The verifier will fill it in for searchable methods after you finish.

The shots array must have EXACTLY one entry per input shot, in shot_idx order.`;

/** Detect whether the user's free-text instructions explicitly enable
 *  stock_search. Stock is banned by default; the user has to opt in
 *  via their instructions for any shot to use it. */
function userAllowsStock(instructions: string | undefined): boolean {
  if (!instructions) return false;
  return /\b(stock|pexels|pond5|getty|shutterstock|archival\s*footage)\b/i.test(
    instructions,
  );
}

function buildUserMessage(
  shotSlots: ShotSlot[],
  styleReels: {
    url: string;
    analysis: ReelAnalysisResult;
    tags: string[];
  }[],
  metrics: CollectionFingerprint | null,
  fullTranscriptText: string,
  libraryItems: { id: string; description: string; tags?: string[] }[] | null,
  allowCopyrightedMedia: boolean,
  userInstructions: string,
  allowStock: boolean,
  brief: EditingBrief | null,
): string {
  const lines: string[] = [];

  lines.push('# LIBRARY AVAILABILITY');
  if (libraryItems && libraryItems.length > 0) {
    lines.push(`library_available: true (${libraryItems.length} items)`);
    lines.push('Items (id — description [tags]):');
    for (const it of libraryItems) {
      const tags = it.tags && it.tags.length > 0 ? ` [${it.tags.join(', ')}]` : '';
      lines.push(`  - ${it.id} — ${it.description}${tags}`);
    }
    lines.push('You may use "library_search" but ONLY when one of these items plausibly matches the spoken context.');
    lines.push('FOOTAGE-FIRST: the user provided this footage because they want THEIR footage edited into the video. Whenever a library item plausibly matches a shot\'s spoken context, make "library_search" the PRIMARY (first, highest fit_score) option for that shot, with web_capture as the fallback option — not the other way around.');
  } else {
    lines.push('library_available: false');
    lines.push('"library_search" is FORBIDDEN. Use "web_capture" with a real existing URL for every shot. "manual" is also banned — there is no shoot-this-fresh fallback.');
  }
  lines.push('');

  lines.push('# COPYRIGHTED MEDIA POLICY');
  if (allowCopyrightedMedia) {
    lines.push('allow_copyrighted_media: true');
    lines.push('You MAY suggest "web_capture" URLs that point to copyrighted content — YouTube videos, news/TV clips, movie/TV stills, branded social posts, copyrighted images. Use them when they\'re the best fit. Pull from named sources (e.g., "https://www.youtube.com/watch?v=..." with a clear focus segment).');
  } else {
    lines.push('allow_copyrighted_media: false');
    lines.push('"web_capture" is restricted to PUBLIC, NON-COPYRIGHTED sources: the SUBJECT\'s own website / press kit / social profiles, public government / institutional / academic pages, openly-licensed reference material. AVOID: YouTube videos, news/TV broadcast clips, movie/TV stills, copyrighted brand imagery from third parties (use the brand\'s own press kit instead), copyrighted music videos. When the only fitting source would be copyrighted, fall back to a different real non-copyrighted source instead (the subject\'s own posted media, press kit, or a public institutional page) — "manual" stays banned.');
  }
  lines.push('');

  lines.push('# STOCK FOOTAGE POLICY');
  if (allowStock) {
    lines.push('allow_stock_search: true (user explicitly enabled in their additional instructions)');
    lines.push('"stock_search" is allowed where it fits naturally.');
  } else {
    lines.push('allow_stock_search: false');
    lines.push('"stock_search" is BANNED on every option. The user did NOT request stock in their additional instructions. Use "web_capture" (with a specific real-world URL) or "library_search" (when the library has a match) instead — "manual" stays banned. Do not emit any option with asset.method="stock_search".');
  }
  lines.push('');

  lines.push('# METHOD WHITELIST');
  lines.push('The only valid asset.method values are: "web_capture", "library_search"' + (allowStock ? ', "stock_search"' : '') + '.');
  lines.push('BANNED methods on every option: "manual", "generate_image", "generate_video", "generate_audio", any "generate_*" / "ai_*" variant, and any other method name you might invent.');
  lines.push('Every shot must source from the web (or the user\'s library when present). There is no shoot-this-fresh and no AI generation.');
  lines.push('');

  if (userInstructions.trim().length > 0) {
    lines.push('# USER ADDITIONAL INSTRUCTIONS');
    lines.push(userInstructions.trim());
    lines.push('');
  }

  lines.push('# INSPIRATION REELS');
  lines.push('');
  if (styleReels.length === 0) {
    lines.push('(no inspiration provided)');
  } else {
    for (let i = 0; i < styleReels.length; i++) {
      lines.push(
        summarizeStyleReel(styleReels[i].analysis, styleReels[i].url, i, styleReels[i].tags),
      );
      lines.push('');
    }
  }

  if (metrics) {
    lines.push('# STYLE METRICS (numerical targets — your plan should approximate these)');
    lines.push('');
    lines.push(summarizeMetrics(metrics));
    lines.push('');
  }

  // The editing BRIEF — the same playbook the analysis tab shows, here as
  // editorial DIRECTIONS the planner must follow. It translates the raw
  // metrics into concrete "do this" instructions (how to pace, what
  // footage on the main track, how to organize overlays, sound design) and
  // a script→screen guide. Treat it as authoritative alongside the metrics.
  if (brief && brief.sections.length > 0) {
    lines.push('# EDITING BRIEF (STRICT creator playbook — MUST FOLLOW when filling shots)');
    if (brief.summary) lines.push(brief.summary);
    lines.push('Priority rule: these brief directives are mandatory constraints. If a directive says a source category, shot layout, repeated shot structure, caption treatment, overlay pattern, motion pattern, or SFX cadence should be used, your structure_sections and every shot option must implement it. Do not merely mention it in rationale.');
    for (const sec of brief.sections) {
      lines.push(`${sec.title}${sec.tag ? ` (${sec.tag})` : ''}:`);
      for (const d of sec.directives) lines.push(`  - ${d}`);
    }
    if (brief.script_map.length > 0) {
      lines.push('Script → screen (mirror this pairing of what\'s said to what\'s shown, including the base clip type and layout used at each script beat):');
      for (const b of brief.script_map.slice(0, 6)) {
        lines.push(
          `  - says "${b.says}" → ${b.footage}${b.overlay ? ` | overlay: ${b.overlay}` : ''}`,
        );
      }
    }
    lines.push(
      'When remixing, treat the brief as a position-by-position edit map: preserve which script beats use talking head, screen/product b-roll, screenshots, PiP/split layouts, overlays, and motion. If the brief gives a repeated per-shot layout sequence, assign clip_type, placement, broll_description, source_type, animation_cue, text_overlay, and sfx_cue to match that sequence as closely as the target transcript allows.',
    );
    lines.push('');
  }

  // Overlay quota — translate media_overlay_pct into an explicit shot
  lines.push('# TARGET FULL TEXT (subject context — what the new reel is about)');
  lines.push(`"${fullTranscriptText}"`);
  lines.push('');

  lines.push('# SHOT TIMELINE (pre-decided — fill content for each)');
  lines.push('');
  lines.push(summarizeShotSlots(shotSlots));
  lines.push('');

  lines.push('# TASK');
  lines.push(
    `Fill content for the ${shotSlots.length} shots above. Do NOT change shot timing. Match the STYLE METRICS targets, FOLLOW the EDITING BRIEF directions, and mirror the inspiration's editing patterns. Output JSON now.`,
  );
  return lines.join('\n');
}

// ---------- output normalization ----------

interface RawAsset {
  method?: string;
  web_capture?: { url?: string; focus?: string } | null;
  library_search?: { query?: string } | null;
  stock_search?: { query?: string } | null;
  generate_image?: { prompt?: string } | null;
  manual?: { instruction?: string } | null;
  camera_move?: string | null;
}

interface RawPlacement {
  aspect?: string;
  fit?: string;
  position?: string;
  scale?: number;
}

interface RawSceneElement {
  kind?: string;
  description?: string;
  position?: string;
  animation?: string | null;
  layer?: number;
}

interface RawOption {
  tier?: string;
  fit_score?: number;
  likelihood?: number | null;
  broll_description?: string;
  asset?: RawAsset | null;
  placement?: RawPlacement | null;
  source_type?: string;
  rationale?: string;
}

interface RawShot {
  shot_idx?: number;
  structure_role?: string;
  options?: RawOption[] | null;
  /** Legacy flat fields (still accepted as a single-option shot for
   *  backward compat with cached / older LLM responses). */
  broll_description?: string;
  asset?: RawAsset | null;
  placement?: RawPlacement | null;
  source_type?: string;
  has_overlay?: boolean | null;
  additional_elements?: RawSceneElement[] | null;
  inspired_by?: { url?: string; shot_idx?: number; pattern?: string } | null;
  text_overlay?: string;
  text_position?: string;
  animation_cue?: string | null;
  scene_animation?: string | null;
  sfx_cue?: string | null;
  clip_type?: string;
  rationale?: string;
}

const VALID_TIERS: ShotOptionTier[] = ['ideal', 'strong', 'feasible', 'fallback'];

function normalizeOption(raw: RawOption): ShotOption {
  const tier = VALID_TIERS.includes(raw.tier as ShotOptionTier)
    ? (raw.tier as ShotOptionTier)
    : 'ideal';
  const fitDefault =
    tier === 'ideal' ? 0.9 : tier === 'fallback' ? 0.5 : 0.7;
  const fit_score =
    typeof raw.fit_score === 'number'
      ? Math.max(0, Math.min(1, raw.fit_score))
      : fitDefault;
  // likelihood: null when the model said null or omitted it. The
  // verify-options post-pass fills in numeric values for searchable
  // methods. Non-searchable methods stay null.
  const likelihood =
    typeof raw.likelihood === 'number'
      ? Math.max(0, Math.min(1, raw.likelihood))
      : null;
  const asset = normalizeAsset(raw.asset ?? null);
  // Salvage broll_description: model sometimes drops the field but
  // still populates the asset block. Derive a usable description from
  // the asset's focus / query / instruction / prompt so the option
  // remains shown to the user instead of dropping to "(no suggestion)".
  let broll_description = raw.broll_description?.trim() ?? '';
  if (!broll_description) {
    broll_description =
      asset.web_capture?.focus?.trim() ??
      asset.stock_search?.query?.trim() ??
      asset.library_search?.query?.trim() ??
      asset.manual?.instruction?.trim() ??
      asset.generate_image?.prompt?.trim() ??
      raw.rationale?.trim() ??
      '';
  }
  return {
    tier,
    fit_score,
    likelihood,
    broll_description: broll_description || '(no suggestion)',
    asset,
    placement: normalizePlacement(raw.placement ?? null),
    source_type: raw.source_type?.trim() || 'unspecified',
    rationale: raw.rationale?.trim() || '',
  };
}

const VALID_ASPECTS: BrollAspect[] = [
  '9:16',
  '16:9',
  '1:1',
  '4:5',
  '3:4',
  'original',
];

const VALID_FITS: BrollFit[] = [
  'fill',
  'contain',
  'pip',
  'split_top',
  'split_bottom',
  'split_left',
  'split_right',
];

function normalizePlacement(raw: RawPlacement | null | undefined): BrollPlacement {
  const aspect = VALID_ASPECTS.includes(raw?.aspect as BrollAspect)
    ? (raw!.aspect as BrollAspect)
    : '9:16';
  const fit = VALID_FITS.includes(raw?.fit as BrollFit)
    ? (raw!.fit as BrollFit)
    : 'fill';
  const position = VALID_REGIONS.includes(raw?.position as FrameRegion)
    ? (raw!.position as FrameRegion)
    : 'middle_center';
  const scale =
    typeof raw?.scale === 'number'
      ? Math.max(0, Math.min(1, raw.scale))
      : fit === 'fill'
        ? 1.0
        : fit === 'pip'
          ? 0.3
          : 0.5;
  return { aspect, fit, position, scale };
}

const VALID_SCENE_ANIMATIONS: SceneAnimation[] = [
  'none',
  'zoom_in',
  'zoom_out',
  'pan_left',
  'pan_right',
  'ken_burns',
  'punch_in',
];

/** Resolve a structured motion preset for a shot. Prefers an explicit
 *  `scene_animation` enum from the model, then falls back to keyword
 *  matching the free-text motion hints (animation_cue / camera_move) the
 *  synthesizer already extracts from the inspiration. Returns 'none' when
 *  nothing suggests movement so static shots stay static. */
function normalizeSceneAnimation(
  explicit: string | null | undefined,
  ...hints: (string | null | undefined)[]
): SceneAnimation {
  const direct = explicit?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (direct && VALID_SCENE_ANIMATIONS.includes(direct as SceneAnimation)) {
    return direct as SceneAnimation;
  }
  const text = hints.filter(Boolean).join(' ').toLowerCase();
  if (!text || /\bstatic\b|\bnone\b|\bhold\b/.test(text)) {
    // An explicit enum that wasn't recognized still implies intent; only
    // return 'none' when there's genuinely no motion signal.
    if (!text) return 'none';
  }
  const pans = /\bpan\b|\bslide\b|\bdrift\b|\btrack\b/.test(text);
  const right = /\bright\b|left[\s-]*to[\s-]*right|l2r\b/.test(text);
  const left = /\bleft\b|right[\s-]*to[\s-]*left|r2l\b/.test(text);
  if (pans && (left || right)) return right ? 'pan_right' : 'pan_left';
  if (/\bken[\s-]*burns\b/.test(text)) return 'ken_burns';
  if (/\bpunch\b|\bsnap\b|\bfast zoom\b|\bquick zoom\b/.test(text)) {
    return 'punch_in';
  }
  if (/\bzoom[\s-]*out\b|\bpull[\s-]*out\b|\bpull[\s-]*back\b/.test(text)) {
    return 'zoom_out';
  }
  if (/\bzoom\b|\bpush[\s-]*in\b|\bscale[\s-]*in\b|\bzoom[\s-]*in\b/.test(text)) {
    return 'zoom_in';
  }
  if (pans) return 'pan_left';
  return 'none';
}

interface RawVisualSignature {
  dominant_clip_type?: string;
  shot_type_pattern?: string;
  placement_pattern?: string;
  text_overlay_pattern?: string;
  sfx_pattern?: string;
  motion_pattern?: string;
  scene_elements?: string[];
}

interface RawStructureSection {
  role?: string;
  script_template?: string;
  target_fill?: string;
  target_start_ms?: number;
  target_end_ms?: number;
  shot_count?: number;
  visual_signature?: RawVisualSignature | null;
}

const VALID_ASSET_METHODS: AssetMethod[] = [
  'web_capture',
  'library_search',
  'stock_search',
  'generate_image',
  'manual',
];

function normalizeAsset(raw: RawAsset | null | undefined): ShotAsset {
  const method = VALID_ASSET_METHODS.includes(raw?.method as AssetMethod)
    ? (raw!.method as AssetMethod)
    : 'manual';
  const wc =
    raw?.web_capture && (raw.web_capture.url || raw.web_capture.focus)
      ? {
          url: String(raw.web_capture.url ?? '').trim(),
          focus: String(raw.web_capture.focus ?? '').trim(),
        }
      : null;
  const ls =
    raw?.library_search && raw.library_search.query
      ? { query: String(raw.library_search.query).trim() }
      : null;
  const ss =
    raw?.stock_search && raw.stock_search.query
      ? { query: String(raw.stock_search.query).trim() }
      : null;
  const gi =
    raw?.generate_image && raw.generate_image.prompt
      ? { prompt: String(raw.generate_image.prompt).trim() }
      : null;
  const mn =
    raw?.manual && raw.manual.instruction
      ? { instruction: String(raw.manual.instruction).trim() }
      : null;
  return {
    method,
    web_capture: wc,
    library_search: ls,
    stock_search: ss,
    generate_image: gi,
    manual: mn,
    camera_move: raw?.camera_move?.trim() || null,
  };
}

interface RawResponse {
  structure_sections?: RawStructureSection[];
  structure_confidence?: string;
  structure_rationale?: string;
  structure_alternatives?: RawStructureSection[][] | null;
  content_source_patterns?: string[];
  shots?: RawShot[];
}

function normalizeVisualSignature(
  raw: RawVisualSignature | null | undefined,
): SectionVisualSignature {
  return {
    dominant_clip_type: raw?.dominant_clip_type?.trim() || 'unspecified',
    shot_type_pattern:
      raw?.shot_type_pattern?.trim() ||
      raw?.dominant_clip_type?.trim() ||
      'unspecified',
    placement_pattern: raw?.placement_pattern?.trim() || 'unspecified',
    text_overlay_pattern: raw?.text_overlay_pattern?.trim() || 'unspecified',
    sfx_pattern: raw?.sfx_pattern?.trim() || 'unspecified',
    motion_pattern: raw?.motion_pattern?.trim() || 'unspecified',
    scene_elements: Array.isArray(raw?.scene_elements)
      ? raw!.scene_elements
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  };
}

function normalizeSection(raw: RawStructureSection): StructureSection {
  const start = typeof raw.target_start_ms === 'number'
    ? Math.max(0, Math.round(raw.target_start_ms))
    : 0;
  const end = typeof raw.target_end_ms === 'number'
    ? Math.max(start, Math.round(raw.target_end_ms))
    : start;
  return {
    role: raw.role?.trim() || 'unspecified',
    script_template: raw.script_template?.trim() || '',
    target_fill: raw.target_fill?.trim() || '',
    target_start_ms: start,
    target_end_ms: end,
    shot_count:
      typeof raw.shot_count === 'number' && raw.shot_count > 0
        ? Math.round(raw.shot_count)
        : 0,
    visual_signature: normalizeVisualSignature(raw.visual_signature ?? null),
  };
}

function normalizeConfidence(raw: string | undefined): StructureConfidence {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return 'medium';
}

const VALID_REGIONS: FrameRegion[] = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'middle_center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
];

const VALID_CLIP_TYPES: ClipType[] = [
  'talking_head',
  'broll_talking_head',
  'talking_head_unknown',
  'broll_visual',
];

function normalizeShot(raw: RawShot, slot: ShotSlot): ShotPlan {
  const textPosition = VALID_REGIONS.includes(raw.text_position as FrameRegion)
    ? (raw.text_position as FrameRegion)
    : 'bottom_center';
  const clipType = VALID_CLIP_TYPES.includes(raw.clip_type as ClipType)
    ? (raw.clip_type as ClipType)
    : 'broll_visual';
  const inspired = raw.inspired_by
    ? {
        url: String(raw.inspired_by.url ?? ''),
        shot_idx:
          typeof raw.inspired_by.shot_idx === 'number'
            ? raw.inspired_by.shot_idx
            : -1,
        pattern: String(raw.inspired_by.pattern ?? ''),
      }
    : null;
  // Build options[]. New schema: raw.options array. Legacy schema:
  // promote the flat fields to a single 'ideal' option for back-compat.
  let options: ShotOption[];
  if (Array.isArray(raw.options) && raw.options.length > 0) {
    options = raw.options
      .map(normalizeOption)
      // Drop empty/placeholder options the model padded in. Better to
      // show 1 real idea than 5 entries where 4 say "(no suggestion)".
      .filter((o) => o.broll_description !== '(no suggestion)');
  } else {
    options = [];
  }
  if (options.length === 0) {
    // Either no options array, or every option was empty. Try the
    // legacy top-level flat fields first.
    const legacy = normalizeOption({
      tier: 'ideal',
      likelihood: null,
      broll_description: raw.broll_description,
      asset: raw.asset,
      placement: raw.placement,
      source_type: raw.source_type,
      rationale: raw.rationale,
    });
    if (legacy.broll_description !== '(no suggestion)') {
      options = [legacy];
    } else {
      // Both new and legacy paths produced nothing usable. Generate a
      // sane placeholder anchored to the shot's spoken context so the
      // user gets SOMETHING actionable instead of "(no suggestion)".
      // The curator agent will improvise per the ladder.
      const ctx =
        slot.spoken_during?.trim() || `shot ${slot.shot_idx} (silence)`;
      console.error(
        `[synthesize] WARNING: shot ${slot.shot_idx} emitted no usable options. Falling back to spoken-context placeholder. raw=`,
        JSON.stringify(raw).slice(0, 240),
      );
      options = [
        normalizeOption({
          tier: 'ideal',
          likelihood: null,
          broll_description: `Real public web source visualizing: ${ctx}`,
          asset: {
            method: 'web_capture',
            web_capture: { url: '', focus: ctx },
          },
          source_type: 'unspecified',
          rationale:
            'Auto-generated fallback: model returned an empty option for this shot; curator agent will research it via the improvisation ladder.',
        }),
      ];
    }
  }
  // Sort options by likelihood ascending so ideal (lower likelihood,
  // higher fit) comes first — but only if the model didn't already
  // order them; respect the order it gave when likelihoods are equal.
  // Actually trust the model's order — they may put ideal first
  // explicitly. Don't re-sort.
  const primary = options[0];

  const elements: SceneElement[] = [];
  const hasOverlay = false;

  return {
    shot_idx: slot.shot_idx,
    start_ms: slot.start_ms,
    end_ms: slot.end_ms,
    duration_ms: slot.duration_ms,
    spoken_during: slot.spoken_during,
    spoken_words: slot.spoken_words,
    structure_role: raw.structure_role?.trim() || 'unspecified',
    options,
    // Top-level mirror of options[0] for backward-compat consumers.
    broll_description: primary.broll_description,
    asset: primary.asset,
    placement: primary.placement,
    source_type: primary.source_type,
    has_overlay: hasOverlay,
    additional_elements: elements,
    inspired_by: inspired && inspired.url ? inspired : null,
    text_overlay: raw.text_overlay?.trim() ?? '',
    text_position: textPosition,
    animation_cue: raw.animation_cue?.trim() || null,
    scene_animation: normalizeSceneAnimation(
      raw.scene_animation,
      raw.animation_cue,
      primary.asset.camera_move,
    ),
    animation_scale: 1,
    animation_easing: 'ease-in-out',
    animation_origin: 'middle_center',
    sfx_cue: raw.sfx_cue?.trim() || null,
    clip_type: clipType,
    rationale: raw.rationale?.trim() || '',
  };
}

function summaryPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function topDistribution(
  dist: Record<string, number> | null | undefined,
  max = 3,
  min = 0.03,
): string {
  if (!dist) return 'none';
  const parts = Object.entries(dist)
    .filter(([, value]) => value >= min)
    .sort(([, a], [, b]) => b - a)
    .slice(0, max)
    .map(([key, value]) => `${key} ${summaryPct(value)}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

function captionSummary(analysis: ReelAnalysisResult): string {
  const cap = analysis.caption_style;
  if (!cap?.present) return 'captions: none';
  const preset = cap.preset_label || cap.matched_preset || cap.style_label || 'custom';
  const font = cap.font_family_name || cap.font_descriptor || 'unmatched font';
  const highlight = cap.highlight_color ? `, highlight ${cap.highlight_color}` : '';
  const emoji = cap.has_emoji ? ', emoji' : '';
  return (
    `captions: ${preset}; ${cap.position}, ${cap.chunking}` +
    `/${cap.words_per_chunk || '?'} words, ${cap.casing}, ${cap.font_size}, ` +
    `${cap.text_treatment}${cap.treatment_color ? ` ${cap.treatment_color}` : ''}, ` +
    `${cap.animation}, ${font}${highlight}${emoji}`
  );
}

function overlaySummary(analysis: ReelAnalysisResult): string {
  if (analysis.media_overlay_pct <= 0.01 && analysis.overlays_per_min <= 0) {
    return 'overlays: none';
  }
  return (
    `overlays: ${summaryPct(analysis.media_overlay_pct)} shots, ` +
    `${analysis.overlays_per_min.toFixed(1)}/min; ` +
    `kinds ${topDistribution(analysis.overlay_kind_distribution)}; ` +
    `motion ${topDistribution(analysis.overlay_motion_distribution)}; ` +
    `regions ${topDistribution(analysis.overlay_region_distribution)}`
  );
}

function motionSummary(analysis: ReelAnalysisResult): string {
  if (!analysis.camera_motion_distribution) return 'motion: unknown';
  const movingPct = Object.entries(analysis.camera_motion_distribution)
    .filter(([kind]) => kind !== 'none')
    .reduce((sum, [, value]) => sum + value, 0);
  return (
    `motion: ${summaryPct(movingPct)} moving; ` +
    `${topDistribution(analysis.camera_motion_distribution, 4, 0.01)}`
  );
}

function styleSummaryString(
  reels: { url: string; analysis: ReelAnalysisResult }[],
): string {
  if (reels.length === 0) return '(no inspiration reels)';
  const lines: string[] = [];
  for (let i = 0; i < reels.length; i++) {
    const a = reels[i].analysis;
    const dur = a.shots.length ? a.shots[a.shots.length - 1].end_ms : 0;
    const clipMix = topDistribution(a.clip_type_distribution, 4, 0.01);
    lines.push(
      `- reel ${i + 1}: ${(dur / 1000).toFixed(1)}s, ${a.shots.length} shots, ` +
        `cuts/sec=${a.cuts_per_sec.toFixed(2)}, ` +
        `shot types: ${clipMix}; ` +
        `${captionSummary(a)}; ` +
        `text overlays ${summaryPct(a.text_overlay_pct)} at ${a.text_region_dominant ?? 'none'}; ` +
        `${overlaySummary(a)}; ` +
        `${motionSummary(a)}; ` +
        `SFX ${a.sfx_per_min.toFixed(0)}/min, ${summaryPct(a.cuts_with_sfx_pct)} cut hits`,
    );
  }
  return lines.join('\n');
}

// ---------- main entry ----------

export interface SynthesizeInput {
  transcript: TranscriptWord[];
  /** Actual target media duration. For uploaded/reel video this is the
   *  audio/video timeline length, not the last spoken word timestamp. */
  targetDurationMs?: number;
  inspirationReels: {
    url: string;
    analysis: ReelAnalysisResult;
    /** Any subset of 'STYLE' | 'CONTENT' | 'STRUCTURE'. A reel can
     *  carry multiple tags. */
    tags: string[];
  }[];
  metrics?: CollectionFingerprint | null;
  vocabulary?: ContentVocabulary;
  /** When the user has uploaded their own footage library, list each
   *  item here so the LLM can match library_search to known assets.
   *  When empty / undefined, library_search is BANNED and shots that
   *  would normally pull from user footage get method='manual' with
   *  a shoot direction. */
  libraryItems?: { id: string; description: string; tags?: string[] }[];
  /** When true, the LLM is allowed to source copyrighted media
   *  (YouTube clips, news footage, branded content, movie/TV stills,
   *  copyrighted social posts). When false (default), web_capture is
   *  restricted to the subject's own public-facing content + public
   *  press / official references. Toggleable from the UI. */
  allowCopyrightedMedia?: boolean;
  /** Free-text instructions the user can add per synthesis. Goes into
   *  the LLM prompt verbatim. Also gates stock_search: stock is BANNED
   *  unless this string contains an explicit request for it (regex on
   *  /stock|pexels|pond5|getty|archival footage/i). */
  userInstructions?: string;
  /** The collection's editing BRIEF — the analysis-derived editorial
   *  playbook (pace, main-track footage, overlay organization, sound,
   *  script→screen). Injected into the prompt as directions the planner
   *  follows. Null/omitted → the prompt relies on STYLE METRICS alone. */
  brief?: EditingBrief | null;
  /** Optional progress callback. Fires per streaming chunk during the
   *  LLM call with the accumulated text length so the UI can show a
   *  live "received N chars" indicator. */
  onStream?: (received_chars: number) => void;
}

export async function synthesize(
  input: SynthesizeInput,
): Promise<SuggestedEdit | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[synthesize] OPENAI_API_KEY not set');
    return null;
  }
  const { transcript, inspirationReels, vocabulary, metrics } = input;
  if (transcript.length === 0) {
    return {
      total_duration_ms: 0,
      shots: [],
      structure_sections: [],
      structure_confidence: 'low',
      structure_rationale: '(empty transcript)',
      structure_alternatives: null,
      content_source_patterns: [],
      style_summary: styleSummaryString(inspirationReels),
      content_sources: vocabulary?.source_reels ?? [],
      target_metrics: metrics ?? null,
      sfx_plan: metrics?.sfx_pattern ?? null,
      subtitle_spec: deriveSubtitleSpec(metrics?.caption_style),
    };
  }

  // Pick the inspiration reel closest in duration to target for shot count,
  // then place the actual cut boundaries on target transcript beats.
  const targetDurationMs = Math.max(
    input.targetDurationMs ?? 0,
    transcript[transcript.length - 1].end_ms,
  );
  const template = selectPacingTemplate(targetDurationMs, inspirationReels);
  if (!template) {
    console.error('[synthesize] no inspiration shots to derive pacing from');
    return null;
  }
  const slots = planShotTimeline(targetDurationMs, template, transcript);
  console.error(
    `[synthesize] transcript timeline: ${slots.length} shots from ${transcript.length} words ` +
      `(count target from ${template.source_url}, ` +
      `${(targetDurationMs / 1000).toFixed(1)}s target)`,
  );

  const fullText = transcript.map((w) => w.text).join(' ');
  const client = new OpenAI({ apiKey });
  const instructions = input.userInstructions ?? '';
  const allowStock = userAllowsStock(instructions);
  const userMessage = buildUserMessage(
    slots,
    inspirationReels,
    metrics ?? null,
    fullText,
    input.libraryItems && input.libraryItems.length > 0
      ? input.libraryItems
      : null,
    input.allowCopyrightedMedia === true,
    instructions,
    allowStock,
    input.brief ?? null,
  );

  let raw: RawResponse;
  try {
    // Streaming so the UI can show a live progress indicator as the
    // model emits JSON. We accumulate the text deltas into a buffer
    // and parse once the stream completes.
    const stream = await client.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });
    let buffer = '';
    let finishReason: string | null = null;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta?.content ?? '';
      if (delta) {
        buffer += delta;
        input.onStream?.(buffer.length);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    const text = buffer.trim();
    if (!text) {
      console.error('[synthesize] empty response');
      return null;
    }
    if (finishReason === 'length') {
      // Output hit MAX_TOKENS. Later shots will be missing options or
      // truncated mid-JSON. Surface this so we can either compress the
      // schema further or move to gpt-4o-128k output mode.
      console.error(
        `[synthesize] WARNING: response truncated at MAX_TOKENS=${MAX_TOKENS} (${text.length} chars). Last shots will be incomplete.`,
      );
    }
    raw = JSON.parse(text);
  } catch (err) {
    console.error(
      '[synthesize] API call or parse failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  const patterns = Array.isArray(raw.content_source_patterns)
    ? raw.content_source_patterns
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  const sections: StructureSection[] = Array.isArray(raw.structure_sections)
    ? raw.structure_sections.map(normalizeSection).filter((s) => s.role)
    : [];
  const confidence = normalizeConfidence(raw.structure_confidence);
  const rationale = raw.structure_rationale?.trim() || '';
  const alternatives: StructureSection[][] | null =
    Array.isArray(raw.structure_alternatives) && confidence !== 'high'
      ? raw.structure_alternatives
          .map((alt) =>
            Array.isArray(alt)
              ? alt.map(normalizeSection).filter((s) => s.role)
              : [],
          )
          .filter((alt) => alt.length > 0)
      : null;

  // Map returned shots to slots by shot_idx; fall back to position
  // when shot_idx missing or out of range.
  const rawShots = Array.isArray(raw.shots) ? raw.shots : [];
  const byIdx = new Map<number, RawShot>();
  rawShots.forEach((rs, pos) => {
    const i = typeof rs.shot_idx === 'number' ? rs.shot_idx : pos;
    if (!byIdx.has(i)) byIdx.set(i, rs);
  });
  const planned: ShotPlan[] = slots.map((slot, pos) => {
    const rs = byIdx.get(slot.shot_idx) ?? rawShots[pos] ?? {};
    return normalizeShot(rs, slot);
  });
  // Sanity log — the prompt asks for ≥3 options per shot. If the
  // model returned fewer, surface that so we know whether the issue
  // is truncation (boost MAX_TOKENS) vs prompt-following (try gpt-4o).
  const lowOption = planned.filter((s) => s.options.length < 2);
  if (lowOption.length > 0) {
    console.error(
      '[synthesize] WARNING:',
      lowOption.length,
      'of',
      planned.length,
      'shots returned <2 options (expected ≥3). Affected shot_idx:',
      lowOption.map((s) => s.shot_idx).join(', '),
    );
  }

  // Method-whitelist post-guard: rewrite all banned methods to
  // web_capture so every emitted option is something the curator agent
  // can act on. Banned set: "manual" (no shoot-fresh allowed) + any
  // "generate_*" / "ai_*" variant the model invents. Focus carries the
  // original instruction / prompt / description so the search retains
  // intent. Note: normalizeAsset silently defaults unknown method names
  // to "manual", so this guard catches both real "manual" emissions and
  // hallucinated methods like "generate_video" / "create_image".
  let methodRewritten = 0;
  for (const s of planned) {
    for (const opt of s.options) {
      const m = opt.asset.method as string;
      const isBanned =
        m === 'manual' ||
        m === 'generate_image' ||
        m.startsWith('generate_') ||
        m.startsWith('ai_');
      if (isBanned) {
        const focusText =
          opt.asset.manual?.instruction ??
          opt.asset.generate_image?.prompt ??
          opt.broll_description;
        opt.asset = {
          ...opt.asset,
          method: 'web_capture',
          manual: null,
          generate_image: null,
          web_capture: {
            url: '',
            focus: `Find a real public web source for: ${focusText}`,
          },
        };
        methodRewritten++;
      }
    }
  }
  if (methodRewritten > 0) {
    console.error(
      '[synthesize] post-guard: rewrote',
      methodRewritten,
      'banned-method option(s) (manual / generate_*) to web_capture',
    );
  }

  // Stock-when-disallowed post-guard: when the user didn't opt into
  // stock_search via their additional instructions, any stock_search
  // option that slipped through is rewritten to web_capture (with the
  // query as focus) so the curator agent searches the web for a real
  // source instead of pulling from a stock library.
  const stockAllowed = userAllowsStock(input.userInstructions);
  let stockRewritten = 0;
  if (!stockAllowed) {
    for (const s of planned) {
      for (const opt of s.options) {
        if (opt.asset.method === 'stock_search') {
          const query = opt.asset.stock_search?.query ?? opt.broll_description;
          opt.asset = {
            ...opt.asset,
            method: 'web_capture',
            stock_search: null,
            web_capture: {
              url: '',
              focus: `Find a real public source for: ${query}`,
            },
          };
          stockRewritten++;
        }
      }
    }
    if (stockRewritten > 0) {
      console.error(
        '[synthesize] post-guard: rewrote',
        stockRewritten,
        'stock_search option(s) to web_capture (user did not request stock in their instructions)',
      );
    }
  }

  // Fallback-tier post-guard: tier="fallback" must NEVER be
  // stock_search (stock is unreliable as a safety net). Rewrite to
  // web_capture with the stock query as focus so the curator can
  // search for a real public source.
  let fallbackStockRewritten = 0;
  for (const s of planned) {
    for (const opt of s.options) {
      if (opt.tier === 'fallback' && opt.asset.method === 'stock_search') {
        const query = opt.asset.stock_search?.query ?? opt.broll_description;
        opt.asset = {
          ...opt.asset,
          method: 'web_capture',
          stock_search: null,
          web_capture: {
            url: '',
            focus: `Find a real high-confidence public source for: ${query}`,
          },
        };
        fallbackStockRewritten++;
      }
    }
    // Re-mirror options[0] in case it was rewritten.
    s.asset = s.options[0].asset;
  }
  if (fallbackStockRewritten > 0) {
    console.error(
      '[synthesize] post-guard: rewrote',
      fallbackStockRewritten,
      'fallback stock_search option(s) to web_capture',
    );
  }

  // Library-availability post-guard: when the user has no library
  // provided, no asset.method may be "library_search". Rewrite slipped-
  // through entries to web_capture (per-option, since options[] is the
  // primary shape now).
  const hasLibrary =
    Array.isArray(input.libraryItems) && input.libraryItems.length > 0;
  if (!hasLibrary) {
    let stripped = 0;
    for (const s of planned) {
      for (const opt of s.options) {
        if (opt.asset.method === 'library_search') {
          const query = opt.asset.library_search?.query ?? opt.broll_description;
          opt.asset = {
            ...opt.asset,
            method: 'web_capture',
            library_search: null,
            web_capture: {
              url: '',
              focus: `Find a real public web source for: ${query} (LLM proposed library_search but no library was provided)`,
            },
          };
          stripped++;
        }
      }
      // Re-mirror options[0] in case it was rewritten.
      s.asset = s.options[0].asset;
    }
    if (stripped > 0) {
      console.error(
        '[synthesize] post-guard: rewrote',
        stripped,
        'library_search option(s) to web_capture (no library_available)',
      );
    }
  }

  return {
    total_duration_ms: targetDurationMs,
    shots: planned,
    structure_sections: sections,
    structure_confidence: confidence,
    structure_rationale: rationale,
    structure_alternatives:
      alternatives && alternatives.length > 0 ? alternatives : null,
    content_source_patterns: patterns,
    style_summary: styleSummaryString(inspirationReels),
    content_sources: vocabulary?.source_reels ?? [],
    target_metrics: metrics ?? null,
    sfx_plan: metrics?.sfx_pattern ?? null,
    subtitle_spec: deriveSubtitleSpec(metrics?.caption_style),
  };
}
