// Command-bar agent — a tool-calling AI agent with FULL editor parity.
// Every operation a human can perform in the plan editor is mirrored here as
// a tool with the SAME semantics as the renderer's handlers (boundary
// clamping, delete-with-neighbor-absorption, pick moves with options[0]
// sync), so the agent can do anything the user can: trim shots, delete
// shots, move clips between shots, change layouts/motion/text/subtitles,
// control the SFX timeline down to individual events, and queue curation.
//
// The model discovers what it can do FROM THE TOOL SCHEMAS — no hardcoded
// command parsing. Tools run against a server-side working copy of the plan;
// the final plan + queued renderer actions go back over IPC.
import OpenAI from 'openai';
import { existsSync, readFileSync } from 'fs';
import { extname, join, resolve } from 'path';
import type {
  SuggestedEdit,
  PlanAgentResult,
  AnimationEasing,
  BrollAspect,
  BrollFit,
  SceneAnimation,
  SelectedMedia,
} from './analyze/synthesize';
import type { FrameRegion } from './analyze/types';
import type { SubtitleSpec } from './analyze/subtitle-spec';
import type { SfxType } from './analyze/sfx-classify';
import {
  buildSfxTimeline,
  dominantCueBucket,
  searchSfxLibrary,
} from './export/sfx-resolve';
import { extractReelAudio } from './analyze/audio';
import { transcribeReel, type TranscriptWord } from './analyze/transcribe';
import { CAPTURES_DIR_PATH } from './curator/web-record';

const MODEL = process.env.ONETAKE_PLAN_AGENT_MODEL?.trim() || 'gpt-4o';
const MAX_TURNS = 10;
const MIN_SHOT_MS = 200; // mirrors the renderer's boundary clamp

let clientPromise: Promise<OpenAI | null> | null = null;
function getClient(): Promise<OpenAI | null> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error('[agent] OPENAI_API_KEY not set');
        return null;
      }
      return new OpenAI({ apiKey });
    })();
  }
  return clientPromise;
}

// ---- loose-value normalizers (model wording -> enums) ----
const TYPE_SYNONYMS: Record<string, SfxType> = {
  impulse_tonal: 'impulse_tonal', ding: 'impulse_tonal', dings: 'impulse_tonal',
  bell: 'impulse_tonal', chime: 'impulse_tonal', tone: 'impulse_tonal',
  beep: 'impulse_tonal', ping: 'impulse_tonal',
  impulse_noisy: 'impulse_noisy', clap: 'impulse_noisy', impact: 'impulse_noisy',
  snap: 'impulse_noisy', hit: 'impulse_noisy', punch: 'impulse_noisy',
  boom: 'impulse_noisy', bang: 'impulse_noisy', pop: 'impulse_noisy',
  sweep: 'sweep', whoosh: 'sweep', swoosh: 'sweep', swish: 'sweep',
  transition: 'sweep', riser: 'sweep',
  vocal: 'vocal', wow: 'vocal', voice: 'vocal', stinger: 'vocal',
  sustained: 'sustained', drone: 'sustained', hum: 'sustained',
};
const ANIM_SYNONYMS: Record<string, SceneAnimation> = {
  none: 'none', off: 'none',
  zoom_in: 'zoom_in', zoom: 'zoom_in', zoomin: 'zoom_in',
  punch: 'punch_in', punch_in: 'punch_in', punchin: 'punch_in',
  zoom_out: 'zoom_out', zoomout: 'zoom_out',
  pan_left: 'pan_left', panleft: 'pan_left',
  pan_right: 'pan_right', panright: 'pan_right', pan: 'pan_right',
  ken_burns: 'ken_burns', kenburns: 'ken_burns',
};
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
const VALID_EASINGS: AnimationEasing[] = [
  'ease-in-out',
  'linear',
  'ease-out',
  'ease-in',
];
const VALID_BROLL_ASPECTS: BrollAspect[] = [
  '9:16',
  '16:9',
  '1:1',
  '4:5',
  '3:4',
  'original',
];
const VALID_BROLL_FITS: BrollFit[] = [
  'fill',
  'contain',
  'pip',
  'split_top',
  'split_bottom',
  'split_left',
  'split_right',
];
function normKey(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase().replace(/[\s-]+/g, '_').trim() : '';
}
function normType(v: unknown): SfxType | undefined {
  const k = normKey(v);
  if (!k) return undefined;
  if (TYPE_SYNONYMS[k]) return TYPE_SYNONYMS[k];
  for (const key of Object.keys(TYPE_SYNONYMS)) if (k.includes(key)) return TYPE_SYNONYMS[key];
  return undefined;
}
function normCadence(v: unknown): 'every_word' | 'sparse' | 'normal' | 'off' | undefined {
  const k = normKey(v);
  if (!k) return undefined;
  if (k.includes('every_word') || k.includes('each_word') || k === 'per_word') return 'every_word';
  if (k.includes('spars')) return 'sparse';
  if (k === 'off' || k.includes('none') || k.includes('remov')) return 'off';
  if (k.includes('normal') || k.includes('default')) return 'normal';
  return undefined;
}
function normAnimation(v: unknown): SceneAnimation | undefined {
  const k = normKey(v);
  if (!k) return undefined;
  if (ANIM_SYNONYMS[k]) return ANIM_SYNONYMS[k];
  for (const key of Object.keys(ANIM_SYNONYMS)) if (k.includes(key)) return ANIM_SYNONYMS[key];
  return undefined;
}
function normRegion(v: unknown): FrameRegion | undefined {
  const k = normKey(v);
  return (VALID_REGIONS as readonly string[]).includes(k)
    ? (k as FrameRegion)
    : undefined;
}
function normEasing(v: unknown): AnimationEasing | undefined {
  const raw = typeof v === 'string' ? v.trim() : '';
  return (VALID_EASINGS as readonly string[]).includes(raw)
    ? (raw as AnimationEasing)
    : undefined;
}
function normBrollAspect(v: unknown): BrollAspect | undefined {
  const raw = typeof v === 'string' ? v.trim() : '';
  return (VALID_BROLL_ASPECTS as readonly string[]).includes(raw)
    ? (raw as BrollAspect)
    : undefined;
}
function normBrollFit(v: unknown): BrollFit | undefined {
  const k = normKey(v);
  return (VALID_BROLL_FITS as readonly string[]).includes(k)
    ? (k as BrollFit)
    : undefined;
}
function clampNum(v: unknown, lo: number, hi: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(lo, Math.min(hi, n));
}
function intNum(v: unknown, lo: number, hi: number): number | undefined {
  const n = clampNum(v, lo, hi);
  return n === undefined ? undefined : Math.round(n);
}

/** Does an SFX event match a free-text descriptor like "ding", "wow",
 *  "impulse_tonal", or "all"? Matches a specific sound by name-substring,
 *  or a coarse type/bucket. Lets targeted edits hit only the right subset
 *  (e.g. "replace the dings" leaves the "wow"s alone). */
function eventMatches(
  ev: { type: SfxType; sound?: string },
  descriptor: string,
): boolean {
  const f = descriptor.toLowerCase().trim();
  if (!f || f === 'all' || f === 'everything' || f === 'every sfx') return true;
  // Events with a SPECIFIC named sound only match by that name. This is the
  // key disambiguation: "ding" must NOT match a "wow" event just because both
  // happen to share the impulse_tonal bucket — match the sound, not the bucket.
  if (ev.sound) return ev.sound.toLowerCase().includes(f);
  // Sound-less (bucket-only) events match their acoustic type + synonyms.
  const t = normType(f);
  return !!t && ev.type === t;
}

