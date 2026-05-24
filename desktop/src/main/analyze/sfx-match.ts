// SFX matching against a fingerprinted local library (myinstants).
//
// Fingerprint per clip = MFCC mean + MFCC std across all frames, after
// the same 3 kHz HPF used for SFX detection. 26-d vector. Matching is
// cosine similarity against every library entry — brute force is fine
// for O(1k) entries and stays simple/transparent. Both library and
// query share the SAME HPF + MFCC pipeline so the cosine space is
// consistent.
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { mfcc } from './mfcc';
import { highPass, SFX_HPF_CUTOFF_HZ } from './sfx';

/** Candidate locations checked in order when no explicit path is given.
 *  Covers tsx-from-desktop-cwd (dev) and built-from-out (prod). */
function candidateIndexPaths(): string[] {
  return [
    resolve(process.cwd(), 'resources/myinstants/index.json'),
    join(__dirname, '../../resources/myinstants/index.json'),
    join(__dirname, '../../../resources/myinstants/index.json'),
  ];
}

/** 16 kHz mono, matching the audio extraction pipeline. */
export const FP_SAMPLE_RATE = 16000;
/** Half-window around an onset to clip for fingerprinting (ms).
 *  Tight: ±150ms = 300ms total. Wider windows pull in voiceover from
 *  before/after the SFX and drown the MFCC summary. Most UGC SFX
 *  (dings, whooshes, stings) fit comfortably in 300ms. */
export const FP_HALF_WINDOW_MS = 150;
/** Window size (ms) for library-side "loudest region" extraction. The
 *  library fingerprint summarizes only this many ms around the file's
 *  energy peak — many myinstants files have leading silence or long
 *  decays that dilute the global mean+std. Matches the query window
 *  total duration so both sides see comparable amounts of audio. */
export const FP_LIBRARY_WINDOW_MS = 300;
/** 13 MFCC coefficients × {mean, std} = 26-d fingerprint. */
export const FP_DIM = 26;

export interface LibraryEntry {
  slug: string;
  name: string;
  source_mp3_url: string;
  source_page_url: string;
  local_file: string;
  /** 26-d fingerprint (13 MFCC means + 13 MFCC stds). Absent until the
   *  one-time fingerprinting script has been run on this entry. */
  fingerprint?: number[];
}

export interface LibraryIndex {
  source: string;
  crawled_at: string;
  page_url?: string;
  entries: LibraryEntry[];
}

export interface SfxMatch {
  slug: string;
  name: string;
  source_url: string;
  /** Cosine similarity in [-1, 1]. Higher = more similar. */
  similarity: number;
}

/** Compute the 26-d fingerprint of a mono float32 buffer at 16 kHz.
 *  Caller is responsible for handing in a slice of the right length —
 *  this function applies the HPF + MFCC + summarization. Returns null
 *  if the input is too short for any MFCC frame. */
export function computeFingerprint(samples: Float32Array): number[] | null {
  if (samples.length < 400) return null; // mfcc.FRAME_LEN ≈ 400
  const hpf = highPass(samples, SFX_HPF_CUTOFF_HZ, FP_SAMPLE_RATE);
  const { data, frames } = mfcc(hpf);
  if (frames === 0) return null;
  const numCep = data.length / frames;
  const sum = new Float64Array(numCep);
  const sumSq = new Float64Array(numCep);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numCep; c++) {
      const v = data[f * numCep + c];
      sum[c] += v;
      sumSq[c] += v * v;
    }
  }
  const out = new Array<number>(numCep * 2);
  for (let c = 0; c < numCep; c++) {
    const mean = sum[c] / frames;
    const variance = sumSq[c] / frames - mean * mean;
    out[c] = mean;
    out[numCep + c] = Math.sqrt(Math.max(variance, 0));
  }
  return out;
}

/** Cosine similarity between two equal-length vectors. */
function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Brute-force top-k cosine match of `query` against the library.
 *  Skips entries without a fingerprint (un-indexed). */
