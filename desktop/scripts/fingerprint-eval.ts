// fingerprint-eval: take N reel URLs, run the full analyzer on each,
// then assemble + print a CollectionFingerprint. Validates the
// aggregation logic against multi-reel input.
//
// Run from desktop/:
//   npx tsx scripts/fingerprint-eval.ts <url1> <url2> [...]
// Keys + config: copy .env.example -> .env and fill in OPENAI_API_KEY
// for hook clustering. SYNCNET_MODEL_DIR defaults to resources/models.
import './_env';
import { analyzeReel, type ReelAnalysisResult } from '../src/main/analyze';
import {
  assembleFingerprint,
  assembleFingerprintWithHooks,
} from '../src/main/analyze/fingerprint';
import { resolveReel } from '../src/main/resolver';

async function main(): Promise<void> {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error(
      'usage: fingerprint-eval <reel-url> [reel-url ...]\n' +
        'env: SYNCNET_MODEL_DIR=resources/models',
    );
    process.exit(1);
  }

  // Concurrency: ffmpeg subprocesses + network resolves parallelize
  // cleanly; the WASM workloads (tfjs face, ONNX SyncNet/VAD,
  // tesseract) still serialize since they share singletons in one Node
  // process. Real speedup ≈ 2-3x at 4 workers. Tunable via env.
  const maxConcurrent = Math.max(
    1,
    Number(process.env.ANALYZE_CONCURRENCY ?? 4),
  );

  const t0 = Date.now();
  console.log(
    `\nanalyzing ${urls.length} reel(s), concurrency=${maxConcurrent}\n`,
  );

  const results: (ReelAnalysisResult | null)[] = new Array(urls.length).fill(
    null,
  );
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const idx = next++;
      const url = urls[idx];
      const reelT0 = Date.now();
      try {
        const r = await resolveReel(url);
        if ('error' in r) {
          console.log(`  [${idx + 1}] ${url} resolve failed: ${r.error}`);
          continue;
        }
        const a = await analyzeReel({
          playableUrl: r.playable_url,
          durationMs: r.duration_ms,
        });
        console.log(
          `  [${idx + 1}] ${a.shots.length} shots | ` +
            `vo=${(a.voiceover_pct * 100).toFixed(0)}% ` +
            `music=${(a.music_pct * 100).toFixed(0)}% | ` +
            `face=${a.face_region_dominant ?? '-'} | ` +
            `${((Date.now() - reelT0) / 1000).toFixed(1)}s   ${url}`,
        );
        results[idx] = a;
      } catch (e) {
        console.log(
          `  [${idx + 1}] ERROR: ${e instanceof Error ? e.message : String(e)}   ${url}`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(maxConcurrent, urls.length) }, worker),
  );

  const validResults = results.filter(
    (r): r is ReelAnalysisResult => r !== null,
  );
  console.log(
    `\nanalyzed ${validResults.length}/${urls.length} reels in ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
  );

  if (validResults.length === 0) {
    console.log('\nno reels analyzed; nothing to assemble.');
    return;
  }

  // Use the async assembler when OPENAI_API_KEY is set so hooks get
  // clustered into reusable archetypes; otherwise fall back to the
  // pure-function output (hook_archetypes will be null).
  const fp = process.env.OPENAI_API_KEY
    ? await assembleFingerprintWithHooks(validResults)
    : assembleFingerprint(validResults);

  console.log('\n=== CollectionFingerprint ===');
  console.log(`n_reels=${fp.n_reels}  n_shots=${fp.n_shots}`);
  console.log(`\nPacing:`);
  console.log(`  median_shot_ms=${fp.median_shot_ms}`);
  console.log(`  cuts_per_sec=${fp.cuts_per_sec.toFixed(2)}`);

  console.log(`\nClip mix:`);
  for (const [k, v] of Object.entries(fp.clip_type_distribution).sort(
    ([, a], [, b]) => (b as number) - (a as number),
  )) {
    if ((v as number) > 0) {
      console.log(`  ${k.padEnd(24)} ${((v as number) * 100).toFixed(0)}%`);
    }
  }
  console.log(
    `  real_speaker=${(fp.real_speaker_pct * 100).toFixed(0)}% | ` +
      `broll_talking_head=${(fp.broll_talking_head_pct * 100).toFixed(0)}%`,
  );

  console.log(`\nFace layout:`);
  if (fp.face_region_distribution) {
    console.log(
      `  dominant=${fp.face_region_dominant} | size_median=${fp.face_size_median?.toFixed(2)}`,
    );
    for (const [k, v] of Object.entries(fp.face_region_distribution).sort(
      ([, a], [, b]) => (b as number) - (a as number),
    )) {
      if ((v as number) > 0)
        console.log(`  ${k.padEnd(18)} ${((v as number) * 100).toFixed(0)}%`);
    }
  } else {
    console.log('  (no face shots)');
  }

  console.log(`\nText layout:`);
  if (fp.text_region_distribution) {
    console.log(
      `  dominant=${fp.text_region_dominant} | overlay_pct=${(fp.text_overlay_pct * 100).toFixed(0)}%`,
    );
    for (const [k, v] of Object.entries(fp.text_region_distribution).sort(
      ([, a], [, b]) => (b as number) - (a as number),
    )) {
      if ((v as number) > 0)
        console.log(`  ${k.padEnd(18)} ${((v as number) * 100).toFixed(0)}%`);
    }
  } else {
    console.log('  (no text shots)');
  }

  console.log(`\nAudio:`);
  console.log(
    `  voiceover=${(fp.voiceover_pct * 100).toFixed(0)}% | ` +
      `music=${(fp.music_pct * 100).toFixed(0)}% | ` +
      `silence=${(fp.audio_silence_pct * 100).toFixed(0)}%`,
  );
  console.log(`  energy_mean=${fp.audio_energy_mean.toFixed(3)}`);
  console.log(
    `  sfx: ${fp.sfx_per_min.toFixed(1)}/min | ` +
      `${(fp.cuts_with_sfx_pct * 100).toFixed(0)}% of cuts have SFX | ` +
      `${(fp.sfx_at_cuts_pct * 100).toFixed(0)}% of SFX land on cuts`,
  );

  console.log(
    `\nSFX type mix (${fp.sfx_classified_total} classified onsets):`,
  );
  const sfxDist = fp.sfx_type_distribution;
  const sorted = Object.entries(sfxDist).sort(
    ([, a], [, b]) => (b as number) - (a as number),
  );
  for (const [t, pct] of sorted) {
    if ((pct as number) > 0) {
      console.log(`  ${t.padEnd(15)} ${((pct as number) * 100).toFixed(0)}%`);
    }
  }

  console.log(`\nBeat template (sorted by shot count):`);
  for (const b of fp.beat_template) {
    console.log(
      `  ${b.clip_type.padEnd(22)} n=${String(b.n_shots).padStart(3)}  ` +
        `dur_p50=${String(b.duration_p50_ms).padStart(5)}ms  ` +
        `text=${(b.has_text_p * 100).toFixed(0).padStart(3)}%  ` +
        `face=${(b.has_face_p * 100).toFixed(0).padStart(3)}%  ` +
        `spk=${(b.is_speaker_p * 100).toFixed(0).padStart(3)}%`,
    );
  }

  console.log(
    `\nHook speech (Whisper, ${fp.hook_speeches.length} reels):`,
  );
  for (const h of fp.hook_speeches) {
    const oneLine = h.replace(/\s+/g, ' ').slice(0, 100);
    console.log(`  "${oneLine}"`);
  }
  if (fp.hook_texts.length > 0) {
    console.log(`\nHook OCR text (text overlays, for reference):`);
    for (const h of fp.hook_texts) {
      const oneLine = h.replace(/\s+/g, ' ').slice(0, 80);
      console.log(`  "${oneLine}"`);
    }
  }

  if (fp.hook_archetypes && fp.hook_archetypes.length > 0) {
    console.log(`\nHook archetypes:`);
    for (const a of fp.hook_archetypes) {
      console.log(
        `  [${(a.weight * 100).toFixed(0)}%] ${a.template}\n` +
          `         ${a.description}`,
      );
      for (const ex of a.examples) {
        console.log(`         e.g. "${ex.replace(/\s+/g, ' ').slice(0, 80)}"`);
      }
    }
  } else if (process.env.OPENAI_API_KEY) {
    console.log(`\nHook archetypes: (clustering returned no results)`);
  } else {
    console.log(
      `\nHook archetypes: (set OPENAI_API_KEY to enable clustering)`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
