// Resolve a reel URL, extract its audio, and Whisper-transcribe the full
// reel with word-level timestamps. Prints the timestamped word list and
// the joined text. No scene detect, no face / SyncNet / overlays / OCR —
// just the script.
//
// Run from desktop/:
//   npx tsx scripts/transcribe-reel.ts <reel-url>
// Needs OPENAI_API_KEY in .env.
import './_env';
import { extractReelAudio } from '../src/main/analyze/audio';
import { transcribeReel } from '../src/main/analyze/transcribe';
import { resolveReel } from '../src/main/resolver';

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: transcribe-reel <reel-url>');
    process.exit(1);
  }

  const r = await resolveReel(url);
  if ('error' in r) {
    console.error('resolve failed:', r.error);
    process.exit(2);
  }
  console.log(`source: ${url}`);
  console.log(`duration: ${(r.duration_ms / 1000).toFixed(1)}s\n`);

  const samples = await extractReelAudio(r.playable_url);
  if (!samples) {
    console.error('audio extraction failed');
    process.exit(3);
  }
  console.log(`audio: ${samples.length} samples (${(samples.length / 16000).toFixed(1)}s @ 16 kHz)\n`);

  const transcript = await transcribeReel(samples);
  if (!transcript) {
    console.error(
      'transcription failed (missing OPENAI_API_KEY in .env, or API error)',
    );
    process.exit(4);
  }

  console.log(`--- timestamped words (${transcript.words.length}) ---`);
  for (const w of transcript.words) {
    console.log(
      `  [${(w.start_ms / 1000).toFixed(2)}s - ${(w.end_ms / 1000).toFixed(2)}s]  ${w.text}`,
    );
  }
  console.log(`\n--- full text ---`);
  console.log(transcript.words.map((w) => w.text).join(' '));
  if (transcript.hook) {
    console.log(`\n--- hook (first 5s) ---`);
    console.log(transcript.hook);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
