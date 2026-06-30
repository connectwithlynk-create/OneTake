// One-off: resolve a real short-form reel that HAS audio and save its audio
// to /tmp/reel-sfx-test.wav for the SFX-detection eval. Network-uncertain.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveReel } from '../src/main/resolver';

const execFileAsync = promisify(execFile);

// Distinct candidate reel URLs gathered from .library/library.json +
// collections.json. All Instagram (no TikTok/YouTube in this library).
const CANDIDATES = [
  'https://www.instagram.com/p/DYlQlfYuTc7/',
  'https://www.instagram.com/p/DXz_iMJNjlV/',
  'https://www.instagram.com/p/DYg26zgRiGS/',
  'https://www.instagram.com/p/DU_3YEUEoGG/',
  'https://www.instagram.com/reel/DYxLMnNRzQ5/?igsh=bXhtY2JlNjhsYzNm',
  'https://www.instagram.com/reel/DYg26zgRiGS/?igsh=enl3MzA3dnFnNHNv',
];

async function hasAudio(url: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      url,
    ]);
    return stdout.trim().includes('audio');
  } catch (e: any) {
    console.log('    ffprobe failed:', (e.stderr || e.message || '').trim().slice(0, 300));
    return false;
  }
}

async function main(): Promise<void> {
  for (const url of CANDIDATES) {
    console.log('\n=== resolving', url);
    let r;
    try {
      r = await resolveReel(url);
    } catch (e: any) {
      console.log('  resolveReel threw:', (e.message || String(e)).slice(0, 300));
      continue;
    }
    if ('error' in r) {
      console.log('  resolve failed:', r.error.slice(0, 300));
      continue;
    }
    console.log('  resolved:', r.platform, 'dur_ms=', r.duration_ms);
    console.log('  checking audio stream...');
    if (!(await hasAudio(r.playable_url))) {
      console.log('  no audio stream - skipping');
      continue;
    }
    console.log('  audio present -> extracting to /tmp/reel-sfx-test.wav');
    await execFileAsync('ffmpeg', [
      '-nostdin', '-loglevel', 'error',
      '-i', r.playable_url,
      '-vn', '-ac', '1', '-ar', '16000',
      '-y', '/tmp/reel-sfx-test.wav',
    ]);
    console.log('\nWINNER');
    console.log('  source_url:', url);
    console.log('  platform:', r.platform);
    console.log('  duration_ms:', r.duration_ms);
    console.log('  saved: /tmp/reel-sfx-test.wav');
    return;
  }
  console.log('\nEXHAUSTED: no candidate yielded a playable URL with audio.');
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
