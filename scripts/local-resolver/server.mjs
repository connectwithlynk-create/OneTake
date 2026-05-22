// Dev-only local reel resolver.
//
// Why this exists: the `resolve-reel` Supabase Edge Function runs from a
// datacenter IP, which YouTube's InnerTube `player` endpoint bot-walls
// ("LOGIN_REQUIRED - sign in to confirm you're not a bot"). This service
// runs a stealth-patched headless Chrome on your machine (a residential
// IP), loads the real YouTube page so BotGuard runs in a trusted context,
// then reads the player response from inside that page. It returns the
// exact same JSON shape as the edge function so the app is none the wiser.
//
// Run:   cd scripts/local-resolver && npm install && node server.mjs
//        HEADFUL=1 node server.mjs   # show the browser (sign in once if
//                                      a challenge ever appears; the
//                                      .chrome-profile dir persists it)
//
// Point the app at it via EXPO_PUBLIC_LOCAL_RESOLVER_URL (see .env.example).

import http from 'node:http';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const PORT = Number(process.env.PORT ?? 8787);
const HEADFUL = Boolean(process.env.HEADFUL);
const PROFILE_DIR = new URL('./.chrome-profile', import.meta.url).pathname;

const YT_ID_RE = /(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/;

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: !HEADFUL,
      userDataDir: PROFILE_DIR,
      defaultViewport: { width: 412, height: 915, isMobile: true },
    });
  }
  return browserPromise;
}

// Loads the real YouTube watch page in a stealth browser, then extracts a
// direct-URL mp4 + media facts from inside the page context. Prefers the
// IOS InnerTube client (serves un-ciphered direct URLs); falls back to the
// web `ytInitialPlayerResponse` already on the page.
async function resolveYouTube(videoId) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page
      .waitForFunction(() => Boolean(window.ytInitialPlayerResponse), {
        timeout: 15000,
      })
      .catch(() => {});

    return await page.evaluate(async (vid) => {
      const webResp = window.ytInitialPlayerResponse || null;

      function visitorData() {
        try {
          return (window.ytcfg?.get?.('VISITOR_DATA')) || null;
        } catch {
          return null;
        }
      }

      // InnerTube IOS client: serves direct-URL mp4 formats (no
      // signatureCipher). Called same-origin from the trusted page.
      async function iosPlayer() {
        const vd = visitorData();
        const body = {
          context: {
            client: {
              clientName: 'IOS',
              clientVersion: '20.10.4',
              hl: 'en',
              gl: 'US',
              deviceMake: 'Apple',
              deviceModel: 'iPhone16,2',
              osName: 'iPhone',
              osVersion: '18.3.2.22D82',
              platform: 'MOBILE',
              ...(vd ? { visitorData: vd } : {}),
            },
          },
          videoId: vid,
          contentCheckOk: true,
          racyCheckOk: true,
        };
        try {
          const res = await fetch('/youtubei/v1/player?prettyPrint=false', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Youtube-Client-Name': '5',
              'X-Youtube-Client-Version': '20.10.4',
              ...(vd ? { 'X-Goog-Visitor-Id': vd } : {}),
            },
            body: JSON.stringify(body),
          });
          if (!res.ok) return null;
          return await res.json();
        } catch {
          return null;
        }
      }

      function pickFormat(data) {
        const sd = data?.streamingData;
        if (!sd) return null;
        const formats = [
          ...(sd.formats ?? []),
          ...(sd.adaptiveFormats ?? []),
        ];
        return (
          formats
            .filter(
              (f) =>
                f.url &&
                (f.mimeType ?? '').includes('video/mp4') &&
                (f.height ?? 0) <= 720,
            )
            .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0] || null
        );
      }

      async function captionText(data) {
        const tracks =
          data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!tracks?.length) return null;
        const en =
          tracks.find((t) => /^en/i.test(t.languageCode)) || tracks[0];
        try {
          const r = await fetch(`${en.baseUrl}&fmt=json3`);
          if (!r.ok) return null;
          const j = await r.json();
          const text = (j.events ?? [])
            .flatMap((e) =>
              (e.segs ?? []).map((s) => s.utf8 ?? '').filter(Boolean),
            )
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          return text.length ? text : null;
        } catch {
          return null;
        }
      }

      // Prefer whichever response yields a direct-URL mp4.
      let chosen = null;
      let data = null;
      if (webResp) {
        const f = pickFormat(webResp);
        if (f) {
          chosen = f;
          data = webResp;
        }
      }
      if (!chosen) {
        const ios = await iosPlayer();
        if (ios) {
          const f = pickFormat(ios);
          if (f) {
            chosen = f;
            data = ios;
          } else if (!data) {
            data = ios;
          }
        }
      }

      if (!chosen) {
        const ps = data?.playabilityStatus || webResp?.playabilityStatus;
        return {
          error: `unplayable: ${ps?.status ?? 'UNKNOWN'} - ${ps?.reason ?? 'no direct-url mp4 format'}`,
        };
      }

      const durSec = parseFloat(data.videoDetails?.lengthSeconds ?? '0');
      const expMatch = String(chosen.url).match(/[?&]expire=(\d+)/);

      return {
        platform: 'youtube',
        playable_url: chosen.url,
        playable_url_expires_at: expMatch
          ? parseInt(expMatch[1], 10) * 1000
          : null,
        duration_ms: Math.round(durSec * 1000),
        width: chosen.width ?? null,
        height: chosen.height ?? null,
        caption_text: await captionText(data),
      };
    }, videoId);
  } finally {
    await page.close();
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function send(res, status, body) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function resolve(url) {
  const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
    const m = url.match(YT_ID_RE);
    if (!m) return { error: 'Invalid YouTube URL' };
    return await resolveYouTube(m[1]);
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    return { error: 'TikTok resolver not implemented (phase 2)' };
  }
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
    return { error: 'Instagram resolver not implemented (phase 2)' };
  }
  return { error: `unsupported host: ${host}` };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'POST only' });
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', async () => {
    let inputUrl = '<unparsed>';
    try {
      const parsed = JSON.parse(body || '{}');
      inputUrl = typeof parsed.url === 'string' ? parsed.url : '<missing>';
      if (typeof parsed.url !== 'string' || parsed.url.length === 0) {
        send(res, 200, { error: 'url required' });
        return;
      }
      console.log(`resolve: ${inputUrl}`);
      const result = await resolve(parsed.url);
      console.log(
        result.error ? `  -> error: ${result.error}` : '  -> ok',
      );
      send(res, 200, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`resolve error: url=${inputUrl} msg=${msg}`);
      send(res, 200, { error: msg });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`local resolver listening on http://0.0.0.0:${PORT}`);
  console.log(`headless: ${!HEADFUL}  profile: ${PROFILE_DIR}`);
});
