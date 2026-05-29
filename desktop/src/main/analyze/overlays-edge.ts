// Persistent-edge overlay detection.
//
// Compositing physics: when an overlay (sticker / GIF / image / PiP /
// emoji) is rendered on top of the base video, the seam between the
// overlay and the base produces a sharp pixel-value discontinuity —
// an edge — that sits at the same canvas position across the frames
// of the shot. Natural scene edges (silhouettes, building outlines)
// move and change as the camera and subjects move. So the visual
// signature of "thing composited on top" is: hard edge that persists
// across the shot.
//
// Algorithm:
//   1. Per sample frame: grayscale → Sobel gradient magnitude.
//   2. Threshold each per-frame edge map → binary edge mask.
//   3. Per-pixel count: how many frames is this pixel a hard edge?
//      Require count ≥ PERSISTENCE_K_OF_N * n to flag persistent.
//      Loose enough to tolerate modest overlay motion (zoom, slide,
//      small drift) — strict per-pixel persistence breaks for those.
//   4. Morphological dilation bridges 1-2 pixel gaps in outlines.
//   5. Connected components → candidate bboxes.
//   6. Ring-fraction filter: real overlay outlines have most of their
//      mask pixels near the bbox boundary; solid blobs (false
//      positives from textured regions) have pixels spread throughout
//      the bbox.
//   7. Existing face / text exclusion, kind / motion classification,
//      thumb crop.
//
// All classical, no ML, no API.
import jpeg from 'jpeg-js';
import type { ExtractedFrame, ShotFrames } from './frame-extractor';
import type { Shot } from './scene-detect';
import {
  type FrameRegion,
  type MediaOverlay,
  type NormBBox,
  type OverlayKind,
  type OverlayMotion,
  type TextMoment,
} from './types';

// --- Tunables ---

/** Source frames are decoded at the resolution they were extracted at
 *  (default ~720 long edge). Sobel + persistence work at half-res to
 *  cut compute ~4×; overlay outlines survive the downsample. */
const WORK_DOWN = 2;

/** Sobel magnitude threshold for "this pixel is a hard edge." Range
 *  is 0-~1500 on raw 8-bit grayscale. Composited overlay outlines
 *  are typically >100; letterbox / UI band edges sit around 60-70.
 *  Higher = more permissive (more false positives slip through). */
const EDGE_THRESHOLD = 90;

/** Persistence requirement as a fraction of sample-frame count. With
 *  3 samples that's ceil(0.66*3) = 2 frames. With 5 samples that's
 *  ceil(0.66*5) = 4 frames. Loose enough to tolerate overlay zoom /
 *  slide / drift; strict enough that transient scene edges (a moving
 *  silhouette) don't accumulate. */
const PERSISTENCE_K_OF_N = 0.66;

/** Dilation kernel half-width (3 means 7×7 max filter). Bridges
 *  gaps in slightly broken outlines (anti-aliasing, JPEG noise,
 *  small motion blur on overlay boundary). */
const DILATE_RADIUS = 1;

/** Connected-component bbox size limits, fraction of frame area. */
const MIN_AREA_PCT = 0.003;
const MAX_AREA_PCT = 0.5;

/** Minimum bbox dimension in EACH axis as a fraction of the frame's
 *  smaller dimension. Kills line/sliver false positives whose area
 *  passes MIN_AREA_PCT because one axis is large — but which are
 *  clearly not overlay rectangles (letterbox edges, horizontal color
 *  bands, vertical screen borders). A real overlay has nontrivial
 *  size in both axes. */
const MIN_BBOX_DIM_PCT = 0.06;

/** Bbox aspect ratio (h/w) must be in this range. */
const ASPECT_MIN = 0.1;
const ASPECT_MAX = 10;

/** Ring-fraction floor: of the CC's mask pixels, what fraction sit
 *  within RING_THICKNESS of the bbox boundary. A clean outline → ~1.0;
 *  a solid blob → much lower. 0.55 admits outlines that have some
 *  interior fill (logos with internal detail) while rejecting fully
 *  solid CCs. */
