import { readFileSync, existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import type { SfxType } from '../analyze/sfx-classify';
import type { SfxCollectionPattern } from '../analyze/fingerprint';

/** One SFX hit on the reel's independent SFX timeline — anchored to a
 *  specific spoken word, so it starts exactly when that word is said. */
export interface SfxTimelineEvent {
  /** Time from reel start, ms — equals the attached word's start time. */
  ms: number;
  /** Acoustic type to play (fallback when no specific sound is set). */
  type: SfxType;
  /** Specific library sound to play (free-text name/query, e.g. "iphone
   *  message"). When set, it resolves to that exact clip — overrides type. */
  sound?: string;
  /** Per-event playback gain (0-1). Overrides the plan-wide sfx_volume for
   *  THIS event, so different sounds can be louder/quieter than each other. */
  volume?: number;
  /** The transcript word this SFX is attached to (its spoken start = ms). */
  word: string;
  /** Index of that word in the word-by-word transcript. */
  wordIndex: number;
}

/** Build the reel's SFX timeline by ATTACHING SFX to the word-by-word
 *  narration transcript: each placed hit is bound to a word and starts at
 *  that word's spoken onset. Which words get a hit follows the learned
 *  cadence (≈ sfx_per_word), denser through the hook when the pattern
 *  escalates; with no learned pattern it falls back to a moderate cadence of
 *  `fallbackType`. Single source of SFX placement for export + live preview. */
export interface SfxOverride {
  cadence?: 'every_word' | 'sparse' | 'normal' | 'off';
  type?: SfxType;
  /** A specific library sound (free-text name/query) to use for every SFX,
   *  e.g. "iphone message notification". Resolves to that exact clip. */
  sound?: string;
}

export function buildSfxTimeline(
  words: { start_ms: number; text?: string }[],
  pattern: SfxCollectionPattern | null,
  hookMs: number,
  fallbackType: SfxType = 'impulse_tonal',
  override?: SfxOverride | null,
): SfxTimelineEvent[] {
  if (words.length === 0) return [];
  if (override?.cadence === 'off') return [];
  const sig = pattern?.signals ?? null;
  const type =
    override?.type ??
    sig?.body_dominant_type ??
    sig?.hook_dominant_type ??
    fallbackType;
  // Override cadence wins; else the inspiration's; else a moderate default.
  const overridePerWord =
    override?.cadence === 'every_word'
      ? 1
      : override?.cadence === 'sparse'
        ? 0.2
        : null;
  const perWord =
    overridePerWord ??
    (sig ? Math.min(1, Math.max(0.05, sig.sfx_per_word)) : 0.4);
  const escalate = sig
    ? sig.hook_escalation >= 0.2 ||
      sig.hook_density_per_s > sig.body_density_per_s * 1.3
    : false;
  const stride = Math.max(1, Math.round(1 / perWord));
  const CAP = 300;
  const out: SfxTimelineEvent[] = [];
  for (let i = 0; i < words.length && out.length < CAP; i++) {
    const inHook = words[i].start_ms < hookMs;
    const st = inHook && escalate ? 1 : stride;
    if (i % st !== 0) continue;
    out.push({
      ms: words[i].start_ms,
      type,
      ...(override?.sound ? { sound: override.sound } : {}),
      word: words[i].text ?? '',
      wordIndex: i,
    });
  }
  return out;
}

// Resolve a shot's free-text `sfx_cue` to a real local SFX mp3 from the
// myinstants library. Two signals are combined:
//   1. index.json           -> slug/name -> local_file (the clips themselves)
//   2. audioset-labels.json  -> slug -> { top AudioSet label, bucket }
//      produced offline by scripts/index-myinstants-audioset.ts. The PANNs
//      model works on these CLEAN isolated clips (unlike buried-in-voiceover
//      reel SFX), so the labels are reliable here.
//
// Matching order:
//   (a) keyword token overlap of the cue against each clip's name + slug +
//       its AudioSet label (so cue "swoosh" matches a clip labelled
//       "Whoosh, swoosh, swish" even if its filename never says swoosh).
//   (b) if nothing overlaps, fall back to the cue's intended acoustic
//       BUCKET (ding->impulse_tonal, whoosh->sweep, boom->impulse_noisy,
//       ...) and pick a clip the model labelled with that bucket. This is
//       what lets a generic cue still land a sensible real SFX.

const MY_DIR = resolve(process.cwd(), 'resources', 'myinstants');
const CATALOG_PATH = join(MY_DIR, 'index.json');
const LABELS_PATH = join(MY_DIR, 'audioset-labels.json');
const AUDIO_DIR = join(MY_DIR, 'audio');

const STOP = new Set([
  'the', 'and', 'for', 'sound', 'effect', 'effects', 'sfx', 'meme', 'memes',
  'original', 'audio', 'clip', 'on', 'in', 'to', 'of', 'a', 'an', 'with',
  'cut', 'cue', 'hit', 'transition', 'short', 'quick', 'soft', 'loud',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Infer the intended acoustic bucket from a cue's tokens, for the
 *  no-keyword-overlap fallback. Returns null when the cue gives no clear
 *  acoustic hint (e.g. "silent open"). */
function cueToBucket(tokens: string[]): SfxType | null {
  const t = ' ' + tokens.join(' ') + ' ';
  if (/(whoosh|swoosh|swish|whip|wind|sweep|riser)/.test(t)) return 'sweep';
  if (/(ding|bell|chime|beep|ping|bong|bling|tone|note|sparkle|twinkle)/.test(t)) {
    return 'impulse_tonal';
  }
  if (
    /(boom|bang|explos|slam|punch|thud|drop|impact|clap|snap|click|knock|pop|smack)/.test(
      t,
    )
  ) {
    return 'impulse_noisy';
  }
  if (/(vocal|wow|yeah|huh|bruh|scream|laugh|cheer|gasp|yell|shout|woah)/.test(t)) {
    return 'vocal';
  }
  if (/(drone|hum|buzz|ambient|rumble)/.test(t)) return 'sustained';
  return null;
}

/** Public: the acoustic bucket a free-text cue implies, or null. */
export function bucketForCue(cue: string | null | undefined): SfxType | null {
  if (!cue) return null;
  return cueToBucket(tokenize(cue));
}

/** Most common cue bucket across a set of cues, defaulting to a tonal ding.
 *  Used as the SFX type when there's no learned pattern. */
export function dominantCueBucket(cues: (string | null)[]): SfxType {
  const counts = new Map<SfxType, number>();
  for (const c of cues) {
    const b = bucketForCue(c);
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  let best: SfxType = 'impulse_tonal';
  let max = 0;
  for (const [t, n] of counts) if (n > max) ((max = n), (best = t));
  return best;
}

/** Resolve an SFX timeline to playable sfx:// URLs — one sound per type
 *  (repeated), so a cadence reads as a deliberate rhythm. For the live
 *  preview. */
export function resolveSfxTimelineUrls(
  timeline: SfxTimelineEvent[],
): {
  ms: number;
  url: string;
  word: string;
  type: SfxType;
  sound?: string;
  volume?: number;
}[] {
  const cache = new Map<string, string | null>();
  const out: {
    ms: number;
    url: string;
    word: string;
    type: SfxType;
    sound?: string;
    volume?: number;
  }[] = [];
  for (const ev of timeline) {
    // A specific named sound resolves to that exact clip; else by bucket.
    const key = ev.sound ? `q:${ev.sound}` : `t:${ev.type}`;
    let p = cache.get(key);
    if (p === undefined) {
      p = ev.sound ? resolveSfxCue(ev.sound) : resolveSfxByType(ev.type);
      cache.set(key, p);
    }
    if (p) {
      out.push({
        ms: ev.ms,
        url: `sfx://files/${basename(p)}`,
        word: ev.word,
        type: ev.type,
        ...(ev.sound ? { sound: ev.sound } : {}),
        ...(typeof ev.volume === 'number' ? { volume: ev.volume } : {}),
      });
    }
  }
  return out;
}

interface CatalogRow {
  local_file: string;
  /** Human-readable name from the library index (for the agent + UI). */
  name: string;
  /** AudioSet label, when the offline index has one. */
  label: string | null;
  tokens: Set<string>;
  bucket: SfxType | null;
}

let CATALOG: CatalogRow[] | null = null;

function loadCatalog(): CatalogRow[] {
  if (CATALOG) return CATALOG;
  // slug -> { label, bucket } from the offline AudioSet index (optional).
  const bySlug = new Map<string, { label?: string; bucket?: SfxType }>();
  try {
    const labels = JSON.parse(readFileSync(LABELS_PATH, 'utf8')) as Record<
      string,
      { top?: string; bucket?: SfxType }
    >;
    for (const [slug, v] of Object.entries(labels)) {
      bySlug.set(slug, { label: v.top, bucket: v.bucket });
    }
  } catch {
    // No labels file -> degrade to name/slug-only matching.
  }
  try {
    const data = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as {
      entries?: { slug?: string; name?: string; local_file?: string }[];
    };
    CATALOG = (data.entries ?? [])
      .filter((e) => e.local_file)
      .map((e) => {
        const meta = e.slug ? bySlug.get(e.slug) : undefined;
        return {
          local_file: e.local_file as string,
          name: e.name ?? '',
          label: meta?.label ?? null,
          tokens: new Set([
            ...tokenize(e.name ?? ''),
            ...tokenize((e.slug ?? '').replace(/-\d+$/, '').replace(/-/g, ' ')),
            ...tokenize(meta?.label ?? ''),
          ]),
          bucket: meta?.bucket ?? null,
        };
      });
  } catch {
    CATALOG = [];
  }
  return CATALOG;
}

function pathIfExists(localFile: string): string | null {
  const p = join(AUDIO_DIR, localFile);
  return existsSync(p) ? p : null;
}

/** Best-matching local SFX mp3 path for a cue, or null if nothing matches.
 *  `typeHint` (e.g. the collection's dominant sfx_type) biases the
 *  bucket-fallback when the cue itself gives no acoustic hint. */
export function resolveSfxCue(
  cue: string | null | undefined,
  opts?: { typeHint?: SfxType; variant?: number },
): string | null {
  if (!cue || !cue.trim()) return null;
  const cueTokens = tokenize(cue);
  if (!cueTokens.length) return null;
  const catalog = loadCatalog();

  // (a) keyword token overlap against name + slug + AudioSet label.
  let best: CatalogRow | null = null;
  let bestScore = 0;
  for (const row of catalog) {
    let score = 0;
    for (const t of cueTokens) if (row.tokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (best && bestScore >= 1) {
    const p = pathIfExists(best.local_file);
    if (p) return p;
  }

  // (b) acoustic-bucket fallback: cue-inferred bucket, else the caller's
  //     typeHint. Pick the first clip the model labelled with that bucket.
  const bucket = cueToBucket(cueTokens) ?? opts?.typeHint ?? null;
  if (bucket) {
    const p = resolveSfxByType(bucket, opts?.variant ?? 0);
    if (p) return p;
  }
  return null;
}

/** Local SFX whose AudioSet bucket matches `type`, or null. `variant`
 *  rotates among the matching clips so repeated same-type cues (e.g. eight
 *  "vocal" shots) don't all get the identical file — deterministic per
 *  variant. Used by per-shot cue resolution + pattern-driven placement. */
export function resolveSfxByType(type: SfxType, variant = 0): string | null {
  const matches: string[] = [];
  for (const row of loadCatalog()) {
    if (row.bucket === type) {
      const p = pathIfExists(row.local_file);
      if (p) matches.push(p);
    }
  }
  if (matches.length === 0) return null;
  return matches[((variant % matches.length) + matches.length) % matches.length];
}

export interface SfxLibraryMatch {
  name: string;
  label: string | null;
  /** Keyword-overlap score against the query (higher = better). */
  score: number;
}

/** Search the full SFX library by free-text query, ranked by keyword overlap
 *  against each clip's name + slug + AudioSet label. Lets the agent discover
 *  specific sounds ("iphone message notification") and detect ambiguity. */
export function searchSfxLibrary(query: string, limit = 8): SfxLibraryMatch[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const scored: SfxLibraryMatch[] = [];
  for (const row of loadCatalog()) {
    if (!pathIfExists(row.local_file)) continue;
    let score = 0;
    for (const t of qTokens) if (row.tokens.has(t)) score++;
    if (score > 0) scored.push({ name: row.name, label: row.label, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
