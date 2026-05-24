// Quick diagnostic: load the Silero VAD ONNX and dump its inputs/outputs
// + run it on a known-speech buffer to see actual probability values.
import * as ort from 'onnxruntime-web';
import { join } from 'path';
import { extractReelAudio } from '../src/main/analyze/audio';
import { resolveReel } from '../src/main/resolver';

async function main(): Promise<void> {
  const modelPath = join(
    process.env.SYNCNET_MODEL_DIR || 'resources/models',
    'silero_vad.onnx',
  );
  console.log('loading', modelPath);
  const session = await ort.InferenceSession.create(modelPath);

  console.log('inputs:');
  for (const name of session.inputNames) {
    const meta = session.inputMetadata[name];
    console.log(' ', name, JSON.stringify(meta));
  }
  console.log('outputs:');
  for (const name of session.outputNames) {
    const meta = session.outputMetadata[name];
    console.log(' ', name, JSON.stringify(meta));
  }

  const url = process.argv[2];
  if (!url) {
    console.log('no URL given - skipping inference probe');
    return;
  }
  console.log('\nresolving', url);
  const r = await resolveReel(url);
  if ('error' in r) {
    console.log('resolve failed:', r.error);
    return;
  }
  console.log('extracting audio...');
  const samples = await extractReelAudio(r.playable_url);
  if (!samples) {
    console.log('no audio');
    return;
  }
  console.log('got', samples.length, 'samples');

  const { runVAD } = await import('../src/main/analyze/vad');
  console.log('\nrunning runVAD on full reel (using context-aware path)...');
  const probs = await runVAD(samples);
  if (!probs) {
    console.log('VAD returned null');
    return;
  }
  const speechFrames = Array.from(probs).filter((p) => p >= 0.5).length;
  console.log(
    `  ${probs.length} frames total; ${speechFrames} >= 0.5 threshold`,
  );

  // Print summary stats
  const sorted = Array.from(probs).sort((a, b) => a - b);
  const pct = (p: number): number => sorted[Math.floor(sorted.length * p)];
  console.log(
    `  p10=${pct(0.1).toFixed(3)} p50=${pct(0.5).toFixed(3)} ` +
      `p90=${pct(0.9).toFixed(3)} max=${Math.max(...sorted).toFixed(3)}`,
  );

  // Print first 60 frames so we can see the curve
  console.log('\n  first 60 frames:');
  for (let i = 0; i < Math.min(60, probs.length); i++) {
    if (i < 20 || i % 10 === 0) {
      console.log(`    frame ${i}: prob=${probs[i].toFixed(4)}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
