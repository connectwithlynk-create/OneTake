// Motion-aware per-shot captioning via OpenAI vision (gpt-4o-mini).
//
// For each shot we send the FIRST and LAST sample frames to the
// vision LLM with a comparison prompt. The model describes what's
// shown and — critically — any motion that happens within the shot
// (zoom, pan, scroll, scale, content swap). A single-frame caption
// would treat a "screen recording zooming into the YC button" as a
// static screenshot of a button; the paired-frame approach catches
// the trajectory the editor actually composed.
//
// Single-image fallback when only one usable frame is available.
//
// Best-effort: returns null on missing OPENAI_API_KEY, missing
// frames, or API failure. The rest of the pipeline runs without
// the caption.
import OpenAI from 'openai';

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 160;

/** Pool size for concurrent captioning calls. Rate-limit bound. */
const CONCURRENCY = 6;

const SYSTEM_PROMPT_PAIR = `You are looking at the FIRST and LAST frames of a single video shot from a short-form vertical reel (TikTok / Instagram). Your caption feeds an editing assistant that needs to know what each shot really is — including any motion the editor applied.

Describe the shot in ONE concrete sentence. Critical:
- If the two frames are essentially identical → describe the static content.
- If the content changes between frames → describe what changes (zoom in/out, pan, scroll, content swap, scale, rotate). Make clear it is an active shot, not static.

Be specific about: subjects, framing (close-up / wide / POV / screen recording / logo card), and any visible brand iconography by name when recognizable.

Ignore any burned-in text caption overlays — those are captured separately.

Rules:
- One sentence, under 30 words.
- No preamble, no "this is", no markdown.
- Do not start with "A" or "An" — start with the subject or the framing word.

Examples of good captions:
- "Static close-up of a young man speaking on a TEDx-style stage, no motion."
- "Screen recording of a Y Combinator company directory zooming into the 'Ornadyne' card."
- "Pan from left to right across a cluttered desk with circuit boards and electronics."
- "Logo card with the orange Y Combinator wordmark centered on white, static."
- "Fast scroll down a LinkedIn profile, stopping on the founder's headline."
- "Close-up of a robotic pigeon prop being lifted toward camera, slight tilt."
- "POV phone screen swiping through an Instagram feed, no zoom."`;

const SYSTEM_PROMPT_SINGLE = `You are captioning a single video frame for an editing assistant. Return ONE short, concrete sentence covering subject, framing, and any visible brand iconography.

Rules:
- Ignore any burned-in text caption overlays.
- No preamble, no "this is", no markdown.
- Do not start with "A" or "An".
- One sentence, under 25 words.`;

let clientPromise: Promise<OpenAI | null> | null = null;

function getClient(): Promise<OpenAI | null> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error('[shot-caption] OPENAI_API_KEY not set; skipping');
        return null;
      }
      return new OpenAI({ apiKey });
    })();
  }
  return clientPromise;
}

export interface ShotFramesForCaption {
  /** First sample frame in the shot, base64 JPEG. */
  start: string;
  /** Last sample frame in the shot, base64 JPEG. Same as start when
   *  only one frame is available (treated as static). */
  end: string;
}

function imagePart(jpegBase64: string): {
  type: 'image_url';
  image_url: { url: string; detail: 'low' };
} {
  return {
    type: 'image_url',
    image_url: {
      url: `data:image/jpeg;base64,${jpegBase64}`,
      // 'low' detail = single 512px tile; cheap and plenty for
      // short-form reel caption granularity.
      detail: 'low',
    },
  };
}

/** Caption one shot using start + end frames. Returns null on any
 *  error so a single bad shot never aborts the pipeline. */
export async function captionShot(
  frames: ShotFramesForCaption,
): Promise<string | null> {
  const client = await getClient();
  if (!client) return null;
  if (!frames.start) return null;

  const isPair = frames.start !== frames.end && !!frames.end;
  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'system',
          content: isPair ? SYSTEM_PROMPT_PAIR : SYSTEM_PROMPT_SINGLE,
        },
        {
          role: 'user',
          content: isPair
            ? [
                { type: 'text', text: 'First frame:' },
                imagePart(frames.start),
                { type: 'text', text: 'Last frame:' },
                imagePart(frames.end),
                {
                  type: 'text',
                  text: 'Caption this shot. Describe motion if frames differ; describe static content if they look the same.',
                },
              ]
            : [
                { type: 'text', text: 'Caption this frame.' },
                imagePart(frames.start),
              ],
        },
      ],
    });
    const text = resp.choices[0]?.message?.content?.trim().replace(/\s+/g, ' ');
    return text && text.length > 0 ? text : null;
  } catch (err) {
    console.error(
      '[shot-caption] caption failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Caption a list of shots in parallel. Result is 1:1 with the input.
 *  Null entries pass through as null. */
export async function captionShots(
  shots: (ShotFramesForCaption | null)[],
): Promise<(string | null)[]> {
  const client = await getClient();
  if (!client) return shots.map(() => null);
  const results: (string | null)[] = new Array(shots.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < shots.length) {
      const idx = next++;
      const s = shots[idx];
      if (!s) {
        results[idx] = null;
        continue;
      }
      results[idx] = await captionShot(s);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, shots.length) }, worker),
  );
  return results;
}
