// Diagnostic: given a reel URL and a library slug we believe is the
// ground-truth match, print where that library entry actually ranks
// for every detected SFX onset. Tells us whether the matcher's failures
// are "the right entry ranks badly" (algorithm broken — needs different
// fingerprint) vs "the right entry ranks top-5 but loses to noise"
// (algorithm OK — needs better discrimination / threshold).
//
// Run from desktop/:
//   SYNCNET_MODEL_DIR=resources/models npx tsx scripts/sfx-diagnostic.ts \
//     <reel-url> <library-slug>
import { extractReelAudio } from '../src/main/analyze/audio';
import { resolveReel } from '../src/main/resolver';
import { detectSfxOnsets } from '../src/main/analyze/sfx';
import {
  computeFingerprint,
  loadLibrary,
  sliceWindow,
} from '../src/main/analyze/sfx-match';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

async function main(): Promise<void> {
  const url = process.argv[2];
  const targetSlug = process.argv[3];
  if (!url || !targetSlug) {
    console.error(
      'usage: sfx-diagnostic <reel-url> <library-slug>\n' +
        'example: ... https://www.instagram.com/reel/X/ ding-sound-effect',
    );
    process.exit(1);
  }

  const lib = loadLibrary();
  if (!lib) {
    console.error('no library');
    process.exit(1);
  }
  const target = lib.entries.find((e) => e.slug === targetSlug);
  if (!target) {
    console.error(`slug not in library: ${targetSlug}`);
    process.exit(1);
  }
  if (!target.fingerprint) {
    console.error(`target has no fingerprint: ${targetSlug}`);
    process.exit(1);
  }
  console.log(`target: "${target.name}" (${targetSlug})`);

  const r = await resolveReel(url);
  if ('error' in r) {
    console.log('resolve failed:', r.error);
    return;
  }
  const samples = await extractReelAudio(r.playable_url);
  if (!samples) {
    console.log('no audio');
    return;
  }
  const events = detectSfxOnsets(samples);
  console.log(`detected ${events.length} SFX onsets in reel\n`);

  // Pre-compute all library cosines once per query for ranking.
  const indexed = lib.entries.filter((e) => e.fingerprint);
  console.log(
    `library has ${indexed.length} fingerprinted entries (of ${lib.entries.length})\n`,
  );

  console.log(
    'onset_ms | target_sim | target_rank | top1_name (top1_sim)',
  );
  console.log('---------|------------|-------------|----------------------');
  for (const ev of events) {
    const clip = sliceWindow(samples, ev.ms);
    const fp = computeFingerprint(clip);
    if (!fp) {
      console.log(`${String(ev.ms).padStart(8)} | (fp failed)`);
      continue;
    }
    const targetSim = cosine(fp, target.fingerprint);
    // Compute all sims, find rank of target.
    const scored: { slug: string; name: string; sim: number }[] = [];
    for (const e of indexed) {
      scored.push({
        slug: e.slug,
        name: e.name,
        sim: cosine(fp, e.fingerprint!),
      });
    }
    scored.sort((a, b) => b.sim - a.sim);
    const rank = scored.findIndex((s) => s.slug === targetSlug) + 1;
    const top1 = scored[0];
    console.log(
      `${String(ev.ms).padStart(8)} | ${targetSim.toFixed(3).padStart(10)} | ` +
        `${String(rank).padStart(11)} | "${top1.name.slice(0, 30)}" (${top1.sim.toFixed(3)})`,
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
