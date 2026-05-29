// Smoke test for recordUrl with aspect_ratio + behavior args.
// Usage: npx tsx scripts/record-test.ts <url> [aspect] [behavior] [duration_seconds]
import './_env';
import { stat } from 'fs/promises';
import { recordUrl } from '../src/main/curator/tools';
import type { AspectRatio, Behavior } from '../src/main/curator/web-record';

async function main(): Promise<void> {
  const url = process.argv[2] ?? 'https://www.vori.com/';
  const aspect = (process.argv[3] ?? '16:9') as AspectRatio;
  const behavior = (process.argv[4] ?? 'static') as Behavior;
  const durationSec = Number(process.argv[5] ?? '6');
  console.log(`[record-test] ${url}`);
  console.log(`[record-test]   aspect=${aspect}  behavior=${behavior}  duration=${durationSec}s`);
  const t0 = Date.now();
  const result = await recordUrl(url, {
    durationMs: durationSec * 1000,
    aspect,
    behavior,
    scroll: 'smooth',
    expectedContent: 'Vori grocery',
  });
  const dt = Date.now() - t0;
  console.log(`[record-test] took ${dt}ms`);
  console.log(`[record-test] ok=${result.ok}`);
  if (!result.ok) {
    console.log(`[record-test] error: ${result.error}`);
    process.exit(1);
  }
  console.log(`[record-test] final_url: ${result.final_url}`);
  console.log(`[record-test] viewport: ${result.viewport_width}x${result.viewport_height}`);
  console.log(`[record-test] aspect_ratio: ${result.aspect_ratio}`);
  console.log(`[record-test] behavior: ${result.behavior}`);
  console.log(`[record-test] mp4: ${result.recording_path}`);
  try {
    const s = await stat(result.recording_path);
    console.log(`[record-test] mp4 size: ${(s.size / 1024).toFixed(1)} KB`);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[record-test] failed:', err);
  process.exit(2);
});
