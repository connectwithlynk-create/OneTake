// Turns a finished ReelAnalysisResult into an EDITING BRIEF — the spec a
// person would hand a pro social-media editor to recreate the video's
// style. Unlike the raw metrics, the brief explains the EDITORIAL LOGIC:
// what kind of footage runs on the main track, what overlays sit on top,
// how those overlays are placed/organized, and — crucially — how the
// VISUALS relate to the SCRIPT (what's shown while each thing is said).
//
// Primary path is an OpenAI text call grounded on a compact per-shot
// digest (script = spoken_window, footage = visual_caption, plus overlay
// kind/region/motion and the words spoken while each overlay is up). When
// no OPENAI_API_KEY is set or the call fails, a deterministic fallback
// assembles a grounded brief from the same fields so the UI always has
// something real to show.
import OpenAI from 'openai';
import type { ReelAnalysisResult } from './analyze';
import type { ReelShot } from './types';

// One text call per brief; quality of synthesis matters more than cost here.
const MODEL = process.env.ONETAKE_ANALYZE_MODEL?.trim() || 'gpt-4o';

export interface BriefSection {
  title: string;
  /** Short tag shown next to the heading (e.g. "the base footage"). */
  tag?: string;
  /** Imperative directives — each a sentence or two. */
  directives: string[];
}

/** One script→screen pairing: what's being said and what's shown over it. */
export interface ScriptBeat {
  /** What the script says at this beat (a short quote). */
  says: string;
  /** What footage is on the main track while it's said. */
  footage: string;
  /** Overlay shown on top at this beat, or null when the footage runs
   *  clean. Includes placement (e.g. "caption, bottom center"). */
  overlay: string | null;
}

export interface EditingBrief {
  /** One-paragraph framing — hand-this-to-your-editor intro. */
  summary: string;
  sections: BriefSection[];
  /** Representative script→screen pairings, in playback order. */
  script_map: ScriptBeat[];
  /** True when written by the LLM; false for the deterministic fallback. */
  ai_generated: boolean;
}

function mmss(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function clip(s: string | null | undefined, max = 160): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Compact one-line-per-shot digest fed to the model. Keeps the script,
 *  footage, and overlay layers explicit and aligned per shot. */
function shotDigest(shots: ReelShot[]): string {
  return shots
    .map((s, i) => {
      const text =
        s.text_moments.map((m) => m.text.trim()).filter(Boolean).join(' / ') ||
        s.ocr_text?.trim() ||
        '';
      const media = s.overlays
        .map(
          (o) =>
            `${o.kind.replace(/_/g, ' ')}@${o.region.replace(/_/g, ' ')}(${o.motion})` +
            (o.spoken_window ? ` while "${clip(o.spoken_window, 80)}"` : ''),
        )
        .join('; ');
      const layout = [
        s.clip_type,
        s.face_region ? `face@${s.face_region}` : null,
        s.text_moments[0]?.region ? `text@${s.text_moments[0].region}` : null,
        media ? `media-overlay:${media}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      return (
        `#${i + 1} [${mmss(s.start_ms)}-${mmss(s.end_ms)}] type=${s.clip_type}` +
        (s.detected_motion && s.detected_motion.kind !== 'none'
          ? ` motion=${s.detected_motion.kind}`
          : '') +
        (layout ? `\n  layout: ${layout}` : '') +
        `\n  footage: ${clip(s.visual_caption) || '(no caption)'}` +
        `\n  script: ${s.spoken_window ? `"${clip(s.spoken_window)}"` : '(silent)'}` +
        (text ? `\n  text-overlay: "${clip(text, 120)}"` : '') +
        (media ? `\n  media-overlay: ${media}` : '')
      );
    })
    .join('\n');
}

const SYSTEM_PROMPT = `You are a senior short-form video editor writing a production brief. Another editor will read your brief and recreate a reel in the same style WITHOUT seeing the original. You are given a per-shot breakdown of one vertical reel: each shot's footage (visual description), the script (words spoken over it), and any overlays composited on top (burned-in text, stickers, GIFs, picture-in-picture, emoji), including where each overlay sits and what was being said while it was up.

Write the brief as concrete, imperative directions — what to do, not what was observed. Ground every claim in the data; never invent footage or overlays that aren't listed. Be specific about TYPES (e.g. "screen recordings", "talking-head to camera", "stock b-roll", "logo cards"; "word-by-word captions", "reaction stickers", "PiP webcam").

Critically, explain the RELATIONSHIP between the script and what's shown:
- When the script introduces a concept/product/person, what footage or image appears?
- What base clip type and canvas layout is used at each part of the script (talking head, product/screen b-roll, screenshot, PiP, split screen, full-screen visual)?
- Which lines get an overlay, and what kind, and where is it placed?
- How are overlays organized across the reel (consistent corner? swapped per beat? on the cut?)?

Return ONLY JSON matching exactly:
{
  "summary": "one paragraph, hand-this-to-your-editor framing",
  "sections": [
    { "title": "Pace & structure", "directives": ["...", "..."] },
    { "title": "Main track", "tag": "the base footage", "directives": ["what footage types and layouts to source/use at each script stage"] },
    { "title": "Overlays", "tag": "composited on top", "directives": ["what overlays to add, their types, and how to place/organize them"] },
    { "title": "Sound design", "directives": ["..."] }
  ],
  "script_map": [
    { "says": "short quote from the script", "footage": "what's on the main track here", "overlay": "overlay shown + placement, or null" }
  ]
}

Rules: 3-6 directives per section. 4-8 script_map beats covering the arc start-to-finish. In script_map.footage, include clip type + layout when visible. Keep directives under 35 words. No markdown, no preamble — JSON only.`;

let clientPromise: Promise<OpenAI | null> | null = null;
function getClient(): Promise<OpenAI | null> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error('[brief] OPENAI_API_KEY not set; using fallback brief');
        return null;
      }
      return new OpenAI({ apiKey });
    })();
  }
  return clientPromise;
}

