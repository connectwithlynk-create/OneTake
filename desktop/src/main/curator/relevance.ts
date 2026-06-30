// Post-research relevance gate.
//
// The research agents verify subject identity while browsing
// (fetch_page expected_content), but committed candidates can still
// drift off-topic — a page about a similarly-named company, a press
// hit about a different announcement, a generic article that has
// nothing to do with the beat it was assigned to. This pass judges
// every candidate against the beat it must visually support and DROPS
// clear mismatches before any capture money is spent on them.
//
// Deliberately conservative: agents improvise down a tier ladder on
// purpose (founder profile instead of an interview, brand assets
// instead of event footage), so same-subject-but-indirect candidates
// are KEPT. Only wrong-subject / wholly-unrelated candidates drop.
// Best-effort throughout: judge failures keep the input unchanged.
import OpenAI from 'openai';
import type { ShotPlan, SuggestedEdit } from '../analyze/synthesize';
import type { CurationResult, MediaCandidate, ShotCuration } from './types';

const JUDGE_MODEL =
  process.env.ONETAKE_RELEVANCE_MODEL?.trim() || 'gpt-4o-mini';

function openai(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  return key ? new OpenAI({ apiKey: key }) : null;
}

interface JudgeItem {
  id: number;
  shot_idx: number;
  spoken: string;
  candidate: MediaCandidate;
}

const JUDGE_SYSTEM = [
  'You are a relevance gate for b-roll candidates in a short vertical video.',
  'Each numbered candidate is meant to VISUALLY SUPPORT what is being said during its beat of the voiceover.',
  'DROP a candidate ONLY when it is clearly about a DIFFERENT subject (wrong company / person / product with a similar name) or wholly unrelated to both its beat and the video\'s overall subject.',
  'KEEP candidates that are same-subject but indirect — founder profiles, brand assets, directory pages, adjacent press — the agent improvises those on purpose (notes often flag the tier).',
  'When in doubt, KEEP.',
  'Output strict JSON only: { "drop": [ { "id": <int>, "reason": "<one short sentence>" } ] }. An empty drop list is valid.',
].join('\n');

/** Judge a batch of (beat, candidate) pairs in one model call. Returns
 *  the set of item ids to drop. Empty set on any failure. */
async function judgeItems(
  fullTranscript: string,
  items: JudgeItem[],
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const drops = new Map<number, string>();
  if (items.length === 0) return drops;
  const client = openai();
  if (!client) return drops;

  const lines = items.map(
    (it) =>
      `${it.id}. [beat ${it.shot_idx}] spoken: "${it.spoken || '(silence)'}"\n` +
      `   candidate: title="${it.candidate.title ?? '(none)'}" url=${it.candidate.url}` +
      (it.candidate.source_page && it.candidate.source_page !== it.candidate.url
        ? ` source_page=${it.candidate.source_page}`
        : '') +
      `\n   agent notes: "${(it.candidate.notes ?? '').slice(0, 240)}"`,
  );
  const user = [
    `Full video voiceover transcript: "${fullTranscript}"`,
    '',
    'Candidates:',
    ...lines,
  ].join('\n');

  try {
    const resp = await client.chat.completions.create(
      {
        model: JUDGE_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: user },
        ],
      },
      signal ? { signal } : undefined,
    );
    const parsed = JSON.parse(
      resp.choices[0]?.message?.content ?? '{}',
    ) as { drop?: { id?: unknown; reason?: unknown }[] };
    const validIds = new Set(items.map((it) => it.id));
    for (const d of Array.isArray(parsed.drop) ? parsed.drop : []) {
      if (typeof d.id === 'number' && validIds.has(d.id)) {
        drops.set(d.id, typeof d.reason === 'string' ? d.reason : '');
      }
    }
  } catch (err) {
    console.error(
      '[relevance] judge call failed (keeping all candidates):',
      err instanceof Error ? err.message : String(err),
    );
  }
  return drops;
}

function fullTranscriptOf(plan: SuggestedEdit): string {
  return plan.shots
    .map((s) => s.spoken_during)
    .filter(Boolean)
    .join(' ');
}

/** Gate the reel-level library assignments in ONE judge call. Shots
 *  whose candidates all drop simply end up absent — the per-shot
 *  gap-fill research rescues them downstream. */
