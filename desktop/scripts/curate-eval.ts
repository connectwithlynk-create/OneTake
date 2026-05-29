// End-to-end eval for the media curator:
//   1. Hydrate library (cached) + transcribe target → SuggestedEdit
//      (same as synthesize-eval).
//   2. For each shot, run the research agent to find 2-5 media
//      candidates.
//   3. Print per-shot candidates with provenance.
//
// Run from desktop/:
//   npx tsx scripts/curate-eval.ts \
//     --content URL [--content URL ...] \
//     --style URL [--style URL ...] \
//     --target URL [--concurrency N]
//
// Needs OPENAI_API_KEY. Uses OpenAI Responses API with the built-in
// web_search_preview tool + our custom fetch_page + generate_image
// function tools.
import './_env';
import { createInterface } from 'readline';
import { extractReelAudio } from '../src/main/analyze/audio';
import { buildContentVocabulary } from '../src/main/analyze/content-vocab';
import { assembleFingerprint } from '../src/main/analyze/fingerprint';
import {
  contentReels,
  hydrateLibrary,
  saveLibrary,
  structureReels,
  styleReels,
  type LibraryReel,
  type ReelTag,
} from '../src/main/analyze/library';
import { synthesize } from '../src/main/analyze/synthesize';
import { transcribeReel } from '../src/main/analyze/transcribe';
import { curate } from '../src/main/curator';
import type { ShotCuration } from '../src/main/curator';
import { resolveReel } from '../src/main/resolver';

interface Args {
  content: string[];
  style: string[];
  structure: string[];
  target: string;
  concurrency: number;
  noConfirm: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const content: string[] = [];
  const style: string[] = [];
  const structure: string[] = [];
  let target = '';
  let concurrency = 4;
  let noConfirm = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--content') content.push(argv[++i]);
    else if (a === '--style') style.push(argv[++i]);
    else if (a === '--structure') structure.push(argv[++i]);
    else if (a === '--target') target = argv[++i];
    else if (a === '--concurrency') concurrency = parseInt(argv[++i], 10);
    else if (a === '--no-confirm') noConfirm = true;
  }
  if (
    !target ||
    (content.length === 0 && style.length === 0 && structure.length === 0)
  ) {
    console.error(
      'usage: curate-eval [--content URL ...] [--style URL ...] [--structure URL ...] --target URL [--concurrency N] [--no-confirm]\n\n' +
        'Tags (any combination, a reel can repeat across flags):\n' +
        '  --content    use this reel\'s b-roll types\n' +
        '  --style      use this reel\'s editing pacing / SFX / text overlays\n' +
        '  --structure  use this reel\'s narrative script template\n\n' +
        'Needs OPENAI_API_KEY (synthesis + agent loop + image gen + Whisper).',
    );
    process.exit(1);
  }
  return { content, style, structure, target, concurrency, noConfirm };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(question, resolve),
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printCuration(curation: ShotCuration, completed: number, total: number): void {
  console.log(
    `\n[${completed}/${total}] shot ${String(curation.shot_idx).padStart(2, '0')}  (${curation.candidates.length} candidate(s))`,
  );
  if (curation.research_notes) {
    console.log(`  notes:    ${curation.research_notes}`);
  }
  if (curation.failure_reason) {
    console.log(`  ⚠ failed: ${curation.failure_reason}`);
  }
  for (const c of curation.candidates) {
    console.log(`  • [${c.source}] ${c.url}`);
    if (c.source_page) console.log(`      via:    ${c.source_page}`);
    if (c.title) console.log(`      title:  ${c.title}`);
    if (c.width && c.height) {
      console.log(`      dims:   ${c.width}x${c.height}`);
    }
    if (c.duration_ms) {
      console.log(`      length: ${(c.duration_ms / 1000).toFixed(1)}s`);
    }
    if (c.recommended_segment_ms) {
      const s = c.recommended_segment_ms;
      console.log(
        `      clip:   ${(s.start_ms / 1000).toFixed(1)}s - ${(s.end_ms / 1000).toFixed(1)}s`,
      );
    }
    if (c.notes) console.log(`      why:    ${c.notes}`);
  }
}

