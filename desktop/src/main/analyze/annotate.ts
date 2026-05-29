import type { ShotAudio } from './audio';
import type { ExtractedFrame, ShotFrames } from './frame-extractor';
import { recognizeText } from './ocr';
import { detectOverlays } from './overlays';
import type { Shot } from './scene-detect';
import type { ShotSpeakerInfo, SpeakerVerdict } from './speaker';
import type { ShotSfx } from './sfx';
import type { SfxClassifiedEvent, MediaOverlay } from './types';
import type {
  ClipType,
  FrameRegion,
  NormBBox,
  ReelShot,
  TextMoment,
} from './types';

/** Below this duration we don't multi-sample OCR — the sampled frames
 *  would be near-identical and OCR is the dominant cost. */
const OCR_MULTI_SAMPLE_MIN_MS = 2000;

/** Map a normalized centroid (x,y in [0,1]) to one of 9 grid cells. */
export function regionForXY(x: number, y: number): FrameRegion {
  const row: 'top' | 'middle' | 'bottom' =
    y < 1 / 3 ? 'top' : y < 2 / 3 ? 'middle' : 'bottom';
  const col: 'left' | 'center' | 'right' =
    x < 1 / 3 ? 'left' : x < 2 / 3 ? 'center' : 'right';
  return `${row}_${col}` as FrameRegion;
}

/** Normalize a face bbox by frame dimensions. Coords may be slightly
 *  negative or exceed 1 when an edge-framed face extends past the visible
 *  frame — that's accurate, not a bug, and consumers should handle it. */
function normalizeBBox(
  box: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): NormBBox {
  return {
    x: box.x / width,
    y: box.y / height,
    w: box.w / width,
    h: box.h / height,
  };
}

/** Pure derivation: underlying-video category from face presence + speaker
 *  verdict. Text overlay is orthogonal (carried in ocr_text), not part of
 *  the clip type.
 *
 *  The rep frame is the BEST face detection from multi-frame sampling
 *  (see extractShotFrames), so hasFace=true is a strong signal. We trust
 *  it over speaker_verdict='no_face' — the latter only means face-crops
 *  bailed in its 2.5s window (motion blur, brief occlusion), not that
 *  there's no face. A bailed-face-crops shot is still a face shot;
 *  we just couldn't compute sync, so the verdict is 'unknown'-shaped. */
export function classifyClipType(
  hasFace: boolean,
  speakerVerdict: SpeakerVerdict,
): ClipType {
  if (!hasFace) {
    return 'broll_visual';
  }
  switch (speakerVerdict) {
    case 'speaker':
      return 'talking_head';
    case 'broll':
      return 'broll_talking_head';
    case 'no_face':
      // Multi-frame rep saw a face; SyncNet face-crops bailed. Face shot
      // of unknown speaker status.
      return 'talking_head_unknown';
    default:
      return 'talking_head_unknown';
  }
}

/** Multi-frame OCR: run recognition on every sampled frame in the shot
 *  (with a duration gate to skip near-identical short-shot samples), and
 *  collect every detected text moment + the longest text string. */
async function ocrShotMoments(
  shotFrames: ShotFrames,
  shotDurationMs: number,
): Promise<{ ocrText: string | null; moments: TextMoment[] }> {
  const candidates: ExtractedFrame[] = [];
  if (
    shotDurationMs < OCR_MULTI_SAMPLE_MIN_MS ||
    shotFrames.samples.length === 0
  ) {
    if (shotFrames.rep) candidates.push(shotFrames.rep);
  } else {
    for (const f of shotFrames.samples) if (f) candidates.push(f);
  }

  const moments: TextMoment[] = [];
  let longest = '';
  for (const frame of candidates) {
    if (!frame.jpegBase64) continue;
    try {
      const ocr = await recognizeText(frame.jpegBase64);
      if (ocr.text.length > longest.length) longest = ocr.text;
      if (frame.width <= 0 || frame.height <= 0) continue;
      // One TextMoment PER LINE — preserves per-region accuracy so the
      // downstream text_region_distribution and overlay-exclusion both
      // see where each text block actually sits, instead of an
      // envelope union that spans the whole frame.
      for (const line of ocr.lines) {
        const bbox = normalizeBBox(line.bbox, frame.width, frame.height);
        const region = regionForXY(
          bbox.x + bbox.w / 2,
          bbox.y + bbox.h / 2,
        );
        moments.push({ text: line.text, bbox, region });
      }
    } catch {
      // skip a bad frame, keep going
    }
  }
  return {
    ocrText: longest.length > 0 ? longest : null,
    moments,
  };
}

