// Open-vocabulary overlay detection via YOLO-World (Ultralytics).
//
// YOLO-World is a YOLOv8 variant trained for open-vocabulary object
// detection. `scripts/export-yolo-world.py` bakes a concrete class list
// (sticker, gif, screenshot, picture in picture, emoji) into the model
// and exports it to ONNX as a standard YOLO detector. At inference time
// we run it as any YOLOv8 model: resize+normalize input → forward →
// decode anchors → per-class threshold → NMS.
//
// Replaces the classical detector in overlays.ts when this spike is
// promoted. Same DetectOverlaysInput signature, async because ONNX
// inference is. Auxiliary motion classification + thumb cropping reuse
// the same approach as the classical detector (per-pixel temporal
// variance inside the bbox across sample frames for motion; pixel-crop
// + JPEG encode for thumb).
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import * as ort from 'onnxruntime-web';
import { initOrt } from './ort-init';
import jpeg from 'jpeg-js';
import type { ExtractedFrame, ShotFrames } from './frame-extractor';
import type { Shot } from './scene-detect';
import {
  type MediaOverlay,
  type NormBBox,
  type OverlayKind,
  type OverlayMotion,
  type FrameRegion,
  type TextMoment,
} from './types';

const MODEL_FILENAME = 'yolo-world-overlays.onnx';

/** YOLOv8 default input resolution. */
const INPUT_DIM = 640;

/** Per-prompt confidence cutoff. YOLO-World tends to over-fire on
 *  generic prompts; raising this is the cheapest precision lever. */
const CONFIDENCE_THRESHOLD = 0.25;

/** IoU threshold for non-max suppression across classes. */
const NMS_IOU = 0.45;

/** Bbox size sanity gates (fraction of frame area). */
const MIN_AREA_PCT = 0.002;
const MAX_AREA_PCT = 0.5;

/** Drop the candidate when overlap with the face bbox exceeds this
 *  fraction of the candidate's area. */
const FACE_OVERLAP_DROP = 0.5;

/** Text-line containment thresholds, matching the classical detector. */
const TEXT_OVERLAP_DROP = 0.5;
const TEXT_COVERAGE_DROP = 0.22;

/** Inner-bbox motion threshold used to flip animated vs static. Same
 *  semantic as the classical detector — summed RGB max-min over the
 *  sample-frame stack inside the bbox; above this = animated. */
const INNER_MOTION_THRESHOLD = 30;

/** JPEG thumb sizing. */
const THUMB_MAX_DIM = 128;
const THUMB_QUALITY = 75;

/** Class index → MediaOverlay kind. Mirrors the order in
 *  scripts/export-yolo-world.py. */
const CLASS_TO_KIND: OverlayKind[] = [
  'sticker',
  'gif',
  'image',
  'pip_video',
  'emoji_graphic',
];

function resolveModelDir(): string {
  const candidates = [
    process.env.SYNCNET_MODEL_DIR,
    resolve(process.cwd(), 'resources/models'),
    join(__dirname, '../../resources/models'),
    join(__dirname, '../../../resources/models'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(join(c, MODEL_FILENAME))) return c;
  }
  return candidates[candidates.length - 1];
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      initOrt();
      const path = join(resolveModelDir(), MODEL_FILENAME);
      if (!existsSync(path)) {
        throw new Error(
          `YOLO-World ONNX not found at ${path}.\n` +
            `Run from desktop/: pip install ultralytics && ` +
            `python scripts/export-yolo-world.py`,
        );
      }
      const session = await ort.InferenceSession.create(path);
      console.error('[overlays-yolo] session ready');
      return session;
    })();
  }
  return sessionPromise;
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

