// Capture the "important" parts of a web_page candidate as an mp4.
// Pipeline:
//   1. fetch_page → load the page in stealth Chromium, return its
//      detected sections (label + position_fraction + height_fraction)
//      plus a body-text excerpt.
//   2. gpt-4o-mini reads the section list + the shot context and
//      returns an ordered scroll_segments timeline — which sections
//      matter, in what order, and how long to hold on each.
//   3. recordUrl runs that timeline and writes the mp4 to
//      .library/captures/<hash>.mp4 (existing path; served via the
//      capture:// scheme already wired in main/index.ts).
// Emits the same shape of progress events as extract-clips so the
// renderer can re-use its log UI.

import OpenAI from 'openai';
import { fetchPage } from './curator/tools';
import {
  recordUrl,
  type PageSection,
  type ScrollSegment,
} from './curator/web-record';

const RANK_MODEL = 'gpt-4o-mini';
// Total recording length is clamped to this window. The shot's planned
// duration is used as a target with a small buffer on top for settle +
// hold; if the shot is shorter than MIN we still need enough time to
// land at least 1-2 sections meaningfully.
const MIN_DURATION_MS = 8000;
const MAX_DURATION_MS = 25000;
const DURATION_BUFFER_MS = 3000;
const MAX_SEGMENTS = 6;

export type RecordStage =
  | 'fetch'
  | 'plan'
  | 'record'
  | 'done'
  | 'error';

export interface RecordProgressEvent {
  stage: RecordStage;
  message: string;
  detail?: {
    sections?: PageSection[];
    segments?: ScrollSegment[];
    reasoning?: string;
  };
}

export type RecordProgressFn = (e: RecordProgressEvent) => void;

export interface RecordPageInput {
  candidate_url: string;
  shot_idx: number;
  broll_description: string;
  spoken_during: string;
  shot_duration_ms?: number | null;
}

export interface RecordPageResult {
  ok: true;
  recording_url: string;
  recording_path: string;
  duration_ms: number;
  page_title: string | null;
  reasoning: string;
  segments: ScrollSegment[];
}

export interface RecordPageFailure {
  ok: false;
  error: string;
  stage: 'fetch' | 'plan' | 'record';
}

export type RecordPageResponse = RecordPageResult | RecordPageFailure;

interface PlannedRecording {
  segments: ScrollSegment[];
  reasoning: string;
}

/** Ask the LLM for an ordered scroll timeline tailored to the shot.
 *  Returns sensible defaults if there's no API key — a smooth top→
 *  bottom sweep so the recorder still produces something useful. */
async function planRecording(
  input: RecordPageInput,
  sections: PageSection[],
  pageText: string,
  durationMs: number,
): Promise<PlannedRecording> {
  // Fallback when there's no model available: pick top-of-page,
  // middle-ish, bottom — every page is roughly bracketed by those.
  const fallback = (): PlannedRecording => {
    const hold = Math.max(1500, Math.floor(durationMs / 4));
    return {
      reasoning: 'no LLM available — using a generic top→middle→bottom sweep',
      segments: [
        { scroll_to: 0, travel_ms: 0, hold_ms: hold },
        {
          scroll_to: 0.5,
          travel_ms: 1500,
          hold_ms: hold,
        },
        {
          scroll_to: 1,
          travel_ms: 1500,
          hold_ms: Math.max(1000, durationMs - hold * 2 - 3000),
        },
      ],
    };
  };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || sections.length === 0) return fallback();

  const client = new OpenAI({ apiKey });
  const sectionList = sections
    .map(
      (s, i) =>
        `[${i}] label="${s.label}" position=${s.position_fraction.toFixed(3)} height=${s.height_fraction.toFixed(3)}`,
    )
    .join('\n');
  const userMessage = [
    `You're picking what to record from a web page so it can be dropped into a planned shot in a short-form Reel.`,
    ``,
    `PLANNED SHOT:`,
    `- visual idea (b-roll description): ${input.broll_description || '(none specified)'}`,
    `- voiceover over this shot: "${input.spoken_during || '(none)'}"`,
    `- target recording duration: ${(durationMs / 1000).toFixed(1)}s`,
    ``,
    `DETECTED PAGE SECTIONS (position is the fraction of total scrollable height from the top):`,
    sectionList,
    ``,
    `PAGE TEXT EXCERPT (first ~800 chars):`,
    pageText.slice(0, 800),
    ``,
    `Pick up to ${MAX_SEGMENTS} sections to feature in the recording, in the order they should appear. For each, set:`,
    `- scroll_to: the section's position_fraction (0..1).`,
    `- travel_ms: time to scroll to that position (0 for the first segment / instant jumps; 800-2000 for smooth cinematic scrolls).`,
    `- hold_ms: how long to dwell on the section (longer for important / dense sections, shorter for transitional ones).`,
    ``,
    `Rules:`,
    `- Total travel_ms + hold_ms across all segments should be roughly ${(durationMs / 1000).toFixed(0)}s minus 2s for tail.`,
    `- Use the section that actually contains the shot's relevant subject FIRST. Footers and ad sections almost always go LAST or are skipped entirely.`,
    `- If nothing in the section list looks relevant, do a top→middle→bottom sweep.`,
    ``,
    `Return strict JSON only:`,
    `{ "reasoning": "<one sentence on why you picked these sections>", "segments": [ { "scroll_to": <0..1>, "travel_ms": <int>, "hold_ms": <int> }, ... ] }`,
  ].join('\n');

  try {
    const resp = await client.chat.completions.create({
      model: RANK_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You design scroll timelines for screen recordings. Output strict JSON only.',
        },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
    });
    const text = resp.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text) as {
      reasoning?: string;
      segments?: { scroll_to?: number; travel_ms?: number; hold_ms?: number }[];
    };
    const segments: ScrollSegment[] = (Array.isArray(parsed.segments)
      ? parsed.segments
      : []
    )
      .map((s) => ({
        scroll_to: Math.max(0, Math.min(1, Number(s.scroll_to) || 0)),
        travel_ms: Math.max(0, Math.round(Number(s.travel_ms) || 0)),
        hold_ms: Math.max(500, Math.round(Number(s.hold_ms) || 1500)),
      }))
      .slice(0, MAX_SEGMENTS);
    if (segments.length === 0) return fallback();
    return {
      segments,
      reasoning: String(parsed.reasoning ?? '').slice(0, 400),
    };
  } catch {
    return fallback();
  }
}

