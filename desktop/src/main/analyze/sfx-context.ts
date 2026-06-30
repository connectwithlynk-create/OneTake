// SFX-in-context analysis: how a reel uses sound effects RELATIVE to the
// spoken transcript and structure — not just which type each onset is.
//
// Detection (sfx.ts) gives onset times; sfx-classify gives coarse types;
// this module joins those with the Whisper word stream to recover the
// *pattern*: "a ding on nearly every word", "tones escalating through the
// hook", "a vocal 'wow' when something important is said". Deterministic
// signals cover cadence/position/escalation; an OpenAI pass over an
// SFX-annotated transcript covers the semantic triggers (which MOMENTS get
// a hit) and writes a natural-language summary for synthesis to replicate.
import OpenAI from 'openai';
import type { TranscriptWord } from './transcribe';
import type { Shot } from './scene-detect';
import type { SfxType } from './sfx-classify';

const MODEL = process.env.ONETAKE_ANALYZE_MODEL?.trim() || 'gpt-4o';
/** A SFX onset counts as "on the word" if it lands within this of a word
 *  start. ~120 ms ≈ one syllable's attack — tight enough to mean "on it". */
const ALIGN_MS = 120;
/** Cap how much of the annotated transcript we send to the model. */
const MAX_WORDS_FOR_LLM = 140;

/** A detected SFX onset with its coarse acoustic type. */
export interface TypedSfxEvent {
  ms: number;
  type: SfxType;
}

export interface SfxContextSignals {
  sfx_count: number;
  word_count: number;
  /** SFX onsets per spoken word. ~1.0 ⇒ "an SFX on every word". */
  sfx_per_word: number;
  /** Fraction of SFX onsets landing within ALIGN_MS of a word start. */
  on_word_pct: number;
  /** SFX onsets per second inside the hook window. */
  hook_density_per_s: number;
  /** SFX onsets per second after the hook. */
  body_density_per_s: number;
  /** -1..1: positive ⇒ onsets get denser through the hook (escalation). */
  hook_escalation: number;
  /** Dominant SFX type in the hook window, or null. */
  hook_dominant_type: SfxType | null;
  /** Dominant SFX type after the hook, or null. */
  body_dominant_type: SfxType | null;
}

/** One learned placement rule, structured so synthesis/export can apply it. */
export interface SfxContextRule {
  /** When the SFX fires, in content terms. e.g. "every emphasized word",
   *  "building through the hook", "on a reveal / punchline word". */
  trigger: string;
  /** Coarse SFX type to use. */
  sfx_type: SfxType;
  /** Optional example moment from the transcript. */
  example?: string;
}

export interface SfxContext {
  signals: SfxContextSignals;
  /** One- or two-sentence natural-language characterization. */
  pattern_summary: string;
  /** Structured placement rules for replication. */
  rules: SfxContextRule[];
  /** True when summary/rules came from the model (vs deterministic template). */
  llm: boolean;
}

function dominant(counts: Map<SfxType, number>): SfxType | null {
  let best: SfxType | null = null;
  let max = 0;
  for (const [t, n] of counts) {
    if (n > max) {
      max = n;
      best = t;
    }
  }
  return best;
}

