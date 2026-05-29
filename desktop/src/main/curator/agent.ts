// Per-shot research agent loop.
//
// Given a shot from the synthesis plan, the agent reasons about WHAT
// media is needed and HOW to find it, then iteratively calls tools
// (web_search built into OpenAI, fetch_page + record_url as custom
// Playwright-backed functions) until it has 2-5 concrete media
// candidates. AI image generation is intentionally NOT available —
// real-world media only.
//
// Uses OpenAI's Responses API for the agent loop because it supports
// the built-in web_search tool out of the box — no separate search
// API key required, single OPENAI_API_KEY drives everything.
//
// Loop pattern:
//   1. responses.create({ input: [system, user], tools })
//   2. If output has function_call items: execute them, append
//      function_call_output items to input, repeat.
//   3. When output has only text / message items: parse the final
//      JSON, return ShotCuration.
import OpenAI from 'openai';
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
  Tool,
} from 'openai/resources/responses/responses';
import type { ShotPlan, SuggestedEdit } from '../analyze/synthesize';
import {
  fetchPage,
  recordUrl,
  tavilySearch,
  type ScrollSegment,
  type ScrollStyle,
} from './tools';
import { isVideoHostUrl } from './web-record';
import type {
  AgentTrace,
  AgentTurn,
  MediaCandidate,
  ShotCuration,
} from './types';

const MODEL = 'gpt-4o-mini';
/** Pure safety cap to prevent a model bug from looping forever. Not
 *  intended as a budget — the user explicitly wants no max-turns
 *  constraint, so this is set high enough that any normal research
 *  chain (10-20 turns) finishes well below it. If you ever see a
 *  shot reach this number, the model is malfunctioning. */
const SAFETY_TURN_CAP = 200;

interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** Per-turn snapshot of what the agent did. Emitted to the UI so the
 *  user sees live activity instead of waiting for the final result.
 *  tool_calls includes both custom functions (fetch_page, record_url)
 *  and OpenAI's built-in web_search calls.
 *
 *  Each turn fires TWICE: once before tool execution (result_summary
 *  unset — "fetching X…"), once after (result_summary populated —
 *  "fetching X → 404"). The renderer keys by (shot_idx, turn) and the
 *  second emission replaces the first, so failures surface inline. */
export interface CuratorTurnEvent {
  shot_idx: number;
  turn: number;
  total_turns: number;
  tool_calls: Array<{
    name: string;
    summary: string;
    /** Short summary of the tool's return value once it has been
     *  executed — populated on the second emission for the turn.
     *  Examples: "5 results", "matches=true score=0.87",
     *  "FAILED: auth_wall_redirect". */
    result_summary?: string;
  }>;
  /** True on the turn where the model returned text without any more
   *  tool calls — agent is done with this shot. */
  finished: boolean;
}

/** Clarification request emitted when the agent calls
 *  `ask_user_clarification`. The host (main process) is expected to
 *  surface this to the user and return their picked answer. */
export interface CuratorClarificationRequest {
  shot_idx: number;
  question: string;
  options: string[];
  reason: string;
}

/** One-line summary of a tool's RESULT, for the live activity feed.
 *  Pulls the key success / failure signal from each tool's return JSON
 *  so the user can see "fetched X → 404" without opening the trace. */
function summarizeResult(name: string, outputJson: string): string {
  try {
    const r = JSON.parse(outputJson) as Record<string, unknown>;
    if (typeof r.error === 'string' && r.error) {
      return `FAILED: ${r.error.slice(0, 80)}`;
    }
    if (name === 'tavily_search') {
      if (r.blocked) {
        return `BLOCKED: ${String(r.block_reason ?? 'unknown')}`;
      }
      const results = Array.isArray(r.results) ? r.results.length : 0;
      return `${results} result${results === 1 ? '' : 's'}`;
    }
    if (name === 'fetch_page') {
      if (r.ok === false) {
        return `FAILED: ${String(r.error ?? 'unknown')}`;
      }
      const score = r.content_match_score;
      const matches = r.matches_expected;
      const imgs = Array.isArray(r.images) ? r.images.length : 0;
      const vids = Array.isArray(r.videos) ? r.videos.length : 0;
      const scorePart =
        typeof score === 'number'
          ? ` matches=${matches ? 'yes' : 'NO'} score=${score.toFixed(2)}`
          : '';
      return `${imgs} img, ${vids} vid${scorePart}`;
    }
    if (name === 'record_url') {
      if (r.ok === false) {
        return `FAILED: ${String(r.error ?? 'unknown')}`;
      }
      const dur = typeof r.duration_ms === 'number' ? r.duration_ms / 1000 : 0;
      const score = r.content_match_score;
      const scorePart =
        typeof score === 'number' ? ` (match ${score.toFixed(2)})` : '';
      return `recorded ${dur.toFixed(1)}s${scorePart}`;
    }
    if (name === 'ask_user_clarification') {
      const ans = typeof r.answer === 'string' ? r.answer : '';
      if (!ans) return 'user did not respond';
      return `user picked: ${ans.slice(0, 60)}`;
    }
    if (name === 'request_record_approval') {
      if (r.approved === true) return 'APPROVED';
      if (r.approved === false) return 'DENIED';
      return 'pending';
    }
    // Fallback: short JSON-ish blurb.
    return Object.keys(r).slice(0, 3).join(',') || 'ok';
  } catch {
    return outputJson.slice(0, 60);
  }
}

function summarizeArgs(name: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    if (name === 'tavily_search') {
      return `"${String(args.query ?? '')}"`;
    }
    if (name === 'fetch_page') {
      return String(args.url ?? '');
    }
    if (name === 'record_url') {
      const url = String(args.url ?? '');
      const segs = Array.isArray(args.scroll_segments)
        ? args.scroll_segments.length
        : 0;
      const scrollPart =
        segs > 0
          ? `${segs} segment${segs === 1 ? '' : 's'}`
          : String(args.scroll ?? 'smooth');
      const dur = args.duration_seconds
        ? ` (${args.duration_seconds}s ${scrollPart} 9:16 mobile)`
        : '';
      return url + dur;
    }
    if (name === 'ask_user_clarification') {
      const q = String(args.question ?? '').slice(0, 80);
      return q || '(empty question)';
    }
    if (name === 'request_record_approval') {
      return String(args.url ?? '').slice(0, 80);
    }
    return JSON.stringify(args).slice(0, 80);
  } catch {
    return '';
  }
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

// ---------- tool schemas ----------