/**
 * Annotate each shot with face presence, OCR text, and speaker verdict.
 * `shotFrames` and `speaker` are both aligned 1:1 with `shots`. The shot
 * frame's `rep` carries face/clip-type signals; its `samples` get OCRed
 * for multi-moment text detection (text overlays often swap mid-shot).
 */
export async function annotateShots(
  shotFrames: ShotFrames[],
  shots: Shot[],
  speaker: ShotSpeakerInfo[],
  audio: ShotAudio[],
  sfx: ShotSfx[],
  sfxClassificationsPerShot: SfxClassifiedEvent[][],
): Promise<ReelShot[]> {
  const out: ReelShot[] = [];
  for (let i = 0; i < shots.length; i++) {
    const sf = shotFrames[i];
    const rep = sf?.rep ?? null;
    const dur = shots[i].end_ms - shots[i].start_ms;
    const { ocrText, moments } = await ocrShotMoments(
      sf ?? { rep: null, samples: [] },
      dur,
    );
    const sp = speaker[i];
    const ad =
      audio[i] ??
      ({
        rms_mean: 0,
        peak_rms: 0,
        silence_pct: 1,
        speech_pct: 0,
        music_pct: 0,
      } as const);
    const sx = sfx[i] ?? { sfx_count: 0, sfx_at_start: false };
    const sxClassifications = sfxClassificationsPerShot[i] ?? [];
    const hasFace = rep?.face != null;
    const verdict = sp?.verdict ?? 'unknown';
    let face_bbox: NormBBox | null = null;
    let face_region: FrameRegion | null = null;
    if (rep?.face && rep.width > 0 && rep.height > 0) {
      face_bbox = normalizeBBox(rep.face.box, rep.width, rep.height);
      face_region = regionForXY(
        face_bbox.x + face_bbox.w / 2,
        face_bbox.y + face_bbox.h / 2,
      );
    }
    // Overlay detection runs after face/OCR for this shot so we can
    // pass the face bbox and text moments in as exclusion zones. Pure
    // best-effort: failures degrade to an empty list, never throw.
    let overlays: MediaOverlay[] = [];
    try {
      overlays = detectOverlays({
        shot: shots[i],
        shotFrames: sf ?? { rep: null, samples: [] },
        faceBbox: face_bbox,
        textMoments: moments,
      });
    } catch (err) {
      console.error(
        '[overlays] shot',
        i,
        'failed:',
        err instanceof Error ? err.message : String(err),
      );
    }

    out.push({
      start_ms: shots[i].start_ms,
      end_ms: shots[i].end_ms,
      has_face: hasFace,
      ocr_text: ocrText,
      speaker_verdict: verdict,
      speaker_confidence: sp?.confidence ?? 0,
      sync_conf: sp?.sync_conf ?? 0,
      clip_type: classifyClipType(hasFace, verdict),
      face_bbox,
      face_region,
      text_moments: moments,
      audio_rms_mean: ad.rms_mean,
      audio_peak_rms: ad.peak_rms,
      audio_silence_pct: ad.silence_pct,
      audio_speech_pct: ad.speech_pct,
      audio_music_pct: ad.music_pct,
      sfx_count: sx.sfx_count,
      sfx_at_start: sx.sfx_at_start,
      sfx_classifications: sxClassifications,
      overlays,
      // Captions + spoken_window are filled in by analyze.ts after
      // this pass (they need the rep frame batched + the full reel
      // transcript respectively, neither of which annotate.ts owns).
      visual_caption: null,
      spoken_window: '',
    });
  }
  return out;
}
