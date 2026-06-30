// Per-shot camera-motion detection via block-based optical flow.
//
// For each shot we decode its sample frames (already extracted for OCR /
// captions — no extra ffmpeg pass), convert to small grayscale buffers,
// and estimate the dominant CAMERA motion between consecutive samples by
// matching a grid of blocks and fitting a translation + uniform-scale
// model in the least-squares sense. A trimmed refit rejects blocks whose
// displacement disagrees with the global fit (a moving foreground subject,
// a talking head) so we capture how the FRAME moved, not how objects in it
// moved. The per-pair (tx, ty, scale) estimates are summed across the
// shot's sampled span and classified into the same preset vocabulary the
// editor offers (zoom_in / zoom_out / pan_left / pan_right / ken_burns /
// none).
//
// Everything here is pure-JS + jpeg-js; no native deps. Best-effort: any
// per-shot failure yields null and the pipeline continues.
import jpeg from 'jpeg-js';
import type { ExtractedFrame, ShotFrames } from './frame-extractor';
import type { CameraMotionKind, DetectedMotion } from './types';

// ---- working-resolution + estimator knobs --------------------------------

/** Downscale every sample to this width before matching. Small enough to
 *  be cheap, large enough to resolve a few-percent drift. Height tracks
 *  the source aspect. */
const WORK_W = 160;
/** Half-size of a match block, in working px (block is 2*HB square). */
const HB = 8;
/** Grid spacing between block centers, in working px. */
const GRID = 24;
/** Block-match search radius each way, in working px. Caps the max
 *  per-pair displacement we can measure (~R/WORK_W of the frame). */
const SEARCH_R = 12;
/** Min within-block intensity variance to trust a block — flat regions
 *  (sky, solid backgrounds) match ambiguously and are skipped. */
const VAR_MIN = 40;
/** Need at least this many usable blocks to fit a model for a pair. */
const MIN_BLOCKS = 10;

// ---- classification thresholds (across the sampled span) -----------------

/** Total fractional scale change across the shot to count as a zoom. */
const MIN_ZOOM = 0.04;
/** Total translation (fraction of frame) across the shot to count as a pan. */
const MIN_PAN = 0.04;
/** A pair whose inlier ratio is below this is too noisy to use. */
const MIN_INLIER_RATIO = 0.3;

interface Gray {
  data: Float32Array;
  w: number;
  h: number;
}

/** Decode a sample frame to a small grayscale buffer at WORK_W width.
 *  Nearest-neighbor sampling is plenty for block matching. */
function toGray(frame: ExtractedFrame | null): Gray | null {
  if (!frame?.jpegBase64) return null;
  let dec: { width: number; height: number; data: Uint8Array };
  try {
    dec = jpeg.decode(Buffer.from(frame.jpegBase64, 'base64'), {
      useTArray: true,
    }) as { width: number; height: number; data: Uint8Array };
  } catch {
    return null;
  }
  const sw = dec.width;
  const sh = dec.height;
  if (sw < 2 || sh < 2) return null;
  const w = Math.min(WORK_W, sw);
  const h = Math.max(1, Math.round((w / sw) * sh));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor((y / h) * sh));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor((x / w) * sw));
      const i = (sy * sw + sx) * 4;
      // Rec.601 luma.
      out[y * w + x] =
        0.299 * dec.data[i] + 0.587 * dec.data[i + 1] + 0.114 * dec.data[i + 2];
    }
  }
  return { data: out, w, h };
}

