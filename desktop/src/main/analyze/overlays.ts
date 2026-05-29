// Media-overlay detection: stickers, GIFs, images, PiP video, emoji
// graphics. Text captions are tracked separately (text_moments) and
// are NOT considered overlays here.
//
// Approach is classical CV, no inference:
//  1. For each shot, decode every available sample frame and stack them.
//  2. Per-pixel max-min over RGB across the stack → stable pixels
//     (overlays sit fixed on the canvas while the underlying video
//     changes).
//  3. Threshold + connected-components (on a downsampled mask) → bbox
//     candidates.
//  4. Filter by size / aspect / overlap with the face bbox and any
//     known text-caption moments.
//  5. For each survivor, look INSIDE the bbox across the same frame
//     stack: low inner motion → static (image/sticker); high inner
//     motion → animated (GIF / PiP video). A palette-complexity proxy
//     on the rep frame splits sticker-like from photographic content.
//  6. Crop the rep frame to the bbox and JPEG-encode for downstream
//     reasoning.
import jpeg from 'jpeg-js';
import type { ExtractedFrame, ShotFrames } from './frame-extractor';
import type { Shot } from './scene-detect';
import {
  type MediaOverlay,
  type NormBBox,
  type OverlayKind,
  type OverlayMotion,
  type TextMoment,
  type FrameRegion,
} from './types';

// --- Tunables (all conservative; tighten once we have eval data) ---

/** Downsample factor for the stability mask. 8 on a 720x1280 frame
 *  gives a 90x160 working grid — ~14 kpx — fast to scan repeatedly
 *  without losing overlay-sized regions (smallest detectable bbox at
 *  MIN_AREA_PCT=0.005 covers ~70 mask cells). */
const DOWN_SAMPLE = 8;

/** A pixel counts as "stable" across the shot when its summed RGB
 *  max-min over the frame stack is below this value (0-765). Higher =
 *  more permissive (more pixels flagged as overlay). */
const STABILITY_THRESHOLD = 16;

/** Per-channel pixel-value stddev inside the bbox (computed on the rep
 *  frame, averaged over R/G/B) must exceed this. Filters out the most
 *  common false positive: stable background patches (skin, wall, sky,
 *  studio backdrop) that are temporally stable but have no actual
 *  visual content inside them. Real overlays — stickers, GIFs, text,
 *  photos — virtually always have stddev > 25. Tune lower if real
 *  overlays start disappearing. */
const MIN_BBOX_STDDEV = 22;

/** Mean absolute neighbor-difference (Sobel-lite) inside the bbox,
 *  averaged over R/G/B, must exceed this. Stddev alone passes soft
 *  gradients like skin tones, blurred backgrounds, or out-of-focus
 *  body parts; this metric specifically requires sharp local
 *  transitions, which real overlays carry on their anti-aliased
 *  edges. Lower = more permissive. */
const MIN_BBOX_EDGE = 6;

/** Mean absolute pixel difference between each bbox-perimeter pixel
 *  and the pixel immediately OUTSIDE the bbox at the same position,
 *  averaged over R/G/B and the full perimeter ring. This is the
 *  single most discriminative signal for "composited rectangle pasted
 *  on top of the video": a real overlay has a visible rectangular
 *  outline → high transition along the entire boundary. A random
 *  stable patch (keyboard slice, t-shirt area, body part) has no
 *  boundary in the underlying pixels → near-zero. */
const MIN_BBOX_PERIMETER_EDGE = 14;

/** Connected-component area divided by its bounding-box area.
 *  Static overlays (images, stickers, emoji) → ~1.0 (whole rectangle
 *  is stable). Animated overlays (GIFs, PiP video) → ~0.15-0.4 (only
 *  the border ring is stable, interior animates). True noise blobs
 *  (irregular shapes from random stable patches) → also low, but the
 *  perimeter-edge gate is what separates those from real animated
 *  overlays. Set low here to admit both static and animated, let
 *  perimeter-edge do the real filtering. */