/** Pick a duration that lets every planned segment land. The shot's
 *  own duration is the target; we add a small buffer for ramp + tail
 *  and clamp to a sane window so a 60s shot doesn't trigger a 60s
 *  capture (the recorder + ffmpeg work isn't free). */
function pickDurationMs(input: RecordPageInput): number {
  const shotDur = input.shot_duration_ms ?? 0;
  const raw = (shotDur > 0 ? shotDur : DEFAULT_SHOT_MS) + DURATION_BUFFER_MS;
  return Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, raw));
}
const DEFAULT_SHOT_MS = 6000;

/** Public entry point used by the IPC handler. */
export async function recordPage(
  input: RecordPageInput,
  onProgress?: RecordProgressFn,
): Promise<RecordPageResponse> {
  const emit = (e: RecordProgressEvent): void => {
    try {
      onProgress?.(e);
    } catch {
      /* fire-and-forget */
    }
  };

  // 1. Fetch page → get sections + text.
  emit({
    stage: 'fetch',
    message: `loading ${input.candidate_url} in stealth Chromium`,
  });
  const fp = await fetchPage(input.candidate_url, {
    expectedContent: input.broll_description,
  });
  if ('ok' in fp && fp.ok === false) {
    emit({ stage: 'error', message: `fetch failed — ${fp.error}` });
    return { ok: false, error: fp.error, stage: 'fetch' };
  }
  // After the failure-branch narrowing fp is FetchedPage.
  const page = fp as Exclude<typeof fp, { ok: false }>;
  emit({
    stage: 'fetch',
    message: `loaded "${page.title ?? '(no title)'}" — ${page.sections.length} section(s) detected`,
    detail: { sections: page.sections },
  });

  // 2. Plan scroll segments.
  const durationMs = pickDurationMs(input);
  emit({
    stage: 'plan',
    message: `asking ${RANK_MODEL} which sections matter (target ${(durationMs / 1000).toFixed(1)}s)`,
  });
  const plan = await planRecording(input, page.sections, page.text_excerpt, durationMs);
  emit({
    stage: 'plan',
    message: `picked ${plan.segments.length} segment(s) — ${plan.reasoning || '(no reasoning returned)'}`,
    detail: { segments: plan.segments, reasoning: plan.reasoning },
  });

  // 3. Record with the planned segments.
  emit({
    stage: 'record',
    message: `recording ${(durationMs / 1000).toFixed(1)}s with ${plan.segments.length} segment(s)`,
  });
  const rec = await recordUrl(input.candidate_url, {
    durationMs,
    scroll: 'smooth',
    scrollSegments: plan.segments,
    expectedContent: input.broll_description,
    // Marketing pages render best at 16:9 — that's also what the user
    // sees on desktop and what the editor can crop down per shot.
    aspect: '16:9',
  });
  if (!rec.ok) {
    const msg = rec.error ?? 'unknown record error';
    emit({ stage: 'error', message: `record failed — ${msg}` });
    return { ok: false, error: msg, stage: 'record' };
  }
  emit({
    stage: 'done',
    message: `recorded ${(rec.duration_ms / 1000).toFixed(1)}s — ${rec.recording_url}`,
  });
  return {
    ok: true,
    recording_url: rec.recording_url,
    recording_path: rec.recording_path,
    duration_ms: rec.duration_ms,
    page_title: rec.page_title,
    reasoning: plan.reasoning,
    segments: plan.segments,
  };
}
