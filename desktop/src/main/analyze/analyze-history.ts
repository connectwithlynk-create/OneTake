// Analyze-tab history: a small newest-first index of reels analyzed via
// the Analyze tool. The heavy ReelAnalysisResult is NOT duplicated here —
// it lives in the shared .library/cache keyed by (url, ANALYSIS_VERSION),
// the same cache the library-hydration path uses. This file only holds
// lightweight metadata for rendering the history list and restoring an
// entry (re-resolve for a fresh playable URL + load the cached analysis).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { saveCachedAnalysis } from './library';
import type { ReelAnalysisResult } from './analyze';

const HISTORY_FILE = resolve(process.cwd(), '.library', 'analyze-history.json');
const MAX_ENTRIES = 60;

export interface AnalyzeHistoryEntry {
  url: string;
  platform: string;
  duration_ms: number;
  width: number | null;
  height: number | null;
  caption_text: string | null;
  /** Spoken or on-screen hook, for the list preview. */
  hook: string | null;
  shot_count: number;
  /** Epoch ms of the most recent analysis of this URL. */
  analyzed_at: number;
}

/** Metadata + analysis to record. The analysis is written to the shared
 *  cache; everything else is distilled into the history entry. */
export interface RecordAnalysisInput {
  url: string;
  platform: string;
  duration_ms: number;
  width: number | null;
  height: number | null;
  caption_text: string | null;
  analysis: ReelAnalysisResult;
  /** Epoch ms; passed from the renderer so this stays a pure write. */
  analyzed_at: number;
}

function readHistory(): AnalyzeHistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(parsed) ? (parsed as AnalyzeHistoryEntry[]) : [];
  } catch (err) {
    console.error(
      '[analyze-history] read failed:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

function writeHistory(entries: AnalyzeHistoryEntry[]): void {
  try {
    mkdirSync(resolve(process.cwd(), '.library'), { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error(
      '[analyze-history] write failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Newest-first list of analyzed reels. */
export function listAnalyzeHistory(): AnalyzeHistoryEntry[] {
  return readHistory();
}

/** Persist the analysis to the shared cache and upsert a history entry.
 *  Re-analyzing an existing URL moves it to the top with a fresh
 *  timestamp (deduped by URL — the list is "recently analyzed reels",
 *  not an append-only log). */
export function recordAnalysis(input: RecordAnalysisInput): AnalyzeHistoryEntry[] {
  saveCachedAnalysis(input.url, input.analysis);
  const entry: AnalyzeHistoryEntry = {
    url: input.url,
    platform: input.platform,
    duration_ms: input.duration_ms,
    width: input.width,
    height: input.height,
    caption_text: input.caption_text,
    hook: input.analysis.hook_speech || input.analysis.hook_text,
    shot_count: input.analysis.shots.length,
    analyzed_at: input.analyzed_at,
  };
  const next = [
    entry,
    ...readHistory().filter((e) => e.url !== input.url),
  ].slice(0, MAX_ENTRIES);
  writeHistory(next);
  return next;
}

/** Drop a URL from the history index. The cached analysis blob is left
 *  on disk (harmless, and makes re-adding instant). */
export function deleteAnalyzeHistory(url: string): AnalyzeHistoryEntry[] {
  const next = readHistory().filter((e) => e.url !== url);
  writeHistory(next);
  return next;
}
