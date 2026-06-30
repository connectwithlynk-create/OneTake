// Library curation research agent loop.
//
// Given a transcript beat from the synthesis plan, the agent reasons about WHAT
// media is needed and HOW to find it, then iteratively calls tools
// (web_search built into OpenAI, fetch_page + record_url as custom
// Playwright-backed functions) until it has 2-5 concrete media
// candidates for the reel's shared media library. AI image generation is intentionally NOT available —
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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
  Tool,
} from 'openai/resources/responses/responses';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { ShotPlan, SuggestedEdit } from '../analyze/synthesize';
import {
  fetchPage,
  recordUrl,
  tavilySearch,
  type ScrollSegment,
  type ScrollStyle,
} from './tools';
import { isVideoHostUrl, SCROLL_STYLES } from './web-record';
import type {
  AgentTrace,
  AgentTurn,
  MediaCandidate,
  ShotCuration,
} from './types';

const MODEL = process.env.ONETAKE_CURATOR_MODEL?.trim() || 'gpt-5.4-mini';
type CuratorReasoningLevel = Extract<
  ReasoningEffort,
  'none' | 'low' | 'medium' | 'high'
>;
const DEFAULT_REASONING_LEVEL: CuratorReasoningLevel = 'low';
const REASONING_MODEL_RE = /^(gpt-5|o[1-9]|codex-mini-latest)/;
function modelSupportsReasoningEffort(model: string): boolean {
  return REASONING_MODEL_RE.test(model);
}
/** Pure safety cap to prevent a model bug from looping forever. Not
 *  intended as a budget — the user explicitly wants no max-turns
 *  constraint, so this is set high enough that any normal research
 *  chain (10-20 turns) finishes well below it. If you ever see a
 *  shot reach this number, the model is malfunctioning. */
