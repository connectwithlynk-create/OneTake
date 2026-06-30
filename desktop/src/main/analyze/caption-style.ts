import OpenAI from 'openai';
import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { FONT_CATALOG } from './font-catalog';
import type { ExtractedFrame } from './frame-extractor';
import type {
  ReelShot,
  CaptionStyleProfile,
  CaptionPosition,
  CaptionChunking,
  CaptionEmphasis,
  CaptionCasing,
  CaptionAnimation,
  CaptionFontSize,
  CaptionTreatment
} from './types';
import { matchSubtitlePreset } from './subtitle-presets';

/**
 * Subtitle / caption STYLE detection.
 *
 * OCR (annotate.ts) already tells us WHERE text appears, but the things that
 * define a creator's caption look - bold vs thin, white vs colored, all-caps,
 * one-word-at-a-time vs full sentences, pop/karaoke animation, emoji - are
 * visual and need a vision model.
 *
 * We send the model a handful of caption-bearing frames (several consecutive
 * frames from the same moment, so it can see the captions animate) and ask it
 * to classify the spoken-word caption style. Best-effort: returns null when
 * OPENAI_API_KEY is missing or the call fails.
 */

const CAPTION_STYLE_MODEL =
  process.env.ONETAKE_ANALYZE_MODEL?.trim() || 'gpt-4o';

const FONT_IDS = FONT_CATALOG.map((f) => f.id);
const FONT_NAME_BY_ID = new Map(FONT_CATALOG.map((f) => [f.id, f.family]));

/** Resolve + load the rendered font reference sheet (base64), or null if
 *  it hasn't been generated (scripts/render-font-sheet.ts). Cached. Tries
 *  cwd first (tsx scripts) then __dirname relative (built app). */
let referenceSheetCache: string | null | undefined;
function loadFontReferenceSheet(): string | null {
  if (referenceSheetCache !== undefined) return referenceSheetCache;
  const candidates = [
    process.env.FONT_SHEET_PATH,
    resolve(process.cwd(), 'resources/fonts/reference-sheet.png'),
    join(__dirname, '../../resources/fonts/reference-sheet.png'),
    join(__dirname, '../../../resources/fonts/reference-sheet.png'),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (existsSync(c)) {
      referenceSheetCache = readFileSync(c).toString('base64');
      return referenceSheetCache;
    }
  }
  referenceSheetCache = null;
  return null;
}

/** Max caption-bearing shots to sample frames from. */
const MAX_SHOTS = 3;
/** Max frames to send per sampled shot (to reveal animation). */
const FRAMES_PER_SHOT = 3;
/** Hard cap on total images sent (cost control). */
const MAX_IMAGES = 9;

const POSITIONS: CaptionPosition[] = [
  'center',
  'lower_third',
  'bottom',
  'top',
  'varies'
];
const CHUNKINGS: CaptionChunking[] = [
  'word_by_word',
  'phrase',
  'sentence',
  'mixed'
];
const EMPHASES: CaptionEmphasis[] = [
  'active_word_highlight',
  'keyword_highlight',
  'none'
];
const CASINGS: CaptionCasing[] = [
  'uppercase',
  'title_case',
  'sentence_case',
  'mixed'
];
const ANIMATIONS: CaptionAnimation[] = [
  'pop',
  'karaoke_fill',
  'fade',
  'typewriter',
  'static',
  'none'
];
const FONT_SIZES: CaptionFontSize[] = ['small', 'medium', 'large'];
const TREATMENTS: CaptionTreatment[] = ['bordered', 'backgrounded', 'clear'];

