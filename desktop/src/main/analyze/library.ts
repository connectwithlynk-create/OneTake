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
const COLLECTIONS_FILE = resolve(
  process.cwd(),
  '.library',
  'collections.json',
);

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
  // A zero-shot analysis means the probe/download failed (analyzeReel
  // degrades to an empty result rather than throwing). Caching it would
  // make a transient failure a permanent "hit" until ANALYSIS_VERSION
  // bumps — treat it as a failure instead.
  if (analysis.shots.length === 0) {
    console.error('[library] analysis produced no shots — not caching:', url);
    return null;
  }
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

// ---------- collections ----------
//
// A collection is a NAMED set of reels you take inspiration from. The app
// used to keep one flat library (library.json); collections let you group
// reels (e.g. "Founder POV", "Product demos", "Hormozi-style") and
// fingerprint each group separately for synthesis. Reels (url + tags) live
// inside the collection; analyses stay in the shared per-URL cache, so the
// same reel in two collections only analyzes once.

export interface Collection {
  id: string;
  name: string;
  created_at: number;
  reels: LibraryReel[];
}

/** Slim on-disk shape — reels carry only url + tags (no analysis). */
interface SlimCollection {
  id: string;
  name: string;
  created_at: number;
  reels: { url: string; tags: ReelTag[] }[];
}

function newId(): string {
  return createHash('sha1')
    .update(`${Date.now()}-${Math.round(Math.random() * 1e9)}`)
    .digest('hex')
    .slice(0, 12);
}

function writeCollections(cols: Collection[]): void {
  ensureCacheDir();
  const slim: SlimCollection[] = cols.map((c) => ({
    id: c.id,
    name: c.name,
    created_at: c.created_at,
    reels: c.reels.map((r) => ({ url: r.url, tags: r.tags })),
  }));
  writeFileSync(COLLECTIONS_FILE, JSON.stringify(slim, null, 2));
}

/** Load all collections. On first run, migrates an existing flat
 *  library.json into a single "My Library" collection (and persists it);
 *  if there's no prior library either, seeds one empty default collection.
 *  Always returns at least one collection so the UI has an active target. */
export function loadCollections(): Collection[] {
  if (existsSync(COLLECTIONS_FILE)) {
    try {
      const parsed = JSON.parse(
        readFileSync(COLLECTIONS_FILE, 'utf8'),
      ) as SlimCollection[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((c) => ({
          id: c.id,
          name: c.name,
          created_at: c.created_at,
          reels: (c.reels ?? []).map((r) => ({ url: r.url, tags: r.tags })),
        }));
      }
    } catch (err) {
      console.error(
        '[library] collections read failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  // Migrate the legacy flat library, or seed an empty default.
  const legacy = loadLibrary();
  const seeded: Collection[] = [
    {
      id: newId(),
      name: 'My Library',
      created_at: Date.now(),
      reels: legacy.map((r) => ({ url: r.url, tags: r.tags })),
    },
  ];
  writeCollections(seeded);
  return seeded;
}

/** Persist the reel list (url + tags) of one collection, leaving the
 *  others untouched. No-op when the id isn't found. */
export function saveCollectionReels(
  id: string,
  reels: LibraryReel[],
): void {
  const cols = loadCollections();
  const target = cols.find((c) => c.id === id);
  if (!target) return;
  target.reels = reels.map((r) => ({ url: r.url, tags: r.tags }));
  writeCollections(cols);
}

/** Create a new, empty collection and return it. */
export function createCollection(name: string): Collection {
  const cols = loadCollections();
  const col: Collection = {
    id: newId(),
    name: name.trim() || 'Untitled collection',
    created_at: Date.now(),
    reels: [],
  };
  cols.push(col);
  writeCollections(cols);
  return col;
}

/** Rename a collection. Returns the updated list. */
export function renameCollection(id: string, name: string): Collection[] {
  const cols = loadCollections();
  const target = cols.find((c) => c.id === id);
  if (target) {
    target.name = name.trim() || target.name;
    writeCollections(cols);
  }
  return cols;
}

/** Delete a collection. The last remaining collection can't be deleted —
 *  there must always be at least one. Returns the updated list. */
export function deleteCollection(id: string): Collection[] {
  const cols = loadCollections();
  if (cols.length <= 1) return cols;
  const next = cols.filter((c) => c.id !== id);
  writeCollections(next);
  return next;
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
