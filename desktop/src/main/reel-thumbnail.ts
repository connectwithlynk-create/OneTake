// Fetch a static thumbnail for a reel link as a data URL.
//
// Strategy:
//   - YouTube / YouTube Shorts → derive img.youtube.com URL from
//     the video id (cheapest path; no subprocess, no HTML fetch).
//   - Everything else → ask yt-dlp for the thumbnail URL. yt-dlp
//     already handles Instagram / TikTok login walls and signed-URL
//     extraction that bare HTML scrapers can't get past, and it's
//     already in our resolver path.
//   - Then proxy-fetch the image binary with Referer pointed back at
//     the original reel URL (Instagram / TikTok CDNs reject loads
//     without it) and return as a data:URL.
//
// Returns null when nothing usable can be derived/extracted. Best-
// effort and short-timeout; thumbnails are a nicety, not load-bearing.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { YT_DLP, ytdlpCookieArgs } from './ytdlp';

const execFileAsync = promisify(execFile);

const YT_DLP_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 12_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function extractYouTubeId(url: string): string | null {
  // youtu.be/<id>
  const short = url.match(/youtu\.be\/([\w-]{6,})/);
  if (short) return short[1];
  // youtube.com/watch?v=<id>
  const watch = url.match(/[?&]v=([\w-]{6,})/);
  if (watch) return watch[1];
  // youtube.com/shorts/<id>
  const shorts = url.match(/youtube\.com\/shorts\/([\w-]{6,})/);
  if (shorts) return shorts[1];
  // youtube.com/embed/<id>
  const embed = url.match(/youtube\.com\/embed\/([\w-]{6,})/);
  if (embed) return embed[1];
  return null;
}

/** Ask yt-dlp for the thumbnail URL of a reel. Far more reliable than
 *  raw page scraping because yt-dlp handles login walls / signed URLs
 *  for IG / TikTok. Returns null when yt-dlp fails or isn't installed. */
async function ytDlpThumbnailUrl(reelUrl: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(
      YT_DLP,
      [
        '--skip-download',
        '--no-warnings',
        '--no-playlist',
        ...ytdlpCookieArgs(),
        '--print',
        '%(thumbnail)s',
        reelUrl,
      ],
      { maxBuffer: 8 * 1024 * 1024, timeout: YT_DLP_TIMEOUT_MS },
    );
    if (stderr) console.error('[reel-thumbnail] yt-dlp stderr:', stderr.trim());
    const url = stdout.trim().split('\n').filter(Boolean).pop();
    if (!url || url === 'NA') {
      console.error('[reel-thumbnail] yt-dlp returned no thumbnail for', reelUrl, '(stdout:', JSON.stringify(stdout.trim()), ')');
      return null;
    }
    console.error('[reel-thumbnail] yt-dlp resolved thumbnail:', url);
    return url;
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string };
    console.error(
      '[reel-thumbnail] yt-dlp failed:',
      e.code ?? '',
      e.stderr?.trim() ?? '',
      e.message ?? String(err),
    );
    return null;
  }
}

/** Scrape the page's og:image / twitter:image straight from the
 *  server-rendered HTML. This is the fallback for platforms where yt-dlp
 *  hits a login wall (Instagram especially) but the public page still
 *  emits Open Graph tags for link-preview crawlers. We pose as
 *  facebookexternalhit — the canonical link-unfurl bot — which IG/TikTok
 *  serve og tags to even when the interactive page is gated. Returns the
 *  absolute image URL, or null. */
async function ogImageFromPage(reelUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(reelUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!resp.ok) {
      console.error('[reel-thumbnail] og:image page fetch returned', resp.status, 'for', reelUrl);
      return null;
    }
    const html = await resp.text();
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    if (!m) {
      console.error('[reel-thumbnail] no og:image meta in HTML for', reelUrl);
      return null;
    }
    // Decode HTML entities Instagram escapes in the URL (&amp; → &).
    const raw = m[1].replace(/&amp;/g, '&');
    try {
      const abs = new URL(raw, reelUrl).toString();
      console.error('[reel-thumbnail] og:image resolved:', abs);
      return abs;
    } catch {
      return null;
    }
  } catch (err) {
    console.error(
      '[reel-thumbnail] og:image fetch threw:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Discover the underlying thumbnail URL for a reel page. YouTube is
 *  derived directly; everything else tries yt-dlp first, then falls back
 *  to scraping og:image (for IG/TikTok login-walled pages yt-dlp can't
 *  resolve). */
async function discoverThumbnailUrl(reelUrl: string): Promise<string | null> {
  const ytId = extractYouTubeId(reelUrl);
  if (ytId) return `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
  return (await ytDlpThumbnailUrl(reelUrl)) ?? (await ogImageFromPage(reelUrl));
}

/** Fetch the image binary and encode as data: URL. Referer pointed
 *  back at the original reel page so platform CDNs (Instagram, TikTok)
 *  accept the request. */
async function fetchImageAsDataUrl(
  imageUrl: string,
  refererUrl: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Referer: refererUrl,
        Accept: 'image/*',
      },
      redirect: 'follow',
    });
    if (!resp.ok) {
      console.error(
        '[reel-thumbnail] image fetch returned',
        resp.status,
        resp.statusText,
        'for',
        imageUrl,
      );
      return null;
    }
    const ct = resp.headers.get('content-type') ?? 'image/jpeg';
    if (!ct.startsWith('image/')) {
      console.error(
        '[reel-thumbnail] image fetch returned non-image content-type:',
        ct,
        'for',
        imageUrl,
      );
      return null;
    }
    const buf = await resp.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    console.error(
      '[reel-thumbnail] image fetched OK:',
      buf.byteLength,
      'bytes,',
      ct,
    );
    return `data:${ct};base64,${b64}`;
  } catch (err) {
    console.error(
      '[reel-thumbnail] image fetch threw:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchReelThumbnail(url: string): Promise<string | null> {
  if (!url) return null;
  const discovered = await discoverThumbnailUrl(url);
  if (!discovered) return null;
  return fetchImageAsDataUrl(discovered, url);
}