export function matchAgainstLibrary(
  query: number[],
  library: LibraryEntry[],
  topK = 3,
): SfxMatch[] {
  const scored: SfxMatch[] = [];
  for (const e of library) {
    if (!e.fingerprint || e.fingerprint.length !== query.length) continue;
    scored.push({
      slug: e.slug,
      name: e.name,
      source_url: e.source_page_url,
      similarity: cosine(query, e.fingerprint),
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

let cachedLibrary: LibraryIndex | null = null;
let cachedPath: string | null = null;

/** Load (and cache) the library index. Returns null if the index file
 *  doesn't exist — caller should treat that as "no matching available."
 *  Resolution order: explicit `indexPath` -> $SFX_LIBRARY_INDEX env ->
 *  cwd-relative `resources/myinstants/index.json` (dev) -> __dirname-
 *  relative (prod/built). The first existing one wins. */
export function loadLibrary(indexPath?: string): LibraryIndex | null {
  const candidates: string[] = [];
  if (indexPath) candidates.push(indexPath);
  if (process.env.SFX_LIBRARY_INDEX)
    candidates.push(process.env.SFX_LIBRARY_INDEX);
  candidates.push(...candidateIndexPaths());

  let path: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) {
      path = c;
      break;
    }
  }
  if (!path) {
    console.error(
      '[sfx-match] library index not found; tried:',
      candidates.join(', '),
    );
    return null;
  }
  if (cachedLibrary && cachedPath === path) return cachedLibrary;
  try {
    const lib = JSON.parse(readFileSync(path, 'utf-8')) as LibraryIndex;
    const indexed = lib.entries.filter((e) => e.fingerprint).length;
    console.error(
      `[sfx-match] library loaded: ${lib.entries.length} entries, ${indexed} fingerprinted (${path})`,
    );
    cachedLibrary = lib;
    cachedPath = path;
    return lib;
  } catch (err) {
    console.error(
      '[sfx-match] failed to load library:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Slice the reel sample buffer to the ±FP_HALF_WINDOW_MS window
 *  around an onset (in ms). */
export function sliceWindow(
  samples: Float32Array,
  onsetMs: number,
): Float32Array {
  const center = Math.round((onsetMs / 1000) * FP_SAMPLE_RATE);
  const halfN = Math.round((FP_HALF_WINDOW_MS / 1000) * FP_SAMPLE_RATE);
  const start = Math.max(0, center - halfN);
  const end = Math.min(samples.length, center + halfN);
  return samples.slice(start, end);
}

/** Find and return the contiguous `windowMs` region of the buffer with
 *  the highest mean RMS energy. Used to crop library fingerprint inputs
 *  to the "actual sound" portion of files that may have leading
 *  silence, padding, or long decays. Returns the whole buffer if it's
 *  shorter than the window. */
export function extractLoudestRegion(
  samples: Float32Array,
  sampleRate: number,
  windowMs: number,
): Float32Array {
  const windowSamples = Math.round((windowMs / 1000) * sampleRate);
  if (samples.length <= windowSamples) return samples;

  const FRAME = 512;
  const numFrames = Math.floor(samples.length / FRAME);
  if (numFrames === 0) return samples;
  const frameRms = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    const start = i * FRAME;
    for (let j = 0; j < FRAME; j++) {
      const v = samples[start + j];
      sum += v * v;
    }
    frameRms[i] = Math.sqrt(sum / FRAME);
  }

  const windowFrames = Math.max(
    1,
    Math.min(numFrames, Math.floor(windowSamples / FRAME)),
  );
  let curSum = 0;
  for (let i = 0; i < windowFrames; i++) curSum += frameRms[i];
  let bestSum = curSum;
  let bestStart = 0;
  for (let i = windowFrames; i < numFrames; i++) {
    curSum += frameRms[i] - frameRms[i - windowFrames];
    if (curSum > bestSum) {
      bestSum = curSum;
      bestStart = i - windowFrames + 1;
    }
  }

  const startSample = bestStart * FRAME;
  const endSample = Math.min(startSample + windowSamples, samples.length);
  return samples.slice(startSample, endSample);
}
