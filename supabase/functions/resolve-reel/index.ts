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

// InnerTube clients tried in order. The IOS client serves direct-URL
// mp4 formats for shorts and most public videos without PoToken. We
// fall back to ANDROID_VR if iOS returns nothing direct-streamable
// (rare but happens on a few age/region-gated reels).
const INNERTUBE_CLIENTS = [
  {
    name: 'IOS',
    clientName: 'IOS',
    clientVersion: '20.10.4',
    userAgent:
      'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    clientNumber: 5,
    extras: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      platform: 'MOBILE',
    },
  },
  {
    name: 'ANDROID_VR',
    clientName: 'ANDROID_VR',
    clientVersion: '1.62.27',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; Quest 3) gzip',
    clientNumber: 28,
    extras: {
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12L',
      platform: 'MOBILE',
    },
  },
];

// deno-lint-ignore no-explicit-any
async function fetchInnerTube(videoId: string, client: typeof INNERTUBE_CLIENTS[number]): Promise<any> {
  const body = {
    context: {
      client: {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: 'en',
        gl: 'US',
        userAgent: client.userAgent,
        ...client.extras,
      },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const res = await fetch(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.userAgent,
        'X-Youtube-Client-Name': String(client.clientNumber),
        'X-Youtube-Client-Version': client.clientVersion,
        Origin: 'https://www.youtube.com',
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`innertube ${client.name} ${res.status}`);
  return await res.json();
}

async function resolveYouTube(videoId: string): Promise<ResolveResponse> {
  // deno-lint-ignore no-explicit-any
  let data: any = null;
  let lastErr = '';
  for (const client of INNERTUBE_CLIENTS) {
    try {
      data = await fetchInnerTube(videoId, client);
      const status = data?.playabilityStatus?.status;
      if (status && status !== 'OK') {
        lastErr = `${client.name}: ${status} ${data.playabilityStatus?.reason ?? ''}`;
        continue;
      }
      const formats: YtFormat[] = [
        ...(data.streamingData?.formats ?? []),
        ...(data.streamingData?.adaptiveFormats ?? []),
      ];
      const hasDirect = formats.some((f) => f.url && f.mimeType?.includes('video/mp4'));
      if (hasDirect) break;
      lastErr = `${client.name}: no direct mp4`;
    } catch (e: unknown) {
      lastErr = `${client.name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (!data) throw new Error(`innertube failed: ${lastErr}`);

  const status = data.playabilityStatus?.status;
  if (status && status !== 'OK') {
    throw new Error(`unplayable: ${status} - ${data.playabilityStatus?.reason ?? ''}`);
  }

  const formats: YtFormat[] = [
    ...(data.streamingData?.formats ?? []),
    ...(data.streamingData?.adaptiveFormats ?? []),
  ];
  // Direct-URL mp4 only. Cap at 720p so the byte-range frame extractor
  // stays cheap. Prefer formats that carry both video+audio (`formats`
  // entries) when available so the same URL also drives playback.
  const playable = formats
    .filter(
      (f) =>
        f.url &&
        f.mimeType?.includes('video/mp4') &&
        (f.height ?? 0) <= 720,
    )
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (!playable?.url) throw new Error(`no direct-url mp4 format (${lastErr})`);

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

  // Return 200 with { error } for application errors. supabase-js otherwise
  // wraps any non-2xx response as a generic FunctionsHttpError that hides
  // the actual error message; this way the client's `data.error` check
  // surfaces the underlying cause directly.
  let inputUrl = '<unparsed>';
  try {
    const body = await req.json();
    inputUrl = typeof body?.url === 'string' ? body.url : '<missing>';
    if (typeof body?.url !== 'string' || body.url.length === 0) {
      return json({ error: 'url required' });
    }

    const host = new URL(body.url).hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
      const id = extractYouTubeId(body.url);
      if (!id) return json({ error: 'Invalid YouTube URL' });
      const result = await resolveYouTube(id);
      return json(result);
    }
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
      return json({ error: 'TikTok resolver not implemented (phase 2)' });
    }
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      return json({ error: 'Instagram resolver not implemented (phase 2)' });
    }
    return json({ error: `unsupported host: ${host}` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`resolve-reel error: url=${inputUrl} msg=${msg}`);
    return json({ error: msg });
  }
});
