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

export type ClipType =
  | 'talking_head'
  | 'broll_talking_head'
  | 'talking_head_unknown'
  | 'broll_visual';

export type FrameRegion =
  | 'top_left'
  | 'top_center'
  | 'top_right'
  | 'middle_left'
  | 'middle_center'
  | 'middle_right'
  | 'bottom_left'
  | 'bottom_center'
  | 'bottom_right';

export interface NormBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReelShot {
  start_ms: number;
  end_ms: number;
  has_face: boolean;
  ocr_text: string | null;
  speaker_verdict: 'speaker' | 'broll' | 'no_face' | 'unknown';
  speaker_confidence: number;
  sync_conf: number;
  clip_type: ClipType;
  face_bbox: NormBBox | null;
  face_region: FrameRegion | null;
  text_moments: TextMoment[];
  audio_rms_mean: number;
  audio_peak_rms: number;
  audio_silence_pct: number;
  audio_speech_pct: number;
  audio_music_pct: number;
  sfx_count: number;
  sfx_at_start: boolean;
  sfx_classifications: SfxClassifiedEvent[];
}

export type SfxType =
  | 'impulse_tonal'
  | 'impulse_noisy'
  | 'sweep'
  | 'vocal'
  | 'sustained'
  | 'other';

export interface SfxClassifiedEvent {
  ms: number;
  type: SfxType;
  confidence: number;
  features: {
    rise_time_ms: number;
    decay_90_ms: number;
    duration_above_floor_ms: number;
    spectral_centroid_hz: number;
    spectral_flatness: number;
    voice_band_ratio: number;
    peak_rms: number;
  };
}

export interface TextMoment {
  text: string;
  bbox: NormBBox;
  region: FrameRegion;
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
  clip_type_distribution: Record<ClipType, number>;
  face_region_dominant: FrameRegion | 'mixed' | null;
  face_region_distribution: Record<FrameRegion, number> | null;
  face_size_median: number | null;
  text_region_dominant: FrameRegion | 'mixed' | null;
  text_region_distribution: Record<FrameRegion, number> | null;
  audio_energy_mean: number;
  audio_energy_std: number;
  audio_silence_pct: number;
  voiceover_pct: number;
  music_pct: number;
  sfx_per_min: number;
  cuts_with_sfx_pct: number;
  sfx_at_cuts_pct: number;
  sfx_type_distribution: Record<SfxType, number>;
  sfx_classified_total: number;
}

export interface HookArchetype {
  template: string;
  weight: number;
  examples: string[];
  description: string;
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
