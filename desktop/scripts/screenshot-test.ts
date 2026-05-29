// Take a single full-page screenshot at the recording viewport so we
// can see what the page looks like WITHOUT scroll heuristics + record
// pipeline interference. Useful for diagnosing "recording looks weird"
// reports — if the static screenshot is broken too, the issue is the
// site/viewport; otherwise the scroll or transcode is at fault.
import './_env';
import { resolve } from 'path';
import { loadStealthPage, aspectToViewport } from '../src/main/curator/web-record';
import type { AspectRatio } from '../src/main/curator/web-record';

async function main(): Promise<void> {
  const url = process.argv[2] ?? 'https://www.vori.com/';
  const aspect = (process.argv[3] ?? '9:16') as AspectRatio;
  const viewport = aspectToViewport(aspect);
  console.log(`[shot] ${url}  viewport=${viewport.width}x${viewport.height} (${aspect})`);
  const loaded = await loadStealthPage(url, { viewport });
  if (!loaded.ok) {
    console.error('[shot] load failed:', loaded.error);
    process.exit(2);
  }
  try {
    const viewportPath = resolve(process.cwd(), 'shot-viewport.png');
    const fullPath = resolve(process.cwd(), 'shot-fullpage.png');
    await loaded.page.screenshot({ path: viewportPath, fullPage: false });
    await loaded.page.screenshot({ path: fullPath, fullPage: true });
    const docHeight = await loaded.page.evaluate(() =>
      Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ),
    );
    console.log(`[shot] doc_height: ${docHeight}px`);
    console.log(`[shot] viewport screenshot: ${viewportPath}`);
    console.log(`[shot] full-page screenshot: ${fullPath}`);
  } finally {
    await loaded.cleanup();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[shot] failed:', err);
  process.exit(2);
});
