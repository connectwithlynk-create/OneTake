import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// Resolve a reel/short share URL to a streamable mp4 + raw media facts.
// Phase 1: YouTube Shorts only. TikTok / Instagram return 501 so the
// client can show "not supported yet" and keep moving. Caption text is
// pulled from YouTube's timed-text track when available (drives the
// spoken-hook archetype clustering downstream).
//
// Deploy: supabase functions deploy resolve-reel --no-verify-jwt
// (set --no-verify-jwt if you want unauthenticated swipe-add to work
// during dev; otherwise the client's Clerk JWT is forwarded by supabase-js).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

interface ResolveResponse {
  platform: 'youtube' | 'tiktok' | 'instagram' | 'unknown';
  playable_url: string;
  /** Epoch ms after which playable_url is expected to stop working. Null
   *  if the platform doesn't expose an expiry; client falls back to a
   *  short cache TTL. */
  playable_url_expires_at: number | null;
  duration_ms: number;
  width: number | null;
  height: number | null;
  caption_text: string | null;
}

const YT_ID_RE = /(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/;

function extractYouTubeId(url: string): string | null {
  const m = url.match(YT_ID_RE);
  return m ? m[1] : null;
}

interface YtFormat {
  url?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bitrate?: number;
}

interface YtCaptionTrack {
  baseUrl: string;
  languageCode: string;
  vssId?: string;
  kind?: string;
}

async function resolveYouTube(videoId: string): Promise<ResolveResponse> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(watchUrl, {
    headers: {
      // Mobile UA tends to surface direct-URL mp4 formats more often
      // than the desktop one (which leans on signatureCipher).
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`yt fetch ${res.status}`);
  const html = await res.text();

  // Two known anchors. Try both - YouTube swaps them between rollouts.
  let m =
    html.match(/var ytInitialPlayerResponse = (\{.+?\});(?:\s*var|<\/script>)/) ??
    html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
  if (!m) throw new Error('ytInitialPlayerResponse not found');
  // deno-lint-ignore no-explicit-any
  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    throw new Error('ytInitialPlayerResponse JSON parse failed');
  }

  const status = data.playabilityStatus?.status;
  if (status && status !== 'OK') {
    throw new Error(`unplayable: ${status} - ${data.playabilityStatus?.reason ?? ''}`);
  }

  const formats: YtFormat[] = [
    ...(data.streamingData?.formats ?? []),
    ...(data.streamingData?.adaptiveFormats ?? []),
  ];
  // Direct-URL mp4 only (skip signatureCipher entries that need decoding).
  // Cap at 720p so the byte-range frame extractor stays cheap.
  const playable = formats
    .filter(
      (f) =>
        f.url &&
        f.mimeType?.includes('video/mp4') &&
        (f.height ?? 0) <= 720
    )
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (!playable?.url) throw new Error('no direct-url mp4 format');

  const duration_ms = Math.round(
    parseFloat(data.videoDetails?.lengthSeconds ?? '0') * 1000
  );

  // playable_url expiry: youtube embeds an `expire` query param (unix sec).
  const expireMatch = playable.url.match(/[?&]expire=(\d+)/);
  const playable_url_expires_at = expireMatch
    ? parseInt(expireMatch[1], 10) * 1000
    : null;

  let caption_text: string | null = null;
  const tracks: YtCaptionTrack[] | undefined =
    data.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (tracks?.length) {
    // Prefer English; fall back to whatever's first (often the original lang).
    const en = tracks.find((t) => /^en/i.test(t.languageCode)) ?? tracks[0];
    try {
      const cRes = await fetch(`${en.baseUrl}&fmt=json3`);
      if (cRes.ok) {
        const cJson = await cRes.json();
        const events: Array<{ segs?: Array<{ utf8?: string }> }> =
          cJson?.events ?? [];
        const text = events
          .flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? '').filter(Boolean))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        caption_text = text.length > 0 ? text : null;
      }
    } catch {
      // Caption fetch is best-effort - reels analysis still works without it.
    }
  }

  return {
    platform: 'youtube',
    playable_url: playable.url,
    playable_url_expires_at,
    duration_ms,
    width: playable.width ?? null,
    height: playable.height ?? null,
    caption_text,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const { url } = await req.json();
    if (typeof url !== 'string' || url.length === 0) {
      return json({ error: 'url required' }, 400);
    }

    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
      const id = extractYouTubeId(url);
      if (!id) return json({ error: 'Invalid YouTube URL' }, 400);
      const result = await resolveYouTube(id);
      return json(result);
    }
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
      return json({ error: 'TikTok resolver not implemented (phase 2)' }, 501);
    }
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      return json({ error: 'Instagram resolver not implemented (phase 2)' }, 501);
    }
    return json({ error: `unsupported host: ${host}` }, 400);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
