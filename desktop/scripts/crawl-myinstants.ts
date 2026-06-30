// myinstants crawler — pulls SFX from listing pages and saves audio +
// metadata for the SFX-matching pipeline. Polite by default (delays
// between requests, single-threaded). Audio files are stored locally
// for fingerprinting; the index.json carries the source URL so we
// never have to redistribute the audio itself.
//
// Run from desktop/:
//   npx tsx scripts/crawl-myinstants.ts \
//     --start trending           # or category=memes / category=reactions / etc.
//     --pages 5                  # listing pages to walk
//     --delay 500                # ms between requests (be nice)
//     --out resources/myinstants # where audio + index land
//
// Categories observed on the site (use with --start category=<name>):
//   memes, reactions, sound effects, tiktok trends, viral, anime & manga,
//   games, movies, music, politics, pranks, sports, television, whatsapp audios
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BASE = 'https://www.myinstants.com';
// myinstants is Cloudflare-fronted and uses a cookie-based region redirect
// (/en/trending/ -> /en/index/us/), plus brotli/gzip bodies that node's
// undici fetch fails to decode (TransformError). curl with --compressed, -L
// and a sticky cookie jar handles all three; the crawler shells out to it.
const COOKIE_JAR = '/tmp/myinstants-crawl-cookies.txt';

interface Args {
  start: string;
  pages: number;
  delay: number;
  out: string;
}

function parseArgs(): Args {
  const args = {
    start: 'trending',
    pages: 3,
    delay: 500,
    out: 'resources/myinstants',
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') args.start = argv[++i];
    else if (a === '--pages') args.pages = Number(argv[++i]);
    else if (a === '--delay') args.delay = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

/** Build the listing URL for a given page. `start` is either "trending"
 *  or "category=<name>". */
function listingUrl(start: string, page: number): string {
  let path: string;
  if (start === 'trending') {
    path = '/en/trending/';
  } else if (start.startsWith('category=')) {
    const cat = start.slice('category='.length).trim();
    path = `/en/categories/${encodeURIComponent(cat)}/`;
  } else {
    // Pass-through: treat as raw path or already-encoded category.
    path = start.startsWith('/') ? start : `/en/${start}/`;
  }
  return `${BASE}${path}?page=${page}`;
}

interface Instant {
  slug: string;
  name: string;
  /** Original mp3 URL on myinstants. */
  source_mp3_url: string;
  /** Permalink to the instant's detail page. */
  source_page_url: string;
  /** Local filename under <out>/audio/. */
  local_file: string;
  /** Where this entry was discovered. */
  found_via: string;
}

function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Each instant on a listing page has:
 *    onclick="play('/media/sounds/<file>.mp3', 'loader-<id>', '<slug>')"
 *    title="Play <DISPLAY NAME> sound"
 *  That single attribute carries everything we need. */
function parseInstants(html: string, foundVia: string): Instant[] {
  const re =
    /onclick="play\('(\/media\/sounds\/[^']+\.mp3)', '[^']+', '([^']+)'\)"\s+title="Play\s+([^"]+?)\s+sound"/g;
  const out: Instant[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, mp3, slug, rawName] = m;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const name = htmlDecode(rawName);
    const audioFile = mp3.split('/').pop() || `${slug}.mp3`;
    out.push({
      slug,
      name,
      source_mp3_url: `${BASE}${mp3}`,
      source_page_url: `${BASE}/en/instant/${slug}/`,
      local_file: audioFile,
      found_via: foundVia,
    });
  }
  return out;
}

const CURL_BASE = ['-sSL', '--compressed', '-A', UA, '-b', COOKIE_JAR, '-c', COOKIE_JAR];

async function fetchText(url: string): Promise<string> {
  const { stdout } = await execFileAsync('curl', [...CURL_BASE, url], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function fetchAudio(url: string, dest: string): Promise<boolean> {
  try {
    await execFileAsync('curl', [...CURL_BASE, '-o', dest, url], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`  ! curl ${err instanceof Error ? err.message : err}`);
    return false;
  }
  if (!existsSync(dest) || statSync(dest).size === 0) {
    console.error(`  ! empty body for ${url}`);
    return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Index {
  source: string;
  crawled_at: string;
  entries: Instant[];
}

function loadOrInitIndex(path: string): Index {
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Index;
    } catch {
      // fall through and reinit
    }
  }
  return {
    source: 'myinstants.com',
    crawled_at: new Date().toISOString(),
    entries: [],
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const audioDir = join(args.out, 'audio');
  const indexPath = join(args.out, 'index.json');
  mkdirSync(audioDir, { recursive: true });

  const index = loadOrInitIndex(indexPath);
  const existingSlugs = new Set(index.entries.map((e) => e.slug));

  let pageInstants: Instant[] = [];
  let newCount = 0;
  let dlCount = 0;
  let skipCount = 0;

  for (let page = 1; page <= args.pages; page++) {
    const url = listingUrl(args.start, page);
    console.log(`\n[page ${page}/${args.pages}] ${url}`);
    let html: string;
    try {
      html = await fetchText(url);
    } catch (err) {
      console.error(`  ! ${err instanceof Error ? err.message : err}`);
      break;
    }
    pageInstants = parseInstants(html, args.start);
    if (pageInstants.length === 0) {
      console.log('  no instants found — pagination probably ended');
      break;
    }
    console.log(`  ${pageInstants.length} instants on page`);

    for (const inst of pageInstants) {
      if (existingSlugs.has(inst.slug)) {
        skipCount++;
        continue;
      }
      const dest = join(audioDir, inst.local_file);
      if (existsSync(dest)) {
        // File on disk but not in index — add to index, don't re-download.
        index.entries.push(inst);
        existingSlugs.add(inst.slug);
        newCount++;
        continue;
      }
      await sleep(args.delay);
      const ok = await fetchAudio(inst.source_mp3_url, dest);
      if (ok) {
        index.entries.push(inst);
        existingSlugs.add(inst.slug);
        dlCount++;
        newCount++;
        process.stdout.write('.');
      } else {
        process.stdout.write('x');
      }
    }
    process.stdout.write('\n');
    // Persist after each page so a Ctrl-C mid-crawl keeps progress.
    index.crawled_at = new Date().toISOString();
    writeFileSync(indexPath, JSON.stringify(index, null, 2));

    if (page < args.pages) await sleep(args.delay);
  }

  console.log(
    `\n=== done ===\n  index: ${indexPath}\n  audio: ${audioDir}\n` +
      `  new entries: ${newCount}\n  downloaded: ${dlCount}\n` +
      `  skipped (already indexed): ${skipCount}\n` +
      `  total in index: ${index.entries.length}`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
