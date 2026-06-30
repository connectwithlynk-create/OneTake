// subtitle-eval: resolve + analyze one or more (content) reels and print
// the detected spoken-word SUBTITLE style — the exact data the renderer's
// "Subtitle style" panel shows (font, words/group, size, position, ...),
// plus the content-reel aggregate produced by summarizeCaptionStyles.
//
// Run from desktop/:
//   npx tsx scripts/subtitle-eval.ts <reel-url> [reel-url ...]
// Needs OPENAI_API_KEY (vision caption pass) + SYNCNET_MODEL_DIR.
import './_env';
import { existsSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { analyzeReel, type ReelAnalysisResult } from '../src/main/analyze';
import { summarizeCaptionStyles } from '../src/main/analyze/caption-style';
import { resolveReel } from '../src/main/resolver';

// This eval only cares about subtitle/caption style. SyncNet speaker
// detection (~3-5s per face shot) + its model load are pure overhead
// here, so skip them unless the caller explicitly opts back in. analyze
// reads this env at call-time, so setting it here (before main runs) is
// enough. Cuts a ~60s reel to ~20s.
if (!process.env.ANALYZE_SKIP_SPEAKER) process.env.ANALYZE_SKIP_SPEAKER = '1';

const execFileAsync = promisify(execFile);

/** Probe a local media file's duration (ms) via ffprobe. */
async function probeDurationMs(path: string): Promise<number> {
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  const { stdout } = await execFileAsync(ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  return Math.round(parseFloat(stdout.trim()) * 1000) || 0;
}

/** Resolve an arg to a playable source. A path to a local file is used
 *  directly (bypassing the Instagram resolver / bot wall); anything else
 *  is treated as a reel URL and resolved. */
async function toPlayable(
  arg: string,
): Promise<{ playableUrl: string; durationMs: number } | { error: string }> {
  if (existsSync(arg)) {
    const path = resolvePath(arg);
    return { playableUrl: path, durationMs: await probeDurationMs(path) };
  }
  const r = await resolveReel(arg);
  if ('error' in r) return { error: r.error };
  return { playableUrl: r.playable_url, durationMs: r.duration_ms };
}

function printProfile(prefix: string, cap: ReelAnalysisResult['caption_style']): void {
  if (!cap) {
    console.log(`${prefix} caption_style = null (no OPENAI_API_KEY or call failed)`);
    return;
  }
  if (!cap.present) {
    console.log(`${prefix} no spoken-word subtitles detected`);
    return;
  }
  console.log(
    `${prefix} → matches preset: ${cap.preset_label || '(none)'} (${Math.round(cap.preset_confidence * 100)}% fit)`,
  );
  console.log(`${prefix} ${cap.style_label || '(captions present)'}`);
  const rows: [string, string][] = [
    ['Position', cap.position],
    ['Chunking', cap.chunking],
    ['Words/group', cap.words_per_chunk > 0 ? String(cap.words_per_chunk) : '-'],
    ['Size', cap.font_size],
    ['Emphasis', cap.emphasis],
    ['Casing', cap.casing],
    ['Animation', cap.animation],
    ['Font (matched)', cap.font_family_name ? `${cap.font_family_name} [${cap.font_family}]` : '(none)'],
    ['Font (described)', cap.font_descriptor],
    ['Text color', cap.text_color],
    ['Treatment', cap.text_treatment],
    ['Border/BG color', cap.treatment_color ?? '-'],
    ['Highlight', cap.highlight_color ?? '-'],
    ['Emoji', cap.has_emoji ? 'yes' : 'no'],
  ];
  for (const [k, v] of rows) console.log(`    ${k.padEnd(12)} ${v}`);
}

async function main(): Promise<void> {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('usage: subtitle-eval <reel-url> [reel-url ...]');
    process.exit(1);
  }

  const profiles: ReelAnalysisResult['caption_style'][] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const t0 = Date.now();
    try {
      const src = await toPlayable(url);
      if ('error' in src) {
        console.log(`\n[${i + 1}] ${url}\n    resolve failed: ${src.error}`);
        continue;
      }
      const a = await analyzeReel({
        playableUrl: src.playableUrl,
        durationMs: src.durationMs,
      });
      // Diagnostic: detectCaptionStyle only sends frames to the vision
      // model for shots that already have OCR text_moments. If OCR found
      // nothing, the detector returns present=false WITHOUT asking the
      // model — so distinguishing "no captions" from "OCR missed them"
      // needs these counts.
      const shotsWithText = a.shots.filter((s) => s.text_moments.length > 0).length;
      const totalMoments = a.shots.reduce((n, s) => n + s.text_moments.length, 0);
      const sampleText = a.shots
        .flatMap((s) => s.text_moments.map((t) => t.text))
        .filter(Boolean)
        .slice(0, 5);
      console.log(
        `\n[${i + 1}] ${url}  (${a.shots.length} shots, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
      console.log(
        `    OCR: ${shotsWithText}/${a.shots.length} shots have text, ${totalMoments} text moments` +
          (sampleText.length ? ` — e.g. ${sampleText.map((t) => JSON.stringify(t)).join(', ')}` : ''),
      );
      printProfile('   ', a.caption_style);
      profiles.push(a.caption_style);
    } catch (e) {
      console.log(`\n[${i + 1}] ERROR: ${e instanceof Error ? e.message : String(e)}  ${url}`);
    }
  }

  if (profiles.length === 0) {
    console.log('\nno reels analyzed.');
    return;
  }

  const s = summarizeCaptionStyles(profiles);
  console.log('\n=== Content-reel subtitle summary (summarizeCaptionStyles) ===');
  console.log(`  captions in ${s.n_with_captions}/${profiles.length} reels (${(s.captions_pct * 100).toFixed(0)}%)`);
  console.log(`  MATCHED PRESET  ${s.preset_label || s.matched_preset || '(none)'} (${(s.preset_confidence_avg * 100).toFixed(0)}% fit)`);
  console.log(`  preset dist     ${JSON.stringify(s.preset_distribution)}`);
  console.log(`  position        ${s.position}`);
  console.log(`  chunking        ${s.chunking}`);
  console.log(`  words/group avg ${s.words_per_chunk_avg.toFixed(1)}`);
  console.log(`  font_size       ${s.font_size}`);
  console.log(`  treatment       ${s.text_treatment} ${JSON.stringify(s.treatment_distribution)}`);
  console.log(`  treatment color ${s.treatment_color_examples.join(', ') || '-'}`);
  console.log(`  emphasis        ${s.emphasis}`);
  console.log(`  casing          ${s.casing}`);
  console.log(`  animation       ${s.animation}`);
  console.log(`  has_emoji       ${(s.has_emoji_pct * 100).toFixed(0)}%`);
  if (s.font_descriptors.length) console.log(`  fonts seen      ${s.font_descriptors.join('; ')}`);
  if (s.style_labels.length) console.log(`  styles seen     ${s.style_labels.join('; ')}`);
  console.log(`  size dist       ${JSON.stringify(s.font_size_distribution)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
