// Premade subtitle styles + a matcher that picks the closest one for a
// detected CaptionStyleProfile.
//
// The caption vision pass (caption-style.ts) extracts structured
// attributes (chunking, size, emphasis, animation, position, casing).
// Rather than ask the model to also name a style — which would mean
// re-prompting every time the catalog changes — we score each preset
// against those attributes here, deterministically. The LLM does the
// perception; this code does the classification. Mirrors the
// preset-based layout picker (LAYOUT_PRESETS) rather than free-text.
//
// To add a style: append to SUBTITLE_PRESETS. Omitted style fields are
// wildcards (not scored), so a loose preset can match a broad range.
import type {
  CaptionStyleProfile,
  CaptionPosition,
  CaptionChunking,
  CaptionEmphasis,
  CaptionCasing,
  CaptionAnimation,
  CaptionFontSize,
  CaptionTreatment,
} from './types';

export interface SubtitlePreset {
  id: string;
  label: string;
  /** Human blurb — shown in UI, not used for matching. */
  description: string;
  /** Defining attributes. Any omitted field is a wildcard. */
  style: {
    position?: CaptionPosition;
    chunking?: CaptionChunking;
    font_size?: CaptionFontSize;
    emphasis?: CaptionEmphasis;
    casing?: CaptionCasing;
    animation?: CaptionAnimation;
    text_treatment?: CaptionTreatment;
  };
}

/** The attributes we score on and how much each one defines the look.
 *  chunking + emphasis carry the most identity (word-by-word karaoke vs
 *  full-sentence static); casing/position are softer tells. */
const SCORED: { field: keyof SubtitlePreset['style']; weight: number }[] = [
  { field: 'chunking', weight: 3 },
  { field: 'emphasis', weight: 3 },
  { field: 'animation', weight: 2 },
  { field: 'font_size', weight: 2 },
  { field: 'text_treatment', weight: 2 },
  { field: 'position', weight: 1 },
  { field: 'casing', weight: 1 },
];

/** Starter catalog of recognizable short-form subtitle styles. Edit
 *  freely — the matcher adapts automatically. */
export const SUBTITLE_PRESETS: SubtitlePreset[] = [
  {
    id: 'hormozi',
    label: 'Hormozi',
    description:
      'Big bold uppercase, one word at a time, the spoken word recolored, punchy pop-in. Center of frame.',
    style: {
      position: 'center',
      chunking: 'word_by_word',
      font_size: 'large',
      emphasis: 'active_word_highlight',
      animation: 'pop',
      casing: 'uppercase',
      text_treatment: 'bordered',
    },
  },
  {
    id: 'karaoke',
    label: 'Karaoke fill',
    description:
      'A full phrase held on screen while a color sweeps across it word by word as it is spoken.',
    style: {
      chunking: 'phrase',
      font_size: 'medium',
      emphasis: 'keyword_highlight',
      animation: 'karaoke_fill',
      position: 'bottom',
      text_treatment: 'backgrounded',
    },
  },
  {
    id: 'beast',
    label: 'Bold stroke (MrBeast)',
    description:
      'Large bold white text with a thick black outline, a phrase at a time, bouncy pop-in. No recolor.',
    style: {
      position: 'center',
      chunking: 'phrase',
      font_size: 'large',
      emphasis: 'none',
      animation: 'pop',
      casing: 'uppercase',
      text_treatment: 'bordered',
    },
  },
  {
    id: 'keyword_pop',
    label: 'Keyword highlight',
    description:
      'Phrase at a time with select keywords recolored, light pop animation. Mid-size, centered.',
    style: {
      position: 'center',
      chunking: 'phrase',
      font_size: 'medium',
      emphasis: 'keyword_highlight',
      animation: 'pop',
    },
  },
  {
    id: 'clean_bottom',
    label: 'Clean captions',
    description:
      'Full sentences, plain white, sitting at the bottom, no animation — standard auto-captions.',
    style: {
      position: 'bottom',
      chunking: 'sentence',
      font_size: 'medium',
      emphasis: 'none',
      animation: 'static',
      casing: 'sentence_case',
      text_treatment: 'clear',
    },
  },
  {
    id: 'minimal_lower_third',
    label: 'Minimal lower-third',
    description:
      'Small, understated sentence captions low in the frame, static. Documentary / talking-head feel.',
    style: {
      position: 'lower_third',
      chunking: 'sentence',
      font_size: 'small',
      emphasis: 'none',
      animation: 'static',
      casing: 'sentence_case',
      text_treatment: 'clear',
    },
  },
];

export interface SubtitlePresetMatch {
  /** id of the closest preset in SUBTITLE_PRESETS. */
  preset_id: string;
  /** Its display label. */
  preset_label: string;
  /** Fraction of the preset's (weighted) defining attributes that the
   *  detected profile matched, 0-1. Low values mean "nothing fit well —
   *  treat the pick as weak". */
  preset_confidence: number;
}

const NO_MATCH: SubtitlePresetMatch = {
  preset_id: '',
  preset_label: '',
  preset_confidence: 0,
};

/** Pick the closest premade subtitle style for a detected profile.
 *  Returns an empty match when captions aren't present. */
export function matchSubtitlePreset(
  profile: CaptionStyleProfile,
): SubtitlePresetMatch {
  if (!profile.present) return NO_MATCH;

  let best: SubtitlePreset | null = null;
  let bestScore = -1;
  let bestTotal = 0;
  for (const preset of SUBTITLE_PRESETS) {
    let matched = 0;
    let total = 0;
    for (const { field, weight } of SCORED) {
      const want = preset.style[field];
      if (want === undefined) continue;
      total += weight;
      if (profile[field] === want) matched += weight;
    }
    const score = total > 0 ? matched / total : 0;
    // Higher score wins; tie broken by the more specific preset (more
    // defining attributes), then by catalog order.
    if (score > bestScore || (score === bestScore && total > bestTotal)) {
      best = preset;
      bestScore = score;
      bestTotal = total;
    }
  }

  if (!best) return NO_MATCH;
  return {
    preset_id: best.id,
    preset_label: best.label,
    preset_confidence: Math.round(bestScore * 100) / 100,
  };
}
