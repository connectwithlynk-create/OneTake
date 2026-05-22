// Shot-boundary detection via ffmpeg's scene filter. ffmpeg decodes every
// frame of the reel and scores scene changes, so it catches cuts at any
// speed - unlike sampling dHashes every 500ms, which can't resolve a reel
// that cuts faster than the sample interval. One streaming pass; the reel
// is read through ffmpeg transiently, not saved to disk.
import { execFile } from 'child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// 0.3 is robust here (identical cuts at 0.2-0.3 on test reels). Higher =
// fewer, only-stronger cuts; lower = more sensitive.
const SCENE_THRESHOLD = 0.3;

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
        `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
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
        // showinfo logs each selected (scene-change) frame to stderr.
        const times: number[] = [];
        const re = /pts_time:([0-9.]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(stderr || '')) !== null) {
          times.push(Math.round(parseFloat(m[1]) * 1000));
        }
        resolve(times);
      },
    );
  });

  const inRange = cuts
    .filter((c) => c > 0 && c < durationMs)
    .sort((a, b) => a - b);
  const bounds = [0, ...inRange, durationMs];

  const shots: Shot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] > bounds[i]) {
      shots.push({ start_ms: bounds[i], end_ms: bounds[i + 1] });
    }
  }
  return shots.length ? shots : [{ start_ms: 0, end_ms: durationMs }];
}