const SAFETY_TURN_CAP = 200;
const AGENT_MEMORY_PATH = resolve(
  process.cwd(),
  '.library',
  'agent-memory.jsonl',
);

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
    if (name === 'set_reasoning_level') {
      return `reasoning=${String(r.reasoning_level ?? 'unknown')}`;
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
          : String(args.scroll ?? 'slow');
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
    if (name === 'set_reasoning_level') {
      const level = String(args.reasoning_level ?? '').trim();
      const reason = String(args.reason ?? '').trim();
      return reason ? `${level}: ${reason.slice(0, 64)}` : level;
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
    name: 'set_reasoning_level',
    description:
      'Switch the reasoning effort used for subsequent agent turns. Call this whenever the current shot or sub-task changes complexity: none for trivial formatting/final JSON, low for routine search/fetch steps, medium for ambiguous multi-source decisions, high for hard planning, conflicting evidence, or recovery from repeated tool failures. The new level applies to the next Responses API call.',
    parameters: {
      type: 'object',
      properties: {
        reasoning_level: {
          type: 'string',
          enum: ['none', 'low', 'medium', 'high'],
          description:
            'Desired reasoning effort for future turns. Use the lowest level that can solve the immediate sub-task.',
        },
        reason: {
          type: 'string',
          description:
            'Short operational reason for the switch, e.g. "routine search", "conflicting sources", or "final JSON only".',
        },
      },
      required: ['reasoning_level', 'reason'],
      additionalProperties: false,
    },
    strict: true,
  },
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
          enum: ['linear', 'slow', 'hold'],
          description:
            'Single-style scroll, used ONLY when scroll_segments is an empty array. hold = no scroll (static / single-screen page); linear = steady gradual reveal capped by runtime speed limits; slow = a gentle creep. Never use scrolling to rush through a whole website.',
        },
        expected_content: {
          type: 'string',
          description:
            'One short sentence (~5-15 words) of SUBJECT KEYWORDS the page text actually contains (e.g., "Vori grocery POS startup homepage", "Vori founder Brandon Hill biography", "TechCrunch article about Vori $22M funding"). DO NOT describe the recording or layout — BAD: "homepage hero section and logo", "8s smooth scroll of marketing page", "product banner with header". The reason: the page never literally says "I am the hero section" / "8s scroll", so those tokens score zero. Use the SUBJECT and TOPIC that would appear in the rendered text. After user approval the internal threshold check is skipped, but the score is still reported on the result for visibility — write good keywords anyway so the score is informative. Pass an empty string only if you want NO content scoring on the result.',
        },
        scroll_segments: {
          type: 'array',
          description:
            "OPTIONAL cinematic scroll timeline. DEFAULT IS EMPTY — pass [] for most recordings (single-screen pages, articles, videos, short shots, anything with <3 distinct sections). Reach for a non-empty timeline ONLY when the page is multi-section marketing content AND the shot is >=8s AND the spoken_during has multiple beats that benefit from landing on different sections. BANNED PATTERN: never pass generic thirds like [{scroll_to:0},{scroll_to:0.5},{scroll_to:1}] — those aim at whitespace, not content. The recorder SNAPS each scroll_to to the nearest real section position detected on the loaded mobile page (the mobile layout reflows, so fractions shift) and DROPS any segment further than 0.2 from every section — generic guesses degrade to a plain gradual scroll, not your timeline. When non-empty: each scroll_to MUST come from fetch_page's `sections[].position_fraction` for THIS url. Each segment animates to `scroll_to` over `travel_ms`, then HOLDS for `hold_ms`. travel_ms=0 is only for the first segment when it is already at the top. Never use segments to race through the whole website; pick 1-3 relevant sections and move gradually. Total travel+hold should fit inside duration_seconds*1000 minus ~2s. Example for a rich SaaS homepage at 10s with sections at 0, 0.30, 0.55: [ { scroll_to: 0, travel_ms: 0, hold_ms: 2500 }, { scroll_to: 0.30, travel_ms: 2500, hold_ms: 2500 }, { scroll_to: 0.55, travel_ms: 2500, hold_ms: 2000 } ].",
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
                  'How long (ms) to animate from the previous position to scroll_to. Use 0 only when the first target is already at the current top. Typical values: 1800-3500 for readable gradual moves; the recorder expands too-fast values at runtime.',
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

const SYSTEM_PROMPT = `You are a media research agent. Your job: CURATE LIBRARY for a short-form vertical reel: build a library of concrete media candidates as actual page recordings or screenshots of relevant web content. Prefer pages the editor can record/screenshot, not raw image/video files embedded inside a page.

IMPORTANT MODE SHIFT — CURATE LIBRARY, NOT SHOT-BY-SHOT B-ROLL:
- Do NOT start from the shot's broll_description as the source of truth. Treat it as a weak hint only.
- Start from what is being talked about in the transcript/subtitle.
- For each subtitle/shot beat, focus on 1-2 key words from spoken_during. Those keywords define what clips to find.
- The whole curation run must produce at least one usable clip per total shot in the plan. If there are N total shots, the final media library across the run needs at least N usable candidates.
- Each agent run is filling one library slot for its subtitle beat, so return at least 1 strong candidate; return 2-5 when there are distinct useful options.

Process:
0. IDENTIFY THE SUBJECT. Read the full target transcript context (provided in the user message) and pin down WHO / WHAT the reel is about — the named company, product, person, or topic. Name it explicitly to yourself before searching. The SUBJECT is the constant across every shot; the shot's local spoken_during ("they raised 22 million") makes no sense without the subject ("Vori raised 22 million").
0A. BUILD A TOPIC BRIEF BEFORE CANDIDATES. Do initial research on the ACTUAL topic of the video, not only the isolated shot hint. Run at least one subject-level tavily_search using the subject name plus the strongest transcript keywords (company/product/person/topic, funding amount, demo/review, founder, launch, etc.). Use results/snippets/fetches to identify: what the subject is, key people/products/events, credible source domains, and likely media types (demo videos, review reels, interviews, product pages, press, founder profiles). This brief should guide all candidate choices.
1. UNDERSTAND THE SUBTITLE BEAT. Read what's spoken during this subtitle/shot beat and extract 1-2 key words. Identify what specifically needs to be visible AS APPLIED TO THE SUBJECT — a logo (of the subject), a person (the subject's founder / spokesperson), a place (the subject's office / venue), a screen recording or screenshot of the subject's website / press / review / demo page, etc. Use broll_description only as a fallback hint.
2. PLAN. Decide what searches and fetches will get you there based on the topic brief. Don't just run a single search — chain searches and page fetches when needed (search for the SUBJECT + qualifier → find their company page → search demos/reviews/interviews → fetch pages/videos → extract media URLs).
3. EXECUTE. Start with tavily_search (real API, bot-friendly, no captcha) — returns concrete title/url/snippet triples. Use the built-in web_search only as a last resort when tavily_search is blocked (missing API key / transient network error). Then use fetch_page to load a candidate page from your search results in a real browser and verify it has relevant visible sections. Prefer committing that page as source="web_page" so auto-capture can make screenshots/recordings, or call record_url to create a capture:// recording. DO NOT harvest raw image URLs or raw video URLs from inside the page as candidates unless the URL is itself a video-host URL under VIDEO HOST PASSTHROUGH. NEVER hand fetch_page or record_url a URL that didn't appear in a search result.
4. EVALUATE. Pick 2-5 candidates ranked best-first. Each candidate should be a concrete URL the editor can actually use and should make sense for the full transcript's topic, not merely for the local phrase. Prefer same-subject hits; when Tier 1 (exact) fails, walk DOWN the IMPROVISATION LADDER (see below) before giving up.

SOURCE DIVERSITY — do not make every shot the obvious homepage:
- The full reel needs a varied media library. Avoid returning the same source_page / same URL pattern for multiple shots unless the current shot specifically calls for that exact page section.
- The subject's homepage, YC profile, Crunchbase page, LinkedIn profile, Wikipedia page, or top press release are allowed as anchors, but each should usually appear once across the reel, not as the default fallback for every shot.
- Before committing the obvious source, run at least one alternate query for this subtitle beat's keywords: demo, review, customer, founder interview, product screenshot, funding article, directory/profile, docs, social/video result, or third-party writeup.
- If you reuse a domain already likely to appear elsewhere, pick a meaningfully different page/section and explain why this library slot needs it in notes.

OUTPUT POLICY — PAGE CAPTURES, NOT SCRAPED ASSETS:
- For normal websites, articles, company pages, review pages, demo pages, docs, Crunchbase/YC/Wikipedia/press pages: return source="web_page" with url=<page URL>. The app will auto-record the page and capture relevant screenshots after curation.
- Do NOT return source="web_image" for images found inside a page. Return the page URL as source="web_page" instead, with notes saying which section/visual should be captured.
- Do NOT return direct .mp4/.webm/video file URLs extracted from a page. Return the page URL as source="web_page" unless the URL is a supported video-host passthrough.
- For supported video hosts (YouTube/Vimeo/Loom/Streamable/Wistia/Dailymotion/v.redd.it/Instagram/TikTok/Facebook), source="web_video" is allowed because the URL itself is the media page. Do not fetch/record those; commit directly as described below.
- For record_url success, source="web_video" with url=<capture:// recording_url> is allowed because it is an actual recording of the page.

There is NO TURN LIMIT on this loop. Take as many tool calls as you need to ground every candidate in real, subject-matching content. Don't shortcut.

REASONING LEVEL CONTROL:
You can call set_reasoning_level to change how much reasoning effort future turns use. Use your own judgment:
- none: trivial final JSON cleanup or mechanically reporting already-decided candidates.
- low: routine search, page fetches, normal URL verification.
- medium: comparing mixed sources, choosing among plausible candidates, planning scroll_segments.
- high: conflicting evidence, ambiguous identity, repeated tool failures, or hard improvisation down the ladder.
Do not stay at high after the hard sub-task is done; lower it before routine fetches or final output.

WHEN TO ASK THE USER FOR HELP — confused, don't guess:
When you genuinely cannot decide between candidates on signal alone, STOP and call ask_user_clarification instead of guessing. Guessing on ambiguity produces wrong-subject candidates, which is the worst possible outcome.

  Valid triggers — DO ask the user:
    1. Two candidate URLs from search results are equally plausible for the SAME tier and you can't pick on signal alone. Example: search returns linkedin.com/in/brandonhill-vori AND linkedin.com/in/brandonhill-uk — both are real people, both are software engineers, neither bio explicitly says "Vori grocery POS." A coin flip is wrong.
    2. The SUBJECT itself is ambiguous from the transcript. Example: the transcript says "the founder built it" but the company has two co-founders named in different sources — which one is the speaker referring to?
    3. Fetched pages give CONFLICTING signals. Example: fetch_page on the company's homepage says "founded by A and B" but a TechCrunch article says "founded by A, C, D" — which set is canonical for this library slot?

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

  After getting an answer, treat it as authoritative for the rest of this library slot and proceed to fetch_page / record_url with the chosen URL.

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
    record_url(url="https://vori.com", duration_seconds=10, scroll="linear", expected_content="Vori grocery POS startup", scroll_segments=[
      { scroll_to: 0.0,  travel_ms: 0,    hold_ms: 2500 },
      { scroll_to: 0.30, travel_ms: 2500, hold_ms: 2500 },
      { scroll_to: 0.55, travel_ms: 2500, hold_ms: 2000 },
    ]) → recorded at 9:16 mobile with cinematic timeline driven by real section positions

SCROLL_SEGMENTS — situational, not default:
Default is scroll_segments=[] with a single \`scroll\` style. Reach for segments ONLY when the shot has a clear cinematic intent that the simple single-style scroll wouldn't serve — and never on pages where it adds nothing.

BANNED PATTERN — DO NOT GUESS POSITIONS:
scroll_segments=[ { scroll_to: 0 }, { scroll_to: 0.5 }, { scroll_to: 1 } ] (and any other "generic thirds / quarters / halves" layout) is BANNED. Those values aim at whatever happens to be at the top, middle, and bottom — which is usually whitespace or the boundary between sections, NOT the interesting content. The recorder enforces this at runtime: each scroll_to is snapped to the nearest real section position_fraction detected on the loaded (mobile) page, and any scroll_to further than 0.2 from every section is DROPPED — if every segment is dropped, the recording falls back to a plain linear scroll and your timeline is gone. Do not guess — read fetch_page's \`sections\` array and use those numbers.

REQUIREMENT when scroll_segments is non-empty:
You MUST have called fetch_page on this URL earlier in the conversation and you MUST source every scroll_to value from a section.position_fraction in that response. Don't invent intermediate positions; if you want to land between two sections, use the actual section position closest to your intent. If you don't have a fetch_page response with sections for this URL, either (a) call fetch_page first or (b) pass scroll_segments=[] and use the single 'scroll' style.

  USE scroll_segments when ALL three are true:
   - The page is multi-section marketing / product content with 3+ distinct blocks (hero, feature grid, testimonials, pricing, CTA — typical SaaS/startup homepage shape).
   - The shot is long enough to give each section its own beat (typically >= 8s).
   - The spoken_during has multiple ideas you'd want different sections to land on (e.g., "they raised 22M, built a POS for grocery, and got Y Combinator backing" → hero, product, YC logos).

  DO NOT USE scroll_segments when ANY of these:
   - Single-screen page (logo only, hero only, app store badge, profile page).
   - Article / blog / Wikipedia / TechCrunch piece — use hold or one gradual partial scroll over the relevant headline/body area, not a full top-to-bottom tour.
   - YouTube / Vimeo / video player URLs — no scrolling at all (use scroll='hold').
   - Image gallery / Pinterest-style pages — one linear scroll is fine.
   - Pages with only 1-2 sections (use 'linear' or 'hold').
   - Short recordings (< 6s) — not enough time for cinematic beats.
   - You're not sure — default to scroll_segments=[] and pick a single scroll style.

  When you DO use segments, scrape them — don't guess:
   fetch_page returns a \`sections\` array with { label, position_fraction, height_fraction } for every meaningful block. Use those fractions verbatim — don't make up positions. Pick 1-3 relevant sections in reading order, skipping noise (newsletter signup, cookie disclaimers that survived dismissal). Map each section.position_fraction → segment.scroll_to. Hero / first segment: travel_ms=0 only if already at top, hold_ms 2000-3000. Subsequent segments: travel_ms 2200-4000, hold_ms calibrated to height_fraction (bigger section → longer hold). Sum should be roughly duration_seconds*1000 minus ~2s settle/tail.

Default mental model: "simple scroll is fine" — proven, predictable, web-recorder-style. Segments are a tool for when the shot genuinely earns the extra complexity.

URL DISCIPLINE — non-negotiable:
Most "broken URL" failures come from the model inventing plausible-looking paths from training data (e.g., guessing "https://twitter.com/SUBJECT" or "https://techcrunch.com/2022/06/23/SUBJECT-raises-22m" or "https://www.crunchbase.com/organization/SUBJECT" without verifying). Stop doing this.

  1. NEVER call fetch_page OR record_url on a URL you got from your own head, EXCEPT when BOTH search backends (tavily_search and web_search) have returned blocked / empty for this library slot AND you're walking the WHEN SEARCH IS BLOCKED ladder (see below). In the normal case, every URL you act on MUST have come from a search result or a prior fetch_page response. Inventing URLs from training data is the #1 cause of 404s.
  2. ALWAYS run tavily_search BEFORE the first fetch_page / record_url for a subtitle beat, unless you already have a verified URL from prior research in this same agent run. Search query must include the SUBJECT's name + a specific qualifier (page type / topic / year). Escalate to the built-in web_search ONLY when tavily_search returns blocked=true.
  3. Search tools return { title, url, snippet } objects. Pick a URL from those results — DO NOT modify the path, DO NOT swap the domain, DO NOT "complete" a URL you partially remember. If the exact URL you wanted isn't in the results, run another search with a different query, OR drop a tier down the ladder.
  4. After search returns URLs, the SAFE order is: fetch_page (cheap, verifies the page exists and contains expected content) THEN record_url (expensive, produces the actual mp4). Skip fetch_page only when the URL is from a domain you trust will render (subject's homepage, YC company page, Wikipedia article you saw in search results) OR when it's a video-host URL (YouTube / Vimeo / Loom / Streamable / Wistia / Dailymotion / v.redd.it / Instagram / TikTok / Facebook — see the VIDEO HOST PASSTHROUGH rule below; fetch_page short-circuits these with video_host_passthrough). NEVER skip for x.com, twitter.com URLs — those are auth-walled for logged-out web visitors and require fetch_page verification first.
  5. Common failure modes the tools now catch and report — when you see them, DO NOT retry the same URL, switch to a different URL FROM YOUR SEARCH RESULTS:
     - http_404 / http_410 / http_5xx → URL is dead; pick from another search result
     - http_999_bot_blocked → LinkedIn-style bot denial: the site refuses logged-out automated visits entirely (already auto-retried once). The page can NEITHER be fetched NOR captured — do NOT commit it as a candidate; pick a public source
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

NEVER skip fetch_page on a URL from these domains — they are NOT trusted-render domains. If fetch_page returns auth_wall_text_detected or matches_expected=false, immediately move to a different source. If you're tempted to put one of these URLs into request_record_approval, STOP — record_url will reject it.

SCREENSHOT-ONLY CAPTURE for auth-walled hosts: when an auth-walled page IS the best same-subject source (e.g., the founder's LinkedIn profile and no public equivalent exists), you MAY still commit it as source="web_page" — auto-capture takes SCREENSHOTS ONLY for linkedin.com / x.com / twitter.com / medium.com and never attempts a recording (it would just bounce off the wall). Flag "screenshot-only" in the candidate's notes and set recommended_scroll to "hold". Prefer a public alternative whenever equivalent content exists. HARD PRECONDITION: fetch_page must have actually RENDERED the page (ok, matches_expected=true). If fetch_page came back http_999_bot_blocked / auth_wall_redirect / auth_wall_text_detected, screenshots will fail the same way — do NOT commit that URL at all.

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
- fetch_page: load a URL in stealth Playwright Chromium (same engine as record_url), wait for full settle, auto-dismiss cookies, detect auth walls. Returns the rendered title, visible body text, real visible images/videos for verification only, sections, AND a matches_expected boolean derived from your expected_content vs the rendered title + text. Returns ok:false with an error when the URL is an auth wall or 404 — switch to a different URL FROM SEARCH RESULTS when that happens. ALWAYS pass expected_content (subject name + qualifier). Use this to EVALUATE a candidate page before committing it as source="web_page" or recording it. Do NOT output the returned image/video URLs as candidates; output the page URL. The URL passed here MUST come from a search result or a prior fetch_page response.

  Wrong-subject worked example (Vori grocery POS):
    tavily_search "Vori grocery POS Twitter" → results include https://twitter.com/vori_life
    fetch_page(url="https://twitter.com/vori_life", expected_content="Vori grocery POS startup founder")
      → returns title="Profile / X", text mentions "Vietnamese lifestyle", matches_expected=false, score 0.05
      → DO NOT use any media from this page. Run another tavily_search ("Vori grocery POS founder X profile") or drop down a tier.
- record_url: same Playwright pipeline as fetch_page but additionally records a real mp4 video. ALWAYS records at 9:16 in mobile view, and ALWAYS captures a clean source — no zoom, no pan, no Ken-Burns moves. Camera moves are an editor-side concern that gets layered in downstream after the recording lands; do not attempt to do them at capture time. AT MOST ONCE SUCCESSFUL PER SHOT, AND ONLY AFTER request_record_approval RETURNS approved=true FOR THE EXACT SAME URL — see the RECORD_URL DISCIPLINE section above. ALWAYS pass expected_content — a short sentence of subject keywords the page text contains — so the score lands on the result for diagnostics. The URL MUST come from a search result or a prior fetch_page response. Pick:
    * duration_seconds — close to the shot's duration_ms (round up by ~2s). Range 3-30.
    * scroll AND scroll_segments — the recorder picks ONE of the two:
        - If scroll_segments is EMPTY: the recorder uses the single \`scroll\` style for the whole recording. Only three styles exist: 'hold' = no scroll (static logos / single-product / one-screen pages); 'linear' = steady gradual reveal capped by runtime speed limits; 'slow' = a gentle creep. Neither mode is allowed to rush through a whole website.
        - If scroll_segments is NON-EMPTY: it OVERRIDES \`scroll\` and runs a cinematic timeline. Each segment animates to \`scroll_to\` (0=top, 1=bottom) over \`travel_ms\`, then HOLDS for \`hold_ms\`. Use this when the page has distinct sections worth pausing on (hero → feature grid → testimonial → CTA), or when the spoken_during has beats that should land on specific content. Pick 1-3 relevant sections, not a full-site tour. Total travel+hold should fit inside duration_seconds*1000 minus ~2s for settle+tail; slack auto-extends the final hold. Example for a 10s recording with three beats: [ { scroll_to: 0, travel_ms: 0, hold_ms: 2500 }, { scroll_to: 0.35, travel_ms: 2800, hold_ms: 2500 } ].
        When unsure: pass scroll='slow' and scroll_segments=[] for the default behavior. Reach for segments when the shot has a clear cinematic intent the agent has read from the spoken_during.
    NOTE on aspect: the synthesis plan's placement.aspect may say 16:9, 4:5, 1:1, etc., but record_url always captures at 9:16 mobile. The editor handles cropping / fitting the 9:16 mp4 into whatever target frame the placement requires.
    NOTE on camera moves: if the synthesis plan's asset.camera_move says "zoom in" / "pan right" / etc., IGNORE that for record_url — the editor will apply the move when it composes the final reel. Your job is to deliver a clean recording.
    VIDEO HOST PASSTHROUGH — DO NOT call fetch_page, request_record_approval, OR record_url for these:
    For URLs on YouTube (watch / youtu.be / embed), Vimeo, Loom, Streamable, Wistia, Dailymotion, v.redd.it, Instagram (reel / reels / p / tv / stories / profile), TikTok (any @user/video URL or vm.tiktok.com link), Facebook (facebook.com/*, m.facebook.com/*, fb.watch/*), the agent SKIPS the entire recording pipeline. These are committed directly as MediaCandidate entries with source="web_video" and url=<the URL>. The editor handles rendering them via embed / iframe / native player at composition time. All three tools (fetch_page, request_record_approval, record_url) short-circuit on these hosts with error="video_host_passthrough" — calling any of them on an ig/tiktok/facebook/youtube URL is a wasted turn.
    Workflow:
      web_capture URL (marketing page, article, etc.) → fetch_page → candidate source="web_page" with page URL OR request_record_approval → record_url → candidate with capture:// recording_url
      video host URL (YouTube / Vimeo / Loom / Streamable / Wistia / Dailymotion / v.redd.it / Instagram / TikTok / Facebook) → commit candidate IMMEDIATELY with source="web_video", url=<the URL>, source_page=<the URL>, title=<from search snippet>. NO fetch_page, NO approval, NO record_url.
    (Reminder: twitter|x.com/y/status URLs are NOT in this list — they're STILL blocked at the auth-wall layer and aren't usable as either recordings or passthroughs.)
- ask_user_clarification: pause and ask the user to disambiguate between equally-plausible candidates. Only call when the WHEN TO ASK section's valid triggers fire. Returns { answer: <one of the options> } as the function output; treat the returned option as authoritative.
- request_record_approval: MANDATORY pre-flight check before record_url. Surfaces { url, approach_description, why_this_url } to the user, who picks yes or no. Returns { approved: true|false, user_answer: string }. Do NOT call record_url unless this returned approved=true for the EXACT same URL — code-level guard rejects mismatched record_url calls.
- AI image / video generation: NOT AVAILABLE. There is no generate_image tool. Real-world media only.

When asset.method = "web_capture" on the weak hint (the dominant method now), the agent's job is to (a) pick the best real URL via web_search + fetch_page, then (b) record_url it. The resulting capture:// URL becomes a MediaCandidate with source = "web_video", url = recording_url, source_page = final_url, title = page_title. The editor can play it directly — no extra step required.

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
- The asset block is a weak hint (web_capture means "go to this URL", stock_search means "find footage matching this query", library_search means "find user footage" — but if library was banned, treat as manual). Use transcript keywords first, then these hints only to surface better candidates.
- For "find founders together"-style intents, plan: search for the company / topic → identify the people by name → search for joint photos / interview videos → fetch promising pages → extract media URLs.
- Cite source_page for every capture:// candidate. For source="web_page", source_page can equal url. Notes should say which visible page section / screen should be captured.
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
      "source": "web_video|web_page|unresolved",
      "url": "<concrete page URL, video-host URL, or capture:// recording URL>",
      "thumbnail_url": "<url or null>",
      "source_page": "<provenance URL or null>",
      "title": "<short title or null>",
      "width": <int or null>,
      "height": <int or null>,
      "duration_ms": <int or null>,
      "recommended_segment_ms": { "start_ms": <int>, "end_ms": <int> } | null,
      "recommended_scroll": "hold|slow|linear" | null,
      "notes": "<one-sentence rationale; for web_page say what page section/screenshot/recording should be captured>"
    }
  ],
  "failure_reason": "<null when candidates >= 1; otherwise a one-sentence explanation>"
}

recommended_scroll — YOU decide how the auto-recorder should scroll each web_page candidate (the user is never asked). Base it on what you actually saw via fetch_page (title, text, sections), not on guesswork:
- "hold": single-screen pages — logo / hero-only pages, profile pages, app-store pages, video-player pages, anything where scrolling adds nothing.
- "linear": scrollable pages — steady gradual reveal capped by runtime speed limits; it may stop mid-page rather than rushing to the bottom.
- "slow": default for long/tall pages, articles, and anything where readability matters; a calm partial creep.
Set it on every web_page candidate. For web_video candidates use null (nothing to scroll).`;

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
  lines.push(
    `Curate library target: find at least ${plan.shots.length} total usable clip/page candidates across the full run (one or more per subtitle beat).`,
  );
  const fullTranscript = plan.shots
    .map((s) => s.spoken_during)
    .filter(Boolean)
    .join(' ');
  lines.push(`Target full transcript: "${fullTranscript}"`);
  const contract = plan.edit_contract;
  if (contract) {
    const rule = contract.shots.find((s) => s.shot_idx === shot.shot_idx);
    lines.push('');
    lines.push('# STRICT EDIT CONTRACT FOR THIS SHOT');
    lines.push(`Contract summary: ${contract.summary}`);
    if (rule) {
      lines.push(`Script trigger: ${rule.script_trigger || '(silent beat)'}`);
      lines.push(`L1 media: ${rule.l1_media}`);
      lines.push(`L2 visual overlay/media: ${rule.l2_visual_overlay}`);
      lines.push(`L3 captions: ${rule.l3_captions}`);
      lines.push(
        `Layout: ${rule.layout.fit} at ${rule.layout.position}, aspect ${rule.layout.aspect}, scale ${rule.layout.scale}`,
      );
      lines.push(`Source category: ${rule.source_category}; method ${rule.source_method}`);
      if (rule.source_instruction) lines.push(`Source instruction: ${rule.source_instruction}`);
      if (rule.motion && rule.motion !== 'none') lines.push(`Motion: ${rule.motion}`);
      if (rule.sfx) lines.push(`SFX: ${rule.sfx}`);
      lines.push(
        'These fields are mandatory. Pick media that satisfies them; do not replace the planned layout or source category with an easier generic source.',
      );
    } else {
      lines.push(
        'This shot has no exact contract row; preserve the global rules and section pattern.',
      );
    }
  }
  lines.push('');
  lines.push('Full subtitle transcript map:');
  for (const s of plan.shots) {
    const keywords = subtitleKeywords(s.spoken_during || '').join(', ') || '(none)';
    lines.push(
      `  ${s.shot_idx}: ${s.structure_role} ${(s.start_ms / 1000).toFixed(2)}s-${(s.end_ms / 1000).toFixed(2)}s — keywords: ${keywords} — "${s.spoken_during || '(silence)'}"`,
    );
  }
  lines.push('');
  lines.push('Topic research requirement before candidates:');
  lines.push(
    '- First infer the real subject/topic from the full transcript, not just this local shot.',
  );
  lines.push(
    '- Run subject-level searches using transcript keywords to learn what the video is about and what credible media sources exist.',
  );
  lines.push(
    '- Prefer media that fits the actual topic: demos, reviews, reels, interviews, product pages, founder/team pages, press, or official assets about the subject.',
  );
  lines.push(
    '- Avoid duplicate obvious sources across the library. Do not default every subtitle beat to the homepage/top search result; search for a distinct page or media angle for this transcript beat.',
  );
  lines.push(
    '- Then gather media for this subtitle beat using that topic context. Do not return generic or wrong-subject media unless all same-subject tiers fail.',
  );
  lines.push(
    '- Return actual web page candidates for recording/screenshots. Do not return image/video URLs scraped from inside a website; use the containing page URL and explain what part to capture.',
  );
  const memory = relevantAgentMemory(plan, shot.spoken_during || shot.broll_description, 6);
  if (memory.length > 0) {
    lines.push('');
    lines.push('Relevant past successful sources (memory; use as hints, verify if reused):');
    for (const item of memory) lines.push(`- ${item}`);
  }
  lines.push('');
  const currentKeywords = subtitleKeywords(shot.spoken_during || '');
  lines.push(`# Library slot ${shot.shot_idx} (${shot.structure_role})`);
  lines.push(
    `time: ${(shot.start_ms / 1000).toFixed(2)}s - ${(shot.end_ms / 1000).toFixed(2)}s  (${(shot.duration_ms / 1000).toFixed(2)}s)`,
  );
  lines.push(`spoken_during: "${shot.spoken_during || '(silence)'}"`);
  lines.push(
    `subtitle_keywords: ${currentKeywords.length > 0 ? currentKeywords.join(', ') : '(infer from spoken_during)'}`,
  );
  lines.push(`broll_description_weak_hint: ${shot.broll_description}`);
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
  lines.push(
    'Research the topic first, then curate this library slot from the subtitle keywords and what is being talked about. Do not go by the shot idea first. Find at least 1 concrete web_page / capture recording / supported video-host candidate for this slot, and 2-5 when distinct useful options exist. Prefer page recordings/screenshots over raw images/videos scraped from pages. Return JSON.',
  );
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
  reasoningLevel: CuratorReasoningLevel;
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

const SUBTITLE_KEYWORD_STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'because',
  'before',
  'could',
  'doing',
  'from',
  'have',
  'here',
  'into',
  'like',
  'more',
  'most',
  'only',
  'over',
  'really',
  'said',
  'says',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
]);

