// Custom function tools the research agent calls.
//
// web_search is provided by OpenAI's built-in Responses API tool —
// we don't implement it here.
//
// Tools defined here:
//   - fetch_page(url): load a URL in stealth Playwright Chromium
//     (same engine as record_url), wait for it to settle, dismiss
//     cookie / consent walls, detect auth walls, then extract:
//     - rendered title
//     - visible body text excerpt (innerText, post-hydration)
//     - real image URLs (after lazy-load, filtered for tracking pixels)
//     - real video / embed URLs
//     Used by the agent to evaluate pages without committing to a
//     full mp4 recording.
//   - record_url(url, ...): re-exported from ./web-record.ts —
//     produces a real mp4 recording (with scroll heuristic).
//
// generate_image is INTENTIONALLY ABSENT. AI image generation is
// blacklisted everywhere in the curator. Real-world media only.

export {
  recordUrl,
  type PageSection,
  type RecordedUrl,
  type ScrollSegment,
  type ScrollStyle,
} from './web-record';
import { tavily } from '@tavily/core';
import {
  extractPageSections,
  isVideoHostUrl,
  keywordMatchScore,
  loadStealthPage,
  type PageSection,
} from './web-record';

// ---------- google_search (Playwright-scraped) ----------

export interface GoogleSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface GoogleSearchResponse {
  query: string;
  results: GoogleSearchResult[];
  /** True when Google served a CAPTCHA / unusual-traffic interstitial.
   *  Caller should treat this as "no results" and try a different query
   *  or fall back to web_search. */
  blocked: boolean;
  /** Why blocked (when blocked=true) — captcha / rate_limit / load_error. */
  block_reason?: string;
}

// ---------- tavily_search (paid API, primary discovery tool) ----------
//
// Bot-friendly search: a real API designed for LLM agents. No scraping,
// no captcha walls, no IP rate-limiting surprises. Maps the @tavily/core
// SDK's response to the existing GoogleSearchResponse shape so call
// sites that previously hit duckduckgoSearch / googleSearch keep
// working unchanged.

let tavilyClient: ReturnType<typeof tavily> | null = null;
function getTavilyClient(): ReturnType<typeof tavily> | null {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  if (!tavilyClient) tavilyClient = tavily({ apiKey });
  return tavilyClient;
}

/** Hit the Tavily search API. Returns up to `n` results mapped to the
 *  curator's title/url/snippet shape. On missing API key / network
 *  error / SDK exception, returns blocked=true so the agent's
 *  fallback chain (web_search) kicks in cleanly — same contract as
 *  the old DDG / Google scrapers. */
export async function tavilySearch(
  query: string,
  n: number = 10,
): Promise<GoogleSearchResponse> {
  const client = getTavilyClient();
  if (!client) {
    return {
      query,
      results: [],
      blocked: true,
      block_reason: 'no_api_key (set TAVILY_API_KEY in .env)',
    };
  }
  // Tavily caps maxResults at 20; keep parity with the other backends.
  const safeN = Math.max(1, Math.min(20, n));
  try {
    const resp = await client.search(query, {
      maxResults: safeN,
      // 'basic' is fast + cheap and returns the snippet quality we
      // need for URL discovery. 'advanced' costs ~2x and adds deeper
      // crawling — not worth it for the curator's first-pass search.
      searchDepth: 'basic',
      // We do our own fetch_page on the URLs the agent picks, so we
      // don't need Tavily to also return raw page content.
      includeRawContent: false,
      // No answer summarization — the agent reads the snippets.
      includeAnswer: false,
    });
    const results = Array.isArray(resp.results) ? resp.results : [];
    if (results.length === 0) {
      return {
        query,
        results: [],
        blocked: true,
        block_reason: 'no_results',
      };
    }
    return {
      query,
      results: results.map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        // Tavily's `content` is a clean LLM-ready snippet — already
        // de-boilerplated, capped at ~300 chars by their backend.
        snippet: r.content ?? '',
      })),
      blocked: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      query,
      results: [],
      blocked: true,
      block_reason: `tavily_error: ${msg.slice(0, 200)}`,
    };
  }
}