// Layout presets — mirror of the renderer's LAYOUT_PRESETS.
type Placement = SuggestedEdit['shots'][number]['placement'];
const LAYOUTS: Record<string, Placement> = {
  fill: { aspect: 'original', fit: 'fill', position: 'middle_center', scale: 1 },
  contain: { aspect: 'original', fit: 'contain', position: 'middle_center', scale: 1 },
  split_top: { aspect: 'original', fit: 'split_top', position: 'top_center', scale: 0.5 },
  split_bottom: { aspect: 'original', fit: 'split_bottom', position: 'bottom_center', scale: 0.5 },
  overlay: { aspect: 'original', fit: 'pip', position: 'middle_center', scale: 0.42 },
};

type Shot = SuggestedEdit['shots'][number];
/** Normalize a shot's selected media to an array (legacy single-pick). */
function picksOf(shot: Shot): SelectedMedia[] {
  const raw = shot.selected_media as SelectedMedia[] | SelectedMedia | null | undefined;
  if (Array.isArray(raw)) return raw;
  return raw ? [raw] : [];
}
/** Patch a shot and keep options[0] in sync with the top-level mirror
 *  (broll_description / asset / placement) — mirrors renderer updateShot. */
function patchShot(shot: Shot, patch: Partial<Shot>): Shot {
  const merged: Shot = { ...shot, ...patch };
  if (merged.options.length > 0) {
    merged.options = merged.options.map((o, i) =>
      i === 0
        ? {
            ...o,
            broll_description: merged.broll_description,
            asset: merged.asset,
            placement: merged.placement,
            source_type: merged.source_type,
          }
        : o,
    );
  }
  return merged;
}

interface FindClipAction {
  kind: 'find_clip';
  query: string;
  shot_idx: number | null;
}

interface AgentCtx {
  plan: SuggestedEdit;
  narrationPath: string | null;
  actions: FindClipAction[];
  /** Cached narration transcript (one Whisper call max per agent run). */
  words: TranscriptWord[] | null;
  /** Set when the agent is unsure and needs the user to pick — ends the run. */
  clarify: { question: string; options: string[] } | null;
  /** Library sounds the agent surfaced (via search_sfx_library) this run, so
   *  the UI can let the user preview every one it mentioned. Deduped by name. */
  presentedSounds: { name: string; label: string | null }[];
}

/** Current SFX events: hand-edited if present, else generated from the
 *  narration transcript + inspiration cadence (transcribing on demand). */
async function materializeSfxEvents(
  ctx: AgentCtx,
): Promise<{ ms: number; type: SfxType; sound?: string; volume?: number }[]> {
  const plan = ctx.plan;
  if (plan.sfx_events && plan.sfx_events.length > 0) return [...plan.sfx_events];
  if (ctx.words === null) {
    ctx.words = [];
    const src = ctx.narrationPath ?? plan.target_video_path ?? null;
    if (src && existsSync(src)) {
      try {
        const samples = await extractReelAudio(src);
        const tr = samples ? await transcribeReel(samples) : null;
        ctx.words = tr?.words ?? [];
      } catch {
        ctx.words = [];
      }
    }
  }
  if (ctx.words.length === 0) return [];
  const first = plan.shots[0];
  const hookMs = first ? first.start_ms + first.duration_ms : 5000;
  return buildSfxTimeline(
    ctx.words,
    plan.sfx_plan ?? null,
    hookMs,
    dominantCueBucket(plan.shots.map((s) => s.sfx_cue)),
    plan.sfx_override ?? null,
  ).map((e) => ({ ms: e.ms, type: e.type, ...(e.sound ? { sound: e.sound } : {}) }));
}

/** The plan-wide SFX gain, used as the baseline when reporting/scaling
 *  per-event volume. */
function baseSfxVolume(ctx: AgentCtx): number {
  return ctx.plan.sfx_volume ?? 0.5;
}

function mimeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function imageUrlToVisionUrl(url: string): string | null {
  if (/^https?:\/\//i.test(url)) return url;
  let path: string | null = null;
  if (url.startsWith('capture://files/')) {
    const rel = url.slice('capture://files/'.length).replace(/^\/+/, '');
    const candidate = join(CAPTURES_DIR_PATH, rel);
    if (candidate.startsWith(CAPTURES_DIR_PATH)) path = candidate;
  } else if (url.startsWith('file://')) {
    try {
      path = new URL(url).pathname;
    } catch {
      path = null;
    }
  } else if (url.startsWith('/')) {
    path = url;
  }
  if (!path || !existsSync(path)) return null;
  const data = readFileSync(path);
  return `data:${mimeForPath(path)};base64,${data.toString('base64')}`;
}

async function inspectImagePoints(
  imageUrl: string,
  prompt: string | undefined,
): Promise<string> {
  const client = await getClient();
  if (!client) return 'error: OPENAI_API_KEY not set';
  const visionUrl = imageUrlToVisionUrl(imageUrl);
  if (!visionUrl) {
    return `error: image URL is not inspectable from main process (${imageUrl})`;
  }
  const ask =
    (prompt && prompt.trim()) ||
    'Find key visual points useful for animation focus: words, symbols, logos, faces, product UI, buttons, and important objects.';
  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You inspect one image for a video editor. Return strict JSON with normalized coordinates. ' +
          'Coordinates use origin top-left, x/y/w/h in 0..1. For each point, provide label, kind ' +
          '(word|symbol|logo|face|object|ui|other), center x/y, optional bbox, confidence 0..1, and why it matters. ' +
          'Favor points a camera zoom/pan could land on.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: ask },
          { type: 'image_url', image_url: { url: visionUrl } },
        ],
      },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() || '{"points":[]}';
}

// ---- tool schemas: the agent's discoverable capability list ----
type Tool = OpenAI.Chat.Completions.ChatCompletionTool;
const num = (description?: string): object => ({ type: 'number', ...(description ? { description } : {}) });
const int = (description?: string): object => ({ type: 'integer', ...(description ? { description } : {}) });
const str = (description?: string): object => ({ type: 'string', ...(description ? { description } : {}) });