function iouSym(a: NormBBox, b: NormBBox): number {
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(a.x + a.w, b.x + b.w);
  const iy1 = Math.min(a.y + a.h, b.y + b.h);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Letterbox resize: scale the frame to fit inside INPUT_DIM × INPUT_DIM
 *  preserving aspect ratio, padding the rest with gray (114). Returns
 *  the [3, INPUT_DIM, INPUT_DIM] CHW float tensor and the geometry
 *  needed to map predictions back to source-frame coords. */
function letterboxToTensor(frame: DecodedFrame): {
  tensor: Float32Array;
  scale: number;
  padX: number;
  padY: number;
} {
  const scale = Math.min(INPUT_DIM / frame.w, INPUT_DIM / frame.h);
  const resizedW = Math.round(frame.w * scale);
  const resizedH = Math.round(frame.h * scale);
  const padX = Math.floor((INPUT_DIM - resizedW) / 2);
  const padY = Math.floor((INPUT_DIM - resizedH) / 2);

  const plane = INPUT_DIM * INPUT_DIM;
  const tensor = new Float32Array(3 * plane);
  // Pre-fill with gray (114/255) — matches Ultralytics default.
  tensor.fill(114 / 255);

  // Nearest-neighbor resample directly into the CHW tensor.
  for (let y = 0; y < resizedH; y++) {
    const srcY = Math.min(frame.h - 1, Math.floor(y / scale));
    for (let x = 0; x < resizedW; x++) {
      const srcX = Math.min(frame.w - 1, Math.floor(x / scale));
      const srcIdx = (srcY * frame.w + srcX) * 4;
      const dstX = padX + x;
      const dstY = padY + y;
      const dstIdx = dstY * INPUT_DIM + dstX;
      tensor[dstIdx] = frame.rgba[srcIdx] / 255;
      tensor[plane + dstIdx] = frame.rgba[srcIdx + 1] / 255;
      tensor[2 * plane + dstIdx] = frame.rgba[srcIdx + 2] / 255;
    }
  }

  return { tensor, scale, padX, padY };
}

interface RawDetection {
  bbox: NormBBox;
  classIdx: number;
  score: number;
}

/** Decode YOLOv8 output (xywh in input-image pixels + per-class
 *  scores) into normalized-bbox candidates in source-frame coords.
 *  Output shape: [1, 4+nClasses, nAnchors]. */
function decodeYoloOutput(
  output: ort.Tensor,
  scale: number,
  padX: number,
  padY: number,
  srcW: number,
  srcH: number,
  numClasses: number,
): RawDetection[] {
  const data = output.data as Float32Array;
  const dims = output.dims;
  if (dims.length !== 3 || dims[0] !== 1) {
    throw new Error(`unexpected YOLO output shape ${dims.join('x')}`);
  }
  const channels = dims[1];
  const anchors = dims[2];
  if (channels !== 4 + numClasses) {
    throw new Error(
      `output channels ${channels} ≠ 4 + ${numClasses} expected classes`,
    );
  }

  const dets: RawDetection[] = [];
  for (let i = 0; i < anchors; i++) {
    // Output is channel-major: data[c * anchors + i].
    let bestScore = 0;
    let bestClass = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * anchors + i];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < CONFIDENCE_THRESHOLD) continue;

    // bbox cx,cy,w,h in input-image pixel space.
    const cx = data[0 * anchors + i];
    const cy = data[1 * anchors + i];
    const bw = data[2 * anchors + i];
    const bh = data[3 * anchors + i];

    // Undo letterbox: subtract pad then divide by scale → source pixels.
    const srcCx = (cx - padX) / scale;
    const srcCy = (cy - padY) / scale;
    const srcW2 = bw / scale;
    const srcH2 = bh / scale;
    const x0 = (srcCx - srcW2 / 2) / srcW;
    const y0 = (srcCy - srcH2 / 2) / srcH;
    const w = srcW2 / srcW;
    const h = srcH2 / srcH;
    if (w <= 0 || h <= 0) continue;
    dets.push({
      bbox: { x: x0, y: y0, w, h },
      classIdx: bestClass,
      score: bestScore,
    });
  }
  return dets;
}

/** Class-aware non-max suppression. Sorts by score, suppresses any box
 *  with IoU > threshold against a higher-scoring box of the same class. */
