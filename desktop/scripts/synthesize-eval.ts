// End-to-end synthesis eval:
//
//   1. Hydrate library (resolve + analyze each tagged reel; cached on disk)
//   2. Assemble style fingerprint from style-tagged reels
//   3. Assemble content vocabulary from content-tagged reels
//   4. Transcribe the target reel (Whisper, word-level timestamps)
//   5. Run the synthesis engine → beat-by-beat editing plan
//   6. Print the plan
//
// Run from desktop/:
//   npx tsx scripts/synthesize-eval.ts \
//     --content URL [--content URL ...] \
//     --style URL [--style URL ...] \
//     --target URL
//
// Requires OPENAI_API_KEY (Whisper) and ANTHROPIC_API_KEY (captions +
// synthesis). Library analyses are cached to ./.library/cache/ keyed
// by URL + ANALYSIS_VERSION so re-runs are instant.
import './_env';
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
import { resolveReel } from '../src/main/resolver';

interface Args {
  content: string[];
  style: string[];
  structure: string[];
  target: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const content: string[] = [];
  const style: string[] = [];
  const structure: string[] = [];
  let target = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--content') content.push(argv[++i]);
    else if (a === '--style') style.push(argv[++i]);
    else if (a === '--structure') structure.push(argv[++i]);
    else if (a === '--target') target = argv[++i];
  }
  if (
    !target ||
    (content.length === 0 && style.length === 0 && structure.length === 0)
  ) {
    console.error(
      'usage: synthesize-eval [--content URL ...] [--style URL ...] [--structure URL ...] --target URL\n\n' +
        'A reel can carry multiple tags by passing it under each flag.\n' +
        'Requires OPENAI_API_KEY in .env.',
    );
    process.exit(1);
  }
  return { content, style, structure, target };
}

function printShot(shot: import('../src/main/analyze/synthesize').ShotPlan): void {
  const t0 = (shot.start_ms / 1000).toFixed(2);
  const t1 = (shot.end_ms / 1000).toFixed(2);
  const dur = (shot.duration_ms / 1000).toFixed(2);
  console.log(
    `\nshot ${String(shot.shot_idx).padStart(2, '0')}  [${t0}s – ${t1}s | ${dur}s]  ${shot.clip_type}  · ${shot.structure_role}`,
  );
  console.log(`  spoken:       "${shot.spoken_during || '(silence)'}"`);
  console.log(`  b-roll:       ${shot.broll_description}`);
  console.log(`  source_type:  ${shot.source_type}`);
  const a = shot.asset;
  console.log(`  asset:        method=${a.method}`);
  if (a.web_capture) {
    console.log(
      `                ↳ url:   ${a.web_capture.url}`,
    );
    console.log(`                ↳ focus: ${a.web_capture.focus}`);
  }
  if (a.library_search) {
    console.log(`                ↳ library query: ${a.library_search.query}`);
  }
  if (a.stock_search) {
    console.log(`                ↳ stock query:   ${a.stock_search.query}`);
  }
  if (a.generate_image) {
    console.log(`                ↳ image prompt:  ${a.generate_image.prompt}`);
  }
  if (a.manual) {
    console.log(`                ↳ manual:        ${a.manual.instruction}`);
  }
  if (a.camera_move) {
    console.log(`                ↳ camera_move:   ${a.camera_move}`);
  }
  const p = shot.placement;
  console.log(
    `  placement:    ${p.aspect} · ${p.fit} @ ${p.position} · scale ${p.scale.toFixed(2)}`,
  );
  if (shot.additional_elements.length > 0) {
    console.log(`  elements:`);
    for (const el of shot.additional_elements) {
      const anim = el.animation ? ` (${el.animation})` : '';
      console.log(
        `    • ${el.kind} @ ${el.position}${anim} — ${el.description}`,
      );
    }
  }
  if (shot.inspired_by) {
    console.log(
      `  inspired_by:  ${shot.inspired_by.url}  shot ${shot.inspired_by.shot_idx}`,
    );
    console.log(`                ↳ ${shot.inspired_by.pattern}`);
  }
  if (shot.text_overlay) {
    console.log(
      `  text:         "${shot.text_overlay}"  @  ${shot.text_position}`,
    );
  } else {
    console.log(`  text:         (none)`);
  }
  if (shot.animation_cue) {
    console.log(`  animation:    ${shot.animation_cue}`);
  }
  console.log(`  sfx:          ${shot.sfx_cue ?? '(none)'}`);
  console.log(`  why:          ${shot.rationale}`);
}

