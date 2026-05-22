export interface ResolvedReel {
  platform: 'youtube' | 'tiktok' | 'instagram' | 'unknown';
  playable_url: string;
  playable_url_expires_at: number | null;
  duration_ms: number;
  width: number | null;
  height: number | null;
  caption_text: string | null;
}

export type ResolveResult = ResolvedReel | { error: string };

export interface ReelShot {
  start_ms: number;
  end_ms: number;
  has_face: boolean;
  ocr_text: string | null;
  speaker_verdict: 'speaker' | 'broll' | 'no_face' | 'unknown';
  speaker_confidence: number;
  asd_score: number;
}

export interface ReelAnalysisResult {
  shots: ReelShot[];
  hook_text: string | null;
  hook_duration_ms: number | null;
  median_shot_ms: number;
  cuts_per_sec: number;
  talking_pct: number;
  broll_pct: number;
  text_overlay_pct: number;
  real_speaker_pct: number;
  broll_talking_head_pct: number;
}

declare global {
  interface Window {
    api: {
      resolveReel: (url: string) => Promise<ResolveResult>;
      analyzeReel: (input: {
        playableUrl: string;
        durationMs: number;
      }) => Promise<ReelAnalysisResult>;
    };
  }
}