const TOOLS: Tool[] = [
  { type: 'function', function: { name: 'get_plan_state', description:
      'Overview of the edit: shot count, total duration, SFX settings (cadence/type/volume/lead, hand-edited?), subtitle state, motions in use. Call before relative edits ("a bit louder").',
      parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_shots', description:
      'List every shot: index, time range ms, role, spoken text, motion, layout fit, text overlay, media picks (count + kinds). Call before any per-shot edit to get correct indices.',
      parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_sfx_events', description:
      'List the current SFX timeline events ({ms,type}). Use before adding/moving/removing individual SFX.',
      parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'move_shot_boundary', description:
      'Trim/extend two adjacent shots by moving their shared cut. boundary_idx = index of the LEFT shot; new_ms = absolute reel time of the cut. Total reel length is preserved; both sides keep >=200ms.',
      parameters: { type: 'object', properties: { boundary_idx: int('array index of the left shot'), new_ms: int('new cut position, ms') }, required: ['boundary_idx', 'new_ms'] } } },
  { type: 'function', function: { name: 'delete_shot', description:
      'Remove a shot. Its time range and spoken script are absorbed by the neighbors (split at the midpoint) so the reel stays contiguous and no narration is lost.',
      parameters: { type: 'object', properties: { shot_idx: int('array index from get_shots') }, required: ['shot_idx'] } } },
  { type: 'function', function: { name: 'move_media', description:
      'Move a media pick (clip/image) within a shot (reorder) or to another shot. Indices are array positions from get_shots.',
      parameters: { type: 'object', properties: { source_shot_idx: int(), source_pick_idx: int(), dest_shot_idx: int(), dest_pick_idx: int('insert position; omit = append') }, required: ['source_shot_idx', 'source_pick_idx', 'dest_shot_idx'] } } },
  { type: 'function', function: { name: 'remove_media', description: 'Remove one media pick from a shot.',
      parameters: { type: 'object', properties: { shot_idx: int(), pick_idx: int() }, required: ['shot_idx', 'pick_idx'] } } },
  { type: 'function', function: { name: 'set_text_overlay', description: 'Set (or clear with "") the on-screen text of a shot.',
      parameters: { type: 'object', properties: { shot_idx: int(), text: str() }, required: ['shot_idx', 'text'] } } },
  { type: 'function', function: { name: 'set_broll_description', description:
      'Rewrite what a shot\'s b-roll should show (guides curation/search).',
      parameters: { type: 'object', properties: { shot_idx: int(), text: str() }, required: ['shot_idx', 'text'] } } },
  { type: 'function', function: { name: 'set_layout', description:
      'Set how a shot\'s media sits on the 9:16 canvas. Presets: fill (fit frame), contain (actual size), split_top (split up), split_bottom (split down), overlay (inset media over the original video background).',
      parameters: { type: 'object', properties: { target: { description: '"all" or array of shot indices', anyOf: [ { type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'integer' } } ] }, preset: { type: 'string', enum: Object.keys(LAYOUTS) } }, required: ['target', 'preset'] } } },
  { type: 'function', function: { name: 'set_motion', description:
      'Camera motion on shots. "zoom in on the relevant part" => punch_in (pivots on the subject).',
      parameters: { type: 'object', properties: { target: { description: '"all" or array of shot indices', anyOf: [ { type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'integer' } } ] }, animation: { type: 'string', enum: ['none', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'ken_burns', 'punch_in'] } }, required: ['target', 'animation'] } } },
  { type: 'function', function: { name: 'inspect_image_points', description:
      'Inspect an image pick and return key animation focus points: words, symbols, logos, faces, UI controls, and important objects. Coordinates are normalized 0-1 and can be passed directly to set_animation_settings animation_x/y or zoom_x/y. Use this before requests like "zoom into the logo/text/button" when you need exact focal coordinates.',
      parameters: { type: 'object', properties: { shot_idx: int('shot index from get_shots'), pick_idx: int('selected_media index; default 0'), url: str('optional image URL instead of a shot pick'), prompt: str('optional thing to look for, e.g. "the YC logo" or "the big headline"') } } } },
  { type: 'function', function: { name: 'set_animation_settings', description:
      'Advanced animation/layout editor. Changes every motion variable the UI exposes. scope=base edits the shot/b-roll media; scope=selected_pick edits selected_media overrides (one pick_idx, or all picks if omitted); scope=original_video edits the creator/original video half in split layouts. Use normalized points from inspect_image_points for animation_x/y and zoom_x/y.',
      parameters: { type: 'object', properties: {
        target: { description: '"all" or array of shot indices', anyOf: [ { type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'integer' } } ] },
        scope: { type: 'string', enum: ['base', 'selected_pick', 'original_video'], description: 'base shot media, selected pick override, or original/creator video in split layouts' },
        pick_idx: int('selected_media index when scope=selected_pick; omit to edit all picks in target shots'),
        animation: { type: 'string', enum: ['none', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'ken_burns', 'punch_in'] },
        animation_scale: num('motion intensity multiplier, 0-4'),
        animation_duration_ms: int('motion duration in ms, 100-60000'),
        animation_easing: { type: 'string', enum: ['ease-in-out', 'linear', 'ease-out', 'ease-in'] },
        animation_origin: { type: 'string', enum: VALID_REGIONS },
        animation_x: num('free motion focal point x, 0-1'),
        animation_y: num('free motion focal point y, 0-1'),
        media_start_zoom: num('starting media zoom before animation, 0.25-6'),
        zoom_region: { type: 'string', enum: VALID_REGIONS },
        zoom_x: num('static media zoom focal point x, 0-1'),
        zoom_y: num('static media zoom focal point y, 0-1'),
        zoom_scale: num('static media zoom multiplier, 0.25-8'),
        placement_aspect: { type: 'string', enum: VALID_BROLL_ASPECTS },
        placement_fit: { type: 'string', enum: VALID_BROLL_FITS },
        placement_position: { type: 'string', enum: VALID_REGIONS },
        placement_scale: num('layout scale, 0.05-3'),
        contain_background_mode: { type: 'string', enum: ['autofill', 'show_background'] },
        original_video_position: { type: 'string', enum: VALID_REGIONS },
        split_media_fit: { type: 'string', enum: ['fill', 'contain'] }
      }, required: ['target'] } } },
  { type: 'function', function: { name: 'search_sfx_library', description:
      'Search the full SFX library (1000+ named clips) by free text and get back the matching sound NAMES — use this to find a SPECIFIC sound the user names (e.g. "iphone message notification", "vine boom") before setting it. If several distinct sounds match and you are unsure which the user means, call ask_user to let them choose.',
      parameters: { type: 'object', properties: { query: str() }, required: ['query'] } } },
  { type: 'function', function: { name: 'set_sfx', description:
      'Control the SFX timeline. Passing `cadence` REGENERATES which words get a hit (use only when the user changes the rhythm/density or says "redo the sfx"). Passing only `type`/`sound` (no cadence) restyles EVERY existing event without retiming — it does NOT wipe. "put a ding on every word" => cadence every_word + sound "ding". "make all the sfx a whoosh" => sound "whoosh", no cadence.',
      parameters: { type: 'object', properties: { cadence: { type: 'string', enum: ['every_word', 'sparse', 'normal', 'off'] }, type: { type: 'string', enum: ['impulse_tonal', 'impulse_noisy', 'sweep', 'vocal', 'sustained'] }, sound: str('specific library sound name/query') } } } },
  { type: 'function', function: { name: 'replace_sfx', description:
      'Replace ONLY the SFX matching `from` with a new sound/type, leaving every other SFX untouched. `from` is a descriptor like "ding", "wow", or a type. "replace all the ding sfx with a vine boom" => from "ding", to_sound "vine boom". This is how you change a subset — never use set_sfx for "replace the X".',
      parameters: { type: 'object', properties: { from: str('which SFX to replace, e.g. "ding"'), to_sound: str('specific library sound'), to_type: { type: 'string', enum: ['impulse_tonal', 'impulse_noisy', 'sweep', 'vocal', 'sustained'] } }, required: ['from'] } } },
  { type: 'function', function: { name: 'remove_sfx_matching', description:
      'Remove ONLY the SFX matching `match` (e.g. "ding", "wow"), leaving the rest. "remove all the dings" => match "ding".',
      parameters: { type: 'object', properties: { match: str('which SFX to remove, e.g. "ding"') }, required: ['match'] } } },
  { type: 'function', function: { name: 'replace_sound', description:
      'Replace EVERY SFX of the SAME ACOUSTIC TYPE (bucket) with one new sound. Identify the bucket either by `from_type` directly, or by `from` (a sound name whose events define the bucket). This is BROADER than replace_sfx: it hits all sounds sharing that bucket, not just the named one. Use it for "replace all sounds of the same type" / "make every ding-type sound a vine boom". For changing only one named sound and keeping others, use replace_sfx instead.',
      parameters: { type: 'object', properties: { from: str('a sound name whose bucket to target, e.g. "ding"'), from_type: { type: 'string', enum: ['impulse_tonal', 'impulse_noisy', 'sweep', 'vocal', 'sustained'] }, to_sound: str('specific library sound'), to_type: { type: 'string', enum: ['impulse_tonal', 'impulse_noisy', 'sweep', 'vocal', 'sustained'] } } } } },
  { type: 'function', function: { name: 'add_sfx_event', description: 'Add ONE SFX at an exact reel time. Use sound for a specific library clip, else type for a bucket.',
      parameters: { type: 'object', properties: { ms: int('reel time'), type: { type: 'string', enum: ['impulse_tonal', 'impulse_noisy', 'sweep', 'vocal', 'sustained'] }, sound: str('specific library sound name/query') }, required: ['ms'] } } },
  { type: 'function', function: { name: 'ask_user', description:
      'Ask the user to choose when you are genuinely unsure (e.g. several distinct library sounds match their request). Provide a short question and 2-6 concrete options. This pauses and returns the choices to the user; do not call other edit tools in the same turn.',
      parameters: { type: 'object', properties: { question: str(), options: { type: 'array', items: { type: 'string' } } }, required: ['question', 'options'] } } },
  { type: 'function', function: { name: 'move_sfx_event', description: 'Move the SFX event nearest to ms to new_ms.',
      parameters: { type: 'object', properties: { ms: int(), new_ms: int() }, required: ['ms', 'new_ms'] } } },
  { type: 'function', function: { name: 'remove_sfx_event', description: 'Remove the SFX event nearest to ms.',
      parameters: { type: 'object', properties: { ms: int() }, required: ['ms'] } } },
  { type: 'function', function: { name: 'set_sfx_timing', description:
      'Shift ALL SFX relative to their words: positive lead_ms = fire that many ms BEFORE each word; negative = after.',
      parameters: { type: 'object', properties: { lead_ms: int() }, required: ['lead_ms'] } } },
  { type: 'function', function: { name: 'set_audio_level', description: 'Set the PLAN-WIDE gain for a whole track (value) or nudge it (delta). sfx/music are 0-1; "narration" (the ORIGINAL video\'s own audio — voiceover/talking head) is 0-4, where >1 BOOSTS it (1=100%, 4=400%). "sfx" = ALL sound effects at once, "music" = b-roll audio. For changing only SOME sound effects (e.g. just the dings), use set_sfx_volume instead. "lower the original audio" => track narration, value ~0.5. "make the original audio twice as loud" => track narration, value 2.',
      parameters: { type: 'object', properties: { track: { type: 'string', enum: ['sfx', 'music', 'narration'] }, value: num(), delta: num() }, required: ['track'] } } },
  { type: 'function', function: { name: 'set_sfx_volume', description: 'Set (value) or nudge (delta) the gain of ONLY the SFX matching `match`, 0-1 — so different sounds can be louder/quieter than each other. `match` is a descriptor like "ding", "wow", a type, or "all". "make the dings quieter" => match "ding", value ~0.3. "turn the wow down a bit" => match "wow", delta -0.2. Leaves non-matching SFX untouched. For the whole SFX track at once use set_audio_level track=sfx.',
      parameters: { type: 'object', properties: { match: str('which SFX to adjust, e.g. "ding", "wow", or "all"'), value: num('absolute gain 0-1'), delta: num('relative nudge, e.g. -0.2') }, required: ['match'] } } },
  { type: 'function', function: { name: 'set_subtitles', description:
      'Edit burned-in subtitle style: enabled, position (top|center|lower_third|bottom), text_treatment (bordered|backgrounded|clear), text_color/treatment_color (hex). Subtitle POSITION can be PER-SHOT: pass `target` (shot indices or "all") together with `position` to move captions on just those shots ("put the subtitles at the top for shot 3" => target [3], position top). Without `target`, position and the other style fields apply to the whole reel.',
      parameters: { type: 'object', properties: { enabled: { type: 'boolean' }, position: { type: 'string', enum: ['top', 'center', 'lower_third', 'bottom'] }, target: { description: 'Scope POSITION to these shots: "all" or an array of shot indices. Omit for plan-wide.', anyOf: [ { type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'integer' } } ] }, text_treatment: { type: 'string', enum: ['bordered', 'backgrounded', 'clear'] }, text_color: str('hex'), treatment_color: str('hex') } } } },
  { type: 'function', function: { name: 'find_clip', description:
      'Find/curate a b-roll clip for a shot (runs the curator agent). Omit shot_idx to use the selected shot.',
      parameters: { type: 'object', properties: { query: str('what the clip should show'), shot_idx: int() }, required: ['query'] } } },
];

