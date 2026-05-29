// overlay-debug: run JUST the overlay-detection step on a single reel
// and dump every detected overlay's thumbnail to disk for visual
// verification. No SyncNet, no audio, no Whisper, no SFX — only the
// pieces detectOverlays() actually needs (scene cuts + sample frames +
// face bboxes for exclusion).
//
// Run from desktop/:
//   npx tsx scripts/overlay-debug.ts <reel-url-or-local-file>
//   npx tsx scripts/overlay-debug.ts ./path/to/clip.mp4
//
// Output: ./tmp/overlay-debug/<ts>/shot{i}-ov{j}-{kind}-{motion}.jpg
//         and a summary table to stdout. The thumbs are what the
//         detector thought was an overlay — eyeball them to see if it's
//         catching real media (stickers/GIFs/PiP/images) vs. tagging
//         stable background regions.
import './_env';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { extractShotFrames } from '../src/main/analyze/frame-extractor';
import { recognizeText } from '../src/main/analyze/ocr';
import { detectOverlays } from '../src/main/analyze/overlays';
import { detectOverlaysEdge } from '../src/main/analyze/overlays-edge';
import { detectOverlaysYolo } from '../src/main/analyze/overlays-yolo';
import { detectScenes } from '../src/main/analyze/scene-detect';
import { resolveReel } from '../src/main/resolver';
import type {
  FrameRegion,
  NormBBox,
  TextMoment,
} from '../src/main/analyze/types';

const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** Quick ffprobe duration in ms for a local file. Returns 0 on failure. */
function probeDuration(filePath: string): Promise<number> {
  return new Promise((res) => {
    execFile(
      FFPROBE,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          res(0);
          return;
        }
        const sec = parseFloat(String(stdout).trim());
        res(Number.isFinite(sec) ? Math.round(sec * 1000) : 0);
      },
    );
  });
}

interface ResolvedInput {
  playableUrl: string;
  durationMs: number;
  source: string;
}

