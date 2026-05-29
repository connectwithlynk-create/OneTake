// Capture cropped PNG screenshots of the parts of a static web page
// that are actually relevant to a planned shot — instead of dumping
// the whole page. Pipeline:
//   1. loadStealthPage opens the URL with full stealth fingerprint +
//      cookie/auth-wall guard.
//   2. We walk the DOM for candidate regions (headings + their nearest
//      block container, large images), assign each a data-onetake-
//      region attribute, and emit the list with text/alt previews +
//      bounding rects.
//   3. gpt-4o-mini picks up to N relevant regions for the shot's
//      broll_description + spoken_during.
//   4. For each pick, we resolve the marked element and call
//      ElementHandle.screenshot — Playwright scrolls it into view,
//      then captures a tight PNG clipped to its bounding box.
//   5. Each PNG lands in .library/captures/<hash>-<i>.png and is
//      served via capture://files/<filename>.

import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import OpenAI from 'openai';
import { CAPTURES_DIR_PATH, loadStealthPage } from './curator/web-record';

const CAPTURES_DIR = CAPTURES_DIR_PATH;
const DEFAULT_VIEWPORT = { width: 1280, height: 960 };
const RANK_MODEL = 'gpt-4o-mini';

const MAX_REGIONS = 5;
const MIN_IMAGE_WIDTH = 200;
const MIN_IMAGE_HEIGHT = 150;
// Cap an element-screenshot at this height so a huge "section"
// container doesn't produce a near-full-page PNG. Anything taller
// gets clipped from the top.
const MAX_REGION_HEIGHT = 1200;

export type ScreenshotStage =
  | 'load'
  | 'scan'
  | 'rank'
  | 'capture'
  | 'done'
  | 'error';

