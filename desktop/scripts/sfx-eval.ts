// SFX classification eval: validates the hybrid model+heuristic path.
//   1. Loads panns-cnn14.onnx in onnxruntime-web (op-support gate).
//   2. Extracts audio from local reel(s), detects SFX onsets.
//   3. Runs the PANNs AudioSet classifier + the heuristic on each onset,
//      printing per-onset labels and a collection-level label tally.
//
// Run from desktop/:  npx tsx scripts/sfx-eval.ts <file-or-url> [...]
import * as ort from 'onnxruntime-web';
import { join } from 'path';
import { extractReelAudio } from '../src/main/analyze/audio';
import { detectSfxOnsets } from '../src/main/analyze/sfx';
import { classifyOnset } from '../src/main/analyze/sfx-classify';
import {
  audioSetModelAvailable,
  classifyOnsetsAudioSet,
} from '../src/main/analyze/sfx-audioset';
import { runVAD, speechMaskFromProbs } from '../src/main/analyze/vad';

async function main(): Promise<void> {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.log('usage: tsx scripts/sfx-eval.ts <file-or-url> [...]');
    return;
  }

  // --- Gate 1: does the ONNX load in onnxruntime-web (WASM)? ---
  console.log('model available on disk:', audioSetModelAvailable());
  const modelPath = join(
    process.env.SYNCNET_MODEL_DIR || 'resources/models',
    'panns-cnn14.onnx',
  );
  console.log('loading', modelPath, 'in onnxruntime-web...');
  const t0 = Date.now();
  const session = await ort.InferenceSession.create(modelPath);
  console.log(`  loaded in ${Date.now() - t0}ms`);
  console.log('  inputs:', session.inputNames.join(', '));
  console.log('  outputs:', session.outputNames.join(', '));

  const labelTally = new Map<string, number>();
  let agree = 0;
  let totalModel = 0;

  for (const input of inputs) {
    console.log(`\n=== ${input} ===`);
    const samples = await extractReelAudio(input);
    if (!samples) {
      console.log('  no audio (ffmpeg failed) — skipping');
      continue;
    }
    const durS = (samples.length / 16000).toFixed(1);
    console.log(`  ${samples.length} samples (${durS}s)`);

    const onsets = detectSfxOnsets(samples);
    console.log(`  ${onsets.length} SFX onsets detected`);
    if (onsets.length === 0) continue;

    // Mirror the production path: VAD-derived speech mask gates whether
    // each onset uses baseline subtraction (speech regions) or raw
    // tagging (non-speech regions).
    const probs = await runVAD(samples);
    const speechMask = probs ? speechMaskFromProbs(probs) : undefined;
    const speechFrames = speechMask
      ? speechMask.filter(Boolean).length
      : 0;
    console.log(
      `  VAD speech: ${speechMask ? `${speechFrames}/${speechMask.length} frames` : 'unavailable'}`,
    );

    const tInf = Date.now();
    const results = await classifyOnsetsAudioSet(
      samples,
      onsets.map((o) => o.ms),
      speechMask,
    );
    const infMs = Date.now() - tInf;
    console.log(
      `  model inference: ${infMs}ms for ${onsets.length} onsets ` +
        `(${(infMs / onsets.length).toFixed(0)}ms/onset)`,
    );

    let modelHits = 0;
    for (let i = 0; i < onsets.length; i++) {
      const m = results[i];
      const h = classifyOnset(samples, onsets[i].ms);
      const t = (onsets[i].ms / 1000).toFixed(2);
      if (m) {
        modelHits++;
        totalModel++;
        labelTally.set(m.top, (labelTally.get(m.top) ?? 0) + 1);
        if (h && h.type === m.bucket) agree++;
        const top3 = m.labels
          .slice(0, 3)
          .map((l) => `${l.label}=${l.score.toFixed(2)}`)
          .join(', ');
        console.log(
          `  ${t}s  MODEL  ${m.bucket.padEnd(13)} "${m.top}" ` +
            `(${m.confidence.toFixed(2)})  [heur: ${h?.type ?? 'none'}]  {${top3}}`,
        );
      } else {
        console.log(
          `  ${t}s  HEUR   ${(h?.type ?? 'none').padEnd(13)} ` +
            `(${h?.confidence.toFixed(2) ?? '-'})  [model: no confident label]`,
        );
      }
    }
    console.log(
      `  -> ${modelHits}/${onsets.length} classified by model, ` +
        `${onsets.length - modelHits} fell back to heuristic`,
    );
  }

  console.log('\n=== collection label tally (model-classified onsets) ===');
  const sorted = [...labelTally.entries()].sort((a, b) => b[1] - a[1]);
  for (const [label, n] of sorted) {
    console.log(`  ${String(n).padStart(3)}  ${label}`);
  }
  if (totalModel > 0) {
    console.log(
      `\nmodel/heuristic bucket agreement: ${agree}/${totalModel} ` +
        `(${((100 * agree) / totalModel).toFixed(0)}%)`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
