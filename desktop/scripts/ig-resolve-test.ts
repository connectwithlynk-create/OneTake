// Standalone check for the browser-based Instagram resolver.
// Usage: npx tsx scripts/ig-resolve-test.ts <reel-url>
import './_env';
import { resolveInstagramViaBrowser } from '../src/main/instagram';
import { closeStealthBrowser } from '../src/main/curator/web-record';

const url =
  process.argv[2] || 'https://www.instagram.com/reel/DXz_iMJNjlV/';

(async () => {
  console.log('resolving', url);
  const t0 = Date.now();
  const res = await resolveInstagramViaBrowser(url);
  console.log('took', Date.now() - t0, 'ms');
  if ('error' in res) {
    console.error('FAILED:', res.error);
  } else {
    console.log('RESOLVED:', {
      platform: res.platform,
      dims: `${res.width}x${res.height}`,
      duration_ms: res.duration_ms,
      caption: res.caption_text?.slice(0, 60),
      url_head: res.playable_url.slice(0, 80) + '...',
      expires_at: res.playable_url_expires_at
        ? new Date(res.playable_url_expires_at).toISOString()
        : null,
    });
  }
  await closeStealthBrowser().catch(() => {});
  process.exit('error' in res ? 1 : 0);
})();
