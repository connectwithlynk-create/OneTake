// Tagged reel library + on-disk cache.
//
// Users upload reels and tag each one with their intent:
//   - 'style_reference'   — copy editing pacing, structure, SFX, motion
//   - 'content_reference' — copy the b-roll subjects, framing, iconography
// A single reel can carry both tags. The synthesis engine pulls the
// style fingerprint from style-tagged reels and the content vocabulary
// from content-tagged reels.
//
// Analyses are slow (scene-detect + face + SyncNet + audio/VAD + SFX +
// OCR + transcript + per-shot captioning) — typically 1-3 minutes per
// reel. We cache the full ReelAnalysisResult to disk keyed by
// (url, ANALYSIS_VERSION) so re-running the synthesis engine on the
// same library is instant.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import {
  ANALYSIS_VERSION,
  analyzeReel,
  type ReelAnalysisResult,
} from './analyze';
import { resolveReel } from '../resolver';

export type ReelTag =
  | 'style_reference'
  | 'content_reference'
  | 'structure_reference';

export interface LibraryReel {
  url: string;
  tags: ReelTag[];
  /** Filled in by ensureAnalysis. */
  analysis?: ReelAnalysisResult;
}

const CACHE_DIR = resolve(process.cwd(), '.library', 'cache');
const LIBRARY_FILE = resolve(process.cwd(), '.library', 'library.json');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function cachePath(url: string): string {
  return join(CACHE_DIR, `${cacheKey(url)}-v${ANALYSIS_VERSION}.json`);
}

/** Load a cached analysis if one exists for the current ANALYSIS_VERSION,
 *  else return null. Stale-version files are intentionally ignored, not
 *  deleted — keep them around in case the user wants to roll back. */
export function loadCachedAnalysis(url: string): ReelAnalysisResult | null {
  const path = cachePath(url);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ReelAnalysisResult;
  } catch (err) {
    console.error(
      '[library] cache read failed for',
      url,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function saveCachedAnalysis(
  url: string,
  analysis: ReelAnalysisResult,
): void {
  ensureCacheDir();
  try {
    writeFileSync(cachePath(url), JSON.stringify(analysis, null, 2));
  } catch (err) {
    console.error(
      '[library] cache write failed for',
      url,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Resolve + analyze a single reel, caching the result on disk. If a
 *  cached analysis at the current ANALYSIS_VERSION exists, returns it
 *  without re-running the pipeline. Returns null on resolve failure. */
export async function ensureAnalysis(
  url: string,
  options?: { force?: boolean },
): Promise<ReelAnalysisResult | null> {
  if (!options?.force) {
    const cached = loadCachedAnalysis(url);
    if (cached) {
      console.error('[library] cache hit:', url);
      return cached;
    }
  }
  const resolved = await resolveReel(url);
  if ('error' in resolved) {
    console.error('[library] resolve failed:', url, resolved.error);
    return null;
  }
  const analysis = await analyzeReel({
    playableUrl: resolved.playable_url,
    durationMs: resolved.duration_ms,
  });
  saveCachedAnalysis(url, analysis);
  return analysis;
}

/** Hydrate every reel in the library: ensures each has an analysis
 *  attached (loading from cache or running the analyzer). Failed
 *  reels keep their tags but get analysis=undefined; callers should
 *  filter those out. */
export async function hydrateLibrary(
  reels: LibraryReel[],
  options?: { concurrent?: number },
): Promise<LibraryReel[]> {
  const limit = Math.max(1, options?.concurrent ?? 2);
  const out = reels.map((r) => ({ ...r }));
  let next = 0;
  async function worker(): Promise<void> {
    while (next < out.length) {
      const idx = next++;
      const a = await ensureAnalysis(out[idx].url);
      if (a) out[idx].analysis = a;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, out.length) }, worker),
  );
  return out;
}

/** Persist the library reel list (URLs + tags) to .library/library.json.
 *  Analyses live in the cache files, not here, so this stays small. */
export function saveLibrary(reels: LibraryReel[]): void {
  ensureCacheDir();
  const slim = reels.map((r) => ({ url: r.url, tags: r.tags }));
  writeFileSync(LIBRARY_FILE, JSON.stringify(slim, null, 2));
}

/** Read the persisted library if one exists, else empty list. */
export function loadLibrary(): LibraryReel[] {
  if (!existsSync(LIBRARY_FILE)) return [];
  try {
    return JSON.parse(readFileSync(LIBRARY_FILE, 'utf8')) as LibraryReel[];
  } catch (err) {
    console.error(
      '[library] read failed:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/** Filter helpers used by the synthesis engine. */
export function styleReels(reels: LibraryReel[]): LibraryReel[] {
  return reels.filter(
    (r) => r.analysis && r.tags.includes('style_reference'),
  );
}

export function contentReels(reels: LibraryReel[]): LibraryReel[] {
  return reels.filter(
    (r) => r.analysis && r.tags.includes('content_reference'),
  );
}

export function structureReels(reels: LibraryReel[]): LibraryReel[] {
  return reels.filter(
    (r) => r.analysis && r.tags.includes('structure_reference'),
  );
}
