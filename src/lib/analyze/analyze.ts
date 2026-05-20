import { extractFrames } from 'expo-frame-extractor';

import type { ReelShot } from '../types';
import { annotateShots } from './ocr';
import { pickSampleTimestamps } from './sampling';
import { detectShots } from './shots';

/** Bump when the analysis algorithm changes meaningfully (new metric,
 *  different threshold, schema migration). Inspirations with a stale
 *  analysis_version get re-analyzed on next visit to the swipe deck. */
export const ANALYSIS_VERSION = 1;

export interface ReelAnalysisInput {
  playableUrl: string;
  durationMs: number;
}

/** Per-reel structured output. Field names mirror the SQL columns on
 *  the `inspiration` table so persistence is a 1:1 write. */
export interface ReelAnalysisResult {
  shots: ReelShot[];
  hook_text: string | null;
  hook_duration_ms: number | null;
  median_shot_ms: number;
  cuts_per_sec: number;
  talking_pct: number;
  broll_pct: number;
  text_overlay_pct: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Compute the aggregate metrics from a list of annotated shots.
 *  Pure - exported so tests can drive it without the native bridge. */
export function deriveMetrics(
  shots: ReelShot[],
  durationMs: number
): Omit<ReelAnalysisResult, 'shots'> {
  if (shots.length === 0) {
    return {
      hook_text: null,
      hook_duration_ms: null,
      median_shot_ms: 0,
      cuts_per_sec: 0,
      talking_pct: 0,
      broll_pct: 0,
      text_overlay_pct: 0,
    };
  }
  const durations = shots.map((s) => s.end_ms - s.start_ms);
  const totalDur = durations.reduce((a, b) => a + b, 0) || durationMs || 1;
  const talkingDur = shots
    .filter((s) => s.has_face)
    .reduce((sum, s) => sum + (s.end_ms - s.start_ms), 0);
  const textShots = shots.filter(
    (s) => s.ocr_text !== null && s.ocr_text.length > 0
  ).length;
  const cuts = Math.max(0, shots.length - 1);

  const hook = shots[0];
  return {
    hook_text: hook.ocr_text,
    hook_duration_ms: hook.end_ms - hook.start_ms,
    median_shot_ms: median(durations),
    cuts_per_sec: durationMs > 0 ? cuts / (durationMs / 1000) : 0,
    talking_pct: talkingDur / totalDur,
    broll_pct: 1 - talkingDur / totalDur,
    text_overlay_pct: textShots / shots.length,
  };
}

/**
 * Run the full on-device analysis pipeline on a streamable video URL.
 *
 * Pipeline: pick timestamps → byte-range stream frames + face + dhash →
 * shot detection from dhash diffs → OCR on each shot's representative
 * frame → derive aggregate metrics. ~60-80 frames sampled per reel,
 * ~6-12 shots typical, ~6-12 OCR calls. Total wall time on-device is
 * usually 1-3 seconds for a 30s reel.
 */
export async function analyzeReel(
  input: ReelAnalysisInput
): Promise<ReelAnalysisResult> {
  if (input.durationMs <= 0) {
    return { shots: [], ...deriveMetrics([], 0) };
  }
  const timestamps = pickSampleTimestamps(input.durationMs);
  const frames = await extractFrames(input.playableUrl, timestamps);
  const shotBounds = detectShots(frames, { durationMs: input.durationMs });
  const shots = await annotateShots(frames, shotBounds);
  return { shots, ...deriveMetrics(shots, input.durationMs) };
}