const SYSTEM_PROMPT = `You are a short-form video caption analyst. You are given sampled frames from a SINGLE short video. Several frames may come from the same moment in sequence - use those to judge how the on-screen captions animate.

Focus ONLY on burned-in SPOKEN-WORD captions (the auto-generated style subtitles creators add to transcribe their talking, e.g. CapCut/Hormozi-style). IGNORE titles, logos, hashtags, lower-third name tags, sticker text, and other decorative graphics.

If the video has no spoken-word captions, return present=false and leave the other fields at their defaults.

Return ONLY valid JSON with this exact shape:
{
  "present": boolean,
  "position": "center" | "lower_third" | "bottom" | "top" | "varies",
  "chunking": "word_by_word" | "phrase" | "sentence" | "mixed",
  "words_per_chunk": number,        // typical count of words on screen at once before it swaps (1-2 for word-by-word, 3-5 for phrases, 6+ for full sentences)
  "font_size": "small" | "medium" | "large", // caption text height vs frame height: small (<5%), medium (5-9%), large (>=9%, Hormozi-style)
  "emphasis": "active_word_highlight" | "keyword_highlight" | "none",
  "casing": "uppercase" | "title_case" | "sentence_case" | "mixed",
  "animation": "pop" | "karaoke_fill" | "fade" | "typewriter" | "static" | "none",
  "font_descriptor": string,        // e.g. "bold rounded sans-serif with black stroke"
  "font_family": string,            // id of the closest-matching font from the reference sheet (last image), or "" if none clearly match
  "text_color": string,             // e.g. "white"
  "text_treatment": "bordered" | "backgrounded" | "clear", // how the text is made legible
  "treatment_color": string | null, // outline color (bordered) or box color (backgrounded), null if clear
  "highlight_color": string | null, // active/keyword color, null if none
  "has_emoji": boolean,
  "style_label": string             // concise name, e.g. "word-by-word karaoke highlight"
}

Definitions:
- chunking word_by_word: only one or two words visible at a time.
- words_per_chunk: count the words in ONE caption group as it appears (the unit that swaps together), not the whole sentence. Estimate the typical group across the frames.
- font_size: judge the cap-height of the caption text against the full frame height. Big bold center captions are "large"; thin lower-third lines are "small".
- text_treatment: "bordered" = each letter has a visible outline/stroke in a contrasting color (e.g. yellow text with a black edge). "backgrounded" = the text sits on a solid filled box/block of color. "clear" = neither, just the colored text itself (a soft drop shadow still counts as clear). treatment_color is that outline or box color (a plain color word), null when clear.
- emphasis active_word_highlight: the currently spoken word is recolored or scaled relative to the rest of the line.
- animation karaoke_fill: a color/fill sweeps across a held line; pop: words scale/bounce in.
- font_family: the LAST image is a reference sheet of candidate fonts, each labeled with its id (e.g. "anton", "bebas-neue"). Compare the caption's LETTERFORMS (weight, proportions, whether it's condensed/rounded/slab, the shape of A/E/G/R) to each sample and return the id that matches best. Judge shape, not color or outline. Only return an id from the sheet; if nothing is a clear match, return "".`;

function pick<T>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function captionDefaults(present: boolean): CaptionStyleProfile {
  return {
    present,
    position: 'bottom',
    chunking: 'sentence',
    words_per_chunk: 0,
    font_size: 'medium',
    emphasis: 'none',
    casing: 'mixed',
    animation: 'none',
    font_descriptor: '',
    font_family: '',
    font_family_name: '',
    text_color: '',
    text_treatment: 'clear',
    treatment_color: null,
    highlight_color: null,
    has_emoji: false,
    style_label: '',
    matched_preset: '',
    preset_label: '',
    preset_confidence: 0
  };
}

/** Score how likely a shot carries spoken-word captions (vs a logo/title). */
function captionLikelihood(shot: ReelShot): number {
  if (shot.text_moments.length === 0) return 0;
  let score = 0;
  for (const tm of shot.text_moments) {
    if (tm.role === 'image_text' || tm.role === 'title') {
      score -= 3;
      continue;
    }
    if (tm.role === 'subtitle') score += 5;
    // Spoken-word captions sit in the lower or middle band, not the corners.
    if (tm.region.startsWith('bottom') || tm.region.startsWith('middle')) {
      score += 2;
    }
    if (tm.region.endsWith('center')) score += 1;
    // Longer strings read as dialogue rather than a one-word sticker/logo.
    score += Math.min(tm.text.length, 40) / 20;
  }
  return Math.max(0, score);
}

function selectFrames(
  shot: ReelShot,
  frames: ExtractedFrame[]
): ExtractedFrame[] {
  const withB64 = frames.filter((f) => f.jpegBase64);
  if (withB64.length <= FRAMES_PER_SHOT) return withB64;
  // First, middle, last - spread to reveal animation across the shot.
  const last = withB64.length - 1;
  const mid = Math.floor(last / 2);
  const idxs = [...new Set([0, mid, last])];
  return idxs.map((i) => withB64[i]);
}

/**
 * Detect the spoken-word caption style of a single reel.
 *
 * `framesByShot` must be aligned 1:1 by position with `shots` (the same
 * shot ordering the analyzer uses everywhere else) — entry i holds the
 * sample frames for shots[i].
 */
