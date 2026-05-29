// Standalone CLI for the reel thumbnail fetcher. Runs the same
// pipeline the Electron IPC handler runs, but prints every step's
// outcome to the terminal so we can diagnose why a particular reel
// has "no preview" in the UI.
//
// Run from desktop/:
//   npx tsx scripts/thumbnail-debug.ts <reel-url>
import './_env';
import { writeFileSync } from 'fs';
import { fetchReelThumbnail } from '../src/main/reel-thumbnail';

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: thumbnail-debug <reel-url>');
    process.exit(1);
  }
  console.log(`fetching thumbnail for: ${url}`);
  const t0 = Date.now();
  const result = await fetchReelThumbnail(url);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (!result) {
    console.log(`\nresult: null (see error logs above)  · ${elapsed}s`);
    process.exit(2);
  }
  // Write the data URL's binary to a tmp file so we can open it
  // visually to confirm the image is valid.
  const match = result.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    console.log(`\nresult: ${result.slice(0, 80)}…`);
    return;
  }
  const [, mime, b64] = match;
  const ext = mime.split('/')[1] ?? 'jpg';
  const out = `/tmp/thumbnail-debug.${ext}`;
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`\nresult: data:${mime} (${b64.length} chars base64)  · ${elapsed}s`);
  console.log(`saved decoded image → ${out}`);
  console.log(`open ${out}  # to verify visually`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
