// Resolved, concrete subtitle style for a generated edit. This is where
// the detected caption ANALYSIS becomes a real pipeline artifact: the
// collection-level CaptionStyleSummary (a statistical roll-up, full of
// 'mixed' and averages) is resolved into one definite style that the plan
// carries and a future renderer can burn in. Derived deterministically —
// we already detected every field, so we attach it directly instead of
// asking the LLM to re-emit it (which it does unreliably).
import type { CaptionStyleSummary } from './caption-style';
import type {
  CaptionPosition,
  CaptionChunking,
  CaptionCasing,
  CaptionEmphasis,
  CaptionAnimation,
  CaptionFontSize,
  CaptionTreatment,
} from './types';

export interface SubtitleSpec {
  /** Whether the edit should burn in spoken-word subtitles at all —
   *  true when most content reels did. The user can still toggle it. */
  enabled: boolean;
  /** Matched premade preset id + label (from subtitle-presets), '' none. */
  preset_id: string;
  preset_label: string;
  /** Matched real font (font-catalog id) + display name, '' none. */
  font_family: string;
  font_family_name: string;
  font_size: CaptionFontSize;
  /** Fine size multiplier on top of the font_size preset (1 = the
   *  preset's default). Lets the user nudge subtitle size continuously
   *  instead of being limited to the three presets. Optional — treated
   *  as 1 when absent. */
  font_scale?: number;
  /** Outline thickness in px for the 'bordered' text treatment, at 1x
   *  font scale (it scales with font_scale so the outline stays
   *  proportional). Optional — treated as 2 when absent. */
  border_width?: number;
  position: CaptionPosition;
  chunking: CaptionChunking;
  /** Concrete words-on-screen-at-once (>=1). */
  words_per_chunk: number;
  casing: CaptionCasing;
  emphasis: CaptionEmphasis;
  animation: CaptionAnimation;
  text_treatment: CaptionTreatment;
  /** Resolved colors (color word or hex). */
  text_color: string;
  treatment_color: string | null;
  highlight_color: string | null;
  has_emoji: boolean;
  /** True when fields were resolved from a 'mixed'/empty summary (low
   *  agreement across reels) — the UI can flag it as a soft guess. */
  low_confidence: boolean;
}

function resolve<T extends string>(v: T | 'mixed', fallback: T): T {
  return v === 'mixed' ? fallback : v;
}

/** Words shown at once implied by the chunking when the numeric average
 *  is missing. */
function chunkWords(chunking: CaptionChunking): number {
  switch (chunking) {
    case 'word_by_word':
      return 1;
    case 'phrase':
      return 3;
    case 'sentence':
      return 7;
    default:
      return 3;
  }
}

/**
 * Resolve a CaptionStyleSummary (from the content reels) into a single
 * concrete SubtitleSpec, or null when no captions were detected at all.
 */
export function deriveSubtitleSpec(
  summary: CaptionStyleSummary | null | undefined,
): SubtitleSpec | null {
  if (!summary || summary.n_with_captions === 0) return null;

  const chunking = resolve<CaptionChunking>(summary.chunking, 'phrase');
  const wpc =
    summary.words_per_chunk_avg > 0
      ? Math.max(1, Math.round(summary.words_per_chunk_avg))
      : chunkWords(chunking);

  // "mixed" on the defining fields means the reels didn't agree — flag it.
  const lowConfidence =
    summary.preset_confidence_avg < 0.6 ||
    summary.text_treatment === 'mixed' ||
    summary.font_size === 'mixed';

  return {
    // Most content reels caption → on by default.
    enabled: summary.captions_pct >= 0.5,
    preset_id: summary.matched_preset === 'mixed' ? '' : summary.matched_preset,
    preset_label: summary.preset_label,
    font_family: summary.font_family === 'mixed' ? '' : summary.font_family,
    font_family_name: summary.font_family_name,
    font_size: resolve<CaptionFontSize>(summary.font_size, 'large'),
    position: resolve<CaptionPosition>(summary.position, 'bottom'),
    chunking,
    words_per_chunk: wpc,
    casing: resolve<CaptionCasing>(summary.casing, 'uppercase'),
    emphasis: resolve<CaptionEmphasis>(summary.emphasis, 'none'),
    animation: resolve<CaptionAnimation>(summary.animation, 'pop'),
    text_treatment: resolve<CaptionTreatment>(summary.text_treatment, 'bordered'),
    text_color: summary.text_color || 'white',
    treatment_color:
      summary.treatment_color_examples[0] ??
      (resolve<CaptionTreatment>(summary.text_treatment, 'bordered') === 'clear'
        ? null
        : 'black'),
    highlight_color: summary.highlight_color,
    has_emoji: summary.has_emoji_pct >= 0.4,
    low_confidence: lowConfidence,
  };
}