/** Execute one tool call. Mutates ctx.plan / queues actions; returns a short
 *  result string fed back to the model. */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentCtx,
): Promise<string> {
  const plan = ctx.plan;
  const shots = plan.shots;
  const idxOk = (i: unknown): i is number =>
    typeof i === 'number' && i >= 0 && i < shots.length;
  const targetSet = (target: unknown): Set<number> => {
    if (target === 'all' || target === undefined || target === null) {
      return new Set(shots.map((_, j) => j));
    }
    if (Array.isArray(target)) {
      return new Set(
        target.filter((i): i is number => typeof i === 'number' && idxOk(i)),
      );
    }
    return new Set();
  };

  switch (name) {
    case 'get_plan_state':
      return JSON.stringify({
        shots: shots.length,
        total_duration_ms: plan.total_duration_ms,
        motions_in_use: [...new Set(shots.map((s) => s.scene_animation ?? 'none'))],
        sfx: {
          override: plan.sfx_override ?? null,
          volume: plan.sfx_volume ?? 0.5,
          lead_ms: plan.sfx_lead_ms ?? 0,
          hand_edited_events: plan.sfx_events?.length ?? 0,
          inspiration_pattern: plan.sfx_plan
            ? { sfx_per_word: plan.sfx_plan.signals.sfx_per_word, type: plan.sfx_plan.signals.body_dominant_type }
            : null,
        },
        music_volume: plan.music_volume ?? 0.25,
        subtitles: plan.subtitle_spec
          ? { enabled: plan.subtitle_spec.enabled, treatment: plan.subtitle_spec.text_treatment, position: plan.subtitle_spec.position }
          : null,
      });
    case 'get_shots':
      return JSON.stringify(
        shots.map((s, i) => ({
          idx: i,
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          role: s.structure_role,
          spoken: String(s.spoken_during ?? '').slice(0, 70),
          motion: s.scene_animation ?? 'none',
          animation: {
            scale: s.animation_scale ?? 1,
            duration_ms: s.animation_duration_ms ?? s.duration_ms,
            easing: s.animation_easing ?? 'ease-in-out',
            origin: s.animation_origin ?? 'middle_center',
            x: s.animation_x ?? null,
            y: s.animation_y ?? null,
            start_zoom: s.media_start_zoom ?? 1,
          },
          media_zoom: {
            region: s.zoom_region ?? s.animation_origin ?? 'middle_center',
            x: s.zoom_x ?? null,
            y: s.zoom_y ?? null,
            scale: s.zoom_scale ?? 1,
          },
          layout: s.placement ?? null,
          original_video: {
            position: s.original_video_position ?? null,
            animation: s.original_scene_animation ?? null,
            scale: s.original_animation_scale ?? null,
            duration_ms: s.original_animation_duration_ms ?? null,
            easing: s.original_animation_easing ?? null,
            origin: s.original_animation_origin ?? null,
            x: s.original_animation_x ?? null,
            y: s.original_animation_y ?? null,
            start_zoom: s.original_media_start_zoom ?? null,
          },
          contain_background_mode: s.contain_background_mode ?? null,
          split_media_fit: s.split_media_fit ?? null,
          text_overlay: String(s.text_overlay ?? '').slice(0, 50),
          picks: picksOf(s).map((p, pick_idx) => ({
            pick_idx,
            kind: p.kind ?? 'media',
            origin: p.origin,
            url: p.url,
            reason: p.reason ?? null,
            animation: {
              motion: p.scene_animation ?? null,
              scale: p.animation_scale ?? null,
              duration_ms: p.animation_duration_ms ?? null,
              easing: p.animation_easing ?? null,
              origin: p.animation_origin ?? null,
              x: p.animation_x ?? null,
              y: p.animation_y ?? null,
              start_zoom: p.media_start_zoom ?? null,
            },
            media_zoom: {
              region: p.zoom_region ?? null,
              x: p.zoom_x ?? null,
              y: p.zoom_y ?? null,
              scale: p.zoom_scale ?? null,
            },
          })),
        })),
      );
    case 'get_sfx_events': {
      const evs = await materializeSfxEvents(ctx);
      return JSON.stringify(evs.slice(0, 120));
    }
    case 'move_shot_boundary': {
      const b = args.boundary_idx;
      if (typeof b !== 'number' || b < 0 || b >= shots.length - 1)
        return 'error: boundary_idx out of range';
      const left = shots[b];
      const right = shots[b + 1];
      const lo = left.start_ms + MIN_SHOT_MS;
      const hi = right.end_ms - MIN_SHOT_MS;
      const edge = Math.max(lo, Math.min(hi, Math.round(Number(args.new_ms))));
      plan.shots = shots.map((s, i) => {
        if (i === b) return { ...s, end_ms: edge, duration_ms: edge - s.start_ms };
        if (i === b + 1) return { ...s, start_ms: edge, duration_ms: s.end_ms - edge };
        return s;
      }) as SuggestedEdit['shots'];
      return `ok: cut between shots ${b} and ${b + 1} now at ${edge}ms (clamped to [${lo},${hi}])`;
    }
    case 'delete_shot': {
      const i = args.shot_idx;
      if (!idxOk(i)) return 'error: shot_idx out of range';
      if (shots.length < 2) return 'error: cannot delete the only shot';
      const removed = shots[i];
      const prev = i > 0 ? shots[i - 1] : null;
      const next = i < shots.length - 1 ? shots[i + 1] : null;
      const hasBoth = !!prev && !!next;
      const mid = hasBoth ? Math.round((removed.start_ms + removed.end_ms) / 2) : null;
      const words = String(removed.spoken_during ?? '').trim().split(/\s+/).filter(Boolean);
      const cut = mid !== null ? Math.round(words.length / 2) : 0;
      const head = mid !== null ? words.slice(0, cut).join(' ') : '';
      const tail = mid !== null ? words.slice(cut).join(' ') : '';
      const join = (a: string, b: string): string => [a.trim(), b.trim()].filter(Boolean).join(' ');
      plan.shots = shots
        .filter((_, j) => j !== i)
        .map((s) => {
          if (prev && s.shot_idx === prev.shot_idx) {
            const end_ms = mid ?? removed.end_ms;
            return { ...s, end_ms, duration_ms: end_ms - s.start_ms, spoken_during: join(String(s.spoken_during ?? ''), mid !== null ? head : String(removed.spoken_during ?? '')) };
          }
          if (next && s.shot_idx === next.shot_idx) {
            const start_ms = mid ?? removed.start_ms;
            return { ...s, start_ms, duration_ms: s.end_ms - start_ms, spoken_during: join(mid !== null ? tail : String(removed.spoken_during ?? ''), String(s.spoken_during ?? '')) };
          }
          return s;
        }) as SuggestedEdit['shots'];
      return `ok: deleted shot ${i}; neighbors absorbed its ${removed.end_ms - removed.start_ms}ms + script`;
    }
    case 'move_media': {
      const si = args.source_shot_idx, pi = args.source_pick_idx, di = args.dest_shot_idx;
      if (!idxOk(si) || !idxOk(di)) return 'error: shot index out of range';
      const source = shots[si as number];
      const picks = picksOf(source);
      if (typeof pi !== 'number' || pi < 0 || pi >= picks.length)
        return `error: source_pick_idx out of range (shot has ${picks.length} picks)`;
      const destPickIdx = typeof args.dest_pick_idx === 'number' ? args.dest_pick_idx : undefined;
      const pick = picks[pi];
      if (si === di) {
        const next = picks.slice();
        next.splice(pi, 1);
        const rawInsert = destPickIdx ?? next.length;
        const insertIdx = destPickIdx !== undefined && destPickIdx > pi ? rawInsert - 1 : rawInsert;
        next.splice(Math.max(0, Math.min(next.length, insertIdx)), 0, pick);
        plan.shots = shots.map((s, j) => (j === si ? { ...s, selected_media: next } : s)) as SuggestedEdit['shots'];
        return `ok: reordered pick ${pi} -> ${insertIdx} in shot ${si}`;
      }
      plan.shots = shots.map((s, j) => {
        if (j === si) return { ...s, selected_media: picks.filter((_, k) => k !== pi) };
        if (j === di) {
          const dp = picksOf(s).slice();
          dp.splice(Math.max(0, Math.min(dp.length, destPickIdx ?? dp.length)), 0, pick);
          return { ...s, selected_media: dp };
        }
        return s;
      }) as SuggestedEdit['shots'];
      return `ok: moved pick ${pi} from shot ${si} to shot ${di}`;
    }
    case 'remove_media': {
      const i = args.shot_idx, pi = args.pick_idx;
      if (!idxOk(i)) return 'error: shot_idx out of range';
      const picks = picksOf(shots[i as number]);
      if (typeof pi !== 'number' || pi < 0 || pi >= picks.length)
        return `error: pick_idx out of range (shot has ${picks.length} picks)`;
      plan.shots = shots.map((s, j) =>
        j === i ? { ...s, selected_media: picks.filter((_, k) => k !== pi) } : s,
      ) as SuggestedEdit['shots'];
      return `ok: removed pick ${pi} from shot ${i}`;
    }
    case 'set_text_overlay': {
      const i = args.shot_idx;
      if (!idxOk(i)) return 'error: shot_idx out of range';
      plan.shots = shots.map((s, j) =>
        j === i ? patchShot(s, { text_overlay: String(args.text ?? '') }) : s,
      ) as SuggestedEdit['shots'];
      return `ok: text overlay on shot ${i} = "${String(args.text ?? '').slice(0, 40)}"`;
    }
    case 'set_broll_description': {
      const i = args.shot_idx;
      if (!idxOk(i)) return 'error: shot_idx out of range';
      plan.shots = shots.map((s, j) =>
        j === i ? patchShot(s, { broll_description: String(args.text ?? '') }) : s,
      ) as SuggestedEdit['shots'];
      return `ok: b-roll description updated on shot ${i}`;
    }
    case 'set_layout': {
      const preset = LAYOUTS[normKey(args.preset)];
      if (!preset) return `error: unknown preset (use ${Object.keys(LAYOUTS).join(', ')})`;
      const target = args.target === 'all' || Array.isArray(args.target) ? args.target : 'all';
      const set = target === 'all' ? new Set(shots.map((_, j) => j)) : new Set(target as number[]);
      plan.shots = shots.map((s, j) =>
        set.has(j) ? patchShot(s, { placement: { ...preset } }) : s,
      ) as SuggestedEdit['shots'];
      return `ok: layout ${normKey(args.preset)} on ${target === 'all' ? 'all shots' : `${set.size} shot(s)`}`;
    }
    case 'set_motion': {
      const animation = normAnimation(args.animation);
      if (!animation) return 'error: unknown animation';
      const target = args.target === 'all' || Array.isArray(args.target) ? args.target : 'all';
      const set = target === 'all' ? new Set(shots.map((_, j) => j)) : new Set(target as number[]);
      plan.shots = shots.map((s, j) =>
        set.has(j) ? { ...s, scene_animation: animation } : s,
      ) as SuggestedEdit['shots'];
      return `ok: motion ${animation} on ${target === 'all' ? 'all shots' : `${set.size} shot(s)`}`;
    }
    case 'inspect_image_points': {
      let url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) {
        const i = args.shot_idx;
        if (!idxOk(i)) return 'error: provide shot_idx or url';
        const picks = picksOf(shots[i]);
        const pi = typeof args.pick_idx === 'number' ? args.pick_idx : 0;
        const pick = picks[pi];
        if (!pick) return `error: shot ${i} has no pick ${pi}`;
        if (pick.kind !== 'image') {
          return `error: pick ${pi} on shot ${i} is ${pick.kind}, not an image`;
        }
        url = pick.url;
      }
      return inspectImagePoints(
        url,
        typeof args.prompt === 'string' ? args.prompt : undefined,
      );
    }
    case 'set_animation_settings': {
      const set = targetSet(args.target);
      if (set.size === 0) return 'error: target selects no shots';
      const scope =
        args.scope === 'selected_pick' || args.scope === 'original_video'
          ? args.scope
          : 'base';
      const animation = normAnimation(args.animation);
      const easing = normEasing(args.animation_easing);
      const animOrigin = normRegion(args.animation_origin);
      const zoomRegion = normRegion(args.zoom_region);
      const placementAspect = normBrollAspect(args.placement_aspect);
      const placementFit = normBrollFit(args.placement_fit);
      const placementPosition = normRegion(args.placement_position);
      const originalVideoPosition = normRegion(args.original_video_position);
      const changed = new Set<string>();

      const mediaPatch = (): Partial<SelectedMedia> => {
        const patch: Partial<SelectedMedia> = {};
        if (animation) {
          patch.scene_animation = animation;
          changed.add('animation');
        }
        const animationScale = clampNum(args.animation_scale, 0, 4);
        if (animationScale !== undefined) {
          patch.animation_scale = animationScale;
          changed.add('animation_scale');
        }
        const animationDuration = intNum(args.animation_duration_ms, 100, 60000);
        if (animationDuration !== undefined) {
          patch.animation_duration_ms = animationDuration;
          changed.add('animation_duration_ms');
        }
        if (easing) {
          patch.animation_easing = easing;
          changed.add('animation_easing');
        }
        if (animOrigin) {
          patch.animation_origin = animOrigin;
          changed.add('animation_origin');
        }
        const ax = clampNum(args.animation_x, 0, 1);
        const ay = clampNum(args.animation_y, 0, 1);
        if (ax !== undefined) {
          patch.animation_x = ax;
          changed.add('animation_x');
        }
        if (ay !== undefined) {
          patch.animation_y = ay;
          changed.add('animation_y');
        }
        const startZoom = clampNum(args.media_start_zoom, 0.25, 6);
        if (startZoom !== undefined) {
          patch.media_start_zoom = startZoom;
          changed.add('media_start_zoom');
        }
        if (zoomRegion) {
          patch.zoom_region = zoomRegion;
          changed.add('zoom_region');
        }
        const zx = clampNum(args.zoom_x, 0, 1);
        const zy = clampNum(args.zoom_y, 0, 1);
        if (zx !== undefined) {
          patch.zoom_x = zx;
          changed.add('zoom_x');
        }
        if (zy !== undefined) {
          patch.zoom_y = zy;
          changed.add('zoom_y');
        }
        const zoomScale = clampNum(args.zoom_scale, 0.25, 8);
        if (zoomScale !== undefined) {
          patch.zoom_scale = zoomScale;
          changed.add('zoom_scale');
        }
        return patch;
      };

      plan.shots = shots.map((s, j) => {
        if (!set.has(j)) return s;
        if (scope === 'selected_pick') {
          const picks = picksOf(s);
          if (picks.length === 0) return s;
          const patch = mediaPatch();
          const pi =
            typeof args.pick_idx === 'number'
              ? Math.max(0, Math.min(picks.length - 1, Math.round(args.pick_idx)))
              : null;
          const next = picks.map((p, k) =>
            pi === null || k === pi ? { ...p, ...patch } : p,
          );
          return { ...s, selected_media: next };
        }

        const patch: Partial<Shot> = {};
        if (scope === 'original_video') {
          if (animation) {
            patch.original_scene_animation = animation;
            changed.add('original_scene_animation');
          }
          const animationScale = clampNum(args.animation_scale, 0, 4);
          if (animationScale !== undefined) {
            patch.original_animation_scale = animationScale;
            changed.add('original_animation_scale');
          }
          const animationDuration = intNum(args.animation_duration_ms, 100, 60000);
          if (animationDuration !== undefined) {
            patch.original_animation_duration_ms = animationDuration;
            changed.add('original_animation_duration_ms');
          }
          if (easing) {
            patch.original_animation_easing = easing;
            changed.add('original_animation_easing');
          }
          if (animOrigin) {
            patch.original_animation_origin = animOrigin;
            changed.add('original_animation_origin');
          }
          const ax = clampNum(args.animation_x, 0, 1);
          const ay = clampNum(args.animation_y, 0, 1);
          if (ax !== undefined) {
            patch.original_animation_x = ax;
            changed.add('original_animation_x');
          }
          if (ay !== undefined) {
            patch.original_animation_y = ay;
            changed.add('original_animation_y');
          }
          const startZoom = clampNum(args.media_start_zoom, 0.25, 6);
          if (startZoom !== undefined) {
            patch.original_media_start_zoom = startZoom;
            changed.add('original_media_start_zoom');
          }
        } else {
          if (animation) {
            patch.scene_animation = animation;
            changed.add('scene_animation');
          }
          Object.assign(patch, mediaPatch());
        }

        if (placementAspect || placementFit || placementPosition || typeof args.placement_scale === 'number') {
          patch.placement = {
            ...s.placement,
            ...(placementAspect ? { aspect: placementAspect } : {}),
            ...(placementFit ? { fit: placementFit } : {}),
            ...(placementPosition ? { position: placementPosition } : {}),
            ...(clampNum(args.placement_scale, 0.05, 3) !== undefined
              ? { scale: clampNum(args.placement_scale, 0.05, 3)! }
              : {}),
          };
          changed.add('placement');
        }
        if (args.contain_background_mode === 'autofill' || args.contain_background_mode === 'show_background') {
          patch.contain_background_mode = args.contain_background_mode;
          changed.add('contain_background_mode');
        }
        if (originalVideoPosition) {
          patch.original_video_position = originalVideoPosition;
          changed.add('original_video_position');
        }
        if (args.split_media_fit === 'fill' || args.split_media_fit === 'contain') {
          patch.split_media_fit = args.split_media_fit;
          changed.add('split_media_fit');
        }
        return patchShot(s, patch);
      }) as SuggestedEdit['shots'];
      if (changed.size === 0) return 'error: no valid animation settings supplied';
      return `ok: set ${[...changed].join(', ')} on ${set.size} shot(s) (${scope})`;
    }
    case 'search_sfx_library': {
      const q = typeof args.query === 'string' ? args.query : '';
      const matches = searchSfxLibrary(q, 8);
      if (matches.length === 0) return `no library sounds match "${q}"`;
      // Surface these to the UI so the user can hear every option the agent
      // is about to mention. Dedupe across the run by name.
      for (const m of matches) {
        if (!ctx.presentedSounds.some((s) => s.name === m.name))
          ctx.presentedSounds.push({ name: m.name, label: m.label });
      }
      return JSON.stringify(matches.map((m) => ({ name: m.name, label: m.label })));
    }
    case 'set_sfx': {
      const cadence = normCadence(args.cadence);
      const type = normType(args.type);
      const sound = typeof args.sound === 'string' && args.sound.trim() ? args.sound.trim() : undefined;
      if (!cadence && !type && !sound) return 'error: need a cadence, type, or sound';
      // A CADENCE change regenerates which words get a hit (an explicit
      // "redo the rhythm"), so it rebuilds the timeline. A sound/type-only
      // change must NOT wipe — it retimes nothing and just restyles EVERY
      // existing event (use replace_sfx to change only a subset).
      if (cadence) {
        plan.sfx_events = null;
        plan.sfx_override = {
          ...(plan.sfx_override ?? {}),
          cadence,
          ...(type ? { type } : {}),
          ...(sound ? { sound } : {}),
        };
        return `ok: regenerated sfx timeline ${JSON.stringify(plan.sfx_override)}`;
      }
      const evs = await materializeSfxEvents(ctx);
      for (const e of evs) {
        if (sound) {
          e.sound = sound;
          e.type = type ?? normType(sound) ?? e.type;
        } else if (type) {
          e.type = type;
        }
      }
      plan.sfx_events = evs;
      // Keep override in sync so future regenerations match.
      plan.sfx_override = {
        ...(plan.sfx_override ?? {}),
        ...(type ? { type } : {}),
        ...(sound ? { sound } : {}),
      };
      return `ok: set all ${evs.length} SFX to ${sound ?? type}`;
    }
    case 'replace_sfx': {
      const from =
        typeof args.from === 'string'
          ? args.from
          : typeof args.match === 'string'
            ? args.match
            : '';
      if (!from) return 'error: need `from` (which SFX to replace, e.g. "ding")';
      const toSound = typeof args.to_sound === 'string' && args.to_sound.trim() ? args.to_sound.trim() : undefined;
      const toType = normType(args.to_type);
      if (!toSound && !toType) return 'error: need to_sound or to_type';
      const evs = await materializeSfxEvents(ctx);
      let changed = 0;
      for (const e of evs) {
        if (!eventMatches(e, from)) continue;
        if (toSound) e.sound = toSound;
        if (toType) e.type = toType;
        if (toSound && !toType) e.type = normType(toSound) ?? e.type;
        changed++;
      }
      if (changed === 0) return `no SFX matched "${from}" — nothing changed`;
      plan.sfx_events = evs;
      return `ok: replaced ${changed} "${from}" SFX with ${toSound ?? toType} (left ${evs.length - changed} others untouched)`;
    }
    case 'remove_sfx_matching': {
      const match = typeof args.match === 'string' ? args.match : typeof args.from === 'string' ? args.from : '';
      if (!match) return 'error: need `match` (which SFX to remove)';
      const evs = await materializeSfxEvents(ctx);
      const before = evs.length;
      const kept = evs.filter((e) => !eventMatches(e, match));
      plan.sfx_events = kept;
      return `ok: removed ${before - kept.length} "${match}" SFX (kept ${kept.length})`;
    }
    case 'replace_sound': {
      const toSound = typeof args.to_sound === 'string' && args.to_sound.trim() ? args.to_sound.trim() : undefined;
      const toType = normType(args.to_type);
      if (!toSound && !toType) return 'error: need to_sound or to_type';
      const evs = await materializeSfxEvents(ctx);
      // Resolve which acoustic bucket(s) to replace: an explicit from_type, the
      // bucket of `from` as a type word, and the bucket of any event matching
      // `from` by name. All sounds in those buckets get swapped.
      const targetTypes = new Set<SfxType>();
      const fromType = normType(args.from_type) ?? normType(args.from);
      if (fromType) targetTypes.add(fromType);
      if (typeof args.from === 'string' && args.from.trim()) {
        for (const e of evs) if (eventMatches(e, args.from)) targetTypes.add(e.type);
      }
      if (targetTypes.size === 0)
        return 'error: need `from` or `from_type` to identify which type to replace';
      let changed = 0;
      for (const e of evs) {
        if (!targetTypes.has(e.type)) continue;
        if (toSound) {
          e.sound = toSound;
          e.type = toType ?? normType(toSound) ?? e.type;
        } else if (toType) {
          e.type = toType;
        }
        changed++;
      }
      if (changed === 0) return 'no SFX of that type — nothing changed';
      plan.sfx_events = evs;
      return `ok: replaced all ${changed} SFX of type ${[...targetTypes].join(', ')} with ${toSound ?? toType}`;
    }
    case 'add_sfx_event': {
      const type = normType(args.type) ?? 'impulse_tonal';
      const sound = typeof args.sound === 'string' && args.sound.trim() ? args.sound.trim() : undefined;
      const ms = Math.max(0, Math.round(Number(args.ms)));
      if (!Number.isFinite(ms)) return 'error: ms must be a number';
      const evs = await materializeSfxEvents(ctx);
      evs.push({ ms, type, ...(sound ? { sound } : {}) });
      evs.sort((a, b) => a.ms - b.ms);
      plan.sfx_events = evs;
      return `ok: added ${sound ?? type} at ${ms}ms (${evs.length} events total)`;
    }
    case 'ask_user': {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      const options = Array.isArray(args.options)
        ? args.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).map((o) => o.trim())
        : [];
      if (!question || options.length === 0) return 'error: need a question and options';
      ctx.clarify = { question, options: options.slice(0, 6) };
      return 'ok: asking the user to choose';
    }
    case 'move_sfx_event': {
      const evs = await materializeSfxEvents(ctx);
      if (evs.length === 0) return 'error: no SFX events to move';
      const ms = Number(args.ms);
      let best = 0;
      for (let j = 1; j < evs.length; j++)
        if (Math.abs(evs[j].ms - ms) < Math.abs(evs[best].ms - ms)) best = j;
      const from = evs[best].ms;
      evs[best] = { ...evs[best], ms: Math.max(0, Math.round(Number(args.new_ms))) };
      evs.sort((a, b) => a.ms - b.ms);
      plan.sfx_events = evs;
      return `ok: moved event ${from}ms -> ${Math.round(Number(args.new_ms))}ms`;
    }
    case 'remove_sfx_event': {
      const evs = await materializeSfxEvents(ctx);
      if (evs.length === 0) return 'error: no SFX events to remove';
      const ms = Number(args.ms);
      let best = 0;
      for (let j = 1; j < evs.length; j++)
        if (Math.abs(evs[j].ms - ms) < Math.abs(evs[best].ms - ms)) best = j;
      const removed = evs.splice(best, 1)[0];
      plan.sfx_events = evs;
      return `ok: removed ${removed.type} at ${removed.ms}ms (${evs.length} left)`;
    }
    case 'set_sfx_timing': {
      const lead = Number(args.lead_ms);
      if (!Number.isFinite(lead)) return 'error: lead_ms must be a number';
      plan.sfx_lead_ms = Math.round(lead);
      return `ok: sfx lead ${plan.sfx_lead_ms}ms`;
    }
    case 'set_audio_level': {
      const t = String(args.track);
      const track =
        t === 'music'
          ? 'music'
          : t === 'sfx'
            ? 'sfx'
            : t === 'narration' || t === 'original' || t === 'voice' || t === 'video'
              ? 'narration'
              : null;
      if (!track) return 'error: track must be sfx, music, or narration';
      const cur =
        track === 'sfx'
          ? (plan.sfx_volume ?? 0.5)
          : track === 'music'
            ? (plan.music_volume ?? 0.25)
            : (plan.narration_volume ?? 1);
      const raw = typeof args.value === 'number' ? args.value : cur + (typeof args.delta === 'number' ? args.delta : 0);
      // Original video audio can be boosted up to 400%; sfx/music cap at 100%.
      const v = Math.max(0, Math.min(track === 'narration' ? 4 : 1, raw));
      if (track === 'sfx') plan.sfx_volume = v;
      else if (track === 'music') plan.music_volume = v;
      else plan.narration_volume = v;
      const label = track === 'narration' ? 'original video audio' : track;
      return `ok: ${label} volume ${Math.round(v * 100)}%`;
    }
    case 'set_sfx_volume': {
      const match = typeof args.match === 'string' ? args.match : 'all';
      const evs = await materializeSfxEvents(ctx);
      if (evs.length === 0) return 'error: there are no SFX to adjust';
      const base = baseSfxVolume(ctx);
      let changed = 0;
      let lastV = base;
      for (const e of evs) {
        if (!eventMatches(e, match)) continue;
        const cur = typeof e.volume === 'number' ? e.volume : base;
        const raw =
          typeof args.value === 'number'
            ? args.value
            : cur + (typeof args.delta === 'number' ? args.delta : 0);
        const v = Math.max(0, Math.min(1, raw));
        e.volume = v;
        lastV = v;
        changed++;
      }
      if (changed === 0) return `no SFX matched "${match}" — nothing changed`;
      plan.sfx_events = evs;
      return `ok: set ${changed} "${match}" SFX to ${Math.round(lastV * 100)}% (left ${evs.length - changed} others untouched)`;
    }
    case 'set_subtitles': {
      if (!plan.subtitle_spec) return 'error: this plan has no subtitle spec to edit';
      // A `target` (shot indices / "all") scopes the POSITION to those shots
      // only — captions can sit differently on different shots. Other style
      // fields are plan-wide. With no target, position is plan-wide too.
      const hasTarget = args.target === 'all' || Array.isArray(args.target);
      if (hasTarget && typeof args.position === 'string') {
        const pos = args.position as Shot['subtitle_position'];
        const set =
          args.target === 'all'
            ? new Set(shots.map((_, j) => j))
            : new Set(args.target as number[]);
        plan.shots = shots.map((s, j) =>
          set.has(j) ? { ...s, subtitle_position: pos } : s,
        ) as SuggestedEdit['shots'];
        return `ok: subtitle position ${pos} on ${args.target === 'all' ? 'all shots' : `${set.size} shot(s)`}`;
      }
      const patch: Partial<SubtitleSpec> = {};
      if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
      if (typeof args.position === 'string') patch.position = args.position as SubtitleSpec['position'];
      if (typeof args.text_treatment === 'string') patch.text_treatment = args.text_treatment as SubtitleSpec['text_treatment'];
      if (typeof args.text_color === 'string') patch.text_color = args.text_color;
      if (typeof args.treatment_color === 'string') patch.treatment_color = args.treatment_color;
      if (Object.keys(patch).length === 0) return 'error: nothing to change';
      plan.subtitle_spec = { ...plan.subtitle_spec, ...patch };
      return `ok: subtitles ${JSON.stringify(patch)}`;
    }
    case 'find_clip': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return 'error: need a query';
      const shot_idx = typeof args.shot_idx === 'number' ? args.shot_idx : null;
      ctx.actions.push({ kind: 'find_clip', query, shot_idx });
      return `ok: queued clip search "${query}"${shot_idx != null ? ` for shot ${shot_idx}` : ''}`;
    }
    default:
      return `error: unknown tool ${name}`;
  }
}

