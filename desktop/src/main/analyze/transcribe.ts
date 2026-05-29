// Full-reel audio transcription via OpenAI Whisper, with word-level
// timestamps. The on-screen text at the start of a reel (OCR'd
// hook_text) is often just a caption of the voice — or sometimes
// unrelated text scaffolding. For voiceover-driven UGC, the SPOKEN
// hook is what reveals the creator's writing style.
//
// We now transcribe the WHOLE reel with verbose_json so we get word
// timestamps:
//  - the hook is derived from the first HOOK_MS of words (single call,
//    not a separate API request);
//  - downstream consumers can align media overlays (and other timed
//    events) to whatever was being said at that moment.
//
// Best-effort: missing API key or API failure returns null and the
// pipeline keeps running with hook_text (OCR) as the fallback.

import OpenAI from 'openai';

const SAMPLE_RATE = 16000;
/** Window used to derive the hook slice from the word stream. Most UGC
 *  hooks are 1–4s; 5s covers the long tail. */
const HOOK_MS = 5000;

/** Convert float32 [-1, 1] mono samples to a WAV buffer (16-bit PCM
 *  little-endian) suitable for the Whisper file upload. */
function floatSamplesToWav(
  samples: Float32Array,
  sampleRate: number,
): Buffer {
  const numSamples = samples.length;
  const byteRate = sampleRate * 2; // 16-bit mono
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** One transcribed word with reel-time bounds (ms from reel start). */
export interface TranscriptWord {
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface ReelTranscript {
  /** Every word in the reel, in spoken order. */
  words: TranscriptWord[];
  /** Spoken hook — words whose start lands within the first HOOK_MS.
   *  Empty string when nothing was spoken in that window. */
  hook: string;
}

/** Transcribe the full reel via Whisper with word-level timestamps.
 *  Returns null on missing API key, audio too short, or API failure
 *  (caller should fall back to OCR hook + empty word list). */
export async function transcribeReel(
  samples: Float32Array,
): Promise<ReelTranscript | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // Need at least ~0.5s of audio for Whisper to produce anything useful.
  if (samples.length < SAMPLE_RATE / 2) return null;

  const wav = floatSamplesToWav(samples, SAMPLE_RATE);

  try {
    const client = new OpenAI({ apiKey });
    // The openai SDK accepts a web File object; Node 20 has File global.
    const file = new File([new Uint8Array(wav)], 'reel.wav', {
      type: 'audio/wav',
    });
    const resp = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });
    const words: TranscriptWord[] = (resp.words ?? []).map((w) => ({
      text: w.word,
      start_ms: Math.round(w.start * 1000),
      end_ms: Math.round(w.end * 1000),
    }));
    const hookWords = words.filter((w) => w.start_ms < HOOK_MS);
    const hook = hookWords.map((w) => w.text).join(' ').trim();
    return { words, hook };
  } catch (err) {
    console.error(
      '[transcribe] reel transcription failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Words whose [start_ms, end_ms] window overlaps [from_ms, to_ms],
 *  joined with single spaces. Empty string when none overlap. */
export function spokenWindow(
  words: TranscriptWord[],
  from_ms: number,
  to_ms: number,
): string {
  const hits: string[] = [];
  for (const w of words) {
    if (w.end_ms <= from_ms || w.start_ms >= to_ms) continue;
    hits.push(w.text);
  }
  return hits.join(' ').replace(/\s+/g, ' ').trim();
}
