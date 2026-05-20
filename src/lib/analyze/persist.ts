import {
  getInspiration,
  setInspirationAnalysisResult,
  setInspirationAnalysisStatus,
} from '../repo';
import { analyzeReel, ANALYSIS_VERSION, type ReelAnalysisResult } from './analyze';

export interface RunAnalysisOutcome {
  ok: boolean;
  /** Non-fatal skip reason or fatal error message. */
  reason?: string;
  /** Set on ok=true. Returned so callers can show a summary without
   *  re-fetching the row. */
  result?: ReelAnalysisResult;
}

/**
 * Drive one inspiration row through the analysis state machine:
 *   idle/failed/queued  -->  running  -->  ready  (or 'failed')
 *
 * Idempotent: a row that's already `ready` at the current ANALYSIS_VERSION
 * is left untouched. Rows missing playable_url / duration_ms (resolver
 * hasn't run yet) return ok=false with reason='not_resolved' so the
 * caller can decide to run the resolver first.
 */
export async function runAnalysisForInspiration(
  itemId: string
): Promise<RunAnalysisOutcome> {
  const row = await getInspiration(itemId);
  if (!row) return { ok: false, reason: 'not_found' };

  if (
    row.analysis_status === 'ready' &&
    row.analysis_version >= ANALYSIS_VERSION
  ) {
    return { ok: true, reason: 'already_ready' };
  }

  if (!row.playable_url || !row.duration_ms) {
    return { ok: false, reason: 'not_resolved' };
  }

  try {
    await setInspirationAnalysisStatus(itemId, 'running');
    const result = await analyzeReel({
      playableUrl: row.playable_url,
      durationMs: row.duration_ms,
    });
    await setInspirationAnalysisResult(itemId, {
      shots_json: JSON.stringify(result.shots),
      hook_text: result.hook_text,
      hook_duration_ms: result.hook_duration_ms,
      median_shot_ms: result.median_shot_ms,
      cuts_per_sec: result.cuts_per_sec,
      talking_pct: result.talking_pct,
      broll_pct: result.broll_pct,
      text_overlay_pct: result.text_overlay_pct,
      analysis_version: ANALYSIS_VERSION,
    });
    return { ok: true, result };
  } catch (e: unknown) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await setInspirationAnalysisStatus(itemId, 'failed', msg);
    return { ok: false, reason: msg };
  }
}
