// Dump the rendered HTML + classes of every anchor on DDG's lite SERP
// so we can see what selector to use for organic results.
import './_env';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { loadStealthPage } from '../src/main/curator/web-record';

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ').trim() || 'Vori grocery POS';
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=us-en`;
  console.log(`[ddg-debug] loading ${url}`);
  const loaded = await loadStealthPage(url);
  if (!loaded.ok) {
    console.error('[ddg-debug] load failed:', loaded.error);
    process.exit(2);
  }
  try {
    const html = await loaded.page.content();
    const outPath = resolve(process.cwd(), 'ddg-lite.html');
    writeFileSync(outPath, html);
    console.log(`[ddg-debug] HTML → ${outPath} (${html.length} chars)`);

    const summary = await loaded.page.evaluate(() => {
      // Count + sample anchors by class.
      const allAnchors = Array.from(document.querySelectorAll('a'));
      const byClass: Record<string, { count: number; samples: string[] }> = {};
      for (const a of allAnchors) {
        const cls = a.className || '(no-class)';
        if (!byClass[cls]) byClass[cls] = { count: 0, samples: [] };
        byClass[cls].count++;
        if (byClass[cls].samples.length < 3) {
          byClass[cls].samples.push(
            `${(a.textContent || '').trim().slice(0, 50)} → ${(a as HTMLAnchorElement).href.slice(0, 80)}`,
          );
        }
      }
      // Top-level layout: how many tables, trs, etc.
      const layout = {
        tables: document.querySelectorAll('table').length,
        trs: document.querySelectorAll('tr').length,
        a_total: allAnchors.length,
        forms: document.querySelectorAll('form').length,
        body_text_head: (document.body?.innerText || '').slice(0, 400),
      };
      return { byClass, layout };
    });

    console.log('[ddg-debug] layout:', JSON.stringify(summary.layout, null, 2));
    console.log('[ddg-debug] anchors by class:');
    for (const [cls, info] of Object.entries(summary.byClass)) {
      console.log(`  class="${cls}"  count=${info.count}`);
      for (const s of info.samples) console.log(`    ${s}`);
    }
  } finally {
    await loaded.cleanup();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[ddg-debug] failed:', err);
  process.exit(2);
});