export interface ScreenshotRegion {
  id: number;
  kind: 'heading' | 'image';
  /** Heading text or image alt — what the LLM ranks on. */
  preview: string;
  /** Pre-scroll bounding box for diagnostics in the log. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotPick {
  id: number;
  reason: string;
}

export interface CapturedScreenshot {
  screenshot_id: string;
  region_id: number;
  reason: string;
  preview: string;
  kind: 'heading' | 'image';
  image_url: string;
  image_path: string;
  width: number;
  height: number;
}

export interface ScreenshotProgressEvent {
  stage: ScreenshotStage;
  message: string;
  detail?: {
    regions?: ScreenshotRegion[];
    picks?: ScreenshotPick[];
    page_title?: string | null;
  };
}

export type ScreenshotProgressFn = (e: ScreenshotProgressEvent) => void;

export interface ScreenshotPageInput {
  candidate_url: string;
  shot_idx: number;
  broll_description: string;
  spoken_during?: string;
}

export interface ScreenshotPageResult {
  ok: true;
  page_title: string | null;
  screenshots: CapturedScreenshot[];
}

export interface ScreenshotPageFailure {
  ok: false;
  error: string;
  stage: 'load' | 'scan' | 'rank' | 'capture';
}

export type ScreenshotPageResponse =
  | ScreenshotPageResult
  | ScreenshotPageFailure;

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Stable hash keyed on URL + shot + broll — same args overwrite the
 *  same PNGs so re-clicking doesn't accumulate near-duplicates. */
function screenshotKey(input: ScreenshotPageInput): string {
  return createHash('sha256')
    .update(input.candidate_url)
    .update('\n')
    .update(String(input.shot_idx))
    .update('\n')
    .update(input.broll_description)
    .digest('hex')
    .slice(0, 16);
}

/** Walk the rendered page for candidate regions. Each candidate gets
 *  a data-onetake-region attribute so we can find it again from
 *  outside the page context for the actual screenshot call. */
async function scanRegions(
  page: import('playwright').Page,
): Promise<ScreenshotRegion[]> {
  return page
    .evaluate(
      (config) => {
        const out: {
          id: number;
          kind: 'heading' | 'image';
          preview: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }[] = [];
        let nextId = 0;

        const seenContainers = new Set<Element>();

        const pickHeadingContainer = (h: Element): Element => {
          // Walk up until we hit a block-level container that's
          // substantially larger than the heading itself — that's the
          // "card" or "section" the heading belongs to.
          let cur: Element | null = h;
          for (let i = 0; i < 6 && cur; i++) {
            if (!cur.parentElement) break;
            const par: HTMLElement = cur.parentElement;
            const parRect = par.getBoundingClientRect();
            const curRect = cur.getBoundingClientRect();
            if (
              par.tagName === 'SECTION' ||
              par.tagName === 'ARTICLE' ||
              par.tagName === 'HEADER' ||
              par.tagName === 'MAIN'
            ) {
              return par;
            }
            if (parRect.height > curRect.height * 1.6) return par;
            cur = par;
          }
          return h;
        };

        // 1. Headings + their nearest block container.
        document
          .querySelectorAll<HTMLHeadingElement>('h1, h2, h3')
          .forEach((h) => {
            const text = (h.innerText || h.textContent || '').trim();
            if (!text) return;
            const container = pickHeadingContainer(h);
            if (seenContainers.has(container)) return;
            const rect = container.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 30) return;
            seenContainers.add(container);
            (container as HTMLElement).dataset.onetakeRegion = String(nextId);
            out.push({
              id: nextId,
              kind: 'heading',
              preview: text.slice(0, 240),
              x: Math.round(rect.x),
              y: Math.round(rect.y + window.scrollY),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            });
            nextId++;
          });

        // 2. Large images that aren't already inside a marked
        // container (avoid double-marking the same visual).
        document.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
          const rect = img.getBoundingClientRect();
          if (
            rect.width < config.minImageWidth ||
            rect.height < config.minImageHeight
          ) {
            return;
          }
          // Skip images that live inside an already-marked container.
          let ancestor: Element | null = img;
          while (ancestor) {
            if (seenContainers.has(ancestor)) return;
            ancestor = ancestor.parentElement;
          }
          img.dataset.onetakeRegion = String(nextId);
          out.push({
            id: nextId,
            kind: 'image',
            preview: (img.alt || img.title || '').slice(0, 240),
            x: Math.round(rect.x),
            y: Math.round(rect.y + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
          nextId++;
        });

        return out;
      },
      { minImageWidth: MIN_IMAGE_WIDTH, minImageHeight: MIN_IMAGE_HEIGHT },
    )
    .catch(() => [] as ScreenshotRegion[]);
}

/** Ask the LLM which regions matter for this shot. Falls back to the
 *  first MAX_REGIONS when no API key is configured. */
async function rankRegions(
  input: ScreenshotPageInput,
  regions: ScreenshotRegion[],
): Promise<ScreenshotPick[]> {
  if (regions.length === 0) return [];
  const fallback = (): ScreenshotPick[] =>
    regions
      .slice(0, MAX_REGIONS)
      .map((r) => ({
        id: r.id,
        reason:
          r.kind === 'heading'
            ? `heading: ${r.preview.slice(0, 80)}`
            : `image (${r.width}×${r.height})`,
      }));

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback();

  const client = new OpenAI({ apiKey });
  const regionList = regions
    .map(
      (r) =>
        `[${r.id}] kind=${r.kind} size=${r.width}x${r.height} preview="${r.preview.replace(/"/g, "'").slice(0, 180)}"`,
    )
    .join('\n');
  const userMessage = [
    `You're picking which regions of a web page to screenshot for a planned shot in a short-form Reel.`,
    ``,
    `PLANNED SHOT:`,
    `- visual idea (b-roll description): ${input.broll_description || '(none specified)'}`,
    input.spoken_during
      ? `- voiceover over this shot: "${input.spoken_during}"`
      : '',
    ``,
    `PAGE REGIONS (each is either a heading + its container, or a large image):`,
    regionList,
    ``,
    `Pick up to ${MAX_REGIONS} regions whose content most clearly supports the shot's visual idea. Prefer regions whose preview text mentions the subject, the topic, or the visual concept. For images, the alt text is the preview.`,
    ``,
    `Return strict JSON only:`,
    `{ "picks": [ { "id": <region id>, "reason": "<one short sentence>" }, ... ] }`,
    `If no regions seem relevant, return up to 3 regions you would screenshot anyway (probably the hero / first heading + a representative image).`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const resp = await client.chat.completions.create({
      model: RANK_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You pick the best regions of a web page to screenshot. Output strict JSON only.',
        },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
    });
    const text = resp.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(text) as { picks?: ScreenshotPick[] };
    const raw = Array.isArray(parsed.picks) ? parsed.picks : [];
    const seen = new Set<number>();
    const cleaned: ScreenshotPick[] = [];
    for (const p of raw) {
      const id = Number(p.id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      if (!regions.some((r) => r.id === id)) continue;
      seen.add(id);
      cleaned.push({ id, reason: String(p.reason ?? '').slice(0, 240) });
      if (cleaned.length >= MAX_REGIONS) break;
    }
    return cleaned.length ? cleaned : fallback();
  } catch {
    return fallback();
  }
}

export async function screenshotPage(
  input: ScreenshotPageInput,
  onProgress?: ScreenshotProgressFn,
): Promise<ScreenshotPageResponse> {
  const emit = (e: ScreenshotProgressEvent): void => {
    try {
      onProgress?.(e);
    } catch {
      /* fire-and-forget */
    }
  };

  emit({
    stage: 'load',
    message: `loading ${input.candidate_url} in stealth Chromium`,
  });
  const loaded = await loadStealthPage(input.candidate_url, {
    viewport: DEFAULT_VIEWPORT,
  });
  if (!loaded.ok) {
    emit({ stage: 'error', message: `load failed — ${loaded.error}` });
    return { ok: false, error: loaded.error, stage: 'load' };
  }

  try {
    // 1. Scan DOM for candidate regions.
    emit({ stage: 'scan', message: 'walking the DOM for headings + large images' });
    const regions = await scanRegions(loaded.page);
    if (regions.length === 0) {
      emit({
        stage: 'error',
        message: 'no headings or large images found on the page',
      });
      return { ok: false, error: 'no candidate regions on page', stage: 'scan' };
    }
    emit({
      stage: 'scan',
      message: `${regions.length} candidate region(s) detected on "${loaded.page_title ?? '(no title)'}"`,
      detail: { regions, page_title: loaded.page_title },
    });

    // 2. Rank.
    emit({
      stage: 'rank',
      message: `asking ${RANK_MODEL} which regions match the shot`,
    });
    const picks = await rankRegions(input, regions);
    if (picks.length === 0) {
      emit({ stage: 'error', message: 'no regions picked' });
      return { ok: false, error: 'no regions picked', stage: 'rank' };
    }
    emit({
      stage: 'rank',
      message: `picked ${picks.length} region(s)`,
      detail: { picks },
    });

    // 3. Capture each pick.
    ensureDir(CAPTURES_DIR);
    const key = screenshotKey(input);
    const screenshots: CapturedScreenshot[] = [];
    for (let i = 0; i < picks.length; i++) {
      const pick = picks[i];
      const region = regions.find((r) => r.id === pick.id);
      if (!region) continue;
      emit({
        stage: 'capture',
        message: `capturing region ${i + 1}/${picks.length} — ${region.kind === 'heading' ? 'heading' : 'image'} "${region.preview.slice(0, 80)}"`,
      });
      const handle = await loaded.page
        .$(`[data-onetake-region="${pick.id}"]`)
        .catch(() => null);
      if (!handle) {
        // Element was removed/re-rendered between scan and capture.
        // Log and skip rather than abort the whole job.
        emit({
          stage: 'capture',
          message: `region ${pick.id} no longer in DOM — skipping`,
        });
        continue;
      }
      try {
        await handle.scrollIntoViewIfNeeded({ timeout: 3000 });
        // Wait for layout to settle (images, lazy-loaded fonts) before
        // capturing. ~250ms is enough for most pages without making
        // the whole pass crawl.
        await loaded.page.waitForTimeout(250);
        // Clip the height so a giant "section" container can't yield a
        // near-full-page PNG.
        const box = await handle.boundingBox().catch(() => null);
        let buf: Buffer;
        if (box && box.height > MAX_REGION_HEIGHT) {
          buf = await loaded.page.screenshot({
            type: 'png',
            clip: {
              x: Math.max(0, box.x),
              y: Math.max(0, box.y),
              width: Math.min(box.width, DEFAULT_VIEWPORT.width),
              height: MAX_REGION_HEIGHT,
            },
          });
        } else {
          buf = await handle.screenshot({ type: 'png' });
        }
        const filename = `${key}-${pick.id}.png`;
        const outPath = resolve(CAPTURES_DIR, filename);
        writeFileSync(outPath, buf);
        screenshots.push({
          screenshot_id: `${key}-${pick.id}`,
          region_id: pick.id,
          reason: pick.reason,
          preview: region.preview,
          kind: region.kind,
          image_url: `capture://files/${filename}`,
          image_path: outPath,
          width: box ? Math.round(box.width) : region.width,
          height: box
            ? Math.min(Math.round(box.height), MAX_REGION_HEIGHT)
            : Math.min(region.height, MAX_REGION_HEIGHT),
        });
      } catch (err) {
        emit({
          stage: 'capture',
          message: `region ${pick.id} failed (${err instanceof Error ? err.message : String(err)}) — skipping`,
        });
      }
    }

    if (screenshots.length === 0) {
      emit({
        stage: 'error',
        message: 'every region failed to capture',
      });
      return {
        ok: false,
        error: 'no screenshots captured',
        stage: 'capture',
      };
    }

    emit({
      stage: 'done',
      message: `${screenshots.length} screenshot(s) saved`,
    });

    return {
      ok: true,
      page_title: loaded.page_title,
      screenshots,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ stage: 'error', message: `screenshot failed — ${msg}` });
    return { ok: false, error: msg, stage: 'capture' };
  } finally {
    await loaded.cleanup();
  }
}
