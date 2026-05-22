// Per-shot face-crop extraction for Path A (Light-ASD). Extracts a 25fps
// window of frames, detects + lightly tracks the face, and produces the
// 112x112 grayscale crops the model's visual encoder expects (values
// 0-255; the model normalizes internally).
//
// The crop is framed off the eye + mouth keypoints (not the raw detector
// box) so it stays consistent regardless of box convention - mouth-centric
// with the face filling the frame, approximating Light-ASD's training crop.
import { execFile } from 'child_process';
import jpeg from 'jpeg-js';
import { detectFaceData, type FaceDetection } from './face';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FPS = 25;
const DIM = 112;
const OOB_FILL = 110; // pad crops with constant gray

export interface FaceCropSequence {
  /** numFrames * 112 * 112 grayscale floats, 0-255. */
  crops: Float32Array;
  numFrames: number;
  /** Fraction of frames where a face was actually detected (vs filled). */
  faceRatio: number;
}

interface Region {
  cx: number;
  cy: number;
  size: number;
}

// Extract a window of frames at 25fps as one MJPEG stream, split to JPEGs.
function extractWindowJpegs(
  url: string,
  startMs: number,
  durMs: number,
): Promise<Buffer[]> {
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      [
        '-nostdin', '-loglevel', 'error',
        '-ss', (startMs / 1000).toFixed(3),
        '-i', url,
        '-t', (durMs / 1000).toFixed(3),
        '-an',
        '-vf', `fps=${FPS}`,
        '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 60_000 },
      (err, stdout) => {
        const buf = stdout as unknown as Buffer;
        if (err || !buf || buf.length === 0) resolve([]);
        else resolve(splitMjpeg(buf));
      },
    );
  });
}

// Split a concatenated MJPEG stream on JPEG SOI (FFD8) / EOI (FFD9) markers.
function splitMjpeg(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length - 1) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
      let j = i + 2;
      while (j < buf.length - 1 && !(buf[j] === 0xff && buf[j + 1] === 0xd9)) {
        j++;
      }
      if (j >= buf.length - 1) break;
      out.push(buf.subarray(i, j + 2));
      i = j + 2;
    } else {
      i++;
    }
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function medianFilter(arr: number[], k: number): number[] {
  const r = k >> 1;
  return arr.map((_, i) =>
    median(arr.slice(Math.max(0, i - r), Math.min(arr.length, i + r + 1))),
  );
}

// Square crop region from a detection. Prefer eye+mouth keypoints (a
// stable, mouth-centric frame); fall back to the detector box.
function cropRegion(d: FaceDetection): Region {
  if (d.eyeMid && d.mouth) {
    const eyeMouth =
      Math.hypot(d.mouth.x - d.eyeMid.x, d.mouth.y - d.eyeMid.y) || 1;
    return {
      cx: (d.eyeMid.x + d.mouth.x) / 2,
      cy: d.mouth.y - 0.1 * eyeMouth,
      size: 2.3 * eyeMouth,
    };
  }
  const s = Math.max(d.box.w, d.box.h);
  return {
    cx: d.box.x + d.box.w / 2,
    cy: d.box.y + d.box.h / 2 + 0.1 * s,
    size: 1.1 * s,
  };
}

// Fill missing regions (hold nearest) and median-smooth the track.
function smoothRegions(regions: (Region | null)[]): Region[] | null {
  const n = regions.length;
  if (!regions.some((r) => r !== null)) return null;
  const filled: Region[] = new Array(n);
  let last: Region | null = null;
  for (let i = 0; i < n; i++) {
    if (regions[i]) last = regions[i];
    if (last) filled[i] = last;
  }
  let next: Region | null = null;
  for (let i = n - 1; i >= 0; i--) {
    if (regions[i]) next = regions[i];
    if (!filled[i] && next) filled[i] = next;
  }
  const cx = medianFilter(filled.map((r) => r.cx), 5);
  const cy = medianFilter(filled.map((r) => r.cy), 5);
  const size = medianFilter(filled.map((r) => r.size), 5);
  return filled.map((_, i) => ({ cx: cx[i], cy: cy[i], size: size[i] }));
}

// Bilinear-sample a 112x112 grayscale crop of the square region.
function cropTo112(
  rgba: Uint8Array,
  fw: number,
  fh: number,
  r: Region,
  out: Float32Array,
  offset: number,
): void {
  const top = r.cy - r.size / 2;
  const left = r.cx - r.size / 2;
  for (let oy = 0; oy < DIM; oy++) {
    const sy = top + ((oy + 0.5) / DIM) * r.size;
    const y0 = Math.floor(sy);
    const wy = sy - y0;
    for (let ox = 0; ox < DIM; ox++) {
      const sx = left + ((ox + 0.5) / DIM) * r.size;
      const x0 = Math.floor(sx);
      const wx = sx - x0;
      let g = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = x0 + dx;
          const py = y0 + dy;
          let v: number;
          if (px < 0 || py < 0 || px >= fw || py >= fh) {
            v = OOB_FILL;
          } else {
            const idx = (py * fw + px) * 4;
            v =
              0.299 * rgba[idx] +
              0.587 * rgba[idx + 1] +
              0.114 * rgba[idx + 2];
          }
          g += v * (dx ? wx : 1 - wx) * (dy ? wy : 1 - wy);
        }
      }
      out[offset + oy * DIM + ox] = g;
    }
  }
}

/**
 * Extract the 25fps 112x112 grayscale face-crop sequence for a shot's
 * time window. Empty crops (numFrames 0 or faceRatio 0) mean no usable
 * face - the caller should treat the shot as non-speaker.
 */
export async function extractFaceCrops(
  url: string,
  startMs: number,
  durMs: number,
): Promise<FaceCropSequence> {
  const jpegs = await extractWindowJpegs(url, startMs, durMs);
  if (jpegs.length === 0) {
    return { crops: new Float32Array(0), numFrames: 0, faceRatio: 0 };
  }

  const frames: { rgba: Uint8Array; w: number; h: number }[] = [];
  const regions: (Region | null)[] = [];
  for (const j of jpegs) {
    let dec: { width: number; height: number; data: Uint8Array };
    try {
      dec = jpeg.decode(j, { useTArray: true }) as {
        width: number;
        height: number;
        data: Uint8Array;
      };
    } catch {
      continue;
    }
    frames.push({ rgba: dec.data, w: dec.width, h: dec.height });
    const det = await detectFaceData(dec.data, dec.width, dec.height);
    regions.push(det ? cropRegion(det) : null);
  }

  const numFrames = frames.length;
  if (numFrames === 0) {
    return { crops: new Float32Array(0), numFrames: 0, faceRatio: 0 };
  }
  const detected = regions.filter((r) => r !== null).length;
  const smoothed = smoothRegions(regions);
  if (!smoothed) {
    return { crops: new Float32Array(0), numFrames, faceRatio: 0 };
  }

  const crops = new Float32Array(numFrames * DIM * DIM);
  for (let i = 0; i < numFrames; i++) {
    cropTo112(
      frames[i].rgba,
      frames[i].w,
      frames[i].h,
      smoothed[i],
      crops,
      i * DIM * DIM,
    );
  }
  return { crops, numFrames, faceRatio: detected / numFrames };
}
