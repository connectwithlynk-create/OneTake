// Instagram resolver via a logged-in stealth browser.
//
// yt-dlp's Instagram extractor is currently broken: the /api/v1/media/
// {id}/info/ endpoint it relies on returns 302/403 for web sessions, so
// even with valid cookies it raises "Requested content is not available,
// rate-limit reached or login required". The public reel PAGE loads fine,
// though, and the Instagram SPA fetches the media data itself through the
// API endpoints (with the exact headers + rotating doc_id IG expects).
//
// So instead of reimplementing that handshake, we drive the real browser
// (the project's stealth Chromium, already used by the curator), inject
// the user's Instagram cookies, navigate to the reel, and intercept the
// JSON response that carries `video_versions`. The browser does the hard
// part; we just read the result.
import { readFileSync, existsSync } from 'fs';
import type { Cookie } from 'playwright';
import { getStealthBrowser } from './curator/web-record';
import type { ResolvedReel, ResolveResult } from './resolver';

/** Pull the shortcode out of a /reel/, /reels/, /p/, or /tv/ URL. */
export function instagramShortcode(url: string): string | null {
  const m = url.match(/instagram\.com\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Parse a Netscape cookies.txt (the YTDLP_COOKIES_FILE) into Playwright
 *  cookie objects for instagram.com. */
function loadCookies(file: string): Cookie[] {
  const out: Cookie[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [domain, , path, secure, expires, name, value] = f;
    if (!/instagram\.com$/i.test(domain.replace(/^\./, ''))) continue;
    const exp = parseInt(expires, 10);
    out.push({
      name,
      value,
      domain,
      path: path || '/',
      expires: Number.isFinite(exp) && exp > 0 ? exp : -1,
      httpOnly: false,
      secure: secure.toUpperCase() === 'TRUE',
      sameSite: 'Lax',
    } as Cookie);
  }
  return out;
}

interface VideoHit {
  url: string;
  width: number | null;
  height: number | null;
  duration_ms: number;
  caption: string | null;
  /** The media's own shortcode/code, when present — lets us pick the
   *  TARGET reel over related/suggested reels in the same payload. */
  code: string | null;
}

/** Recursively collect every media node carrying a playable video from
 *  an IG payload (API JSON or the page's embedded relay store). A page
 *  embeds the target reel AND related/suggested reels, so callers match
 *  on shortcode rather than taking the first hit. */
function collectVideos(node: unknown, out: VideoHit[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, any>;

  const versions = obj.video_versions;
  if (Array.isArray(versions) && versions.length) {
    const best = [...versions]
      .filter((v) => v && typeof v.url === 'string')
      .sort(
        (a, b) =>
          (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
      )[0];
    if (best) {
      out.push({
        url: best.url,
        width: obj.original_width ?? best.width ?? null,
        height: obj.original_height ?? best.height ?? null,
        duration_ms: obj.video_duration
          ? Math.round(obj.video_duration * 1000)
          : 0,
        caption:
          obj.caption && typeof obj.caption.text === 'string'
            ? obj.caption.text
            : null,
        code: obj.code ?? obj.shortcode ?? null,
      });
    }
  } else if (obj.is_video && typeof obj.video_url === 'string') {
    // GraphQL shape: { is_video, video_url, dimensions, shortcode }
    out.push({
      url: obj.video_url,
      width: obj.dimensions?.width ?? null,
      height: obj.dimensions?.height ?? null,
      duration_ms: obj.video_duration
        ? Math.round(obj.video_duration * 1000)
        : 0,
      caption: obj.edge_media_to_caption?.edges?.[0]?.node?.text ?? null,
      code: obj.shortcode ?? obj.code ?? null,
    });
  }
  for (const key of Object.keys(obj)) collectVideos(obj[key], out);
}

/** Pick the hit matching the target shortcode, else the first one. */
function pickVideo(hits: VideoHit[], shortcode: string): VideoHit | null {
  if (!hits.length) return null;
  return hits.find((h) => h.code === shortcode) ?? hits[0];
}

/** Parse one JSON payload and return the best video hit for the reel. */
function videoFromPayload(data: unknown, shortcode: string): VideoHit | null {
  const hits: VideoHit[] = [];
  collectVideos(data, hits);
  return pickVideo(hits, shortcode);
}

/** Resolve an Instagram reel by driving the stealth browser with the
 *  user's cookies and intercepting the media API response. Requires
 *  YTDLP_COOKIES_FILE to point at a cookies.txt with a logged-in IG
 *  session (see scripts/export-arc-cookies.py). */
export async function resolveInstagramViaBrowser(
  url: string,
): Promise<ResolveResult> {
  const shortcode = instagramShortcode(url);
  if (!shortcode) return { error: 'Not an Instagram reel/post URL' };

  const cookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
  if (!cookiesFile || !existsSync(cookiesFile)) {
    return {
      error:
        'Instagram needs a logged-in session. Set YTDLP_COOKIES_FILE to a ' +
        'cookies.txt (run scripts/export-arc-cookies.py) and retry.',
    };
  }

  const browser = await getStealthBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  try {
    await context.addCookies(loadCookies(cookiesFile));

    // Backup path: intercept IG's API responses. The graphql endpoint
    // returns `text/javascript` (not application/json), so don't filter
    // on content-type — just try to parse any api/graphql body as JSON.
    let hit: VideoHit | null = null;
    let resolveHit: (() => void) | null = null;
    const gotHit = new Promise<void>((res) => {
      resolveHit = res;
    });
    context.on('response', (resp) => {
      if (hit) return;
      const u = resp.url();
      if (!/\/(api\/v1|graphql)/.test(u)) return;
      resp
        .text()
        .then((body) => {
          if (hit || !body) return;
          let data: unknown;
          try {
            data = JSON.parse(body);
          } catch {
            return;
          }
          const found = videoFromPayload(data, shortcode);
          if (found) {
            hit = found;
            resolveHit?.();
          }
        })
        .catch(() => {
          /* body already consumed / not text — ignore */
        });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page
      .goto(`https://www.instagram.com/reel/${shortcode}/`, {
        waitUntil: 'domcontentloaded',
      })
      .catch(() => null);

    // Primary path: the reel page embeds the media (including
    // video_versions) in <script type="application/json"> relay blobs —
    // present even when logged out for public reels. Give the page a
    // moment to populate, then scan those blobs in Node.
    await page.waitForTimeout(2500);
    if (!hit) {
      const blobs = await page
        .evaluate(() =>
          Array.from(
            document.querySelectorAll('script[type="application/json"]'),
          )
            .map((s) => s.textContent || '')
            .filter((t) => t.includes('video_versions') || t.includes('"video_url"')),
        )
        .catch(() => [] as string[]);
      for (const b of blobs) {
        try {
          const found = videoFromPayload(JSON.parse(b), shortcode);
          if (found) {
            hit = found;
            break;
          }
        } catch {
          /* not parseable — skip */
        }
      }
    }

    // Still nothing? Wait a bit longer for the API intercept to fire.
    if (!hit) {
      await Promise.race([
        gotHit,
        new Promise<void>((res) => setTimeout(res, 10_000)),
      ]);
    }

    if (!hit) {
      return {
        error:
          'Could not capture the Instagram video URL — the reel may be ' +
          'private to your account, or the cookies are stale (re-run ' +
          'scripts/export-arc-cookies.py).',
      };
    }

    const expMatch = hit.url.match(/[?&]oe=([0-9a-fA-F]+)/);
    const resolved: ResolvedReel = {
      platform: 'instagram',
      playable_url: hit.url,
      // IG CDN URLs carry an `oe=` hex expiry (seconds since epoch).
      playable_url_expires_at: expMatch
        ? parseInt(expMatch[1], 16) * 1000
        : null,
      duration_ms: hit.duration_ms,
      width: hit.width,
      height: hit.height,
      caption_text: hit.caption,
    };
    return resolved;
  } finally {
    await context.close().catch(() => {});
  }
}
