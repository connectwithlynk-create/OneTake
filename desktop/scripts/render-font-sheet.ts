// Render a labeled reference contact-sheet of the downloaded caption fonts
// to resources/fonts/reference-sheet.png. The caption detector sends this
// sheet to the vision model alongside the caption frames so it can MATCH
// the on-screen lettering to a real font id (closed set) instead of
// free-naming one. Run from desktop/ after download-fonts.ts:
//   npx tsx scripts/render-font-sheet.ts
import './_env';
import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { chromium } from 'playwright';
import { FONT_CATALOG, fontFile } from '../src/main/analyze/font-catalog';

const FONTS_DIR = resolve(process.cwd(), 'resources/fonts');
const OUT = join(FONTS_DIR, 'reference-sheet.png');

function buildHtml(): string {
  const present = FONT_CATALOG.filter((f) =>
    existsSync(join(FONTS_DIR, fontFile(f))),
  );

  // Inline each ttf as a base64 data URL. file:// font fetches are blocked
  // from a setContent (about:blank) origin, so embedding is the reliable
  // way to get the fonts to actually apply.
  const faces = present
    .map((f) => {
      const b64 = readFileSync(join(FONTS_DIR, fontFile(f))).toString('base64');
      return `@font-face{font-family:'${f.id}';src:url(data:font/ttf;base64,${b64}) format('truetype');font-weight:400 900;}`;
    })
    .join('\n');

  const cells = present
    .map(
      (f) => `
      <div class="cell">
        <div class="id">${f.id}</div>
        <div class="sample" style="font-family:'${f.id}'">PEOPLE Hamburg</div>
      </div>`,
    )
    .join('');

  // Caption-like: white bold text on dark, big, so glyph shapes are clear.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${faces}
    *{margin:0;box-sizing:border-box}
    body{background:#111;color:#fff;width:1200px;padding:24px;
      display:grid;grid-template-columns:repeat(2,1fr);gap:18px 28px;
      font-family:sans-serif}
    .cell{border:1px solid #333;border-radius:8px;padding:12px 16px}
    .id{font-size:14px;color:#8ad;letter-spacing:.04em;margin-bottom:6px;
      font-family:monospace}
    .sample{font-size:44px;font-weight:800;line-height:1.1;
      text-transform:none;white-space:nowrap}
  </style></head><body>${cells}</body></html>`;
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.setContent(buildHtml(), { waitUntil: 'load' });
    await page.evaluate(() => (document as Document & { fonts: FontFaceSet }).fonts.ready);
    await page.waitForTimeout(300);
    const body = page.locator('body');
    await body.screenshot({ path: OUT });
    console.log(`rendered ${FONT_CATALOG.length}-font reference sheet -> ${OUT}`);
  } finally {
    await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