function subtitleKeywords(text: string): string[] {
  const counts = new Map<string, number>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9'$-]*/g)) {
    const word = match[0].replace(/^'+|'+$/g, '');
    if (word.length < 4) continue;
    if (SUBTITLE_KEYWORD_STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 2)
    .map(([word]) => word);
}

function memoryTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9'$-]*/g)) {
    const word = match[0].replace(/^'+|'+$/g, '');
    if (word.length < 4 || SUBTITLE_KEYWORD_STOPWORDS.has(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

interface AgentMemoryEntry {
  at: number;
  kind: 'curator_source';
  subject_hint: string;
  shot_keywords: string[];
  url: string;
  source_page: string | null;
  title: string | null;
  source: MediaCandidate['source'];
  notes: string | null;
  recommended_scroll: ScrollStyle | null;
}

function readAgentMemory(): AgentMemoryEntry[] {
  try {
    if (!existsSync(AGENT_MEMORY_PATH)) return [];
    return readFileSync(AGENT_MEMORY_PATH, 'utf8')
      .split(/\n+/)
      .filter(Boolean)
      .slice(-400)
      .map((line) => JSON.parse(line) as AgentMemoryEntry)
      .filter((entry) => entry.kind === 'curator_source' && !!entry.url);
  } catch {
    return [];
  }
}

function transcriptSubjectHint(plan: SuggestedEdit): string {
  const text = plan.shots
    .map((shot) => shot.spoken_during)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 180);
}

function relevantAgentMemory(
  plan: SuggestedEdit,
  focusText: string,
  max = 6,
): string[] {
  const queryTokens = memoryTokens(
    `${transcriptSubjectHint(plan)} ${focusText}`,
  );
  if (queryTokens.size === 0) return [];
  const scored = readAgentMemory()
    .map((entry) => {
      const haystack = [
        entry.subject_hint,
        entry.shot_keywords.join(' '),
        entry.title ?? '',
        entry.notes ?? '',
        entry.url,
        entry.source_page ?? '',
      ].join(' ');
      const entryTokens = memoryTokens(haystack);
      let overlap = 0;
      for (const token of queryTokens) {
        if (entryTokens.has(token)) overlap += 1;
      }
      return { entry, score: overlap };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
    .slice(0, max);
  return scored.map(({ entry }) => {
    const title = entry.title ? ` — ${entry.title}` : '';
    const scroll =
      entry.source === 'web_page' && entry.recommended_scroll
        ? ` scroll=${entry.recommended_scroll}`
        : '';
    const notes = entry.notes ? ` (${entry.notes.slice(0, 90)})` : '';
    return `${entry.source} ${entry.url}${title}${scroll}${notes}`;
  });
}

function saveAgentMemory(
  plan: SuggestedEdit,
  shot: ShotPlan,
  candidates: MediaCandidate[],
): void {
  const useful = candidates.filter(
    (candidate) =>
      candidate.url &&
      candidate.source !== 'unresolved' &&
      !candidate.url.startsWith('capture://'),
  );
  if (useful.length === 0) return;
  try {
    mkdirSync(dirname(AGENT_MEMORY_PATH), { recursive: true });
    const subject_hint = transcriptSubjectHint(plan);
    const shot_keywords = subtitleKeywords(shot.spoken_during || '');
    const lines = useful.map((candidate) =>
      JSON.stringify({
        at: Date.now(),
        kind: 'curator_source',
        subject_hint,
        shot_keywords,
        url: candidate.url,
        source_page: candidate.source_page ?? null,
        title: candidate.title ?? null,
        source: candidate.source,
        notes: candidate.notes ?? null,
        recommended_scroll: candidate.recommended_scroll ?? null,
      } satisfies AgentMemoryEntry),
    );
    appendFileSync(AGENT_MEMORY_PATH, `${lines.join('\n')}\n`);
  } catch {
    /* best-effort memory */
  }
}

async function executeTool(
  call: ToolCall,
  ctx: ToolExecContext,
): Promise<string> {
  try {
    const args = JSON.parse(call.arguments);
    if (call.name === 'set_reasoning_level') {
      const requested = String(args.reasoning_level ?? '').trim();
      if (
        requested !== 'none' &&
        requested !== 'low' &&
        requested !== 'medium' &&
        requested !== 'high'
      ) {
        return JSON.stringify({
          error: 'invalid_reasoning_level',
          allowed: ['none', 'low', 'medium', 'high'],
        });
      }
      const previous = ctx.reasoningLevel;
      ctx.reasoningLevel = requested as CuratorReasoningLevel;
      return JSON.stringify({
        reasoning_level: ctx.reasoningLevel,
        previous_reasoning_level: previous,
        applied: modelSupportsReasoningEffort(MODEL),
        model: MODEL,
        applies_to: 'next_response',
        reason: String(args.reason ?? '').slice(0, 200),
      });
    }
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
        scroll: (args.scroll as ScrollStyle) ?? 'slow',
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
  const sourcePage = typeof r.source_page === 'string' ? r.source_page : null;
  const normalizedUrl =
    sourceRaw === 'web_image' && sourcePage && sourcePage.trim()
      ? sourcePage.trim()
      : url;
  // generated_image is intentionally NOT in validSources — AI image
  // generation is blacklisted; if the model emits it, fall to 'unresolved'.
  const validSources: MediaCandidate['source'][] = [
    'web_video',
    'web_page',
    'user_provided',
    'unresolved',
  ];
  const source =
    sourceRaw === 'web_image'
      ? 'web_page'
      : validSources.includes(sourceRaw as MediaCandidate['source'])
    ? (sourceRaw as MediaCandidate['source'])
    : 'unresolved';
  const segRaw = r.recommended_segment_ms as
    | { start_ms?: number; end_ms?: number }
    | null
    | undefined;
  const scrollRaw =
    typeof r.recommended_scroll === 'string'
      ? r.recommended_scroll.trim().toLowerCase()
      : '';
  const recommended_scroll = (SCROLL_STYLES as readonly string[]).includes(
    scrollRaw,
  )
    ? (scrollRaw as MediaCandidate['recommended_scroll'])
    : source === 'web_page'
      ? 'slow'
      : null;
  return {
    source,
    url: normalizedUrl,
    thumbnail_url:
      typeof r.thumbnail_url === 'string' ? r.thumbnail_url : null,
    source_page: sourcePage ?? (source === 'web_page' ? normalizedUrl : null),
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
    recommended_scroll,
  };
}

function canonicalCandidateKey(candidate: MediaCandidate): string {
  return (candidate.source_page || candidate.url)
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function verifiedCandidates(candidates: MediaCandidate[]): MediaCandidate[] {
  const seen = new Set<string>();
  const real = candidates.filter((candidate) => candidate.source !== 'unresolved');
  const base = real.length > 0 ? real : candidates;
  const out: MediaCandidate[] = [];
  for (const candidate of base) {
    const key = canonicalCandidateKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function verifiedFailureReason(
  candidates: MediaCandidate[],
  rawFailure: string | null | undefined,
): string | null {
  if (candidates.some((candidate) => candidate.source !== 'unresolved')) {
    return null;
  }
  return rawFailure?.trim() || (candidates.length > 0 ? null : 'no_candidates_returned');
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
  const result = await runAgentLoop(shot, input, opts);
  saveAgentMemory(plan, shot, result.curation.candidates);
  return result;
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

// ---------- reel-level library curation ----------
//
// ONE agent run that sees EVERY shot and curates the full media library
// for the reel in a single pass. This replaces N blind per-shot runs as
// the primary discovery path: because the agent holds the whole reel in
// context, diversity is planned up front (no duplicate sources, no
// near-identical clips across shots) instead of patched after the fact
// with uniqueness retries. The per-shot machinery stays as the gap-fill
// fallback for shots the library leaves empty.

/** Synthetic shot_idx used for reel-level (non-per-shot) agent events. */
export const LIBRARY_SHOT_IDX = -1;

/** Library mode never records in-loop — captures happen automatically
 *  after curation — and clarifications stay available for subject
 *  disambiguation. */
const LIBRARY_TOOLS: Tool[] = TOOLS.filter(
  (t) =>
    !(
      'name' in t &&
      (t.name === 'record_url' || t.name === 'request_record_approval')
    ),
);

const LIBRARY_SYSTEM_PROMPT = `You are a media research agent. ONE RUN = THE WHOLE REEL. Curate a complete LIBRARY of concrete media candidates covering EVERY shot/subtitle beat of a short-form vertical reel, in a single research pass.

You see all the beats at once ON PURPOSE: the #1 job of this run (beyond finding usable media) is DIVERSITY — a varied library with no duplicate and no near-identical clips across shots.

PROCESS:
0. IDENTIFY THE SUBJECT. Read the full target transcript and pin down WHO/WHAT the reel is about — the named company, product, person, or topic. The SUBJECT is the constant across every beat; a beat's local words ("they raised 22 million") make no sense without the subject ("Vori raised 22 million").
0A. BUILD A TOPIC BRIEF FIRST. Run at least one subject-level tavily_search (subject name + strongest transcript keywords). Identify: what the subject is, key people/products/events, credible source domains, likely media types (demo videos, reviews, interviews, product pages, press, founder profiles). This brief guides the WHOLE library.
1. PLAN THE LIBRARY BEFORE SEARCHING PER-BEAT. Sketch which source TYPE each beat should get so the library spreads across: homepage/product pages, demo or review videos, founder/team pages, press articles, directories (YC / Crunchbase / Wikipedia), docs, social video. Assign the obvious anchors (homepage, YC profile, top press hit) to the beats that need them MOST — each such anchor appears AT MOST ONCE in the library.
2. RESEARCH EACH BEAT from its 1-2 strongest spoken keywords (broll_description is a weak hint only). Chain tavily_search → fetch_page to verify pages before committing them.
3. OUTPUT the library, assigning every candidate to exactly ONE shot_idx.

DIVERSITY MANDATE (hard rules):
- No two candidates may share the same URL or the same page (ignoring query string / hash). Code-level dedup will DROP later duplicates, leaving that beat empty — so don't emit them.
- Near-duplicates count as duplicates: two recordings of the same homepage, two articles about the same announcement, two profile pages of the same person. Pick the strongest one for the beat that needs it most and find a DIFFERENT angle for the other beat.
- A domain should appear at most twice across the library, and only when the two pages show meaningfully different content (say which section in notes).
- Each shot gets 1-3 candidates ranked best-first; EVERY shot_idx listed in the user message MUST appear at least once in the library.

BEAT RELEVANCE — clips must match what is being SAID:
- A viewer pausing on a candidate's page/video during its beat should see content that matches the spoken line (or at minimum the subject). Assign each candidate to the beat whose words it actually supports — don't park a leftover source on an unrelated beat just to fill it.
- An automatic relevance judge runs after your output and DROPS candidates that are about a different subject or unrelated to their beat — a dropped candidate wastes the slot and forces a slower per-shot rescue. In each candidate's notes, tie it to its beat's spoken words in a few words.

SUBJECT ANCHORING — strong default (relaxes only at Tier 5 of the ladder):
- EVERY search query MUST include the subject's name. "$22 million funding" is wrong; "Vori $22 million funding" is right.
- A page must be about the subject for Tier 1-4. Returning a DIFFERENT company's media as if it were the subject's is BANNED.

URL DISCIPLINE — non-negotiable:
1. NEVER call fetch_page on a URL from your own head. Every URL you act on MUST come from a search result or a prior fetch_page response. Inventing URLs from training data is the #1 cause of 404s.
2. ALWAYS run tavily_search before the first fetch_page for a beat unless you already verified the URL earlier in THIS run. Escalate to the built-in web_search ONLY when tavily_search returns blocked=true.
3. Pick URLs from results verbatim — do not modify paths, swap domains, or "complete" remembered URLs.
4. ALWAYS pass expected_content ("<subject name> <one qualifier>") to fetch_page. matches_expected=false means WRONG SUBJECT — do not use the page; pick a different result.
5. On http_404 / http_999_bot_blocked / auth_wall_redirect / not_found_text_detected: do NOT retry the same URL; switch to a different search result. http_999_bot_blocked (LinkedIn-style bot denial) means the page can neither be fetched nor captured — never commit such a URL.
6. If both search backends are blocked for a real subject, try trusted roots directly (subject's .com/.io/.ai, en.wikipedia.org/wiki/<Subject>, ycombinator.com/companies/<slug>, crunchbase.com/organization/<slug>, github.com/<name>) — each with expected_content set.

SOURCE PREFERENCE — public over auth-walled:
linkedin.com, x.com/twitter.com (especially /status/ URLs), and medium paywalls are auth/app-walled for logged-out visitors. Prefer public alternatives: subject's own site, Crunchbase/Wikipedia, YC directory, GitHub, public press, YouTube (not Shorts), institutional pages. When an auth-walled page IS the strongest same-subject source for a beat (e.g. the founder's LinkedIn profile, a key X post), you MAY commit it as source="web_page" — these hosts are captured as SCREENSHOTS ONLY (a recording is never attempted; it would just bounce off the wall). Flag "screenshot-only" in notes and set recommended_scroll to "hold". HARD PRECONDITION: fetch_page must have actually RENDERED it (ok, matches_expected=true) — if fetch_page returned http_999_bot_blocked or an auth-wall error, screenshots will fail the same way, so do NOT commit that URL.

OUTPUT POLICY — PAGE CAPTURES, NOT SCRAPED ASSETS:
- Normal websites / articles / company / review / demo / docs / directory pages → source="web_page" with url=<page URL>. The app auto-records the page and captures screenshots AFTER curation — you do not record anything in this loop.
- Do NOT return raw image URLs or direct .mp4/.webm file URLs scraped from inside a page. Return the containing page as source="web_page" with notes saying which section/visual to capture.
- VIDEO HOST PASSTHROUGH: URLs on YouTube (watch / youtu.be / embed), Vimeo, Loom, Streamable, Wistia, Dailymotion, v.redd.it, Instagram, TikTok, Facebook are committed DIRECTLY as source="web_video" with url=<the URL> — do NOT fetch_page them (the tool short-circuits with video_host_passthrough). When only a segment of a long video is relevant, set recommended_segment_ms.

REASONING LEVEL CONTROL:
Call set_reasoning_level by your own judgment: low for routine search/fetch; medium for cross-beat diversity planning and comparing mixed sources; high for conflicting evidence or hard improvisation. Lower it again for routine work and the final JSON.

WHEN TO ASK THE USER — confused, don't guess:
Call ask_user_clarification ONLY when two same-tier candidates are equally plausible on real evidence (wrong-person/wrong-company forks), the SUBJECT itself is ambiguous from the transcript, or fetched pages give conflicting signals. Never ask before searching, never ask when one more query would resolve it, never ask because you have zero candidates (walk the ladder instead). At most 2 clarifications for the WHOLE run.

NEVER LEAVE A BEAT EMPTY — IMPROVISATION LADDER:
Tier 1 EXACT → Tier 2 ADJACENT same-subject same-topic → Tier 3 same-subject any-topic (leadership/team) → Tier 4 subject brand assets (homepage hero, product shots, press kit) → Tier 5 TOPIC-ANCHORED generic visual (last resort; flag it in notes). Tool failures are NOT "no public presence" — walk the blocked-search ladder before giving up. failure_reason stays null unless the subject truly has zero public web presence.

There is NO TURN LIMIT. Take as many tool calls as you need — but reuse your topic brief across beats instead of re-searching the same ground; repeated identical searches are cached anyway.

Output ONE JSON object (no markdown fences, no preamble):
{
  "research_notes": "<2-4 sentences: subject, library strategy, how diversity was achieved>",
  "library": [
    {
      "shot_idx": <int — the one shot this clip is assigned to>,
      "source": "web_video|web_page|unresolved",
      "url": "<concrete page URL or video-host URL>",
      "thumbnail_url": "<url or null>",
      "source_page": "<provenance URL or null>",
      "title": "<short title or null>",
      "width": <int or null>,
      "height": <int or null>,
      "duration_ms": <int or null>,
      "recommended_segment_ms": { "start_ms": <int>, "end_ms": <int> } | null,
      "recommended_scroll": "hold|slow|linear" | null,
      "notes": "<rationale; which page section to capture; tier if improvised; why this source is DISTINCT from the rest of the library>"
    }
  ],
  "failure_reason": "<null when every shot got >= 1 candidate; otherwise one sentence>"
}

recommended_scroll — YOU decide how the auto-recorder should scroll each web_page candidate (the user is never asked). Base it on what you actually saw via fetch_page (title, text, sections), not on guesswork:
- "hold": single-screen pages — logo / hero-only pages, profile pages, app-store pages, video-player pages, anything where scrolling adds nothing.
- "linear": scrollable pages — steady gradual reveal capped by runtime speed limits; it may stop mid-page rather than rushing to the bottom.
- "slow": default for long/tall pages, articles, and anything where readability matters; a calm partial creep.
Set it on every web_page candidate. For web_video candidates use null (nothing to scroll). Vary it with the page type — a library where every entry scrolls the same way reads as monotonous.`;

function buildLibraryPrompt(
  plan: SuggestedEdit,
  shots: ShotPlan[],
  extraUserPrompt?: string,
): string {
  const lines: string[] = [];
  if (extraUserPrompt && extraUserPrompt.trim().length > 0) {
    lines.push('# ADDITIONAL USER GUIDANCE FOR THIS RUN');
    lines.push(extraUserPrompt.trim());
    lines.push('');
    lines.push(
      'Treat the guidance above as a hard constraint. It overrides the original shot ideas wherever they conflict.',
    );
    lines.push('');
  }
  lines.push(
    `Target reel duration: ${(plan.total_duration_ms / 1000).toFixed(1)}s, ${plan.shots.length} shots total; ${shots.length} of them need library candidates from this run.`,
  );
  const fullTranscript = plan.shots
    .map((s) => s.spoken_during)
    .filter(Boolean)
    .join(' ');
  lines.push(`Target full transcript: "${fullTranscript}"`);
  if (plan.edit_contract) {
    lines.push('');
    lines.push('# STRICT EDIT CONTRACT');
    lines.push(`Contract summary: ${plan.edit_contract.summary}`);
    lines.push('Global rules:');
    for (const rule of plan.edit_contract.global_rules.slice(0, 8)) {
      lines.push(`- ${rule.label}: ${rule.requirement}`);
    }
    lines.push('');
    lines.push('Per-shot contract rows to satisfy:');
    const wanted = new Set(shots.map((s) => s.shot_idx));
    for (const rule of plan.edit_contract.shots.filter((s) => wanted.has(s.shot_idx))) {
      lines.push(
        `  shot_idx ${rule.shot_idx}: trigger="${rule.script_trigger || '(silent)'}"; ` +
          `L1=${rule.l1_media}; L2=${rule.l2_visual_overlay}; ` +
          `layout=${rule.layout.fit}/${rule.layout.position}; ` +
          `source=${rule.source_category} via ${rule.source_method}; ` +
          `instruction=${rule.source_instruction || '(match the beat)'}`,
      );
    }
    lines.push(
      'Use these rows as hard constraints when assigning media. The final library should make the plan follow the analysis contract, not just fill empty slots.',
    );
  }
  lines.push('');
  lines.push(
    'Beats to fill (assign every candidate to exactly one of THESE shot_idx values; every one of them must get at least 1 candidate):',
  );
  for (const s of shots) {
    const keywords =
      subtitleKeywords(s.spoken_during || '').join(', ') || '(none)';
    lines.push(
      `  shot_idx ${s.shot_idx}: ${s.structure_role} ${(s.start_ms / 1000).toFixed(2)}s-${(s.end_ms / 1000).toFixed(2)}s (${(s.duration_ms / 1000).toFixed(1)}s) — keywords: ${keywords} — "${s.spoken_during || '(silence)'}" — weak visual hint: ${s.broll_description}`,
    );
  }
  lines.push('');
  lines.push(
    'Research the subject + topic first, plan the library for diversity, then fill every beat. Return JSON.',
  );
  const memory = relevantAgentMemory(plan, fullTranscript, 8);
  if (memory.length > 0) {
    lines.push('');
    lines.push('Relevant past successful sources (memory; use as hints, verify if reused):');
    for (const item of memory) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

interface RawLibraryEntry {
  shot_idx?: unknown;
  shot_idxs?: unknown;
}

interface RawLibrary {
  research_notes?: string;
  library?: unknown[];
  failure_reason?: string | null;
}

export interface LibraryResearchResult {
  research_notes: string;
  /** Per-shot candidate assignments. Candidates are unique across the
   *  whole map — a URL assigned to two shots keeps only its first
   *  assignment. Shots the agent left empty are simply absent. */
  assignments: Map<number, MediaCandidate[]>;
  failure_reason: string | null;
  usage: AgentUsage;
  trace: AgentTrace;
}

/** Run ONE reel-level agent pass that curates the media library for all
 *  `shots` at once (diversity planned in-context), instead of N blind
 *  per-shot runs. Events fire with shot_idx = LIBRARY_SHOT_IDX. */
export async function researchLibrary(
  plan: SuggestedEdit,
  shots: ShotPlan[],
  opts: ResearchShotOptions = {},
): Promise<LibraryResearchResult> {
  const empty = (
    failure: string,
    notes: string,
    trace?: AgentTrace,
    usage?: AgentUsage,
  ): LibraryResearchResult => ({
    research_notes: notes,
    assignments: new Map(),
    failure_reason: failure,
    usage: usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    trace:
      trace ?? {
        shot_idx: LIBRARY_SHOT_IDX,
        turns: [],
        final_text: '',
        finished_at_turn: 0,
        reason: 'api_error',
        tokens: { input: 0, output: 0, total: 0 },
      },
  });
  if (shots.length === 0) return empty('no_shots', '(no shots to research)');
  if (opts.signal?.aborted) return empty('aborted', '(aborted before start)');
  if (!getOpenAI()) {
    return empty('no_api_key', '(OPENAI_API_KEY not set; curator skipped)');
  }

  // The loop only needs a shot for its shot_idx (events, trace, record
  // budget) — give it a synthetic reel-level one.
  const pseudoShot = { shot_idx: LIBRARY_SHOT_IDX } as ShotPlan;
  const input: ResponseInputItem[] = [
    { type: 'message', role: 'system', content: LIBRARY_SYSTEM_PROMPT },
    {
      type: 'message',
      role: 'user',
      content: buildLibraryPrompt(plan, shots, opts.extraUserPrompt),
    },
  ];
  const result = await runAgentLoop(pseudoShot, input, opts, LIBRARY_TOOLS);
  const finalText = result.trace.final_text;
  if (!finalText) {
    return empty(
      result.curation.failure_reason ?? 'no_output',
      result.curation.research_notes,
      result.trace,
      result.usage,
    );
  }

  let parsed: RawLibrary;
  try {
    const cleaned = finalText
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned) as RawLibrary;
  } catch (err) {
    return empty(
      `parse_error: ${err instanceof Error ? err.message : String(err)}`,
      '(final output was not valid JSON)',
      result.trace,
      result.usage,
    );
  }

  const validIdxs = new Set(shots.map((s) => s.shot_idx));
  const assignments = new Map<number, MediaCandidate[]>();
  const seenUrls = new Set<string>();
  for (const rawEntry of Array.isArray(parsed.library) ? parsed.library : []) {
    const candidate = normalizeCandidate(rawEntry);
    if (!candidate) continue;
    const entry = rawEntry as RawLibraryEntry;
    // Accept shot_idx (canonical) or shot_idxs[0] (model drift).
    const idxRaw =
      typeof entry.shot_idx === 'number'
        ? entry.shot_idx
        : Array.isArray(entry.shot_idxs) &&
            typeof entry.shot_idxs[0] === 'number'
          ? entry.shot_idxs[0]
          : null;
    if (idxRaw === null || !validIdxs.has(idxRaw)) continue;
    // Diversity enforcement: each source appears once in the library.
    const key = canonicalCandidateKey(candidate);
    if (key && seenUrls.has(key)) continue;
    if (key) seenUrls.add(key);
    const list = assignments.get(idxRaw) ?? [];
    list.push(candidate);
    assignments.set(idxRaw, list);
  }
  for (const shot of shots) {
    saveAgentMemory(plan, shot, assignments.get(shot.shot_idx) ?? []);
  }

  return {
    research_notes: parsed.research_notes?.trim() || '',
    assignments,
    failure_reason:
      [...assignments.values()].some((items) => items.length > 0)
        ? null
        : verifiedFailureReason([], parsed.failure_reason),
    usage: result.usage,
    trace: result.trace,
  };
}

async function runAgentLoop(
  shot: ShotPlan,
  input: ResponseInputItem[],
  opts: ResearchShotOptions,
  tools: Tool[] = TOOLS,
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
    reasoningLevel: DEFAULT_REASONING_LEVEL,
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
      const responseParams = {
        model: MODEL,
        input,
        tools,
        ...(modelSupportsReasoningEffort(MODEL)
          ? { reasoning: { effort: ctx.reasoningLevel } }
          : {}),
      };
      resp = await client.responses.create(
        responseParams,
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

  const candidates = verifiedCandidates(Array.isArray(parsed.candidates)
    ? parsed.candidates
        .map(normalizeCandidate)
        .filter((c): c is MediaCandidate => c !== null)
    : []);

  return {
    curation: {
      shot_idx: shot.shot_idx,
      research_notes: parsed.research_notes?.trim() || '',
      candidates,
      failure_reason: verifiedFailureReason(candidates, parsed.failure_reason),
    },
    usage,
    trace: buildTrace(),
    final_input: input,
  };
}