/** Variance of a block centered at (cx, cy), subsampled. */
function blockVariance(g: Gray, cx: number, cy: number): number {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let dy = -HB; dy < HB; dy += 2) {
    const y = cy + dy;
    const row = y * g.w;
    for (let dx = -HB; dx < HB; dx += 2) {
      const v = g.data[row + cx + dx];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/** Sum of absolute differences between block at (ax,ay) in A and the
 *  block shifted by (ox,oy) in B. Early-outs once it exceeds `best`. */
function blockSAD(
  a: Gray,
  b: Gray,
  ax: number,
  ay: number,
  ox: number,
  oy: number,
  best: number,
): number {
  let cost = 0;
  for (let dy = -HB; dy < HB; dy += 2) {
    const ar = (ay + dy) * a.w;
    const br = (ay + dy + oy) * b.w;
    for (let dx = -HB; dx < HB; dx += 2) {
      const d = a.data[ar + ax + dx] - b.data[br + ax + dx + ox];
      cost += d < 0 ? -d : d;
    }
    if (cost >= best) return cost; // prune
  }
  return cost;
}

interface PairFit {
  /** Translation in working px (content displacement A→B). */
  tx: number;
  ty: number;
  /** Scale-expansion a = scale-1 (content spreads from center when >0). */
  a: number;
  /** Fraction of usable blocks that agreed with the fit. */
  inlierRatio: number;
}

/** Least-squares fit of dx = tx + a*X, dy = ty + a*Y over the block
 *  displacement field, with one trimmed refit to reject outliers. */
function fitModel(
  X: number[],
  Y: number[],
  DX: number[],
  DY: number[],
  keep: boolean[],
): { tx: number; ty: number; a: number } | null {
  let n = 0;
  let sX = 0,
    sY = 0,
    sDX = 0,
    sDY = 0,
    sXX = 0,
    sYY = 0,
    sXDX = 0,
    sYDY = 0;
  for (let i = 0; i < X.length; i++) {
    if (!keep[i]) continue;
    n++;
    sX += X[i];
    sY += Y[i];
    sDX += DX[i];
    sDY += DY[i];
    sXX += X[i] * X[i];
    sYY += Y[i] * Y[i];
    sXDX += X[i] * DX[i];
    sYDY += Y[i] * DY[i];
  }
  if (n < MIN_BLOCKS) return null;
  // a = [cov(X,DX) + cov(Y,DY)] / [var(X) + var(Y)]   (un-normalized by n)
  const num = sXDX - (sX * sDX) / n + (sYDY - (sY * sDY) / n);
  const den = sXX - (sX * sX) / n + (sYY - (sY * sY) / n);
  const a = Math.abs(den) > 1e-6 ? num / den : 0;
  const tx = (sDX - a * sX) / n;
  const ty = (sDY - a * sY) / n;
  return { tx, ty, a };
}

function estimatePairMotion(a: Gray, b: Gray): PairFit | null {
  if (a.w !== b.w || a.h !== b.h) return null;
  const { w, h } = a;
  const cx = w / 2;
  const cy = h / 2;
  const margin = HB + SEARCH_R;
  const X: number[] = [];
  const Y: number[] = [];
  const DX: number[] = [];
  const DY: number[] = [];
  for (let gy = margin; gy < h - margin; gy += GRID) {
    for (let gx = margin; gx < w - margin; gx += GRID) {
      if (blockVariance(a, gx, gy) < VAR_MIN) continue;
      let best = Infinity;
      let box = 0;
      let boy = 0;
      for (let oy = -SEARCH_R; oy <= SEARCH_R; oy++) {
        for (let ox = -SEARCH_R; ox <= SEARCH_R; ox++) {
          const cost = blockSAD(a, b, gx, gy, ox, oy, best);
          if (cost < best) {
            best = cost;
            box = ox;
            boy = oy;
          }
        }
      }
      X.push(gx - cx);
      Y.push(gy - cy);
      DX.push(box);
      DY.push(boy);
    }
  }
  if (X.length < MIN_BLOCKS) return null;

  const keep = X.map(() => true);
  let fit = fitModel(X, Y, DX, DY, keep);
  if (!fit) return null;

  // Trim: drop blocks whose residual is far above the median, then refit
  // once. Removes foreground-object motion that disagrees with the global
  // camera model.
  const resid: number[] = [];
  for (let i = 0; i < X.length; i++) {
    const ex = fit.tx + fit.a * X[i] - DX[i];
    const ey = fit.ty + fit.a * Y[i] - DY[i];
    resid.push(Math.hypot(ex, ey));
  }
  const sortedR = [...resid].sort((p, q) => p - q);
  const medR = sortedR[Math.floor(sortedR.length / 2)] || 0;
  const cutoff = Math.max(1.5, medR * 2.5);
  let inliers = 0;
  for (let i = 0; i < X.length; i++) {
    keep[i] = resid[i] <= cutoff;
    if (keep[i]) inliers++;
  }
  const refit = fitModel(X, Y, DX, DY, keep);
  if (refit) fit = refit;

  return {
    tx: fit.tx,
    ty: fit.ty,
    a: fit.a,
    inlierRatio: inliers / X.length,
  };
}

function classify(
  totalZoom: number,
  totalPanX: number,
  totalPanY: number,
): CameraMotionKind {
  const panMag = Math.hypot(totalPanX, totalPanY);
  const zoomSig = Math.abs(totalZoom) >= MIN_ZOOM;
  const panSig = panMag >= MIN_PAN;
  if (!zoomSig && !panSig) return 'none';
  if (zoomSig && panSig) return 'ken_burns';
  if (zoomSig) return totalZoom > 0 ? 'zoom_in' : 'zoom_out';
  // pan only: horizontal pans map to the presets; a dominantly-vertical
  // drift (tilt) has no preset, so call it ken_burns rather than mislabel.
  if (Math.abs(totalPanY) > 1.5 * Math.abs(totalPanX)) return 'ken_burns';
  // CSS pan_right drifts content rightward over the shot — match that:
  // content moving right (+x) → pan_right.
  return totalPanX > 0 ? 'pan_right' : 'pan_left';
}

/** Estimate the dominant camera motion for a single shot from its sample
 *  frames. Returns null when fewer than two frames decode or no pair
 *  yields a reliable fit. */
export function detectShotMotion(sf: ShotFrames | null): DetectedMotion | null {
  if (!sf) return null;
  const grays: Gray[] = [];
  for (const s of sf.samples) {
    const g = toGray(s);
    if (g) grays.push(g);
  }
  if (grays.length < 2) return null;

  let zoom = 0;
  let panX = 0;
  let panY = 0;
  let usedPairs = 0;
  let inlierSum = 0;
  const dirs: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < grays.length; i++) {
    const fit = estimatePairMotion(grays[i], grays[i + 1]);
    if (!fit || fit.inlierRatio < MIN_INLIER_RATIO) continue;
    const w = grays[i].w;
    const hh = grays[i].h;
    zoom += fit.a; // small per-step; summing approximates total expansion
    panX += fit.tx / w;
    panY += fit.ty / hh;
    inlierSum += fit.inlierRatio;
    dirs.push({ x: fit.tx / w, y: fit.ty / hh });
    usedPairs++;
  }
  if (usedPairs === 0) return null;

  const kind = classify(zoom, panX, panY);
  const panMag = Math.hypot(panX, panY);

  // Confidence: magnitude over threshold (saturating at 2x), scaled by the
  // mean inlier ratio and by directional consistency across pairs. For a
  // 'none' verdict, confidence is how clearly the motion stayed below
  // threshold.
  const magRatio = Math.max(
    Math.abs(zoom) / MIN_ZOOM,
    panMag / MIN_PAN,
  );
  const meanInlier = inlierSum / usedPairs;
  let consistency = 1;
  if (dirs.length >= 2 && panMag > 1e-4) {
    // Average cosine alignment of per-pair pan vectors with the total.
    let dot = 0;
    for (const d of dirs) {
      const m = Math.hypot(d.x, d.y) || 1e-6;
      dot += (d.x * panX + d.y * panY) / (m * panMag);
    }
    consistency = Math.max(0, dot / dirs.length);
  }
  let confidence: number;
  if (kind === 'none') {
    confidence = Math.max(0, Math.min(1, 1 - magRatio));
  } else {
    const magFactor = Math.min(1, magRatio / 2);
    confidence = Math.max(
      0,
      Math.min(1, magFactor * meanInlier * (0.4 + 0.6 * consistency)),
    );
  }

  return {
    kind,
    confidence: Math.round(confidence * 100) / 100,
    zoom_rate: Math.round(zoom * 1000) / 1000,
    pan_x: Math.round(panX * 1000) / 1000,
    pan_y: Math.round(panY * 1000) / 1000,
  };
}

/** Detect motion for every shot. Best-effort per shot — a failure yields
 *  null in that slot so indexing stays aligned with the shots array. */
export function detectAllMotion(
  shotFrames: ShotFrames[],
): (DetectedMotion | null)[] {
  return shotFrames.map((sf) => {
    try {
      return detectShotMotion(sf);
    } catch {
      return null;
    }
  });
}
