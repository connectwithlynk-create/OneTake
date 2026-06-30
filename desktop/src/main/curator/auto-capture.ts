// Automatic capture for committed curation outputs.
//
// Once a shot's research agent commits an output, we proactively gather
// BOTH a screen recording and screenshot stills from it — with no
// approval prompt — so every page/video output ships with reusable
// footage. This is the post-output counterpart to the agent's gated,
// in-loop record_url tool: that one asks first and is for exploratory
// recording; this runs automatically on whatever the agent settled on.
//
// Every candidate shown in the library is captured so the user can assign
// it immediately without clicking per-card record/screenshot buttons.
//
// - web_page  → recordUrl (mp4) + screenshotPage (PNG stills)
// - web_video → videoScreenshots (extracted frames); the video itself is
//               the recording, so auto_recording_url points at it.
// Best-effort throughout: a failed capture leaves the field null/empty
// and never aborts curation.
import { recordUrl, type ScrollStyle } from './web-record';
import { screenshotPage } from '../screenshot-page';
import { videoScreenshots } from '../video-frames';
import type { SuggestedEdit } from '../analyze/synthesize';
import type {
  AlternativeShot,
  AutoScreenshot,
  MediaCandidate,
  ShotCuration,
  CurationResult,
} from './types';
import { existsSync, readFileSync } from 'fs';
import OpenAI from 'openai';

export interface AutoCaptureContext {
  shot_idx: number;
  broll_description: string;
  spoken_during: string;
  shot_duration_ms?: number | null;
  signal?: AbortSignal;
  onScrollBehavior?: (input: {
    shot_idx: number;
    url: string;
    title?: string | null;
    broll_description: string;
    spoken_during: string;
  }) => Promise<ScrollStyle | null>;
  /** Fired after EACH primary candidate finishes its capture (recording
   *  + screenshots filled in), with the candidate's index in the
   *  curation's candidates array. Lets the caller stream footage to the
   *  UI as it's collected instead of waiting for the whole shot.
   *  Not fired for alternative-shot candidates. */
  onCandidateCaptured?: (candidate: MediaCandidate, candidateIdx: number) => void;
}

/** Recording length: track the shot's duration so the editor has enough
 *  footage without over-recording. Clamp to the recorder's 3-30s window. */
function recordingDurationMs(shotDurationMs?: number | null): number {
  const ms = shotDurationMs && shotDurationMs > 0 ? shotDurationMs : 8000;
  return Math.min(30_000, Math.max(3_000, Math.round(ms)));
}

/** Domains where RECORDING is pointless: they serve auth/app walls to
 *  logged-out visitors, so the recorder's wall detection rejects the
 *  mp4 after burning 15-45s. Screenshots still work when the page
 *  renders content before the wall kicks in, so capture for these is
 *  STRICTLY screenshot-only — recordUrl is never attempted.
 *  Instagram/Facebook are deliberately NOT here: those are video-host
 *  passthroughs committed as web_video links, and IG sources still get
 *  frame extraction via yt-dlp. */
const SCREENSHOT_ONLY_HOSTS =
  /(^|\.)(linkedin\.com|x\.com|twitter\.com|medium\.com)$/i;

