// Media-overlay PATTERN detection via OpenAI.
//
// Beyond the aggregate distributions (overlay_kind_distribution etc.), a
// creator's overlays follow a PATTERN tied to the script: a reaction GIF
// pops in the corner on a punchline, a logo lockup drops bottom-center when
// they name the company, an emoji burst hits the hook. This clusters every
// MEDIA overlay across the collection — never text captions — into reusable
// pattern entries the synthesis engine can mirror: what TYPE, WHERE it sits,
// HOW OFTEN, in WHAT SCRIPT CONTEXT, and with what motion.
//
// Text overlays (burned-in captions / sticker text) are tracked separately
// (text_moments / caption_style) and are explicitly EXCLUDED here.
//
// Best-effort: no API key / API error / no overlays → null, and callers
// fall back to the raw distributions.
import OpenAI from 'openai';
import type { ReelAnalysisResult } from './analyze';
import type { FrameRegion, OverlayKind } from './types';

const MODEL = process.env.ONETAKE_ANALYZE_MODEL?.trim() || 'gpt-4o';

/** One recurring media-overlay behavior the creator repeats. */
export interface OverlayPatternEntry {
  /** Media-overlay type. NEVER text — one of the analyzer's OverlayKind. */
  kind: OverlayKind;
  /** How often it shows up, in plain terms grounded in the rate
   *  ("~2 per reel", "on most punchlines", "once, on the hook"). */
  frequency: string;
  /** Where it sits — the dominant 3x3 grid cell for this overlay type. */
  typical_position: FrameRegion;
  /** Placement note beyond the cell ("small corner badge", "full-width
   *  lower third", "centered card covering the frame"). */
  placement: string;
  /** Whether this overlay type tends to be static or animated. */
  motion: 'static' | 'animated' | 'mixed';
  /** WHEN in the script / narrative it appears and WHAT is being said —
   *  the script-mapped context ("when naming the product", "on the
   *  punchline after a beat", "during the hook"). */
  script_context: string;
  /** Verbatim spoken_window snippets from where this overlay appeared. */
  examples: string[];
}

export interface OverlayPattern {
  /** One-paragraph overview of how this creator uses media overlays. */
  summary: string;
  /** Mean media overlays per reel (deterministic, not LLM). */
  per_reel_rate: number;
  /** Media overlays per minute across the collection (deterministic). */
  overlays_per_min: number;
  /** The recurring overlay behaviors, most frequent first. */
  entries: OverlayPatternEntry[];
}

/** Coarse narrative position of a shot within its reel. */
function narrativeBucket(fraction: number): string {
  if (fraction < 0.15) return 'hook/open';
  if (fraction < 0.4) return 'early';
  if (fraction < 0.7) return 'middle';
  if (fraction < 0.9) return 'late';
  return 'close/cta';
}

interface OverlayRow {
  reel: number;
  position: string;
  kind: OverlayKind;
  region: FrameRegion;
  motion: string;
  script: string;
}

/** Pull every MEDIA overlay across the collection with its script +
 *  narrative-position context. Text overlays are not represented in
 *  shot.overlays at all (they live in text_moments), so this is already
 *  text-free by construction. */
function collectOverlays(reels: ReelAnalysisResult[]): {
  rows: OverlayRow[];
  totalMs: number;
} {
  const rows: OverlayRow[] = [];
  let totalMs = 0;
  reels.forEach((reel, ri) => {
    const reelDur = reel.shots.reduce((m, s) => Math.max(m, s.end_ms), 0) || 1;
    totalMs += reelDur;
    for (const shot of reel.shots) {
      for (const ov of shot.overlays) {
        rows.push({
          reel: ri,
          position: `${narrativeBucket(shot.start_ms / reelDur)} ${(
            shot.start_ms / reelDur
          ).toFixed(2)}`,
          kind: ov.kind,
          region: ov.region,
          motion: ov.motion,
          script:
            ov.spoken_window?.replace(/\s+/g, ' ').trim().slice(0, 120) ||
            shot.spoken_window?.replace(/\s+/g, ' ').trim().slice(0, 120) ||
            '',
        });
      }
    }
  });
  return { rows, totalMs };
}

