// End-to-end test of continueShot. Runs a small fresh research pass,
// then calls continueShot with a tweak. Prints both results so we can
// see if continueShot is the bug or something upstream.
import './_env';
import { continueShot, researchShot } from '../src/main/curator';
import type { ShotPlan, SuggestedEdit } from '../src/main/curator/agent';

const SHOT: ShotPlan = {
  shot_idx: 0,
  start_ms: 0,
  end_ms: 3000,
  duration_ms: 3000,
  spoken_during: 'Vori raised 22 million in funding to build the grocery POS of the future.',
  structure_role: 'body',
  options: [],
  broll_description:
    "Screen recording of a press article about Vori's $22 million Series funding round",
  asset: {
    method: 'web_capture',
    web_capture: { url: 'https://www.vori.com/', focus: 'homepage hero + logo' },
    library_search: null,
    stock_search: null,
    generate_image: null,
    manual: null,
    camera_move: null,
  },
  placement: { aspect: '9:16', fit: 'fill', position: 'middle_center', scale: 1.0 },
  additional_elements: [],
  source_type: 'press article about the subject',
  inspired_by: null,
  text_overlay: '',
  text_position: 'middle_center',
  animation_cue: null,
  sfx_cue: null,
  clip_type: 'broll_visual',
  rationale: 'Reinforces the funding line with an authoritative article.',
};

const PLAN: SuggestedEdit = {
  total_duration_ms: 3000,
  shots: [SHOT],
  structure_sections: [],
  structure_confidence: 'low',
  structure_rationale: '',
  structure_alternatives: null,
  content_source_patterns: ['press article about the subject'],
  style_summary: 'test',
  content_sources: ['press article'],
  target_metrics: null,
};

async function main(): Promise<void> {
  console.log('[continue-test] running initial researchShot…');
  const initial = await researchShot(SHOT, PLAN, {});
  console.log(`[continue-test] initial: ${initial.curation.candidates.length} candidates`);
  console.log(`[continue-test] initial notes: ${initial.curation.research_notes.slice(0, 200)}`);
  console.log(`[continue-test] final_input length: ${initial.final_input.length} items`);
  if (initial.curation.failure_reason) {
    console.log(`[continue-test] initial failure_reason: ${initial.curation.failure_reason}`);
  }
  for (const c of initial.curation.candidates.slice(0, 3)) {
    console.log(`  - ${c.title?.slice(0, 60) ?? c.url.slice(0, 60)}`);
  }
  if (initial.final_input.length === 0) {
    console.error('[continue-test] no final_input — continueShot can not proceed');
    process.exit(1);
  }

  console.log('\n[continue-test] running continueShot with tweak prompt…');
  const tweaked = await continueShot(
    SHOT,
    initial.final_input,
    'Drop any press release sources and prefer Fortune or TechCrunch articles instead. Rank Fortune first.',
    {},
  );
  console.log(`[continue-test] tweaked: ${tweaked.curation.candidates.length} candidates`);
  console.log(`[continue-test] tweaked notes: ${tweaked.curation.research_notes.slice(0, 300)}`);
  if (tweaked.curation.failure_reason) {
    console.log(`[continue-test] tweaked failure_reason: ${tweaked.curation.failure_reason}`);
  }
  for (const c of tweaked.curation.candidates.slice(0, 3)) {
    console.log(`  - ${c.title?.slice(0, 60) ?? c.url.slice(0, 60)}`);
    console.log(`    url: ${c.url}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[continue-test] failed:', err);
  process.exit(2);
});