const MIN_RECTANGULARITY = 0.12;

/** Same metric, but measured inside an overlay's bbox to decide whether
 *  the overlay itself is moving. Above this → `animated`. */
const INNER_MOTION_THRESHOLD = 30;

/** Bbox area, as a fraction of frame area, must fall in this range
 *  to be reported. Below = noise; above = full-frame static background. */
const MIN_AREA_PCT = 0.005;
const MAX_AREA_PCT = 0.4;

/** Bbox aspect ratio (height/width) must be in this range — filters
 *  extreme slivers that are usually scanline artifacts. */
const ASPECT_MIN = 0.1;
const ASPECT_MAX = 10;

/** A candidate is dropped when its overlap with the face bbox exceeds
 *  this fraction of the candidate's area. */
const FACE_OVERLAP_DROP = 0.5;

/** Drop the candidate if it sits >this-fraction inside any single
 *  text line — i.e. the candidate IS a text fragment. */
const TEXT_OVERLAP_DROP = 0.5;

/** Drop the candidate if the SUM of text-line area inside it covers
 *  > this fraction of the candidate's area. Tesseract line bboxes are
 *  tight around the glyphs while the stable-mask candidate usually
 *  has some background padding, so a "text strip" candidate typically
 *  measures around 25-35% text-coverage, not 60%+. Set the floor low
 *  enough to catch those without dropping logos / PiP videos with a
 *  small bit of text inside them (typically ≤10% coverage). */
const TEXT_COVERAGE_DROP = 0.22;

/** Emoji-graphic heuristic: small + near-square + low palette. */
const EMOJI_MAX_AREA_PCT = 0.04;
const EMOJI_ASPECT_TOL = 0.5; // |h/w - 1| < this

/** Palette complexity proxy. We quantize each pixel to a 3-bit-per-channel
 *  cube (512 buckets), count how many distinct buckets the bbox uses.
 *  Below LOW_PALETTE_MAX → graphic (sticker/gif/emoji); above → image/video. */
const PALETTE_QUANTIZE_SHIFT = 5; // keep top 3 bits per channel
const LOW_PALETTE_MAX = 48;

/** JPEG thumbnail sizing for the cropped overlay. */
const THUMB_MAX_DIM = 128;
const THUMB_QUALITY = 75;

/** 3x3 grid cell a centroid sits in. Mirrors annotate.regionForXY but
 *  duplicated here so overlays.ts has no upward dep on annotate.ts. */
function regionForXY(x: number, y: number): FrameRegion {
  const row = y < 1 / 3 ? 'top' : y < 2 / 3 ? 'middle' : 'bottom';
  const col = x < 1 / 3 ? 'left' : x < 2 / 3 ? 'center' : 'right';
  return `${row}_${col}` as FrameRegion;
}

interface DecodedFrame {
  rgba: Uint8Array;
  w: number;
  h: number;
}

function decodeFrame(frame: ExtractedFrame): DecodedFrame | null {
  if (!frame.jpegBase64) return null;
  try {
    const dec = jpeg.decode(Buffer.from(frame.jpegBase64, 'base64'), {
      useTArray: true,
    }) as { width: number; height: number; data: Uint8Array };
    return { rgba: dec.data, w: dec.width, h: dec.height };
  } catch {
    return null;
  }
}

/** Per-pixel summed RGB max-min across a stack of same-size frames,
 *  downsampled to a coarse grid by averaging DOWN_SAMPLE×DOWN_SAMPLE
 *  blocks before differencing. Returns a Uint16Array of length
 *  (smallW * smallH). */
