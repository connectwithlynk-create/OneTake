// One-time pass: decode every mp3 in resources/myinstants/audio/ via
// ffmpeg to 16 kHz mono Float32, compute the 26-d MFCC fingerprint
// (same HPF + MFCC pipeline as the runtime matcher), and write the
// vector back into resources/myinstants/index.json under each entry's
// `fingerprint` field. Resumable: entries that already have a
// `fingerprint` are skipped.
//
// Run from desktop/:
//   npx tsx scripts/fingerprint-myinstants.ts
//   npx tsx scripts/fingerprint-myinstants.ts --rebuild  # force re-compute all
//   npx tsx scripts/fingerprint-myinstants.ts --concurrency 8
import { execFile } from 'child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  computeFingerprint,
  extractLoudestRegion,
  FP_LIBRARY_WINDOW_MS,
  FP_SAMPLE_RATE,
  type LibraryIndex,
} from '../src/main/analyze/sfx-match';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const INDEX_PATH = 'resources/myinstants/index.json';
const AUDIO_DIR = 'resources/myinstants/audio';

interface Args {
  rebuild: boolean;
  concurrency: number;
}

function parseArgs(): Args {
  const args: Args = { rebuild: false, concurrency: 6 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rebuild') args.rebuild = true;
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
  }
  return args;
}

/** Decode an mp3 to 16 kHz mono float32 in [-1, 1] via ffmpeg. */
function decodeMp3(path: string): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        's16le',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        const buf = stdout as unknown as Buffer;
        if (err || !buf || buf.length === 0) return resolve(null);
        const out = new Float32Array(buf.length / 2);
        for (let i = 0; i < out.length; i++) {
          out[i] = buf.readInt16LE(i * 2) / 32768;
        }
        resolve(out);
      },
    );
  });
}

async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(INDEX_PATH)) {
    console.error(`index not found: ${INDEX_PATH}`);
    process.exit(1);
  }
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8')) as LibraryIndex;
  console.log(`index has ${index.entries.length} entries`);

  const toProcess = index.entries.filter((e) => {
    if (!existsSync(join(AUDIO_DIR, e.local_file))) return false;
    return args.rebuild || !e.fingerprint;
  });
  console.log(
    `processing ${toProcess.length} entries ` +
      `(${index.entries.length - toProcess.length} already fingerprinted or missing audio)`,
  );

  let ok = 0;
  let fail = 0;
  let savedAt = Date.now();

  await pool(toProcess, args.concurrency, async (entry, idx) => {
    const path = join(AUDIO_DIR, entry.local_file);
    const samples = await decodeMp3(path);
    if (!samples) {
      fail++;
      process.stdout.write('x');
      return;
    }
    // Library files often have leading silence + long tails; fingerprint
    // only the loudest FP_LIBRARY_WINDOW_MS so the summary reflects the
    // actual sound, not the padding.
    const region = extractLoudestRegion(
      samples,
      FP_SAMPLE_RATE,
      FP_LIBRARY_WINDOW_MS,
    );
    const fp = computeFingerprint(region);
    if (!fp) {
      fail++;
      process.stdout.write('s'); // too short
      return;
    }
    entry.fingerprint = fp;
    ok++;
    if (ok % 50 === 0) process.stdout.write('.');
    // Persist every ~10s so a Ctrl-C doesn't lose progress.
    if (Date.now() - savedAt > 10_000) {
      writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
      savedAt = Date.now();
    }
    void idx;
  });

  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
  console.log(
    `\ndone: ${ok} fingerprinted, ${fail} failed.\n` +
      `index now has ${index.entries.filter((e) => e.fingerprint).length} fingerprinted entries.`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
