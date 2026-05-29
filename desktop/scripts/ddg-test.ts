// Smoke test for the DuckDuckGo search backend in tools.ts.
// Usage: npx tsx scripts/ddg-test.ts ["optional query"]
import './_env';
import { duckduckgoSearch } from '../src/main/curator/tools';

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ').trim() || 'Vori grocery POS';
  console.log(`[ddg-test] query: ${query}`);
  const t0 = Date.now();
  const resp = await duckduckgoSearch(query, 8);
  const dt = Date.now() - t0;
  console.log(`[ddg-test] took ${dt}ms`);
  console.log(
    `[ddg-test] blocked=${resp.blocked}${resp.block_reason ? ` (${resp.block_reason})` : ''}`,
  );
  console.log(`[ddg-test] ${resp.results.length} results`);
  for (let i = 0; i < resp.results.length; i++) {
    const r = resp.results[i];
    console.log(`  [${i}] ${r.title}`);
    console.log(`      url: ${r.url}`);
    if (r.snippet) console.log(`      snippet: ${r.snippet.slice(0, 120)}`);
  }
  // Force-exit so Playwright's shared browser doesn't hold the process open.
  process.exit(resp.blocked ? 1 : 0);
}

main().catch((err) => {
  console.error('[ddg-test] failed:', err);
  process.exit(2);
});
