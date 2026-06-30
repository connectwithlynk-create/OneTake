// URL → recorded video (mp4). Ports /Users/rahulpeesa/Documents/GitHub/
// web-recorder (record.ts + heuristic.ts + convert.ts) verbatim for the
// core recording flow. Adds the integration features the curator needs:
//   - shared stealth Chromium singleton (for sites with bot detection)
//   - Explicit iPhone-class mobile emulation (isMobile + hasTouch +
//     DPR 3 + iOS Safari UA) for 9:16 portrait recordings so marketing
//     sites serve their real mobile layout
//   - capture:// URL output for the renderer
//   - aspect-ratio → viewport mapping
//   - optional post-record camera move (zoom_in / pan_left / etc.)
//   - auth-wall detection (URL + body-text patterns)
//   - expected-content keyword scoring
//
// Everything else (consent dismissal, settle, scroll) matches the
// web-recorder reference 1:1.
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium as chromiumPlain } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Stealth: patches navigator.webdriver, WebGL fingerprints, Chrome
// runtime presence, plugins/mimeTypes, permissions.query, iframe
// contentWindow, etc. — defeats most casual headless-Chromium detection
// (LinkedIn, Cloudflare bot-check, etc.). Initialized once at module
// load; subsequent chromiumExtra.launch() uses the patches.
//
// We explicitly disable the 'user-agent-override' evasion: it reads
// the Chromium binary's UA and overrides navigator.userAgent +
// navigator.platform to match, which CLOBBERS the mobile UA + iOS
// platform we set per-context for 9:16 recordings. With it enabled,
// every recording — even at a 396x704 viewport with isMobile=true —
// reports a desktop Chromium UA + "MacIntel" platform, so any site
// that does UA sniffing serves its desktop layout. Disabling this
// single evasion preserves our context-level UA without giving up
// the rest of the stealth surface (webdriver, plugins, permissions,
// WebGL, etc.).
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('user-agent-override');
chromiumExtra.use(stealth);

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const CAPTURES_DIR = resolve(process.cwd(), '.library', 'captures');

export const SCROLL_STYLES = [
  // hold = static (no scroll); linear = steady gradual reveal; slow =
  // a gentle creep. Neither scroll mode is allowed to race through an
  // entire long page just because the page is tall. The earlier easing zoo
  // (smooth / ease-in / ease-out / stepped / reverse) was removed —
  // these three cover every real case.
  'linear',
  'slow',
  'hold',
] as const;
export type ScrollStyle = (typeof SCROLL_STYLES)[number];

/** Scroll pace caps, px/sec. These are runtime guardrails: even if an
 *  agent asks for a full-page sweep or a short segment travel time, the
 *  recorder moves gradually and stops wherever the budget naturally lands. */
const LINEAR_SCROLL_PX_PER_SEC = 360;
const SLOW_SCROLL_PX_PER_SEC = 180;
const SEGMENT_SCROLL_PX_PER_SEC = 420;
const MIN_SCROLL_TRAVEL_MS = 900;

/** One step of a programmed scroll timeline. The recording animates
 *  to `scroll_to` (a fraction of the page's scrollable height,
 *  0 = top, 1 = bottom; values outside the range are clamped) over
 *  `travel_ms`, then holds at that position for `hold_ms`. Runtime
 *  speed caps may expand travel time so long jumps stay gradual. Segments run in order;
 *  recordUrl picks this path whenever the caller passes a non-empty
 *  `scrollSegments` — the simple `scroll` style is ignored in that
 *  case. */
export interface ScrollSegment {
  scroll_to: number;
  travel_ms: number;
  hold_ms: number;
}

/** Canvas aspect ratios the recorder supports. Maps 1:1 to the most
 *  common reel composition aspects the synthesizer plans for. */
export const ASPECT_RATIOS = [
  '9:16',     // vertical reel canvas (Instagram / TikTok)
  '16:9',     // landscape (YouTube-style)
  '1:1',      // square (legacy IG feed)
  '4:5',      // portrait-ish (IG feed)
  '3:4',      // portrait
] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Post-processing "camera move" applied to the captured video.
 *  Static = no motion. The motion modes use ffmpeg crop+scale so the
 *  output dimensions stay the same as the input. */
export const BEHAVIORS = [
  'static',
  'zoom_in',
  'zoom_out',
  'pan_left',
  'pan_right',
] as const;
export type Behavior = (typeof BEHAVIORS)[number];

/** Aspect ratio → viewport dimensions. Width prioritized so that
 *  every aspect can render at a sensible pixel density on a normal
 *  display. */
export function aspectToViewport(
  aspect: AspectRatio,
): { width: number; height: number } {
  switch (aspect) {
    case '9:16':
      // Phone-class CSS viewport (close to iPhone 14 Pro at 393x852).
      // 396x704 is exactly 9:16 with even dimensions x264 requires.
      // Even if a caller overrides the viewport, 9:16 ALWAYS renders
      // in mobile mode (iPhone 14 Pro device emulation) per
      // buildContextOptions — that's a strict contract, not a
      // side-effect of these dimensions.
      return { width: 396, height: 704 };
    case '16:9':
      return { width: 1280, height: 720 };
    case '1:1':
      return { width: 720, height: 720 };
    case '4:5':
      return { width: 432, height: 540 };
    case '3:4':
      return { width: 405, height: 540 };
  }
}

export interface RecordedUrl {
  ok: boolean;
  page_title: string | null;
  /** URL after redirects (Playwright's page.url() at end of recording). */
  final_url: string;
  /** Absolute filesystem path to the mp4. Empty when ok=false. */
  recording_path: string;
  /** capture:// URL the renderer can put into <video src="..."> directly. Empty when ok=false. */
  recording_url: string;
  duration_ms: number;
  viewport_width: number;
  viewport_height: number;
  /** The aspect ratio the recording was framed at. Mirrors the
   *  aspect arg passed to recordUrl (or the default when omitted). */
  aspect_ratio: AspectRatio;
  /** The post-record camera move applied via ffmpeg. */
  behavior: Behavior;
  format: 'mp4';
  /** Whether a consent / cookie wall was detected and dismissed before recording. */
  consent_dismissed: boolean;
  /** When `expected_content` was provided: keyword-match score (0-1)
   *  between the expected content and the page's actual text. */
  content_match_score?: number;
  /** Page innerText excerpt (first ~800 chars) — useful for the agent
   *  to verify it found the right page when the match score is low. */
  page_text_excerpt?: string;
  error?: string;
}

export interface RecordUrlOptions {
  durationMs?: number;
  /** Explicit pixel viewport. When omitted, derived from `aspect` (or
   *  DEFAULT_VIEWPORT when aspect is also omitted). */
  viewport?: { width: number; height: number };
  /** Canvas aspect ratio to record at. Drives the viewport dimensions
   *  unless `viewport` is also set (which overrides). The synthesizer
   *  typically picks 9:16 for fullbleed-portrait shots and 16:9 for
   *  landscape pages (desktop websites, YouTube clips). */
  aspect?: AspectRatio;
  scroll?: ScrollStyle;
  /** Programmed scroll timeline. When non-empty, this overrides
   *  `scroll` — recordUrl runs each segment in sequence (animate to
   *  the fraction over travel_ms, then hold for hold_ms). Empty or
   *  undefined → fall back to the simple `scroll` style. The total
   *  segment time should fit inside `durationMs` minus a short
   *  settle + tail; excess runs until the recording window closes. */
  scrollSegments?: ScrollSegment[];
  /** Post-record camera move applied via ffmpeg. Default "static" — no
   *  motion. Combines cleanly with `scroll` (scroll runs during
   *  recording; behavior is applied in post). */
  behavior?: Behavior;
  /** Sentence/phrase describing what the agent expects to see on the
   *  page. When provided, the recorder extracts the page's visible text
   *  after settling, scores keyword overlap, and returns ok=false with
   *  a page_text_excerpt if the page clearly doesn't match. */
  expectedContent?: string;
  /** Minimum keyword-match score required to proceed with recording.
   *  Default 0.25 (loose — most pages mention the subject even if the
   *  exact content isn't there). */
  minMatchScore?: number;
}

const DEFAULT_DURATION_MS = 8000;
const DEFAULT_VIEWPORT = { width: 1280, height: 960 };

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Final-URL patterns that indicate the page redirected to an auth /
 *  paywall / consent landing page rather than rendering the requested
 *  content. The stealth plugin doesn't defeat real auth walls; the
 *  best we can do is detect the redirect and fail fast so the agent
 *  picks a different URL. */
const AUTH_WALL_PATTERNS: RegExp[] = [
  // Login / signup redirects (URL-level)
  /linkedin\.com\/(authwall|uas\/login|checkpoint|legal\/user-agreement|signup)/i,
  /x\.com\/i\/flow\/(login|signup)/i,
  /twitter\.com\/i\/flow\/(login|signup)/i,
  /instagram\.com\/accounts\/(login|emailsignup)/i,
  /facebook\.com\/(login|recover|reg)/i,
  /m\.facebook\.com\/login/i,
  /reddit\.com\/login/i,
  /quora\.com\/login/i,
  /medium\.com\/m\/signin/i,
  /\baccounts\.google\.com\/(signin|ServiceLogin)/i,
  /login\.microsoftonline\.com\//i,
  /auth0\.com\/login/i,
  /accounts\.atlassian\.com\/login/i,
  // App-walls: paths that show the "Watch in the app" / "Open the
  // app" interstitial to logged-out web visitors. These don't redirect
  // to a login URL — they just overlay a JS modal on top of the
  // requested content — so they're invisible to the AUTH_WALL_TEXT
  // patterns until the body renders. Catching them at the URL level
  // is more reliable (and cheaper — no need to load the page).
  /instagram\.com\/(reel|reels|p|tv|stories)\//i,
  /tiktok\.com\/@[^/]+\/(video|photo)\//i,
  /(?:^|\.)fb\.watch\//i,
  /facebook\.com\/(reel|watch|share|video\.php)/i,
  /twitter\.com\/[^/]+\/status\//i,
  /x\.com\/[^/]+\/status\//i,
];