const SYSTEM_PROMPT = `You analyze how a short-form video creator uses MEDIA OVERLAYS — stickers, GIFs, images/cards, picture-in-picture, emoji graphics — composited ON TOP of their footage. You are given every media overlay across their reels with: its type, grid position, motion, the narrative position in the reel, and the words spoken while it was on screen.

NEVER treat burned-in text captions / subtitles as overlays — they are excluded from your input and must never appear in your output. Only the media-overlay TYPES listed above.

Find the reusable PATTERN: which overlay types recur, how often, WHERE they sit, with what motion, and — most importantly — in WHAT SCRIPT CONTEXT they appear (what's being said / where in the narrative). Ground every claim in the data; do not invent overlays that aren't present.

Return ONLY JSON, this exact shape (no markdown, no prose):
{
  "summary": "one paragraph on how this creator uses media overlays",
  "entries": [
    {
      "kind": "<one of: image | sticker | gif | pip_video | emoji_graphic>",
      "frequency": "plain-language rate, e.g. '~2 per reel' or 'once, on the hook'",
      "typical_position": "<3x3 grid cell, e.g. top_right>",
      "placement": "short note, e.g. 'small corner badge' or 'full-width lower third'",
      "motion": "static | animated | mixed",
      "script_context": "WHEN in the script it appears + what is being said",
      "examples": ["verbatim spoken snippet from the input", "..."]
    }
  ]
}

Rules:
- entries sorted most-frequent first; merge the same kind+context into one entry.
- examples MUST be copied verbatim from the input scripts (max 3 each); use [] if none had speech.
- typical_position must be one of the nine grid cells. kind must be one of the five media types — NEVER a text/caption type.
- If overlays show no real pattern, return a single entry summarizing what little there is.`;

/** Detect the collection's media-overlay pattern. Returns null when there
 *  are no media overlays, no API key, or the call fails. */
export async function detectOverlayPattern(
  reels: ReelAnalysisResult[],
): Promise<OverlayPattern | null> {
  const { rows, totalMs } = collectOverlays(reels);
  if (rows.length === 0) return null;

  const perReelRate = rows.length / Math.max(reels.length, 1);
  const overlaysPerMin = totalMs > 0 ? (rows.length * 60_000) / totalMs : 0;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[overlay-pattern] OPENAI_API_KEY not set');
    return null;
  }
  const client = new OpenAI({ apiKey });

  // Cap rows fed to the model to bound tokens; the rate stats above are
  // computed from the FULL set so frequency stays accurate.
  const sample = rows.slice(0, 80);
  const userMessage =
    `${reels.length} reels, ${rows.length} media overlays total ` +
    `(~${perReelRate.toFixed(1)} per reel, ${overlaysPerMin.toFixed(1)}/min).\n\n` +
    `Each overlay — [reel, narrative-position] kind region motion | script:\n` +
    sample
      .map(
        (r) =>
          `[r${r.reel}, ${r.position}] ${r.kind} ${r.region} ${r.motion}` +
          (r.script ? ` | "${r.script}"` : ' | (silent)'),
      )
      .join('\n');

  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? '';
    if (!text) return null;
    const parsed = JSON.parse(text) as {
      summary?: string;
      entries?: OverlayPatternEntry[];
    };
    if (!parsed.entries || !Array.isArray(parsed.entries)) return null;
    const entries: OverlayPatternEntry[] = parsed.entries
      .filter(
        (e) =>
          e &&
          typeof e.kind === 'string' &&
          typeof e.script_context === 'string',
      )
      .map((e) => ({
        kind: e.kind,
        frequency: typeof e.frequency === 'string' ? e.frequency : '',
        typical_position: e.typical_position,
        placement: typeof e.placement === 'string' ? e.placement : '',
        motion:
          e.motion === 'static' || e.motion === 'animated' ? e.motion : 'mixed',
        script_context: e.script_context,
        examples: Array.isArray(e.examples)
          ? e.examples
              .filter((x): x is string => typeof x === 'string')
              .slice(0, 3)
          : [],
      }));
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      per_reel_rate: perReelRate,
      overlays_per_min: overlaysPerMin,
      entries,
    };
  } catch (err) {
    console.error(
      '[overlay-pattern] API call failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