const TOOLS: Tool[] = [
  // Built-in OpenAI web search — opaque to us (model calls it, OpenAI
  // executes it transparently). Useful as a last-resort fallback when
  // both scrape backends are blocked.
  { type: 'web_search_preview' },
  {
    type: 'function',
    name: 'tavily_search',
    description:
      "PRIMARY discovery tool. Hits the Tavily search API — a real, bot-friendly search service (no scraping, no captchas, no IP-block roulette) and returns the top organic results as { title, url, snippet } objects. Snippets are already LLM-ready (de-boilerplated, sized for direct reading). ALWAYS call this BEFORE fetch_page or record_url on any URL you don't already have from a prior search result — guessing URLs from training data (twitter.com/<handle>, techcrunch.com/<slug>, prnewswire.com/<id>) produces 404s. Include the subject's name in every query (e.g., 'Vori grocery POS', 'Vori 22 million funding TechCrunch'). Returns blocked=true with a block_reason on missing API key / transient network error; fall back to web_search.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The search query. Include the subject name + a specific qualifier (page type, topic, year). Example: "Vori founder Brandon Hill LinkedIn", "Vori grocery POS press release 2022".',
        },
        num_results: {
          type: 'number',
          description:
            'How many results to return (default 10, max 20). Use the default unless you need many results for a broad scan.',
        },
      },
      required: ['query', 'num_results'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'fetch_page',
    description:
      "Fetch a URL and return its title, a 2000-char text excerpt, lists of image URLs and video URLs (direct .mp4/.webm plus embedded YouTube/Vimeo iframes), and a content_match_score + matches_expected derived from comparing your expected_content against the rendered page. ALSO returns `sections` — a sorted list of section descriptors ({ label, position_fraction, height_fraction }) detected in the rendered DOM. These are AVAILABLE for the rare case you're planning a cinematic scroll_segments timeline (see SCROLL_SEGMENTS rules in the system prompt); ignore them for most shots. The URL MUST come from a prior tavily_search / web_search result or a prior fetch_page response — never guess. Returns ok:false with an error when the URL is dead (http_404 / 5xx) or an auth wall. ALWAYS pass expected_content so the tool can catch same-domain wrong-subject pages (e.g., a similar Twitter handle that exists but belongs to someone else, a Wikipedia page about a different person with the same name).",
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to fetch.' },
        expected_content: {
          type: 'string',
          description:
            "Short description of what the page SHOULD be about — typically the SUBJECT's name plus a topic / role qualifier (e.g., 'Vori grocery POS company homepage', 'Vori founder Brandon Hill profile', 'TechCrunch article about Vori 22M funding'). DO NOT describe layout / visual structure (BAD: 'homepage hero section and logo', 'product banner with header') — pages don't literally say 'this is the hero section', so those tokens will never match and tank the score. Write SUBJECT KEYWORDS the actual page text would mention. The tool computes a keyword-overlap score against the rendered title + body and sets matches_expected=true when score >= 0.25. If matches_expected is false the page is almost certainly NOT about the subject you wanted — DO NOT extract media from it; pick a different result. Pass an empty string only when you genuinely have no expected content (rare).",
        },
      },
      required: ['url', 'expected_content'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'record_url',
    description:
      "URL-to-video recorder (the real screen-recording tool). ALWAYS records at 9:16 in mobile view (iPhone-class viewport, isMobile=true, iOS Safari UA, DPR=3) and ALWAYS captures a clean source — no zoom, no pan, no effects. Camera moves are an editor-side concern that gets layered in downstream; do not try to do them here. Launches Playwright Chromium, navigates to the URL, dismisses cookie / consent walls, waits for the page to be visually settled, then records the page's mobile layout. On success: returns recording_path + recording_url (capture:// URL usable in <video src=>) + duration_ms + consent_dismissed + content_match_score (informational only, doesn't gate the recording).",
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute URL to record.',
        },
        duration_seconds: {
          type: 'number',
          description:
            'Recording length in seconds. Pick something close to the shot duration_ms (so the editor has enough footage without over-recording). Range: 3-30.',
        },
        scroll: {
          type: 'string',
          enum: [
            'smooth',
            'linear',
            'ease-in',
            'ease-out',
            'stepped',
            'reverse',
            'hold',
          ],
          description:
            'Single-style scroll, used ONLY when scroll_segments is an empty array. smooth = standard scroll reveal; hold = no scroll (static page); stepped = pause-scroll-pause like reading; reverse = start at bottom and scroll up.',
        },
        expected_content: {
          type: 'string',
          description:
            'One short sentence (~5-15 words) of SUBJECT KEYWORDS the page text actually contains (e.g., "Vori grocery POS startup homepage", "Vori founder Brandon Hill biography", "TechCrunch article about Vori $22M funding"). DO NOT describe the recording or layout — BAD: "homepage hero section and logo", "8s smooth scroll of marketing page", "product banner with header". The reason: the page never literally says "I am the hero section" / "8s scroll", so those tokens score zero. Use the SUBJECT and TOPIC that would appear in the rendered text. After user approval the internal threshold check is skipped, but the score is still reported on the result for visibility — write good keywords anyway so the score is informative. Pass an empty string only if you want NO content scoring on the result.',
        },
        scroll_segments: {
          type: 'array',
          description:
            "OPTIONAL cinematic scroll timeline. DEFAULT IS EMPTY — pass [] for most recordings (single-screen pages, articles, videos, short shots, anything with <3 distinct sections). Reach for a non-empty timeline ONLY when the page is multi-section marketing content AND the shot is >=8s AND the spoken_during has multiple beats that benefit from landing on different sections. BANNED PATTERN: never pass generic thirds like [{scroll_to:0},{scroll_to:0.5},{scroll_to:1}] — those aim at whitespace, not content. The recorder REJECTS scroll_segments whose scroll_to values don't match real section positions (within ±0.08) detected on the page, returning the live sections list so you can rebuild. When non-empty: each scroll_to MUST come from fetch_page's `sections[].position_fraction` for THIS url. Each segment animates to `scroll_to` over `travel_ms`, then HOLDS for `hold_ms`. travel_ms=0 = instant jump. Total travel+hold should fit inside duration_seconds*1000 minus ~2s. Example for a rich SaaS homepage at 10s with sections at 0, 0.30, 0.55: [ { scroll_to: 0, travel_ms: 0, hold_ms: 2500 }, { scroll_to: 0.30, travel_ms: 1500, hold_ms: 2500 }, { scroll_to: 0.55, travel_ms: 1500, hold_ms: 2000 } ].",
          items: {
            type: 'object',
            properties: {
              scroll_to: {
                type: 'number',
                description:
                  'Target position as a fraction of the page\'s scrollable height. 0 = very top (hero), 0.5 = middle, 1 = bottom. Values outside [0,1] are clamped.',
              },
              travel_ms: {
                type: 'number',
                description:
                  'How long (ms) to animate from the previous position to scroll_to. Use 0 for an instant jump. Typical values: 1200-2500 for smooth reveal-style moves.',
              },
              hold_ms: {
                type: 'number',
                description:
                  'How long (ms) to stay at scroll_to before moving on. 0 = no hold (move straight to next segment). Typical values: 800-2500ms depending on how much content needs to register.',
              },
            },
            required: ['scroll_to', 'travel_ms', 'hold_ms'],
            additionalProperties: false,
          },
        },
      },
      required: [
        'url',
        'duration_seconds',
        'scroll',
        'expected_content',
        'scroll_segments',
      ],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'request_record_approval',
    description:
      "MANDATORY pre-flight check before every record_url call. Surfaces the URL + your planned approach to the user, who replies yes/no. Returns { approved: true|false, user_answer: string }. If approved=false, DO NOT call record_url for this URL — refine your search, pick a different URL, and call request_record_approval again. You may only call record_url ONCE per shot, and only on a URL that was just approved here. Recording is expensive — this gate exists so the user controls what actually gets captured.",
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The EXACT URL you intend to pass to record_url. The downstream guard rejects record_url unless its url argument matches this string character-for-character.',
        },
        approach_description: {
          type: 'string',
          description:
            'One sentence describing what the recording will visually contain + the scroll / aspect / behavior you picked. Example: "8s smooth scroll of the Vori homepage at 9:16, behavior=static — captures hero headline, product mock, and pricing band."',
        },
        why_this_url: {
          type: 'string',
          description:
            'One sentence on why THIS URL specifically matches the shot\'s intent and the subject. The user reads this to decide approve / deny — be concrete, not generic.',
        },
      },
      required: ['url', 'approach_description', 'why_this_url'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'ask_user_clarification',
    description:
      "Pause and ask the user to disambiguate when you are genuinely confused — DO NOT use this to delegate research. Valid triggers: (a) two candidate URLs from search results are equally plausible for the SAME tier and you can't pick on signal alone (e.g., two LinkedIn profiles with the same name, two Wikipedia disambiguation pages, two GitHub orgs); (b) the SUBJECT itself is ambiguous from the transcript (the transcript says 'the founder' but two people are plausibly the founder); (c) fetched pages give conflicting signals about who/what the subject is. Forbidden triggers: scroll style / aspect / behavior (those come from synthesis), trivial choices you can resolve with one more search, or any case where you haven't run a single search yet. Limit: AT MOST 2 clarifications per shot — if you've already asked once and got an answer, only ask again on a fundamentally different fork.",
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            "The question to show the user. ONE sentence, specific, and self-contained — they're looking at it without the agent's research context. Good: \"Which 'Brandon Hill' is the Vori founder?\" Bad: \"Which LinkedIn URL?\" (too vague).",
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The 2-4 concrete options the user can pick from. Each option is the FULL choice as the user sees it — typically the candidate URL + a short label (e.g., "https://linkedin.com/in/bhill-vori — Vori (San Francisco)" vs "https://linkedin.com/in/brandonhill-uk — UK consultant"). NEVER include an "I don\'t know" option; if you genuinely have no candidates, run more searches.',
        },
        reason: {
          type: 'string',
          description:
            'ONE sentence explaining WHY you\'re stuck — what signal you\'d normally use to disambiguate but can\'t here (e.g., "Both profiles list software engineer roles and neither mentions Vori explicitly").',
        },
      },
      required: ['question', 'options', 'reason'],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ---------- prompt ----------