function stabilityField(
  frames: DecodedFrame[],
): { field: Uint16Array; smallW: number; smallH: number } {
  const { w, h } = frames[0];
  const smallW = Math.floor(w / DOWN_SAMPLE);
  const smallH = Math.floor(h / DOWN_SAMPLE);
  const stackAvg: Uint8Array[] = frames.map(() => new Uint8Array(smallW * smallH * 3));

  // Block-average each frame down to (smallW × smallH × RGB).
  for (let f = 0; f < frames.length; f++) {
    const { rgba } = frames[f];
    const out = stackAvg[f];
    for (let sy = 0; sy < smallH; sy++) {
      for (let sx = 0; sx < smallW; sx++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        const y0 = sy * DOWN_SAMPLE;
        const x0 = sx * DOWN_SAMPLE;
        for (let dy = 0; dy < DOWN_SAMPLE; dy++) {
          const rowStart = ((y0 + dy) * w + x0) * 4;
          for (let dx = 0; dx < DOWN_SAMPLE; dx++) {
            const i = rowStart + dx * 4;
            sr += rgba[i];
            sg += rgba[i + 1];
            sb += rgba[i + 2];
            n++;
          }
        }
        const j = (sy * smallW + sx) * 3;
        out[j] = sr / n;
        out[j + 1] = sg / n;
        out[j + 2] = sb / n;
      }
    }
  }

  // Per-cell summed-RGB max-min across the stack.
  const field = new Uint16Array(smallW * smallH);
  for (let p = 0; p < smallW * smallH; p++) {
    const base = p * 3;
    let rMin = 255;
    let rMax = 0;
    let gMin = 255;
    let gMax = 0;
    let bMin = 255;
    let bMax = 0;
    for (let f = 0; f < stackAvg.length; f++) {
      const r = stackAvg[f][base];
      const g = stackAvg[f][base + 1];
      const b = stackAvg[f][base + 2];
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }
    field[p] = rMax - rMin + (gMax - gMin) + (bMax - bMin);
  }
  return { field, smallW, smallH };
}

interface MaskBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

/** Iterative 4-connected flood-fill over a binary mask; returns one
 *  bounding box per connected component. Operates on the downsampled
 *  grid, so coordinates are in mask-cell units. */
