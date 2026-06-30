import { mkdirSync, renameSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'node:crypto';
import type { SuggestedEdit } from '../analyze/synthesize';
import type { CurationResult } from '../curator/types';
import { captureFrames } from './capture';
import { buildAudioTrack, muxVideoAudio } from './audio';

export const EXPORTS_DIR = resolve(process.cwd(), '.library', 'exports');

export type ExportProgress =
  | { phase: 'frames'; done: number; total: number }
  | { phase: 'audio' }
  | { phase: 'mux' }
  | { phase: 'done'; outPath: string }
  | { phase: 'error'; error: string };

export interface ExportReelOptions {
  plan: SuggestedEdit;
  curation: CurationResult | null;
  /** Renderer-loadable URL for the creator/narration video (local-video://),
   *  or null. Built by the caller, which has localVideoUrl(). */
  targetVideoUrl: string | null;
  /** Filesystem path to the narration/creator video for the audio bed, or
   *  null. Distinct from targetVideoUrl (which is a renderer URL). */
  narrationPath?: string | null;
  fps?: number;
  onProgress?: (p: ExportProgress) => void;
  shouldAbort?: () => boolean;
}

function planKey(plan: SuggestedEdit): string {
  return createHash('sha1')
    .update(JSON.stringify(plan.shots ?? []))
    .digest('hex')
    .slice(0, 12);
}

export interface ExportReelResult {
  outPath: string;
  hasAudio: boolean;
  frames: number;
}

/** Full export pipeline: deterministic frame capture -> silent mp4, audio
 *  track (narration + b-roll + SFX) -> aac, then mux into a final reel. */
export async function exportReel(
  opts: ExportReelOptions,
): Promise<ExportReelResult> {
  const { plan, curation, targetVideoUrl } = opts;
  const fps = opts.fps ?? 30;
  mkdirSync(EXPORTS_DIR, { recursive: true });

  const key = planKey(plan);
  const silentPath = join(EXPORTS_DIR, `.tmp-${key}-silent.mp4`);
  const audioPath = join(EXPORTS_DIR, `.tmp-${key}-audio.m4a`);
  const outPath = join(EXPORTS_DIR, `reel-${key}.mp4`);

  try {
    // 1. Frames -> silent video.
    const frames = await captureFrames({
      plan,
      curation,
      targetVideoUrl,
      fps,
      outPath: silentPath,
      shouldAbort: opts.shouldAbort,
      onProgress: (done, total) =>
        opts.onProgress?.({ phase: 'frames', done, total }),
    });

    // 2. Audio bed.
    opts.onProgress?.({ phase: 'audio' });
    const { hasAudio } = await buildAudioTrack(
      plan,
      audioPath,
      opts.narrationPath ?? null,
    );

    // 3. Mux (or promote the silent video when there's no audio at all).
    if (hasAudio) {
      opts.onProgress?.({ phase: 'mux' });
      await muxVideoAudio(silentPath, audioPath, outPath);
    } else {
      renameSync(silentPath, outPath);
    }

    opts.onProgress?.({ phase: 'done', outPath });
    return { outPath, hasAudio, frames };
  } finally {
    for (const tmp of [silentPath, audioPath]) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