/** Coerce arbitrary parsed JSON into a valid EditingBrief, dropping
 *  malformed entries rather than throwing. */
function coerce(raw: unknown, ai: boolean): EditingBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sections = Array.isArray(o.sections)
    ? o.sections
        .map((s) => {
          const sec = s as Record<string, unknown>;
          const directives = Array.isArray(sec.directives)
            ? sec.directives.filter((d): d is string => typeof d === 'string')
            : [];
          if (typeof sec.title !== 'string' || directives.length === 0)
            return null;
          return {
            title: sec.title,
            tag: typeof sec.tag === 'string' ? sec.tag : undefined,
            directives,
          } as BriefSection;
        })
        .filter((x): x is BriefSection => x !== null)
    : [];
  const script_map = Array.isArray(o.script_map)
    ? o.script_map
        .map((b) => {
          const beat = b as Record<string, unknown>;
          if (typeof beat.says !== 'string' || typeof beat.footage !== 'string')
            return null;
          return {
            says: beat.says,
            footage: beat.footage,
            overlay:
              typeof beat.overlay === 'string' && beat.overlay.trim()
                ? beat.overlay
                : null,
          } as ScriptBeat;
        })
        .filter((x): x is ScriptBeat => x !== null)
    : [];
  if (sections.length === 0) return null;
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    sections,
    script_map,
    ai_generated: ai,
  };
}

/** Deterministic, fully-grounded fallback. Builds the same shape from the
 *  raw fields with real quoted examples — used when there's no API key or
 *  the model call fails. */
