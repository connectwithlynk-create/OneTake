// deriveMetrics is pure but lives next to analyzeReel which imports the
// native module at load time. Stub it so jest can load the file.
jest.mock('expo-frame-extractor', () => ({
  extractFrames: jest.fn(),
  recognizeText: jest.fn(),
}));

import { deriveMetrics } from '../analyze/analyze';
import type { ReelShot } from '../types';

const s = (
  start_ms: number,
  end_ms: number,
  has_face: boolean,
  ocr_text: string | null
): ReelShot => ({ start_ms, end_ms, has_face, ocr_text });

describe('deriveMetrics', () => {
  it('returns zeroed metrics for an empty shot list', () => {
    const m = deriveMetrics([], 0);
    expect(m).toEqual({
      hook_text: null,
      hook_duration_ms: null,
      median_shot_ms: 0,
      cuts_per_sec: 0,
      talking_pct: 0,
      broll_pct: 0,
      text_overlay_pct: 0,
    });
  });

  it('treats the first shot as the hook', () => {
    const m = deriveMetrics(
      [s(0, 1200, true, 'POV: ...'), s(1200, 2400, false, null)],
      2400
    );
    expect(m.hook_text).toBe('POV: ...');
    expect(m.hook_duration_ms).toBe(1200);
  });

  it('computes talking/broll/text shares correctly', () => {
    // 4 shots, 2 talking, 2 broll. 2 with text overlay.
    const shots = [
      s(0, 1000, true, 'hook text'),
      s(1000, 2000, false, null),
      s(2000, 3000, true, null),
      s(3000, 4000, false, 'cta'),
    ];
    const m = deriveMetrics(shots, 4000);
    expect(m.talking_pct).toBeCloseTo(0.5, 5);
    expect(m.broll_pct).toBeCloseTo(0.5, 5);
    expect(m.text_overlay_pct).toBeCloseTo(0.5, 5);
    expect(m.median_shot_ms).toBe(1000);
    // 3 cuts over 4 seconds = 0.75 cuts/sec.
    expect(m.cuts_per_sec).toBeCloseTo(0.75, 5);
  });

  it('weights pct by duration, not by shot count', () => {
    // One short talking shot, one long broll shot.
    const shots = [s(0, 200, true, null), s(200, 2200, false, null)];
    const m = deriveMetrics(shots, 2200);
    // 200 / 2200 ~= 0.0909
    expect(m.talking_pct).toBeCloseTo(200 / 2200, 4);
    expect(m.broll_pct).toBeCloseTo(2000 / 2200, 4);
  });
});
