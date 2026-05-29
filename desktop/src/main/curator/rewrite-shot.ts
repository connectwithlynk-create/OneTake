// Auto-retry helper: when the curator agent fails on a shot
// (failure_reason set, or zero candidates), this module asks the LLM
// to propose a NEW, more-sensible broll idea for the slot — one
// aimed at a high-acquirability public web resource — so the curator
// can be re-run on the rewritten shot instead of leaving a warning.
//
// The rewrite changes only the visual idea + acquisition spec:
// broll_description, asset, source_type. Timing, structure_role,
// spoken_during, text overlay, etc. are preserved.
import OpenAI from 'openai';
import type {
  BrollPlacement,
  ShotAsset,
  ShotOption,
  ShotPlan,
  SuggestedEdit,
} from '../analyze/synthesize';

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 800;

const SYSTEM_PROMPT = `You are rescuing a single shot in a short-form video edit plan. The original shot idea failed: the research agent searched the web and could not find usable media for it. Your job: propose a NEW, MORE SENSIBLE shot idea that targets media the agent CAN find.

CONSTRAINTS:
- Keep the shot's narrative purpose (spoken_during, structure_role). The visual must still fit the spoken line.
- The new idea must target a REAL, PUBLIC, HIGH-ACQUIRABILITY web resource: the subject's official site, the subject's public social profile, a Wikipedia / Wikimedia page about the subject, the subject's press kit, a public press article about the subject, or — as a last resort — a clearly-described generic topic visual.
- BANNED methods: manual, generate_image, any "generate_*" / "ai_*" method, and library_search. You are restricted to web_capture, and only when stock was already opted-in may you use stock_search.
- The new asset.web_capture.url must point to a SPECIFIC resource (a real domain root or article URL — not "example.com", not a guessed path that probably 404s).
- Do NOT repeat the failed idea. Pick a DIFFERENT angle (drop one tier down the improvisation ladder: same-subject brand asset, public profile, topic-level visual).

Output STRICT JSON only (no markdown fences, no preamble) matching:
{
  "broll_description": "<one specific sentence — the NEW visual>",
  "source_type": "<short label of where this comes from, e.g. 'subject's website hero', 'public LinkedIn profile', 'topic-anchored fallback'>",
  "asset": {
    "method": "web_capture",
    "web_capture": { "url": "<real specific URL>", "focus": "<what to capture on that page>" },
    "camera_move": "<motion hint or null>"
  },
  "rationale": "<one sentence: why this is more findable than the failed idea>"
}`;

interface RawRewrite {
  broll_description?: string;
  source_type?: string;
  asset?: {
    method?: string;
    web_capture?: { url?: string; focus?: string } | null;
    stock_search?: { query?: string } | null;
    camera_move?: string | null;
  } | null;
  rationale?: string;
}

function buildUserMessage(
  shot: ShotPlan,
  plan: SuggestedEdit,
  failureReason: string,
  userPrompt?: string,
): string {
  const lines: string[] = [];
  const fullText = plan.shots
    .map((s) => s.spoken_during)
    .filter(Boolean)
    .join(' ');
  if (userPrompt && userPrompt.trim().length > 0) {
    lines.push('# USER PROMPT — HARD CONSTRAINT');
    lines.push(userPrompt.trim());
    lines.push('');
    lines.push(
      'Your rewrite MUST follow the user prompt above. It overrides the original shot idea wherever they conflict.',
    );
    lines.push('');
  }
  lines.push(`# Target reel`);
  lines.push(`Full transcript: "${fullText}"`);
  lines.push('');
  lines.push(`# Failed shot ${shot.shot_idx}`);
  lines.push(`structure_role: ${shot.structure_role}`);
  lines.push(`spoken_during: "${shot.spoken_during || '(silence)'}"`);
  lines.push(`time: ${(shot.start_ms / 1000).toFixed(2)}s - ${(shot.end_ms / 1000).toFixed(2)}s`);
  lines.push('');
  lines.push(`## What the synthesizer tried (and the curator failed to acquire)`);
  lines.push(`broll_description: ${shot.broll_description}`);
  lines.push(`source_type: ${shot.source_type}`);
  lines.push(`asset.method: ${shot.asset.method}`);
  if (shot.asset.web_capture) {
    lines.push(
      `asset.web_capture: url=${shot.asset.web_capture.url}, focus="${shot.asset.web_capture.focus}"`,
    );
  }
  if (shot.asset.stock_search) {
    lines.push(`asset.stock_search.query: "${shot.asset.stock_search.query}"`);
  }
  lines.push('');
  lines.push(`## Curator failure reason`);
  lines.push(failureReason);
  lines.push('');
  lines.push(`## Other ideas the synthesizer already considered (avoid duplicating these)`);
  for (const o of shot.options) {
    lines.push(`- (${o.tier}) ${o.broll_description}`);
  }
  lines.push('');
  lines.push(
    'Propose a NEW, more-acquirable broll idea now. Output JSON only.',
  );
  return lines.join('\n');
}

