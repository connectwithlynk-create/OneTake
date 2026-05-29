// Media curator — entry point.
//
// Takes a SuggestedEdit (the synthesis plan) and runs the per-shot
// research agent across all shots. Returns a CurationResult that an
// editor agent / renderer can consume to actually place media.
import type { ShotPlan, SuggestedEdit } from '../analyze/synthesize';
import {
  researchShot,
  type CuratorClarificationRequest,
  type CuratorTurnEvent,
} from './agent';
import { rewriteShotIdea } from './rewrite-shot';
import { extractDirectVideoFromPage } from './tools';
import type {
  AgentTrace,
  CurationResult,
  MediaCandidate,
  ShotCuration,
} from './types';

export { continueShot, researchShot } from './agent';
export type { ResearchResult } from './agent';
export type { CuratorTurnEvent, CuratorClarificationRequest } from './agent';
export type {
  AgentTrace,
  AgentTurn,
  AlternativeShot,
  MediaCandidate,
  MediaSource,
  ShotCuration,
  CurationResult,
} from './types';

const DEFAULT_CONCURRENCY = 4;

/** Quick heuristics — is this URL already playable inline (no need
 *  to scrape a page for a direct file)? */
function isPlayableVideoUrl(url: string): boolean {
  if (/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(url)) return true;
  if (/(?:youtube\.com|youtu\.be|player\.vimeo\.com|vimeo\.com\/video)/i.test(url)) {
    return true;
  }
  return false;
}

async function enrichCandidate(c: MediaCandidate): Promise<MediaCandidate> {
  if (c.source !== 'web_video') return c;
  if (isPlayableVideoUrl(c.url)) return c;
  const extracted = await extractDirectVideoFromPage(c.url);
  if (!extracted) return c;
  return {
    ...c,
    source_page: c.source_page ?? c.url,
    url: extracted.video_url,
    thumbnail_url: extracted.thumbnail_url ?? c.thumbnail_url ?? null,
  };
}

/** Replace candidate.url with the direct video file when the URL is
 *  a page (Pexels, news article, etc.) that contains an og:video or
 *  <video> tag. Applies to both primary and alternative candidates. */
async function enrichWebVideoCandidates(
  curation: ShotCuration,
): Promise<ShotCuration> {
  const enriched = await Promise.all(curation.candidates.map(enrichCandidate));
  const enrichedAlts = curation.alternatives
    ? await Promise.all(
        curation.alternatives.map(async (alt) => ({
          ...alt,
          candidates: await Promise.all(alt.candidates.map(enrichCandidate)),
        })),
      )
    : undefined;
  return { ...curation, candidates: enriched, alternatives: enrichedAlts };
}

export interface CurateOptions {
  /** Per-shot agents run in parallel up to this limit. Each shot's
   *  agent makes multiple OpenAI API calls; high concurrency hits
   *  rate limits. Default 4. */
  concurrency?: number;
  /** Per-shot progress callback. Surfaces partial progress so a long
   *  curation run isn't silent. */
  onShotComplete?: (curation: ShotCuration, idx: number, total: number) => void;
  /** Per-turn callback fired during each shot's agent loop. Lets the
   *  UI display live activity (e.g., "shot 3 turn 4/16: fetch_page
   *  ycombinator.com"). */
  onTurn?: (event: CuratorTurnEvent) => void;
  /** Per-shot callback fired with the agent's final conversation
   *  input (system + user + all tool calls / results / model outputs)
   *  after each shot completes. Main process stores this so the
   *  "Edit result" UI can call continueShot() with the same session
   *  context instead of running a fresh agent loop. */
  onShotInput?: (shotIdx: number, input: unknown[]) => void;
  /** Called when any shot's agent calls ask_user_clarification. The
   *  host (main process) surfaces the question to the user and
   *  resolves with their picked option. See ResearchShotOptions for
   *  full semantics. */
  onClarification?: (
    req: CuratorClarificationRequest,
  ) => Promise<{ answer: string }>;
  /** Cancellation. When aborted, in-flight OpenAI calls reject and
   *  the worker loop stops launching new shots. Already-completed
   *  shots are kept; not-yet-started shots are left with a stub
   *  ShotCuration marked failure_reason='aborted'. */
  signal?: AbortSignal;
  /** Per-shot results from a prior partial run. Shots whose index has
   *  a populated entry here (non-empty candidates, not aborted) are
   *  COPIED THROUGH instead of being re-researched — so the user can
   *  curate a few shots individually and then hit "curate all" to
   *  fill in the rest without redoing what already worked. */
  existingResults?: CurationResult | null;
}

