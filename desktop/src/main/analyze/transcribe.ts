// Audio hook transcription via OpenAI Whisper.
//
// The on-screen text at the start of a reel (OCR'd hook_text) is often
// just a caption of the voice — or sometimes unrelated text scaffolding.
// For voiceover-driven UGC, the SPOKEN hook is what reveals the
// creator's writing style. We Whisper-transcribe the first few seconds
// of audio so hook clustering sees actual sentences, not screen text.
//
// Best-effort: missing API key or API failure returns null and the
// pipeline keeps running with hook_text (OCR) as the fallback.

import OpenAI from 'openai';

const SAMPLE_RATE = 16000;
/** Seconds of audio to transcribe for the hook. Most UGC hooks are
 *  1-4 seconds; 5 covers the long tail without bloating the API call. */
const HOOK_SECONDS = 5;

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

/** Transcribe the first HOOK_SECONDS of the reel's 16 kHz mono audio
 *  buffer via Whisper. Returns null on missing API key, audio too
 *  short, or API failure (caller should fall back to OCR hook). */
export async function transcribeHook(
  samples: Float32Array,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const slice = samples.slice(0, HOOK_SECONDS * SAMPLE_RATE);
  // Need at least ~0.5 s of audio for Whisper to produce anything useful.
  if (slice.length < SAMPLE_RATE / 2) return null;

  const wav = floatSamplesToWav(slice, SAMPLE_RATE);

  try {
    const client = new OpenAI({ apiKey });
    // The openai SDK accepts a web File object; Node 20 has File global.
    const file = new File([new Uint8Array(wav)], 'hook.wav', {
      type: 'audio/wav',
    });
    const resp = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'text',
      // Empty prompt; Whisper picks up English by default. Could pin
      // language='en' here if we ever ship non-English reels.
    });
    const text =
      typeof resp === 'string' ? resp.trim() : String(resp).trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    console.error(
      '[transcribe] hook transcription failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
