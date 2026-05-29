import './_env';
import { readFileSync } from 'fs';
import type { Cookie } from 'playwright';
import { getStealthBrowser, closeStealthBrowser } from '../src/main/curator/web-record';

function loadCookies(file: string): Cookie[] {
  const out: Cookie[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [domain, , path, secure, expires, name, value] = f;
    const exp = parseInt(expires, 10);
    out.push({
      name, value, domain, path: path || '/',
      expires: Number.isFinite(exp) && exp > 0 ? exp : -1,
      httpOnly: false, secure: secure.toUpperCase() === 'TRUE', sameSite: 'Lax',
    } as Cookie);
  }
  return out;
}

(async () => {
  const browser = await getStealthBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const cookies = loadCookies(process.env.YTDLP_COOKIES_FILE!);
  console.log('injecting', cookies.length, 'cookies; sessionid present:', cookies.some(c => c.name === 'sessionid'));
  await ctx.addCookies(cookies);

  ctx.on('response', (r) => {
    const u = r.url();
    if (/\/(api\/v1|graphql)/.test(u)) {
      console.log('  API RESP', r.status(), r.headers()['content-type']?.slice(0, 30), u.slice(0, 110));
    }
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto('https://www.instagram.com/reel/DXz_iMJNjlV/', { waitUntil: 'domcontentloaded' }).catch((e) => console.log('goto err', e.message));
  await page.waitForTimeout(8000);

  console.log('--- final url:', page.url());
  console.log('--- title:', await page.title().catch(() => null));
  // logged in? look for a login form / "Log in" button text
  const bodyText = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 400);
  console.log('--- body head:', JSON.stringify(bodyText.replace(/\n+/g, ' ').slice(0, 200)));
  // video element
  const vinfo = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { src: v.getAttribute('src'), currentSrc: v.currentSrc } : null;
  }).catch(() => null);
  console.log('--- video el:', JSON.stringify(vinfo));
  // embedded JSON with video_versions / video_url?
  const embedded = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
    const all = scripts.map(s => s.textContent || '').join('');
    return {
      scriptCount: scripts.length,
      hasVideoVersions: all.includes('video_versions'),
      hasVideoUrl: all.includes('"video_url"'),
      hasXdtMedia: all.includes('xdt_'),
    };
  }).catch(() => null);
  console.log('--- embedded JSON:', JSON.stringify(embedded));

  await ctx.close().catch(() => {});
  await closeStealthBrowser().catch(() => {});
  process.exit(0);
})();