async function main(): Promise<void> {
  const { content, style, structure, target } = parseArgs();

  // Build library spec — a reel can carry multiple tags.
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

  // Persist the library list so future runs can re-read it.
  saveLibrary(library);

  console.log(`hydrating ${library.length} library reel(s)...`);
  const hydrated = await hydrateLibrary(library);
  const ok = hydrated.filter((r) => r.analysis);
  console.log(`  ${ok.length}/${hydrated.length} analyzed successfully\n`);
  if (ok.length === 0) {
    console.error('no library reels analyzed; aborting.');
    process.exit(2);
  }

  // Build the inspiration list — every analyzed reel gets fed to the
  // LLM with its tag composition, so the planner can extract content-
  // source patterns and mirror editing style as appropriate.
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

  console.log(`inspiration: ${inspiration.length} reel(s)`);
  for (const r of inspiration) {
    console.log(
      `  [${r.tags.padEnd(15)}]  ${r.analysis.shots.length} shots, cuts/sec=${r.analysis.cuts_per_sec.toFixed(2)}  ${r.url}`,
    );
  }

  // Keep the vocabulary aggregation around for surface compat / debug —
  // synthesize() no longer treats it as a literal lookup, but it's
  // useful for printed stats.
  const contentTaggedReels = contentReels(hydrated);
  const vocab = buildContentVocabulary(contentTaggedReels);
  console.log(
    `(content vocabulary catalogued for ref: ${vocab.shots.length} shots from ${contentTaggedReels.length} content-tagged reel)`,
  );

  // Aggregate fingerprint over inspiration → numerical targets for
  // the planner. Style-tagged subset preferred (editing patterns live
  // there); falls back to all inspiration when no style-tagged reels.
  const styleTagged = styleReels(hydrated);
  const metricsSource = styleTagged.length > 0 ? styleTagged : ok;
  const metrics = assembleFingerprint(
    metricsSource.map((r) => r.analysis!),
  );
  console.log(
    `\nstyle metrics: aggregated from ${metrics.n_reels} reel(s), ${metrics.n_shots} shots ` +
      `(median_shot=${metrics.median_shot_ms}ms, cuts/sec=${metrics.cuts_per_sec.toFixed(2)})`,
  );

  // Transcribe target.
  console.log(`\ntranscribing target...`);
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
  console.log(`  ${transcript.words.length} words transcribed`);
  console.log(`  full text: "${transcript.words.map((w) => w.text).join(' ')}"`);

  // Synthesize.
  console.log(`\nsynthesizing edit plan...`);
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

  // Print.
  console.log(`\n${'='.repeat(70)}`);
  console.log(`SUGGESTED EDIT PLAN`);
  console.log(`${'='.repeat(70)}`);
  console.log(
    `target_duration: ${(plan.total_duration_ms / 1000).toFixed(1)}s`,
  );
  console.log(`shots: ${plan.shots.length}`);

  console.log(`\n--- INSPIRATION SOURCES ---`);
  console.log(plan.style_summary);

  console.log(`\n--- DETECTED REEL STRUCTURE ---`);
  console.log(`confidence: ${plan.structure_confidence.toUpperCase()}`);
  if (plan.structure_rationale) {
    console.log(`why:        ${plan.structure_rationale}`);
  }
  if (plan.structure_sections.length === 0) {
    console.log('(no structure detected)');
  } else {
    console.log('sections:');
    for (const s of plan.structure_sections) {
      const t0 = (s.target_start_ms / 1000).toFixed(2);
      const t1 = (s.target_end_ms / 1000).toFixed(2);
      console.log(
        `  • ${s.role.padEnd(12)}  [${t0}s – ${t1}s]  ${s.shot_count} shot(s)`,
      );
      if (s.script_template) {
        console.log(`      template: "${s.script_template}"`);
      }
      if (s.target_fill) {
        console.log(`      fill:     "${s.target_fill}"`);
      }
      const v = s.visual_signature;
      console.log(`      clip:      ${v.dominant_clip_type}`);
      console.log(`      placement: ${v.placement_pattern}`);
      console.log(`      text:      ${v.text_overlay_pattern}`);
      console.log(`      sfx:       ${v.sfx_pattern}`);
      console.log(`      motion:    ${v.motion_pattern}`);
      if (v.scene_elements.length > 0) {
        console.log(`      elements:  ${v.scene_elements.join(', ')}`);
      }
    }
  }
  if (plan.structure_confidence !== 'high' && plan.structure_alternatives) {
    console.log(`\n⚠  STRUCTURE IS ${plan.structure_confidence.toUpperCase()} CONFIDENCE — alternatives the LLM considered:`);
    plan.structure_alternatives.forEach((alt, i) => {
      console.log(`  alternative ${i + 1}:`);
      for (const s of alt) {
        const t0 = (s.target_start_ms / 1000).toFixed(2);
        const t1 = (s.target_end_ms / 1000).toFixed(2);
        console.log(
          `    • ${s.role.padEnd(12)}  [${t0}s – ${t1}s]  ${s.shot_count} shot(s)`,
        );
        if (s.script_template) console.log(`        template: "${s.script_template}"`);
        if (s.target_fill) console.log(`        fill:     "${s.target_fill}"`);
      }
    });
    console.log(
      `  → if neither the primary nor an alternative fits, rerun with a manual structure spec (not yet implemented — let me know if needed)`,
    );
  }

  console.log(`\n--- EXTRACTED CONTENT SOURCE PATTERNS ---`);
  if (plan.content_source_patterns.length === 0) {
    console.log('(no patterns extracted)');
  } else {
    console.log(
      'The creator typically sources b-roll from these kinds of places:',
    );
    for (const p of plan.content_source_patterns) {
      console.log(`  • ${p}`);
    }
  }

  if (plan.target_metrics) {
    const m = plan.target_metrics;
    console.log(`\n--- STYLE METRICS THE PLANNER WAS GIVEN ---`);
    console.log(
      `  median_shot_ms       ${m.median_shot_ms}  (target beat ~${(m.median_shot_ms / 1000).toFixed(2)}s)`,
    );
    console.log(
      `  cuts_per_sec         ${m.cuts_per_sec.toFixed(2)}`,
    );
    console.log(
      `  text_overlay_pct     ${(m.text_overlay_pct * 100).toFixed(0)}%  (dominant=${m.text_region_dominant})`,
    );
    console.log(
      `  cuts_with_sfx_pct    ${(m.cuts_with_sfx_pct * 100).toFixed(0)}%  (sfx_per_min=${m.sfx_per_min.toFixed(1)})`,
    );
    console.log(
      `  media_overlay_pct    ${(m.media_overlay_pct * 100).toFixed(0)}%  (overlays_per_min=${m.overlays_per_min.toFixed(1)})`,
    );
    const dominantClip = Object.entries(m.clip_type_distribution)
      .sort(([, a], [, b]) => b - a)
      .filter(([, v]) => v > 0.01);
    console.log(
      `  clip_type_dominant   ` +
        dominantClip.map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' / '),
    );
  }

  console.log(`\n--- SHOT PLAN ---`);
  plan.shots.forEach(printShot);

  // Aggregate vs ALL inspiration shots — does the plan's shot mix
  // and pacing actually mirror the inspiration?
  const textCount = plan.shots.filter((s) => s.text_overlay.length > 0).length;
  const sfxCount = plan.shots.filter((s) => s.sfx_cue).length;
  const clipMix = new Map<string, number>();
  for (const s of plan.shots) {
    clipMix.set(s.clip_type, (clipMix.get(s.clip_type) ?? 0) + 1);
  }
  const inspClipMix = new Map<string, number>();
  let inspTotalShots = 0;
  let inspTextShots = 0;
  let inspSfxAtCutShots = 0;
  for (const r of inspiration) {
    for (const s of r.analysis.shots) {
      inspClipMix.set(s.clip_type, (inspClipMix.get(s.clip_type) ?? 0) + 1);
      if ((s.ocr_text ?? '').length > 0) inspTextShots++;
      if (s.sfx_at_start) inspSfxAtCutShots++;
      inspTotalShots++;
    }
  }
  const safeRatio = (n: number, d: number): string =>
    d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`;
  console.log(`\n--- AGGREGATE CHECK (plan vs inspiration) ---`);
  console.log(
    `text overlay  : plan ${safeRatio(textCount, plan.shots.length)} | inspiration ${safeRatio(inspTextShots, inspTotalShots)}`,
  );
  console.log(
    `SFX on cut    : plan ${safeRatio(sfxCount, plan.shots.length)} | inspiration ${safeRatio(inspSfxAtCutShots, inspTotalShots)}`,
  );
  console.log(`clip mix      : plan vs inspiration`);
  const allClipTypes = new Set([
    ...clipMix.keys(),
    ...inspClipMix.keys(),
  ]);
  for (const k of allClipTypes) {
    const planN = clipMix.get(k) ?? 0;
    const exN = inspClipMix.get(k) ?? 0;
    console.log(
      `  ${k.padEnd(22)} ${safeRatio(planN, plan.shots.length).padEnd(5)} | ${safeRatio(exN, inspTotalShots)}`,
    );
  }
  const traced = plan.shots.filter((s) => s.inspired_by).length;
  console.log(
    `inspiration trace: ${traced}/${plan.shots.length} shots reference a specific inspiration shot (${safeRatio(traced, plan.shots.length)})`,
  );
  const planCutsPerSec =
    plan.shots.length / Math.max(1, plan.total_duration_ms / 1000);
  const inspCutsPerSec =
    inspiration.length > 0
      ? inspiration.reduce((s, r) => s + r.analysis.cuts_per_sec, 0) /
        inspiration.length
      : 0;
  const planMedianShotMs = (() => {
    const ds = plan.shots.map((s) => s.duration_ms);
    if (ds.length === 0) return 0;
    const sorted = [...ds].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  })();
  const inspMedianShotMs =
    inspiration.length > 0
      ? Math.round(
          inspiration.reduce((s, r) => s + r.analysis.median_shot_ms, 0) /
            inspiration.length,
        )
      : 0;
  console.log(
    `cuts/sec      : plan ${planCutsPerSec.toFixed(2)} | inspiration ${inspCutsPerSec.toFixed(2)}`,
  );
  console.log(
    `median shot   : plan ${planMedianShotMs}ms | inspiration ${inspMedianShotMs}ms`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
