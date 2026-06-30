// Media curator — entry point.
//
// Takes a SuggestedEdit (the synthesis plan) and runs the per-shot
// research agent across all shots. Returns a CurationResult that an
// editor agent / renderer can consume to actually place media.
import type { ShotPlan, SuggestedEdit } from '../analyze/synthesize';
import {
  researchLibrary,
  researchShot,
  type CuratorClarificationRequest,
  type CuratorTurnEvent,
  type ResearchResult,
} from './agent';
import { rewriteShotIdea } from './rewrite-shot';
import { autoCaptureCuration } from './auto-capture';
import { filterLibraryRelevance, filterShotRelevance } from './relevance';
import { resolveShotOverlays } from './overlay-curate';
import { extractDirectVideoFromPage } from './tools';
import type { ScrollStyle } from './web-record';
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
const UNIQUE_RETRY_LIMIT = 2;

function canonicalSourceKey(c: MediaCandidate): string {
  const raw = c.source_page || c.url;
  try {
    const u = new URL(raw);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.trim().replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  }
}

function appendNote(notes: string, note: string): string {
  return notes.trim() ? `${notes.trim()} ${note}` : note;
}

function pruneRepeatedSources(shots: ShotCuration[]): ShotCuration[] {
  const seenExact = new Set<string>();

  return shots.map((shot) => {
    const kept: MediaCandidate[] = [];
    const deferred: MediaCandidate[] = [];
    const localSeen = new Set<string>();

    for (const c of shot.candidates) {
      const key = canonicalSourceKey(c);
      if (!key || localSeen.has(key)) continue;
      localSeen.add(key);

      const alreadySeen = seenExact.has(key);

      // Deduplicate exact pages only. Different pages on the same domain
      // can both be useful library items; hiding them here makes the UI look
      // empty after agents finish.
      if (!alreadySeen) kept.push(c);
      else deferred.push(c);
    }

    const finalCandidates = kept;
    for (const c of finalCandidates) {
      const key = canonicalSourceKey(c);
      if (key) seenExact.add(key);
    }

    return {
      ...shot,
      candidates: finalCandidates,
      research_notes:
        deferred.length > 0 && kept.length > 0
          ? `${shot.research_notes} Filtered repeated obvious sources across library slots.`
          : shot.research_notes,
      alternatives: shot.alternatives?.map((alt) => {
        const altSeen = new Set<string>();
        return {
          ...alt,
          candidates: alt.candidates.filter((c) => {
            const key = canonicalSourceKey(c);
            if (!key || altSeen.has(key) || seenExact.has(key)) return false;
            altSeen.add(key);
            return true;
          }),
        };
      }),
    };
  });
}

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
  /** Streaming partial updates for a shot BEFORE it completes — fired
   *  as soon as research lands (candidates committed, footage not yet
   *  captured) and again after EACH candidate's auto-capture finishes
   *  (recording / screenshots filled in). The UI can show footage the
   *  moment it's collected instead of waiting for the shot's whole
   *  capture + overlay chain. The final onShotComplete for the same
   *  shot supersedes every partial. */
  onShotPartial?: (curation: ShotCuration, idx: number, total: number) => void;
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
  /** Automatically gather a screen recording + screenshots from each
   *  shot's committed (top) page/video output, with no approval prompt.
   *  Default true. Set false to skip (e.g. fast test runs). */
  autoCapture?: boolean;
  /** Optional bulk regeneration guidance applied to every shot agent. */
  extraUserPrompt?: string;
  /** Ask host/user how a page should scroll before auto-recording it. */
  onScrollBehavior?: (input: {
    shot_idx: number;
    url: string;
    title?: string | null;
    broll_description: string;
    spoken_during: string;
  }) => Promise<ScrollStyle | null>;
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
  const reservedSourceKeys = new Set<string>();

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

  function reserveUniqueCandidates(curation: ShotCuration): {
    curation: ShotCuration;
    removed: string[];
  } {
    const localSeen = new Set<string>();
    const removed: string[] = [];
    const candidates: MediaCandidate[] = [];

    for (const candidate of curation.candidates) {
      const key = canonicalSourceKey(candidate);
      if (!key || localSeen.has(key) || reservedSourceKeys.has(key)) {
        if (key) removed.push(key);
        continue;
      }
      localSeen.add(key);
      candidates.push(candidate);
    }

    for (const candidate of candidates) {
      const key = canonicalSourceKey(candidate);
      if (key) reservedSourceKeys.add(key);
    }

    return {
      curation: {
        ...curation,
        candidates,
        research_notes:
          removed.length > 0
            ? appendNote(
                curation.research_notes,
                `Skipped ${removed.length} duplicate URL${removed.length === 1 ? '' : 's'} already used in the library.`,
              )
            : curation.research_notes,
        failure_reason:
          candidates.length === 0 && curation.candidates.length > 0
            ? 'duplicate_urls_rejected'
            : curation.failure_reason,
      },
      removed,
    };
  }

  function uniquenessRetryPrompt(): string {
    const banned = Array.from(reservedSourceKeys).slice(-30);
    return [
      'CURATE LIBRARY UNIQUENESS RETRY.',
      'Your previous candidates duplicated URL(s) already used by another library slot, so they were rejected before recording.',
      'Find different URLs/pages for this subtitle beat. Do not return any exact URL below.',
      'Prefer a different page or domain when possible; avoid the homepage/top profile if already used.',
      banned.length > 0 ? `Already used URLs:\n${banned.map((u) => `- ${u}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
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
  for (const result of results) {
    if (!result) continue;
    for (const candidate of result.candidates) {
      const key = canonicalSourceKey(candidate);
      if (key) reservedSourceKeys.add(key);
    }
  }

  // Phase 1: reel-level library research. ONE agent run sees every shot
  // still needing media and curates the whole library in a single pass —
  // diversity (no duplicate / near-identical sources across shots) is
  // planned in-context instead of patched post-hoc with uniqueness
  // retries. The per-shot worker loop below then captures + finalizes
  // each shot, falling back to per-shot research only for beats the
  // library left empty (or when the library run failed entirely).
  let libraryAssignments: Map<number, MediaCandidate[]> | null = null;
  let libraryNotes = '';
  let libraryTrace: AgentTrace | null = null;
  {
    const researchShots = plan.shots.filter(
      (shot, i) =>
        !results[i] && shot.asset?.method !== 'library_search',
    );
    if (researchShots.length > 0 && !options.signal?.aborted) {
      const lib = await researchLibrary(plan, researchShots, {
        onTurn: options.onTurn,
        signal: options.signal,
        extraUserPrompt: options.extraUserPrompt,
        onClarification: options.onClarification,
      });
      usage.input_tokens += lib.usage.input_tokens;
      usage.output_tokens += lib.usage.output_tokens;
      usage.total_tokens += lib.usage.total_tokens;
      if (lib.assignments.size > 0) {
        // Relevance gate: drop candidates that are clearly about a
        // different subject / unrelated to their beat. Shots emptied by
        // the gate fall through to per-shot gap-fill research below.
        const gated = await filterLibraryRelevance(
          plan,
          lib.assignments,
          options.signal,
        );
        libraryAssignments = gated;
        libraryNotes = lib.research_notes;
        libraryTrace = lib.trace;
        console.error(
          `[curate] library run assigned candidates to ${gated.size} of ${researchShots.length} shots` +
            (gated.size < lib.assignments.size
              ? ` (${lib.assignments.size - gated.size} shot(s) emptied by the relevance gate)`
              : ''),
        );
      } else {
        console.error(
          '[curate] library run produced no assignments',
          lib.failure_reason ? `(${lib.failure_reason})` : '',
          '— falling back to per-shot research',
        );
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
      // Footage-first: when the plan fulfills this shot from the user's
      // own footage (asset.method === 'library_search'), there is nothing
      // for the web-research agent to find — the media is the user's
      // library. Skip the agent loop entirely (it would otherwise burn a
      // full research run treating the query as a web target) and only
      // resolve the shot's overlay layers, which are still web assets.
      if (originalShot.asset?.method === 'library_search') {
        const resolvedOverlays =
          options.autoCapture !== false &&
          originalShot.has_overlay &&
          originalShot.additional_elements.length > 0
            ? await resolveShotOverlays(
                originalShot.additional_elements,
                options.signal,
              )
            : null;
        const stub: ShotCuration = {
          shot_idx: originalShot.shot_idx,
          research_notes:
            'Fulfilled by your own footage (library_search) — web research skipped.',
          candidates: [],
          library_fulfilled: true,
          ...(resolvedOverlays ? { resolved_overlays: resolvedOverlays } : {}),
        };
        results[idx] = stub;
        traces[idx] = {
          shot_idx: originalShot.shot_idx,
          turns: [],
          final_text: '',
          finished_at_turn: 0,
          reason: 'completed',
          tokens: { input: 0, output: 0, total: 0 },
        };
        completed++;
        if (options.onShotComplete) {
          options.onShotComplete(stub, completed, total);
        }
        continue;
      }
      // Library-first: take this shot's candidates from the reel-level
      // library run when it assigned any; fall back to a per-shot
      // research agent only for beats the library left empty.
      const assigned =
        libraryAssignments?.get(originalShot.shot_idx) ?? null;
      let finalCuration: ShotCuration;
      let finalTrace: AgentTrace;
      // Latest session conversation for this shot — handed up via the
      // optional onShotInput so the main process can stash it for the
      // "Edit result" continue flow. Library-fulfilled shots have no
      // per-shot session (the library run is shared), so this stays
      // empty for them and "Edit result" falls back to regenerate.
      let finalInput: ResearchResult['final_input'] = [];
      if (assigned && assigned.length > 0) {
        finalCuration = {
          shot_idx: originalShot.shot_idx,
          research_notes: libraryNotes
            ? `Reel-level library curation: ${libraryNotes}`
            : 'Reel-level library curation.',
          candidates: assigned,
        };
        finalTrace = libraryTrace
          ? { ...libraryTrace, shot_idx: originalShot.shot_idx }
          : {
              shot_idx: originalShot.shot_idx,
              turns: [],
              final_text: '',
              finished_at_turn: 0,
              reason: 'completed',
              tokens: { input: 0, output: 0, total: 0 },
            };
      } else {
        const initial = await researchShot(originalShot, plan, {
          onTurn: options.onTurn,
          signal: options.signal,
          extraUserPrompt: options.extraUserPrompt,
          onClarification: options.onClarification,
        });
        // Relevance gate — an all-dropped result reads as a failed shot
        // below, so the rewrite machinery rescues it with a new idea.
        finalCuration = await filterShotRelevance(
          plan,
          originalShot,
          initial.curation,
          options.signal,
        );
        finalTrace = initial.trace;
        finalInput = initial.final_input;
        usage.input_tokens += initial.usage.input_tokens;
        usage.output_tokens += initial.usage.output_tokens;
        usage.total_tokens += initial.usage.total_tokens;
      }

      let rewrittenShot: ShotPlan | null = null;

      if (!options.signal?.aborted && shotWarned(finalCuration)) {
        const reason =
          finalCuration.failure_reason ??
          'curator returned no usable candidates';
        const rewritten = await rewriteShotIdea(originalShot, plan, reason, {
          signal: options.signal,
        });
        if (rewritten) {
          rewrittenShot = rewritten;
          const retry = await researchShot(rewritten, plan, {
            onTurn: options.onTurn,
            signal: options.signal,
            extraUserPrompt: options.extraUserPrompt,
            onClarification: options.onClarification,
          });
          usage.input_tokens += retry.usage.input_tokens;
          usage.output_tokens += retry.usage.output_tokens;
          usage.total_tokens += retry.usage.total_tokens;
          // Use the retry result (relevance-gated too), but stamp it
          // with the original shot_idx so the plan↔curation mapping
          // stays intact.
          const gatedRetry = await filterShotRelevance(
            plan,
            rewritten,
            retry.curation,
            options.signal,
          );
          finalCuration = { ...gatedRetry, shot_idx: originalShot.shot_idx };
          finalTrace = { ...retry.trace, shot_idx: originalShot.shot_idx };
          // The retry's conversation REPLACES the original's — that's
          // what "continue" should pick up from.
          finalInput = retry.final_input;
        }
      }

      // Before capture, reserve globally unique page/video URLs. The old
      // pruning step ran after auto-capture, so duplicate pages could still
      // get recorded for multiple shots. If a slot only found URLs already
      // used elsewhere, re-run it with an explicit banned URL list.
      for (let retryCount = 0; retryCount <= UNIQUE_RETRY_LIMIT; retryCount++) {
        const reserved = reserveUniqueCandidates(finalCuration);
        finalCuration = reserved.curation;
        if (
          finalCuration.candidates.length > 0 ||
          reserved.removed.length === 0 ||
          options.signal?.aborted ||
          retryCount === UNIQUE_RETRY_LIMIT
        ) {
          break;
        }

        const retryShot = rewrittenShot ?? originalShot;
        const retry = await researchShot(retryShot, plan, {
          onTurn: options.onTurn,
          signal: options.signal,
          extraUserPrompt: [options.extraUserPrompt, uniquenessRetryPrompt()]
            .filter((s): s is string => Boolean(s && s.trim()))
            .join('\n\n'),
          onClarification: options.onClarification,
        });
        usage.input_tokens += retry.usage.input_tokens;
        usage.output_tokens += retry.usage.output_tokens;
        usage.total_tokens += retry.usage.total_tokens;
        finalCuration = { ...retry.curation, shot_idx: originalShot.shot_idx };
        finalTrace = { ...retry.trace, shot_idx: originalShot.shot_idx };
        finalInput = retry.final_input;
      }

      if (finalInput.length > 0 && options.onShotInput) {
        options.onShotInput(originalShot.shot_idx, finalInput);
      }

      // Post-process: turn page URLs into directly-playable video
      // URLs by extracting og:video from the page server-side.
      const enriched = await enrichWebVideoCandidates(finalCuration);
      // Stream the researched candidates to the UI right away (no
      // footage yet), then again as each candidate's capture lands.
      let partialSnapshot: ShotCuration = {
        ...enriched,
        ...(rewrittenShot ? { rewritten_shot: rewrittenShot } : {}),
      };
      if (options.onShotPartial && !options.signal?.aborted) {
        options.onShotPartial(partialSnapshot, idx, total);
      }
      // Auto-capture: gather a recording + screenshots from the committed
      // (top) page/video outputs, no approval prompt. Best-effort and
      // gated by the autoCapture option (default on).
      const captureShot = rewrittenShot ?? originalShot;
      const captured =
        options.autoCapture === false
          ? enriched
          : await autoCaptureCuration(enriched, {
              shot_idx: originalShot.shot_idx,
              broll_description: captureShot.broll_description,
              spoken_during: captureShot.spoken_during,
              shot_duration_ms: captureShot.duration_ms,
              signal: options.signal,
              onScrollBehavior: options.onScrollBehavior,
              onCandidateCaptured: (candidate, candidateIdx) => {
                if (!options.onShotPartial || options.signal?.aborted) return;
                partialSnapshot = {
                  ...partialSnapshot,
                  candidates: partialSnapshot.candidates.map((c, i) =>
                    i === candidateIdx ? candidate : c,
                  ),
                };
                options.onShotPartial(partialSnapshot, idx, total);
              },
            });
      // Auto-curate the shot's media overlays (the ones synthesis assigned
      // from the overlay pattern) into real web assets — best-effort, web
      // only, no generation. Skipped when the shot has no overlay or
      // autoCapture is off.
      const resolvedOverlays =
        options.autoCapture !== false &&
        captureShot.has_overlay &&
        captureShot.additional_elements.length > 0
          ? await resolveShotOverlays(
              captureShot.additional_elements,
              options.signal,
            )
          : null;
      const withRewrite: ShotCuration = {
        ...captured,
        ...(rewrittenShot ? { rewritten_shot: rewrittenShot } : {}),
        ...(resolvedOverlays ? { resolved_overlays: resolvedOverlays } : {}),
      };
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

  const prunedResults = pruneRepeatedSources(results);

  return {
    shots: prunedResults,
    traces,
    usage,
    duration_ms: Date.now() - t0,
  };
}