function connectedComponents(
  mask: Uint8Array,
  w: number,
  h: number,
): MaskBox[] {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const boxes: MaskBox[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let area = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      area++;
      // 4-neighbours
      if (x > 0) {
        const n = idx - 1;
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (x + 1 < w) {
        const n = idx + 1;
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (y > 0) {
        const n = idx - w;
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (y + 1 < h) {
        const n = idx + w;
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    boxes.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, area });
  }
  return boxes;
}

function iouFrac(a: NormBBox, b: NormBBox): number {
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(a.x + a.w, b.x + b.w);
  const iy1 = Math.min(a.y + a.h, b.y + b.h);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const aArea = a.w * a.h;
  return aArea > 0 ? inter / aArea : 0;
}

/** Mean stability field value inside a bbox, computed on the same
 *  downsampled grid the field lives on. Used to decide animated vs
 *  static — high mean = pixels moved a lot during the shot. */
function meanFieldInBox(
  field: Uint16Array,
  smallW: number,
  smallH: number,
  norm: NormBBox,
): number {
  const x0 = Math.max(0, Math.floor(norm.x * smallW));
  const y0 = Math.max(0, Math.floor(norm.y * smallH));
  const x1 = Math.min(smallW, Math.ceil((norm.x + norm.w) * smallW));
  const y1 = Math.min(smallH, Math.ceil((norm.y + norm.h) * smallH));
  if (x1 <= x0 || y1 <= y0) return 0;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * smallW;
    for (let x = x0; x < x1; x++) {
      sum += field[row + x];
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Mean absolute RGB difference between each pixel on the bbox
 *  perimeter and the pixel immediately outside the bbox at the same
 *  position. High value = clear rectangular boundary in the underlying
 *  pixels = composited overlay. Low value = the bbox cuts through a
 *  continuous region (keyboard slice, body part, background patch).
 *  Edges of the frame are skipped since there's no "outside" pixel. */
function bboxPerimeterEdge(frame: DecodedFrame, norm: NormBBox): number {
  const x0 = Math.max(0, Math.floor(norm.x * frame.w));
  const y0 = Math.max(0, Math.floor(norm.y * frame.h));
  const x1 = Math.min(frame.w, Math.ceil((norm.x + norm.w) * frame.w));
  const y1 = Math.min(frame.h, Math.ceil((norm.y + norm.h) * frame.h));
  if (x1 - x0 < 3 || y1 - y0 < 3) return 0;

  let sum = 0;
  let n = 0;
  const accumulate = (insideIdx: number, outsideIdx: number): void => {
    sum +=
      Math.abs(frame.rgba[insideIdx] - frame.rgba[outsideIdx]) +
      Math.abs(frame.rgba[insideIdx + 1] - frame.rgba[outsideIdx + 1]) +
      Math.abs(frame.rgba[insideIdx + 2] - frame.rgba[outsideIdx + 2]);
    n += 3;
  };

  // Top + bottom rows.
  if (y0 > 0) {
    const insideY = y0;
    const outsideY = y0 - 1;
    for (let x = x0; x < x1; x++) {
      accumulate((insideY * frame.w + x) * 4, (outsideY * frame.w + x) * 4);
    }
  }
  if (y1 < frame.h) {
    const insideY = y1 - 1;
    const outsideY = y1;
    for (let x = x0; x < x1; x++) {
      accumulate((insideY * frame.w + x) * 4, (outsideY * frame.w + x) * 4);
    }
  }
  // Left + right columns (skip the corners already counted in top/bottom).
  if (x0 > 0) {
    const insideX = x0;
    const outsideX = x0 - 1;
    for (let y = y0 + 1; y < y1 - 1; y++) {
      accumulate((y * frame.w + insideX) * 4, (y * frame.w + outsideX) * 4);
    }
  }
  if (x1 < frame.w) {
    const insideX = x1 - 1;
    const outsideX = x1;
    for (let y = y0 + 1; y < y1 - 1; y++) {
      accumulate((y * frame.w + insideX) * 4, (y * frame.w + outsideX) * 4);
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Mean of per-channel pixel-value standard deviations inside a bbox.
 *  Cheap "is there anything visible in this region" measure: flat
 *  patches (skin, wall, single-color backdrop) have low stddev; real
 *  overlays with edges, text, or illustration have higher stddev. */
function bboxStdDev(frame: DecodedFrame, norm: NormBBox): number {
  const x0 = Math.max(0, Math.floor(norm.x * frame.w));
  const y0 = Math.max(0, Math.floor(norm.y * frame.h));
  const x1 = Math.min(frame.w, Math.ceil((norm.x + norm.w) * frame.w));
  const y1 = Math.min(frame.h, Math.ceil((norm.y + norm.h) * frame.h));
  if (x1 <= x0 || y1 <= y0) return 0;
  let n = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumR2 = 0;
  let sumG2 = 0;
  let sumB2 = 0;
  for (let y = y0; y < y1; y++) {
    const rowStart = (y * frame.w + x0) * 4;
    for (let x = 0; x < x1 - x0; x++) {
      const i = rowStart + x * 4;
      const r = frame.rgba[i];
      const g = frame.rgba[i + 1];
      const b = frame.rgba[i + 2];
      sumR += r;
      sumG += g;
      sumB += b;
      sumR2 += r * r;
      sumG2 += g * g;
      sumB2 += b * b;
      n++;
    }
  }
  if (n === 0) return 0;
  const varR = Math.max(0, sumR2 / n - (sumR / n) ** 2);
  const varG = Math.max(0, sumG2 / n - (sumG / n) ** 2);
  const varB = Math.max(0, sumB2 / n - (sumB / n) ** 2);
  return (Math.sqrt(varR) + Math.sqrt(varG) + Math.sqrt(varB)) / 3;
}

/** Mean absolute neighbor-difference inside a bbox (right + down
 *  pairs), averaged over R/G/B. Cheap edge-density proxy: flat regions
 *  ≈ 0; soft skin gradients ≈ 2-4; sharp sticker/text edges ≈ 10+.
 *  Discriminates "stable patch with visual content" from "stable patch
 *  with soft gradient" — the latter is the common false-positive after
 *  the stddev filter. */
function bboxEdgeDensity(frame: DecodedFrame, norm: NormBBox): number {
  const x0 = Math.max(0, Math.floor(norm.x * frame.w));
  const y0 = Math.max(0, Math.floor(norm.y * frame.h));
  const x1 = Math.min(frame.w, Math.ceil((norm.x + norm.w) * frame.w));
  const y1 = Math.min(frame.h, Math.ceil((norm.y + norm.h) * frame.h));
  if (x1 - x0 < 2 || y1 - y0 < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1 - 1; y++) {
    const rowStart = (y * frame.w + x0) * 4;
    const nextRow = ((y + 1) * frame.w + x0) * 4;
    for (let x = 0; x < x1 - x0 - 1; x++) {
      const i = rowStart + x * 4;
      const right = i + 4;
      const down = nextRow + x * 4;
      sum +=
        Math.abs(frame.rgba[i] - frame.rgba[right]) +
        Math.abs(frame.rgba[i + 1] - frame.rgba[right + 1]) +
        Math.abs(frame.rgba[i + 2] - frame.rgba[right + 2]) +
        Math.abs(frame.rgba[i] - frame.rgba[down]) +
        Math.abs(frame.rgba[i + 1] - frame.rgba[down + 1]) +
        Math.abs(frame.rgba[i + 2] - frame.rgba[down + 2]);
      n += 6;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Count distinct 3-bit-per-channel quantized colors inside a bbox of
 *  the given decoded frame. Proxy for "how graphic-like is this region":
 *  vector art / stickers / emoji use few palette buckets; photos and
 *  video frames use many. */
function paletteCount(frame: DecodedFrame, norm: NormBBox): number {
  const x0 = Math.max(0, Math.floor(norm.x * frame.w));
  const y0 = Math.max(0, Math.floor(norm.y * frame.h));
  const x1 = Math.min(frame.w, Math.ceil((norm.x + norm.w) * frame.w));
  const y1 = Math.min(frame.h, Math.ceil((norm.y + norm.h) * frame.h));
  if (x1 <= x0 || y1 <= y0) return 0;
  const seen = new Uint8Array(512); // 8 * 8 * 8 buckets
  let count = 0;
  for (let y = y0; y < y1; y++) {
    const rowStart = (y * frame.w + x0) * 4;
    for (let x = 0; x < x1 - x0; x++) {
      const i = rowStart + x * 4;
      const r = frame.rgba[i] >> PALETTE_QUANTIZE_SHIFT;
      const g = frame.rgba[i + 1] >> PALETTE_QUANTIZE_SHIFT;
      const b = frame.rgba[i + 2] >> PALETTE_QUANTIZE_SHIFT;
      const key = (r << 6) | (g << 3) | b;
      if (!seen[key]) {
        seen[key] = 1;
        count++;
      }
    }
  }
  return count;
}

function classifyKind(
  norm: NormBBox,
  innerMotion: number,
  palette: number,
): OverlayKind {
  const area = norm.w * norm.h;
  const aspect = norm.h / Math.max(norm.w, 1e-6);
  const animated = innerMotion > INNER_MOTION_THRESHOLD;
  const lowPalette = palette <= LOW_PALETTE_MAX;

  if (
    !animated &&
    lowPalette &&
    area <= EMOJI_MAX_AREA_PCT &&
    Math.abs(aspect - 1) < EMOJI_ASPECT_TOL
  ) {
    return 'emoji_graphic';
  }
  if (animated && !lowPalette) return 'pip_video';
  if (animated && lowPalette) return 'gif';
  if (!animated && lowPalette) return 'sticker';
  return 'image';
}

/** Crop the rep frame to the overlay bbox (pixel-space), downsize to
 *  THUMB_MAX_DIM on the long edge, and return a base64 JPEG. Returns
 *  null on any failure — best-effort, never throws. */
function cropThumb(frame: DecodedFrame, norm: NormBBox): string | null {
  const x0 = Math.max(0, Math.floor(norm.x * frame.w));
  const y0 = Math.max(0, Math.floor(norm.y * frame.h));
  const x1 = Math.min(frame.w, Math.ceil((norm.x + norm.w) * frame.w));
  const y1 = Math.min(frame.h, Math.ceil((norm.y + norm.h) * frame.h));
  const cropW = x1 - x0;
  const cropH = y1 - y0;
  if (cropW <= 0 || cropH <= 0) return null;

  const scale = Math.min(1, THUMB_MAX_DIM / Math.max(cropW, cropH));
  const outW = Math.max(1, Math.round(cropW * scale));
  const outH = Math.max(1, Math.round(cropH * scale));
  const out = Buffer.alloc(outW * outH * 4);

  // Nearest-neighbor resample. Quality-cheap; the thumb is for a vision
  // model's "what is this overlay" eyeball, not for display.
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(cropH - 1, Math.floor(y / scale));
    const srcRow = ((y0 + sy) * frame.w + x0) * 4;
    const dstRow = y * outW * 4;
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(cropW - 1, Math.floor(x / scale));
      const s = srcRow + sx * 4;
      const d = dstRow + x * 4;
      out[d] = frame.rgba[s];
      out[d + 1] = frame.rgba[s + 1];
      out[d + 2] = frame.rgba[s + 2];
      out[d + 3] = 255;
    }
  }

  try {
    const enc = jpeg.encode(
      { data: out, width: outW, height: outH },
      THUMB_QUALITY,
    );
    return Buffer.from(enc.data).toString('base64');
  } catch {
    return null;
  }
}

export interface DetectOverlaysInput {
  shot: Shot;
  shotFrames: ShotFrames;
  /** Face bbox on the rep frame, normalized 0-1. Null when none. Used
   *  to suppress face regions which are often "stable" in a static
   *  talking-head framing. */
  faceBbox: NormBBox | null;
  /** Already-detected text-caption moments for this shot. Used to
   *  suppress text-region candidates so we don't double-count captions
   *  as overlays. */
  textMoments: TextMoment[];
}

/** Detect media overlays in one shot. Returns [] when fewer than two
 *  decodable sample frames are available (the stability mask needs a
 *  stack), the shot has no rep frame, or no candidates survive
 *  filtering. Pure best-effort: any internal failure short-circuits to
 *  an empty result rather than aborting the pipeline. */
export function detectOverlays(input: DetectOverlaysInput): MediaOverlay[] {
  const { shot, shotFrames, faceBbox, textMoments } = input;
  const samples = shotFrames.samples.filter(
    (f): f is ExtractedFrame => f !== null,
  );
  if (samples.length < 2) return [];

  // All samples should share dimensions (same ffmpeg scale filter), but
  // verify before stacking — a mismatch would corrupt the field.
  const decoded: DecodedFrame[] = [];
  let baseW = 0;
  let baseH = 0;
  for (const s of samples) {
    const d = decodeFrame(s);
    if (!d) continue;
    if (decoded.length === 0) {
      baseW = d.w;
      baseH = d.h;
    } else if (d.w !== baseW || d.h !== baseH) {
      continue;
    }
    decoded.push(d);
  }
  if (decoded.length < 2 || baseW === 0 || baseH === 0) return [];

  // Use the rep frame for palette + thumb when available; fall back to
  // the first decoded sample.
  const repDecoded =
    (shotFrames.rep && decodeFrame(shotFrames.rep)) ?? decoded[0];

  const { field, smallW, smallH } = stabilityField(decoded);

  // Binary mask of stable cells.
  const mask = new Uint8Array(field.length);
  for (let i = 0; i < field.length; i++) {
    mask[i] = field[i] < STABILITY_THRESHOLD ? 1 : 0;
  }

  const boxes = connectedComponents(mask, smallW, smallH);
  const frameArea = baseW * baseH;
  const minAreaCells = MIN_AREA_PCT * smallW * smallH;
  const maxAreaCells = MAX_AREA_PCT * smallW * smallH;

  const overlays: MediaOverlay[] = [];
  for (const box of boxes) {
    if (box.area < minAreaCells || box.area > maxAreaCells) continue;
    const bboxCells = (box.x1 - box.x0) * (box.y1 - box.y0);
    // Rectangularity: real composited overlays are rectangles, so the
    // stable-pixel CC fills nearly its whole bounding box. Sparse blobs
    // (body parts, irregular background patches) fail this.
    if (box.area / Math.max(bboxCells, 1) < MIN_RECTANGULARITY) continue;

    const norm: NormBBox = {
      x: box.x0 / smallW,
      y: box.y0 / smallH,
      w: (box.x1 - box.x0) / smallW,
      h: (box.y1 - box.y0) / smallH,
    };
    const aspect = norm.h / Math.max(norm.w, 1e-6);
    if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) continue;
    if (norm.w * norm.h * frameArea < 1) continue;

    if (faceBbox && iouFrac(norm, faceBbox) > FACE_OVERLAP_DROP) continue;
    // Two text exclusions:
    //  1. Candidate is mostly inside a single text line → it's a
    //     text fragment.
    //  2. Total text-line area inside the candidate covers most of
    //     the candidate → it's a text-filled region (caption strip
    //     with multiple words that individually don't trip #1).
    // The second specifically handles cases where small text lines
    // each fit inside a larger candidate without any one of them
    // dominating. It tolerates "small bit of text inside a logo or
    // PiP video" because the coverage fraction stays low.
    let collidesText = false;
    let textCoverage = 0;
    const candArea = Math.max(norm.w * norm.h, 1e-9);
    for (const tm of textMoments) {
      if (iouFrac(norm, tm.bbox) > TEXT_OVERLAP_DROP) {
        collidesText = true;
        break;
      }
      const ix0 = Math.max(norm.x, tm.bbox.x);
      const iy0 = Math.max(norm.y, tm.bbox.y);
      const ix1 = Math.min(norm.x + norm.w, tm.bbox.x + tm.bbox.w);
      const iy1 = Math.min(norm.y + norm.h, tm.bbox.y + tm.bbox.h);
      if (ix1 > ix0 && iy1 > iy0) {
        textCoverage += (ix1 - ix0) * (iy1 - iy0);
      }
    }
    if (collidesText) continue;
    if (textCoverage / candArea > TEXT_COVERAGE_DROP) continue;

    // Perimeter-edge: the dominant signal for "this is a composited
    // rectangle pasted on the video." A real overlay has a visible
    // outline → strong pixel transition all the way around the bbox.
    // A random stable patch in continuous content (keyboard slice,
    // t-shirt area, background region) has no such transition.
    if (bboxPerimeterEdge(repDecoded, norm) < MIN_BBOX_PERIMETER_EDGE)
      continue;

    // Backup content checks — kill the residual cases the perimeter
    // test could miss (e.g., a stable bbox at the very edge of the
    // frame where one side has no outside pixel).
    if (bboxStdDev(repDecoded, norm) < MIN_BBOX_STDDEV) continue;
    if (bboxEdgeDensity(repDecoded, norm) < MIN_BBOX_EDGE) continue;

    const innerMotion = meanFieldInBox(field, smallW, smallH, norm);
    const motion: OverlayMotion =
      innerMotion > INNER_MOTION_THRESHOLD ? 'animated' : 'static';
    const palette = paletteCount(repDecoded, norm);
    const kind = classifyKind(norm, innerMotion, palette);

    const region = regionForXY(
      norm.x + norm.w / 2,
      norm.y + norm.h / 2,
    );

    overlays.push({
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      bbox: norm,
      region,
      kind,
      motion,
      // spoken_window filled in later by the orchestrator once the
      // reel-wide transcript is available.
      spoken_window: '',
      thumb_b64: cropThumb(repDecoded, norm),
    });
  }
  return overlays;
}