const SYSTEM_PROMPT = `You are a media research agent. Your job: for a single shot of a short-form vertical reel, find 2-5 concrete media candidates (URLs to real images, real videos, or generated images) that match the shot's intent.

Process:
0. IDENTIFY THE SUBJECT. Read the full target transcript context (provided in the user message) and pin down WHO / WHAT the reel is about — the named company, product, person, or topic. Name it explicitly to yourself before searching. The SUBJECT is the constant across every shot; the shot's local spoken_during ("they raised 22 million") makes no sense without the subject ("Vori raised 22 million").
1. UNDERSTAND THE INTENT. Read the shot's broll_description, source_type, structure_role, and what's spoken during this shot. Identify what specifically needs to be visible AS APPLIED TO THE SUBJECT — a logo (of the subject), a person (the subject's founder / spokesperson), a place (the subject's office / venue), a screen recording (of the subject's website / press), etc.
2. PLAN. Decide what searches and fetches will get you there. Don't just run a single search — chain searches and page fetches when needed (search for the SUBJECT + qualifier → find their company page → fetch the team page → extract photo URLs).
3. EXECUTE. Start with tavily_search (real API, bot-friendly, no captcha) — returns concrete title/url/snippet triples. Use the built-in web_search only as a last resort when tavily_search is blocked (missing API key / transient network error). Then use fetch_page to load a candidate page from your search results in a real browser and extract its real visible text + real image URLs + real video URLs (handles SPAs, dismisses cookie walls, detects auth walls), and record_url to produce a real mp4 video recording of a web_capture target. NEVER hand fetch_page or record_url a URL that didn't appear in a search result.
4. EVALUATE. Pick 2-5 candidates ranked best-first. Each candidate should be a concrete URL the editor can actually use. Prefer same-subject hits; when Tier 1 (exact) fails, walk DOWN the IMPROVISATION LADDER (see below) before giving up.

There is NO TURN LIMIT on this loop. Take as many tool calls as you need to ground every candidate in real, subject-matching content. Don't shortcut.

WHEN TO ASK THE USER FOR HELP — confused, don't guess:
When you genuinely cannot decide between candidates on signal alone, STOP and call ask_user_clarification instead of guessing. Guessing on ambiguity produces wrong-subject candidates, which is the worst possible outcome.

  Valid triggers — DO ask the user:
    1. Two candidate URLs from search results are equally plausible for the SAME tier and you can't pick on signal alone. Example: search returns linkedin.com/in/brandonhill-vori AND linkedin.com/in/brandonhill-uk — both are real people, both are software engineers, neither bio explicitly says "Vori grocery POS." A coin flip is wrong.
    2. The SUBJECT itself is ambiguous from the transcript. Example: the transcript says "the founder built it" but the company has two co-founders named in different sources — which one is the speaker referring to?
    3. Fetched pages give CONFLICTING signals. Example: fetch_page on the company's homepage says "founded by A and B" but a TechCrunch article says "founded by A, C, D" — which set is canonical for this shot?

  Invalid triggers — DO NOT ask:
    - Scroll style, aspect ratio, behavior — those come from synthesis. Take them from the shot's placement / asset.camera_move and do not consult the user.
    - You haven't run a single search yet. Search first; ask only after the ambiguity survives real evidence.
    - One more search would resolve it. If a slightly different query ("Brandon Hill Vori site:linkedin.com") would disambiguate, run THAT, don't ask.
    - You have zero candidates. Walk the IMPROVISATION LADDER, don't ask. Asking implies "I have multiple plausible options"; "I have none" is a search problem.
    - You're tired / the shot is hard. Effort cost is not a reason.

  Limit: at most 2 clarifications per shot. If you've already asked once and got an answer, only ask again on a fundamentally different fork. Repeated asking burns user trust. NOTE: request_record_approval (described below) does NOT count toward this 2-call cap — it is a separate mandatory pre-flight check, not a discretionary clarification.

  ask_user_clarification schema:
    question — ONE specific sentence. Bad: "Which URL?" Good: "Which 'Brandon Hill' is the Vori founder?"
    options — 2-4 concrete picks. Each is the URL the user will pick PLUS a short disambiguator: "https://linkedin.com/in/brandonhill-vori — engineer in San Francisco" vs "https://linkedin.com/in/brandonhill-uk — UK consultant". NEVER include "I don't know" — if you have no candidates, search more.
    reason — ONE sentence on WHY you're stuck: what signal you'd normally use but can't here.

  After getting an answer, treat it as authoritative for the rest of this shot and proceed to fetch_page / record_url with the chosen URL.

RECORD_URL DISCIPLINE — at-most-once + user-approved:
record_url is the only EXPENSIVE tool you have (it launches a browser and writes mp4 to disk). The user wants tight control over what actually gets recorded. Two hard rules, both enforced in code:

  1. Call request_record_approval(url, approach_description, why_this_url) BEFORE every record_url. The tool surfaces the URL + your planned approach to the user; they answer yes or no.
     - approved=true → call record_url IMMEDIATELY (same turn or the very next turn) on the EXACT url you had approved. The code guard checks string equality.
     - approved=false → DO NOT call record_url for this URL. Either run more search / fetch_page to find a different URL and call request_record_approval again on the new one, OR commit a candidate with source="web_page" (no recording) and finish the shot.
     - Calling record_url without a prior matching approval returns error="record_url_requires_prior_approval" and does NOT record. This is a code-level guard; do not try to bypass it.

  2. Only ONE SUCCESSFUL record_url per shot. A successful recording (result.ok=true) exhausts the budget — any subsequent call returns error="record_url_already_called_for_this_shot". A FAILED recording (result.ok=false: auth_wall_redirect, http_404, no_video_object, etc.) is retriable, but EVERY retry requires a fresh request_record_approval call first (the previous approval is consumed on every attempt, success or failure). This gives the user a chance to redirect you to a different URL before you bash the same broken one twice.
     - Recommended flow on failure: read the error field, decide whether the failure is fixable (e.g., a transient network blip vs. a hard auth wall). If fixable: call request_record_approval again for the same URL with a brief note in approach_description about retrying. If not fixable (auth wall, 404): pick a different URL via search/fetch_page and request approval for the NEW url.
     - If retries keep failing or the page is fundamentally unrecordable (login-walled, paywalled), stop retrying and commit a candidate with source="web_page" using the URL — the editor can still link to the page even without a recording. Or drop down the IMPROVISATION LADDER.
     - Once user-approved, the record_url tool skips its internal expected_content keyword threshold (the user already validated the URL — that heuristic was for the unapproved path). You still pass expected_content so the score lands in the result for diagnostics, but it never blocks.

  Approval flow worked example:
    tavily_search "Vori grocery POS homepage" → returns https://vori.com
    fetch_page(url="https://vori.com", expected_content="Vori grocery POS company homepage") → matches_expected=true, score=0.91. ALSO returns sections=[
      { label: "Grocery POS system built to protect margins and grow sales", position_fraction: 0.0,  height_fraction: 0.18 },
      { label: "Trusted by leading independent grocers across the country", position_fraction: 0.18, height_fraction: 0.10 },
      { label: "Replace fragile integrations with one connected system",     position_fraction: 0.30, height_fraction: 0.22 },
      { label: "How smart grocers run their stores",                          position_fraction: 0.55, height_fraction: 0.20 },
      { label: "footer",                                                       position_fraction: 0.92, height_fraction: 0.08 },
    ]
    request_record_approval(url="https://vori.com", approach_description="10s recording: hold hero, scroll to integrations section, hold for product mock, then to 'how smart grocers run' for the proof. Skipping footer.", why_this_url="...") → user approves
    record_url(url="https://vori.com", duration_seconds=10, scroll="smooth", expected_content="Vori grocery POS startup", scroll_segments=[
      { scroll_to: 0.0,  travel_ms: 0,    hold_ms: 2500 },
      { scroll_to: 0.30, travel_ms: 1500, hold_ms: 2500 },
      { scroll_to: 0.55, travel_ms: 1500, hold_ms: 2000 },
    ]) → recorded at 9:16 mobile with cinematic timeline driven by real section positions

SCROLL_SEGMENTS — situational, not default:
Default is scroll_segments=[] with a single \`scroll\` style. Reach for segments ONLY when the shot has a clear cinematic intent that the simple single-style scroll wouldn't serve — and never on pages where it adds nothing.

BANNED PATTERN — DO NOT GUESS POSITIONS:
scroll_segments=[ { scroll_to: 0 }, { scroll_to: 0.5 }, { scroll_to: 1 } ] (and any other "generic thirds / quarters / halves" layout) is BANNED. Those values aim at whatever happens to be at the top, middle, and bottom — which is usually whitespace or the boundary between sections, NOT the interesting content. The recorder enforces this at runtime: if any scroll_to doesn't match a real section's position_fraction (within ±0.08) detected on the loaded page, record_url returns ok:false with error="scroll_segments_dont_match_page_sections" and includes the actual sections list so you can rebuild. Do not iterate by guessing closer — read fetch_page's \`sections\` array and use those numbers.

REQUIREMENT when scroll_segments is non-empty:
You MUST have called fetch_page on this URL earlier in the conversation and you MUST source every scroll_to value from a section.position_fraction in that response. Don't invent intermediate positions; if you want to land between two sections, use the actual section position closest to your intent. If you don't have a fetch_page response with sections for this URL, either (a) call fetch_page first or (b) pass scroll_segments=[] and use the single 'scroll' style.

  USE scroll_segments when ALL three are true:
   - The page is multi-section marketing / product content with 3+ distinct blocks (hero, feature grid, testimonials, pricing, CTA — typical SaaS/startup homepage shape).
   - The shot is long enough to give each section its own beat (typically >= 8s).
   - The spoken_during has multiple ideas you'd want different sections to land on (e.g., "they raised 22M, built a POS for grocery, and got Y Combinator backing" → hero, product, YC logos).

  DO NOT USE scroll_segments when ANY of these:
   - Single-screen page (logo only, hero only, app store badge, profile page).
   - Article / blog / Wikipedia / TechCrunch piece — these benefit from a smooth top-to-bottom reveal, not stops.
   - YouTube / Vimeo / video player URLs — no scrolling at all (use scroll='hold').
   - Image gallery / Pinterest-style pages — one smooth scroll is fine.
   - Pages with only 1-2 sections (use 'smooth' or 'hold').
   - Short recordings (< 6s) — not enough time for cinematic beats.
   - You're not sure — default to scroll_segments=[] and pick a single scroll style.

  When you DO use segments, scrape them — don't guess:
   fetch_page returns a \`sections\` array with { label, position_fraction, height_fraction } for every meaningful block. Use those fractions verbatim — don't make up positions. Pick 2-4 of them ordered top→bottom, skipping noise (newsletter signup, cookie disclaimers that survived dismissal). Map each section.position_fraction → segment.scroll_to. Hero / first segment: travel_ms=0, hold_ms 2000-3000. Subsequent segments: travel_ms 1200-2000, hold_ms calibrated to height_fraction (bigger section → longer hold). Sum should be roughly duration_seconds*1000 minus ~2s settle/tail.

Default mental model: "simple scroll is fine" — proven, predictable, web-recorder-style. Segments are a tool for when the shot genuinely earns the extra complexity.

URL DISCIPLINE — non-negotiable:
Most "broken URL" failures come from the model inventing plausible-looking paths from training data (e.g., guessing "https://twitter.com/SUBJECT" or "https://techcrunch.com/2022/06/23/SUBJECT-raises-22m" or "https://www.crunchbase.com/organization/SUBJECT" without verifying). Stop doing this.

  1. NEVER call fetch_page OR record_url on a URL you got from your own head, EXCEPT when BOTH search backends (tavily_search and web_search) have returned blocked / empty for this shot AND you're walking the WHEN SEARCH IS BLOCKED ladder (see below). In the normal case, every URL you act on MUST have come from a search result or a prior fetch_page response. Inventing URLs from training data is the #1 cause of 404s.
  2. ALWAYS run tavily_search BEFORE the first fetch_page / record_url for a shot, unless you already have a verified URL from a prior shot's research in this same agent run. Search query must include the SUBJECT's name + a specific qualifier (page type / topic / year). Escalate to the built-in web_search ONLY when tavily_search returns blocked=true.
  3. Search tools return { title, url, snippet } objects. Pick a URL from those results — DO NOT modify the path, DO NOT swap the domain, DO NOT "complete" a URL you partially remember. If the exact URL you wanted isn't in the results, run another search with a different query, OR drop a tier down the ladder.
  4. After search returns URLs, the SAFE order is: fetch_page (cheap, verifies the page exists and contains expected content) THEN record_url (expensive, produces the actual mp4). Skip fetch_page only when the URL is from a domain you trust will render (subject's homepage, YC company page, Wikipedia article you saw in search results) OR when it's a video-host URL (YouTube / Vimeo / Loom / Streamable / Wistia / Dailymotion / v.redd.it / Instagram / TikTok / Facebook — see the VIDEO HOST PASSTHROUGH rule below; fetch_page short-circuits these with video_host_passthrough). NEVER skip for x.com, twitter.com URLs — those are auth-walled for logged-out web visitors and require fetch_page verification first.
  5. Common failure modes the tools now catch and report — when you see them, DO NOT retry the same URL, switch to a different URL FROM YOUR SEARCH RESULTS:
     - http_404 / http_410 / http_5xx → URL is dead; pick from another search result
     - auth_wall_redirect / auth_wall_text_detected → page wants login; pick a public source (see SOURCE PREFERENCE below)
     - not_found_text_detected → URL serves a custom 404 page; pick another result
     - expected_content_not_found → record_url page text didn't match your expected_content; either your expected_content was wrong or the URL is wrong — refine and try a different URL
     - matches_expected = false on a fetch_page response → THE URL LOADED A REAL PAGE BUT IT'S NOT ABOUT YOUR SUBJECT. This is the "wrong twitter handle / same name different person" case: twitter.com/vori_life might be a Vietnamese lifestyle blogger, not the Vori grocery POS startup; wikipedia.org/wiki/Vori might be a Greek island. When matches_expected is false, DO NOT extract media from the page, DO NOT call record_url on it — pick a different result from your search and try again.
  6. If fetch_page returns 404 for a URL you invented, the correct response is "run tavily_search now," NOT "guess another similar-looking URL." Two invented URLs in a row is an error pattern; break out of it by searching.
  7. ALWAYS pass a specific expected_content to fetch_page — at minimum "<subject name> <one qualifier>" (e.g., "Vori grocery POS homepage", "Vori founder Brandon Hill"). An empty expected_content disables the wrong-subject check; only do that when you genuinely have no subject anchor (almost never for Tier 1-4).
  8. If two retries on the same shot fail for different URLs from real search results, drop down the IMPROVISATION LADDER instead of trying a third URL of the same kind.

SOURCE PREFERENCE — auth-walled vs public:
The recorder cannot get past real login walls OR "view in app" overlays. Treat these as LIKELY-BLOCKED and only try them when no public alternative exists for the same content:
  - linkedin.com (redirects to /authwall after a few seconds, returns auth_wall_redirect)
  - x.com / twitter.com (redirects to /i/flow/login for most content; only the homepage of an account works partially)
  - any *.medium.com paywall article

APP-WALL URLS — even more reliably blocked than login walls:
The following URL patterns serve a "View this post in the app" overlay to all logged-out web visitors. The page loads (HTTP 200) but the actual content is gated behind an "Open in App" button. THE RECORDER WILL REJECT THESE — record_url returns ok:false with error="auth_wall_text_detected" or "auth_wall_redirect" — but you should not even propose them in the first place:
  - twitter.com/<user>/status/* , x.com/<user>/status/* (individual post URLs; profile homepage sometimes works)

NEVER skip fetch_page on a URL from these domains — they are NOT trusted-render domains. If fetch_page returns auth_wall_text_detected or matches_expected=false, immediately move to a different source. If you're tempted to put one of these URLs into request_record_approval, STOP — record_url will reject it. Find the same content on the subject's own website or in a public press article instead.

(Instagram, TikTok, and Facebook URLs are handled differently — see the VIDEO HOST PASSTHROUGH rule below. They're committed directly as source="web_video" candidates without fetch_page / approval / record_url.)

Prefer these PUBLIC alternatives, in order:
  1. Subject's own website (the domain that owns the brand)
  2. Crunchbase / Wikipedia / Wikidata
  3. Y Combinator company directory (for YC startups)
  4. GitHub (for tech companies / founders)
  5. Public press articles (TechCrunch, WSJ, NYT, Bloomberg, official press releases)
  6. YouTube (most videos load logged-out — but NOT YouTube Shorts, those wall the same way IG reels do)
  7. Government / academic / institutional pages
If you DO try an auth-walled or app-walled domain and get back auth_wall_redirect / auth_wall_text_detected, immediately switch to a public alternative — don't keep retrying with different paths on the same blocked domain.

TOOL CHOICE GUIDE:
- tavily_search: PRIMARY discovery tool. Real search API (Tavily) — bot-friendly, no captcha, no IP block roulette. Returns { title, url, snippet }. Call this FIRST every shot. Always include the subject's name in the query. Snippets are LLM-ready (pre-extracted from page bodies). Only returns blocked=true on missing API key or transient network error.
- web_search: LAST-RESORT discovery tool — OpenAI's built-in search. Opaque (you can't see raw URLs back). Use only when tavily_search returned blocked=true.
- fetch_page: load a URL in stealth Playwright Chromium (same engine as record_url), wait for full settle, auto-dismiss cookies, detect auth walls. Returns the rendered title, visible body text, real visible images (filtered to >=64px, no tracking pixels), real video / embed URLs, AND a matches_expected boolean derived from your expected_content vs the rendered title + text. Returns ok:false with an error when the URL is an auth wall or 404 — switch to a different URL FROM SEARCH RESULTS when that happens. ALWAYS pass expected_content (subject name + qualifier) — that's what catches the same-handle-wrong-entity case. Use this to EVALUATE a candidate page before committing it. The URL passed here MUST come from a search result or a prior fetch_page response.

  Wrong-subject worked example (Vori grocery POS):
    tavily_search "Vori grocery POS Twitter" → results include https://twitter.com/vori_life
    fetch_page(url="https://twitter.com/vori_life", expected_content="Vori grocery POS startup founder")
      → returns title="Profile / X", text mentions "Vietnamese lifestyle", matches_expected=false, score 0.05
      → DO NOT use any media from this page. Run another tavily_search ("Vori grocery POS founder X profile") or drop down a tier.
- record_url: same Playwright pipeline as fetch_page but additionally records a real mp4 video. ALWAYS records at 9:16 in mobile view, and ALWAYS captures a clean source — no zoom, no pan, no Ken-Burns moves. Camera moves are an editor-side concern that gets layered in downstream after the recording lands; do not attempt to do them at capture time. AT MOST ONCE SUCCESSFUL PER SHOT, AND ONLY AFTER request_record_approval RETURNS approved=true FOR THE EXACT SAME URL — see the RECORD_URL DISCIPLINE section above. ALWAYS pass expected_content — a short sentence of subject keywords the page text contains — so the score lands on the result for diagnostics. The URL MUST come from a search result or a prior fetch_page response. Pick:
    * duration_seconds — close to the shot's duration_ms (round up by ~2s). Range 3-30.
    * scroll AND scroll_segments — the recorder picks ONE of the two:
        - If scroll_segments is EMPTY: the recorder uses the single \`scroll\` style for the whole recording. Good for short pages and "just smoothly scroll through it" shots. Styles: 'smooth' for marketing sites with scroll-revealed content; 'hold' for static logos / single-product / one-screen pages (NO scroll); 'stepped' for long article pages where you want pause-scroll-pause; 'reverse' if the most visually-interesting content is below the fold; 'linear'/'ease-in'/'ease-out' for finer control.
        - If scroll_segments is NON-EMPTY: it OVERRIDES \`scroll\` and runs a cinematic timeline. Each segment animates to \`scroll_to\` (0=top, 1=bottom) over \`travel_ms\`, then HOLDS for \`hold_ms\`. Use this when the page has distinct sections worth pausing on (hero → feature grid → testimonial → CTA), or when the spoken_during has beats that should land on specific content. Total travel+hold should fit inside duration_seconds*1000 minus ~2s for settle+tail; slack auto-extends the final hold. Example for a 10s recording with three beats: [ { scroll_to: 0, travel_ms: 0, hold_ms: 2500 }, { scroll_to: 0.5, travel_ms: 1500, hold_ms: 2500 }, { scroll_to: 1, travel_ms: 1500, hold_ms: 1000 } ].
        When unsure: pass scroll='smooth' and scroll_segments=[] for the default behavior. Reach for segments when the shot has a clear cinematic intent the agent has read from the spoken_during.
    NOTE on aspect: the synthesis plan's placement.aspect may say 16:9, 4:5, 1:1, etc., but record_url always captures at 9:16 mobile. The editor handles cropping / fitting the 9:16 mp4 into whatever target frame the placement requires.
    NOTE on camera moves: if the synthesis plan's asset.camera_move says "zoom in" / "pan right" / etc., IGNORE that for record_url — the editor will apply the move when it composes the final reel. Your job is to deliver a clean recording.
    VIDEO HOST PASSTHROUGH — DO NOT call fetch_page, request_record_approval, OR record_url for these:
    For URLs on YouTube (watch / youtu.be / embed), Vimeo, Loom, Streamable, Wistia, Dailymotion, v.redd.it, Instagram (reel / reels / p / tv / stories / profile), TikTok (any @user/video URL or vm.tiktok.com link), Facebook (facebook.com/*, m.facebook.com/*, fb.watch/*), the agent SKIPS the entire recording pipeline. These are committed directly as MediaCandidate entries with source="web_video" and url=<the URL>. The editor handles rendering them via embed / iframe / native player at composition time. All three tools (fetch_page, request_record_approval, record_url) short-circuit on these hosts with error="video_host_passthrough" — calling any of them on an ig/tiktok/facebook/youtube URL is a wasted turn.
    Workflow:
      web_capture URL (marketing page, article, etc.) → fetch_page → request_record_approval → record_url → candidate with capture:// recording_url
      video host URL (YouTube / Vimeo / Loom / Streamable / Wistia / Dailymotion / v.redd.it / Instagram / TikTok / Facebook) → commit candidate IMMEDIATELY with source="web_video", url=<the URL>, source_page=<the URL>, title=<from search snippet>. NO fetch_page, NO approval, NO record_url.
    (Reminder: twitter|x.com/y/status URLs are NOT in this list — they're STILL blocked at the auth-wall layer and aren't usable as either recordings or passthroughs.)
- ask_user_clarification: pause and ask the user to disambiguate between equally-plausible candidates. Only call when the WHEN TO ASK section's valid triggers fire. Returns { answer: <one of the options> } as the function output; treat the returned option as authoritative.
- request_record_approval: MANDATORY pre-flight check before record_url. Surfaces { url, approach_description, why_this_url } to the user, who picks yes or no. Returns { approved: true|false, user_answer: string }. Do NOT call record_url unless this returned approved=true for the EXACT same URL — code-level guard rejects mismatched record_url calls.
- AI image / video generation: NOT AVAILABLE. There is no generate_image tool. Real-world media only.

When asset.method = "web_capture" on the shot's hint (the dominant method now), the agent's job is to (a) pick the best real URL via web_search + fetch_page, then (b) record_url it. The resulting capture:// URL becomes a MediaCandidate with source = "web_video", url = recording_url, source_page = final_url, title = page_title. The editor can play it directly — no extra step required.

You can also use record_url to VERIFY a URL before committing: if the recording fails or the page_title comes back nothing like what you expected, pick a different URL.

SUBJECT ANCHORING — strong default (relaxes only at Tier 5 of the ladder):
- EVERY search query you fire MUST include the subject's name. "$22 million funding" is wrong; "Vori $22 million funding" is right.
- For Tier 1-4 candidates: page must be about the subject. If a page is about an unrelated company that happens to share a topic / claim, do NOT extract media from it.
- Returning a DIFFERENT company's media as if it were the subject's is BANNED. (Returning Fazeshift / XXII / Opaque media labeled as Vori is wrong even at Tier 5 — a topic-level fallback must be GENERIC topic visuals, not another company's content.)
- Tier 5 (topic-anchored fallback) is allowed only AFTER Tiers 1-4 are exhausted, and the candidate's "notes" field must flag it as a topic-level improvisation so the user knows.

Banned failure example:
  Subject: Vori
  Shot's spoken_during: "they raised 22 million in funding"
  ❌ tavily_search "$22 million funding round" → returns Fazeshift, XXII, Opaque Systems → BANNED. Those are not Vori.
  ✅ tavily_search "Vori 22 million funding" → returns TechCrunch / press release about Vori → fetch_page → extract logo / hero image → cite.

Rules:
- Real-world media ONLY. AI image / video generation is NOT AVAILABLE. If you can't find media for the literal broll_description, BROADEN your search to related media about the subject (subject's other footage, subject's company / venue, the topic of the spoken line) via the IMPROVISATION LADDER below.
- The shot's asset block carries the user's intent (web_capture means "go to this URL", stock_search means "find footage matching this query", library_search means "find user footage" — but if library was banned, treat as manual). Use these as starting points, but DO YOUR OWN research to surface better candidates.
- For "find founders together"-style intents, plan: search for the company / topic → identify the people by name → search for joint photos / interview videos → fetch promising pages → extract media URLs.
- Cite the source_page (where you found the media) for every candidate so the editor can verify.
- When you find a long video (e.g., YouTube interview) and only a segment is relevant, set recommended_segment_ms.

NEVER RETURN EMPTY — IMPROVISATION LADDER (MANDATORY):

You MUST return at least one candidate for every shot. "We couldn't find the exact thing" is NEVER a valid outcome — improvise to something close. The user explicitly said: "when something like this happens, have the agent improvise and find things close to it or adjacent to it while keeping it related to the topic at hand and present that piece of media."

When the literal broll_description has no perfect match, walk down this ladder until you find SOMETHING (don't stop at the first failed query):

  Tier 1 — EXACT: the literal broll_description (e.g., "Vori CEO interview clip on YouTube").
  Tier 2 — ADJACENT same-subject same-topic: the same subject doing a closely related thing (e.g., Vori CEO on a podcast, Vori CEO LinkedIn post, Vori CEO conference photo).
  Tier 3 — ADJACENT same-subject any-topic: any video/photo of the subject's leadership / team / spokesperson (e.g., any video of any Vori founder, any Vori team page photo).
  Tier 4 — SAME-SUBJECT brand assets: subject's homepage hero, product screenshots, logo lockup, press kit imagery — anything that visually anchors the subject.
  Tier 5 — TOPIC-ANCHORED (last resort): a representative visual of the topic mentioned in spoken_during, with framing that's still appropriate (e.g., a generic grocery-store interior for a Vori-grocery-tech shot). Note in the candidate's "notes" field that this is a topic-level fallback.

For each candidate, include a "notes" field that's HONEST about which tier it came from when it's not Tier 1, so the user knows it's an improvisation. Example: "notes": "Improvised — exact CEO interview not found publicly; using founder LinkedIn profile photo as same-subject alternative (Tier 3)."

candidates[]:
The BEST set you can produce after walking the ladder. 2-5 entries, ranked best-first. This may mix tiers — if Tier 1 yielded one hit and Tiers 2-3 yielded two more, all three go into candidates[]. Do NOT split your output into multiple "alternative" shot directions — pick the strongest single interpretation of the shot and put all your best candidates there.

failure_reason: set to null UNLESS the subject itself has zero public web presence (no website, no social, no press). In every other case improvise per the ladder. If you're tempted to set failure_reason because "the exact thing wasn't found," that's wrong — drop down a tier and find something.

TOOL FAILURES ARE NOT FAILURE_REASON: Search tools getting blocked / rate-limited is NOT the same as "the subject has no public presence." If tavily_search returns blocked=true, that's a YOU problem (the tool), not a subject problem. NEVER set failure_reason="no public web presence" just because your tools choked. Walk through the WHEN SEARCH IS BLOCKED ladder below before giving up.

WHEN SEARCH IS BLOCKED — escape hatch:
If BOTH tavily_search AND web_search return blocked / empty for a real, well-known subject (a named company / product / person you can see is real from the target transcript), DO NOT set failure_reason. Instead, try fetch_page directly on these trusted URL patterns, in order — each is a well-known canonical path the search backends should have surfaced but didn't:

  1. The subject's own brand domain: \`https://<subject-name>.com\` — almost every named company / product owns the obvious .com. Try this first.
  2. Common alternates: \`https://<subject-name>.io\`, \`https://<subject-name>.ai\`, \`https://<subject-name>.co\` (one at a time, only if the .com 404s).
  3. Wikipedia: \`https://en.wikipedia.org/wiki/<Subject_Name>\` (use underscores for spaces, proper capitalization).
  4. Y Combinator directory (for YC startups, often hinted at in the transcript): \`https://www.ycombinator.com/companies/<subject-slug-lowercase>\`.
  5. Crunchbase: \`https://www.crunchbase.com/organization/<slug>\`.
  6. GitHub (for tech companies / open-source projects): \`https://github.com/<subject-name>\`.

For EACH attempt, ALWAYS pass expected_content="<subject name> <one qualifier>" to fetch_page so matches_expected catches wrong-subject hits. When matches_expected=true and the page renders, that URL is your Tier 1-4 hit even though no search backend surfaced it. When the entire ladder above fails AND the subject's name produces matches_expected=false on every trusted root, only THEN consider setting failure_reason.

This escape hatch is ONLY for the all-search-blocked case. Do NOT use it as a shortcut when DDG returns real results — those results take priority because they're verified-surfaced URLs, not heuristic guesses.

Output ONE JSON object (no markdown fences, no preamble) with this exact shape:
{
  "research_notes": "<2-3 sentences summarizing your plan + findings>",
  "candidates": [
    {
      "source": "web_image|web_video|web_page|unresolved",
      "url": "<concrete URL>",
      "thumbnail_url": "<url or null>",
      "source_page": "<provenance URL or null>",
      "title": "<short title or null>",
      "width": <int or null>,
      "height": <int or null>,
      "duration_ms": <int or null>,
      "recommended_segment_ms": { "start_ms": <int>, "end_ms": <int> } | null,
      "notes": "<one-sentence rationale>"
    }
  ],
  "failure_reason": "<null when candidates >= 1; otherwise a one-sentence explanation>"
}`;

