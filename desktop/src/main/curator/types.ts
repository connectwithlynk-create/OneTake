// Public types for the media research / curation agent.
//
// The curator takes a SuggestedEdit (the synthesis plan) and, per shot,
// runs a research agent that devises a plan to find concrete media
// candidates (image URLs, video URLs with optional timestamps, or
// generated images) that match the shot's intent.
//
// Output is a CurationResult — one ShotCuration per shot with 2-5
// candidates and the agent's research_notes explaining its strategy.
import type { ShotPlan } from '../analyze/synthesize';

export type MediaSource =
  | 'web_image'      // image URL found via web search / page fetch
  | 'web_video'      // video URL (often YouTube / Vimeo / direct .mp4)
  | 'web_page'       // a page to be screen-recorded (when method=web_capture)
  | 'generated_image' // OpenAI-generated synthetic image
  | 'user_provided'   // resolved from a passed library inventory item
  | 'unresolved';     // agent couldn't find anything — render as placeholder

export interface MediaCandidate {
  source: MediaSource;
  /** Direct URL to the media (image, video, or page). */
  url: string;
  /** Thumbnail preview when available. */
  thumbnail_url?: string | null;
  /** The page where the agent discovered this media (provenance /
   *  attribution). For web_image / web_video. */
  source_page?: string | null;
  /** Human title (image alt, video title, page title) when known. */
  title?: string | null;
  /** Image / video dimensions when known. */
  width?: number | null;
  height?: number | null;
  /** Video duration in ms when known. */
  duration_ms?: number | null;
  /** For long videos: timestamp(s) the agent identified as relevant
   *  (e.g., where founders are on screen together). */
  recommended_segment_ms?: { start_ms: number; end_ms: number } | null;
  /** Agent's rationale: why this candidate fits the shot. */
  notes?: string | null;
}

/** An alternative shot concept the agent surfaces when the primary
 *  broll_description couldn't be filled with strong candidates. The
 *  visual idea is different but still appropriate for the spoken
 *  context, so the editor can pick which direction to go. */
export interface AlternativeShot {
  /** A different b-roll idea from the shot's primary broll_description,
   *  still appropriate to the shot's spoken_during content. */
  broll_description: string;
  /** Why this is a reasonable fallback. */
  rationale: string;
  /** Candidates the agent found for this alternative idea. */
  candidates: MediaCandidate[];
}

export interface ShotCuration {
  shot_idx: number;
  /** Brief summary of the agent's research plan and findings for
   *  this shot. Surfaces decisions like "searched for X, found Y,
   *  picked Z because…". */
  research_notes: string;
  /** Ranked best-first list of media candidates for the shot's
   *  primary broll_description. Typically 2-5. */
  candidates: MediaCandidate[];
  /** Backup shot concepts when the primary brol_description came up
   *  short on candidates. Each alternative is a different visual idea
   *  with its own candidate list. Empty / undefined when the primary
   *  was filled well. */
  alternatives?: AlternativeShot[];
  /** When the agent exhausted its plan without finding any usable
   *  media (primary AND alternatives), this captures why. */
  failure_reason?: string | null;
  /** When the original shot idea failed (failure_reason set or empty
   *  candidates), the curator auto-rewrote it into a more-acquirable
   *  idea and re-ran research. This is the rewritten ShotPlan; its
   *  broll_description / asset / source_type are the new ones, while
   *  timing and structure_role are preserved from the original. */
  rewritten_shot?: ShotPlan | null;
}

/** One round-trip with the model during a shot's research. Captures
 *  what the model said (reasoning + final answer text), every custom
 *  function tool it called (with both arguments and the result we
 *  sent back), and how many built-in web_search calls OpenAI ran. */
export interface AgentTurn {
  turn_idx: number;
  /** Concatenated text from this turn's message items. Empty when
   *  the turn produced only tool calls. */
  message_text: string;
  /** Custom function tool calls (fetch_page, generate_image) the
   *  model made this turn. Each carries the model's args JSON and
   *  the JSON-stringified result we returned. */
  function_calls: Array<{
    name: string;
    arguments: string;
    result: string;
  }>;
  /** OpenAI's built-in web_search calls fired this turn. Queries are
   *  not directly exposed by the SDK so we just count them. */
  web_search_calls: number;
}

export interface AgentTrace {
  shot_idx: number;
  turns: AgentTurn[];
  /** Final JSON text the model emitted (the parsed shape lives in
   *  ShotCuration; this is the raw record). */
  final_text: string;
  /** Turn at which the agent finished (could be < MAX_TURNS for
   *  early exits or === MAX_TURNS for max-out). */
  finished_at_turn: number;
  reason: 'completed' | 'max_turns_reached' | 'api_error';
  /** Total tokens this shot's agent burned (subset of CurationResult.usage). */
  tokens: { input: number; output: number; total: number };
}

export interface CurationResult {
  shots: ShotCuration[];
  /** Full agent traces per shot for visibility / replay. Indexed
   *  parallel to shots; one trace per shot. */
  traces: AgentTrace[];
  /** Total LLM token usage across all per-shot agent runs (input,
   *  output, total). Surfaces cost. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  /** Wall-clock time spent on curation. */
  duration_ms: number;
  /** True when this result was loaded from disk cache, not freshly
   *  curated. */
  from_cache?: boolean;
}