function fallbackBrief(
  a: ReelAnalysisResult,
  durationMs: number,
): EditingBrief {
  const durSec = (durationMs / 1000).toFixed(0);
  const pacingWord =
    a.cuts_per_sec > 0.7 ? 'punchy' : a.cuts_per_sec >= 0.35 ? 'steady' : 'relaxed';
  const talkPct = Math.round(a.talking_pct * 100);
  const brollPct = Math.round(a.broll_pct * 100);
  const voPct = Math.round(a.voiceover_pct * 100);
  const musicPct = Math.round(a.music_pct * 100);
  const textShotPct = Math.round(a.text_overlay_pct * 100);
  const mediaShotPct = Math.round(a.media_overlay_pct * 100);
  const hook = a.hook_speech || a.hook_text;

  // Distinct footage types from clip_type distribution.
  const footageTypes = Object.entries(a.clip_type_distribution)
    .filter(([, v]) => v > 0.02)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k.replace(/_/g, ' ')} (${Math.round(v * 100)}%)`);
  const ovKinds = a.overlay_kind_distribution
    ? Object.entries(a.overlay_kind_distribution)
        .filter(([, v]) => v > 0)
        .sort((x, y) => y[1] - x[1])
        .map(([k]) => k.replace(/_/g, ' '))
    : [];

  const pace: string[] = [
    `Cut it ${pacingWord}: ${a.shots.length} scenes across ${durSec}s, ~${a.cuts_per_sec.toFixed(1)} cuts/sec. Don't let a shot sit.`,
    hook
      ? `Open cold on the hook — lead with "${clip(hook, 90)}". No slow intro.`
      : `Open on your strongest visual in the first 3s.`,
  ];

  const track: string[] = [];
  track.push(
    footageTypes.length
      ? `Footage mix: ${footageTypes.join(', ')}.`
      : `Footage mix unavailable.`,
  );
  track.push(
    talkPct >= 60
      ? `Mostly on-camera talking head (~${talkPct}%); cut to b-roll for the rest.`
      : brollPct >= 60
        ? `Mostly b-roll (~${brollPct}%) carried by voiceover; ~${talkPct}% talking head.`
        : `Alternate talking head (~${talkPct}%) and b-roll (~${brollPct}%).`,
  );
  track.push(
    voPct >= musicPct
      ? `Drive with voiceover (~${voPct}%) over a music bed (~${musicPct}%).`
      : `Music bed leads (~${musicPct}%) under ~${voPct}% voiceover.`,
  );

  const overlays: string[] = [];
  if (a.caption_style?.present) {
    const cs = a.caption_style;
    overlays.push(
      `Burn in spoken-word captions: ${cs.chunking.replace(/_/g, ' ')}, ${cs.casing.replace(/_/g, ' ')}, ${cs.position.replace(/_/g, ' ')}, ${cs.text_color}, ${cs.animation.replace(/_/g, ' ')} animation.`,
    );
  }
  if (textShotPct > 0) {
    overlays.push(
      `Title/text overlays on ~${textShotPct}% of scenes${
        a.text_region_dominant && a.text_region_dominant !== 'mixed'
          ? `, placed ${a.text_region_dominant.replace(/_/g, ' ')}`
          : ''
      }.`,
    );
  }
  if (mediaShotPct > 0) {
    overlays.push(
      `Layer media graphics${ovKinds.length ? ` (${ovKinds.join(', ')})` : ''} on ~${mediaShotPct}% of scenes${
        a.overlay_region_distribution
          ? `, mostly ${
              Object.entries(a.overlay_region_distribution)
                .sort((x, y) => y[1] - x[1])[0][0]
                .replace(/_/g, ' ')
            }`
          : ''
      }.`,
    );
  }
  if (overlays.length === 0)
    overlays.push('Keep the frame clean — no captions, titles, or graphics.');

  const sound: string[] = [
    `Mix ~${voPct}% voiceover with ~${musicPct}% music.`,
  ];
  if (a.sfx_per_min > 0.5)
    sound.push(
      `SFX ~${a.sfx_per_min.toFixed(1)}/min${a.cuts_with_sfx_pct >= 0.3 ? ', on the cuts' : ''}.`,
    );

  // Real script→screen pairings: spoken shots, spread across the reel.
  const spoken = a.shots.filter((s) => s.spoken_window.trim());
  const picks: ReelShot[] = [];
  const want = Math.min(6, spoken.length);
  for (let i = 0; i < want; i++) {
    picks.push(spoken[Math.floor((i * (spoken.length - 1)) / Math.max(want - 1, 1))]);
  }
  const script_map: ScriptBeat[] = picks.map((s) => {
    const text =
      s.text_moments.map((m) => m.text.trim()).filter(Boolean).join(' / ') || '';
    const media = s.overlays[0];
    const overlay = text
      ? `text overlay "${clip(text, 50)}"`
      : media
        ? `${media.kind.replace(/_/g, ' ')}, ${media.region.replace(/_/g, ' ')}`
        : null;
    return {
      says: clip(s.spoken_window, 90),
      footage: clip(s.visual_caption, 90) || s.clip_type.replace(/_/g, ' '),
      overlay,
    };
  });

  return {
    summary: `Hand this to your editor: cut a ~${durSec}s vertical ${pacingWord} reel. Main track is ${
      talkPct >= 60 ? 'talking-head-led' : brollPct >= 60 ? 'b-roll-led' : 'a talking-head / b-roll mix'
    }; overlays ${overlays[0].startsWith('Keep') ? 'are minimal' : 'carry text and graphics on top'}.`,
    sections: [
      { title: 'Pace & structure', directives: pace },
      { title: 'Main track', tag: 'the base footage', directives: track },
      { title: 'Overlays', tag: 'composited on top', directives: overlays },
      { title: 'Sound design', directives: sound },
    ],
    script_map,
    ai_generated: false,
  };
}

