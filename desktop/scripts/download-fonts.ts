// Download the open-source caption-font library (FONT_CATALOG) from the
// Google Fonts repo into desktop/resources/fonts/. Run from desktop/:
//   npx tsx scripts/download-fonts.ts
// Re-running skips fonts already on disk. Reports any 404s (bad path) so
// the catalog entry can be fixed.
import './_env';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { FONT_CATALOG, fontFile } from '../src/main/analyze/font-catalog';

const BASE = 'https://github.com/google/fonts/raw/main/';
const OUT = resolve(process.cwd(), 'resources/fonts');

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  let ok = 0;
  const failed: string[] = [];
  for (const f of FONT_CATALOG) {
    const dest = join(OUT, fontFile(f));
    if (existsSync(dest) && statSync(dest).size > 1000) {
      console.log(`  skip  ${f.id} (already downloaded)`);
      ok++;
      continue;
    }
    const url = BASE + f.github;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        console.log(`  FAIL  ${f.id}  HTTP ${res.status}  ${f.github}`);
        failed.push(f.id);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // A 404 HTML page is small; a real ttf is tens of KB and starts
      // with a known sfnt signature.
      const sig = buf.subarray(0, 4).toString('hex');
      const isTtf =
        sig === '00010000' || sig === '4f54544f' /* OTTO */ || sig === '74727565';
      if (!isTtf || buf.length < 5000) {
        console.log(
          `  FAIL  ${f.id}  not a ttf (sig=${sig}, ${buf.length}b)  ${f.github}`,
        );
        failed.push(f.id);
        continue;
      }
      writeFileSync(dest, buf);
      console.log(`  ok    ${f.id}  ${(buf.length / 1024).toFixed(0)}KB`);
      ok++;
    } catch (e) {
      console.log(`  ERR   ${f.id}  ${e instanceof Error ? e.message : String(e)}`);
      failed.push(f.id);
    }
  }
  console.log(`\n${ok}/${FONT_CATALOG.length} fonts in ${OUT}`);
  if (failed.length) console.log(`failed: ${failed.join(', ')}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