const GOOGLE_SEARCH_BASE = 'https://www.google.com/search';

/** Scrape Google's SERP for the top N organic results via stealth
 *  Chromium. Returns title + URL + snippet per result. Detects CAPTCHA /
 *  unusual-traffic pages and returns blocked=true so the agent can fall
 *  back to OpenAI's web_search. */
export async function googleSearch(
  query: string,
  n: number = 10,
): Promise<GoogleSearchResponse> {
  const safeN = Math.max(1, Math.min(20, n));
  const url = `${GOOGLE_SEARCH_BASE}?q=${encodeURIComponent(query)}&num=${safeN}&hl=en&gl=us`;
  const loaded = await loadStealthPage(url);
  if (!loaded.ok) {
    return {
      query,
      results: [],
      blocked: true,
      block_reason: `load_error: ${loaded.error}`,
    };
  }
  try {
    // Google's CAPTCHA / unusual-traffic page has very specific phrasing.
    const captchaSnippet = loaded.page_text.slice(0, 2500);
    if (
      /unusual traffic from your computer network|before you continue to google|please complete the following challenge|recaptcha/i.test(
        captchaSnippet,
      )
    ) {
      return {
        query,
        results: [],
        blocked: true,
        block_reason: 'captcha_or_rate_limit',
      };
    }

    const results = await loaded.page
      .evaluate((maxResults) => {
        const out: { title: string; url: string; snippet: string }[] = [];
        const seen = new Set<string>();
        // Organic results are anchors that wrap an <h3>. This selector
        // has been the one stable element across Google SERP redesigns.
        const anchors = Array.from(
          document.querySelectorAll('a:has(h3)'),
        ) as HTMLAnchorElement[];
        for (const a of anchors) {
          if (out.length >= maxResults) break;
          let href = a.href || '';
          // Google sometimes wraps results in /url?q=ACTUAL&... redirect.
          if (
            href.startsWith('/url?') ||
            /^https?:\/\/(?:www\.)?google\.com\/url\?/i.test(href)
          ) {
            try {
              const u = new URL(href, location.href);
              const q = u.searchParams.get('q') || u.searchParams.get('url');
              if (q) href = q;
            } catch {
              /* ignore */
            }
          }
          if (!/^https?:\/\//.test(href)) continue;
          // Skip Google's own properties (search/maps/preferences/etc).
          if (
            /^https?:\/\/(?:www\.)?google\.[^/]+\/(?:search|preferences|setprefs|maps|imgres|aclk|advanced_search|sorry)/i.test(
              href,
            )
          )
            continue;
          if (seen.has(href)) continue;
          seen.add(href);
          const h3 = a.querySelector('h3');
          const title = (h3?.textContent ?? '').trim();
          if (!title) continue;

          // Walk up looking for the result container, then find the
          // longest <span> / <div> text that isn't the title or URL —
          // that's almost always the snippet. Bounded depth keeps it fast.
          let snippet = '';
          let container: HTMLElement | null = a.parentElement;
          for (let depth = 0; depth < 5 && container; depth++) {
            let bestLen = 0;
            const candidates = container.querySelectorAll(
              'div[data-sncf], span:not([aria-hidden="true"])',
            );
            for (const c of Array.from(candidates)) {
              const text = (c.textContent ?? '').trim();
              if (
                text.length > 40 &&
                text.length > bestLen &&
                text !== title &&
                !text.includes(href)
              ) {
                bestLen = text.length;
                snippet = text.slice(0, 240);
              }
            }
            if (snippet) break;
            container = container.parentElement;
          }
          out.push({ title, url: href, snippet });
        }
        return out;
      }, safeN)
      .catch(() => []);

    // Empty results on a clean (non-captcha) page can also indicate a
    // SERP-layout change Google rolled out — surface that explicitly.
    if (results.length === 0) {
      return {
        query,
        results: [],
        blocked: true,
        block_reason: 'no_results_parsed (SERP layout may have changed)',
      };
    }
    return { query, results, blocked: false };
  } finally {
    await loaded.cleanup();
  }
}

// ---------- duckduckgo_search (Playwright-scraped) ----------
//
// Same shape as googleSearch, but hits DuckDuckGo's "lite" SERP
// instead. DDG's full-html endpoint (/html/) shifts its selectors
// every few months; the lite endpoint (/lite/) is a server-rendered
// table-based page that's been structurally stable for a decade and
// returns direct URLs (no /l/?uddg=ENCODED_URL redirect wrapping).
// We hit lite first and fall back to html if lite ever fails.

const DDG_LITE_BASE = 'https://lite.duckduckgo.com/lite/';
const DDG_HTML_BASE = 'https://html.duckduckgo.com/html/';

/** Older /html/ endpoint wraps every result href in /l/?uddg=ENCODED_URL —
 *  unwrap it to the real destination. The /lite/ endpoint doesn't do
 *  this, but we keep the helper for the fallback path. */
function unwrapDdgRedirect(raw: string): string {
  if (!raw) return raw;
  try {
    const abs = raw.startsWith('//') ? `https:${raw}` : raw;
    const u = new URL(abs, 'https://duckduckgo.com');
    if (/duckduckgo\.com$/i.test(u.hostname) && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
    return abs;
  } catch {
    return raw;
  }
}

/** True if `text` clearly looks like a DDG rate-limit / "unusual
 *  traffic" interstitial rather than a SERP. */
function ddgIsRateLimited(text: string): boolean {
  const head = text.slice(0, 2500);
  return /unusual\s*traffic|are\s*you\s*a\s*robot|please\s*try\s*again|too\s*many\s*requests|automated\s*queries/i.test(
    head,
  );
}

interface ParsedResult {
  title: string;
  url: string;
  snippet: string;
}

/** Parse the /lite/ endpoint's table-based result list. Stable
 *  selector: anchors with class "result-link" carry the title + URL;
 *  snippets sit in the next sibling row's td.result-snippet (with a
 *  legacy class .snippet-result on older DDG variants).
 *
 *  Note: despite the name, the lite endpoint wraps result hrefs in
 *  /l/?uddg= redirects just like the /html/ endpoint does — unwrap
 *  them in the caller. */
async function parseDdgLite(
  page: import('playwright').Page,
  max: number,
): Promise<ParsedResult[]> {
  const raw = await page
    .evaluate((maxResults) => {
      const out: { title: string; url: string; snippet: string }[] = [];
      const seen = new Set<string>();
      const links = Array.from(
        document.querySelectorAll('a.result-link'),
      ) as HTMLAnchorElement[];
      for (const a of links) {
        if (out.length >= maxResults) break;
        // .href returns the resolved absolute URL (handles
        // protocol-relative //duckduckgo.com/l/?... hrefs). Using
        // getAttribute('href') here would drop every real result.
        const href = a.href || '';
        const title = (a.textContent || '').trim();
        if (!href || !title) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        // Walk forward through table rows looking for the matching
        // snippet td. The lite layout is:
        //   <tr><td>N.</td><td><a.result-link>title</a></td></tr>
        //   <tr><td colspan=2><span.link-text>url</span></td></tr>
        //   <tr><td colspan=2 class=result-snippet>snippet</td></tr>
        let snippet = '';
        const row = a.closest('tr');
        let cursor = row?.nextElementSibling ?? null;
        for (let depth = 0; depth < 4 && cursor; depth++) {
          const sn = cursor.querySelector('td.result-snippet, .snippet-result');
          if (sn) {
            snippet = (sn.textContent || '').trim().slice(0, 240);
            break;
          }
          cursor = cursor.nextElementSibling;
        }
        out.push({ title, url: href, snippet });
      }
      return out;
    }, max)
    .catch(() => [] as ParsedResult[]);
  // Unwrap DDG's /l/?uddg= redirects + drop anything that didn't
  // resolve to a real http(s) destination (sponsored "y.js" ad rows,
  // help-page links, etc.).
  return raw
    .map((r) => ({ ...r, url: unwrapDdgRedirect(r.url) }))
    .filter(
      (r) =>
        /^https?:\/\//i.test(r.url) &&
        // Drop DDG's own help/ad pages.
        !/(^|\.)duckduckgo\.com\//i.test(r.url) &&
        // Drop ad redirects (DDG's y.js endpoint).
        !/\/y\.js(\?|$)/.test(r.url),
    );
}

/** Parse the older /html/ endpoint as a fallback. Less stable but
 *  occasionally returns more results than /lite/ for certain queries. */
async function parseDdgHtml(
  page: import('playwright').Page,
  max: number,
): Promise<ParsedResult[]> {
  const raw = await page
    .evaluate((maxResults) => {
      const out: { title: string; url: string; snippet: string }[] = [];
      const seen = new Set<string>();
      const containers = Array.from(
        document.querySelectorAll('div.result, div.results_links, article'),
      );
      for (const div of containers) {
        if (out.length >= maxResults) break;
        const titleA = div.querySelector(
          'a.result__a, h2.result__title a, h2 a, h3 a',
        ) as HTMLAnchorElement | null;
        if (!titleA) continue;
        const href = titleA.getAttribute('href') || '';
        const title = (titleA.textContent || '').trim();
        if (!title || !href) continue;
        const snippetEl =
          div.querySelector('.result__snippet') ??
          div.querySelector('a.result__snippet') ??
          div.querySelector('[data-result="snippet"]');
        const snippet = (snippetEl?.textContent || '').trim().slice(0, 240);
        if (seen.has(href)) continue;
        seen.add(href);
        out.push({ title, url: href, snippet });
      }
      return out;
    }, max)
    .catch(() => [] as ParsedResult[]);
  return raw
    .map((r) => ({ ...r, url: unwrapDdgRedirect(r.url) }))
    .filter((r) => /^https?:\/\//i.test(r.url));
}

async function tryDdg(
  base: string,
  query: string,
  max: number,
  parser: 'lite' | 'html',
): Promise<{ ok: true; results: ParsedResult[] } | { ok: false; reason: string }> {
  const url = `${base}?q=${encodeURIComponent(query)}&kl=us-en`;
  const loaded = await loadStealthPage(url);
  if (!loaded.ok) {
    return { ok: false, reason: `load_error: ${loaded.error}` };
  }
  try {
    // DDG sometimes auto-redirects highly-confident queries straight
    // to the destination page instead of showing a SERP (e.g., a
    // unique product video / official page match). In that case the
    // final URL is no longer on duckduckgo.com — surface it as the
    // single result so the agent can fetch it directly.
    const finalHost = (() => {
      try {
        return new URL(loaded.final_url).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();
    const stayedOnDdg =
      finalHost.endsWith('duckduckgo.com') ||
      finalHost === 'lite.duckduckgo.com' ||
      finalHost === 'html.duckduckgo.com';
    if (!stayedOnDdg && /^https?:\/\//i.test(loaded.final_url)) {
      const title = loaded.page_title || loaded.final_url;
      const snippet = loaded.page_text
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      return {
        ok: true,
        results: [{ title, url: loaded.final_url, snippet }],
      };
    }
    if (ddgIsRateLimited(loaded.page_text)) {
      return { ok: false, reason: 'rate_limited' };
    }
    const results =
      parser === 'lite'
        ? await parseDdgLite(loaded.page, max)
        : await parseDdgHtml(loaded.page, max);
    if (results.length === 0) {
      return {
        ok: false,
        reason: `no_results_parsed (${parser} endpoint, layout may have changed)`,
      };
    }
    return { ok: true, results };
  } finally {
    await loaded.cleanup();
  }
}

export async function duckduckgoSearch(
  query: string,
  n: number = 10,
): Promise<GoogleSearchResponse> {
  const safeN = Math.max(1, Math.min(20, n));
  // Lite first (stable + plain HTML); fall back to html (different
  // layout, sometimes survives when lite is down for maintenance).
  const lite = await tryDdg(DDG_LITE_BASE, query, safeN, 'lite');
  if (lite.ok) {
    return { query, results: lite.results, blocked: false };
  }
  // Rate-limit applies to the whole DDG infrastructure — no point
  // retrying with the other endpoint.
  if (lite.reason === 'rate_limited') {
    return { query, results: [], blocked: true, block_reason: 'rate_limited' };
  }
  const html = await tryDdg(DDG_HTML_BASE, query, safeN, 'html');
  if (html.ok) {
    return { query, results: html.results, blocked: false };
  }
  return {
    query,
    results: [],
    blocked: true,
    block_reason: `lite: ${lite.reason} | html: ${html.reason}`,
  };
}

const MAX_MEDIA_PER_PAGE = 8;
const TEXT_EXCERPT_CHARS = 1200;
/** Image dimensions below this are almost always tracking pixels /
 *  decorative icons rather than real media worth showing. */
const MIN_IMAGE_PX = 64;

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  title: string | null;
  /** Visible body text (innerText, post-hydration), truncated. */
  text_excerpt: string;
  /** Real image URLs visible on the page, deduped, filtered for
   *  tracking pixels and decorative icons, capped at MAX_MEDIA_PER_PAGE. */
  images: {
    url: string;
    alt: string | null;
    width: number;
    height: number;
  }[];
  /** Video URLs — direct files (.mp4/.webm) plus embedded
   *  YouTube/Vimeo iframes. */
  videos: { url: string; kind: 'direct' | 'youtube' | 'vimeo' | 'iframe' }[];
  /** Whether a cookie / consent wall was detected and dismissed. */
  consent_dismissed: boolean;
  /** Page sections detected in the rendered DOM, sorted top→bottom.
   *  Each entry includes a label (heading text / class hint), a
   *  position_fraction (0=top, 1=bottom) for where it sits, and a
   *  height_fraction. Designed to be fed directly into record_url's
   *  scroll_segments — the agent can pick which sections to land on
   *  and at what timing. Captured at fetchPage's viewport (desktop
   *  by default); positions are approximate when the eventual
   *  recording is at a different viewport, but the relative ordering
   *  and section count are stable. */
  sections: PageSection[];
  /** When `expected_content` was provided to fetchPage: keyword-match
   *  score (0-1) between the expected description and the page's
   *  visible title + body text. Higher = better match. */
  content_match_score?: number;
  /** Convenience flag derived from content_match_score >= 0.25 (the
   *  same threshold record_url uses). When false, the page is almost
   *  certainly NOT about the subject you expected — e.g., a similar
   *  username on X that belongs to someone else. */
  matches_expected?: boolean;
}

export interface FetchedPageFailure {
  ok: false;
  url: string;
  error: string;
  /** Present when the page was an auth wall — caller can decide
   *  whether to pick a different URL. */
  page_text_excerpt?: string;
}

export interface FetchPageOptions {
  /** Short description of what the page SHOULD contain — typically
   *  the subject's name plus a topic qualifier (e.g., "Vori grocery
   *  POS founder Brandon Hill"). When set, fetchPage scores the
   *  page's title + visible text against this description and returns
   *  content_match_score + matches_expected so the caller can detect
   *  similar-but-wrong pages (e.g., a Twitter handle that exists but
   *  belongs to a different entity). */
  expectedContent?: string;
}

/** Load a URL in stealth Chromium and return the rendered title,
 *  visible text, and real media URLs. Inherits all of record_url's
 *  protections (stealth fingerprint, consent-wall dismissal, auth-wall
 *  detection). When expectedContent is supplied, also returns a
 *  keyword-overlap score so the caller can reject same-domain wrong-
 *  subject pages. Returns a failure object on invalid URL / auth wall
 *  / load error so the agent can route around the page. */
export async function fetchPage(
  url: string,
  options: FetchPageOptions = {},
): Promise<FetchedPage | FetchedPageFailure> {
  // Video-host URLs (YouTube / Vimeo / Loom / Streamable / Wistia /
  // Dailymotion / v.redd.it / Instagram / TikTok) are passthroughs —
  // the editor renders them downstream from the URL alone, so the
  // agent should commit them directly as source="web_video" rather
  // than spending a fetch on auth-wall detection that would just
  // bounce ig/tiktok URLs.
  if (isVideoHostUrl(url)) {
    return {
      ok: false,
      url,
      error: `video_host_passthrough (${url}) — this is already a video URL. Commit it directly as a MediaCandidate with source="web_video", url="${url}", source_page="${url}". Do NOT call fetch_page, request_record_approval, or record_url on video-host URLs.`,
    };
  }
  const loaded = await loadStealthPage(url);
  if (!loaded.ok) {
    return {
      ok: false,
      url: loaded.final_url,
      error: loaded.error,
      page_text_excerpt: loaded.page_text_excerpt,
    };
  }

  try {
    const text_excerpt = loaded.page_text.trim().slice(0, TEXT_EXCERPT_CHARS);

    // Pull real <img> elements after lazy-load. Filter by natural
    // dimensions to drop tracking pixels and decorative icons.
    const rawImages: { url: string; alt: string; w: number; h: number }[] =
      await loaded.page
        .evaluate(
          ({ minPx, max }) => {
            const out: { url: string; alt: string; w: number; h: number }[] = [];
            const seen = new Set<string>();
            const push = (
              src: string,
              alt: string,
              w: number,
              h: number,
            ): void => {
              if (!src || seen.has(src)) return;
              if (w < minPx || h < minPx) return;
              seen.add(src);
              out.push({ url: src, alt, w, h });
            };
            // og:image / twitter:image first
            const metaSelectors = [
              'meta[property="og:image"]',
              'meta[property="og:image:secure_url"]',
              'meta[name="twitter:image"]',
              'meta[name="twitter:image:src"]',
            ];
            for (const sel of metaSelectors) {
              const meta = document.querySelector(
                sel,
              ) as HTMLMetaElement | null;
              if (meta?.content) {
                try {
                  const abs = new URL(meta.content, location.href).toString();
                  push(abs, '', minPx, minPx);
                } catch {
                  /* ignore */
                }
              }
            }
            for (const img of Array.from(document.images)) {
              if (out.length >= max) break;
              const w = img.naturalWidth || img.width || 0;
              const h = img.naturalHeight || img.height || 0;
              try {
                const abs = new URL(img.src, location.href).toString();
                push(abs, img.alt || '', w, h);
              } catch {
                /* ignore */
              }
            }
            return out;
          },
          { minPx: MIN_IMAGE_PX, max: MAX_MEDIA_PER_PAGE },
        )
        .catch(() => []);

    const images = rawImages.map((i) => ({
      url: i.url,
      alt: i.alt || null,
      width: i.w,
      height: i.h,
    }));

    // Real video sources — <video src>, <source src>, <iframe src>
    // pointing at known video providers, plus YouTube anchor hrefs.
    const videos: FetchedPage['videos'] = await loaded.page
      .evaluate((max) => {
        const out: { url: string; kind: string }[] = [];
        const seen = new Set<string>();
        const push = (raw: string, kind: string): void => {
          if (!raw || seen.has(raw)) return;
          seen.add(raw);
          if (out.length < max) out.push({ url: raw, kind });
        };
        // og:video meta
        const ogv = document.querySelector(
          'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]',
        ) as HTMLMetaElement | null;
        if (ogv?.content) {
          try {
            push(new URL(ogv.content, location.href).toString(), 'direct');
          } catch {
            /* ignore */
          }
        }
        // <video src> + <source src>
        for (const v of Array.from(
          document.querySelectorAll('video, video source'),
        )) {
          const src = (v as HTMLVideoElement | HTMLSourceElement).src;
          if (src) {
            try {
              push(new URL(src, location.href).toString(), 'direct');
            } catch {
              /* ignore */
            }
          }
        }
        // iframes
        for (const f of Array.from(document.querySelectorAll('iframe'))) {
          const src = (f as HTMLIFrameElement).src;
          if (!src) continue;
          try {
            const abs = new URL(src, location.href).toString();
            if (/youtube\.com\/embed|youtu\.be/.test(abs)) push(abs, 'youtube');
            else if (/player\.vimeo\.com/.test(abs)) push(abs, 'vimeo');
            else if (/\.(mp4|webm|mov)(\?|$)/.test(abs)) push(abs, 'direct');
            else push(abs, 'iframe');
          } catch {
            /* ignore */
          }
        }
        // <a href> to YouTube
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const href = (a as HTMLAnchorElement).href;
          if (
            href &&
            /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch|youtu\.be\/)/.test(
              href,
            )
          ) {
            push(href, 'youtube');
          }
        }
        return out;
      }, MAX_MEDIA_PER_PAGE)
      .catch(() => []) as FetchedPage['videos'];

    const expected = options.expectedContent?.trim() ?? '';
    let content_match_score: number | undefined;
    let matches_expected: boolean | undefined;
    if (expected.length > 0) {
      // Score against the title + visible body. Title carries the
      // strongest identity signal — an X profile titled "Profile / X"
      // with the wrong handle won't have the subject's name in body.
      const haystack = `${loaded.page_title ?? ''}\n${loaded.page_text}`;
      content_match_score = keywordMatchScore(expected, haystack);
      matches_expected = content_match_score >= 0.25;
    }

    // Layout structure for the agent to plan scroll_segments against.
    // Captured at the same viewport fetchPage used to settle the page.
    const sections = await extractPageSections(loaded.page);

    return {
      url: loaded.final_url,
      title: loaded.page_title,
      text_excerpt,
      images,
      videos,
      consent_dismissed: loaded.consent_dismissed,
      sections,
      ...(content_match_score !== undefined && {
        content_match_score,
        matches_expected,
      }),
    };
  } finally {
    await loaded.cleanup();
  }
}

// ---------- direct-video extraction (post-processing, not an agent tool) ----------

export interface ExtractedVideo {
  /** Direct .mp4/.webm/.mov URL the renderer can play in a <video>. */
  video_url: string;
  /** og:image poster, if found. */
  thumbnail_url: string | null;
}

const POST_FETCH_TIMEOUT_MS = 15_000;
const POST_FETCH_MAX_BYTES = 600_000;

/** Pull a directly-playable video URL from a page's og:video / twitter
 *  player meta tags or a <video src> element. Lightweight raw HTTP
 *  fetch — used post-curation to upgrade page-URL candidates (e.g.,
 *  Pexels article pages) into playable direct files inside the
 *  candidate card. Not exposed as an agent tool. */
export async function extractDirectVideoFromPage(
  pageUrl: string,
): Promise<ExtractedVideo | null> {
  let absUrl: string;
  try {
    absUrl = new URL(pageUrl).toString();
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const resp = await fetch(absUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      },
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('text/html')) return null;
    const buf = await resp.arrayBuffer();
    html = new TextDecoder('utf-8').decode(
      new Uint8Array(buf).slice(0, POST_FETCH_MAX_BYTES),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  const metaPatterns = [
    /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i,
  ];
  let videoUrl: string | null = null;
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m) {
      const candidate = resolveAbs(absUrl, m[1]);
      if (candidate) {
        videoUrl = candidate;
        break;
      }
    }
  }
  if (!videoUrl) {
    const re = /<(?:video|source)\b[^>]*\bsrc=["']([^"']+\.(?:mp4|webm|mov|m4v))["']/i;
    const m = html.match(re);
    if (m) videoUrl = resolveAbs(absUrl, m[1]);
  }
  if (!videoUrl) return null;

  let thumbnail_url: string | null = null;
  const ogImg = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  );
  if (ogImg) thumbnail_url = resolveAbs(absUrl, ogImg[1]);

  return { video_url: videoUrl, thumbnail_url };
}

function resolveAbs(base: string, raw: string): string | null {
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}