export function isScreenshotOnlyUrl(url: string): boolean {
  try {
    return SCREENSHOT_ONLY_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const SCREENSHOT_FILTER_MODEL =
  process.env.ONETAKE_SCREENSHOT_FILTER_MODEL?.trim() || 'gpt-4o-mini';

function openai(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  return key ? new OpenAI({ apiKey: key }) : null;
}

function imageDataUrl(path?: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    const ext = path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg')
      ? 'jpeg'
      : 'png';
    return `data:image/${ext};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return null;
  }
}

export async function filterRelevantScreenshots(
  screenshots: AutoScreenshot[] | undefined,
  c: MediaCandidate,
  ctx: AutoCaptureContext,
): Promise<AutoScreenshot[] | undefined> {
  if (!screenshots || screenshots.length <= 1 || ctx.signal?.aborted) {
    return screenshots;
  }
  const client = openai();
  if (!client) return screenshots;
  const items = screenshots
    .map((s, i) => ({ index: i + 1, screenshot: s, dataUrl: imageDataUrl(s.image_path) }))
    .filter((x) => x.dataUrl);
  if (items.length <= 1) return screenshots;

  const text = [
    'Judge whether each screenshot is actually useful for this short-form video shot.',
    '',
    `Shot visual idea: ${ctx.broll_description}`,
    `Voiceover during shot: ${ctx.spoken_during || '(none)'}`,
    `Candidate title: ${c.title ?? '(none)'}`,
    `Candidate notes: ${c.notes ?? '(none)'}`,
    `Source URL: ${c.source_page ?? c.url}`,
    '',
    'Keep screenshots that visibly support the shot idea/topic/subject.',
    'Reject blank screens, cookie walls, nav-only crops, random unrelated text/images, duplicates, and screenshots where the relevant subject is not visible.',
    'Return strict JSON only: { "keep": [1,2], "reject": [{ "index": 3, "reason": "..." }] }',
  ].join('\n');

  try {
    const resp = await client.chat.completions.create({
      model: SCREENSHOT_FILTER_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a strict visual relevance judge for b-roll screenshots. Output JSON only.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text },
            ...items.flatMap((item) => [
              { type: 'text' as const, text: `Screenshot ${item.index}` },
              {
                type: 'image_url' as const,
                image_url: { url: item.dataUrl!, detail: 'low' as const },
              },
            ]),
          ],
        },
      ],
      temperature: 0,
    });
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '{}') as {
      keep?: number[];
    };
    const keep = new Set(
      (Array.isArray(parsed.keep) ? parsed.keep : [])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= screenshots.length),
    );
    if (keep.size === 0) return screenshots.slice(0, 1);
    return screenshots.filter((_, i) => keep.has(i + 1));
  } catch {
    return screenshots;
  }
}

async function filterCandidateExistingScreenshots(
  candidate: MediaCandidate,
  ctx: AutoCaptureContext,
): Promise<MediaCandidate> {
  if (!candidate.auto_screenshots?.length) return candidate;
  return {
    ...candidate,
    auto_screenshots: await filterRelevantScreenshots(
      candidate.auto_screenshots,
      candidate,
      ctx,
    ),
  };
}

async function filterShotExistingScreenshots(
  curation: ShotCuration,
  plan: SuggestedEdit,
): Promise<ShotCuration> {
  const shot = plan.shots.find((s) => s.shot_idx === curation.shot_idx);
  const ctx: AutoCaptureContext = {
    shot_idx: curation.shot_idx,
    broll_description:
      curation.rewritten_shot?.broll_description ?? shot?.broll_description ?? '',
    spoken_during:
      curation.rewritten_shot?.spoken_during ?? shot?.spoken_during ?? '',
    shot_duration_ms:
      curation.rewritten_shot?.duration_ms ?? shot?.duration_ms ?? null,
  };
  const candidates = await Promise.all(
    (curation.candidates ?? []).map((c) =>
      filterCandidateExistingScreenshots(c, ctx),
    ),
  );
  const alternatives: AlternativeShot[] | undefined = curation.alternatives
    ? await Promise.all(
        curation.alternatives.map(async (alt) => ({
          ...alt,
          candidates: await Promise.all(
            alt.candidates.map((c) =>
              filterCandidateExistingScreenshots(
                c,
                { ...ctx, broll_description: alt.broll_description },
              ),
            ),
          ),
        })),
      )
    : curation.alternatives;
  return { ...curation, candidates, alternatives };
}

export async function filterExistingCurationScreenshots(
  curation: CurationResult,
  plan: SuggestedEdit,
): Promise<CurationResult> {
  const shots = await Promise.all(
    curation.shots.map((s) => filterShotExistingScreenshots(s, plan)),
  );
  return { ...curation, shots };
}

/** Gather a recording + screenshots for one committed output. Returns a
 *  new candidate with auto_recording_url / auto_screenshots filled in as
 *  far as capture succeeded; the input is returned unchanged for source
 *  types that aren't a page or video. */
async function captureForCandidate(
  c: MediaCandidate,
  ctx: AutoCaptureContext,
): Promise<MediaCandidate> {
  if (ctx.signal?.aborted) return c;

  if (c.source === 'web_page') {
    // Auth/app-walled hosts (LinkedIn, X/Twitter, Medium, …) are
    // STRICTLY screenshot-only — recording always bounces off the wall
    // detection, so don't even attempt it.
    const screenshotOnly = isScreenshotOnlyUrl(c.url);
    // Scroll style: the research agent decided this per candidate while
    // it had the page open (recommended_scroll). The onScrollBehavior
    // host callback remains as an optional override hook, but the main
    // process no longer wires a user prompt into it.
    const requestedScroll = screenshotOnly
      ? 'hold'
      : (c.recommended_scroll ??
        (await ctx
          .onScrollBehavior?.({
            shot_idx: ctx.shot_idx,
            url: c.url,
            title: c.title ?? null,
            broll_description: ctx.broll_description,
            spoken_during: ctx.spoken_during,
          })
          .catch(() => null)) ??
        'slow');
    const [rec, shots] = await Promise.all([
      screenshotOnly
        ? Promise.resolve(null)
        : recordUrl(c.url, {
            durationMs: recordingDurationMs(ctx.shot_duration_ms),
            expectedContent: ctx.broll_description,
            scroll: requestedScroll,
          }).catch(() => null),
      screenshotPage({
        candidate_url: c.url,
        shot_idx: ctx.shot_idx,
        broll_description: ctx.broll_description,
        spoken_during: ctx.spoken_during,
      }).catch(() => null),
    ]);
    const rawScreenshots: AutoScreenshot[] | undefined =
      shots && shots.ok
        ? shots.screenshots.map((s) => ({
            image_url: s.image_url,
            image_path: s.image_path,
          }))
        : c.auto_screenshots;
    const screenshots = await filterRelevantScreenshots(rawScreenshots, c, ctx);
    return {
      ...c,
      auto_recording_url:
        rec && rec.ok ? rec.recording_url : (c.auto_recording_url ?? null),
      auto_screenshots: screenshots,
    };
  }

  if (c.source === 'web_video') {
    // Every curated video automatically gets relevant still frames
    // extracted (download → transcribe/scene-detect → LLM-ranked
    // moments → ffmpeg frame grabs). Failures are logged, not silent —
    // a video candidate with zero screenshots should be explainable
    // from the main-process log.
    const frames = await videoScreenshots({
      candidate_url: c.url,
      source_page: c.source_page ?? null,
      shot_idx: ctx.shot_idx,
      broll_description: ctx.broll_description,
      spoken_during: ctx.spoken_during,
      shot_duration_ms: ctx.shot_duration_ms ?? null,
    }).catch((err: unknown) => {
      console.error(
        `[auto-capture] video frame extraction threw for shot ${ctx.shot_idx} (${c.url}):`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    });
    if (frames && !frames.ok) {
      console.error(
        `[auto-capture] video frame extraction failed for shot ${ctx.shot_idx} (${c.url}): ${frames.error} (stage: ${frames.stage})`,
      );
    }
    const rawScreenshots: AutoScreenshot[] | undefined =
      frames && frames.ok
        ? frames.frames.map((f) => ({
            image_url: f.image_url,
            image_path: f.image_path,
          }))
        : c.auto_screenshots;
    const screenshots = await filterRelevantScreenshots(rawScreenshots, c, ctx);
    return {
      ...c,
      // The found video IS the recording — keep it playable as-is.
      auto_recording_url: c.auto_recording_url ?? c.url,
      auto_screenshots: screenshots,
    };
  }

  return c;
}

/** Capture every candidate, bounded so curation does not launch too many
 *  browser recorders at once. Empty lists pass through. */
async function captureAll(
  candidates: MediaCandidate[],
  ctx: AutoCaptureContext,
): Promise<MediaCandidate[]> {
  if (candidates.length === 0) return candidates;
  const out: MediaCandidate[] = new Array(candidates.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const idx = next++;
      out[idx] = await captureForCandidate(candidates[idx], ctx);
      ctx.onCandidateCaptured?.(out[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, worker));
  return out;
}

/** Enrich a finished ShotCuration with auto-captured recording +
 *  screenshots for its committed (top) outputs. Best-effort: returns the
 *  curation unchanged on abort or when nothing was capturable. */
export async function autoCaptureCuration(
  curation: ShotCuration,
  ctx: AutoCaptureContext,
): Promise<ShotCuration> {
  if (ctx.signal?.aborted) return curation;
  const candidates = await captureAll(curation.candidates, ctx);
  // Alternatives capture with the per-candidate callback suppressed —
  // their indices would collide with the primary candidates' and the
  // streaming UI only tracks the primary list.
  const altCtx: AutoCaptureContext = { ...ctx, onCandidateCaptured: undefined };
  const alternatives = curation.alternatives
    ? await Promise.all(
        curation.alternatives.map(async (alt) => ({
          ...alt,
          candidates: await captureAll(alt.candidates, altCtx),
        })),
      )
    : curation.alternatives;
  return { ...curation, candidates, alternatives };
}
