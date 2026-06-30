import { BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname, basename } from 'path';
import { writeFileSync, rmSync, renameSync } from 'node:fs';
import os from 'node:os';
import type { Writable } from 'node:stream';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// 9:16 vertical reel. The render window content is sized to this so a
// full-window capturePage already has the right aspect; ffmpeg scales to
// exactly these pixels regardless of the host display's scale factor.
export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;

export interface CaptureOptions {
  /** SuggestedEdit plan (passed verbatim to the render window). */
  plan: unknown;
  /** CurationResult or null. */
  curation: unknown;
  /** Renderer-loadable URL for the creator/narration video, or null. */
  targetVideoUrl: string | null;
  fps: number;
  /** Where the silent H.264 mp4 is written. */
  outPath: string;
  onProgress?: (doneFrames: number, totalFrames: number) => void;
  shouldAbort?: () => boolean;
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const SCALE_PAD =
  `scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:force_original_aspect_ratio=decrease,` +
  `pad=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`;

/** How many parallel render windows to spin up. Each window is a full renderer
 *  process decoding video, so it is GPU/RAM heavy — cap conservatively and
 *  leave cores for the main process and the ffmpeg encoders. Override with
 *  EXPORT_WINDOWS. */
function desiredWindowCount(totalFrames: number): number {
  const env = Number(process.env.EXPORT_WINDOWS);
  if (Number.isFinite(env) && env >= 1) {
    return Math.max(1, Math.min(Math.floor(env), totalFrames));
  }
  const cores = os.cpus()?.length ?? 4;
  const n = Math.max(2, Math.min(4, cores - 2));
  return Math.max(1, Math.min(n, totalFrames));
}

/** Split [0, totalFrames) into `n` contiguous, near-equal frame ranges. Each
 *  window renders its own slice; concatenated in order they reconstruct the
 *  full timeline. */
function partitionFrames(totalFrames: number, n: number): [number, number][] {
  const ranges: [number, number][] = [];
  const base = Math.floor(totalFrames / n);
  const extra = totalFrames % n;
  let start = 0;
  for (let k = 0; k < n; k++) {
    const len = base + (k < extra ? 1 : 0);
    ranges.push([start, start + len]);
    start += len;
  }
  return ranges;
}

async function waitForRenderReady(win: BrowserWindow): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (win.isDestroyed()) throw new Error('render window destroyed');
    const ready = await win.webContents
      .executeJavaScript('window.__exportReady === true')
      .catch(() => false);
    if (ready) return;
    await delay(50);
  }
  throw new Error('render window did not become ready in time');
}

/** Create a hidden render window, load the renderer in export mode, wait for
 *  the imperative bridge, and inject the job. */
async function createRenderWindow(job: unknown): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Critical: hidden windows otherwise throttle rAF/timers to a crawl,
      // which would stall the per-frame settle() in RenderStage.
      backgroundThrottling: false,
      offscreen: false,
    },
  });

  const renderUrl = process.env.ELECTRON_RENDERER_URL;
  if (renderUrl) {
    await win.loadURL(`${renderUrl}?render=1`);
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'), {
      search: 'render=1',
    });
  }
  await waitForRenderReady(win);
  await win.webContents.executeJavaScript(
    `window.__exportSetJob(${JSON.stringify(job)})`,
  );
  return win;
}

/** Write a buffer to a stream, respecting backpressure. */
function writeFrame(stream: Writable, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => {
      if (err) reject(err);
    });
    if (stream.writableNeedDrain) stream.once('drain', () => resolve());
    else resolve();
  });
}

/** Spawn an ffmpeg that reads JPEG frames from stdin and writes a segment mp4.
 *  Returns the child and a promise that settles on close. */
function spawnSegmentEncoder(
  fps: number,
  segPath: string,
): { ff: ChildProcess; done: Promise<void> } {
  const ff = spawn(
    FFMPEG,
    [
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(fps),
      '-i',
      '-',
      '-vf',
      SCALE_PAD,
      '-r',
      String(fps),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      segPath,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let ffErr = '';
  ff.stderr?.on('data', (d) => {
    ffErr += d.toString();
    if (ffErr.length > 8000) ffErr = ffErr.slice(-8000);
  });
  const done = new Promise<void>((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`ffmpeg(capture) exited ${code}: ${ffErr.slice(-2000)}`),
          ),
    );
  });
  return { ff, done };
}

/** Render frames [startFrame, endFrame) in one window, piping each JPEG into a
 *  dedicated ffmpeg that writes `segPath`. Self-cleans its encoder on error. */
