// Post-synthesis verification: replace null `likelihood` values on
// searchable-method options with real numbers derived from a quick
// web search per option.
//
// Why this is a separate pass and not inline in synthesize(): the
// synthesizer's job is creative (pick what fits the slot). Estimating
// acquirability from prompt heuristics alone is unreliable — actual
// search results are the ground truth. One Responses API call with the
// web_search tool covers every searchable option in the plan; non-
// searchable options (library_search / manual) stay null because they
// depend on the user's footage, not on the open web.
import OpenAI from 'openai';
import type { Response, Tool } from 'openai/resources/responses/responses';
import type { ShotOption, SuggestedEdit } from './synthesize';

const MODEL = process.env.ONETAKE_ANALYZE_MODEL?.trim() || 'gpt-4o';
const MAX_TOKENS = 4096;

const SEARCHABLE_METHODS = new Set([
  'web_capture',
  'stock_search',
  'generate_image',
]);

interface VerifyJob {
  shot_idx: number;
  opt_idx: number;
  method: string;
  query: string;
  description: string;
}

function describeOption(opt: ShotOption): string {
  if (opt.asset.method === 'web_capture' && opt.asset.web_capture) {
    return `URL: ${opt.asset.web_capture.url} (focus: ${opt.asset.web_capture.focus}) — ${opt.broll_description}`;
  }
  if (opt.asset.method === 'stock_search' && opt.asset.stock_search) {
    return `Stock search: "${opt.asset.stock_search.query}" — ${opt.broll_description}`;
  }
  if (opt.asset.method === 'generate_image' && opt.asset.generate_image) {
    return `Image-gen prompt: "${opt.asset.generate_image.prompt}" — ${opt.broll_description}`;
  }
  return opt.broll_description;
}

function buildJobs(plan: SuggestedEdit): VerifyJob[] {
  const jobs: VerifyJob[] = [];
  for (const shot of plan.shots) {
    for (let i = 0; i < shot.options.length; i++) {
      const opt = shot.options[i];
      if (!SEARCHABLE_METHODS.has(opt.asset.method)) continue;
      jobs.push({
        shot_idx: shot.shot_idx,
        opt_idx: i,
        method: opt.asset.method,
        query: opt.asset.stock_search?.query ?? opt.asset.web_capture?.url ?? opt.broll_description,
        description: describeOption(opt),
      });
    }
  }
  return jobs;
}

const TOOLS: Tool[] = [{ type: 'web_search_preview' }];

const SYSTEM_PROMPT = `You are an asset-acquirability verifier for a short-form video editor. Given a list of media descriptions the editor wants to find, you run quick web searches and estimate, for each one, the probability (0-1) that the editor can actually find usable matching media via the open web.

Heuristics:
- generate_image always returns ~0.95 — image generation virtually always works.
- web_capture with a specific URL: ~0.95 if the URL clearly exists / loads (try the search for its title or domain); ~0.4 if it's speculative.
- stock_search: search the query and estimate based on what comes back. Lots of relevant stock results → 0.85-0.95. Niche / specific subject that stock won't have → 0.2-0.4.
- For subject-specific searches (named person / company / event): search the subject's name and see what's available. Public-facing subjects with press coverage → 0.6-0.8. Obscure / private subjects → 0.1-0.3.

Run at most ONE web_search per item. Don't dig deep — surface-level research only. Estimate quickly.

Output ONE JSON object (no markdown, no preamble):
{
  "scores": [
    { "job_idx": <int>, "likelihood": <0-1>, "note": "<one phrase: what you found>" }
  ]
}

The scores array must have one entry per input job. Use the job_idx from the input.`;

function buildUserMessage(jobs: VerifyJob[]): string {
  const lines: string[] = [];
  lines.push(`Verify ${jobs.length} media-acquisition jobs. For each, run at most one web search and return a likelihood score (0-1):`);
  lines.push('');
  jobs.forEach((j, i) => {
    lines.push(`[${i}] method=${j.method}`);
    lines.push(`    ${j.description}`);
  });
  lines.push('');
  lines.push('Output JSON now.');
  return lines.join('\n');
}

interface RawScores {
  scores?: Array<{ job_idx?: number; likelihood?: number; note?: string }>;
}

/** Run the verification pass. Mutates plan in place — every searchable
 *  option gets a numeric likelihood; non-searchable options stay null. */
export async function verifyOptionLikelihoods(
  plan: SuggestedEdit,
  onProgress?: (msg: string) => void,
): Promise<SuggestedEdit> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    onProgress?.('Skipping likelihood verification (no OPENAI_API_KEY)');
    return plan;
  }

  const jobs = buildJobs(plan);
  if (jobs.length === 0) {
    onProgress?.('No searchable options to verify');
    return plan;
  }

  onProgress?.(`Verifying acquirability of ${jobs.length} option(s) via web_search…`);

  const client = new OpenAI({ apiKey });
  let resp: Response;
  try {
    resp = await client.responses.create({
      model: MODEL,
      input: [
        { type: 'message', role: 'system', content: SYSTEM_PROMPT },
        { type: 'message', role: 'user', content: buildUserMessage(jobs) },
      ],
      tools: TOOLS,
      max_output_tokens: MAX_TOKENS,
    });
  } catch (err) {
    console.error(
      '[verify-options] API call failed:',
      err instanceof Error ? err.message : String(err),
    );
    return plan;
  }

  // Extract text from message items in the response.
  let text = '';
  for (const item of resp.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'output_text') text += part.text;
    }
  }
  if (!text.trim()) {
    console.error('[verify-options] empty response');
    return plan;
  }

  let parsed: RawScores;
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned) as RawScores;
  } catch (err) {
    console.error(
      '[verify-options] JSON parse failed:',
      err instanceof Error ? err.message : String(err),
    );
    return plan;
  }

  if (!Array.isArray(parsed.scores)) return plan;

  let updated = 0;
  for (const s of parsed.scores) {
    if (typeof s.job_idx !== 'number') continue;
    const job = jobs[s.job_idx];
    if (!job) continue;
    const shot = plan.shots.find((sh) => sh.shot_idx === job.shot_idx);
    if (!shot) continue;
    const opt = shot.options[job.opt_idx];
    if (!opt) continue;
    if (typeof s.likelihood === 'number') {
      opt.likelihood = Math.max(0, Math.min(1, s.likelihood));
      updated++;
    }
  }
  onProgress?.(`Verified ${updated}/${jobs.length} option likelihood(s).`);
  return plan;
}