async function main(): Promise<void> {
  const { content, style, structure, target, concurrency, noConfirm } = parseArgs();

  const urls = new Map<string, ReelTag[]>();
  for (const u of content) {
    const tags = urls.get(u) ?? [];
    if (!tags.includes('content_reference')) tags.push('content_reference');
    urls.set(u, tags);
  }
  for (const u of style) {
    const tags = urls.get(u) ?? [];
    if (!tags.includes('style_reference')) tags.push('style_reference');
    urls.set(u, tags);
  }
  for (const u of structure) {
    const tags = urls.get(u) ?? [];
    if (!tags.includes('structure_reference')) tags.push('structure_reference');
    urls.set(u, tags);
  }
  const library: LibraryReel[] = Array.from(urls.entries()).map(
    ([url, tags]) => ({ url, tags }),
  );

  console.log(`\n=== LIBRARY ===`);
  for (const r of library) {
    console.log(`  ${r.tags.join(',').padEnd(40)}  ${r.url}`);
  }
  console.log(`  target: ${target}\n`);

  saveLibrary(library);

  console.log(`hydrating ${library.length} library reel(s)...`);
  const hydrated = await hydrateLibrary(library);
  const ok = hydrated.filter((r) => r.analysis);
  console.log(`  ${ok.length}/${hydrated.length} analyzed successfully\n`);
  if (ok.length === 0) {
    console.error('no library reels analyzed; aborting.');
    process.exit(2);
  }

  const styleSet = new Set(styleReels(hydrated).map((r) => r.url));
  const contentSet = new Set(contentReels(hydrated).map((r) => r.url));
  const structureSet = new Set(structureReels(hydrated).map((r) => r.url));
  const inspiration = ok.map((r) => {
    const tags: string[] = [];
    if (styleSet.has(r.url)) tags.push('STYLE');
    if (contentSet.has(r.url)) tags.push('CONTENT');
    if (structureSet.has(r.url)) tags.push('STRUCTURE');
    return { url: r.url, analysis: r.analysis!, tags };
  });

  const vocab = buildContentVocabulary(contentReels(hydrated));
  const styleTagged = styleReels(hydrated);
  const metricsSource = styleTagged.length > 0 ? styleTagged : ok;
  const metrics = assembleFingerprint(metricsSource.map((r) => r.analysis!));

  console.log(`transcribing target...`);
  const resolved = await resolveReel(target);
  if ('error' in resolved) {
    console.error('target resolve failed:', resolved.error);
    process.exit(3);
  }
  console.log(`  duration: ${(resolved.duration_ms / 1000).toFixed(1)}s`);
  const samples = await extractReelAudio(resolved.playable_url);
  if (!samples) {
    console.error('target audio extraction failed');
    process.exit(4);
  }
  const transcript = await transcribeReel(samples);
  if (!transcript) {
    console.error('target transcription failed (need OPENAI_API_KEY)');
    process.exit(5);
  }
  console.log(`  ${transcript.words.length} words\n`);

  console.log(`synthesizing edit plan...`);
  const plan = await synthesize({
    transcript: transcript.words,
    inspirationReels: inspiration,
    metrics,
    vocabulary: vocab,
  });
  if (!plan) {
    console.error('synthesis failed (need OPENAI_API_KEY)');
    process.exit(6);
  }
  console.log(`  ${plan.shots.length} shots planned\n`);

  // Confirmation gate — show the user the plan summary and require
  // explicit approval before the curator starts spending money on
  // OpenAI agent loops + image generation.
  console.log(`${'='.repeat(70)}`);
  console.log(`PLAN REVIEW`);
  console.log(`${'='.repeat(70)}`);
  console.log(
    `target_duration:   ${(plan.total_duration_ms / 1000).toFixed(1)}s`,
  );
  console.log(`structure:         ${plan.structure_confidence} confidence`);
  if (plan.structure_sections.length > 0) {
    for (const s of plan.structure_sections) {
      const t0 = (s.target_start_ms / 1000).toFixed(2);
      const t1 = (s.target_end_ms / 1000).toFixed(2);
      console.log(
        `  • ${s.role.padEnd(12)} [${t0}s-${t1}s] ${s.shot_count} shot(s)  fill: "${s.target_fill.slice(0, 60)}${s.target_fill.length > 60 ? '…' : ''}"`,
      );
    }
  }
  console.log(`shots:             ${plan.shots.length}`);
  console.log(`content patterns:`);
  for (const p of plan.content_source_patterns) {
    console.log(`  • ${p}`);
  }
  console.log(`asset method mix:`);
  const methodCounts = new Map<string, number>();
  for (const s of plan.shots) {
    methodCounts.set(
      s.asset.method,
      (methodCounts.get(s.asset.method) ?? 0) + 1,
    );
  }
  for (const [k, v] of Array.from(methodCounts.entries()).sort(
    ([, a], [, b]) => b - a,
  )) {
    console.log(`  ${k.padEnd(18)} ${v}`);
  }
  console.log(
    `\nestimated curator cost: ~$${(plan.shots.length * 0.003).toFixed(2)} (gpt-4o-mini, ~3 tool calls/shot)`,
  );
  console.log(
    `additional cost if generate_image fires: +$0.04/image (gpt-image-1 portrait)`,
  );

  if (!noConfirm) {
    const ok = await confirm(
      `\nProceed to curation for ${plan.shots.length} shot(s)? (y/n): `,
    );
    if (!ok) {
      console.log('aborted.');
      process.exit(0);
    }
  } else {
    console.log(`\n--no-confirm set; proceeding to curation.`);
  }

  console.log(
    `\ncurating media for ${plan.shots.length} shot(s), concurrency=${concurrency}...`,
  );
  console.log(`(each shot runs an agent loop with web_search + fetch_page + generate_image)`);
  const result = await curate(plan, {
    concurrency,
    onShotComplete: (cur, completed, total) => printCuration(cur, completed, total),
  });

  console.log(`\n${'='.repeat(70)}`);
  console.log(`CURATION SUMMARY`);
  console.log(`${'='.repeat(70)}`);
  console.log(`shots curated:  ${result.shots.length}`);
  const totalCandidates = result.shots.reduce(
    (n, s) => n + s.candidates.length,
    0,
  );
  console.log(`total candidates: ${totalCandidates}`);
  const failed = result.shots.filter((s) => s.candidates.length === 0).length;
  console.log(
    `failed shots:   ${failed} / ${result.shots.length} (${failed === 0 ? '0' : ((failed / result.shots.length) * 100).toFixed(0)}%)`,
  );
  console.log(
    `total tokens:   ${result.usage.total_tokens.toLocaleString()} ` +
      `(in: ${result.usage.input_tokens.toLocaleString()}, out: ${result.usage.output_tokens.toLocaleString()})`,
  );
  console.log(`elapsed:        ${(result.duration_ms / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
