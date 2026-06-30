// Hook archetype clustering via OpenAI.
//
// The per-reel `hook_text` is the OCR'd first-shot text overlay — raw
// strings like "POV: you walked in", "3 things I wish I knew". A
// creator's collection of those reveals repeating PATTERNS the
// script-gen LLM can fill in.
//
// We hand the list of hook strings to GPT and ask for 2-4 templates
// with weights + example fills. Best-effort: a missing API key or
// API error returns null so callers can fall back to the raw strings.

import OpenAI from 'openai';

const MODEL = process.env.ONETAKE_ANALYZE_MODEL?.trim() || 'gpt-4o';

/** One inferred hook pattern this creator reuses. */
export interface HookArchetype {
  /** Template with `<placeholders>` for the varying part(s),
   *  e.g., "POV: <situation>" or "<N> things <descriptor>". */
  template: string;
  /** Fraction of the supplied hook strings that fit this template,
   *  in [0,1]. The set across all archetypes ~sums to 1. */
  weight: number;
  /** Up to 3 example hooks from the input that match this template. */
  examples: string[];
  /** One-sentence describer for downstream LLM consumers — when to
   *  reach for this template ("punchy attention-grab", "list opener"). */
  description: string;
}

const SYSTEM_PROMPT = `You analyze short-video creator hooks (the first
line of text-on-screen in a reel) and surface the 1-4 reusable templates
the creator repeats across their work. Be concrete and literal — return
templates the script writer can actually fill in, not vague vibes.

Return ONLY a JSON object with this exact shape (no markdown, no prose):
{
  "archetypes": [
    {
      "template": "POV: <situation>",
      "weight": 0.5,
      "examples": ["POV: you discover Bali", "POV: your barista nails it"],
      "description": "Second-person scene-setter, immersive."
    },
    ...
  ]
}

Rules:
- Use angle-bracket placeholders like <situation>, <N>, <topic>.
- Weights are the fraction of the input hooks that fit each template,
  summing to ~1.0 across archetypes.
- Examples must be COPIED VERBATIM from the input, not paraphrased.
- If hooks don't show a clear pattern (each is unique), return a single
  archetype with template "<freeform>" and weight 1.0.
- Don't invent templates that aren't supported by at least 2 examples
  unless the input has fewer than 4 hooks total.`;

/** Cluster hook strings into reusable templates via OpenAI. Returns
 *  null when no API key is configured or the call fails — callers
 *  should fall back to the raw hook list. */
export async function clusterHooks(
  hookTexts: string[],
): Promise<HookArchetype[] | null> {
  if (hookTexts.length === 0) return [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[hook-cluster] OPENAI_API_KEY not set');
    return null;
  }

  const client = new OpenAI({ apiKey });
  const userMessage =
    `Hooks from one creator's reels (one per line):\n\n` +
    hookTexts.map((t) => `- "${t.replace(/\n/g, ' ').slice(0, 200)}"`).join('\n');

  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? '';
    if (!text) {
      console.error('[hook-cluster] empty response');
      return null;
    }
    const parsed = JSON.parse(text) as { archetypes?: HookArchetype[] };
    if (!parsed.archetypes || !Array.isArray(parsed.archetypes)) {
      console.error('[hook-cluster] missing archetypes array');
      return null;
    }
    // Light validation + normalization.
    const out: HookArchetype[] = [];
    for (const a of parsed.archetypes) {
      if (
        typeof a.template !== 'string' ||
        typeof a.weight !== 'number' ||
        typeof a.description !== 'string' ||
        !Array.isArray(a.examples)
      ) {
        continue;
      }
      out.push({
        template: a.template,
        weight: Math.max(0, Math.min(1, a.weight)),
        examples: a.examples
          .filter((e: unknown): e is string => typeof e === 'string')
          .slice(0, 3),
        description: a.description,
      });
    }
    return out;
  } catch (err) {
    console.error(
      '[hook-cluster] API call failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
