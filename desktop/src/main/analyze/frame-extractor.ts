// Extracts a JPEG frame at each requested timestamp by seeking ffmpeg into
// the URL (-ss before -i = range request, not a full download). Each frame
// also gets face detection. Returns an array aligned 1:1 with the input
// timestamps - a failed timestamp is null, so callers keep their indexing.
import { execFile } from 'child_process';
import jpeg from 'jpeg-js';
import { detectFace } from './face';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const CONCURRENCY = 6;

export interface ExtractedFrame {
  jpegBase64: string;
  width: number;
  height: number;
  timestampMs: number;
  hasFace: boolean;
}

function ffmpegFrame(
  url: string,
  ms: number,
  maxDim: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-ss',
        (ms / 1000).toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-an',
        '-vf',
        `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease`,
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        const buf = stdout as unknown as Buffer;
        if (err || !buf || buf.length === 0) resolve(null);
        else resolve(buf);
      },
    );
  });
}

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Extract frames at the given timestamps (ms). Result is aligned 1:1 with
 * `timestampsMs`; a timestamp that fails to extract is `null`.
 */
export async function extractFrames(
  url: string,
  timestampsMs: number[],
  options?: { maxDimension?: number },
): Promise<(ExtractedFrame | null)[]> {
  if (!url || timestampsMs.length === 0) return [];
  const maxDim = options?.maxDimension ?? 720;

  const extracted = await pool(timestampsMs, CONCURRENCY, async (ms) => {
    const buf = await ffmpegFrame(url, ms, maxDim);
    if (!buf) return null;
    let decoded: { width: number; height: number; data: Uint8Array };
    try {
      decoded = jpeg.decode(buf, { useTArray: true }) as {
        width: number;
        height: number;
        data: Uint8Array;
      };
    } catch {
      return null;
    }
    const frame: ExtractedFrame = {
      jpegBase64: buf.toString('base64'),
      width: decoded.width,
      height: decoded.height,
      timestampMs: ms,
      hasFace: false,
    };
    return { frame, pixels: decoded.data };
  });

  // Face detection runs as a sequential pass - the tfjs WASM backend is
  // one shared context, not suited to the concurrent ffmpeg pool.
  for (const item of extracted) {
    if (item) {
      item.frame.hasFace = await detectFace(
        item.pixels,
        item.frame.width,
        item.frame.height,
      );
    }
  }

  return extracted.map((item) => (item ? item.frame : null));
}