/** Page-text patterns that suggest the body is an auth wall / sign-in
 *  prompt OR an app-wall (IG/TikTok/FB "view in app" overlay) even if
 *  the URL itself looks normal. */
const AUTH_WALL_TEXT_PATTERNS: RegExp[] = [
  // Classic auth walls
  /^\s*sign in to (continue|view|see|access)/im,
  /^\s*join (linkedin|to view|to see)/im,
  /create your free account to/i,
  /you must (log in|sign in) to/i,
  /this content isn't available right now/i,
  /something went wrong, but don't fret/i,
  /log in or sign up to/i,
  /you need to log in to (continue|view|see)/i,
  // App walls — the "view this content in our app" interstitial
  // pattern Instagram / TikTok / Facebook show on logged-out web.
  // These phrases are unique to the wall; they don't appear on real
  // content pages.
  /watch this (reel|video|story|post|live|highlight) in the app/i,
  /watch this (reel|video|story|post|live) on (instagram|facebook|tiktok)/i,
  /see more on (instagram|facebook|tiktok|twitter)/i,
  /to (view|see|watch) this (reel|video|story|post),? (open|sign up|log in)/i,
  /open (instagram|facebook|tiktok)\s*$/im,
  /\bopen in (the )?(instagram|facebook|tiktok|twitter) app\b/i,
  /tap to (open|view) in (instagram|facebook|tiktok)/i,
  /download (the )?(instagram|facebook|tiktok|x|twitter) app/i,
];

/** Page-text patterns indicating the URL resolved to a 404 / not-found
 *  / removed-content page even though it returned HTTP 200. */
const NOT_FOUND_TEXT_PATTERNS: RegExp[] = [
  /^\s*404\b/m,
  /\bpage (not found|doesn't exist|does not exist|cannot be found|can't be found)\b/i,
  /\bthis page (isn't available|isn't here|doesn't exist|cannot be found)\b/i,
  /\bsorry,?\s+(this|that|the)\s+(page|content|video|profile|account)\s+(doesn't exist|isn't available|cannot be found|was removed|has been removed)\b/i,
  /\b(content|video|page|profile) (no longer (exists|available)|has been removed|was removed|has moved)\b/i,
  /\bwe couldn't find (the|that|this) page\b/i,
  /\bnothing to see here\b/i,
  /\boops!? (we couldn't|something went wrong)/i,
];

function looksLikeNotFoundText(text: string): boolean {
  return NOT_FOUND_TEXT_PATTERNS.some((re) => re.test(text.slice(0, 2000)));
}

export function isAuthWallUrl(url: string): boolean {
  return AUTH_WALL_PATTERNS.some((re) => re.test(url));
}

export function looksLikeAuthWallText(text: string): boolean {
  return AUTH_WALL_TEXT_PATTERNS.some((re) => re.test(text.slice(0, 2000)));
}

// ---------- video-host detection + embed rewrites ----------
//
// For URLs that ARE a video (YouTube watch, Vimeo, etc.) the recorder
// runs in a different mode: rewrite to the chrome-free embed URL when
// possible, fullscreen the <video> element, autoplay (muted — audio
// capture is a separate problem), wait for loadedmetadata, then
// override the requested durationMs to match the video's actual
// length (capped). Below this layer the recording path is the same
// as for any other URL — just with the page configured to BE the
// video.

const MAX_VIDEO_RECORD_SEC = 60;

/** Domains where the URL points at a video the editor can render
 *  downstream — so the curator commits the URL directly as a
 *  source="web_video" candidate instead of attempting to record a
 *  screen capture. record_url short-circuits on these with
 *  video_host_passthrough, and fetch_page short-circuits too so the
 *  agent doesn't burn turns on auth-wall failures for the
 *  app-walled platforms. twitter / x are deliberately absent — they
 *  remain auth-walled and the prompt steers the agent off them
 *  entirely. */
const VIDEO_HOST_PATTERNS: RegExp[] = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)player\.vimeo\.com$/i,
  /(^|\.)dailymotion\.com$/i,
  /(^|\.)v\.redd\.it$/i,
  /(^|\.)loom\.com$/i,
  /(^|\.)streamable\.com$/i,
  /(^|\.)wistia\.com$/i,
  /(^|\.)wistia\.net$/i,
  /(^|\.)fast\.wistia\.com$/i,
  /(^|\.)fast\.wistia\.net$/i,
  /(^|\.)wi\.st$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)m\.facebook\.com$/i,
  /(^|\.)fb\.watch$/i,
];

export function isVideoHostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return VIDEO_HOST_PATTERNS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

/** Rewrite a video-watch URL to its chrome-free embed equivalent
 *  where one exists. YouTube and Vimeo only — others stay as-is
 *  because their embeds are either unreliable (Twitch requires
 *  parent= header) or non-existent. */
export function toVideoEmbedUrl(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const host = u.hostname.toLowerCase();
  // YouTube watch ?v=ID → /embed/ID (autoplay + mute, no related, no controls).
  if (/(^|\.)youtube\.com$/i.test(host)) {
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      if (id) {
        return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1`;
      }
    }
    // Already an embed — make sure the autoplay flags are present.
    if (u.pathname.startsWith('/embed/')) {
      u.searchParams.set('autoplay', '1');
      u.searchParams.set('mute', '1');
      u.searchParams.set('controls', '0');
      return u.toString();
    }
  }
  // youtu.be/ID short link → /embed/ID
  if (/(^|\.)youtu\.be$/i.test(host)) {
    const id = u.pathname.replace(/^\/+/, '').split('/')[0];
    if (id) {
      return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1`;
    }
  }
  // Vimeo numeric path /<id> → player.vimeo.com/video/<id>
  if (/(^|\.)vimeo\.com$/i.test(host)) {
    const match = u.pathname.match(/^\/(\d+)(?:\/|$)/);
    if (match) {
      return `https://player.vimeo.com/video/${match[1]}?autoplay=1&muted=1&controls=0`;
    }
  }
  // Loom share URL /share/<id> → /embed/<id>. Loom embed autoplays
  // by default if `autoplay` is passed.
  if (/(^|\.)loom\.com$/i.test(host)) {
    const match = u.pathname.match(/^\/share\/([a-f0-9]+)/i);
    if (match) {
      return `https://www.loom.com/embed/${match[1]}?autoplay=1&muted=1&hideEmbedTopBar=true&hide_owner=true&hide_share=true&hide_title=true`;
    }
  }
  // Streamable bare /<id> → /e/<id>. Streamable embed pages support
  // autoplay + muted params and strip the page chrome.
  if (/(^|\.)streamable\.com$/i.test(host)) {
    const match = u.pathname.match(/^\/([a-z0-9]+)\/?$/i);
    if (match && !u.pathname.startsWith('/e/')) {
      return `https://streamable.com/e/${match[1]}?autoplay=1&muted=1`;
    }
  }
  // Dailymotion video page → embed
  if (/(^|\.)dailymotion\.com$/i.test(host)) {
    const match = u.pathname.match(/^\/video\/([a-z0-9]+)/i);
    if (match) {
      return `https://www.dailymotion.com/embed/video/${match[1]}?autoplay=1&mute=1`;
    }
  }
  return rawUrl;
}

/** Wait for the largest <video> element on the page to be ready,
 *  fullscreen it via CSS, autoplay it muted, and return its duration
 *  in ms (clamped to MAX_VIDEO_RECORD_SEC). On YouTube the player
 *  lives inside an iframe so we promote the iframe instead and rely
 *  on its query-string autoplay=1. Returns null when no video can be
 *  located — caller falls back to the agent's requested duration. */
