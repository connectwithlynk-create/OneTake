// Shared yt-dlp configuration. Instagram (and intermittently TikTok) now
// gate content behind login / rate-limits, so yt-dlp returns "Requested
// content is not available, rate-limit reached or login required" unless
// it's handed cookies. We don't ship credentials — the user points us at
// their browser's cookie store or an exported cookies.txt via env vars
// (both honored from desktop/.env), and every yt-dlp call picks them up.

import { copyFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Override if yt-dlp isn't on PATH (e.g. a binary bundled with the app).
export const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';

/** Authentication args for yt-dlp, derived from env:
 *   YTDLP_COOKIES_FILE          → --cookies <path>           (Netscape cookies.txt)
 *   YTDLP_COOKIES_FROM_BROWSER  → --cookies-from-browser <v> (e.g. "chrome",
 *                                 "safari", "firefox", "edge", "brave",
 *                                 or "chrome:Profile 1" for a named profile)
 *  A cookies file wins when both are set. Returns [] when neither is
 *  configured — the unauthenticated default. */
let cookieCopySeq = 0;

export function ytdlpCookieArgs(): string[] {
  const file = process.env.YTDLP_COOKIES_FILE?.trim();
  if (file && existsSync(file)) {
    // yt-dlp's --cookies is read-WRITE: on exit it saves its jar back to
    // the file, and MozillaCookieJar.save() drops session cookies (e.g.
    // Instagram's `sessionid`). That would silently degrade the file the
    // browser resolver depends on. Hand yt-dlp a throwaway copy instead
    // so the source of truth is never mutated. The copy is UNIQUE per
    // call: up to 4 yt-dlp jobs run concurrently, and a shared path
    // races one job's write-back against another's read.
    const copy = join(
      tmpdir(),
      `onetake-ytdlp-cookies-${process.pid}-${++cookieCopySeq}.txt`,
    );
    try {
      copyFileSync(file, copy);
      return ['--cookies', copy];
    } catch {
      return ['--cookies', file];
    }
  }
  const browser =
    process.env.YTDLP_COOKIES_FROM_BROWSER?.trim() ||
    (process.env.ONETAKE_YTDLP_AUTO_BROWSER_COOKIES === '0' ? '' : 'chrome');
  if (browser) return ['--cookies-from-browser', browser];
  return [];
}

/** Whether any cookie source is configured — used to tailor the
 *  "login required" hint (don't tell the user to add cookies if they
 *  already have, since then the cookies themselves are stale/wrong). */
export function hasYtdlpCookies(): boolean {
  return !!(
    process.env.YTDLP_COOKIES_FILE?.trim() ||
    process.env.YTDLP_COOKIES_FROM_BROWSER?.trim() ||
    process.env.ONETAKE_YTDLP_AUTO_BROWSER_COOKIES !== '0'
  );
}

/** yt-dlp stderr patterns that mean "this needs valid cookies". */
const AUTH_WALL_RE =
  /rate-limit|login required|requested content is not available|use --cookies|sign in|account|private|18 ?\+|age/i;

/** Turn a raw yt-dlp failure into a user-facing message, appending an
 *  actionable cookie hint when the failure looks like an auth wall. */
export function ytdlpErrorMessage(stderr: string, fallback: string): string {
  const last = stderr.split('\n').filter(Boolean).pop();
  const base = last || fallback;
  if (!AUTH_WALL_RE.test(stderr)) return base;
  if (hasYtdlpCookies()) {
    return (
      base +
      '\nCookies are set but rejected — they may be expired. Re-export ' +
      'them (log in again in the browser) or point YTDLP_COOKIES_FILE at a ' +
      'fresh cookies.txt, then retry.'
    );
  }
  return (
    base +
    '\nThis reel needs authentication. Add one of these to desktop/.env and ' +
    'retry:\n' +
    '  YTDLP_COOKIES_FROM_BROWSER=chrome   (or safari / firefox / edge / brave)\n' +
    '  YTDLP_COOKIES_FILE=/path/to/cookies.txt'
  );
}