async function resolveInput(arg: string): Promise<ResolvedInput | string> {
  // Treat http(s):// as a remote reel; everything else as a local file.
  if (/^https?:\/\//i.test(arg)) {
    const r = await resolveReel(arg);
    if ('error' in r) return r.error;
    return {
      playableUrl: r.playable_url,
      durationMs: r.duration_ms,
      source: arg,
    };
  }
  const absPath = resolvePath(arg);
  if (!existsSync(absPath)) return `local file not found: ${absPath}`;
  const durationMs = await probeDuration(absPath);
  if (durationMs <= 0) return `could not probe duration: ${absPath}`;
  return { playableUrl: absPath, durationMs, source: absPath };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      'usage: overlay-debug <reel-url | local-video-path> [--edge | --classical | --yolo] [--no-ocr] [--samples=N]\n\n' +
        'Runs scene-detect + frame extraction + overlay detection.\n' +
        'Default detector: --edge (persistent-edge across sample frames).\n' +
        '  --edge       persistent-edge classical detector (default)\n' +
        '  --classical  old stability-mask heuristic\n' +
        '  --yolo       YOLO-World ONNX (requires scripts/export-yolo-world.py first)\n' +
        '  --no-ocr     skip text-caption exclusion (faster, noisier)\n' +
        '  --samples=N  override sample frames per shot (default 3; bump to 5 for edge)\n' +
        'Dumps each detected overlay thumbnail to ./tmp/overlay-debug/<ts>/',
    );
    process.exit(1);
  }

  const t0 = Date.now();
  const resolved = await resolveInput(arg);
  if (typeof resolved === 'string') {
    console.error('resolve failed:', resolved);
    process.exit(2);
  }
  console.log(
    `\nsource: ${resolved.source}\n` +
      `duration: ${(resolved.durationMs / 1000).toFixed(1)}s\n`,
  );

  const shots = await detectScenes(resolved.playableUrl, resolved.durationMs);
  console.log(`scenes: ${shots.length} shots`);

  // Persistent-edge benefits from more sample frames; default 5 for
  // --edge runs, 3 for the others (matches existing extractor default).
  const detectorMode = process.argv.includes('--classical')
    ? 'classical'
    : process.argv.includes('--yolo')
      ? 'yolo'
      : 'edge';
  const samplesArg = process.argv.find((a) => a.startsWith('--samples='));
  const samplesPerShot = samplesArg
    ? Math.max(2, parseInt(samplesArg.split('=')[1], 10) || 3)
    : detectorMode === 'edge'
      ? 5
      : 3;
  console.log(`detector: ${detectorMode} (samples/shot=${samplesPerShot})`);

  const shotFrames = await extractShotFrames(resolved.playableUrl, shots, {
    samplesPerShot,
  });
  const sampleTotal = shotFrames.reduce(
    (n, sf) => n + sf.samples.filter((s) => s !== null).length,
    0,
  );
  console.log(`frames: ${sampleTotal} sample frames decoded`);

  // OCR each rep frame so text captions are excluded from overlay
  // detection — matches what annotate.ts does in production. tesseract
  // adds a few seconds of startup + ~200ms/frame; pass --no-ocr to
  // skip if you specifically want to see what the bare detector picks
  // up (which will include text captions).
  const useOcr = !process.argv.includes('--no-ocr');
  const ocrByShot: TextMoment[][] = new Array(shots.length).fill(null).map(() => []);
  if (useOcr) {
    let ocrFound = 0;
    let framesOcred = 0;
    for (let i = 0; i < shotFrames.length; i++) {
      // OCR every sample frame, not just rep — text often fades in or
      // out across the shot, and if it's missing from the rep frame
      // but present on another sample, the stability mask still picks
      // it up as an overlay candidate. Multi-frame OCR matches what
      // annotate.ts does in production.
      const samples = shotFrames[i].samples.filter(
        (s) => s !== null && s.jpegBase64 && s.width > 0 && s.height > 0,
      ) as Array<{ jpegBase64: string; width: number; height: number }>;
      let gotText = false;
      for (const f of samples) {
        const ocr = await recognizeText(f.jpegBase64);
        framesOcred++;
        for (const line of ocr.lines) {
          const bbox: NormBBox = {
            x: line.bbox.x / f.width,
            y: line.bbox.y / f.height,
            w: line.bbox.w / f.width,
            h: line.bbox.h / f.height,
          };
          const cx = bbox.x + bbox.w / 2;
          const cy = bbox.y + bbox.h / 2;
          const row = cy < 1 / 3 ? 'top' : cy < 2 / 3 ? 'middle' : 'bottom';
          const col = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'center' : 'right';
          const region = `${row}_${col}` as FrameRegion;
          ocrByShot[i].push({ text: line.text, bbox, region });
          gotText = true;
        }
      }
      if (gotText) ocrFound++;
    }
    console.log(
      `ocr:    ${framesOcred} frames OCR'd; ${ocrFound} shots had text captions (excluded)`,
    );
  } else {
    console.log('ocr:    skipped (--no-ocr); text captions may show up as overlays');
  }

  const outDir = join(
    process.cwd(),
    'tmp',
    'overlay-debug',
    String(Date.now()),
  );
  mkdirSync(outDir, { recursive: true });

  let total = 0;
  console.log('\nshot   ms-range          n  overlays');
  console.log('-----------------------------------------------------------');
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i];
    const sf = shotFrames[i];
    const faceBbox: NormBBox | null =
      sf.rep?.face && sf.rep.width > 0 && sf.rep.height > 0
        ? {
            x: sf.rep.face.box.x / sf.rep.width,
            y: sf.rep.face.box.y / sf.rep.height,
            w: sf.rep.face.box.w / sf.rep.width,
            h: sf.rep.face.box.h / sf.rep.height,
          }
        : null;
    const detectInput = {
      shot: sh,
      shotFrames: sf,
      faceBbox,
      textMoments: ocrByShot[i],
    };
    const overlays =
      detectorMode === 'classical'
        ? detectOverlays(detectInput)
        : detectorMode === 'yolo'
          ? await detectOverlaysYolo(detectInput)
          : detectOverlaysEdge(detectInput);
    total += overlays.length;

    const range = `${String(sh.start_ms).padStart(5)}-${String(sh.end_ms).padEnd(5)}`;
    const summary =
      overlays.length === 0
        ? '-'
        : overlays
            .map((o) => `${o.kind}/${o.motion}@${o.region}`)
            .join('  ');
    console.log(
      `${String(i).padStart(3)}    ${range}  ${String(overlays.length).padStart(2)}  ${summary}`,
    );

    for (let j = 0; j < overlays.length; j++) {
      const o = overlays[j];
      if (!o.thumb_b64) continue;
      const fname = `shot${String(i).padStart(2, '0')}-ov${j}-${o.kind}-${o.motion}.jpg`;
      writeFileSync(join(outDir, fname), Buffer.from(o.thumb_b64, 'base64'));
    }
  }

  console.log(
    `\ntotal: ${total} overlays across ${shots.length} shots ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log(`thumbs: ${outDir}`);
  if (total > 0) {
    console.log(`open the dir to eyeball:  open "${outDir}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