function nms(dets: RawDetection[], iouThreshold: number): RawDetection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept: RawDetection[] = [];
  for (const d of sorted) {
    let suppressed = false;
    for (const k of kept) {
      if (k.classIdx === d.classIdx && iouSym(k.bbox, d.bbox) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(d);
  }
  return kept;
}

/** Mean summed-RGB max-min inside a bbox across the shot's sample
 *  frames. High = pixels moved during the shot (animated overlay);
 *  low = static. Mirrors the classical detector's motion classifier. */
function innerMotion(
  decoded: DecodedFrame[],
  norm: NormBBox,
): number {
  if (decoded.length < 2) return 0;
  const { w, h } = decoded[0];
  const x0 = Math.max(0, Math.floor(norm.x * w));
  const y0 = Math.max(0, Math.floor(norm.y * h));
  const x1 = Math.min(w, Math.ceil((norm.x + norm.w) * w));
  const y1 = Math.min(h, Math.ceil((norm.y + norm.h) * h));
  if (x1 <= x0 || y1 <= y0) return 0;

  // Subsample inside the bbox so we don't pay for every pixel.
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

/** Run YOLO-World on the rep frame, decode + NMS, then suppress
 *  face/text-collision and emit MediaOverlay records. Auxiliary
 *  motion classification + thumb cropping use the sample-frame stack
 *  (same approach as the classical detector). Best-effort: any
 *  failure short-circuits to an empty result rather than aborting
 *  the pipeline. */
export async function detectOverlaysYolo(
  input: DetectOverlaysInput,
): Promise<MediaOverlay[]> {
  const { shot, shotFrames, faceBbox, textMoments } = input;
  const rep = shotFrames.rep;
  if (!rep) return [];
  const repDecoded = decodeFrame(rep);
  if (!repDecoded) return [];

  let session: ort.InferenceSession;
  try {
    session = await getSession();
  } catch (err) {
    console.error(
      '[overlays-yolo]',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }

  const { tensor, scale, padX, padY } = letterboxToTensor(repDecoded);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const inputTensor = new ort.Tensor('float32', tensor, [
    1,
    3,
    INPUT_DIM,
    INPUT_DIM,
  ]);

  let output: ort.Tensor;
  try {
    const result = await session.run({ [inputName]: inputTensor });
    output = result[outputName];
  } catch (err) {
    console.error(
      '[overlays-yolo] inference failed:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }

  const raw = decodeYoloOutput(
    output,
    scale,
    padX,
    padY,
    repDecoded.w,
    repDecoded.h,
    CLASS_TO_KIND.length,
  );
  const kept = nms(raw, NMS_IOU);

  // Decode the rest of the sample frames once so the motion classifier
  // can reuse them across all kept detections.
  const sampleDecoded: DecodedFrame[] = [repDecoded];
  for (const s of shotFrames.samples) {
    if (!s || s === rep) continue;
    const d = decodeFrame(s);
    if (d && d.w === repDecoded.w && d.h === repDecoded.h) {
      sampleDecoded.push(d);
    }
  }

  const overlays: MediaOverlay[] = [];
  for (const det of kept) {
    const norm = det.bbox;
    const area = norm.w * norm.h;
    if (area < MIN_AREA_PCT || area > MAX_AREA_PCT) continue;
    if (faceBbox && iouFrac(norm, faceBbox) > FACE_OVERLAP_DROP) continue;

    // Text-overlay exclusion (same two-stage check as the classical
    // detector). YOLO-World shouldn't itself fire on text captions,
    // but it sometimes flags "sticker" on caption strips that happen
    // to have a rounded background.
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

    const motion: OverlayMotion =
      innerMotion(sampleDecoded, norm) > INNER_MOTION_THRESHOLD
        ? 'animated'
        : 'static';

    overlays.push({
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      bbox: norm,
      region: regionForXY(norm.x + norm.w / 2, norm.y + norm.h / 2),
      kind: CLASS_TO_KIND[det.classIdx],
      motion,
      spoken_window: '',
      thumb_b64: cropThumb(repDecoded, norm),
    });
  }
  return overlays;
}
