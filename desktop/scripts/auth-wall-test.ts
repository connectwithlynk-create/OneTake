// Smoke test for the auth-wall / app-wall guards.
//
// Runs each URL through BOTH fetchPage (loadStealthPage path) AND
// recordUrl (plain Chromium path), printing what the wall detector
// caught.
//
// Usage:
//   npx tsx scripts/auth-wall-test.ts
//   npx tsx scripts/auth-wall-test.ts https://www.instagram.com/reel/<id>/
//
// Exit code is 0 if EVERY non-control URL was correctly rejected.
import './_env';
import { fetchPage, recordUrl } from '../src/main/curator/tools';

interface Target {
  url: string;
  shouldBlock: boolean;
  note: string;
}

const targets: Target[] = process.argv[2]
  ? [{ url: process.argv[2], shouldBlock: true, note: 'user-supplied URL' }]
  : [
      {
        url: 'https://www.instagram.com/reel/C7vQYxYJxsj/',
        shouldBlock: true,
        note: 'Instagram reel — app-wall (URL pattern)',
      },
      {
        url: 'https://www.tiktok.com/@vori/video/7250000000000000000',
        shouldBlock: true,
        note: 'TikTok video — app-wall (URL pattern)',
      },
      {
        url: 'https://www.facebook.com/watch/?v=000000000000000',
        shouldBlock: true,
        note: 'Facebook watch — app-wall (URL pattern)',
      },
      {
        url: 'https://vori.com',
        shouldBlock: false,
        note: 'CONTROL: Vori homepage — should NOT block',
      },
    ];

function summarize(label: string, val: unknown): string {
  if (val == null) return `${label}=<none>`;
  return `${label}=${String(val).slice(0, 100)}`;
}

async function main(): Promise<void> {
  console.log(`auth-wall-test: ${targets.length} URL(s)\n`);
  let allCorrect = true;
  for (const t of targets) {
    console.log(`\n— ${t.note}`);
    console.log(`  url: ${t.url}`);

    // (1) fetch_page path — uses loadStealthPage which checks both
    // URL patterns and body text.
    const fetched = await fetchPage(t.url, {
      expectedContent: 'Vori grocery',
    });
    if ('ok' in fetched && fetched.ok === false) {
      console.log(`  fetch_page → BLOCKED  ${summarize('error', fetched.error)}`);
    } else {
      console.log(
        `  fetch_page → loaded  title=${('title' in fetched ? fetched.title : null) ?? '<none>'}`,
      );
    }

    // (2) record_url path — plain Chromium, checks URL pattern at
    // page.goto and text pattern after settle.
    const recorded = await recordUrl(t.url, {
      durationMs: 6000,
      scroll: 'smooth',
      scrollSegments: [],
      expectedContent: 'Vori grocery',
    });
    if (!recorded.ok) {
      console.log(`  record_url → BLOCKED  ${summarize('error', recorded.error)}`);
    } else {
      console.log(
        `  record_url → RECORDED ${recorded.duration_ms}ms  ${recorded.recording_path}`,
      );
    }

    const blocked = !recorded.ok || ('ok' in fetched && fetched.ok === false);
    const correct = blocked === t.shouldBlock;
    console.log(`  expected_block=${t.shouldBlock}  actual_block=${blocked}  → ${correct ? 'PASS ✓' : 'FAIL ✗'}`);
    if (!correct) allCorrect = false;
  }

  console.log(`\n${allCorrect ? 'all checks passed ✓' : 'one or more checks failed ✗'}`);
  process.exit(allCorrect ? 0 : 1);
}

main().catch((err) => {
  console.error('auth-wall-test: threw', err);
  process.exit(2);
});
