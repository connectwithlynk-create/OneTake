// Diagnostic: isolate WHERE extractShotFrames hangs for a given reel.
// The analyzer prints "detected N shots" then goes silent before
// "extracted N of N rep frames" — i.e. it stalls inside extractShotFrames,
// which does (1) a concurrent ffmpeg seek-and-decode pool, then (2) a
// sequential tfjs-WASM face-detection pass. This script times each stage
// independently with a heartbeat so we can see which one blocks.
//
// Usage:
//   npx tsx scripts/frame-debug.ts <reel-url-or-playable-url>
//
// Pass a page URL (instagram/tiktok/youtube) to exercise the resolver, or
// a direct playable stream URL to skip resolving.
import './_env';
import { execFile } from 'child_process';
import { detectScenes } from '../src/main/analyze/scene-detect';
import { extractFrames } from '../src/main/analyze/frame-extractor';
import { detectFaceData } from '../src/main/analyze/face';
import { resolveReel } from '../src/main/resolver';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// Probe stream duration (ms); detectScenes needs it to bound cuts.
function probeDurationMs(url: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', url],
      { timeout: 30_000 },
      (err, stdout) => {
        const sec = parseFloat(String(stdout).trim());
        resolve(!err && Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0);
      },
    );
  });
}

// Heartbeat: print which stage we're in every 3s so a hang is visible
// live instead of looking like a frozen terminal.
let stage = 'init';
let stageStart = Date.now();
function setStage(s: string): void {
  stage = s;
  stageStart = Date.now();
  console.log(`\n>>> ${s}`);
}
const hb = setInterval(() => {
  console.log(`    [hb] still in "${stage}" for ${((Date.now() - stageStart) / 1000).toFixed(0)}s`);
}, 3000);
hb.unref?.();

// Raw single ffmpeg seek, mirroring frame-extractor's ffmpegFrame but
// with stderr surfaced and a tighter timeout so a stuck seek is obvious.
function rawFfmpeg(url: string, ms: number): Promise<{ ok: boolean; bytes: number; err?: string }> {
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      [
        '-nostdin', '-loglevel', 'error',
        '-ss', (ms / 1000).toFixed(3),
        '-i', url,
        '-frames:v', '1', '-an',
        '-vf', 'scale=720:720:force_original_aspect_ratio=decrease',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      (err, stdout, stderr) => {
        const buf = stdout as unknown as Buffer;
        resolve({
          ok: !err && !!buf && buf.length > 0,
          bytes: buf?.length ?? 0,
          err: err ? `${(err as Error).message} :: ${String(stderr).slice(0, 300)}` : undefined,
        });
      },
    );
  });
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: npx tsx scripts/frame-debug.ts <reel-url-or-playable-url>');
    process.exit(1);
  }

  // Resolve to a playable URL unless it already looks like a direct stream.
  let playable = arg;
  if (!/^https?:\/\/\S+\.(mp4|m3u8|webm)/i.test(arg)) {
    setStage('resolveReel');
    const r = await resolveReel(arg);
    if ('error' in r) {
      console.error('resolve failed:', r.error);
      process.exit(1);
    }
    playable = r.playable_url;
    console.log('    playable_url:', playable.slice(0, 120));
    console.log('    duration_ms:', r.duration_ms);
  }

  // Stage 1: scene detection (this is the last thing that logs today).
  setStage('probeDurationMs');
  const durationMs = await probeDurationMs(playable);
  console.log('    duration_ms:', durationMs);
  if (durationMs <= 0) {
    console.error('could not probe duration; stream may be expired/unreachable');
    clearInterval(hb);
    return;
  }
  setStage('detectScenes');
  const shots = await detectScenes(playable, durationMs);
  console.log(`    detected ${shots.length} shots`);
  if (shots.length === 0) {
    console.error('no shots; cannot continue');
    clearInterval(hb);
    return;
  }

  // Stage 2: ONE raw ffmpeg seek. If extractShotFrames hangs on ffmpeg
  // (slow/expired stream), this stalls here for up to 30s and reports the
  // ffmpeg error.
  const midMs = Math.round((shots[0].start_ms + shots[0].end_ms) / 2);
  setStage(`rawFfmpeg @ ${midMs}ms (single seek)`);
  const one = await rawFfmpeg(playable, midMs);
  console.log('    ffmpeg:', one.ok ? `ok, ${one.bytes} bytes` : `FAILED: ${one.err}`);

  // Stage 3: face detector init + inference in ISOLATION on a synthetic
  // gray frame — no ffmpeg involved. If this hangs, the stall is the
  // tfjs-WASM backend (the 25s init guard only covers createDetector, not
  // estimateFaces). This is the prime suspect inside an Electron
  // utilityProcess; running it here in plain Node tells us if it
  // reproduces outside Electron too.
  setStage('face detector init + estimateFaces (synthetic frame)');
  const W = 360, H = 640;
  const gray = new Uint8Array(W * H * 4).fill(128);
  const face = await detectFaceData(gray, W, H);
  console.log('    face pass returned:', face ? 'a face' : 'null (expected for gray)');

  // Stage 4: the real extractFrames on the first shot's sample timestamps
  // — the exact code path the analyzer uses (ffmpeg pool + sequential face
  // pass). If stages 2 and 3 passed but this hangs, the problem is in the
  // pool/interaction itself.
  setStage('extractFrames (first shot, 5 samples — real path)');
  const dur = shots[0].end_ms - shots[0].start_ms;
  const ts = [1, 2, 3, 4, 5].map((k) => Math.round(shots[0].start_ms + (dur * k) / 6));
  const frames = await extractFrames(playable, ts);
  console.log(`    extractFrames returned ${frames.filter(Boolean).length}/${ts.length} frames`);

  setStage('done');
  console.log('\nAll stages completed — the hang is NOT reproduced on this input/env.');
  clearInterval(hb);
}

main().catch((e) => {
  console.error('FATAL:', e);
  clearInterval(hb);
  process.exit(1);
});