const SYSTEM_PROMPT =
  'You are the AI editor embedded in a short-form video editing app. The ' +
  'user types a request; you fulfill it with the available tools — they are ' +
  'your complete capability list and cover everything a human can do in ' +
  'this editor (trimming and deleting shots, moving media between shots, ' +
  'layouts, camera motion, text overlays, subtitles, the SFX timeline down ' +
  'to single events, audio levels, and finding new clips). Inspect first ' +
  'when you need indices or current values (get_shots / get_plan_state / ' +
  'get_sfx_events), then edit. Chain as many tool calls as the request ' +
  'needs. For image-specific focus requests ("zoom into the logo", "pan to ' +
  'the word", "center on the symbol"), call inspect_image_points first, then ' +
  'pass its normalized x/y point to set_animation_settings as animation_x/y ' +
  'or zoom_x/y. set_animation_settings has full access to advanced motion ' +
  'variables: animation preset, intensity, duration, easing, focal point, ' +
  'media zoom, layout placement, original-video split animation, overlay size, ' +
  'and opacity. Prefer it over set_motion when the user asks for anything more ' +
  'specific than a simple preset.\n' +
  'Operate as a system, not a one-shot prompt: (1) inspect the relevant state, ' +
  '(2) choose the minimal tool sequence, (3) apply edits, (4) verify by reading ' +
  'the changed state with get_plan_state/get_shots/get_sfx_events before your ' +
  'final answer when the edit touched timing, media, captions, audio, or SFX. ' +
  'If verification shows the edit did not land, fix it before replying. ' +
  'Chain as many tool calls as the request needs. When finished, reply with ONE short sentence stating exactly what ' +
  'you did, grounded in the tool results. If something genuinely cannot be ' +
  'done with these tools, say so plainly — never claim an edit you did not make.\n' +
  'SFX sounds: the user can name a SPECIFIC sound (e.g. "iphone message ' +
  'notification"). Use search_sfx_library to find it, then set_sfx/add_sfx_event ' +
  'with the `sound` field set to the matching name. If several distinct sounds ' +
  'plausibly match and you are unsure which they mean, call ask_user with the ' +
  'candidate names as options instead of guessing.\n' +
  'NEVER wipe SFX the user did not ask you to. To change ONE named sound and ' +
  'keep the others ("replace the dings", "swap the wow"), use replace_sfx with ' +
  '`from` — it is name-precise and leaves different sounds untouched. To replace ' +
  'EVERY sound that shares an acoustic type/bucket ("replace all sounds of the ' +
  'same type", "make every ding-type sound a vine boom"), use replace_sound. To ' +
  'delete some, use remove_sfx_matching. Only pass `cadence` to set_sfx (which ' +
  'regenerates the whole timeline) when the user explicitly changes the ' +
  'rhythm/density or asks to redo all the sfx. A sound/type-only set_sfx ' +
  'restyles existing events without retiming.\n' +
  'SFX VOLUME is PER-SOUND: different sound effects can have different ' +
  'volumes. To change the loudness of only SOME sfx ("make the dings quieter", ' +
  '"turn the wow down"), use set_sfx_volume with `match` — it leaves other ' +
  'sounds at their own levels. Only use set_audio_level track=sfx when the user ' +
  'means the ENTIRE sfx track at once.';