function buildShotPrompt(
  shot: ShotPlan,
  plan: SuggestedEdit,
  extraUserPrompt?: string,
): string {
  const lines: string[] = [];
  if (extraUserPrompt && extraUserPrompt.trim().length > 0) {
    lines.push('# ADDITIONAL USER GUIDANCE FOR THIS REGENERATION');
    lines.push(extraUserPrompt.trim());
    lines.push('');
    lines.push(
      'Treat the guidance above as a hard constraint. It overrides the original shot ideas wherever they conflict.',
    );
    lines.push('');
  }
  lines.push(
    `Target reel duration: ${(plan.total_duration_ms / 1000).toFixed(1)}s, ${plan.shots.length} shots total.`,
  );
  lines.push(`Target full transcript: "${plan.shots.map((s) => s.spoken_during).filter(Boolean).join(' ')}"`);
  lines.push('');
  lines.push(`# Shot ${shot.shot_idx} (${shot.structure_role})`);
  lines.push(
    `time: ${(shot.start_ms / 1000).toFixed(2)}s - ${(shot.end_ms / 1000).toFixed(2)}s  (${(shot.duration_ms / 1000).toFixed(2)}s)`,
  );
  lines.push(`spoken_during: "${shot.spoken_during || '(silence)'}"`);
  lines.push(`broll_description: ${shot.broll_description}`);
  lines.push(`source_type: ${shot.source_type}`);
  lines.push(
    `placement: ${shot.placement.aspect} ${shot.placement.fit}@${shot.placement.position} scale=${shot.placement.scale}`,
  );
  if (shot.text_overlay) {
    lines.push(`text_overlay: "${shot.text_overlay}" @ ${shot.text_position}`);
  }
  lines.push('');
  lines.push('Asset hint from synthesis:');
  lines.push(`  method = ${shot.asset.method}`);
  if (shot.asset.web_capture) {
    lines.push(
      `  web_capture.url = ${shot.asset.web_capture.url}, focus = "${shot.asset.web_capture.focus}"`,
    );
  }
  if (shot.asset.stock_search) {
    lines.push(`  stock_search.query = "${shot.asset.stock_search.query}"`);
  }
  if (shot.asset.library_search) {
    lines.push(
      `  library_search.query = "${shot.asset.library_search.query}"  (note: library was unavailable so treat as research target)`,
    );
  }
  if (shot.asset.manual) {
    lines.push(`  manual.instruction = "${shot.asset.manual.instruction}"`);
  }
  lines.push('');
  lines.push('Research this shot. Find 2-5 concrete media candidates. Return JSON.');
  return lines.join('\n');
}