async function prepareVideoForRecording(
  page: Page,
): Promise<{
  durationMs: number;
  promoted: boolean;
  unavailable?: string;
}> {
  const result = await page
    .evaluate(
      async (maxVideoSec) => {
        // (0) Inject fullscreen CSS unconditionally — applies to any
        // <video> OR known video-embed <iframe>. SPAs (YouTube)
        // remount the player mid-playback, so tag-based selectors
        // are more durable than IDs we'd assign.
        const style = document.createElement('style');
        style.setAttribute('data-onetake-style', 'video-fullscreen');
        style.textContent = `
          html, body {
            background: #000 !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
          }
          video,
          iframe[src*="youtube.com/embed"],
          iframe[src*="youtu.be"],
          iframe[src*="player.vimeo.com"],
          iframe[src*="dailymotion.com/embed"],
          iframe[src*="loom.com/embed"],
          iframe[src*="streamable.com/e/"],
          iframe[src*="wistia.com"],
          iframe[src*="wistia.net"] {
            position: fixed !important;
            inset: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            max-width: none !important;
            max-height: none !important;
            object-fit: contain !important;
            background: #000 !important;
            z-index: 2147483647 !important;
            border: 0 !important;
          }
        `;
        document.head.appendChild(style);

        // (1) "Video unavailable" pre-flight. Cheap body-text check
        // for the standard errors video hosts surface on the page
        // itself (not inside an iframe — those we can't reach).
        const headText = (document.body?.innerText ?? '').slice(0, 2000);
        const unavailablePatterns = [
          /video unavailable/i,
          /this video is( no longer)? (private|unavailable)/i,
          /sorry, this video is/i,
          /this content isn'?t available/i,
          /the uploader has not made this video available/i,
          /video has been removed/i,
          /this video has been deleted/i,
        ];
        for (const re of unavailablePatterns) {
          if (re.test(headText)) {
            return {
              durationMs: 0,
              promoted: false,
              unavailable: headText.match(re)?.[0]?.slice(0, 120) ?? 'unavailable',
            };
          }
        }

        // (2) Click any "play"-looking control. Some hosts gate
        // playback behind a click-to-play UI even when autoplay
        // params are passed (Wistia, certain Vimeo embeds, mobile
        // YouTube on watch pages). We click multiple selectors —
        // first match wins, the rest are harmless on pages that
        // don't have them.
        const playSelectors = [
          'button[aria-label*="Play" i]',
          'button[title*="Play" i]',
          '[role="button"][aria-label*="Play" i]',
          'button.ytp-play-button',
          'button.ytp-large-play-button',
          '.vp-controls-wrapper button[title*="Play" i]',
          '.vp-controls__button[title*="Play" i]',
          'button.w-big-play-button',
          'div.w-big-play-button',
          'button[data-testid="play-button"]',
          'button[data-testid*="play" i]',
          '[class*="play-button" i]:not([class*="paused" i])',
          '[class*="PlayButton" i]:not([class*="paused" i])',
          'button.plyr__control--overlaid',
        ];
        for (const sel of playSelectors) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && (el as HTMLElement).offsetParent !== null) {
            try {
              el.click();
            } catch {
              /* ignore */
            }
          }
        }

        // (3) Find the largest <video> element by current bounding-box
        // area. Polled because YouTube/Wistia/some Vimeo mount the
        // video element lazily after the click-to-play UI hydrates.
        function findLargestVideo(): HTMLVideoElement | null {
          const videos = Array.from(
            document.querySelectorAll('video'),
          ) as HTMLVideoElement[];
          let best: HTMLVideoElement | null = null;
          let bestArea = 0;
          for (const v of videos) {
            const r = v.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            if (area > bestArea) {
              best = v;
              bestArea = area;
            }
          }
          return best;
        }
        function findLargestVideoIframe(): HTMLIFrameElement | null {
          const iframes = Array.from(
            document.querySelectorAll(
              'iframe[src*="youtube.com/embed"], iframe[src*="youtu.be"], iframe[src*="player.vimeo.com"], iframe[src*="dailymotion.com/embed"], iframe[src*="loom.com/embed"], iframe[src*="streamable.com/e/"], iframe[src*="wistia.com"], iframe[src*="wistia.net"]',
            ),
          ) as HTMLIFrameElement[];
          let best: HTMLIFrameElement | null = null;
          let bestArea = 0;
          for (const f of iframes) {
            const r = f.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            if (area > bestArea) {
              best = f;
              bestArea = area;
            }
          }
          return best;
        }

        let video = findLargestVideo();
        // Wait up to 5s for the player to mount — longer than the
        // previous 4s because Wistia and some Loom embeds are slow.
        // Click play buttons each iteration in case new ones appear.
        const deadline = performance.now() + 5000;
        while (!video && performance.now() < deadline) {
          for (const sel of playSelectors) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && (el as HTMLElement).offsetParent !== null) {
              try {
                el.click();
              } catch {
                /* ignore */
              }
            }
          }
          await new Promise((r) => setTimeout(r, 150));
          video = findLargestVideo();
        }

        if (video) {
          // Force-play. Muted autoplay is allowed across all browsers.
          video.muted = true;
          video.autoplay = true;
          video.controls = false;
          try {
            await video.play();
          } catch {
            /* autoplay blocked even when muted is unusual — proceed */
          }
          // Wait for metadata so duration is real (not NaN).
          if (!Number.isFinite(video.duration) || video.duration === 0) {
            await Promise.race([
              new Promise<void>((r) => {
                const done = (): void => r();
                video!.addEventListener('loadedmetadata', done, { once: true });
                video!.addEventListener('canplay', done, { once: true });
                video!.addEventListener('error', done, { once: true });
              }),
              new Promise((r) => setTimeout(r, 4000)),
            ]);
          }
          const seconds = Number.isFinite(video.duration)
            ? Math.min(video.duration, maxVideoSec)
            : maxVideoSec;
          return {
            durationMs: Math.max(2000, Math.round(seconds * 1000)),
            promoted: true,
          };
        }

        // No direct <video> — try an iframe (YouTube watch page,
        // YouTube embed where the shadow-rooted player hides the
        // real <video> from us, Loom/Streamable/Wistia embeds).
        // We can't read .duration across the iframe boundary; rely
        // on the CSS promotion and fall back to the max cap.
        const iframe = findLargestVideoIframe();
        if (iframe) {
          return {
            durationMs: maxVideoSec * 1000,
            promoted: true,
          };
        }
        return { durationMs: 0, promoted: false };
      },
      MAX_VIDEO_RECORD_SEC,
    )
    .catch(() => ({ durationMs: 0, promoted: false }));
  return result;
}

// ---------- shared stealth-browser singleton ----------

let sharedBrowser: Browser | null = null;
let sharedBrowserPromise: Promise<Browser> | null = null;

/** Get (or lazily launch) the shared stealth Chromium instance. Both
 *  recordUrl and fetchPage use this so we pay the ~1-2s launch cost
 *  once per app session, not per tool call. */
export async function getStealthBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (sharedBrowserPromise) return sharedBrowserPromise;
  const launching = chromiumExtra
    .launch({
      args: ['--disable-blink-features=AutomationControlled'],
    })
    .then((b) => {
      sharedBrowser = b;
      b.on('disconnected', () => {
        sharedBrowser = null;
        sharedBrowserPromise = null;
      });
      return b;
    });
  sharedBrowserPromise = launching;
  // A failed launch must not be cached, or every later call re-awaits
  // the same rejection for the rest of the session.
  launching.catch(() => {
    if (sharedBrowserPromise === launching) sharedBrowserPromise = null;
  });
  return launching;
}

export async function closeStealthBrowser(): Promise<void> {
  if (!sharedBrowser) return;
  const b = sharedBrowser;
  sharedBrowser = null;
  sharedBrowserPromise = null;
  await b.close().catch(() => {});
}

// ---------- plain Chromium singleton (for recordUrl) ----------
//
// recordUrl uses plain `chromium` from 'playwright', NOT chromiumExtra +
// stealth. Web-recorder's record.ts launches plain chromium and the user
// wants 1:1 with that. The stealth plugin's evasions (chrome.runtime
// mocks, navigator.plugins overrides, etc.) can subtly interfere with
// mobile emulation — the page might check `window.chrome` or
// `navigator.plugins` and decide that despite isMobile=true and the
// iOS UA, it's actually a desktop Chromium and serve the desktop
// layout. Plain Chromium has none of that interference.
//
// fetch_page / google_search / duckduckgo_search continue using the
// stealth browser via loadStealthPage — those flows DO need bot
// evasion (LinkedIn, Cloudflare, DDG rate-limits) and aren't
// rendering mobile.

let plainBrowser: Browser | null = null;
let plainBrowserPromise: Promise<Browser> | null = null;

export async function getPlainBrowser(): Promise<Browser> {
  if (plainBrowser && plainBrowser.isConnected()) return plainBrowser;
  if (plainBrowserPromise) return plainBrowserPromise;
  const launching = chromiumPlain.launch().then((b) => {
    plainBrowser = b;
    b.on('disconnected', () => {
      plainBrowser = null;
      plainBrowserPromise = null;
    });
    return b;
  });
  plainBrowserPromise = launching;
  launching.catch(() => {
    if (plainBrowserPromise === launching) plainBrowserPromise = null;
  });
  return launching;
}

export async function closePlainBrowser(): Promise<void> {
  if (!plainBrowser) return;
  const b = plainBrowser;
  plainBrowser = null;
  plainBrowserPromise = null;
  await b.close().catch(() => {});
}

// ---------- shared "open URL with all protections" helper ----------

export interface LoadedPage {
  ok: true;
  page: Page;
  context: BrowserContext;
  final_url: string;
  page_title: string | null;
  consent_dismissed: boolean;
  /** Visible body text (up to 8000 chars). */
  page_text: string;
  cleanup: () => Promise<void>;
}

export interface LoadFailed {
  ok: false;
  error: string;
  final_url: string;
  page_title: string | null;
  consent_dismissed: boolean;
  page_text_excerpt?: string;
}

/** Build the context options for a given viewport + aspect. 9:16 ALWAYS
 *  gets full iPhone 14 Pro emulation via Playwright's built-in device
 *  descriptor (user agent, touch, isMobile flag, DPR, Sec-CH-UA-Mobile
 *  / Platform client hints) — that's a strict contract, not a
 *  side-effect of viewport dimensions, so a viewport override can't
 *  accidentally flip a 9:16 recording into desktop mode. Other
 *  portrait viewports (4:5, 3:4) still get mobile when their natural
 *  viewport is taller than wide. Landscape (16:9, 1:1 etc.) stays on
 *  desktop. The exact pixel viewport from the caller is preserved
 *  either way so the recording lands at the requested aspect. */
// Mobile UA used for 9:16 + portrait viewport recordings. Modern
// iPhone Safari. Set verbatim (not spread from a device descriptor) so
// the stealth plugin's removed user-agent-override evasion can't
// silently patch this back to desktop Chromium.
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 ' +
  'Mobile/15E148 Safari/604.1';

function buildContextOptions(
  viewport: { width: number; height: number },
  aspect?: AspectRatio,
): Parameters<Browser['newContext']>[0] {
  // 9:16 is the canonical phone aspect — always mobile regardless of
  // viewport. Other portrait-ish aspects (4:5, 3:4) fall back to the
  // dimension check so legacy callers (fetchPage / search funcs that
  // don't pass aspect) still get mobile for portrait viewports.
  const isMobile =
    aspect === '9:16' || viewport.height > viewport.width;
  if (isMobile) {
    // Full mobile emulation, set EXPLICITLY (not via descriptor spread)
    // so:
    //   - the disabled user-agent-override stealth evasion can't sneak
    //     a desktop UA back in
    //   - we don't accidentally inherit `defaultBrowserType: 'webkit'`
    //     from the iPhone descriptor and confuse Playwright's
    //     emulation pipeline
    //   - every mobile-relevant flag is visible at one glance
    return {
      viewport,
      // window.screen reports the full device screen (typically
      // taller than the viewport because of browser chrome on real
      // devices). 393x852 = iPhone 14 Pro screen.
      screen: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_USER_AGENT,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
    };
  }
  return {
    viewport,
    deviceScaleFactor: 2,
    userAgent: DESKTOP_USER_AGENT,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  };
}

