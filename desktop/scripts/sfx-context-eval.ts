// Verify the SFX-in-context layer end-to-end on a real reel (lightweight —
// no full analyzeReel). Uses your OPENAI_API_KEY (Whisper + gpt-4o-mini).
//   npx tsx scripts/sfx-context-eval.ts <file-or-url> <durationMs>
import { extractReelAudio } from '../src/main/analyze/audio';
import { detectSfxOnsets } from '../src/main/analyze/sfx';
import { classifyOnset } from '../src/main/analyze/sfx-classify';
import { runVAD, speechMaskFromProbs } from '../src/main/analyze/vad';
import { transcribeReel } from '../src/main/analyze/transcribe';
import { analyzeSfxContext, type TypedSfxEvent } from '../src/main/analyze/sfx-context';

async function main() {
  const url = process.argv[2];
  const durationMs = Number(process.argv[3] || '20000');
  if (!url) { console.log('usage: tsx scripts/sfx-context-eval.ts <file-or-url> <durationMs>'); return; }
  const samples = await extractReelAudio(url);
  if (!samples) { console.log('no audio'); return; }
  const probs = await runVAD(samples);
  const speechMask = probs ? speechMaskFromProbs(probs) : undefined;
  const onsets = detectSfxOnsets(samples, speechMask);
  const events: TypedSfxEvent[] = [];
  for (const o of onsets) { const h = classifyOnset(samples, o.ms); if (h) events.push({ ms: o.ms, type: h.type }); }
  const tr = await transcribeReel(samples);
  const words = tr?.words ?? [];
  console.log(`onsets=${events.length} words=${words.length}`);
  const ctx = await analyzeSfxContext(events, words, [], 5000, durationMs);
  console.log('\n=== SFX CONTEXT ===');
  console.log('llm:', ctx.llm);
  console.log('signals:', JSON.stringify(ctx.signals, null, 1));
  console.log('pattern_summary:', ctx.pattern_summary);
  console.log('rules:'); for (const r of ctx.rules) console.log('  -', r.trigger, '->', r.sfx_type, r.example ? `(e.g. "${r.example}")` : '');
}
main().catch((e) => { console.error(e); process.exit(1); });
