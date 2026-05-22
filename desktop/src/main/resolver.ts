// In-process reel resolver. Spawns yt-dlp, which handles YouTube's nsig
// throttling param, PoToken, and signature decryption - the parts a raw
// ytInitialPlayerResponse URL lacks (and gets 403'd without). Runs on the
// user's machine, so the datacenter-IP bot wall never applies. yt-dlp also
// covers TikTok / Instagram, so there's no per-platform branching here.
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ResolvedReel {
  platform: 'youtube' | 'tiktok' | 'instagram' | 'unknown';
  playable_url: string;
  playable_url_expires_at: number | null;
  duration_ms: number;
  width: number | null;
  height: number | null;
  caption_text: string | null;
}

export type ResolveResult = ResolvedReel | { error: string };

// Override if yt-dlp isn't on PATH (e.g. a binary bundled with the app).
const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';

// Prefer a progressive (audio+video) mp4 <=720p so the <video> preview
// plays off a single URL; fall back through to whatever is playable.
const FORMAT =
  'best[ext=mp4][height<=720][acodec!=none][vcodec!=none]/' +
  'best[ext=mp4][height<=720]/best[height<=720]/best';

function detectPlatform(url: string): ResolvedReel['platform'] {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('youtube') || host === 'youtu.be') return 'youtube';
    if (host.includes('tiktok')) return 'tiktok';
    if (host.includes('instagram')) return 'instagram';
  } catch {
    // fall through to 'unknown'
  }
  return 'unknown';
}

// yt-dlp reports caption tracks as URLs, not text. Pull the English
// json3 track and flatten it to a plain transcript string.
async function captionText(info: any): Promise<string | null> {
  const subs =
    info.subtitles && Object.keys(info.subtitles).length
      ? info.subtitles
      : info.automatic_captions;
  const lang = Object.keys(subs ?? {}).find((k) => /^en/i.test(k));
  if (!lang) return null;
  const track = (subs[lang] as any[]).find((t) => t.ext === 'json3');
  if (!track?.url) return null;
  try {
    const res = await fetch(track.url);
    if (!res.ok) return null;
    const data: any = await res.json();
    const text = (data.events ?? [])
      .flatMap((e: any) =>
        (e.segs ?? []).map((s: any) => s.utf8 ?? '').filter(Boolean),
      )
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length ? text : null;
  } catch {
    return null;
  }
}

export async function resolveReel(url: string): Promise<ResolveResult> {
  try {
    new URL(url);
  } catch {
    return { error: 'Invalid URL' };
  }

  let info: any;
  try {
    const { stdout } = await execFileAsync(
      YT_DLP,
      [
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '-f',
        FORMAT,
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
    );
    info = JSON.parse(stdout);
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return { error: 'yt-dlp not found - install it or set YT_DLP_PATH' };
    }
    const stderr = String(e?.stderr ?? '').trim();
    const last = stderr.split('\n').filter(Boolean).pop();
    return { error: last || (e instanceof Error ? e.message : String(e)) };
  }

  const playable_url: string | undefined = info?.url;
  if (!playable_url) {
    return { error: 'yt-dlp returned no playable URL for this video' };
  }

  const expMatch = playable_url.match(/[?&]expire=(\d+)/);

  return {
    platform: detectPlatform(url),
    playable_url,
    playable_url_expires_at: expMatch
      ? parseInt(expMatch[1], 10) * 1000
      : null,
    duration_ms: info.duration ? Math.round(info.duration * 1000) : 0,
    width: typeof info.width === 'number' ? info.width : null,
    height: typeof info.height === 'number' ? info.height : null,
    caption_text: await captionText(info),
  };
}
