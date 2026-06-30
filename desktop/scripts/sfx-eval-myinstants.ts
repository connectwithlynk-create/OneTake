// Classifier accuracy probe on the myinstants SFX library (clean,
// isolated clips — tests the PANNs model + label->bucket mapping, NOT the
// buried-under-voiceover case). For each picked clip we classify at the
// clip's peak-energy moment and compare the model's bucket to the bucket
// implied by the clip's NAME (rough ground truth).
//
// Run from desktop/:  npx tsx scripts/sfx-eval-myinstants.ts [N-per-type]
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractReelAudio, FRAME_SAMPLES } from '../src/main/analyze/audio';
import { classifyOnsetsAudioSet } from '../src/main/analyze/sfx-audioset';
import type { SfxType } from '../src/main/analyze/sfx-classify';

const ROOT = 'resources/myinstants';

// name-keyword -> expected coarse bucket (rough ground truth).
const GT: { kw: RegExp; bucket: SfxType; tag: string }[] = [
  { kw: /\b(ding|bell|chime|ping|bing)\b/i, bucket: 'impulse_tonal', tag: 'ding/bell' },
  { kw: /\b(clap|applause|snap|click|tap|knock)\b/i, bucket: 'impulse_noisy', tag: 'clap/click' },
  { kw: /\b(whoosh|swoosh|swish|whip|whistle)\b/i, bucket: 'sweep', tag: 'whoosh' },
  { kw: /\b(boom|explos|bang|blast)\b/i, bucket: 'impulse_noisy', tag: 'boom/bang' },
  { kw: /\b(laugh|scream|yell|cheer|gasp|wow|huh|bruh|vine)\b/i, bucket: 'vocal', tag: 'vocal' },
];

function peakMs(samples: Float32Array): number {
  const n = Math.floor(samples.length / FRAME_SAMPLES);
  let best = 0;
  let bestRms = -1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < FRAME_SAMPLES; j++) {
      const v = samples[i * FRAME_SAMPLES + j];
      s += v * v;
    }
    if (s > bestRms) {
      bestRms = s;
      best = i;
    }
  }
  return Math.round((best * FRAME_SAMPLES * 1000) / 16000);
}

async function main(): Promise<void> {
  const perType = parseInt(process.argv[2] ?? '6', 10);
  const index = JSON.parse(
    readFileSync(join(ROOT, 'index.json'), 'utf8'),
  ) as { entries: { name: string; local_file: string }[] };

  // Pick up to `perType` clips per ground-truth bucket.
  const picks: { file: string; name: string; gt: SfxType; tag: string }[] = [];
  for (const g of GT) {
    let count = 0;
    for (const e of index.entries) {
      if (count >= perType) break;
      if (e.local_file && g.kw.test(e.name)) {
        picks.push({ file: e.local_file, name: e.name, gt: g.bucket, tag: g.tag });
        count++;
      }
    }
  }
  console.log(`picked ${picks.length} clips across ${GT.length} types\n`);

  let correct = 0;
  let classified = 0;
  const perTag = new Map<string, { ok: number; n: number }>();

  for (const p of picks) {
    const path = join(ROOT, 'audio', p.file);
    const samples = await extractReelAudio(path);
    if (!samples || samples.length < FRAME_SAMPLES * 4) {
      console.log(`  [skip] ${p.name} (no/short audio)`);
      continue;
    }
    const ms = peakMs(samples);
    const [res] = await classifyOnsetsAudioSet(samples, [ms]);
    const slot = perTag.get(p.tag) ?? { ok: 0, n: 0 };
    slot.n++;
    if (res) {
      classified++;
      const ok = res.bucket === p.gt;
      if (ok) {
        correct++;
        slot.ok++;
      }
      console.log(
        `  ${ok ? 'OK ' : 'XX '} [${p.tag.padEnd(10)}] "${p.name.slice(0, 28).padEnd(28)}" ` +
          `-> ${res.bucket.padEnd(13)} "${res.top}" (${res.confidence.toFixed(2)})`,
      );
    } else {
      console.log(
        `  -- [${p.tag.padEnd(10)}] "${p.name.slice(0, 28).padEnd(28)}" -> no confident label`,
      );
    }
    perTag.set(p.tag, slot);
  }

  console.log('\n=== per-type bucket accuracy ===');
  for (const [tag, s] of perTag) {
    console.log(`  ${tag.padEnd(12)} ${s.ok}/${s.n}`);
  }
  console.log(
    `\noverall: ${correct}/${classified} buckets correct ` +
      `(${classified > 0 ? ((100 * correct) / classified).toFixed(0) : 0}%), ` +
      `${picks.length - classified} returned no label`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
