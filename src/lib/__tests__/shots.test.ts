import { detectShots } from '../analyze/shots';
import { pickSampleTimestamps } from '../analyze/sampling';
import type { ExtractedFrame } from 'expo-frame-extractor';

function frame(ts: number, hex: string): ExtractedFrame {
  return {
    jpegBase64: '',
    width: 480,
    height: 270,
    timestampMs: ts,
    dhashHex: hex,
    hasFace: false,
  };
}

describe('pickSampleTimestamps', () => {
  it('returns evenly spaced timestamps within trimmed range', () => {
    const ts = pickSampleTimestamps(30_000, { intervalMs: 500 });
    expect(ts.length).toBeGreaterThanOrEqual(20);
    expect(ts.length).toBeLessThanOrEqual(80);
    expect(ts[0]).toBeGreaterThanOrEqual(100);
    expect(ts[ts.length - 1]).toBeLessThanOrEqual(30_000 - 100);
  });
  it('clamps to minSamples for very short reels', () => {
    const ts = pickSampleTimestamps(3_000);
    expect(ts.length).toBeGreaterThanOrEqual(20);
  });
  it('returns empty for zero-length input', () => {
    expect(pickSampleTimestamps(0)).toEqual([]);
  });
});

describe('detectShots', () => {
  it('returns one shot when all hashes are identical', () => {
    const frames = Array.from({ length: 10 }, (_, i) =>
      frame(i * 500, '0000000000000000')
    );
    const shots = detectShots(frames, { durationMs: 5000 });
    expect(shots.length).toBe(1);
    expect(shots[0].start_ms).toBe(0);
    expect(shots[0].end_ms).toBe(5000);
  });

  it('detects a cut when a large hash flip occurs', () => {
    // First 5 frames similar, then a hard cut, then 5 frames different.
    const frames = [
      frame(0, '0000000000000000'),
      frame(500, '0000000000000001'),
      frame(1000, '0000000000000003'),
      frame(1500, '0000000000000001'),
      frame(2000, '0000000000000000'),
      // big jump: all bits flipped
      frame(2500, 'ffffffffffffffff'),
      frame(3000, 'fffffffffffffffe'),
      frame(3500, 'ffffffffffffffff'),
      frame(4000, 'ffffffffffffffff'),
      frame(4500, 'fffffffffffffffe'),
    ];
    const shots = detectShots(frames, { durationMs: 5000 });
    expect(shots.length).toBe(2);
    expect(shots[0].start_ms).toBe(0);
    expect(shots[1].start_ms).toBe(2500);
    expect(shots[1].end_ms).toBe(5000);
  });

  it('merges shots shorter than minShotMs into the previous', () => {
    // A blip in the middle (one frame flipped, then back) - shouldn't
    // produce a separate sub-shot.
    const frames = [
      frame(0, '0000000000000000'),
      frame(100, '0000000000000000'),
      frame(200, 'ffffffffffffffff'),
      frame(300, '0000000000000000'),
      frame(400, '0000000000000000'),
    ];
    const shots = detectShots(frames, {
      durationMs: 500,
      minShotMs: 250,
    });
    // We expect either 1 shot (cleaner) or at most 2 - never 3.
    expect(shots.length).toBeLessThanOrEqual(2);
  });

  it('handles empty input', () => {
    expect(detectShots([])).toEqual([]);
  });

  it('marks the only frame as one full shot when given a single sample', () => {
    const shots = detectShots([frame(1000, '0000000000000000')], {
      durationMs: 5000,
    });
    expect(shots.length).toBe(1);
    expect(shots[0].end_ms).toBe(5000);
  });
});