/** Collection-level brief for plan creation: merges the style reels into
 *  one analysis (their shots pooled, scalar metrics averaged) and briefs
 *  that, so the result describes the COLLECTION's editorial style rather
 *  than a single reel. Returns null only when no reel has shots. Used by
 *  the synthesizer to feed the brief's directions into the plan. */
export async function generateCollectionBrief(
  analyses: ReelAnalysisResult[],
): Promise<EditingBrief | null> {
  const valid = analyses.filter((a) => a.shots.length > 0);
  if (valid.length === 0) return null;
  const mean = (f: (a: ReelAnalysisResult) => number): number =>
    valid.reduce((s, a) => s + f(a), 0) / valid.length;
  const durations = valid.map((a) => a.shots[a.shots.length - 1].end_ms);
  const meanDuration = durations.reduce((s, d) => s + d, 0) / valid.length;
  // Inherit the full shape from the first reel, then pool shots and
  // average the scalars the brief actually reads. Distributions /
  // caption_style stay from the first reel — a fine approximation for a
  // narrative brief.
  const merged: ReelAnalysisResult = {
    ...valid[0],
    shots: valid.flatMap((a) => a.shots).slice(0, 90),
    median_shot_ms: mean((a) => a.median_shot_ms),
    cuts_per_sec: mean((a) => a.cuts_per_sec),
    talking_pct: mean((a) => a.talking_pct),
    broll_pct: mean((a) => a.broll_pct),
    text_overlay_pct: mean((a) => a.text_overlay_pct),
    media_overlay_pct: mean((a) => a.media_overlay_pct),
    voiceover_pct: mean((a) => a.voiceover_pct),
    music_pct: mean((a) => a.music_pct),
    audio_silence_pct: mean((a) => a.audio_silence_pct),
    sfx_per_min: mean((a) => a.sfx_per_min),
    cuts_with_sfx_pct: mean((a) => a.cuts_with_sfx_pct),
  };
  return generateEditingBrief(merged, Math.round(meanDuration));
}

export async function generateEditingBrief(
  a: ReelAnalysisResult,
  durationMs: number,
): Promise<EditingBrief> {
  if (a.shots.length === 0) return fallbackBrief(a, durationMs);
  const client = await getClient();
  if (!client) return fallbackBrief(a, durationMs);

  const stats =
    `duration=${(durationMs / 1000).toFixed(0)}s shots=${a.shots.length} ` +
    `cuts/sec=${a.cuts_per_sec.toFixed(2)} talking=${Math.round(a.talking_pct * 100)}% ` +
    `broll=${Math.round(a.broll_pct * 100)}% voiceover=${Math.round(a.voiceover_pct * 100)}% ` +
    `music=${Math.round(a.music_pct * 100)}% text-overlay-scenes=${Math.round(a.text_overlay_pct * 100)}% ` +
    `media-overlay-scenes=${Math.round(a.media_overlay_pct * 100)}% sfx/min=${a.sfx_per_min.toFixed(1)}` +
    (a.caption_style?.present
      ? ` captions=${a.caption_style.chunking}/${a.caption_style.position}/${a.caption_style.casing}`
      : ' captions=none');

  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1400,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `REEL STATS\n${stats}\n\nPER-SHOT BREAKDOWN (script / footage / overlays)\n${shotDigest(
            a.shots,
          )}\n\nWrite the editing brief as JSON.`,
        },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? '';
    const parsed = coerce(JSON.parse(text), true);
    if (parsed) return parsed;
    console.error('[brief] model JSON missing required shape; using fallback');
  } catch (err) {
    console.error(
      '[brief] generation failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return fallbackBrief(a, durationMs);
}
