// On-disk cache for synthesized edit plans.
//
// Key = sha1 of the stable input bundle (transcript words +
// inspirationReels with full analyses + metrics). Two identical input
// bundles always produce the same key, so re-clicking Synthesize on
// the same library + target hits the cache instead of paying for
// another LLM call.
//
// Each plan is stored as <key>-v<version>.json. A sibling
// <key>-v<version>.meta.json sidecar holds the human-readable
// metadata (target description, library URLs, instructions, created_at)
// used by the "past plans" dropdown so the user can pick a plan
// without re-running synthesis.
//
// Invalidation: bump SYNTHESIZE_VERSION when the synthesis prompt or
// output shape changes — old cached plans become inaccessible.
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import type { SuggestedEdit } from './synthesize';

/** Duplicate of the TargetInput type in main/index.ts. Inlined here to
 *  avoid a circular import (index.ts imports from plan-cache). */
export type TargetInput =
  | { kind: 'reel_url'; url: string }
  | { kind: 'script'; text: string }
  | { kind: 'local_video'; filePath: string };

/** Bump when the synthesis prompt / schema / output shape changes
 *  meaningfully — invalidates cached plans. */
export const SYNTHESIZE_VERSION = 14;

const CACHE_DIR = resolve(process.cwd(), '.library', 'plans');

function ensureDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

/** Sidecar metadata describing how this plan was produced. Stored
 *  alongside the plan file so the UI can list past plans with a
 *  human-readable label without loading the full plan. */
export interface PlanMeta {
  key: string;
  version: number;
  created_at: number;
  /** Short label describing the target (URL, script preview, filename). */
  target_label: string;
  /** Raw target kind for tooltips / icons. */
  target_kind: TargetInput['kind'];
  library_urls: string[];
  allow_copyrighted: boolean;
  user_instructions: string;
  shot_count: number;
  /** Hook line from the plan (target_fill of the first structure
   *  section), if available — gives a meaningful preview in the dropdown. */
  hook_preview: string | null;
}

/** Listed entry: PlanMeta plus best-effort fields for legacy plans
 *  that don't have a sidecar (created_at is the file mtime; the
 *  target_label is derived from the plan's first section's target_fill). */
export type PlanListEntry = PlanMeta;

/** Stable cache key over the synthesis input bundle. Identical inputs
 *  always produce the same key, so we can detect cache hits without
 *  storing the input alongside the plan. */
export function planCacheKey(input: unknown): string {
  return createHash('sha1')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}

function planPath(key: string): string {
  return join(CACHE_DIR, `${key}-v${SYNTHESIZE_VERSION}.json`);
}

function metaPath(key: string): string {
  return join(CACHE_DIR, `${key}-v${SYNTHESIZE_VERSION}.meta.json`);
}

export function loadCachedPlan(key: string): SuggestedEdit | null {
  const path = planPath(key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SuggestedEdit;
  } catch (err) {
    console.error(
      '[plan-cache] read failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function saveCachedPlan(
  key: string,
  plan: SuggestedEdit,
  meta?: Omit<PlanMeta, 'key' | 'version' | 'created_at' | 'shot_count' | 'hook_preview'>,
): void {
  ensureDir();
  try {
    writeFileSync(planPath(key), JSON.stringify(plan, null, 2));
  } catch (err) {
    console.error(
      '[plan-cache] write failed:',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (!meta) return;
  const full: PlanMeta = {
    key,
    version: SYNTHESIZE_VERSION,
    created_at: Date.now(),
    shot_count: plan.shots.length,
    hook_preview: plan.structure_sections[0]?.target_fill?.trim() || null,
    ...meta,
  };
  try {
    writeFileSync(metaPath(key), JSON.stringify(full, null, 2));
  } catch (err) {
    console.error(
      '[plan-cache] meta write failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Truncate a string to a length, single-line + ellipsis. */
function shorten(s: string, n: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > n ? cleaned.slice(0, n - 1) + '…' : cleaned;
}

/** Build a target label from a TargetInput. Used both when saving
 *  fresh sidecars and when reconstructing legacy entries. */
export function describeTarget(target: TargetInput): string {
  if (target.kind === 'reel_url') return target.url;
  if (target.kind === 'script') return `Script: "${shorten(target.text, 60)}"`;
  return `File: ${target.filePath.split('/').pop() ?? target.filePath}`;
}

/** Scan the cache dir and return every plan at the current version,
 *  newest first. Plans with a sidecar use its metadata; plans without
 *  one (legacy) get a best-effort label derived from the plan itself. */
export function listCachedPlans(): PlanListEntry[] {
  if (!existsSync(CACHE_DIR)) return [];
  const suffix = `-v${SYNTHESIZE_VERSION}.json`;
  const entries: PlanListEntry[] = [];
  for (const name of readdirSync(CACHE_DIR)) {
    if (!name.endsWith(suffix) || name.endsWith('.meta.json')) continue;
    const key = name.slice(0, -suffix.length);
    const pPath = join(CACHE_DIR, name);
    const mPath = metaPath(key);
    if (existsSync(mPath)) {
      try {
        const m = JSON.parse(readFileSync(mPath, 'utf8')) as PlanMeta;
        entries.push(m);
        continue;
      } catch {
        /* fall through to legacy reconstruction */
      }
    }
    // Legacy plan with no sidecar — reconstruct what we can from the
    // plan file itself. We can't recover the original target, so the
    // label is just "(legacy)" plus the hook preview if available.
    let plan: SuggestedEdit | null = null;
    try {
      plan = JSON.parse(readFileSync(pPath, 'utf8')) as SuggestedEdit;
    } catch {
      continue;
    }
    const hook = plan.structure_sections[0]?.target_fill?.trim() || null;
    entries.push({
      key,
      version: SYNTHESIZE_VERSION,
      created_at: statSync(pPath).mtimeMs,
      target_label: hook ? `(legacy) ${shorten(hook, 50)}` : '(legacy)',
      target_kind: 'reel_url',
      library_urls: [],
      allow_copyrighted: false,
      user_instructions: '',
      shot_count: plan.shots.length,
      hook_preview: hook,
    });
  }
  entries.sort((a, b) => b.created_at - a.created_at);
  return entries;
}
