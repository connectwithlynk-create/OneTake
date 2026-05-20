import { requireNativeModule } from 'expo';

/** One sampled frame from a remote video. Bytes are JPEG, base64-encoded
 *  so they cross the JS bridge cleanly. `timestampMs` echoes the request
 *  so callers can match outputs to inputs even when some timestamps fail
 *  silently (past end of file, decoder error). `dhashHex` is a 64-bit
 *  perceptual hash (16 hex chars) computed natively on a 9x8 grayscale
 *  thumbnail - cheap to diff in JS for shot-boundary detection.
 *  `hasFace` is the native face detector's verdict for this frame
 *  (talking-head heuristic). */
export interface ExtractedFrame {
  jpegBase64: string;
  width: number;
  height: number;
  timestampMs: number;
  dhashHex: string;
  hasFace: boolean;
}

interface FrameExtractorNativeModule {
  extractFrames(
    url: string,
    timestampsMs: number[],
    options?: { maxDimension?: number; quality?: number }
  ): Promise<ExtractedFrame[]>;
  recognizeText(jpegBase64: string): Promise<string>;
}

const native = requireNativeModule<FrameExtractorNativeModule>('FrameExtractor');

/**
 * Extract frames at the given timestamps (in ms from the start of the
 * video) from a remote video URL. Streams byte ranges only - does not
 * download the full file. Failing timestamps are silently dropped from
 * the result (no throw), so the output array may be shorter than the
 * request.
 *
 * @param url            Streamable mp4/HLS URL. Must be reachable from
 *                       the device; redirects are followed by the OS.
 * @param timestampsMs   Times to sample at, in ms. Order is preserved.
 * @param options.maxDimension  Resize so longest side <= this (px).
 *                              Default 480 (good for OCR+face detection).
 * @param options.quality       JPEG quality 0..1. Default 0.6.
 */
export async function extractFrames(
  url: string,
  timestampsMs: number[],
  options?: { maxDimension?: number; quality?: number }
): Promise<ExtractedFrame[]> {
  if (!url) throw new Error('extractFrames: url required');
  if (!Array.isArray(timestampsMs) || timestampsMs.length === 0) return [];
  return native.extractFrames(url, timestampsMs, options ?? {});
}

/**
 * Run platform OCR (iOS Vision, Android ML Kit) on a single JPEG frame.
 * Expensive (~50-200ms/frame); call only on shot-representative frames,
 * never the full sampled set. Returns the recognized text joined with
 * newlines, or "" if nothing was read.
 */
export async function recognizeText(jpegBase64: string): Promise<string> {
  if (!jpegBase64) return '';
  return native.recognizeText(jpegBase64);
}