function normalizeAsset(raw: RawRewrite['asset'], original: ShotAsset): ShotAsset {
  // Default everything to null; copy through only what the model gave
  // us in a permitted shape. Method is forced to web_capture (or
  // stock_search) — manual / generate_* are banned even if requested.
  const method = raw?.method === 'stock_search' ? 'stock_search' : 'web_capture';
  const web_capture =
    method === 'web_capture' && raw?.web_capture?.url
      ? {
          url: raw.web_capture.url.trim(),
          focus: (raw.web_capture.focus ?? '').trim(),
        }
      : null;
  const stock_search =
    method === 'stock_search' && raw?.stock_search?.query
      ? { query: raw.stock_search.query.trim() }
      : null;
  return {
    method,
    web_capture,
    stock_search,
    library_search: null,
    generate_image: null,
    manual: null,
    camera_move:
      typeof raw?.camera_move === 'string' && raw.camera_move.trim().length > 0
        ? raw.camera_move.trim()
        : original.camera_move ?? null,
  };
}

export interface RewriteShotOptions {
  /** Extra user guidance to bake in as a hard constraint on the
   *  rewrite (per-shot regenerate UX). */
  userPrompt?: string;
  /** Cancellation. Aborts the in-flight OpenAI call. */
  signal?: AbortSignal;
}

/** Ask the LLM for a more-acquirable broll idea for this shot. Returns
 *  a new ShotPlan (the original with broll_description / asset /
 *  source_type / options[0] replaced), or null on failure (no API key,
 *  malformed response, etc.). */
export async function rewriteShotIdea(
  shot: ShotPlan,
  plan: SuggestedEdit,
  failureReason: string,
  options: RewriteShotOptions = {},
): Promise<ShotPlan | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (options.signal?.aborted) return null;
  const client = new OpenAI({ apiKey });

  let text = '';
  try {
    const resp = await client.chat.completions.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserMessage(
              shot,
              plan,
              failureReason,
              options.userPrompt,
            ),
          },
        ],
      },
      options.signal ? { signal: options.signal } : undefined,
    );
    text = resp.choices[0]?.message?.content ?? '';
  } catch (err) {
    if (!options.signal?.aborted) {
      console.error(
        '[rewrite-shot] API call failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
  if (!text.trim()) return null;

  let parsed: RawRewrite;
  try {
    parsed = JSON.parse(text) as RawRewrite;
  } catch (err) {
    console.error(
      '[rewrite-shot] JSON parse failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  const newDesc = (parsed.broll_description ?? '').trim();
  if (!newDesc) return null;
  const newAsset = normalizeAsset(parsed.asset ?? null, shot.asset);
  // Require a real target (URL or query) — empty assets aren't useful.
  if (
    newAsset.method === 'web_capture' &&
    (!newAsset.web_capture || !newAsset.web_capture.url)
  ) {
    return null;
  }
  if (
    newAsset.method === 'stock_search' &&
    (!newAsset.stock_search || !newAsset.stock_search.query)
  ) {
    return null;
  }

  const newSource = (parsed.source_type ?? '').trim() || shot.source_type;
  const placement: BrollPlacement = shot.placement;
  const newOption: ShotOption = {
    tier: 'ideal',
    fit_score: 0.85,
    likelihood: null,
    broll_description: newDesc,
    asset: newAsset,
    placement,
    source_type: newSource,
    rationale:
      (parsed.rationale ?? '').trim() ||
      'Auto-rewritten after the original idea failed curation.',
  };

  return {
    ...shot,
    broll_description: newDesc,
    asset: newAsset,
    placement,
    source_type: newSource,
    options: [newOption, ...shot.options],
  };
}
