// Diagnostic: is the poor accuracy due to the 16kHz->32kHz upsample
// (missing >8kHz content the model needs), or the model/logic itself?
// For a few well-known clips, compare RAW full-clip tagging at:
//   (a) 16kHz extracted then upsampled 2x  (current pipeline input)
//   (b) 32kHz extracted natively           (proposed fix)
// No baseline subtraction, no suppression — pure model top-5.
import * as ort from 'onnxruntime-web';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = 'resources/myinstants';
const NAMES = ['ding', 'Applause', 'whoosh sfx', 'Vine Boom', 'Cinematic Boom', 'HAha funny laugh', 'Mouse Click'];

function extract(path: string, rate: number): Float32Array {
  const buf = execFileSync(
    'ffmpeg',
    ['-nostdin', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const s = new Float32Array(buf.length / 2);
  for (let i = 0; i < s.length; i++) s[i] = buf.readInt16LE(i * 2) / 32768;
  return s;
}

function up2x(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length * 2);
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    const b = i + 1 < src.length ? src[i + 1] : a;
    out[2 * i] = a;
    out[2 * i + 1] = 0.5 * (a + b);
  }
  return out;
}

async function top5(session: ort.InferenceSession, wave: Float32Array, labels: string[]): Promise<string> {
  const t = new ort.Tensor('float32', wave, [1, wave.length]);
  const out = await session.run({ [session.inputNames[0]]: t });
  const scores = out[session.outputNames[0]].data as Float32Array;
  const idx = [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, 5);
  return idx.map((i) => `${labels[i]}=${scores[i].toFixed(2)}`).join(', ');
}

async function main(): Promise<void> {
  const labels = (
    JSON.parse(
      readFileSync('resources/models/panns-classmap.json', 'utf8'),
    ) as { labels: string[] }
  ).labels;
  const session = await ort.InferenceSession.create('resources/models/panns-cnn14.onnx');
  const index = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8')) as {
    entries: { name: string; local_file: string }[];
  };

  for (const name of NAMES) {
    const e = index.entries.find((x) => x.name === name && x.local_file);
    if (!e) {
      console.log(`(not found: ${name})`);
      continue;
    }
    const path = join(ROOT, 'audio', e.local_file);
    const s16 = extract(path, 16000);
    const s32 = extract(path, 32000);
    console.log(`\n"${name}" (${(s32.length / 32000).toFixed(2)}s)`);
    console.log(`  16k->up2x : ${await top5(session, up2x(s16), labels)}`);
    console.log(`  32k native: ${await top5(session, s32, labels)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
