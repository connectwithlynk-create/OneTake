// On-disk cache for curation results (per-shot candidates + agent
// traces). Key = sha1 of the plan's shot list — two runs of the same
// plan hit the cache instead of re-running the per-shot agents.
//
// Invalidation: bump CURATE_VERSION when the curator prompt / tools
// / output shape changes.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { SuggestedEdit } from '../analyze/synthesize';
import type { CurationResult } from './types';

export const CURATE_VERSION = 14;

const CACHE_DIR = resolve(process.cwd(), '.library', 'curations');

function ensureDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

/** Stable key over the plan's shot list — the only thing that
 *  determines per-shot agent inputs. */
export function curationCacheKey(plan: SuggestedEdit): string {
  const slim = plan.shots.map((s) => ({
    shot_idx: s.shot_idx,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    spoken_during: s.spoken_during,
    broll_description: s.broll_description,
    source_type: s.source_type,
    asset: s.asset,
  }));
  return createHash('sha1')
    .update(JSON.stringify(slim))
    .digest('hex')
    .slice(0, 16);
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}-v${CURATE_VERSION}.json`);
}

export function loadCachedCuration(key: string): CurationResult | null {
  const path = cachePath(key);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CurationResult;
    // Strip sparse-array nulls. JSON.stringify serializes empty slots
    // in a sparse Array as `null`, so a partial run that wrote
    // `new Array(total)` with only some slots filled comes back here
    // as [null, null, ShotCuration, null, ...]. Downstream code does
    // findIndex / map over shot_idx and crashes on the nulls. Filter
    // them out unconditionally so every consumer sees a clean array.
    const cleanShots = Array.isArray(parsed.shots)
      ? parsed.shots.filter((s): s is NonNullable<typeof s> => s != null)
      : [];
    const cleanTraces = Array.isArray(parsed.traces)
      ? parsed.traces.filter((t): t is NonNullable<typeof t> => t != null)
      : [];
    return {
      ...parsed,
      shots: cleanShots,
      traces: cleanTraces,
      from_cache: true,
    };
  } catch (err) {
    console.error(
      '[curation-cache] read failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function saveCachedCuration(
  key: string,
  result: CurationResult,
): void {
  ensureDir();
  try {
    // Don't persist the from_cache flag — it's a runtime hint.
    // Also strip sparse-array nulls: bulk curate pre-allocates
    // `new Array(total)` and fills slots as shots finish, so a
    // partial run has empty slots that JSON.stringify serializes
    // as `null`. We filter at write time so cached state on disk is
    // always a dense array.
    const { from_cache: _ignored, ...slim } = result;
    void _ignored;
    const dense: CurationResult = {
      ...slim,
      shots: Array.isArray(slim.shots)
        ? slim.shots.filter((s): s is NonNullable<typeof s> => s != null)
        : [],
      traces: Array.isArray(slim.traces)
        ? slim.traces.filter((t): t is NonNullable<typeof t> => t != null)
        : [],
    };
    writeFileSync(cachePath(key), JSON.stringify(dense, null, 2));
  } catch (err) {
    console.error(
      '[curation-cache] write failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