const RING_THICKNESS = 3; // cells, in mask space
const MIN_RING_FRACTION = 0.55;

/** Inner-bbox temporal motion threshold (summed RGB max-min across
 *  sample frames inside the bbox, averaged). High = animated. Same
 *  semantic as the classical detector. */
const INNER_MOTION_THRESHOLD = 30;

/** Face / text exclusion (match classical / yolo detectors). */
const FACE_OVERLAP_DROP = 0.5;
const TEXT_OVERLAP_DROP = 0.5;
const TEXT_COVERAGE_DROP = 0.22;

/** Palette complexity proxy for kind classification. */
const PALETTE_QUANTIZE_SHIFT = 5;
const LOW_PALETTE_MAX = 48;

/** Emoji heuristic. */
const EMOJI_MAX_AREA_PCT = 0.04;
const EMOJI_ASPECT_TOL = 0.5;

/** Thumb. */
const THUMB_MAX_DIM = 128;
const THUMB_QUALITY = 75;

function regionForXY(x: number, y: number): FrameRegion {
  const row = y < 1 / 3 ? 'top' : y < 2 / 3 ? 'middle' : 'bottom';
  const col = x < 1 / 3 ? 'left' : x < 2 / 3 ? 'center' : 'right';
  return `${row}_${col}` as FrameRegion;
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

/** Block-average RGBA → grayscale Uint8Array at 1/WORK_DOWN resolution. */
function toGrayDown(frame: DecodedFrame): {
  gray: Uint8Array;
  w: number;
  h: number;
} {
  const w = Math.floor(frame.w / WORK_DOWN);
  const h = Math.floor(frame.h / WORK_DOWN);
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      const y0 = y * WORK_DOWN;
      const x0 = x * WORK_DOWN;
      for (let dy = 0; dy < WORK_DOWN; dy++) {
        const rowStart = ((y0 + dy) * frame.w + x0) * 4;
        for (let dx = 0; dx < WORK_DOWN; dx++) {
          const i = rowStart + dx * 4;
          sr += frame.rgba[i];
          sg += frame.rgba[i + 1];
          sb += frame.rgba[i + 2];
          n++;
        }
      }
      // ITU-R BT.601 luma weighting.
      gray[y * w + x] = Math.round(
        (0.299 * sr + 0.587 * sg + 0.114 * sb) / n,
      );
    }
  }
  return { gray, w, h };
}

/** Sobel gradient magnitude. Output[i] = sqrt(Gx² + Gy²) per pixel.
 *  Border pixels are zero (kernel needs 1-pixel padding). */
function sobel(gray: Uint8Array, w: number, h: number): Uint16Array {
  const out = new Uint16Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const r0 = (y - 1) * w;
    const r1 = y * w;
    const r2 = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      // Gx = (a02 + 2*a12 + a22) - (a00 + 2*a10 + a20)
      const gx =
        gray[r0 + x + 1] + 2 * gray[r1 + x + 1] + gray[r2 + x + 1] -
        (gray[r0 + x - 1] + 2 * gray[r1 + x - 1] + gray[r2 + x - 1]);
      // Gy = (a20 + 2*a21 + a22) - (a00 + 2*a01 + a02)
      const gy =
        gray[r2 + x - 1] + 2 * gray[r2 + x] + gray[r2 + x + 1] -
        (gray[r0 + x - 1] + 2 * gray[r0 + x] + gray[r0 + x + 1]);
      out[r1 + x] = Math.min(
        65535,
        Math.round(Math.sqrt(gx * gx + gy * gy)),
      );
    }
  }
  return out;
}

/** Per-pixel "edge in ≥ k frames" mask. Input is an aligned stack of
 *  Sobel magnitudes at the same WxH (all from the same shot, same
 *  scale). Threshold each frame to binary edge, sum across stack,
 *  threshold sum. */
