import { annotateShots } from './annotate';
import {
  audioMetricsForShots,
  extractReelAudio,
  type ShotAudio,
} from './audio';
import { extractShotFrames } from './frame-extractor';
import { detectScenes } from './scene-detect';
import {
  detectSfxOnsets,
  sfxAtCutsRatio,
  shotSfxMetrics,
  type ShotSfx,
} from './sfx';
import { classifyOnset } from './sfx-classify';
import { captionShots, type ShotFramesForCaption } from './shot-caption';
import { spokenWindow, transcribeReel } from './transcribe';
import type { SfxClassifiedEvent } from './types';
import { detectSpeaker, type ShotSpeakerInfo } from './speaker';
import { runVAD, speechMaskFromProbs } from './vad';
import {
  CLIP_TYPES,
  FRAME_REGIONS,
  OVERLAY_KINDS,
  OVERLAY_MOTIONS,
  type ClipType,
  type FrameRegion,
  type OverlayKind,
  type OverlayMotion,
  type ReelShot,
} from './types';

/** Bump when the analysis algorithm changes meaningfully. */
export const ANALYSIS_VERSION = 23;

export interface ReelAnalysisInput {
  playableUrl: string;
  durationMs: number;
}

/** Per-reel structured output. */
export interface ReelAnalysisResult {
  shots: ReelShot[];
  hook_text: string | null;
  hook_duration_ms: number | null;
  median_shot_ms: number;
  cuts_per_sec: number;
  talking_pct: number;
  broll_pct: number;
  text_overlay_pct: number;
  /** Fraction of shots whose on-screen face is the reel's real speaker
   *  (lip movement tracks the audio). */
  real_speaker_pct: number;
  /** Fraction of shots that are a b-roll talking head - a face whose
   *  lips do NOT track the reel's audio. */
  broll_talking_head_pct: number;
  /** Duration-weighted share of each clip type, summing to ~1. Empty
   *  categories are present with value 0 so the shape is stable. */
  clip_type_distribution: Record<ClipType, number>;
  /** 3x3 grid cell most face shots sit in, or null if no faces. "mixed"
   *  when no single cell claims a clear majority (>50% of face shots). */
  face_region_dominant: FrameRegion | 'mixed' | null;
  /** Per-cell distribution across the 3x3 grid (face shots only).
   *  Null when there are no face shots. */
  face_region_distribution: Record<FrameRegion, number> | null;
  /** Median face bbox HEIGHT (normalized 0-1) across all face shots — a
   *  proxy for typical face size / closeness. Null if no faces. */
  face_size_median: number | null;
  /** 3x3 grid cell where text overlays most commonly sit. "mixed" when
   *  no cell wins a clear majority. Null when no text was detected. */
  text_region_dominant: FrameRegion | 'mixed' | null;
  /** Per-cell distribution of text overlays across the 3x3 grid (text
   *  shots only). Null when there are no text shots. */
  text_region_distribution: Record<FrameRegion, number> | null;
  /** Duration-weighted mean RMS amplitude across the reel, [0, 1]. */
  audio_energy_mean: number;
  /** Standard deviation of per-shot RMS — dynamic range proxy. Higher =
   *  more variation between loud and quiet shots. */
  audio_energy_std: number;
  /** Fraction of total duration that's near-silent. */
  audio_silence_pct: number;
  /** Fraction of total duration flagged as speech by Silero VAD. */
  voiceover_pct: number;
  /** Fraction of total duration that's audible but non-speech (music,
   *  ambient, SFX) — the "music or other non-vocal" bucket. */
  music_pct: number;
  /** Whisper transcript of the first ~5 seconds of audio — the
   *  SPOKEN hook. Preferred over OCR hook_text for clustering because
   *  it captures the creator's actual opening words, not whatever text
   *  overlay happened to land at the start. Null when no OPENAI_API_KEY
   *  is set or the transcription call failed. */
  hook_speech: string | null;
  /** SFX onsets per minute, computed from total events / reel duration. */
  sfx_per_min: number;
  /** Fraction of shot starts that have an SFX onset within ±200ms — the
   *  "whoosh on every cut" signature. */
  cuts_with_sfx_pct: number;
  /** Of all SFX onsets, the fraction that land near a shot boundary. */
  sfx_at_cuts_pct: number;
  /** Fraction of shots that contain at least one media overlay
   *  (sticker / GIF / image / PiP video / emoji graphic). Text
   *  captions are NOT counted here — see text_overlay_pct for those. */
  media_overlay_pct: number;
  /** Total detected overlays per minute of reel duration. */
  overlays_per_min: number;
  /** Distribution across OverlayKind, fraction of detected overlays in
   *  each bucket. Empty buckets present with value 0 so the shape is
   *  stable. Null when no overlays were detected. */
  overlay_kind_distribution: Record<OverlayKind, number> | null;
  /** Distribution across OverlayMotion (static / animated), fraction of
   *  detected overlays in each bucket. Null when no overlays. */
  overlay_motion_distribution: Record<OverlayMotion, number> | null;
  /** Distribution across the 3x3 grid for overlay centroids. Null when
   *  no overlays. */
  overlay_region_distribution: Record<FrameRegion, number> | null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function emptyClipDistribution(): Record<ClipType, number> {
  return Object.fromEntries(CLIP_TYPES.map((t) => [t, 0])) as Record<
    ClipType,
    number
  >;
}

/** Compute the aggregate metrics from a list of annotated shots. Pure. */
export function deriveMetrics(
  shots: ReelShot[],
  durationMs: number,
): Omit<ReelAnalysisResult, 'shots'> {
  if (shots.length === 0) {
    return {
      hook_text: null,
      hook_duration_ms: null,
      median_shot_ms: 0,
      cuts_per_sec: 0,
      talking_pct: 0,
      broll_pct: 0,
      text_overlay_pct: 0,
      real_speaker_pct: 0,
      broll_talking_head_pct: 0,
      clip_type_distribution: emptyClipDistribution(),
      face_region_dominant: null,
      face_region_distribution: null,
      face_size_median: null,
      text_region_dominant: null,
      text_region_distribution: null,
      audio_energy_mean: 0,
      audio_energy_std: 0,
      audio_silence_pct: 0,
      voiceover_pct: 0,
      music_pct: 0,
      hook_speech: null,
      sfx_per_min: 0,
      cuts_with_sfx_pct: 0,
      sfx_at_cuts_pct: 0,
      media_overlay_pct: 0,
      overlays_per_min: 0,
      overlay_kind_distribution: null,
      overlay_motion_distribution: null,
      overlay_region_distribution: null,
    };
  }
  const durations = shots.map((s) => s.end_ms - s.start_ms);
  const totalDur = durations.reduce((a, b) => a + b, 0) || durationMs || 1;
  const talkingDur = shots
    .filter((s) => s.has_face)
    .reduce((sum, s) => sum + (s.end_ms - s.start_ms), 0);
  const textShots = shots.filter((s) => s.text_moments.length > 0).length;
  const cuts = Math.max(0, shots.length - 1);
  const realSpeaker = shots.filter(
    (s) => s.speaker_verdict === 'speaker',
  ).length;
  const brollHead = shots.filter(
    (s) => s.speaker_verdict === 'broll',
  ).length;

  const clipDist = emptyClipDistribution();
  for (const s of shots) {
    clipDist[s.clip_type] += (s.end_ms - s.start_ms) / totalDur;
  }

  // Face layout aggregates - face shots only.
  const faceShots = shots.filter((s) => s.face_bbox !== null);
  let faceRegionDominant: FrameRegion | 'mixed' | null = null;
  let faceSizeMedian: number | null = null;
  let faceRegionDistribution: Record<FrameRegion, number> | null = null;
  if (faceShots.length > 0) {
    const regionCounts = Object.fromEntries(
      FRAME_REGIONS.map((r) => [r, 0]),
    ) as Record<FrameRegion, number>;
    for (const s of faceShots) {
      if (s.face_region) regionCounts[s.face_region]++;
    }
    const total = faceShots.length;
    const [topRegion, topCount] = Object.entries(regionCounts).sort(
      ([, a], [, b]) => b - a,
    )[0] as [FrameRegion, number];
    // 9 cells means a strict majority is a strong signal; below that we
    // call it 'mixed' rather than picking a near-tie cell.
    faceRegionDominant = topCount / total > 0.5 ? topRegion : 'mixed';
    faceRegionDistribution = Object.fromEntries(
      FRAME_REGIONS.map((r) => [r, regionCounts[r] / total]),
    ) as Record<FrameRegion, number>;
    const heights = faceShots.map((s) => s.face_bbox?.h ?? 0).sort();
    const mid = Math.floor(heights.length / 2);
    faceSizeMedian =
      heights.length % 2
        ? heights[mid]
        : (heights[mid - 1] + heights[mid]) / 2;
  }

  // Text overlay layout aggregates - count text MOMENTS, not shots. A
  // single long shot may have several text overlays appear in different
  // positions; each contributes a moment to the distribution.
  const allTextMoments = shots.flatMap((s) => s.text_moments);
  let textRegionDominant: FrameRegion | 'mixed' | null = null;
  let textRegionDistribution: Record<FrameRegion, number> | null = null;
  if (allTextMoments.length > 0) {
    const counts = Object.fromEntries(
      FRAME_REGIONS.map((r) => [r, 0]),
    ) as Record<FrameRegion, number>;
    for (const m of allTextMoments) counts[m.region]++;
    const total = allTextMoments.length;
    const [topRegion, topCount] = Object.entries(counts).sort(
      ([, a], [, b]) => b - a,
    )[0] as [FrameRegion, number];
    textRegionDominant = topCount / total > 0.5 ? topRegion : 'mixed';
    textRegionDistribution = Object.fromEntries(
      FRAME_REGIONS.map((r) => [r, counts[r] / total]),
    ) as Record<FrameRegion, number>;
  }

  // Overlay aggregates - count overlay INSTANCES across all shots,
  // mirroring how text aggregates count text moments. A long shot with
  // multiple overlays contributes each one to the distributions.
  const allOverlays = shots.flatMap((s) => s.overlays);
  const shotsWithOverlay = shots.filter((s) => s.overlays.length > 0).length;
  let overlayKindDist: Record<OverlayKind, number> | null = null;
  let overlayMotionDist: Record<OverlayMotion, number> | null = null;
  let overlayRegionDist: Record<FrameRegion, number> | null = null;
  if (allOverlays.length > 0) {
    const k = Object.fromEntries(OVERLAY_KINDS.map((x) => [x, 0])) as Record<
      OverlayKind,
      number
    >;
    const m = Object.fromEntries(OVERLAY_MOTIONS.map((x) => [x, 0])) as Record<
      OverlayMotion,
      number
    >;
    const r = Object.fromEntries(FRAME_REGIONS.map((x) => [x, 0])) as Record<
      FrameRegion,
      number
    >;
    for (const o of allOverlays) {
      k[o.kind]++;
      m[o.motion]++;
      r[o.region]++;
    }
    const n = allOverlays.length;
    for (const key of OVERLAY_KINDS) k[key] /= n;
    for (const key of OVERLAY_MOTIONS) m[key] /= n;
    for (const key of FRAME_REGIONS) r[key] /= n;
    overlayKindDist = k;
    overlayMotionDist = m;
    overlayRegionDist = r;
  }

  // Audio aggregates - duration-weighted across shots.
  let weightedRmsSum = 0;
  let weightedSilenceSum = 0;
  let weightedSpeechSum = 0;
  let weightedMusicSum = 0;
  let totalSfx = 0;
  let cutsWithSfx = 0;
  for (const s of shots) {
    const w = (s.end_ms - s.start_ms) / totalDur;
    weightedRmsSum += s.audio_rms_mean * w;
    weightedSilenceSum += s.audio_silence_pct * w;
    weightedSpeechSum += s.audio_speech_pct * w;
    weightedMusicSum += s.audio_music_pct * w;
    totalSfx += s.sfx_count;
    if (s.sfx_at_start) cutsWithSfx++;
  }
  const sfxPerMin = totalDur > 0 ? (totalSfx * 60_000) / totalDur : 0;
  const cutsWithSfxPct = cutsWithSfx / shots.length;
  const audioEnergyMean = weightedRmsSum;
  // Std of per-shot RMS (unweighted) — a usable dynamic-range proxy.
  const rmsValues = shots.map((s) => s.audio_rms_mean);
  const rmsAvg =
    rmsValues.reduce((a, b) => a + b, 0) / Math.max(rmsValues.length, 1);
  const audioEnergyStd = Math.sqrt(
    rmsValues.reduce((acc, v) => acc + (v - rmsAvg) ** 2, 0) /
      Math.max(rmsValues.length, 1),
  );

  const hook = shots[0];
  return {
    hook_text: hook.ocr_text,
    hook_duration_ms: hook.end_ms - hook.start_ms,
    median_shot_ms: median(durations),
    cuts_per_sec: durationMs > 0 ? cuts / (durationMs / 1000) : 0,
    talking_pct: talkingDur / totalDur,
    broll_pct: 1 - talkingDur / totalDur,
    text_overlay_pct: textShots / shots.length,
    real_speaker_pct: realSpeaker / shots.length,
    broll_talking_head_pct: brollHead / shots.length,
    clip_type_distribution: clipDist,
    face_region_dominant: faceRegionDominant,
    face_region_distribution: faceRegionDistribution,
    face_size_median: faceSizeMedian,
    text_region_dominant: textRegionDominant,
    text_region_distribution: textRegionDistribution,
    audio_energy_mean: audioEnergyMean,
    audio_energy_std: audioEnergyStd,
    audio_silence_pct: weightedSilenceSum,
    voiceover_pct: weightedSpeechSum,
    music_pct: weightedMusicSum,
    // hook_speech filled in by analyzeReel (deriveMetrics is pure).
    hook_speech: null,
    sfx_per_min: sfxPerMin,
    cuts_with_sfx_pct: cutsWithSfxPct,
    // Filled in by analyzeReel - deriveMetrics can't see the raw events.
    sfx_at_cuts_pct: 0,
    media_overlay_pct: shotsWithOverlay / shots.length,
    overlays_per_min:
      totalDur > 0 ? (allOverlays.length * 60_000) / totalDur : 0,
    overlay_kind_distribution: overlayKindDist,
    overlay_motion_distribution: overlayMotionDist,
    overlay_region_distribution: overlayRegionDist,
  };
}

/**
 * Run the analysis pipeline on a streamable video URL.
 *
 * Pipeline: ffmpeg scene detection -> real shot boundaries -> one
 * representative frame per shot (face detection) -> Light-ASD speaker
 * detection per shot -> OCR each -> derive aggregate metrics.
 */
export async function analyzeReel(
  input: ReelAnalysisInput,
): Promise<ReelAnalysisResult> {
  if (input.durationMs <= 0) {
    return { shots: [], ...deriveMetrics([], 0) };
  }
  console.error('[analyze] start, duration', input.durationMs, 'ms');
  const shots = await detectScenes(input.playableUrl, input.durationMs);
  console.error('[analyze] detected', shots.length, 'shots');
  // Multi-frame sampling: each shot gets several candidate timestamps and
  // we pick the rep frame with the best face detection. We bump samples
  // to 5 here so the first and last samples are spread far enough apart
  // (~17% to ~83% of the shot) to expose motion for the paired-frame
  // captioner — start/end of three samples is too close together for
  // longer shots to show clear motion.
  const shotFrames = await extractShotFrames(input.playableUrl, shots, {
    samplesPerShot: 5,
  });
  const reps = shotFrames.map((sf) => sf.rep);
  const facesFound = reps.filter((r) => r?.face != null).length;
  console.error(
    '[analyze] extracted',
    reps.filter(Boolean).length,
    'of',
    shots.length,
    'rep frames (',
    facesFound,
    'with face)',
  );

  // Speaker detection (SyncNet) - best-effort; never aborts the pipeline.
  // Pass the rep-frame face flags so no-face shots skip the heavy work.
  let speaker: ShotSpeakerInfo[];
  try {
    const hasFaceHints = reps.map((r) => r?.face != null);
    speaker = await detectSpeaker(input.playableUrl, shots, hasFaceHints);
  } catch (err) {
    console.error(
      '[analyze] speaker detection failed:',
      err instanceof Error ? err.message : String(err),
    );
    speaker = shots.map(() => ({
      verdict: 'unknown' as const,
      confidence: 0,
      sync_conf: 0,
    }));
  }
  console.error('[analyze] speaker detection done');

  // Audio extraction + VAD + SFX + per-shot metrics. Best-effort
  // throughout; never aborts the pipeline. VAD/SFX failures degrade
  // gracefully to RMS-only and zero-SFX respectively.
  const audioFallback: ShotAudio[] = shots.map(() => ({
    rms_mean: 0,
    peak_rms: 0,
    silence_pct: 1,
    speech_pct: 0,
    music_pct: 0,
  }));
  let shotAudio: ShotAudio[] = audioFallback;
  let shotSfx: ShotSfx[] = shots.map(() => ({
    sfx_count: 0,
    sfx_at_start: false,
  }));
  let sfxClassificationsPerShot: SfxClassifiedEvent[][] = shots.map(
    () => [],
  );
  let sfxAtCutsPct = 0;
  let hookSpeech: string | null = null;
  let transcriptWords: import('./transcribe').TranscriptWord[] = [];
  try {
    const samples = await extractReelAudio(input.playableUrl);
    if (samples) {
      let speechMask: boolean[] | undefined;
      try {
        const probs = await runVAD(samples);
        if (probs) {
          speechMask = speechMaskFromProbs(probs);
          const speechFrames = speechMask.filter(Boolean).length;
          console.error(
            '[vad] ran on',
            probs.length,
            'frames;',
            speechFrames,
            'flagged as speech',
          );
        }
      } catch (err) {
        console.error(
          '[vad] failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      shotAudio = audioMetricsForShots(samples, shots, speechMask);
      console.error(
        '[audio] extracted',
        samples.length,
        'samples; per-shot metrics done',
      );

      // Full-reel transcription via Whisper verbose_json. One API call
      // gives us both the hook (derived slice of the first ~5s of
      // words) and the word-level timestamps we use to annotate each
      // detected media overlay with what was being said while it was
      // on screen. Best-effort — returns null when no OPENAI_API_KEY.
      try {
        const transcript = await transcribeReel(samples);
        if (transcript) {
          transcriptWords = transcript.words;
          hookSpeech = transcript.hook.length > 0 ? transcript.hook : null;
          if (hookSpeech) {
            console.error(
              '[hook-speech]',
              `"${hookSpeech.replace(/\s+/g, ' ').slice(0, 80)}"`,
            );
          }
          console.error(
            '[transcribe] reel transcript:',
            transcript.words.length,
            'words',
          );
        }
      } catch (err) {
        console.error(
          '[transcribe] reel transcription failed:',
          err instanceof Error ? err.message : String(err),
        );
      }

      try {
        const sfxEvents = detectSfxOnsets(samples, speechMask);
        shotSfx = shotSfxMetrics(sfxEvents, shots);
        sfxAtCutsPct = sfxAtCutsRatio(sfxEvents, shots);
        console.error(
          '[sfx] detected',
          sfxEvents.length,
          'onsets;',
          (sfxAtCutsPct * 100).toFixed(0) + '% land near a cut',
        );

        // Acoustic-type classification for each detected onset. Replaces
        // the earlier identity-matching attempts (MFCC-cosine, Shazam-
        // hash) — both failed on impulse SFX layered under voiceover.
        // Type classification is robust to mixing and is what downstream
        // (autocut + script-gen) actually needs.
        sfxClassificationsPerShot = shots.map(() => []);
        let classifiedEvents = 0;
        for (let s = 0; s < shots.length; s++) {
          const shot = shots[s];
          const eventsInShot = sfxEvents.filter(
            (e) => e.ms >= shot.start_ms && e.ms < shot.end_ms,
          );
          const perEvent: SfxClassifiedEvent[] = [];
          for (const ev of eventsInShot) {
            const cls = classifyOnset(samples, ev.ms);
            if (cls) {
              perEvent.push({
                ms: ev.ms,
                type: cls.type,
                confidence: cls.confidence,
                features: cls.features,
              });
              classifiedEvents++;
            }
          }
          sfxClassificationsPerShot[s] = perEvent;
        }
        console.error(
          '[sfx-classify] classified',
          classifiedEvents,
          'of',
          sfxEvents.length,
          'onsets',
        );
      } catch (err) {
        console.error(
          '[sfx] failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      console.error('[audio] extraction returned no samples');
    }
  } catch (err) {
    console.error(
      '[audio] failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  const annotated = await annotateShots(
    shotFrames,
    shots,
    speaker,
    shotAudio,
    shotSfx,
    sfxClassificationsPerShot,
  );
  console.error('[analyze] annotation done');

  // Per-shot spoken_window: every shot gets the transcript text that
  // played during its [start_ms, end_ms]. This is the glue the
  // synthesis engine needs — for a target line, find the best-matching
  // shot from the collection by comparing its visual_caption against
  // shots whose spoken_window covers a similar topic.
  if (transcriptWords.length > 0) {
    for (const shot of annotated) {
      shot.spoken_window = spokenWindow(
        transcriptWords,
        shot.start_ms,
        shot.end_ms,
      );
      for (const ov of shot.overlays) {
        ov.spoken_window = spokenWindow(
          transcriptWords,
          ov.start_ms,
          ov.end_ms,
        );
      }
    }
    const shotsWithSpoken = annotated.filter(
      (s) => s.spoken_window.length > 0,
    ).length;
    console.error(
      '[transcribe] mapped transcript onto',
      shotsWithSpoken,
      'of',
      annotated.length,
      'shots',
    );
  }

  // Per-shot motion-aware caption via OpenAI vision. We pass the
  // FIRST and LAST sample frames so the LLM can describe in-shot
  // motion (zoom, pan, scroll) instead of treating every shot as a
  // static moment. Falls back to single-frame caption when only one
  // sample is available. Returns all-null when no OPENAI_API_KEY.
  try {
    const captionInputs: (ShotFramesForCaption | null)[] = shotFrames.map(
      (sf) => {
        const valid = sf.samples.filter(
          (s): s is NonNullable<typeof s> => s !== null && !!s.jpegBase64,
        );
        if (valid.length === 0) {
          // Last resort: try the rep frame alone.
          if (sf.rep?.jpegBase64) {
            return { start: sf.rep.jpegBase64, end: sf.rep.jpegBase64 };
          }
          return null;
        }
        const first = valid[0].jpegBase64;
        const last = valid[valid.length - 1].jpegBase64;
        return { start: first, end: last };
      },
    );
    const captions = await captionShots(captionInputs);
    let filled = 0;
    for (let i = 0; i < annotated.length; i++) {
      annotated[i].visual_caption = captions[i] ?? null;
      if (captions[i]) filled++;
    }
    if (filled > 0) {
      console.error(
        '[shot-caption] captioned',
        filled,
        'of',
        annotated.length,
        'shots (motion-aware)',
      );
    }
  } catch (err) {
    console.error(
      '[shot-caption] batch failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  const metrics = deriveMetrics(annotated, input.durationMs);
  // deriveMetrics can't see the raw event list or the transcription
  // result, so we fill those in here.
  metrics.sfx_at_cuts_pct = sfxAtCutsPct;
  metrics.hook_speech = hookSpeech;
  return { shots: annotated, ...metrics };
}