async function captureRange(
  win: BrowserWindow,
  fps: number,
  startFrame: number,
  endFrame: number,
  segPath: string,
  onFrame: () => void,
  shouldAbort?: () => boolean,
): Promise<void> {
  const { ff, done } = spawnSegmentEncoder(fps, segPath);
  try {
    for (let i = startFrame; i < endFrame; i++) {
      if (shouldAbort?.()) throw new Error('export cancelled');
      if (win.isDestroyed()) {
        throw new Error('render window destroyed mid-export');
      }
      const T = (i * 1000) / fps;
      await win.webContents.executeJavaScript(`window.__exportRenderFrame(${T})`);
      const image = await win.webContents.capturePage();
      // JPEG q92 instead of PNG: ~10x smaller buffers and far cheaper to
      // encode per frame; visually lossless for reel content. ffmpeg
      // image2pipe auto-detects it.
      const jpg = image.toJPEG(92);
      if (!jpg.length) {
        throw new Error(`capturePage returned an empty frame at ${T}ms`);
      }
      await writeFrame(ff.stdin as Writable, jpg);
      onFrame();
    }
    (ff.stdin as Writable).end();
    await done;
  } catch (err) {
    try {
      ff.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await done.catch(() => {});
    throw err;
  }
}

/** Concatenate same-codec segment mp4s (stream copy, no re-encode) into
 *  outPath via the ffmpeg concat demuxer. */
async function concatSegments(
  segPaths: string[],
  outPath: string,
): Promise<void> {
  const listPath = `${outPath}.concat.txt`;
  const body = segPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(listPath, body);
  try {
    const ff = spawn(
      FFMPEG,
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        outPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let ffErr = '';
    ff.stderr?.on('data', (d) => {
      ffErr += d.toString();
      if (ffErr.length > 8000) ffErr = ffErr.slice(-8000);
    });
    await new Promise<void>((resolve, reject) => {
      ff.on('error', reject);
      ff.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(`ffmpeg(concat) exited ${code}: ${ffErr.slice(-2000)}`),
            ),
      );
    });
  } finally {
    rmSync(listPath, { force: true });
  }
}

/** Render the reel in a pool of hidden windows — each window encodes a
 *  contiguous slice of frames to its own segment mp4 in parallel, then the
 *  segments are concatenated into a single silent H.264 mp4 at outPath.
 *  Returns the frame count. */
export async function captureFrames(opts: CaptureOptions): Promise<number> {
  const { plan, curation, targetVideoUrl, fps, outPath } = opts;
  const job = { plan, curation, targetVideoUrl, fps };

  const windows: BrowserWindow[] = [];
  const segPaths: string[] = [];
  try {
    // First window also tells us the total duration -> frame count.
    const first = await createRenderWindow(job);
    windows.push(first);
    const totalMs: number = await first.webContents.executeJavaScript(
      'window.__exportTotalDurationMs()',
    );
    const totalFrames = Math.max(1, Math.ceil((totalMs * fps) / 1000));

    const n = desiredWindowCount(totalFrames);
    // Spin up the remaining windows concurrently (each loads the renderer +
    // decodes its own video copy).
    if (n > 1) {
      const rest = await Promise.all(
        Array.from({ length: n - 1 }, () => createRenderWindow(job)),
      );
      windows.push(...rest);
    }

    const ranges = partitionFrames(totalFrames, n);

    // Aggregate progress across all windows. Main-process JS is single
    // threaded, so the shared counter needs no locking.
    let done = 0;
    const onFrame = (): void => {
      done++;
      opts.onProgress?.(done, totalFrames);
    };

    const dir = dirname(outPath);
    const base = basename(outPath).replace(/\.[^.]+$/, '');

    await Promise.all(
      ranges.map((range, k) => {
        // A zero-length range can happen only if n was clamped wrong; skip it.
        if (range[0] >= range[1]) return Promise.resolve();
        const segPath = join(dir, `${base}.seg${k}.mp4`);
        segPaths.push(segPath);
        return captureRange(
          windows[k],
          fps,
          range[0],
          range[1],
          segPath,
          onFrame,
          opts.shouldAbort,
        );
      }),
    );

    if (segPaths.length === 1) {
      // Single segment — promote it to the output instead of re-muxing.
      renameSync(segPaths[0], outPath);
      segPaths.length = 0;
    } else {
      await concatSegments(segPaths, outPath);
    }
    return totalFrames;
  } finally {
    for (const w of windows) {
      if (!w.isDestroyed()) w.destroy();
    }
    for (const s of segPaths) {
      try {
        rmSync(s, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
