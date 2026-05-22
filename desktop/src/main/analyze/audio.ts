// Extracts a window of 16 kHz mono audio for Path A's MFCC features.
import { execFile } from 'child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/**
 * Extract a window of audio as 16 kHz mono samples. Returns the raw int16
 * sample VALUES as floats (NOT normalized to [-1,1]) - python_speech_features
 * (and therefore Light-ASD's MFCC) is computed on the int16 wav samples.
 */
export function extractAudioPCM(
  url: string,
  startMs: number,
  durMs: number,
): Promise<Float32Array> {
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      [
        '-nostdin', '-loglevel', 'error',
        '-ss', (startMs / 1000).toFixed(3),
        '-i', url,
        '-t', (durMs / 1000).toFixed(3),
        '-ac', '1',
        '-ar', '16000',
        '-f', 's16le',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      (err, stdout) => {
        const buf = stdout as unknown as Buffer;
        if (err || !buf || buf.length < 2) {
          resolve(new Float32Array(0));
          return;
        }
        const n = buf.length >> 1;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = buf.readInt16LE(i * 2);
        }
        resolve(out);
      },
    );
  });
}
