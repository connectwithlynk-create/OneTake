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
import type { ContentVocabulary } from './content-vocab';
import { summarizeShot } from './content-vocab';
import type { CollectionFingerprint } from './fingerprint';
import { spokenWindow, type TranscriptWord } from './transcribe';
import type { ClipType, FrameRegion, ReelShot } from './types';

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
  /** For single-frame screenshots from a video — the timestamp the
   *  frame was extracted at. */
  timestamp_ms?: number | null;
}

export interface ShotPlan {
  shot_idx: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  /** Transcript words playing during this shot — may span multiple
   *  sentences or be empty if the shot lands on silence. */
  spoken_during: string;
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
  /** Additional scene elements composited on top of the b-roll (face
   *  cams, stickers, logos, reaction GIFs, lower-thirds). Empty when
   *  the inspiration doesn't use any. The burned-in text caption is
   *  tracked separately in text_overlay. */
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
  animation_cue: string | null;
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
}

// ---------- shot-timeline planning ----------

interface ShotSlot {
  shot_idx: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  spoken_during: string;
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

/** Build the target reel's shot timeline from a pacing template by
 *  scaling each shot duration so the sequence sums to target. Shot
 *  COUNT is preserved exactly from the template (the editor's
 *  decision of how many cuts to make is the meaningful primitive,
 *  not cuts/sec). */
export function planShotTimeline(
  targetDurationMs: number,
  template: PacingTemplate,
  words: TranscriptWord[],
): ShotSlot[] {
  if (
    targetDurationMs <= 0 ||
    template.shot_durations_ms.length === 0 ||
    template.source_duration_ms <= 0
  ) {
    return [];
  }
  const scale = targetDurationMs / template.source_duration_ms;
  const slots: ShotSlot[] = [];
  let cursor = 0;
  for (let i = 0; i < template.shot_durations_ms.length; i++) {
    const isLast = i === template.shot_durations_ms.length - 1;
    const dur = isLast
      ? targetDurationMs - cursor
      : Math.max(200, Math.round(template.shot_durations_ms[i] * scale));
    const end = Math.min(targetDurationMs, cursor + dur);
    slots.push({
      shot_idx: slots.length,
      start_ms: cursor,
      end_ms: end,
      duration_ms: end - cursor,
      spoken_during: spokenWindow(words, cursor, end),
    });
    cursor = end;
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
  if (shot.sfx_at_start) parts.push(`       sfx_at_cut: yes`);
  if (shot.has_face && shot.face_region) {
    parts.push(`       face: ${shot.face_region}`);
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
  lines.push('');
  lines.push('## Media overlays (stickers / GIFs / PiP / emoji on top of base video)');
  lines.push(
    `  media_overlay_pct = ${pct(fp.media_overlay_pct)}  → fraction of shots that should have a media overlay`,
  );
  if (fp.overlay_kind_distribution) {
    const sortedKinds = Object.entries(fp.overlay_kind_distribution)
      .filter(([, v]) => v > 0.05)
      .sort(([, a], [, b]) => b - a);
    if (sortedKinds.length > 0) {
      lines.push(`  overlay kinds:`);
      for (const [k, v] of sortedKinds) {
        lines.push(`    ${k.padEnd(15)} ${pct(v)}`);
      }
    }
  }
  if (fp.overlay_motion_distribution) {
    const m = fp.overlay_motion_distribution;
    lines.push(
      `  overlay motion: static = ${pct(m.static)} | animated = ${pct(m.animated)}`,
    );
  }
  if (fp.overlay_region_dominant) {
    lines.push(`  overlay_region_dominant = ${fp.overlay_region_dominant}`);
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
- STYLE METRICS — aggregated numerical targets your plan must approximate (clip-type mix, text overlay rate, SFX rate, media overlay rate, dominant face/text positions).
- A SHOT TIMELINE — the shot boundaries for the target reel ARE ALREADY DECIDED (mirroring inspiration cut rhythm). Each shot has a fixed start_ms / end_ms / duration_ms / spoken_during.
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

Each section's visual_signature captures the visual treatment characteristic of that section in the inspiration:
  - dominant_clip_type: which clip_type dominates this section in inspiration ('broll_visual', 'talking_head_unknown', etc.)
  - placement_pattern: how b-roll typically sits on canvas in this section ('fullbleed 9:16', 'PiP bottom right', 'split-screen top', etc.)
  - text_overlay_pattern: caption treatment ('large center caption big font', 'small bottom strip', 'none', etc.)
  - sfx_pattern: SFX treatment ('vocal hit on cut in', 'silent open', 'whoosh whoosh', etc.)
  - motion_pattern: animation / motion treatment ('zoom-in over the shot', 'type-on text', 'static cut', etc.)
  - scene_elements: list of additional element types observed in this section's inspiration shots (['subscribe sticker', 'face cam corner'], or [] when none)

The per-shot fill in each section should TEND to follow that section's visual_signature — same clip_type, placement, text/SFX/motion treatment, and only the scene_elements the section signature lists.

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

Step 1.5 — For each shot, define its CANVAS COMPOSITION (the editor needs to know how to lay the b-roll out):
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

Mirror the inspiration's composition. If every inspiration shot is fullbleed 9:16, your shots are too. If inspiration uses PiP / split-screen, you use it where appropriate.

Step 1.7 — For each shot, list any ADDITIONAL SCENE ELEMENTS composited on top besides the burned-in text caption (face cams, stickers, logos, reaction GIFs, emoji bursts, lower-thirds). ONLY include elements the inspiration ACTUALLY uses — check each inspiration shot's "overlays:" line for evidence. If inspiration has no overlay stickers, your additional_elements is empty arrays everywhere. Don't invent.

Step 2 — For EACH SHOT in the SHOT TIMELINE: assign a structure_role and emit 3-5 DISTINCT B-ROLL IDEAS in options[]. Aim for 3 strong ideas per shot; never fewer than 2; up to 5 when you genuinely have that many distinct creative directions.

EVERY option must be FULLY POPULATED — every option has its own complete broll_description (one specific sentence), its own asset block, its own placement, its own source_type, its own rationale. broll_description is the SINGLE MOST IMPORTANT field — it's what the user reads. NEVER leave it empty, missing, or with a placeholder. If you find yourself about to emit an option without a real broll_description, instead emit FEWER options that are fully formed. An option with an empty / missing broll_description is treated as invalid and dropped — emitting 2 fully-formed options is strictly better than 5 with empty broll_descriptions.

These are GENUINELY DIFFERENT visual concepts (not three rephrasings of the same shot). Multiple can be tagged tier="ideal" — that signals "these are different equally-strong creative directions, editor picks." Include at least one tier="fallback" safety option that's near-guaranteed-acquirable.

FALLBACK CONSTRAINT — the tier="fallback" option MUST be "web_capture" pointing to a high-confidence existing public URL (the subject's official homepage, their main social profile, a top-of-funnel public page about them). It must be the most acquirable option of the bunch — something the curator can almost certainly retrieve. NOT stock_search (unreliable), NOT a hypothetical web_capture (must be a real specific resource), NOT manual / generative (both banned).

Each option gets:

  fit_score (0-1, ALWAYS set) = how well this idea matches the slot's narrative / spoken_during context. Higher = better fit. Multiple ideas can have similarly high fit_score — that's fine and expected when you have several good ideas.

  likelihood (0-1 OR null) = how easily the asset can actually be found via web search.
    - For asset.method = "web_capture" (and "stock_search" when allowed): leave likelihood as null. A post-synthesis verification pass will run a real web search per option and fill in the score based on what was actually found. Your guess would be redundant and often wrong.
    - For asset.method in {"library_search", "manual"}: ALWAYS set likelihood: null. These aren't search-based — they depend on the user's own footage or what they shoot fresh.

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
  },
  {
    "tier": "fallback", "fit_score": 0.55, "likelihood": null,
    "broll_description": "Static YC orange logo wordmark, no motion, plain white background.",
    "asset": { "method": "manual", "manual": { "instruction": "Drop in the YC wordmark as a clean graphic asset." }, ... }
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
  - clip_type distribution across your shots should match metrics' clip_type_distribution
  - fraction of shots with non-empty text_overlay should match text_overlay_pct
  - fraction of shots with non-null sfx_cue should match cuts_with_sfx_pct
  - fraction of shots with a media overlay (call out in broll_description or animation_cue) should match media_overlay_pct
  - text_position defaults to text_region_dominant
  - sfx_cue strings should match dominant types in sfx_type_distribution

Other rules:
- broll_description must be specific to the TARGET subject (reference target's name, brand, claims).
- source_type = the label you used in content_source_patterns.
- inspired_by points to a specific inspiration shot exemplifying the pattern. Null when none stands out.
- animation_cue captures motion ("zoom-in over the shot", "slide-up text", "type-on caption", "static cut").
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

For "manual" instructions: be SPECIFIC and ACTIONABLE — duration, framing, what to capture, what NOT to include. "Wide shot of a hopeful investor" is BAD (vague + assumes a person the user can't access). "Record a 1.5s static close-up of yourself nodding seriously at camera" is GOOD.

Also set asset.camera_move when the inspiration suggests motion within a still (e.g., "zoom in 1.15× over the shot", "pan left to right", "static").

For each shot's asset object: include "method" + ONLY the parameter sub-block matching that method (web_capture by default; library_search when library_available; stock_search only when opted in), plus "camera_move". OMIT the other unused method sub-blocks entirely — do not emit them as null. This keeps responses compact so all your options fit in the token budget. Reminder: "manual" is BANNED. ALL "generate_*" methods are BANNED.

Example for a stock_search asset:
  "asset": {
    "method": "stock_search",
    "stock_search": { "query": "Y Combinator logo zoom" },
    "camera_move": "static"
  }
Example for a manual asset:
  "asset": {
    "method": "manual",
    "manual": { "instruction": "Record a 1.5s close-up of yourself nodding at camera." },
    "camera_move": null
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
        "placement_pattern": "<one phrase>",
        "text_overlay_pattern": "<one phrase>",
        "sfx_pattern": "<one phrase>",
        "motion_pattern": "<one phrase>",
        "scene_elements": ["<element kind/phrase>", ...]
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
      "additional_elements": [
        {
          "kind": "face_cam|sticker|logo|reaction_gif|emoji_burst|lower_third|other",
          "description": "<what the element is, subject-aware>",
          "position": "<3x3 grid cell>",
          "animation": "<string or null>"
        }
      ],
      "inspired_by": {
        "url": "<inspiration reel URL>",
        "shot_idx": <int>,
        "pattern": "<one-sentence: what about that shot inspired this choice>"
      } | null,
      "text_overlay": "<string or empty>",
      "text_position": "top_left|top_center|top_right|middle_left|middle_center|middle_right|bottom_left|bottom_center|bottom_right",
      "animation_cue": "<string or null>",
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
    lines.push('"web_capture" is restricted to PUBLIC, NON-COPYRIGHTED sources: the SUBJECT\'s own website / press kit / social profiles, public government / institutional / academic pages, openly-licensed reference material. AVOID: YouTube videos, news/TV broadcast clips, movie/TV stills, copyrighted brand imagery from third parties (use the brand\'s own press kit instead), copyrighted music videos. When the only fitting source would be copyrighted, use "manual" (only if a human-filmed shot is appropriate) or fall back to a different real source.');
  }
  lines.push('');

  lines.push('# STOCK FOOTAGE POLICY');
  if (allowStock) {
    lines.push('allow_stock_search: true (user explicitly enabled in their additional instructions)');
    lines.push('"stock_search" is allowed where it fits naturally.');
  } else {
    lines.push('allow_stock_search: false');
    lines.push('"stock_search" is BANNED on every option. The user did NOT request stock in their additional instructions. Use "web_capture" (with a specific real-world URL) or "manual" (when a human-filmed shot is appropriate) instead. Do not emit any option with asset.method="stock_search".');
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

  lines.push('# TARGET FULL TEXT (subject context — what the new reel is about)');
  lines.push(`"${fullTranscriptText}"`);
  lines.push('');

  lines.push('# SHOT TIMELINE (pre-decided — fill content for each)');
  lines.push('');
  lines.push(summarizeShotSlots(shotSlots));
  lines.push('');

  lines.push('# TASK');
  lines.push(
    `Fill content for the ${shotSlots.length} shots above. Do NOT change shot timing. Match the STYLE METRICS targets. Mirror the inspiration's editing patterns. Output JSON now.`,
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
  additional_elements?: RawSceneElement[] | null;
  inspired_by?: { url?: string; shot_idx?: number; pattern?: string } | null;
  text_overlay?: string;
  text_position?: string;
  animation_cue?: string | null;
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

const VALID_ELEMENT_KINDS: SceneElementKind[] = [
  'face_cam',
  'sticker',
  'logo',
  'reaction_gif',
  'emoji_burst',
  'lower_third',
  'other',
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

function normalizeSceneElements(
  raw: RawSceneElement[] | null | undefined,
): SceneElement[] {
  if (!Array.isArray(raw)) return [];
  const out: SceneElement[] = [];
  for (const r of raw) {
    const kind = VALID_ELEMENT_KINDS.includes(r.kind as SceneElementKind)
      ? (r.kind as SceneElementKind)
      : 'other';
    const description = r.description?.trim() ?? '';
    if (!description) continue;
    const position = VALID_REGIONS.includes(r.position as FrameRegion)
      ? (r.position as FrameRegion)
      : 'middle_center';
    const animation = r.animation?.trim() || null;
    out.push({ kind, description, position, animation });
  }
  return out;
}

interface RawVisualSignature {
  dominant_clip_type?: string;
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

  return {
    shot_idx: slot.shot_idx,
    start_ms: slot.start_ms,
    end_ms: slot.end_ms,
    duration_ms: slot.duration_ms,
    spoken_during: slot.spoken_during,
    structure_role: raw.structure_role?.trim() || 'unspecified',
    options,
    // Top-level mirror of options[0] for backward-compat consumers.
    broll_description: primary.broll_description,
    asset: primary.asset,
    placement: primary.placement,
    source_type: primary.source_type,
    additional_elements: normalizeSceneElements(raw.additional_elements ?? null),
    inspired_by: inspired && inspired.url ? inspired : null,
    text_overlay: raw.text_overlay?.trim() ?? '',
    text_position: textPosition,
    animation_cue: raw.animation_cue?.trim() || null,
    sfx_cue: raw.sfx_cue?.trim() || null,
    clip_type: clipType,
    rationale: raw.rationale?.trim() || '',
  };
}

function styleSummaryString(
  reels: { url: string; analysis: ReelAnalysisResult }[],
): string {
  if (reels.length === 0) return '(no inspiration reels)';
  const lines: string[] = [];
  for (let i = 0; i < reels.length; i++) {
    const a = reels[i].analysis;
    const dur = a.shots.length ? a.shots[a.shots.length - 1].end_ms : 0;
    lines.push(
      `- reel ${i + 1}: ${(dur / 1000).toFixed(1)}s, ${a.shots.length} shots, ` +
        `cuts/sec=${a.cuts_per_sec.toFixed(2)}, ` +
        `text=${(a.text_overlay_pct * 100).toFixed(0)}%, ` +
        `SFX=${a.sfx_per_min.toFixed(0)}/min`,
    );
  }
  return lines.join('\n');
}

// ---------- main entry ----------

export interface SynthesizeInput {
  transcript: TranscriptWord[];
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
    };
  }

  // Pick the inspiration reel closest in duration to target → use its
  // EXACT shot count + scaled duration sequence. Editor's decision
  // about how many cuts to make is preserved verbatim.
  const targetDurationMs = transcript[transcript.length - 1].end_ms;
  const template = selectPacingTemplate(targetDurationMs, inspirationReels);
  if (!template) {
    console.error('[synthesize] no inspiration shots to derive pacing from');
    return null;
  }
  const slots = planShotTimeline(targetDurationMs, template, transcript);
  console.error(
    `[synthesize] pacing template: ${template.shot_durations_ms.length} shots from ${template.source_url} ` +
      `(${(template.source_duration_ms / 1000).toFixed(1)}s → ${(targetDurationMs / 1000).toFixed(1)}s, ` +
      `scale=${(targetDurationMs / template.source_duration_ms).toFixed(2)}×)`,
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
  };
}