/** Run the per-shot research agent across every shot in the plan. */
export async function curate(
  plan: SuggestedEdit,
  options: CurateOptions = {},
): Promise<CurationResult> {
  const t0 = Date.now();
  const total = plan.shots.length;
  const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const results: ShotCuration[] = new Array(total);
  const traces: AgentTrace[] = new Array(total);
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  /** A shot "warned" when the curator agent flagged it as a failure
   *  or returned zero usable candidates. Those are the slots the user
   *  wants auto-rescued — we ask the LLM for a fresher, more findable
   *  shot idea and re-run research on the new idea. */
  function shotWarned(c: ShotCuration): boolean {
    if (c.failure_reason) return true;
    return c.candidates.length === 0;
  }

  /** A prior result is "reusable" when it has at least one candidate
   *  and isn't an aborted stub. We DON'T reuse failed shots because
   *  the user almost certainly clicked "curate all" hoping to retry. */
  function isReusable(c: ShotCuration | undefined): c is ShotCuration {
    if (!c) return false;
    if (c.failure_reason === 'aborted') return false;
    return c.candidates.length > 0;
  }

  // Seed results from any reusable prior entries so the worker loop
  // can skip them. Also seed the corresponding traces.
  const existing = options.existingResults;
  if (existing) {
    for (let i = 0; i < total; i++) {
      const shotIdx = plan.shots[i].shot_idx;
      const prior = existing.shots.find((s) => s.shot_idx === shotIdx);
      if (isReusable(prior)) {
        results[i] = prior;
        const priorTrace = existing.traces?.find(
          (t) => t?.shot_idx === shotIdx,
        );
        if (priorTrace) traces[i] = priorTrace;
      }
    }
  }

  let next = 0;
  let completed = 0;
  async function worker(): Promise<void> {
    while (next < total) {
      if (options.signal?.aborted) return;
      const idx = next++;
      if (results[idx]) {
        // Reused from existingResults — skip the agent call but still
        // fire onShotComplete so the renderer sees it.
        completed++;
        if (options.onShotComplete) {
          options.onShotComplete(results[idx], completed, total);
        }
        continue;
      }
      const originalShot = plan.shots[idx];
      const initial = await researchShot(originalShot, plan, {
        onTurn: options.onTurn,
        signal: options.signal,
        onClarification: options.onClarification,
      });
      const { curation, usage: u, trace } = initial;
      // Latest session conversation for this shot — handed up via the
      // optional onShotInput so the main process can stash it for the
      // "Edit result" continue flow.
      let finalInput = initial.final_input;
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      usage.total_tokens += u.total_tokens;

      let finalCuration: ShotCuration = curation;
      let finalTrace = trace;
      let rewrittenShot: ShotPlan | null = null;

      if (!options.signal?.aborted && shotWarned(curation)) {
        const reason =
          curation.failure_reason ?? 'curator returned no usable candidates';
        const rewritten = await rewriteShotIdea(originalShot, plan, reason, {
          signal: options.signal,
        });
        if (rewritten) {
          rewrittenShot = rewritten;
          const retry = await researchShot(rewritten, plan, {
            onTurn: options.onTurn,
            signal: options.signal,
            onClarification: options.onClarification,
          });
          usage.input_tokens += retry.usage.input_tokens;
          usage.output_tokens += retry.usage.output_tokens;
          usage.total_tokens += retry.usage.total_tokens;
          // Use the retry result, but stamp it with the original
          // shot_idx so the plan↔curation mapping stays intact.
          finalCuration = { ...retry.curation, shot_idx: originalShot.shot_idx };
          finalTrace = { ...retry.trace, shot_idx: originalShot.shot_idx };
          // The retry's conversation REPLACES the original's — that's
          // what "continue" should pick up from.
          finalInput = retry.final_input;
        }
      }

      if (finalInput.length > 0 && options.onShotInput) {
        options.onShotInput(originalShot.shot_idx, finalInput);
      }

      // Post-process: turn page URLs into directly-playable video
      // URLs by extracting og:video from the page server-side.
      const enriched = await enrichWebVideoCandidates(finalCuration);
      const withRewrite: ShotCuration = rewrittenShot
        ? { ...enriched, rewritten_shot: rewrittenShot }
        : enriched;
      results[idx] = withRewrite;
      traces[idx] = finalTrace;
      completed++;
      if (options.onShotComplete) {
        options.onShotComplete(withRewrite, completed, total);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, total) }, worker),
  );

  // Backfill any unstarted-due-to-abort slots so downstream code doesn't
  // hit undefined entries. Already-completed shots are preserved.
  for (let i = 0; i < total; i++) {
    if (!results[i]) {
      results[i] = {
        shot_idx: plan.shots[i].shot_idx,
        research_notes: '(aborted before this shot ran)',
        candidates: [],
        failure_reason: 'aborted',
      };
      traces[i] = {
        shot_idx: plan.shots[i].shot_idx,
        turns: [],
        final_text: '',
        finished_at_turn: 0,
        reason: 'api_error',
        tokens: { input: 0, output: 0, total: 0 },
      };
    }
  }

  return {
    shots: results,
    traces,
    usage,
    duration_ms: Date.now() - t0,
  };
}
