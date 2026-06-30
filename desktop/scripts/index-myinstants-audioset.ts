// Index the whole myinstants SFX library with AudioSet labels (PANNs).
// These are clean isolated clips, so we use RAW full-clip tagging (no
// baseline subtraction, no window — that machinery is only for SFX buried
// under voiceover). Output: resources/myinstants/audioset-labels.json
//   { slug: { name, file, top, bucket, labels: [{label, score}] } }
//
// Run from desktop/:  npx tsx scripts/index-myinstants-audioset.ts
import * as ort from 'onnxruntime-web';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { audioSetLabelToBucket } from '../src/main/analyze/sfx-audioset';

const ROOT = 'resources/myinstants';
const RATE = 32000;
const MAX_S = 4; // truncate/pad clips to 4s for uniform batching
const L = RATE * MAX_S;
const BATCH = 16;
const TOP_K = 3;

interface Entry {
  slug: string;
  name: string;
  local_file: string;
}

function extract(path: string): Float32Array | null {
  try {
    const buf = execFileSync(
      'ffmpeg',
      ['-nostdin', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(RATE), '-t', String(MAX_S), '-f', 's16le', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
    );
    const s = new Float32Array(L); // zero-padded to L
    const n = Math.min(L, buf.length / 2);
    for (let i = 0; i < n; i++) s[i] = buf.readInt16LE(i * 2) / 32768;
    return s;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const labels = (
    JSON.parse(readFileSync(join(ROOT, '..', 'models', 'panns-classmap.json'), 'utf8')) as {
      labels: string[];
    }
  ).labels;
  const session = await ort.InferenceSession.create('resources/models/panns-cnn14.onnx');
  const inName = session.inputNames[0];
  const outName = session.outputNames[0];

  const index = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8')) as {
    entries: Entry[];
  };
  const entries = index.entries.filter((e) => e.local_file && e.slug);
  console.log(`indexing ${entries.length} clips @ ${RATE}Hz, ${MAX_S}s, batch ${BATCH}`);

  const out: Record<string, unknown> = {};
  const bucketTally = new Map<string, number>();
  const labelTally = new Map<string, number>();
  let done = 0;
  let failed = 0;

  for (let start = 0; start < entries.length; start += BATCH) {
    const slice = entries.slice(start, start + BATCH);
    const waves: Float32Array[] = [];
    const valid: Entry[] = [];
    for (const e of slice) {
      const w = extract(join(ROOT, 'audio', e.local_file));
      if (w) {
        waves.push(w);
        valid.push(e);
      } else {
        failed++;
      }
    }
    if (waves.length === 0) continue;

    const flat = new Float32Array(waves.length * L);
    for (let i = 0; i < waves.length; i++) flat.set(waves[i], i * L);
    const t = new ort.Tensor('float32', flat, [waves.length, L]);
    const res = await session.run({ [inName]: t });
    const data = res[outName].data as Float32Array;
    const C = data.length / waves.length;

    for (let i = 0; i < valid.length; i++) {
      const row = data.subarray(i * C, (i + 1) * C);
      const idx = [...row.keys()].sort((a, b) => row[b] - row[a]).slice(0, TOP_K);
      const top = labels[idx[0]];
      const bucket = audioSetLabelToBucket(top);
      out[valid[i].slug] = {
        name: valid[i].name,
        file: valid[i].local_file,
        top,
        bucket,
        labels: idx.map((j) => ({ label: labels[j], score: Number(row[j].toFixed(3)) })),
      };
      bucketTally.set(bucket, (bucketTally.get(bucket) ?? 0) + 1);
      labelTally.set(top, (labelTally.get(top) ?? 0) + 1);
    }
    done += valid.length;
    if (start % (BATCH * 8) === 0) console.log(`  ${done}/${entries.length}...`);
  }

  const outPath = join(ROOT, 'audioset-labels.json');
  writeFileSync(outPath, JSON.stringify(out, null, 0));
  console.log(`\nwrote ${outPath}: ${done} clips (${failed} failed to decode)`);

  console.log('\n=== bucket distribution ===');
  for (const [b, n] of [...bucketTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${b}`);
  }
  console.log('\n=== top 25 AudioSet labels ===');
  for (const [l, n] of [...labelTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(n).padStart(4)}  ${l}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