export function computeSfxSignals(
  events: TypedSfxEvent[],
  words: TranscriptWord[],
  hookMs: number,
  reelMs: number,
): SfxContextSignals {
  const sfx_count = events.length;
  const word_count = words.length;
  const sortedWordStarts = words.map((w) => w.start_ms).sort((a, b) => a - b);

  let onWord = 0;
  for (const e of events) {
    // nearest word start (linear scan is fine — reels are short)
    let nearest = Infinity;
    for (const ws of sortedWordStarts) {
      const d = Math.abs(e.ms - ws);
      if (d < nearest) nearest = d;
      if (ws > e.ms + ALIGN_MS) break;
    }
    if (nearest <= ALIGN_MS) onWord++;
  }

  const hookEvents = events.filter((e) => e.ms < hookMs);
  const bodyEvents = events.filter((e) => e.ms >= hookMs);
  const hookDurS = Math.max(hookMs, 1) / 1000;
  const bodyDurS = Math.max(reelMs - hookMs, 1) / 1000;

  // Escalation: density of hook's second half vs first half.
  const halfMs = hookMs / 2;
  const firstHalf = hookEvents.filter((e) => e.ms < halfMs).length;
  const secondHalf = hookEvents.filter((e) => e.ms >= halfMs).length;
  const denom = firstHalf + secondHalf;
  const escalation =
    denom === 0 ? 0 : (secondHalf - firstHalf) / denom;

  const hookTypes = new Map<SfxType, number>();
  for (const e of hookEvents) hookTypes.set(e.type, (hookTypes.get(e.type) ?? 0) + 1);
  const bodyTypes = new Map<SfxType, number>();
  for (const e of bodyEvents) bodyTypes.set(e.type, (bodyTypes.get(e.type) ?? 0) + 1);

  return {
    sfx_count,
    word_count,
    sfx_per_word: word_count > 0 ? sfx_count / word_count : 0,
    on_word_pct: sfx_count > 0 ? onWord / sfx_count : 0,
    hook_density_per_s: hookEvents.length / hookDurS,
    body_density_per_s: bodyEvents.length / bodyDurS,
    hook_escalation: escalation,
    hook_dominant_type: dominant(hookTypes),
    body_dominant_type: dominant(bodyTypes),
  };
}

/** Interleave words and SFX markers in time order, e.g.
 *  "this is ⟨ding⟩ actually ⟨vocal⟩ insane". Capped for token budget. */
export function buildAnnotatedTranscript(
  events: TypedSfxEvent[],
  words: TranscriptWord[],
): string {
  const w = words.slice(0, MAX_WORDS_FOR_LLM);
  if (w.length === 0) return '';
  const cutoff = w[w.length - 1].end_ms;
  const evs = [...events]
    .filter((e) => e.ms <= cutoff + ALIGN_MS)
    .sort((a, b) => a.ms - b.ms);
  let ei = 0;
  const parts: string[] = [];
  for (const word of w) {
    while (ei < evs.length && evs[ei].ms <= word.start_ms + ALIGN_MS) {
      parts.push(`⟨${evs[ei].type}⟩`);
      ei++;
    }
    parts.push(word.text);
  }
  while (ei < evs.length) {
    parts.push(`⟨${evs[ei].type}⟩`);
    ei++;
  }
  return parts.join(' ');
}

function templateSummary(s: SfxContextSignals): {
  summary: string;
  rules: SfxContextRule[];
} {
  const rules: SfxContextRule[] = [];
  const bits: string[] = [];
  if (s.sfx_count === 0) {
    return { summary: 'No SFX detected.', rules: [] };
  }
  if (s.sfx_per_word >= 0.6) {
    bits.push('an SFX on nearly every word');
    if (s.hook_dominant_type || s.body_dominant_type) {
      rules.push({
        trigger: 'every word / beat',
        sfx_type: s.body_dominant_type ?? s.hook_dominant_type!,
      });
    }
  } else if (s.on_word_pct >= 0.5) {
    bits.push('SFX land on spoken-word onsets');
    rules.push({
      trigger: 'on emphasized words',
      sfx_type: s.body_dominant_type ?? s.hook_dominant_type ?? 'impulse_tonal',
    });
  }
  if (s.hook_escalation >= 0.3 || s.hook_density_per_s > s.body_density_per_s * 1.4) {
    bits.push('SFX concentrate in / escalate through the hook');
    if (s.hook_dominant_type) {
      rules.push({ trigger: 'building through the hook', sfx_type: s.hook_dominant_type });
    }
  }
  if (bits.length === 0) {
    bits.push(
      `sparse SFX (~${s.sfx_per_word.toFixed(2)}/word)` +
        (s.body_dominant_type ? `, mostly ${s.body_dominant_type}` : ''),
    );
  }
  return { summary: bits.join('; ') + '.', rules };
}

let clientPromise: Promise<OpenAI | null> | null = null;
function getClient(): Promise<OpenAI | null> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error('[sfx-context] OPENAI_API_KEY not set; templated summary');
        return null;
      }
      return new OpenAI({ apiKey });
    })();
  }
  return clientPromise;
}

