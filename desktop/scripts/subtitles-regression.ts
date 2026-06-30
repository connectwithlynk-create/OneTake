import assert from 'node:assert/strict';
import { planShotTimeline, type PacingTemplate } from '../src/main/analyze/synthesize';
import {
  estimatePlanSpokenWords,
  hydratePlanSpokenWords,
  transcriptTextScore,
} from '../src/main/analyze/subtitle-backfill';
import {
  alignShotEndsToTranscript,
  snapBoundaryToTranscript,
  splitAdjacentShotsAtTranscriptBoundary,
} from '../src/renderer/src/shot-timing';
import { subtitleTextForShot } from '../src/renderer/src/subtitles';
import type { ShotPlan, SubtitleSpec, TranscriptWord } from '../src/renderer/src/global';

const transcript: TranscriptWord[] = [
  { text: 'alpha', start_ms: 0, end_ms: 200 },
  { text: 'beta', start_ms: 1000, end_ms: 1200 },
  { text: 'gamma', start_ms: 2000, end_ms: 2200 },
];

const template: PacingTemplate = {
  source_url: 'test',
  source_duration_ms: 3000,
  shot_durations_ms: [3000],
};

const [shot] = planShotTimeline(3000, template, transcript);
assert.equal(shot.spoken_during, 'alpha beta gamma');
assert.deepEqual(shot.spoken_words, transcript);

const spec: SubtitleSpec = {
  enabled: true,
  preset_id: '',
  preset_label: '',
  position: 'bottom',
  chunking: 'word_by_word',
  words_per_chunk: 1,
  font_size: 'medium',
  emphasis: 'none',
  casing: 'sentence_case',
  animation: 'static',
  font_family: '',
  font_family_name: '',
  text_color: '#ffffff',
  text_treatment: 'clear',
  treatment_color: null,
  highlight_color: null,
  has_emoji: false,
  low_confidence: false,
  font_scale: 1,
  border_width: 2,
};

const timedShot = shot as ShotPlan;
assert.equal(subtitleTextForShot(timedShot.spoken_during, spec, timedShot, 500), 'alpha');
assert.equal(subtitleTextForShot(timedShot.spoken_during, spec, timedShot, 1000), 'beta');
assert.equal(subtitleTextForShot(timedShot.spoken_during, spec, timedShot, 2000), 'gamma');

const staleShot: ShotPlan = {
  ...timedShot,
  spoken_during: 'edited words',
};
assert.equal(
  subtitleTextForShot(staleShot.spoken_during, spec, staleShot, 1000),
  'words',
);

const legacyPlan = {
  total_duration_ms: 3000,
  shots: [
    { ...timedShot, spoken_words: undefined },
    {
      ...timedShot,
      shot_idx: 1,
      start_ms: 1000,
      end_ms: 2200,
      duration_ms: 1200,
      spoken_during: 'beta gamma',
      spoken_words: undefined,
    },
  ],
  structure_sections: [],
  structure_confidence: 'high',
  structure_rationale: '',
  structure_alternatives: null,
  content_source_patterns: [],
  style_summary: '',
  content_sources: [],
  target_metrics: null,
  subtitle_spec: null,
} as unknown as import('../src/main/analyze/synthesize').SuggestedEdit;

const backfilled = hydratePlanSpokenWords(legacyPlan, transcript);
assert.equal(backfilled.changed, true);
assert.deepEqual(backfilled.plan.shots[0].spoken_words, transcript);
assert.deepEqual(backfilled.plan.shots[1].spoken_words, transcript.slice(1));
assert.ok(transcriptTextScore(legacyPlan, transcript) >= 0.6);

const estimated = estimatePlanSpokenWords(legacyPlan);
const estimatedHydrated = hydratePlanSpokenWords(legacyPlan, estimated);
assert.equal(estimatedHydrated.plan.shots[1].spoken_words?.[0]?.text, 'beta');
assert.equal(estimatedHydrated.plan.shots[1].spoken_words?.[0]?.start_ms, 1000);

const boundaryLeft = {
  ...timedShot,
  end_ms: 950,
  duration_ms: 950,
  spoken_during: 'alpha beta',
  spoken_words: transcript.slice(0, 2),
};
const boundaryRight = {
  ...timedShot,
  shot_idx: 1,
  start_ms: 950,
  end_ms: 3000,
  duration_ms: 2050,
  spoken_during: 'gamma',
  spoken_words: transcript.slice(2),
};
const alignedBoundary = alignShotEndsToTranscript([boundaryLeft, boundaryRight]);
assert.equal(alignedBoundary.changed, true);
assert.equal(alignedBoundary.shots[0].end_ms, 1200);
assert.equal(alignedBoundary.shots[1].start_ms, 1200);

const snapped = snapBoundaryToTranscript(boundaryLeft, boundaryRight, 1050);
assert.equal(snapped, 1200);
const splitBoundary = splitAdjacentShotsAtTranscriptBoundary(
  boundaryLeft,
  boundaryRight,
  snapped,
);
assert.equal(splitBoundary.left.spoken_during, 'alpha beta');
assert.equal(splitBoundary.right.spoken_during, 'gamma');

console.log('subtitles regression passed');