export async function filterLibraryRelevance(
  plan: SuggestedEdit,
  assignments: Map<number, MediaCandidate[]>,
  signal?: AbortSignal,
): Promise<Map<number, MediaCandidate[]>> {
  const spokenByIdx = new Map(
    plan.shots.map((s) => [s.shot_idx, s.spoken_during || '']),
  );
  const items: JudgeItem[] = [];
  let id = 0;
  for (const [shotIdx, candidates] of assignments) {
    for (const candidate of candidates) {
      items.push({
        id: id++,
        shot_idx: shotIdx,
        spoken: spokenByIdx.get(shotIdx) ?? '',
        candidate,
      });
    }
  }
  const drops = await judgeItems(fullTranscriptOf(plan), items, signal);
  if (drops.size === 0) return assignments;

  const filtered = new Map<number, MediaCandidate[]>();
  for (const [shotIdx, candidates] of assignments) {
    const kept: MediaCandidate[] = [];
    for (const candidate of candidates) {
      const item = items.find(
        (it) => it.shot_idx === shotIdx && it.candidate === candidate,
      );
      const reason = item ? drops.get(item.id) : undefined;
      if (reason !== undefined) {
        console.error(
          `[relevance] dropped off-topic candidate for shot ${shotIdx}: ${candidate.url}${reason ? ` (${reason})` : ''}`,
        );
        continue;
      }
      kept.push(candidate);
    }
    if (kept.length > 0) filtered.set(shotIdx, kept);
  }
  return filtered;
}

/** Gate an EXISTING CurationResult (the "Filter screenshots" flow):
 *  one batched judge call across every shot's candidates, dropping
 *  clips that are off-topic for the beat they're assigned to. Shots
 *  left with zero candidates keep an explanatory research note; the
 *  user re-curates them individually. */
export async function filterCurationRelevance(
  plan: SuggestedEdit,
  curation: CurationResult,
  signal?: AbortSignal,
): Promise<CurationResult> {
  const spokenByIdx = new Map(
    plan.shots.map((s) => [s.shot_idx, s.spoken_during || '']),
  );
  const items: JudgeItem[] = [];
  const refs = new Map<number, { shotPos: number; candIdx: number }>();
  let id = 0;
  curation.shots.forEach((sc, shotPos) => {
    sc?.candidates.forEach((candidate, candIdx) => {
      items.push({
        id,
        shot_idx: sc.shot_idx,
        spoken: spokenByIdx.get(sc.shot_idx) ?? '',
        candidate,
      });
      refs.set(id, { shotPos, candIdx });
      id++;
    });
  });
  const drops = await judgeItems(fullTranscriptOf(plan), items, signal);
  if (drops.size === 0) return curation;

  const dropByShotPos = new Map<number, Set<number>>();
  for (const [dropId, reason] of drops) {
    const ref = refs.get(dropId);
    if (!ref) continue;
    const set = dropByShotPos.get(ref.shotPos) ?? new Set<number>();
    set.add(ref.candIdx);
    dropByShotPos.set(ref.shotPos, set);
    const item = items[dropId];
    console.error(
      `[relevance] dropped off-topic candidate for shot ${item.shot_idx}: ${item.candidate.url}${reason ? ` (${reason})` : ''}`,
    );
  }

  const shots = curation.shots.map((sc, shotPos) => {
    if (!sc) return sc;
    const dropIdxs = dropByShotPos.get(shotPos);
    if (!dropIdxs || dropIdxs.size === 0) return sc;
    const kept = sc.candidates.filter((_, i) => !dropIdxs.has(i));
    return {
      ...sc,
      candidates: kept,
      research_notes:
        `${sc.research_notes} Dropped ${dropIdxs.size} off-topic candidate(s) at the relevance gate.`.trim(),
    };
  });
  return { ...curation, shots };
}

/** Gate one shot's freshly-researched curation. All-dropped leaves the
 *  curation empty, which the caller's rewrite machinery treats as a
 *  failed shot and rescues with a new idea. */
export async function filterShotRelevance(
  plan: SuggestedEdit,
  shot: ShotPlan,
  curation: ShotCuration,
  signal?: AbortSignal,
): Promise<ShotCuration> {
  if (curation.candidates.length === 0) return curation;
  const items: JudgeItem[] = curation.candidates.map((candidate, i) => ({
    id: i,
    shot_idx: shot.shot_idx,
    spoken: shot.spoken_during || '',
    candidate,
  }));
  const drops = await judgeItems(fullTranscriptOf(plan), items, signal);
  if (drops.size === 0) return curation;

  const kept = curation.candidates.filter((_, i) => !drops.has(i));
  for (const [id, reason] of drops) {
    console.error(
      `[relevance] dropped off-topic candidate for shot ${shot.shot_idx}: ${curation.candidates[id]?.url}${reason ? ` (${reason})` : ''}`,
    );
  }
  return {
    ...curation,
    candidates: kept,
    research_notes:
      kept.length < curation.candidates.length
        ? `${curation.research_notes} Dropped ${curation.candidates.length - kept.length} off-topic candidate(s) at the relevance gate.`.trim()
        : curation.research_notes,
  };
}