const SYSTEM_PROMPT =
  'You analyze how a short-form video uses SOUND EFFECTS relative to the ' +
  'spoken words. You are given numeric signals and an SFX-annotated ' +
  'transcript where ⟨type⟩ markers show where each sound effect lands ' +
  '(impulse_tonal=ding/bell, impulse_noisy=clap/impact, sweep=whoosh, ' +
  'vocal=spoken stinger like "wow", sustained=drone). Describe the SFX ' +
  'USAGE PATTERN so an editor can replicate it on a new script: the cadence ' +
  '(per word? on emphasis?), how it changes through the hook, and which ' +
  'kinds of MOMENTS get a hit (reveals, punchlines, important claims, ' +
  'numbers). Respond as JSON: {"pattern_summary": "<1-2 sentences>", ' +
  '"rules": [{"trigger": "<content moment>", "sfx_type": "<one of ' +
  'impulse_tonal|impulse_noisy|sweep|vocal|sustained>", "example": ' +
  '"<short quote from transcript or empty>"}]}. Keep rules to the 1-4 that ' +
  'actually fire. Ground every claim in the markers; do not invent SFX.';

const VALID_TYPES: SfxType[] = [
  'impulse_tonal',
  'impulse_noisy',
  'sweep',
  'vocal',
  'sustained',
  'other',
];

function coerceRules(raw: unknown): SfxContextRule[] {
  if (!Array.isArray(raw)) return [];
  const out: SfxContextRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const trigger = typeof o.trigger === 'string' ? o.trigger.trim() : '';
    const t = typeof o.sfx_type === 'string' ? (o.sfx_type as SfxType) : 'other';
    if (!trigger) continue;
    out.push({
      trigger,
      sfx_type: VALID_TYPES.includes(t) ? t : 'other',
      example:
        typeof o.example === 'string' && o.example.trim()
          ? o.example.trim()
          : undefined,
    });
  }
  return out.slice(0, 4);
}

/** Full SFX-context analysis for one reel. Deterministic signals always;
 *  LLM summary+rules when a key + onsets + words are available, else a
 *  templated summary. Never throws — degrades to the template. */
export async function analyzeSfxContext(
  events: TypedSfxEvent[],
  words: TranscriptWord[],
  shots: Shot[],
  hookMs: number,
  reelMs: number,
): Promise<SfxContext> {
  const signals = computeSfxSignals(events, words, hookMs, reelMs);
  const fallback = templateSummary(signals);

  if (events.length === 0 || words.length === 0) {
    return { signals, pattern_summary: fallback.summary, rules: fallback.rules, llm: false };
  }

  const client = await getClient();
  if (!client) {
    return { signals, pattern_summary: fallback.summary, rules: fallback.rules, llm: false };
  }

  const annotated = buildAnnotatedTranscript(events, words);
  const stats =
    `sfx_per_word=${signals.sfx_per_word.toFixed(2)} ` +
    `on_word=${Math.round(signals.on_word_pct * 100)}% ` +
    `hook_density/s=${signals.hook_density_per_s.toFixed(2)} ` +
    `body_density/s=${signals.body_density_per_s.toFixed(2)} ` +
    `hook_escalation=${signals.hook_escalation.toFixed(2)} ` +
    `hook_type=${signals.hook_dominant_type ?? 'none'} ` +
    `body_type=${signals.body_dominant_type ?? 'none'}`;

  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 500,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `SIGNALS\n${stats}\n\nSFX-ANNOTATED TRANSCRIPT\n${annotated}\n\nDescribe the SFX usage pattern as JSON.`,
        },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const summary =
      typeof parsed.pattern_summary === 'string' && parsed.pattern_summary.trim()
        ? parsed.pattern_summary.trim()
        : fallback.summary;
    const rules = coerceRules(parsed.rules);
    return {
      signals,
      pattern_summary: summary,
      rules: rules.length > 0 ? rules : fallback.rules,
      llm: true,
    };
  } catch (err) {
    console.error(
      '[sfx-context] LLM characterization failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { signals, pattern_summary: fallback.summary, rules: fallback.rules, llm: false };
  }
}