// ---------- tool execution ----------

interface ToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

interface ToolExecContext {
  shot_idx: number;
  onClarification?: ResearchShotOptions['onClarification'];
  /** Set true the first time record_url runs successfully for this
   *  shot. Subsequent record_url calls are rejected — the user wants
   *  recording to happen AT MOST once per shot. */
  recordUrlCalled: boolean;
  /** The exact URL the user just approved via request_record_approval.
   *  Cleared when the user denies. record_url rejects unless its url
   *  argument matches this string verbatim (no normalization — the
   *  agent must reuse the exact URL it had the user approve). */
  approvedUrl: string | null;
}

async function executeTool(
  call: ToolCall,
  ctx: ToolExecContext,
): Promise<string> {
  try {
    const args = JSON.parse(call.arguments);
    if (call.name === 'tavily_search') {
      const query = String(args.query ?? '').trim();
      if (!query) return JSON.stringify({ error: 'empty_query' });
      const n = Number(args.num_results);
      const safeN = Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 10;
      const result = await tavilySearch(query, safeN);
      return JSON.stringify(result);
    }
    if (call.name === 'fetch_page') {
      const expected = String(args.expected_content ?? '').trim();
      const result = await fetchPage(String(args.url ?? ''), {
        expectedContent: expected.length > 0 ? expected : undefined,
      });
      if (!result) return JSON.stringify({ error: 'fetch_failed' });
      return JSON.stringify(result);
    }
    if (call.name === 'record_url') {
      const requestedUrl = String(args.url ?? '');
      // Guard 1: only ONE SUCCESSFUL record_url per shot. A previous
      // failure does NOT count toward the budget — the agent can
      // retry (with fresh approval). recordUrlCalled flips true only
      // after a recording actually succeeds.
      if (ctx.recordUrlCalled) {
        return JSON.stringify({
          error: 'record_url_already_called_for_this_shot',
          note: 'You already successfully recorded a URL for this shot. Use that recording, or commit additional candidates as source="web_page".',
        });
      }
      // Guard 2: must have a prior request_record_approval whose
      // approved url matches this one verbatim. After EVERY attempt
      // (success or failure) the approvedUrl is cleared, so a retry
      // requires a fresh approval call — the user gets to redirect
      // the agent rather than have it bash the same URL again.
      if (ctx.approvedUrl !== requestedUrl) {
        return JSON.stringify({
          error: 'record_url_requires_prior_approval',
          approved_url: ctx.approvedUrl,
          requested_url: requestedUrl,
          note: ctx.approvedUrl
            ? 'You requested approval for a different URL than the one you just tried to record. Call request_record_approval again for THIS exact URL, or record the previously-approved one.'
            : 'You must call request_record_approval(url, approach_description, why_this_url) first and receive approved=true before calling record_url. If your previous record_url attempt failed, you can retry — but you must call request_record_approval again first (for the same URL or a new one).',
        });
      }
      const durationSec = Number(args.duration_seconds);
      const safeDurSec = Number.isFinite(durationSec)
        ? Math.max(3, Math.min(30, durationSec))
        : 8;
      const expected = String(args.expected_content ?? '').trim();
      // scroll_segments: pass through as-is; recordUrl normalizes /
      // clamps each entry. Empty array → falls back to single scroll.
      const rawSegments = Array.isArray(args.scroll_segments)
        ? (args.scroll_segments as ScrollSegment[])
        : [];
      // aspect + behavior are NOT parameters — recordUrl forces 9:16
      // mobile and a clean (no-effects) capture regardless of what's
      // passed. Camera moves happen downstream in the editor.
      const result = await recordUrl(requestedUrl, {
        durationMs: safeDurSec * 1000,
        scroll: (args.scroll as ScrollStyle) ?? 'smooth',
        scrollSegments: rawSegments,
        expectedContent: expected.length > 0 ? expected : undefined,
        // User just approved this exact URL via request_record_approval
        // — the keyword threshold inside record_url is now redundant
        // and produces false negatives. Pass 0 so the score is still
        // computed for diagnostics but never blocks the recording.
        minMatchScore: 0,
      });
      // Approval was for this URL; consume it either way. A retry
      // requires a fresh approval call.
      ctx.approvedUrl = null;
      // Only count the budget on a successful recording. Failures
      // (auth_wall_redirect, http_*, no_video_object, …) are retriable.
      if (result.ok) {
        ctx.recordUrlCalled = true;
      }
      return JSON.stringify(result);
    }
    if (call.name === 'request_record_approval') {
      if (!ctx.onClarification) {
        return JSON.stringify({
          error: 'clarification_unavailable_in_this_session',
        });
      }
      const url = String(args.url ?? '').trim();
      const approach = String(args.approach_description ?? '').trim();
      const whyUrl = String(args.why_this_url ?? '').trim();
      if (!url) {
        return JSON.stringify({ error: 'invalid_approval_request: missing url' });
      }
      // Video-host URLs (YouTube, Vimeo, Loom, Streamable, Wistia,
      // Dailymotion, v.redd.it) are passthroughs: they're already video
      // sources, so we commit them as source="web_video" candidates and
      // skip recording entirely. Block at the approval gate so the
      // agent learns this one turn earlier without surfacing a useless
      // yes/no to the user.
      if (isVideoHostUrl(url)) {
        ctx.approvedUrl = null;
        return JSON.stringify({
          approved: false,
          user_answer:
            `video_host_passthrough (${url}) — this is already a video URL. Commit it directly as a MediaCandidate with source="web_video", url="${url}", source_page="${url}". Do NOT call record_url or request_record_approval again on this URL.`,
        });
      }
      const APPROVE_LABEL = 'Yes — record this URL';
      const DENY_LABEL = 'No — try a different approach';
      try {
        const { answer } = await ctx.onClarification({
          shot_idx: ctx.shot_idx,
          question: `Record ${url}?`,
          options: [APPROVE_LABEL, DENY_LABEL],
          reason:
            (approach ? `Approach: ${approach}` : '') +
            (whyUrl ? `${approach ? '\n' : ''}Why this URL: ${whyUrl}` : ''),
        });
        const approved = answer === APPROVE_LABEL;
        if (approved) {
          ctx.approvedUrl = url;
        } else {
          ctx.approvedUrl = null;
        }
        return JSON.stringify({ approved, user_answer: answer });
      } catch (err) {
        // Treat abort as a deny (the agent must not record without
        // explicit user OK).
        ctx.approvedUrl = null;
        return JSON.stringify({
          error: `approval_aborted: ${err instanceof Error ? err.message : String(err)}`,
          approved: false,
        });
      }
    }
    if (call.name === 'ask_user_clarification') {
      if (!ctx.onClarification) {
        // No host-side clarification surface (e.g., called from a
        // script). Tell the model so it falls back to its own judgment
        // instead of looping forever.
        return JSON.stringify({
          error: 'clarification_unavailable_in_this_session',
        });
      }
      const question = String(args.question ?? '').trim();
      const reason = String(args.reason ?? '').trim();
      const rawOptions = Array.isArray(args.options) ? args.options : [];
      const options = rawOptions
        .map((o: unknown) => String(o ?? '').trim())
        .filter((o: string) => o.length > 0);
      if (!question || options.length < 2) {
        return JSON.stringify({
          error: 'invalid_clarification_request (need question + 2-4 options)',
        });
      }
      try {
        const { answer } = await ctx.onClarification({
          shot_idx: ctx.shot_idx,
          question,
          options,
          reason,
        });
        return JSON.stringify({ answer });
      } catch (err) {
        return JSON.stringify({
          error: `clarification_aborted: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return JSON.stringify({ error: `unknown_tool: ${call.name}` });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------- final output parsing ----------

interface RawCuration {
  research_notes?: string;
  candidates?: unknown[];
  failure_reason?: string | null;
}

function normalizeCandidate(raw: unknown): MediaCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!url) return null;
  const sourceRaw = typeof r.source === 'string' ? r.source : '';
  // generated_image is intentionally NOT in validSources — AI image
  // generation is blacklisted; if the model emits it, fall to 'unresolved'.
  const validSources: MediaCandidate['source'][] = [
    'web_image',
    'web_video',
    'web_page',
    'user_provided',
    'unresolved',
  ];
  const source = validSources.includes(sourceRaw as MediaCandidate['source'])
    ? (sourceRaw as MediaCandidate['source'])
    : 'unresolved';
  const segRaw = r.recommended_segment_ms as
    | { start_ms?: number; end_ms?: number }
    | null
    | undefined;
  return {
    source,
    url,
    thumbnail_url:
      typeof r.thumbnail_url === 'string' ? r.thumbnail_url : null,
    source_page: typeof r.source_page === 'string' ? r.source_page : null,
    title: typeof r.title === 'string' ? r.title : null,
    width: typeof r.width === 'number' ? r.width : null,
    height: typeof r.height === 'number' ? r.height : null,
    duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null,
    recommended_segment_ms:
      segRaw &&
      typeof segRaw.start_ms === 'number' &&
      typeof segRaw.end_ms === 'number'
        ? { start_ms: segRaw.start_ms, end_ms: segRaw.end_ms }
        : null,
    notes: typeof r.notes === 'string' ? r.notes : null,
  };
}

function extractFinalText(resp: Response): string {
  // Final assistant text lives in output_message items with output_text content.
  for (const item of resp.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'output_text') return part.text;
    }
  }
  return '';
}

function extractFunctionCalls(resp: Response): ResponseFunctionToolCall[] {
  return resp.output.filter(
    (item): item is ResponseFunctionToolCall =>
      item.type === 'function_call',
  );
}

// ---------- main entry ----------

export interface ResearchShotOptions {
  onTurn?: (event: CuratorTurnEvent) => void;
  /** Cancellation. When aborted, in-flight API calls reject (via the
   *  OpenAI SDK's signal) and the agent loop exits at the next
   *  boundary with reason='api_error' and failure_reason='aborted'. */
  signal?: AbortSignal;
  /** Extra user guidance to prepend to the agent's user message —
   *  used by the per-shot regenerate flow so the user can steer the
   *  agent ("make it less corporate", "use Wikipedia not the
   *  homepage"). Empty / undefined when not regenerating. */
  extraUserPrompt?: string;
  /** Called when the agent invokes ask_user_clarification. The host
   *  (main process) is expected to surface the question to the user
   *  and resolve with the user's picked option as `answer`. Reject
   *  with an Error when the user cancels / the wait is aborted —
   *  the agent will treat it as `clarification_aborted` and fall
   *  back to its own judgment. */
  onClarification?: (
    req: CuratorClarificationRequest,
  ) => Promise<{ answer: string }>;
}

/** Result of one full agent run (initial research OR continuation).
 *  `final_input` carries the full conversation including the model's
 *  output messages + tool calls + tool outputs so a follow-up call
 *  to continueShot() can pick up exactly where this one stopped. */
export interface ResearchResult {
  curation: ShotCuration;
  usage: AgentUsage;
  trace: AgentTrace;
  /** Pass this back to continueShot() to extend the same session. */
  final_input: ResponseInputItem[];
}

/** Stub aborted/api-error result. Used when we bail before the loop
 *  even starts (no API key, signal pre-aborted, etc.). */
function stubResult(
  shot: ShotPlan,
  reason: AgentTrace['reason'],
  failure: string,
  notes: string,
): ResearchResult {
  return {
    curation: {
      shot_idx: shot.shot_idx,
      research_notes: notes,
      candidates: [],
      failure_reason: failure,
    },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    trace: {
      shot_idx: shot.shot_idx,
      turns: [],
      final_text: '',
      finished_at_turn: 0,
      reason,
      tokens: { input: 0, output: 0, total: 0 },
    },
    final_input: [],
  };
}

export async function researchShot(
  shot: ShotPlan,
  plan: SuggestedEdit,
  optsOrOnTurn?: ResearchShotOptions | ((event: CuratorTurnEvent) => void),
): Promise<ResearchResult> {
  const opts: ResearchShotOptions =
    typeof optsOrOnTurn === 'function'
      ? { onTurn: optsOrOnTurn }
      : optsOrOnTurn ?? {};
  if (opts.signal?.aborted) {
    return stubResult(shot, 'api_error', 'aborted', '(aborted before start)');
  }
  if (!getOpenAI()) {
    return stubResult(shot, 'api_error', 'no_api_key', '(OPENAI_API_KEY not set; curator skipped)');
  }
  const userPrompt = buildShotPrompt(shot, plan, opts.extraUserPrompt);
  const input: ResponseInputItem[] = [
    { type: 'message', role: 'system', content: SYSTEM_PROMPT },
    { type: 'message', role: 'user', content: userPrompt },
  ];
  return runAgentLoop(shot, input, opts);
}

/** Continue a prior agent session with a follow-up user instruction.
 *  Picks up the SAME conversation (all prior tool calls + results
 *  still in context) so the model doesn't re-do work — it just tweaks
 *  the output per the new prompt. Use the `final_input` field from a
 *  previous researchShot() / continueShot() return as `priorInput`. */
export async function continueShot(
  shot: ShotPlan,
  priorInput: ResponseInputItem[],
  userPrompt: string,
  options: ResearchShotOptions = {},
): Promise<ResearchResult> {
  if (options.signal?.aborted) {
    return stubResult(shot, 'api_error', 'aborted', '(aborted before start)');
  }
  if (!getOpenAI()) {
    return stubResult(shot, 'api_error', 'no_api_key', '(OPENAI_API_KEY not set; curator skipped)');
  }
  if (!priorInput || priorInput.length === 0) {
    return stubResult(
      shot,
      'api_error',
      'no_prior_session',
      '(no prior session input — run curate-shot first)',
    );
  }
  const trimmed = userPrompt.trim();
  // Append the user's follow-up as a new message. The conversation
  // history (system prompt, prior tool calls, fetched pages, prior
  // model output) is preserved so the model has full context — but
  // the message itself is phrased as a directive, not a suggestion,
  // because the failure mode of permissive phrasing is the model
  // restating its prior candidates with adjusted research_notes
  // ("OK I'll keep PR Newswire even though you said Fortune because
  // it's also Tier 1"). That's what "Edit result does nothing" looks
  // like from the user's perspective.
  const directive = trimmed
    ? `The user reviewed your candidates and is telling you to CHANGE them. Their instruction: "${trimmed}"`
    : 'The user wants you to revise your candidates — re-evaluate and produce a different set.';
  const input: ResponseInputItem[] = [
    ...priorInput,
    {
      type: 'message',
      role: 'user',
      content:
        `${directive}\n\n` +
        `RULES for this revision (read carefully — this is not advisory):\n` +
        `1. If the user names sources to USE (Crunchbase, Fortune, TechCrunch, etc.), you MUST search for / fetch those sources and replace candidates with what you find there.\n` +
        `2. If the user names sources to AVOID (press releases, PR Newswire, a specific URL, etc.), remove those from candidates and find substitutes.\n` +
        `3. If the user asks for a different angle, tier, or framing, walk the improvisation ladder to surface new candidates that match.\n` +
        `4. Returning your prior candidates with revised research_notes is BANNED. The user has already seen them and rejected them — you must produce DIFFERENT candidate URLs.\n` +
        `5. You may keep prior candidates ONLY IF the user's instruction explicitly approves them (e.g., "keep #1 but replace #2"). Default: replace.\n` +
        `6. Take action — call tavily_search / fetch_page / record_url as needed to satisfy the instruction. You are still under the same SUBJECT-ANCHORING + URL DISCIPLINE rules from the system prompt.\n\n` +
        `Return STRICT JSON in the same shape as your prior output (research_notes / candidates / failure_reason). The candidates array MUST differ from your last response unless the user explicitly told you to keep specific entries.`,
    },
  ];
  return runAgentLoop(shot, input, options);
}

async function runAgentLoop(
  shot: ShotPlan,
  input: ResponseInputItem[],
  opts: ResearchShotOptions,
): Promise<ResearchResult> {
  const { onTurn, signal } = opts;
  // getOpenAI() returns null when OPENAI_API_KEY is missing — the
  // wrappers above already filter that case, but TypeScript doesn't
  // know that, so re-check here.
  const client = getOpenAI();
  if (!client) {
    return stubResult(shot, 'api_error', 'no_api_key', '(OPENAI_API_KEY not set; curator skipped)');
  }

  const usage: AgentUsage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };

  let finalText = '';
  const turns: AgentTurn[] = [];
  let finishedAt = 0;
  let reason: AgentTrace['reason'] = 'completed';
  // Per-SHOT tool exec context. Hoisted out of the per-turn loop so
  // record-url state (already-called flag, last approved url) lives
  // for the entire shot — that's what makes the "at most one
  // record_url per shot" guard work across turns.
  const ctx: ToolExecContext = {
    shot_idx: shot.shot_idx,
    onClarification: opts.onClarification,
    recordUrlCalled: false,
    approvedUrl: null,
  };
  // No turn budget — the loop only exits when the model returns text
  // without function_calls (success) or hits SAFETY_TURN_CAP (runaway
  // protection only; not a budget).
  for (let turn = 0; turn < SAFETY_TURN_CAP; turn++) {
    if (signal?.aborted) {
      return {
        curation: {
          shot_idx: shot.shot_idx,
          research_notes: '(aborted)',
          candidates: [],
          failure_reason: 'aborted',
        },
        usage,
        trace: {
          shot_idx: shot.shot_idx,
          turns,
          final_text: '',
          finished_at_turn: turn,
          reason: 'api_error',
          tokens: {
            input: usage.input_tokens,
            output: usage.output_tokens,
            total: usage.total_tokens,
          },
        },
        final_input: input,
      };
    }
    let resp: Response;
    try {
      resp = await client.responses.create(
        {
          model: MODEL,
          input,
          tools: TOOLS,
        },
        signal ? { signal } : undefined,
      );
    } catch (err) {
      const aborted =
        signal?.aborted ||
        (err instanceof Error &&
          (err.name === 'AbortError' || /abort/i.test(err.message)));
      if (!aborted) {
        console.error(
          `[curator] shot ${shot.shot_idx} turn ${turn} API failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      return {
        curation: {
          shot_idx: shot.shot_idx,
          research_notes: aborted ? '(aborted)' : '(API call failed)',
          candidates: [],
          failure_reason: aborted
            ? 'aborted'
            : err instanceof Error
              ? err.message
              : String(err),
        },
        usage,
        trace: {
          shot_idx: shot.shot_idx,
          turns,
          final_text: '',
          finished_at_turn: turn,
          reason: 'api_error',
          tokens: {
            input: usage.input_tokens,
            output: usage.output_tokens,
            total: usage.total_tokens,
          },
        },
        final_input: input,
      };
    }

    if (resp.usage) {
      usage.input_tokens += resp.usage.input_tokens ?? 0;
      usage.output_tokens += resp.usage.output_tokens ?? 0;
      usage.total_tokens += resp.usage.total_tokens ?? 0;
    }

    // The model's own output items (function_calls, messages,
    // web_search_calls) must be carried forward so the model sees
    // its own actions when we make the follow-up call.
    for (const item of resp.output) {
      input.push(item as ResponseInputItem);
    }

    const functionCalls = extractFunctionCalls(resp);
    // Also count OpenAI's built-in web_search calls so the UI can
    // show "the agent searched the web" activity. These are executed
    // automatically by OpenAI — no follow-up needed from us.
    const webSearchCount = resp.output.filter(
      (item) => item.type === 'web_search_call',
    ).length;
    const messageText = extractFinalText(resp);
    // Trace row for this turn — function calls' results will be
    // filled in below once we execute them.
    const turnRow: AgentTurn = {
      turn_idx: turn + 1,
      message_text: messageText,
      function_calls: functionCalls.map((fc) => ({
        name: fc.name,
        arguments: fc.arguments,
        result: '',
      })),
      web_search_calls: webSearchCount,
    };
    turns.push(turnRow);
    const summaries: CuratorTurnEvent['tool_calls'] = [];
    for (let i = 0; i < webSearchCount; i++) {
      summaries.push({ name: 'web_search', summary: '(query handled by OpenAI)' });
    }
    for (const fc of functionCalls) {
      summaries.push({ name: fc.name, summary: summarizeArgs(fc.name, fc.arguments) });
    }

    if (functionCalls.length === 0) {
      // Final turn — no more custom tool calls; model returned text.
      if (onTurn && (summaries.length > 0 || webSearchCount > 0)) {
        onTurn({
          shot_idx: shot.shot_idx,
          turn: turn + 1,
          total_turns: 0,
          tool_calls: summaries,
          finished: true,
        });
      } else if (onTurn) {
        onTurn({
          shot_idx: shot.shot_idx,
          turn: turn + 1,
          total_turns: 0,
          tool_calls: [],
          finished: true,
        });
      }
      finalText = messageText;
      finishedAt = turn + 1;
      reason = 'completed';
      break;
    }

    // First emission for this turn — tools are about to run, so
    // result_summary is unset. UI shows "fetching X…".
    if (onTurn) {
      onTurn({
        shot_idx: shot.shot_idx,
        turn: turn + 1,
        total_turns: 0,
        tool_calls: summaries,
        finished: false,
      });
    }

    // Execute each function call in parallel and append outputs.
    // ask_user_clarification + request_record_approval run through the
    // same path; their executors park on opts.onClarification(...).
    // The renderer surfaces the panel and the user's click eventually
    // resolves it.
    const outputs = await Promise.all(
      functionCalls.map(async (call) => {
        const result = await executeTool(
          {
            call_id: call.call_id,
            name: call.name,
            arguments: call.arguments,
          },
          ctx,
        );
        return { call_id: call.call_id, output: result };
      }),
    );
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i];
      input.push({
        type: 'function_call_output',
        call_id: out.call_id,
        output: out.output,
      });
      // Backfill the trace row with the result we sent back.
      if (turnRow.function_calls[i]) {
        turnRow.function_calls[i].result = out.output;
      }
      // Backfill the matching summary with the result so the second
      // emission shows "→ <result_summary>" on the same line. The
      // first webSearchCount entries in `summaries` are web_search
      // placeholders (no follow-up output from us), so we offset by
      // those when matching to functionCalls.
      const summaryIdx = webSearchCount + i;
      if (summaryIdx < summaries.length) {
        summaries[summaryIdx].result_summary = summarizeResult(
          functionCalls[i].name,
          out.output,
        );
      }
    }

    // Second emission — same turn number, now with result_summary
    // filled in. The renderer keys by (shot_idx, turn) so this
    // replaces the first emission.
    if (onTurn) {
      onTurn({
        shot_idx: shot.shot_idx,
        turn: turn + 1,
        total_turns: 0,
        tool_calls: summaries,
        finished: false,
      });
    }
  }
  // If we exited the for-loop without break, we hit SAFETY_TURN_CAP
  // — that's a malfunctioning model, not normal exhaustion.
  if (!finalText) {
    finishedAt = SAFETY_TURN_CAP;
    reason = 'max_turns_reached';
  }

  const buildTrace = (): AgentTrace => ({
    shot_idx: shot.shot_idx,
    turns,
    final_text: finalText,
    finished_at_turn: finishedAt,
    reason,
    tokens: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      total: usage.total_tokens,
    },
  });

  if (!finalText) {
    return {
      curation: {
        shot_idx: shot.shot_idx,
        research_notes: '(agent did not produce final output before max turns)',
        candidates: [],
        failure_reason: 'max_turns_reached',
      },
      usage,
      trace: buildTrace(),
      final_input: input,
    };
  }

  // Parse JSON. Strip code fences if model added them despite instruction.
  let parsed: RawCuration;
  try {
    const cleaned = finalText
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned) as RawCuration;
  } catch (err) {
    return {
      curation: {
        shot_idx: shot.shot_idx,
        research_notes: '(final output was not valid JSON)',
        candidates: [],
        failure_reason: `parse_error: ${err instanceof Error ? err.message : String(err)}`,
      },
      usage,
      trace: buildTrace(),
      final_input: input,
    };
  }

  const candidates = Array.isArray(parsed.candidates)
    ? parsed.candidates
        .map(normalizeCandidate)
        .filter((c): c is MediaCandidate => c !== null)
    : [];

  return {
    curation: {
      shot_idx: shot.shot_idx,
      research_notes: parsed.research_notes?.trim() || '',
      candidates,
      failure_reason: parsed.failure_reason?.trim() || null,
    },
    usage,
    trace: buildTrace(),
    final_input: input,
  };
}