/** Recent prompts the user has made on THIS reel (across sessions) — read
 *  from the persistent prompt log so the agent has memory of intent and can
 *  resolve "again", "that", "like before". Most recent last. */
function recentPromptsForReel(reelId: string | undefined, limit = 15): string[] {
  if (!reelId) return [];
  try {
    const path = resolve(process.cwd(), '.library', 'prompt-log.jsonl');
    if (!existsSync(path)) return [];
    const rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as { reel_id?: string; source?: string; text?: string };
        } catch {
          return null;
        }
      })
      .filter((e): e is { reel_id: string; source: string; text: string } =>
        !!e && e.reel_id === reelId && !!e.text,
      );
    return rows.slice(-limit).map((e) => `[${e.source}] ${e.text}`);
  } catch {
    return [];
  }
}

/** Run the agent loop over a working copy of the plan. Never throws. */
export async function runPlanAgent(
  command: string,
  plan: SuggestedEdit,
  narrationPath: string | null = null,
): Promise<PlanAgentResult> {
  const ctx: AgentCtx = {
    plan: { ...plan, shots: plan.shots.map((s) => ({ ...s })) },
    narrationPath,
    actions: [],
    words: null,
    clarify: null,
    presentedSounds: [],
  };
  const toolLog: string[] = [];

  const client = await getClient();
  if (!client) {
    return { plan, reply: 'No OPENAI_API_KEY set — the agent is unavailable.', actions: [], toolLog: [] };
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  const history = recentPromptsForReel(plan.reel_id);
  if (history.length > 0) {
    messages.push({
      role: 'system',
      content:
        "The user's recent requests on THIS reel (oldest→newest), for context " +
        'on their intent and preferences — use them to resolve references like ' +
        '"again", "that", "the same":\n' +
        history.map((h) => `- ${h}`).join('\n'),
    });
  }
  messages.push({ role: 'user', content: command });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const resp = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
      });
      const msg = resp.choices[0]?.message;
      if (!msg) break;
      messages.push(msg);
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        return {
          plan: ctx.plan,
          reply: msg.content?.trim() || (toolLog.length ? 'Done.' : "I couldn't do that."),
          actions: ctx.actions,
          toolLog,
          sounds: ctx.presentedSounds,
        };
      }
      for (const call of calls) {
        if (call.type !== 'function') continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* leave empty */
        }
        const result = await runTool(call.function.name, args, ctx);
        toolLog.push(`${call.function.name}(${JSON.stringify(args)}) → ${result}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      // The agent asked the user to choose — stop and surface the options.
      if (ctx.clarify) {
        return {
          plan: ctx.plan,
          reply: ctx.clarify.question,
          actions: ctx.actions,
          toolLog,
          clarify: ctx.clarify,
          sounds: ctx.presentedSounds,
        };
      }
    }
    return { plan: ctx.plan, reply: 'Reached the step limit.', actions: ctx.actions, toolLog, sounds: ctx.presentedSounds };
  } catch (err) {
    return {
      plan,
      reply: `Agent failed: ${err instanceof Error ? err.message : String(err)}`,
      actions: [],
      toolLog,
    };
  }
}
