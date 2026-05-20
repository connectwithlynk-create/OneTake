import { annotateShots } from '../analyze/ocr';
import type { ShotBoundary } from '../analyze/shots';
import type { ExtractedFrame } from 'expo-frame-extractor';

// Mock the native module so we can run jest in a node env (no native
// bridge available).
jest.mock('expo-frame-extractor', () => ({
  recognizeText: jest.fn(async (jpegBase64: string) => {
    if (jpegBase64 === 'HOOK') return 'POV: you just realized\n';
    if (jpegBase64 === 'BLANK') return '';
    if (jpegBase64 === 'FAIL') throw new Error('decoder error');
    return '';
  }),
}));

function frame(opts: Partial<ExtractedFrame> & { jpegBase64: string }): ExtractedFrame {
  return {
    jpegBase64: opts.jpegBase64,
    width: opts.width ?? 480,
    height: opts.height ?? 270,
    timestampMs: opts.timestampMs ?? 0,
    dhashHex: opts.dhashHex ?? '0000000000000000',
    hasFace: opts.hasFace ?? false,
  };
}

describe('annotateShots', () => {
  it('runs OCR only on each shot\'s representative frame', async () => {
    const frames = [
      frame({ jpegBase64: 'A', timestampMs: 0, hasFace: true }),
      frame({ jpegBase64: 'HOOK', timestampMs: 500, hasFace: true }),
      frame({ jpegBase64: 'C', timestampMs: 1000, hasFace: false }),
      frame({ jpegBase64: 'BLANK', timestampMs: 1500, hasFace: false }),
      frame({ jpegBase64: 'E', timestampMs: 2000, hasFace: false }),
    ];
    const shots: ShotBoundary[] = [
      { start_ms: 0, end_ms: 1000, representativeFrameIndex: 1 },
      { start_ms: 1000, end_ms: 2000, representativeFrameIndex: 3 },
    ];
    const out = await annotateShots(frames, shots);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      start_ms: 0,
      end_ms: 1000,
      has_face: true,
      ocr_text: 'POV: you just realized',
    });
    // BLANK -> empty string -> null (so callers can use `!= null`).
    expect(out[1]).toEqual({
      start_ms: 1000,
      end_ms: 2000,
      has_face: false,
      ocr_text: null,
    });

    const { recognizeText } = jest.requireMock('expo-frame-extractor');
    expect(recognizeText).toHaveBeenCalledTimes(2);
  });

  it('treats OCR failure as no-text rather than aborting', async () => {
    const frames = [frame({ jpegBase64: 'FAIL', hasFace: true })];
    const shots: ShotBoundary[] = [
      { start_ms: 0, end_ms: 1000, representativeFrameIndex: 0 },
    ];
    const out = await annotateShots(frames, shots);
    expect(out).toHaveLength(1);
    expect(out[0].ocr_text).toBeNull();
    expect(out[0].has_face).toBe(true);
  });

  it('handles a missing representative frame gracefully', async () => {
    const frames: ExtractedFrame[] = [];
    const shots: ShotBoundary[] = [
      { start_ms: 0, end_ms: 1000, representativeFrameIndex: 0 },
    ];
    const out = await annotateShots(frames, shots);
    expect(out[0].has_face).toBe(false);
    expect(out[0].ocr_text).toBeNull();
  });
});
