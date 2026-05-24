// Speaker-detection evaluation driver, for the Path A (option-1) vs
// Path B (option-2) comparison. Branch-agnostic: it just calls the
// current branch's resolveReel + analyzeReel, so run it on each branch
// and diff the output.
//
// Run (from desktop/):
//   npx esbuild scripts/speaker-eval.ts --bundle --platform=node \
//     --format=cjs --outfile=/tmp/eval.cjs \
//     --external:tesseract.js --external:jpeg-js \
//     --external:@tensorflow/tfjs --external:@tensorflow/tfjs-backend-wasm \
//     --external:@tensorflow-models/face-detection \
//     --external:@tensorflow-models/face-landmarks-detection \
//     --external:onnxruntime-web
//   LIGHT_ASD_MODEL_PATH="$PWD/resources/models/light-asd.onnx" \
//     node /tmp/eval.cjs <reel-url> [reel-url ...]
import { analyzeReel } from '../src/main/analyze';
import { resolveReel } from '../src/main/resolver';

async function main(): Promise<void> {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('usage: speaker-eval <reel-url> [reel-url ...]');
    process.exit(1);
  }
  for (const url of urls) {
    console.log(`\n=== ${url} ===`);
    const t0 = Date.now();
    try {
      const r = await resolveReel(url);
      if ('error' in r) {
        console.log('  resolve failed:', r.error);
        continue;
      }
      const a = await analyzeReel({
        playableUrl: r.playable_url,
        durationMs: r.duration_ms,
      });
      console.log(
        `  ${a.shots.length} shots | real_speaker ${(a.real_speaker_pct * 100).toFixed(0)}% | ` +
          `broll_head ${(a.broll_talking_head_pct * 100).toFixed(0)}% | ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      const dist = a.clip_type_distribution;
      const distLine = Object.entries(dist)
        .filter(([, pct]) => pct > 0)
        .sort(([, a1], [, b1]) => b1 - a1)
        .map(([t, pct]) => `${t} ${(pct * 100).toFixed(0)}%`)
        .join(' | ');
      console.log(`  clip_types: ${distLine || '(none)'}`);
      if (a.face_region_dominant !== null) {
        console.log(
          `  face_region: ${a.face_region_dominant} | face_size_median: ${(a.face_size_median ?? 0).toFixed(2)}`,
        );
        const fdist = a.face_region_distribution ?? {};
        const fdistLine = Object.entries(fdist)
          .filter(([, pct]) => (pct as number) > 0)
          .sort(([, a1], [, b1]) => (b1 as number) - (a1 as number))
          .map(([r, pct]) => `${r} ${((pct as number) * 100).toFixed(0)}%`)
          .join(' | ');
        console.log(`  face_grid: ${fdistLine || '(none)'}`);
      } else {
        console.log('  face_region: (no face shots)');
      }
      console.log(
        `  audio: voiceover=${(a.voiceover_pct * 100).toFixed(0)}% ` +
          `music=${(a.music_pct * 100).toFixed(0)}% ` +
          `silence=${(a.audio_silence_pct * 100).toFixed(0)}% | ` +
          `energy_mean=${a.audio_energy_mean.toFixed(3)} ` +
          `energy_std=${a.audio_energy_std.toFixed(3)}`,
      );
      if (a.text_region_dominant !== null) {
        console.log(`  text_region: ${a.text_region_dominant}`);
        const tdist = a.text_region_distribution ?? {};
        const tdistLine = Object.entries(tdist)
          .filter(([, pct]) => (pct as number) > 0)
          .sort(([, a1], [, b1]) => (b1 as number) - (a1 as number))
          .map(([r, pct]) => `${r} ${((pct as number) * 100).toFixed(0)}%`)
          .join(' | ');
        console.log(`  text_grid:  ${tdistLine || '(none)'}`);
      } else {
        console.log('  text_region: (no text shots)');
      }
      a.shots.forEach((s, i) => {
        const fregion = s.face_region ? s.face_region.padEnd(14) : '--------------';
        const fsize = s.face_bbox ? s.face_bbox.h.toFixed(2) : '----';
        // Per-shot display: list unique text regions observed in this
        // shot's moments (de-duped, in order of first appearance).
        const seen = new Set<string>();
        const tregions = s.text_moments
          .map((m: { region: string }) => m.region)
          .filter((r: string) => (seen.has(r) ? false : (seen.add(r), true)));
        const tDisplay = (
          tregions.length === 0 ? '--' : tregions.join(',')
        ).padEnd(34);
        const audSplit =
          `vo${(s.audio_speech_pct * 100).toFixed(0).padStart(3)}% ` +
          `mu${(s.audio_music_pct * 100).toFixed(0).padStart(3)}% ` +
          `sl${(s.audio_silence_pct * 100).toFixed(0).padStart(3)}%`;
        console.log(
          `    ${String(i).padStart(2, '0')}  ${s.start_ms}-${s.end_ms}ms  ` +
            `${s.clip_type.padEnd(22)} ${s.speaker_verdict.padEnd(8)} ` +
            `conf=${s.speaker_confidence.toFixed(2)} face=${fregion} h=${fsize} ` +
            `text=${tDisplay} ${audSplit}`,
        );
      });
    } catch (e) {
      console.log('  ERROR:', e instanceof Error ? e.message : String(e));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