function persistentEdgeMask(
  stack: Uint16Array[],
  w: number,
  h: number,
): Uint8Array {
  const n = stack.length;
  const k = Math.max(1, Math.ceil(PERSISTENCE_K_OF_N * n));
  const counts = new Uint8Array(w * h);
  for (const mag of stack) {
    for (let i = 0; i < counts.length; i++) {
      if (mag[i] >= EDGE_THRESHOLD) counts[i]++;
    }
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = counts[i] >= k ? 1 : 0;
  }
  return mask;
}

/** 3x3 max dilation (or larger if DILATE_RADIUS > 1). One pass; for
 *  small radii this is cheap and good enough to bridge tiny gaps in
 *  outlines without merging unrelated CCs. */
function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  if (DILATE_RADIUS <= 0) return mask;
  const out = new Uint8Array(w * h);
  const r = DILATE_RADIUS;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -r; dy <= r && !hit; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (mask[ny * w + nx]) {
            hit = 1;
            break;
          }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

interface MaskBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cells: number[]; // flat indices of pixels in the CC
}

/** 4-connected flood fill. Returns one MaskBox per connected
 *  component, with cell indices (so callers can compute ring
 *  fraction without re-walking the mask). */
function connectedComponents(
  mask: Uint8Array,
  w: number,
  h: number,
): MaskBox[] {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const out: MaskBox[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    const cells: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;
      cells.push(idx);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
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
    out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, cells });
  }
  return out;
}

/** Fraction of CC cells that sit within RING_THICKNESS of the bbox
 *  boundary. Real overlay outlines → ~1.0; solid blobs → low. */
function ringFraction(box: MaskBox, w: number): number {
  let near = 0;
  for (const idx of box.cells) {
    const x = idx % w;
    const y = (idx - x) / w;
    if (
      x < box.x0 + RING_THICKNESS ||
      x >= box.x1 - RING_THICKNESS ||
      y < box.y0 + RING_THICKNESS ||
      y >= box.y1 - RING_THICKNESS
    ) {
      near++;
    }
  }
  return near / Math.max(box.cells.length, 1);
}