export async function detectCaptionStyle(
  shots: ReelShot[],
  framesByShot: ExtractedFrame[][]
): Promise<CaptionStyleProfile | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const candidates = shots
    .map((shot, index) => ({ shot, index, score: captionLikelihood(shot) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SHOTS);

  // No on-screen text anywhere -> the reel simply has no captions.
  if (candidates.length === 0) return captionDefaults(false);

  const images: string[] = [];
  for (const c of candidates) {
    const frames = framesByShot[c.index] ?? [];
    for (const f of selectFrames(c.shot, frames)) {
      if (images.length >= MAX_IMAGES) break;
      images.push(f.jpegBase64);
    }
    if (images.length >= MAX_IMAGES) break;
  }

  if (images.length === 0) return captionDefaults(false);

  const client = new OpenAI({ apiKey });
  const sheet = loadFontReferenceSheet();
  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: 'text',
      text: sheet
        ? 'Classify the spoken-word caption style across these frames. The FINAL image is the font reference sheet — use it to pick font_family.'
        : 'Classify the spoken-word caption style across these frames.'
    },
    ...images.map(
      (b64): OpenAI.Chat.Completions.ChatCompletionContentPart => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' }
      })
    )
  ];
  // The reference sheet needs detail:high — the model must read small
  // letterform differences and the id labels to match a font.
  if (sheet) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${sheet}`, detail: 'high' }
    });
  }

  try {
    const resp = await client.chat.completions.create({
      model: CAPTION_STYLE_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      max_tokens: 300,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    const raw = resp.choices[0]?.message?.content;
    if (!raw) return captionDefaults(false);
    const p = JSON.parse(raw) as Record<string, unknown>;
    const present = p.present === true;
    if (!present) return captionDefaults(false);
    const profile: CaptionStyleProfile = {
      present: true,
      position: pick(p.position, POSITIONS, 'bottom'),
      chunking: pick(p.chunking, CHUNKINGS, 'sentence'),
      words_per_chunk:
        typeof p.words_per_chunk === 'number' && p.words_per_chunk > 0
          ? Math.round(p.words_per_chunk)
          : 0,
      font_size: pick(p.font_size, FONT_SIZES, 'medium'),
      emphasis: pick(p.emphasis, EMPHASES, 'none'),
      casing: pick(p.casing, CASINGS, 'mixed'),
      animation: pick(p.animation, ANIMATIONS, 'none'),
      font_descriptor:
        typeof p.font_descriptor === 'string' ? p.font_descriptor : '',
      font_family:
        typeof p.font_family === 'string' && FONT_IDS.includes(p.font_family)
          ? p.font_family
          : '',
      font_family_name:
        typeof p.font_family === 'string'
          ? (FONT_NAME_BY_ID.get(p.font_family) ?? '')
          : '',
      text_color: typeof p.text_color === 'string' ? p.text_color : '',
      text_treatment: pick(p.text_treatment, TREATMENTS, 'clear'),
      treatment_color:
        typeof p.treatment_color === 'string' && p.treatment_color
          ? p.treatment_color
          : null,
      highlight_color:
        typeof p.highlight_color === 'string' && p.highlight_color
          ? p.highlight_color
          : null,
      has_emoji: p.has_emoji === true,
      style_label: typeof p.style_label === 'string' ? p.style_label : '',
      matched_preset: '',
      preset_label: '',
      preset_confidence: 0
    };
    // Snap the detected attributes to the closest premade subtitle style.
    // The match's preset_id maps onto the profile's matched_preset field
    // (a bare spread would add a stray preset_id key and leave
    // matched_preset empty forever).
    const match = matchSubtitlePreset(profile);
    return {
      ...profile,
      matched_preset: match.preset_id,
      preset_label: match.preset_label,
      preset_confidence: match.preset_confidence,
    };
  } catch {
    return null;
  }
}

// --- Collection-level aggregation -----------------------------------------

export interface CaptionStyleSummary {
  /** Fraction of reels (with a profile) that use spoken-word captions. */
  captions_pct: number;
  n_with_captions: number;
  /** Closest premade subtitle preset across the captioned reels
   *  (majority id), 'mixed' when no id wins, '' when none captioned. */
  matched_preset: string;
  /** Label of the majority preset (matched_preset), '' when none. */
  preset_label: string;
  /** Mean preset_confidence across captioned reels. */
  preset_confidence_avg: number;
  /** Count of reels per matched preset id. */
  preset_distribution: Record<string, number>;
  position: CaptionPosition | 'mixed';
  chunking: CaptionChunking | 'mixed';
  /** Mean words-per-group across captioned reels (0 when none report it). */
  words_per_chunk_avg: number;
  font_size: CaptionFontSize | 'mixed';
  text_treatment: CaptionTreatment | 'mixed';
  treatment_color_examples: string[];
  treatment_distribution: Record<string, number>;
  /** Most common base text color across captioned reels ('' if none). */
  text_color: string;
  /** Most common active/keyword highlight color (null if none). */
  highlight_color: string | null;
  emphasis: CaptionEmphasis | 'mixed';
  casing: CaptionCasing | 'mixed';
  animation: CaptionAnimation | 'mixed';
  position_distribution: Record<string, number>;
  chunking_distribution: Record<string, number>;
  font_size_distribution: Record<string, number>;
  emphasis_distribution: Record<string, number>;
  casing_distribution: Record<string, number>;
  animation_distribution: Record<string, number>;
  has_emoji_pct: number;
  /** Closest matched font across captioned reels (majority id), '' none. */
  font_family: string;
  /** Display name of the majority font_family. */
  font_family_name: string;
  /** Count of reels per matched font id. */
  font_family_distribution: Record<string, number>;
  /** Example free-text descriptors from the captioned reels. */
  font_descriptors: string[];
  style_labels: string[];
}

function tally<T extends string>(values: T[]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const v of values) d[v] = (d[v] || 0) + 1;
  return d;
}

/** Majority value (>50% of non-empty inputs), else 'mixed'. */
function majority<T extends string>(values: T[]): T | 'mixed' {
  if (values.length === 0) return 'mixed';
  const d = tally(values);
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of Object.entries(d)) {
    if (n > bestN) {
      bestN = n;
      best = k as T;
    }
  }
  if (best && bestN / values.length > 0.5) return best;
  return 'mixed';
}

/** Most frequent non-empty value, or '' when none. Unlike `majority`,
 *  it doesn't require >50% — used for free-text colors where any plurality
 *  is a useful default. */
function topValue(values: Array<string | null | undefined>): string {
  const d = tally(values.filter((v): v is string => !!v));
  let best = '';
  let bestN = 0;
  for (const [k, n] of Object.entries(d)) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

export function summarizeCaptionStyles(
  profiles: Array<CaptionStyleProfile | null | undefined>
): CaptionStyleSummary {
  const present = profiles.filter(
    (p): p is CaptionStyleProfile => !!p && p.present
  );
  const n = profiles.filter((p): p is CaptionStyleProfile => !!p).length;
  const withCaptions = present.length;

  const presetIds = present
    .map((p) => p.matched_preset)
    .filter((id): id is string => !!id);
  const presetMajority = majority(presetIds);
  const matchedPreset = presetMajority === 'mixed' ? 'mixed' : presetMajority;
  // Label that goes with the winning id (any reel carrying it has it).
  const presetLabel =
    matchedPreset && matchedPreset !== 'mixed'
      ? (present.find((p) => p.matched_preset === matchedPreset)
          ?.preset_label ?? '')
      : '';

  return {
    captions_pct: n > 0 ? withCaptions / n : 0,
    n_with_captions: withCaptions,
    matched_preset: presetIds.length > 0 ? matchedPreset : '',
    preset_label: presetLabel,
    preset_confidence_avg:
      present.length > 0
        ? present.reduce((a, p) => a + p.preset_confidence, 0) / present.length
        : 0,
    preset_distribution: tally(presetIds),
    position: majority(present.map((p) => p.position)),
    chunking: majority(present.map((p) => p.chunking)),
    words_per_chunk_avg: (() => {
      const counts = present
        .map((p) => p.words_per_chunk)
        .filter((n) => n > 0);
      return counts.length > 0
        ? counts.reduce((a, b) => a + b, 0) / counts.length
        : 0;
    })(),
    font_size: majority(present.map((p) => p.font_size)),
    text_treatment: majority(present.map((p) => p.text_treatment)),
    treatment_color_examples: [
      ...new Set(
        present
          .map((p) => p.treatment_color)
          .filter((c): c is string => !!c)
      )
    ].slice(0, 5),
    treatment_distribution: tally(present.map((p) => p.text_treatment)),
    text_color: topValue(present.map((p) => p.text_color)),
    highlight_color: topValue(present.map((p) => p.highlight_color)) || null,
    emphasis: majority(present.map((p) => p.emphasis)),
    casing: majority(present.map((p) => p.casing)),
    animation: majority(present.map((p) => p.animation)),
    position_distribution: tally(present.map((p) => p.position)),
    chunking_distribution: tally(present.map((p) => p.chunking)),
    font_size_distribution: tally(present.map((p) => p.font_size)),
    emphasis_distribution: tally(present.map((p) => p.emphasis)),
    casing_distribution: tally(present.map((p) => p.casing)),
    animation_distribution: tally(present.map((p) => p.animation)),
    has_emoji_pct:
      withCaptions > 0
        ? present.filter((p) => p.has_emoji).length / withCaptions
        : 0,
    ...(() => {
      const ids = present
        .map((p) => p.font_family)
        .filter((id): id is string => !!id);
      const maj = majority(ids);
      const id = ids.length > 0 ? maj : '';
      return {
        font_family: id,
        font_family_name:
          id && id !== 'mixed'
            ? (present.find((p) => p.font_family === id)?.font_family_name ?? '')
            : '',
        font_family_distribution: tally(ids)
      };
    })(),
    font_descriptors: [
      ...new Set(present.map((p) => p.font_descriptor).filter(Boolean))
    ].slice(0, 5),
    style_labels: [
      ...new Set(present.map((p) => p.style_label).filter(Boolean))
    ].slice(0, 5)
  };
}
