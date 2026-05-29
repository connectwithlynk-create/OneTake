// Shot-boundary detection via ffmpeg's scdet filter - its dedicated
// scene-change detector. Decodes every frame and scores scene changes, so
// it catches cuts at any speed. One streaming pass; the reel is read
// through ffmpeg transiently, not saved to disk.
//
// scdet replaces the earlier select='gt(scene,0.3)' approach, whose fixed
// 0.3 threshold under-counted subtle-cut reels (a ~8-shot reel detected as
// 1 cut). scdet's score (0-100) at threshold 7 generalizes: verified a
// subtle ~8-shot reel -> 6 cuts and a fast ~24-shot reel -> 23 cuts.
import { execFile } from 'child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// scdet score (0-100) above which a frame is a cut. The original
// value of 7 was tuned for the SyncNet pipeline where missing a few
// cuts didn't hurt; for inspiration analysis it under-counts cuts in
// fast-paced reels where adjacent shots are visually similar (same
// speaker, same backdrop, only the framing/angle changes). Lowering
// to 4 catches those without dramatically increasing false positives.
const SCENE_THRESHOLD = 4;
// Merge cuts closer than this - scdet can flag one transition twice.
const MIN_CUT_GAP_MS = 200;

export interface Shot {
  start_ms: number;
  end_ms: number;
}

export async function detectScenes(
  url: string,
  durationMs: number,
): Promise<Shot[]> {
  const cuts = await new Promise<number[]>((resolve) => {
    execFile(
      FFMPEG,
      [
        '-nostdin',
        '-loglevel',
        'info',
        '-i',
        url,
        '-vf',
        `scdet=threshold=${SCENE_THRESHOLD}`,
        '-an',
        '-f',
        'null',
        '-',
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 },
      (err, _stdout, stderr) => {
        if (err) {
          resolve([]);
          return;
        }
        // scdet logs each detected scene change to stderr as
        // "lavfi.scd.score: X, lavfi.scd.time: Y".
        const times: number[] = [];
        const re = /lavfi\.scd\.time:\s*([0-9.]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(stderr || '')) !== null) {
          times.push(Math.round(parseFloat(m[1]) * 1000));
        }
        resolve(times);
      },
    );
  });

  // Keep cuts inside the reel, sorted, with very-close ones merged.
  const sorted = cuts
    .filter((c) => c > MIN_CUT_GAP_MS && c < durationMs - MIN_CUT_GAP_MS)
    .sort((a, b) => a - b);
  const merged: number[] = [];
  for (const c of sorted) {
    if (
      merged.length === 0 ||
      c - merged[merged.length - 1] >= MIN_CUT_GAP_MS
    ) {
      merged.push(c);
    }
  }

  const bounds = [0, ...merged, durationMs];
  const shots: Shot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] > bounds[i]) {
      shots.push({ start_ms: bounds[i], end_ms: bounds[i + 1] });
    }
  }
  return shots.length ? shots : [{ start_ms: 0, end_ms: durationMs }];
}