/** Mean summed-RGB max-min inside a bbox across the sample frames. */
function innerMotion(decoded: DecodedFrame[], norm: NormBBox): number {
  if (decoded.length < 2) return 0;
  const { w, h } = decoded[0];
  const x0 = Math.max(0, Math.floor(norm.x * w));
  const y0 = Math.max(0, Math.floor(norm.y * h));
  const x1 = Math.min(w, Math.ceil((norm.x + norm.w) * w));
  const y1 = Math.min(h, Math.ceil((norm.y + norm.h) * h));
  if (x1 <= x0 || y1 <= y0) return 0;
  const STEP = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 16));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += STEP) {
    for (let x = x0; x < x1; x += STEP) {
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (let f = 0; f < decoded.length; f++) {
        const fr = decoded[f];
        if (fr.w !== w || fr.h !== h) continue;
        const i = (y * w + x) * 4;
        const r = fr.rgba[i];
        const g = fr.rgba[i + 1];
        const b = fr.rgba[i + 2];
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
        if (g < gMin) gMin = g;
        if (g > gMax) gMax = g;
        if (b < bMin) bMin = b;
        if (b > bMax) bMax = b;
      }
      sum += rMax - rMin + (gMax - gMin) + (bMax - bMin);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Distinct 3-bit-per-channel quantized colors inside a bbox. Low →
 *  flat-palette graphic; high → photographic. */
function paletteCount(frame: DecodedFrame, norm: NormBBox): number {
  const x0 = Math.max(0, Math.floor(norm.x * frame.w));
  const y0 = Math.max(0, Math.floor(norm.y * frame.h));
  const x1 = Math.min(frame.w, Math.ceil((norm.x + norm.w) * frame.w));
  const y1 = Math.min(frame.h, Math.ceil((norm.y + norm.h) * frame.h));
  if (x1 <= x0 || y1 <= y0) return 0;
  const seen = new Uint8Array(512);
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
  motion: number,
  palette: number,
): OverlayKind {
  const area = norm.w * norm.h;
  const aspect = norm.h / Math.max(norm.w, 1e-6);
  const animated = motion > INNER_MOTION_THRESHOLD;
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
  faceBbox: NormBBox | null;
  textMoments: TextMoment[];
}

export function detectOverlaysEdge(
  input: DetectOverlaysInput,
): MediaOverlay[] {
  const { shot, shotFrames, faceBbox, textMoments } = input;

  // Need ≥2 same-size decoded samples to compute persistence.
  const samples = shotFrames.samples.filter(
    (f): f is ExtractedFrame => f !== null,
  );
  if (samples.length < 2) return [];
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
  if (decoded.length < 2) return [];
  const repDecoded =
    (shotFrames.rep && decodeFrame(shotFrames.rep)) ?? decoded[0];

  // Sobel stack at working resolution.
  const grays = decoded.map((d) => toGrayDown(d));
  const workW = grays[0].w;
  const workH = grays[0].h;
  const sobelStack = grays.map((g) => sobel(g.gray, workW, workH));

  // Persistent-edge mask + dilation + connected components.
  const rawMask = persistentEdgeMask(sobelStack, workW, workH);
  const mask = dilate(rawMask, workW, workH);
  const boxes = connectedComponents(mask, workW, workH);

  const frameArea = baseW * baseH;
  const minCells = MIN_AREA_PCT * workW * workH;
  const maxCells = MAX_AREA_PCT * workW * workH;
  const minBboxCells = (MIN_AREA_PCT * workW * workH) / 4; // bbox can be ~4x CC for thin outlines

  const overlays: MediaOverlay[] = [];
  for (const box of boxes) {
    const bboxArea = (box.x1 - box.x0) * (box.y1 - box.y0);
    if (bboxArea < minBboxCells || bboxArea > maxCells) continue;
    // CC must have enough mass total — too few cells = noise.
    if (box.cells.length < minCells / 3) continue;

    const norm: NormBBox = {
      x: box.x0 / workW,
      y: box.y0 / workH,
      w: (box.x1 - box.x0) / workW,
      h: (box.y1 - box.y0) / workH,
    };
    const area = norm.w * norm.h;
    if (area < MIN_AREA_PCT || area > MAX_AREA_PCT) continue;
    const aspect = norm.h / Math.max(norm.w, 1e-6);
    if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) continue;
    if (norm.w * norm.h * frameArea < 1) continue;
    // Both axes must be sizeable in source-frame terms — kills line
    // and sliver CCs whose area passes only because the other axis
    // is large.
    if (norm.w < MIN_BBOX_DIM_PCT || norm.h < MIN_BBOX_DIM_PCT) continue;

    // Ring-fraction: real overlay outlines have most CC mass along the
    // boundary. Solid blobs (textured base content that produces
    // persistent edges throughout an area) get rejected.
    if (ringFraction(box, workW) < MIN_RING_FRACTION) continue;

    if (faceBbox && iouFrac(norm, faceBbox) > FACE_OVERLAP_DROP) continue;
    let collidesText = false;
    let textCoverage = 0;
    const candArea = Math.max(area, 1e-9);
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

    const motion = innerMotion(decoded, norm);
    const palette = paletteCount(repDecoded, norm);
    const kind = classifyKind(norm, motion, palette);

    overlays.push({
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      bbox: norm,
      region: regionForXY(norm.x + norm.w / 2, norm.y + norm.h / 2),
      kind,
      motion: motion > INNER_MOTION_THRESHOLD ? 'animated' : 'static',
      spoken_window: '',
      thumb_b64: cropThumb(repDecoded, norm),
    });
  }
  return overlays;
}