/** Open a URL with all the protections both recorder and fetcher need:
 *   - stealth Chromium (singleton)
 *   - mobile device emulation for portrait viewports
 *   - settle (fonts ready + hero images decoded + network idle)
 *   - cookie / consent dismissal
 *   - auth-wall URL detection
 *   - auth-wall body-text detection
 *  Returns either a live { page, context, cleanup } the caller can
 *  inspect, or a LoadFailed describing the wall. */
export async function loadStealthPage(
  url: string,
  options: {
    viewport?: { width: number; height: number };
    recordVideo?: { dir: string; size: { width: number; height: number } };
    /** Internal: set on the automatic http_999 retry so it only
     *  happens once. */
    _isBotBlockRetry?: boolean;
  } = {},
): Promise<LoadedPage | LoadFailed> {
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  let absUrl: string;
  try {
    absUrl = new URL(url).toString();
  } catch {
    return {
      ok: false,
      error: 'invalid_url',
      final_url: url,
      page_title: null,
      consent_dismissed: false,
    };
  }

  // Pre-flight URL pattern check. Bail BEFORE creating a browser
  // context or firing any HTTP request when the input URL already
  // matches a known wall pattern (instagram.com/reel/, tiktok.com/
  // @user/video/, etc.). Saves ~500ms of browser context + page
  // creation + HTTP roundtrip vs the post-goto check below. The
  // post-goto check still runs for URLs that PASS this pre-flight
  // but then redirect into a walled domain.
  if (isAuthWallUrl(absUrl)) {
    return {
      ok: false,
      error: `auth_wall_redirect (${absUrl}) — app/login wall URL pattern, no fetch attempted`,
      final_url: absUrl,
      page_title: null,
      consent_dismissed: false,
    };
  }

  const browser = await getStealthBrowser();
  const contextOptions = {
    ...buildContextOptions(viewport),
    ...(options.recordVideo ? { recordVideo: options.recordVideo } : {}),
  };
  const context = await browser.newContext(contextOptions);
  // tsx/esbuild emits __name() helper inside page.evaluate bodies.
  // Polyfill it in the page so evaluated code does not ReferenceError.
  await context.addInitScript({
    content:
      'globalThis.__name = globalThis.__name || function(fn){return fn;};',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  try {
    // Capture HTTP status so we can reject 4xx / 5xx before settling.
    let httpStatus: number | null = null;
    let resp = await page
      .goto(absUrl, { waitUntil: 'load' })
      .catch(() => null);
    if (!resp) {
      resp = await page
        .goto(absUrl, { waitUntil: 'domcontentloaded' })
        .catch(() => null);
    }
    if (resp) httpStatus = resp.status();

    if (httpStatus !== null && httpStatus >= 400) {
      const finalUrl = page.url() || absUrl;
      await context.close().catch(() => {});
      // 999 is LinkedIn's custom bot-denial status for logged-out
      // automated traffic. It's often per-request flaky, so retry ONCE
      // with a fresh context after a short pause; when it persists,
      // return a self-explanatory error so the agent picks a public
      // source instead of retrying the same URL.
      if (httpStatus === 999 && !options._isBotBlockRetry) {
        await new Promise((r) => setTimeout(r, 1500));
        return loadStealthPage(url, { ...options, _isBotBlockRetry: true });
      }
      return {
        ok: false,
        error:
          httpStatus === 999
            ? 'http_999_bot_blocked (site denies logged-out automated visits — this URL cannot be fetched or captured; use a public alternative source)'
            : `http_${httpStatus}`,
        final_url: finalUrl,
        page_title: null,
        consent_dismissed: false,
      };
    }

    await waitUntilVisuallySettled(page, { maxWaitMs: 8000 });
    const consent_dismissed = await dismissConsentAggressive(page);
    // Also flush any signup / newsletter / paywall MODAL overlays
    // before we read the page text — without this, the page_text
    // captured for auth-wall + content-match checks would include
    // the modal's prompt instead of the underlying article.
    await dismissAuthModals(page);
    await page.waitForTimeout(200);

    const final_url = page.url();
    const page_title = (await page.title().catch(() => null)) || null;

    if (isAuthWallUrl(final_url)) {
      await context.close().catch(() => {});
      return {
        ok: false,
        error: `auth_wall_redirect (${final_url})`,
        final_url,
        page_title,
        consent_dismissed,
      };
    }

    const page_text = await page
      .evaluate(() => (document.body?.innerText ?? '').slice(0, 8000))
      .catch(() => '');

    if (looksLikeAuthWallText(page_text)) {
      await context.close().catch(() => {});
      return {
        ok: false,
        error: 'auth_wall_text_detected',
        final_url,
        page_title,
        consent_dismissed,
        page_text_excerpt: page_text.slice(0, 800),
      };
    }

    if (looksLikeNotFoundText(page_text)) {
      await context.close().catch(() => {});
      return {
        ok: false,
        error:
          'not_found_text_detected (page body matched 404 / removed-content patterns)',
        final_url,
        page_title,
        consent_dismissed,
        page_text_excerpt: page_text.slice(0, 800),
      };
    }

    return {
      ok: true,
      page,
      context,
      final_url,
      page_title,
      consent_dismissed,
      page_text,
      cleanup: async () => {
        await context.close().catch(() => {});
      },
    };
  } catch (err) {
    await context.close().catch(() => {});
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      final_url: absUrl,
      page_title: null,
      consent_dismissed: false,
    };
  }
}

/** Record a video of a URL. Direct port of /Users/rahulpeesa/Documents/
 *  GitHub/web-recorder/src/record.ts (recordUrl). The flow is identical
 *  step-for-step — launch → newContext with recordVideo → page.goto
 *  (load → fallback domcontentloaded) → waitUntilVisuallySettled →
 *  trim anchor → applyHeuristic → saveAs webm → transcodeToMp4. The
 *  only delta from web-recorder is integration glue we can't get rid
 *  of without breaking the curator: shared stealth browser singleton,
 *  9:16 → mobile emulation (an explicit user contract), capture://
 *  URL output, aspect-ratio → viewport mapping, and an optional
 *  zoom/pan ffmpeg behavior filter that's a no-op when behavior is
 *  'static'. expected_content is still PASSED for diagnostics — the
 *  matched score lands on the result for visibility — but it never
 *  blocks (user approval has already validated the URL upstream). */
export async function recordUrl(
  rawUrl: string,
  options: RecordUrlOptions = {},
): Promise<RecordedUrl> {
  const url = rawUrl;
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  // ALL recordings are 9:16 in mobile mode. The user's contract:
  // "have all record_urls be 9:16 and in mobile view." The aspect /
  // viewport options on this function are intentionally ignored so a
  // misconfigured caller (or stale agent schema) can't accidentally
  // record at a desktop aspect.
  const aspect: AspectRatio = '9:16';
  const viewport = aspectToViewport('9:16');
  const scroll = options.scroll ?? 'slow';
  // Normalize the programmable timeline: keep only well-formed
  // entries, clamp scroll_to into [0, 1], coerce ms fields to non-
  // negative integers. An empty result means "fall back to the simple
  // `scroll` style". This is the choke point — downstream code can
  // trust the array shape and skip its own validation.
  let scrollSegments: ScrollSegment[] = Array.isArray(options.scrollSegments)
    ? options.scrollSegments
        .map((s) => {
          const to = Number(s?.scroll_to);
          const travel = Number(s?.travel_ms);
          const hold = Number(s?.hold_ms);
          if (!Number.isFinite(to)) return null;
          return {
            scroll_to: Math.max(0, Math.min(1, to)),
            travel_ms: Number.isFinite(travel) ? Math.max(0, Math.floor(travel)) : 0,
            hold_ms: Number.isFinite(hold) ? Math.max(0, Math.floor(hold)) : 0,
          };
        })
        .filter((s): s is ScrollSegment => s !== null)
    : [];
  // Effects (zoom_in / pan_left / etc.) are NEVER applied during
  // recording — the source mp4 is always a clean capture. Camera
  // moves are an editor-side concern and get layered in downstream.
  // We still carry `behavior` on the result for backward compatibility
  // with consumers that read it, but it's hardcoded to 'static'.
  const behavior: Behavior = 'static';
  const expectedContent = options.expectedContent?.trim() ?? '';

  if (!existsSync(CAPTURES_DIR)) mkdirSync(CAPTURES_DIR, { recursive: true });
  const tempDir = join(CAPTURES_DIR, '.tmp');
  await mkdir(tempDir, { recursive: true });

  // Scroll style flows through to the heuristic unchanged. No
  // effects-vs-scroll arbitration needed — behavior is locked to
  // 'static' on the record path.
  let effectiveScroll: ScrollStyle = scroll;

  let absUrl: string;
  try {
    absUrl = new URL(url).toString();
  } catch {
    return failure(url, viewport, aspect, behavior, 'invalid_url');
  }

  // Pre-flight URL pattern check. Bail BEFORE launching the browser
  // when the URL already matches a known wall pattern. Saves the
  // full ~500ms of context creation + HTTP roundtrip on social URLs
  // we know we can't record (IG reels, TikTok videos, FB watch,
  // etc.). The post-goto check below remains as a second layer for
  // URLs that pass this pre-flight but redirect into a walled domain.
  if (isAuthWallUrl(absUrl)) {
    return failure(
      absUrl,
      viewport,
      aspect,
      behavior,
      `auth_wall_redirect (${absUrl}) — app/login wall URL pattern, no fetch attempted`,
    );
  }

  // Video-host URL passthrough. YouTube / Vimeo / Loom / Streamable /
  // Wistia / Dailymotion / Reddit video URLs are NOT screen-recorded
  // — the agent commits them as source="web_video" candidates with
  // the URL as-is, and the editor / a future "record this clip"
  // button decides what to do at composition time. We refuse here
  // so a stale code path can't accidentally produce a misleading
  // recording of an embed player.
  if (isVideoHostUrl(absUrl)) {
    return failure(
      absUrl,
      viewport,
      aspect,
      behavior,
      `video_host_passthrough (${absUrl}) — commit this URL directly as a source="web_video" candidate; do not call record_url on video host URLs.`,
    );
  }

  // Plain Chromium (no stealth) — recording is 1:1 with web-recorder.
  // Stealth evasions can interfere with mobile emulation; we don't
  // need bot evasion for record_url anyway since the user has already
  // approved the URL via the approval gate.
  const browser = await getPlainBrowser();
  const context = await browser.newContext({
    // 9:16 always maps to mobile emulation regardless of viewport
    // override; other aspects derive from the viewport dims.
    ...buildContextOptions(viewport, aspect),
    recordVideo: { dir: tempDir, size: viewport },
  });
  // tsx/esbuild emits __name() helper inside page.evaluate bodies.
  // Polyfill it so evaluated code does not ReferenceError.
  await context.addInitScript({
    content:
      'globalThis.__name = globalThis.__name || function(fn){return fn;};',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  // Anchor the trim clock to the moment recording effectively starts.
  const recordStartedAt = Date.now();

  try {
    await page.goto(absUrl, { waitUntil: 'load' }).catch(async () => {
      // Some sites never reach 'load' (long-poll, ws). Fall back to
      // domcontentloaded — matches web-recorder.
      await page.goto(absUrl, { waitUntil: 'domcontentloaded' });
    });

    // Early URL-pattern check: IG /reel/, /p/, TikTok /video/, FB
    // /watch/, X /status/ — these are guaranteed app-walled for
    // logged-out web visitors. Bail before we waste time settling.
    // (loadStealthPage / fetch_page also check this, but record_url
    // doesn't go through loadStealthPage, so it has to check here.)
    if (isAuthWallUrl(page.url())) {
      const final_url = page.url();
      await context.close().catch(() => {});
      return failure(
        final_url,
        viewport,
        aspect,
        behavior,
        `auth_wall_redirect (${final_url}) — app/login wall on this URL pattern, pick a different source`,
      );
    }

    // Wait until the page looks real before any motion. Bounded so a
    // hung site can't block recording indefinitely.
    await waitUntilVisuallySettled(page, { maxWaitMs: 8000 });

    // Dismiss the cookie banner BEFORE the trim clock advances, so
    // the visible portion of the recording starts post-dismissal.
    // applyHeuristic also calls dismissCommonConsent internally as
    // belt-and-suspenders.
    const consent_dismissed = await dismissCommonConsent(page);

    // (video-mode used to live here — disabled until a "record this
    // clip" button is added. Video host URLs are now intercepted
    // earlier and returned as URL passthroughs.)

    // Body-text auth-wall / app-wall check: catches IG / TikTok / FB
    // "view in app" overlays that don't redirect to a login URL and
    // can therefore slip past the URL pattern check above. Reads the
    // first 4000 chars of innerText after settle so the app-wall
    // banner is in the captured text. Bail fast — recording the
    // wall is strictly worse than no recording at all.
    const wallText = await page
      .evaluate(() => (document.body?.innerText ?? '').slice(0, 4000))
      .catch(() => '');
    if (looksLikeAuthWallText(wallText)) {
      const final_url = page.url();
      const page_title = (await page.title().catch(() => null)) || null;
      await context.close().catch(() => {});
      return {
        ok: false,
        page_title,
        final_url,
        recording_path: '',
        recording_url: '',
        duration_ms: 0,
        viewport_width: viewport.width,
        viewport_height: viewport.height,
        aspect_ratio: aspect,
        behavior,
        format: 'mp4',
        consent_dismissed,
        page_text_excerpt: wallText.slice(0, 800),
        error:
          'auth_wall_text_detected — page rendered an "open in app" / "sign in to view" overlay. ' +
          'Pick a different URL from a publicly-readable source (subject\'s own website, press article, YC company page, etc.).',
      };
    }

    // Section-anchor snap: scroll_to fractions come from fetch_page,
    // which measures sections on a desktop-width layout. The mobile
    // recording layout reflows (taller page, stacked sections), so the
    // same section sits at a different fraction — a strict tolerance
    // check here would reject nearly every legitimate timeline. Snap
    // each segment to the NEAREST section detected at the recording
    // viewport instead: the agent's intent is the section, not the raw
    // number. Top/bottom are valid anchors on any layout. Segments
    // further than SNAP_TOLERANCE from every section are whitespace
    // guesses (the banned generic-thirds pattern) and are dropped; if
    // none survive we fall back to a single linear scroll.
    if (scrollSegments.length > 0) {
      const sections = await extractPageSections(page);
      const sectionPositions = sections.map((s) => s.position_fraction);
      const SNAP_TOLERANCE = 0.2;
      const kept: typeof scrollSegments = [];
      const dropped: string[] = [];
      for (let i = 0; i < scrollSegments.length; i++) {
        const seg = scrollSegments[i];
        if (seg.scroll_to <= 0.02 || seg.scroll_to >= 0.98) {
          kept.push(seg);
          continue;
        }
        let nearest: number | null = null;
        for (const p of sectionPositions) {
          if (
            nearest === null ||
            Math.abs(p - seg.scroll_to) < Math.abs(nearest - seg.scroll_to)
          ) {
            nearest = p;
          }
        }
        if (
          nearest !== null &&
          Math.abs(nearest - seg.scroll_to) <= SNAP_TOLERANCE
        ) {
          kept.push({ ...seg, scroll_to: nearest });
        } else {
          dropped.push(`segment[${i}].scroll_to=${seg.scroll_to.toFixed(2)}`);
        }
      }
      if (dropped.length > 0) {
        console.warn(
          `[record] dropped scroll_segments with no section within ` +
            `${SNAP_TOLERANCE} (${dropped.join(', ')}). Detected sections: ` +
            JSON.stringify(
              sections.map((s) => ({
                label: s.label.slice(0, 60),
                position_fraction: Number(s.position_fraction.toFixed(2)),
              })),
            ),
        );
      }
      scrollSegments = kept;
      if (scrollSegments.length === 0) effectiveScroll = 'linear';
    }

    // Everything before this point is dead "loading" footage we trim
    // off in the ffmpeg pass — matches web-recorder verbatim.
    const trimStartMs = Math.max(0, Date.now() - recordStartedAt - 200);

    // Scrolling: prefer the programmed timeline when the caller
    // supplied one (non-empty after normalization); otherwise fall
    // back to web-recorder's single-style scroll heuristic.
    if (scrollSegments.length > 0) {
      await applyScrollSegments(page, durationMs, scrollSegments);
    } else {
      await applyHeuristic(page, durationMs, effectiveScroll);
    }

    // Capture final url + title BEFORE we close the page (page.url()
    // throws once the page is closed).
    const final_url = page.url();
    const page_title = (await page.title().catch(() => null)) || null;

    // Informational: compute the keyword-overlap score against the
    // visible body text. Never blocks — user approval upstream has
    // already validated the URL. The score lands on the result so
    // the agent can see how well its expected_content held up.
    let content_match_score: number | undefined;
    let page_text_excerpt: string | undefined;
    if (expectedContent) {
      const page_text = await page
        .evaluate(() => (document.body?.innerText ?? '').slice(0, 8000))
        .catch(() => '');
      content_match_score = keywordMatchScore(expectedContent, page_text);
      page_text_excerpt = page_text.slice(0, 800);
    }

    const video = page.video();
    const hash = createHash('sha1')
      .update(
        `${final_url}|${durationMs}|${effectiveScroll}|${aspect}|${behavior}|${
          scrollSegments.length > 0 ? JSON.stringify(scrollSegments) : ''
        }`,
      )
      .digest('hex')
      .slice(0, 16);
    const webmPath = join(tempDir, `${hash}.webm`);
    await page.close();
    if (!video) {
      await context.close().catch(() => {});
      return failure(final_url, viewport, aspect, behavior, 'no_video_object');
    }
    await video.saveAs(webmPath);
    await video.delete().catch(() => {});
    await context.close().catch(() => {});

    const mp4Path = join(CAPTURES_DIR, `${hash}.mp4`);
    await transcodeToMp4(webmPath, mp4Path, trimStartMs / 1000, {
      behavior,
      width: viewport.width,
      height: viewport.height,
      durationSec: durationMs / 1000,
    });
    await unlink(webmPath).catch(() => {});

    return {
      ok: true,
      page_title,
      final_url,
      recording_path: mp4Path,
      recording_url: `capture://files/${hash}.mp4`,
      duration_ms: durationMs,
      viewport_width: viewport.width,
      viewport_height: viewport.height,
      aspect_ratio: aspect,
      behavior,
      format: 'mp4',
      consent_dismissed,
      content_match_score,
      page_text_excerpt,
    };
  } catch (err) {
    await context.close().catch(() => {});
    return failure(
      absUrl,
      viewport,
      aspect,
      behavior,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function failure(
  url: string,
  viewport: { width: number; height: number },
  aspect: AspectRatio,
  behavior: Behavior,
  error: string,
): RecordedUrl {
  return {
    ok: false,
    page_title: null,
    final_url: url,
    recording_path: '',
    recording_url: '',
    duration_ms: 0,
    viewport_width: viewport.width,
    viewport_height: viewport.height,
    aspect_ratio: aspect,
    behavior,
    format: 'mp4',
    consent_dismissed: false,
    error,
  };
}

// ---------- visual-settled wait (ported verbatim from web-recorder) ----------

// Wait for the page to be visually "ready" before recording motion. The
// 'load' event fires far too early on modern SPAs — before React/Next
// hydrate, before fonts swap in, before hero images decode. Bounded so a
// misbehaving page can never hang the recording.
async function waitUntilVisuallySettled(
  page: Page,
  opts: { maxWaitMs?: number } = {},
): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 8000;
  const deadline = Date.now() + maxWaitMs;

  // 1. Best-effort wait for network to quiet down.
  const networkBudget = Math.min(5000, Math.max(0, deadline - Date.now()));
  await page
    .waitForLoadState('networkidle', { timeout: networkBudget })
    .catch(() => {});

  // 2. In-page wait: fonts ready + above-the-fold images decoded + 2 rAFs.
  const inPageBudget = Math.max(500, deadline - Date.now());
  await page
    .evaluate(async (timeoutMs) => {
      const pageDeadline = performance.now() + timeoutMs;
      const remaining = (): number =>
        Math.max(0, pageDeadline - performance.now());

      try {
        if (document.fonts && typeof document.fonts.ready?.then === 'function') {
          await Promise.race([
            document.fonts.ready,
            new Promise((r) => setTimeout(r, remaining())),
          ]);
        }
      } catch {
        /* ignore */
      }

      const vh = window.innerHeight;
      const heroImgs = Array.from(document.images).filter((img) => {
        const r = img.getBoundingClientRect();
        return r.top < vh && r.bottom > 0 && r.width >= 32 && r.height >= 32;
      });
      if (heroImgs.length > 0) {
        await Promise.race([
          Promise.all(
            heroImgs.map((img) => {
              if (img.complete && img.naturalWidth > 0) return Promise.resolve();
              return new Promise<void>((r) => {
                const done = (): void => r();
                img.addEventListener('load', done, { once: true });
                img.addEventListener('error', done, { once: true });
              });
            }),
          ),
          new Promise((r) => setTimeout(r, remaining())),
        ]);
      }

      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
    }, inPageBudget)
    .catch(() => {});
}

// ---------- scroll heuristic (ported verbatim from web-recorder) ----------

// Scroll heuristic: after the page is visually settled,
//   1. brief beat to let hero entrance animations play,
//   2. try to dismiss obvious cookie/consent banners,
//   3. apply the selected scroll style over the remaining time,
//   4. tail hold so the final frame is not mid-motion.
async function applyHeuristic(
  page: Page,
  durationMs: number,
  style: ScrollStyle,
): Promise<void> {
  const settleMs = Math.min(1500, Math.max(500, Math.floor(durationMs * 0.12)));
  await page.waitForTimeout(settleMs);

  await dismissCommonConsent(page);

  const tailMs = 400;
  const scrollMs = Math.max(1500, durationMs - settleMs - tailMs);

  await page.evaluate(
    async ({ ms, style, slowPxPerSec }) => {
      const docHeight = Math.max(
        document.body?.scrollHeight ?? 0,
        document.documentElement?.scrollHeight ?? 0,
      );
      const viewportH = window.innerHeight;
      const distance = Math.max(0, docHeight - viewportH);

      // hold (or an unscrollable page): stay put for the whole window.
      if (style === 'hold' || distance < 10) {
        await new Promise((r) => setTimeout(r, ms));
        return;
      }

      // Both scrolling modes move at capped, calm paces and cover only
      // as far as the recording budget naturally reaches. This avoids
      // rushing through a whole tall site in a short shot.
      const target =
        style === 'slow'
          ? Math.min(distance, (slowPxPerSec * ms) / 1000)
          : Math.min(distance, (linearPxPerSec * ms) / 1000);
      const smoothstep = (t: number): number => t * t * (3 - 2 * t);
      const ease = style === 'linear' ? (t: number): number => t : smoothstep;

      const start = performance.now();
      await new Promise<void>((resolve) => {
        function frame(): void {
          const t = Math.min(1, (performance.now() - start) / ms);
          window.scrollTo(0, target * ease(t));
          if (t < 1) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      });
    },
    {
      ms: scrollMs,
      style,
      slowPxPerSec: SLOW_SCROLL_PX_PER_SEC,
      linearPxPerSec: LINEAR_SCROLL_PX_PER_SEC,
    },
  );

  await page.waitForTimeout(tailMs);
}

// ---------- programmable scroll timeline ----------
//
// Drives `scroll_segments`: each entry says "travel to this fraction
// of the page over travel_ms, then hold for hold_ms". Same structural
// shape as applyHeuristic — short settle beat at the start, segments
// fill the middle, tail beat at the end. If the segments don't
// consume the full budget we hold at the final position to fill the
// remainder; if they would overrun, we just keep running and accept
// that the recording window may close mid-segment.
async function applyScrollSegments(
  page: Page,
  durationMs: number,
  segments: ScrollSegment[],
): Promise<void> {
  // Match applyHeuristic's pacing: 12% settle (clamped to 0.5-1.5s),
  // 400ms tail. Segments share whatever's left.
  const settleMs = Math.min(1500, Math.max(500, Math.floor(durationMs * 0.12)));
  await page.waitForTimeout(settleMs);
  await dismissCommonConsent(page);
  const tailMs = 400;
  const segmentBudgetMs = Math.max(0, durationMs - settleMs - tailMs);
  const segmentTotalMs = segments.reduce(
    (acc, s) => acc + s.travel_ms + s.hold_ms,
    0,
  );
  // Slack = budget left after segments run. We park at the last
  // segment's position for that long so the recording ends on a
  // stable frame rather than mid-something.
  const trailingHoldMs = Math.max(0, segmentBudgetMs - segmentTotalMs);

  await page.evaluate(
    async ({ segments, trailingHoldMs, maxPxPerSec, minTravelMs }) => {
      const docHeight = Math.max(
        document.body?.scrollHeight ?? 0,
        document.documentElement?.scrollHeight ?? 0,
      );
      const viewportH = window.innerHeight;
      const distance = Math.max(0, docHeight - viewportH);

      // Smoothstep easing — same shape as the default 'smooth' style
      // in applyHeuristic so the visual character matches.
      const ease = (t: number): number => t * t * (3 - 2 * t);

      let currentY = window.scrollY;
      for (const seg of segments) {
        const targetY = distance * seg.scroll_to;
        const delta = Math.abs(targetY - currentY);
        const travelMs =
          delta > 1
            ? Math.max(
                seg.travel_ms,
                minTravelMs,
                Math.ceil((delta / maxPxPerSec) * 1000),
              )
            : 0;
        if (travelMs > 0 && targetY !== currentY) {
          const fromY = currentY;
          const toY = targetY;
          const start = performance.now();
          await new Promise<void>((resolve) => {
            function frame(): void {
              const t = Math.min(1, (performance.now() - start) / travelMs);
              window.scrollTo(0, fromY + (toY - fromY) * ease(t));
              if (t < 1) requestAnimationFrame(frame);
              else resolve();
            }
            requestAnimationFrame(frame);
          });
        } else {
          // No movement needed; keep the frame stable.
          window.scrollTo(0, targetY);
        }
        currentY = targetY;
        if (seg.hold_ms > 0) {
          await new Promise((r) => setTimeout(r, seg.hold_ms));
        }
      }
      if (trailingHoldMs > 0) {
        await new Promise((r) => setTimeout(r, trailingHoldMs));
      }
    },
    {
      segments,
      trailingHoldMs,
      maxPxPerSec: SEGMENT_SCROLL_PX_PER_SEC,
      minTravelMs: MIN_SCROLL_TRAVEL_MS,
    },
  );

  await page.waitForTimeout(tailMs);
}

// ---------- consent / popup / auth-modal dismissal ----------
//
// Aggressive multi-pass dismissal that runs BEFORE the recording's
// trim clock advances, so the visible portion of the recording is
// always post-dismissal. Three layers:
//   1. dismissConsentAggressive — cookie / GDPR banners (vendor
//      selectors + multi-language button text + iframe walking + a
//      kill-CSS fallback that hides typical consent containers).
//   2. dismissAuthModals — login / signup / paywall / newsletter
//      modals overlaying otherwise-public content (ESC + close-button
//      selectors + dismissive button text + kill-CSS).
//   3. installRecurringPopupDismisser — keeps a 500ms interval running
//      inside the page for the recording duration so delayed popups
//      ("30s in, sign up!", exit-intent banners) get dismissed too.

const CONSENT_TEXT_BUTTONS = [
  // English (most permissive first — plain "Accept" matches lots of
  // sites including Vori's banner)
  'Accept all', 'Accept All', 'Accept all cookies', 'Accept Cookies',
  'I accept', 'Accept', 'Agree', 'I agree', 'Got it', 'OK', 'Allow all',
  'Allow', 'Allow cookies', 'Continue', 'Continue without accepting',
  'Reject all', 'Reject', 'Decline', 'Decline all', 'Disagree',
  'Save preferences', 'Confirm choices', 'Close', 'No thanks',
  // Common non-English consent buttons
  'Akzeptieren', 'Alle akzeptieren', 'Zustimmen',
  'Aceptar', 'Aceptar todo', 'Estoy de acuerdo',
  'Accepter', 'Tout accepter',
  'Accetta', 'Accetta tutto',
  '同意', '接受', '全部接受',
];

const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#onetrust-pc-btn-handler',
  '.onetrust-close-btn-handler',
  '#truste-consent-button',
  '#truste-consent-required',
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  '.qc-cmp2-summary-buttons button:nth-child(2)',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  'button#hs-eu-confirmation-button',
  'button.cm-btn-success',
  '.cc-allow', '.cc-dismiss',
  '[data-testid="GDPR-accept"]',
  '[data-cookiebanner="accept_button"]',
  '[aria-label*="Accept"]',
  '[aria-label*="Allow"]',
  '[aria-label*="Agree"]',
  '[aria-label*="cookie" i] button',
  '[id*="accept" i][id*="cookie" i]',
  '[class*="accept" i][class*="cookie" i]',
];

const CONSENT_KILL_CSS = `
  /* Known vendor containers */
  #onetrust-consent-sdk, #onetrust-banner-sdk,
  #CybotCookiebotDialog, .cookiebot-banner,
  #truste-consent-track, .truste_box_overlay, .truste_overlay,
  .qc-cmp2-container, .qc-cmp2-summary,
  .hs-cookie-notification-position-bottom, .hs-cookie-notification,
  .cc-window, .cc-banner, .cookie-consent,
  .cookie-notice, .cookie-banner, .cookies-banner, .cookies-popup,
  .gdpr-banner, .gdpr-cookie-notice,
  /* Generic attribute patterns */
  [id*="cookie" i][id*="consent" i],
  [id*="cookie" i][id*="banner" i],
  [class*="cookie" i][class*="consent" i],
  [class*="cookie" i][class*="banner" i],
  [class*="cookie" i][class*="notice" i],
  [aria-label*="cookie" i][role="dialog"],
  [aria-label*="consent" i][role="dialog"],
  [data-cookie-consent], [data-testid*="consent" i],
  [data-testid*="cookie" i] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
  /* Common page-scroll lock the banners apply */
  html.cmp-disable-scroll, body.cmp-disable-scroll,
  html[style*="overflow: hidden"], body[style*="overflow: hidden"] {
    overflow: auto !important;
  }
`;

const AUTH_DISMISS_BUTTON_TEXT = [
  'Not now', 'Not Now', 'Maybe later', 'Later', 'No thanks', 'No, thanks',
  'No Thanks', 'Dismiss', 'Cancel', 'Skip', 'Skip for now', 'Close',
  'Continue reading', 'Continue without subscribing',
  'Continue without account', 'Continue without an account',
  'Continue as guest', 'Browse anonymously',
  "I'll do it later", 'Remind me later',
  'Close dialog', 'Close modal',
];

const AUTH_MODAL_SELECTORS = [
  '[role="dialog"][aria-label*="sign in" i]',
  '[role="dialog"][aria-label*="sign up" i]',
  '[role="dialog"][aria-label*="log in" i]',
  '[role="dialog"][aria-label*="login" i]',
  '[role="dialog"][aria-label*="subscribe" i]',
  '[role="dialog"][aria-label*="paywall" i]',
  '[class*="signup-modal" i]', '[class*="signin-modal" i]',
  '[class*="login-modal" i]', '[class*="auth-modal" i]',
  '[class*="paywall-modal" i]', '[class*="subscribe-modal" i]',
  '[class*="newsletter-modal" i]',
  '#login-modal', '#signup-modal', '#auth-modal', '#paywall-modal',
  '[data-testid="sheetDialog"]', '[data-testid="LoginForm_Login_Button"]',
  '[role="dialog"] a[href*="/accounts/login"]',
  'shreddit-async-loader[bundlename="login_overlay"]',
];

const AUTH_CLOSE_BUTTON_SELECTORS = [
  '[aria-label="Close" i]', '[aria-label="Dismiss" i]',
  '[aria-label*="close" i][role="button"]',
  '[aria-label*="close dialog" i]', '[aria-label*="close modal" i]',
  'button[data-dismiss]', 'button[data-close]',
  '[data-testid="close"]', '[data-testid*="dismiss" i]',
  '[role="dialog"] button[aria-label*="close" i]',
  '[role="dialog"] [aria-label*="close" i]',
  'button.modal__close', 'button.close-button',
  '[class*="modal" i] [class*="close" i]',
];

/** Aggressive consent / cookie wall dismissal. Walks all frames
 *  (vendor banners are often iframed), clicks by vendor selector,
 *  then by text content (multi-language). Finally injects kill-CSS
 *  that hides anything that LOOKS like a consent container — last-
 *  resort defense for banners that ignore the click handlers.
 *  Returns true when at least one click landed (kill-CSS runs
 *  unconditionally). */
async function dismissConsentAggressive(page: Page): Promise<boolean> {
  let clicked = false;
  const frames = [page.mainFrame(), ...page.frames()];
  for (const frame of frames) {
    // (1) Vendor selectors first — fastest match when present.
    for (const sel of CONSENT_SELECTORS) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible({ timeout: 150 }).catch(() => false)) {
          await loc.click({ timeout: 500, force: true }).catch(() => {});
          clicked = true;
          await page.waitForTimeout(150);
        }
      } catch {
        /* ignore */
      }
    }
    // (2) Text-content matchers. Plain "Accept" matches Vori-style
    // banners that don't use vendor classes. One click per frame is
    // enough — break after the first hit so we don't chase additional
    // buttons that might be unrelated.
    for (const text of CONSENT_TEXT_BUTTONS) {
      try {
        const loc = frame
          .locator(
            `button:has-text("${text}"), [role="button"]:has-text("${text}"), a:has-text("${text}")`,
          )
          .first();
        if (await loc.isVisible({ timeout: 100 }).catch(() => false)) {
          await loc.click({ timeout: 500, force: true }).catch(() => {});
          clicked = true;
          await page.waitForTimeout(150);
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  // (3) Kill-CSS fallback — hides anything that LOOKS like a consent
  // container and unlocks body scroll. Safer to hide a stray modal
  // than to record over a consent wall.
  await page.addStyleTag({ content: CONSENT_KILL_CSS }).catch(() => {});
  return clicked;
}

/** Auth / login / signup / paywall modal dismissal. Distinct from the
 *  auth-wall URL detection (which catches FULL-PAGE redirects to
 *  /login). This handles MODAL OVERLAYS on top of otherwise public
 *  pages: NYT paywall, Medium's "join Medium" nag, X "log in to see
 *  more", Instagram "have an account?", etc. */
async function dismissAuthModals(page: Page): Promise<boolean> {
  let clicked = false;
  // (1) ESC — many modal libraries listen for it.
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  } catch {
    /* ignore */
  }
  const frames = [page.mainFrame(), ...page.frames()];
  for (const frame of frames) {
    for (const sel of AUTH_CLOSE_BUTTON_SELECTORS) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible({ timeout: 100 }).catch(() => false)) {
          await loc.click({ timeout: 500, force: true }).catch(() => {});
          clicked = true;
          await page.waitForTimeout(120);
        }
      } catch {
        /* ignore */
      }
    }
    for (const text of AUTH_DISMISS_BUTTON_TEXT) {
      try {
        const loc = frame
          .locator(
            `button:has-text("${text}"), [role="button"]:has-text("${text}"), a:has-text("${text}")`,
          )
          .first();
        if (await loc.isVisible({ timeout: 80 }).catch(() => false)) {
          await loc.click({ timeout: 500, force: true }).catch(() => {});
          clicked = true;
          await page.waitForTimeout(120);
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  await page
    .addStyleTag({
      content: `
        ${AUTH_MODAL_SELECTORS.join(',\n        ')} {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
        html.modal-open, body.modal-open,
        html.no-scroll, body.no-scroll,
        html.scroll-locked, body.scroll-locked {
          overflow: auto !important;
        }
      `,
    })
    .catch(() => {});
  return clicked;
}

/** Install a 500ms in-page interval that keeps clicking dismissive
 *  buttons / hiding modal selectors throughout the recording. Catches
 *  DELAYED popups: "30s in, sign up!" newsletter walls, exit-intent
 *  modals, scroll-depth paywalls. Auto-clears after horizonMs. */
async function installRecurringPopupDismisser(
  page: Page,
  horizonMs: number,
): Promise<void> {
  await page
    .evaluate(
      ({
        horizonMs,
        dismissTexts,
        modalSelectors,
        closeSelectors,
        consentTexts,
        consentSelectors,
      }) => {
        const tryClick = (el: Element | null): void => {
          if (!el) return;
          try {
            (el as HTMLElement).click();
          } catch {
            /* ignore */
          }
        };
        const dismissOnce = (): void => {
          // Close-button selectors (auth + cookie close X icons)
          for (const sel of closeSelectors) {
            const found = document.querySelector(sel);
            if (found && (found as HTMLElement).offsetParent !== null) {
              tryClick(found);
              return;
            }
          }
          // Vendor cookie-banner selectors
          for (const sel of consentSelectors) {
            const found = document.querySelector(sel);
            if (found && (found as HTMLElement).offsetParent !== null) {
              tryClick(found);
              return;
            }
          }
          // Text-content matchers — auth-dismiss first (they appear
          // mid-recording as overlays), then consent text.
          const buttons = Array.from(
            document.querySelectorAll('button, [role="button"], a'),
          ) as HTMLElement[];
          for (const b of buttons) {
            if (b.offsetParent === null) continue;
            const t = (b.textContent || '').trim();
            if (t.length === 0 || t.length > 40) continue;
            if (dismissTexts.includes(t) || consentTexts.includes(t)) {
              tryClick(b);
              return;
            }
          }
          // Brute force: hide visible modals matching auth selectors.
          for (const sel of modalSelectors) {
            const els = document.querySelectorAll(sel);
            for (const el of Array.from(els)) {
              (el as HTMLElement).style.setProperty(
                'display',
                'none',
                'important',
              );
            }
          }
        };
        dismissOnce();
        const intervalId = window.setInterval(dismissOnce, 500);
        window.setTimeout(
          () => window.clearInterval(intervalId),
          horizonMs,
        );
      },
      {
        horizonMs,
        dismissTexts: AUTH_DISMISS_BUTTON_TEXT,
        modalSelectors: AUTH_MODAL_SELECTORS,
        closeSelectors: AUTH_CLOSE_BUTTON_SELECTORS,
        consentTexts: CONSENT_TEXT_BUTTONS,
        consentSelectors: CONSENT_SELECTORS,
      },
    )
    .catch(() => {});
}

// Simple consent dismiss used inside recordUrl + the scroll heuristic.
// Ported verbatim from /Users/rahulpeesa/Documents/GitHub/web-recorder
// (heuristic.ts: dismissCommonConsent). The single addition is plain
// "Accept" for Vori-style banners whose button isn't labelled
// "Accept all". loadStealthPage (used by fetchPage / search funcs)
// runs the more elaborate dismissConsentAggressive on top of this.
async function dismissCommonConsent(page: Page): Promise<boolean> {
  const candidates = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("I accept")',
    'button:has-text("Accept")',
    'button:has-text("Allow all")',
    'button:has-text("Got it")',
    'button:has-text("Agree")',
    '[aria-label="Accept all"]',
    '#onetrust-accept-btn-handler',
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 250 }).catch(() => false)) {
        await el.click({ timeout: 500 }).catch(() => {});
        await page.waitForTimeout(200);
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

// ---------- expected-content keyword matching ----------

const STOPWORDS = new Set([
  // English function words
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this',
  'that', 'these', 'those', 'it', 'its', 'as', 'by', 'from', 'about',
  'into', 'over', 'their', 'they', 'them', 'has', 'have', 'had',
  'will', 'would', 'should', 'could', 'can', 'may', 'might',
  // Media-noise terms (the description domain — agents tend to put
  // these in expected_content but real pages never contain them).
  'shot', 'page', 'image', 'video', 'photo', 'picture', 'screenshot',
  'recording', 'capture', 'show', 'showing', 'real', 'public',
  // Layout / page-structure terms. Real pages don't literally say
  // "this is the hero section" / "this is the homepage" — they ARE
  // those things. If the agent describes a page by its layout
  // ("homepage hero section and logo") instead of its subject, every
  // layout token scores zero and the match tanks. Filter them out
  // so the score reflects subject-keyword overlap only.
  'homepage', 'site', 'website', 'webpage', 'landing',
  'header', 'footer', 'banner', 'hero', 'sidebar', 'aside',
  'navigation', 'nav', 'menu', 'section', 'subsection', 'div',
  'logo', 'wordmark', 'lockup', 'icon', 'favicon',
  'button', 'cta', 'link', 'thumbnail', 'tile', 'card',
  'carousel', 'slider', 'gallery', 'grid', 'list', 'feed',
  'modal', 'popup', 'overlay', 'tooltip', 'dropdown', 'accordion',
  'layout', 'panel', 'widget', 'embed', 'iframe', 'frame',
  'wrapper', 'container', 'block', 'content',
]);

/** Lightweight keyword-overlap score (0-1) between an expected
 *  description and the page's actual visible text. */
export function keywordMatchScore(expected: string, pageText: string): number {
  const tokens = expected
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const unique = Array.from(new Set(tokens));
  if (unique.length === 0) return 1;
  const haystack = pageText.toLowerCase();
  let hits = 0;
  for (const t of unique) {
    if (haystack.includes(t)) hits++;
  }
  return hits / unique.length;
}

// ---------- page-section extractor ----------
//
// extractPageSections inspects a loaded page and returns a sorted
// list of meaningful sections (hero, features, testimonials, footer,
// etc.) with their fractional positions in the page's scrollable
// height. The agent uses this to plan scroll_segments — instead of
// guessing "0.5 = middle", it knows that "Features section starts at
// 0.42" and can scroll precisely there.

export interface PageSection {
  /** Heading text inside the section (h1/h2/h3) when one exists;
   *  otherwise a class-name hint (hero / features / footer / ...);
   *  otherwise the tag name. Truncated to 120 chars. */
  label: string;
  /** Distance from the top of the page to the top of the section,
   *  expressed as a fraction of the page's scrollable height
   *  (0 = top, 1 = bottom). This is the value the agent should use
   *  as `scroll_to` in a scroll_segments entry. */
  position_fraction: number;
  /** Section height as a fraction of the page's scrollable height —
   *  a hint at how much vertical real estate the section takes up.
   *  Useful for deciding hold_ms (bigger section → longer hold so
   *  the viewer can take it in). */
  height_fraction: number;
}

export async function extractPageSections(page: Page): Promise<PageSection[]> {
  return page
    .evaluate(() => {
      const docHeight = Math.max(
        document.body?.scrollHeight ?? 0,
        document.documentElement?.scrollHeight ?? 0,
      );
      const vh = window.innerHeight;
      if (docHeight === 0 || vh === 0) return [];

      const candidates = new Set<HTMLElement>();

      // (1) Semantic sectioning elements.
      document
        .querySelectorAll(
          'section, header, footer, main, article, aside, [role="region"]',
        )
        .forEach((el) => candidates.add(el as HTMLElement));

      // (2) Top-level body children of meaningful size — covers
      // Webflow / Framer / hand-rolled marketing sites whose layout
      // uses <div class="section-X"> at the body root.
      const bodyChildren = Array.from(
        document.body?.children ?? [],
      ) as HTMLElement[];
      for (const child of bodyChildren) {
        const r = child.getBoundingClientRect();
        if (r.height >= vh * 0.3) candidates.add(child);
      }

      // (3) Elements with class names matching common section keywords.
      const classKeywords = [
        'hero', 'features?', 'testimonials?', 'pricing', 'cta',
        'footer', 'header', 'banner', 'gallery', 'stats?', 'about',
        'contact', 'team', 'product', 'how-it-works', 'benefits?',
        'faq', 'showcase', 'integrations?', 'reviews?', 'logos?',
      ];
      const classRe = new RegExp(`\\b(${classKeywords.join('|')})\\w*\\b`, 'i');
      document.querySelectorAll('[class]').forEach((node) => {
        const el = node as HTMLElement;
        const cls = typeof el.className === 'string' ? el.className : '';
        if (!classRe.test(cls)) return;
        const r = el.getBoundingClientRect();
        if (r.height >= vh * 0.3) candidates.add(el);
      });

      // Drop wrappers: if A contains B and B occupies >=90% of A's
      // height, A is just a layout wrapper around B — keep B.
      const list = Array.from(candidates);
      const kept = list.filter((el) => {
        const elH = el.getBoundingClientRect().height;
        if (elH <= 0) return false;
        for (const other of list) {
          if (other === el) continue;
          if (!el.contains(other)) continue;
          const otherH = other.getBoundingClientRect().height;
          if (otherH >= elH * 0.9) return false;
        }
        return true;
      });

      const getHeading = (el: Element): string | null => {
        const h = el.querySelector('h1, h2, h3') as HTMLElement | null;
        if (!h) return null;
        const txt = (h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim();
        return txt ? txt.slice(0, 120) : null;
      };
      const getClassLabel = (el: HTMLElement): string | null => {
        const cls = typeof el.className === 'string' ? el.className : '';
        const m = cls.match(classRe);
        return m ? m[0].toLowerCase() : null;
      };

      const sections: PageSection[] = [];
      for (const el of kept) {
        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        if (rect.height < Math.min(120, vh * 0.15)) continue;
        const heading = getHeading(el);
        const classLabel = getClassLabel(el);
        const tagLabel = el.tagName.toLowerCase();
        const label = heading ?? classLabel ?? tagLabel;
        sections.push({
          label,
          position_fraction: Math.max(0, Math.min(1, top / docHeight)),
          height_fraction: Math.max(0, Math.min(1, rect.height / docHeight)),
        });
      }

      // Sort by position. Dedupe near-identical positions: keep the
      // entry whose label looks most informative (longer + heading
      // beats class-name-only).
      sections.sort((a, b) => a.position_fraction - b.position_fraction);
      const deduped: PageSection[] = [];
      for (const s of sections) {
        const last = deduped[deduped.length - 1];
        if (last && Math.abs(s.position_fraction - last.position_fraction) < 0.03) {
          if (s.label.length > last.label.length) {
            deduped[deduped.length - 1] = s;
          }
        } else {
          deduped.push(s);
        }
      }
      // Cap so the agent doesn't choke on dozens of micro-sections.
      return deduped.slice(0, 12);
    })
    .catch(() => []);
}

// ---------- mp4 transcode (web-recorder convert.ts + behavior filter) ----------

/** Build the -vf filter chain that implements the requested camera
 *  "behavior" — a slow Ken Burns-style move applied in post on top of
 *  the recorded webm. */
function behaviorFilter(
  behavior: Behavior,
  durationSec: number,
  width: number,
  height: number,
): string | null {
  if (behavior === 'static') return null;
  const FPS = 25;
  const totalFrames = Math.max(1, Math.round(durationSec * FPS));
  const denom = Math.max(1, totalFrames - 1);
  const ramp = `(on/${denom})`;
  const W = width;
  const H = height;
  switch (behavior) {
    case 'zoom_in':
      return (
        `zoompan=z='1.0+0.15*${ramp}':d=1:s=${W}x${H}:fps=${FPS}:` +
        `x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'`
      );
    case 'zoom_out':
      return (
        `zoompan=z='1.15-0.15*${ramp}':d=1:s=${W}x${H}:fps=${FPS}:` +
        `x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'`
      );
    case 'pan_right':
      return (
        `zoompan=z='1.18':d=1:s=${W}x${H}:fps=${FPS}:` +
        `x='(iw-iw/zoom)*${ramp}':y='(ih-ih/zoom)/2'`
      );
    case 'pan_left':
      return (
        `zoompan=z='1.18':d=1:s=${W}x${H}:fps=${FPS}:` +
        `x='(iw-iw/zoom)*(1-${ramp})':y='(ih-ih/zoom)/2'`
      );
  }
}

interface TranscodeOptions {
  behavior?: Behavior;
  width?: number;
  height?: number;
  durationSec?: number;
}

/** ffmpeg transcode. Direct port of /Users/rahulpeesa/Documents/GitHub/
 *  web-recorder/src/convert.ts (toMp4): -ss before -i for fast +
 *  frame-accurate input seek, libx264 with preset=fast / crf=20,
 *  yuv420p, +faststart. The ONLY addition is an optional -vf
 *  behavior-filter chain (zoom_in / zoom_out / pan_*) applied when
 *  the caller asks for a camera move — when behavior is 'static'
 *  the args list is byte-identical to web-recorder's. */
function transcodeToMp4(
  input: string,
  output: string,
  trimStartSec: number,
  options: TranscodeOptions = {},
): Promise<void> {
  const trim = Math.max(0, trimStartSec);
  const seekArgs = trim > 0 ? ['-ss', trim.toFixed(3)] : [];
  const behavior = options.behavior ?? 'static';
  let filter: string | null = null;
  if (
    behavior !== 'static' &&
    options.width &&
    options.height &&
    options.durationSec
  ) {
    filter = behaviorFilter(
      behavior,
      options.durationSec,
      options.width,
      options.height,
    );
  }
  const filterArgs = filter ? ['-vf', filter] : [];
  return new Promise((resolve, reject) => {
    const proc = spawn(
      FFMPEG,
      [
        '-y',
        ...seekArgs,
        '-i', input,
        ...filterArgs,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        output,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

export const CAPTURES_DIR_PATH = CAPTURES_DIR;
