// Content vocabulary: flat catalogue of shots from content-tagged
// reels, indexed for retrieval by the synthesis engine.
//
// For each shot in a content-tagged reel we capture WHAT was shown
// (visual_caption) and WHAT was being said when it was shown
// (spoken_window). The synthesis engine queries this catalogue with
// "given target line X, which of these shots fits best?" — using an
// LLM ranker over the (caption, spoken_window) pairs.
import type {
  ClipType,
  FrameRegion,
  MediaOverlay,
  TextMoment,
} from './types';
import type { LibraryReel } from './library';

export interface ContentShot {
  /** Source reel URL — surfaces in suggestions so the user can trace
   *  "this idea came from <that reel> at <that timestamp>". */
  source_url: string;
  shot_idx: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  clip_type: ClipType;
  has_face: boolean;
  face_region: FrameRegion | null;
  /** Vision-LLM one-sentence description of the shot. Null when
   *  captioning was unavailable (no API key / call failed). */
  visual_caption: string | null;
  /** Transcript words playing during the shot. Empty when no
   *  transcript. */
  spoken_window: string;
  /** OCR'd text overlays present on the shot's rep frame. */
  ocr_text: string | null;
  text_moments: TextMoment[];
  overlays: MediaOverlay[];
}

export interface ContentVocabulary {
  shots: ContentShot[];
  /** Reels contributing to this vocabulary (URLs only). */
  source_reels: string[];
}

/** Build a content vocabulary from content-tagged reels. Each reel
 *  must have analysis populated (call hydrateLibrary first). */
export function buildContentVocabulary(
  reels: LibraryReel[],
): ContentVocabulary {
  const shots: ContentShot[] = [];
  const source_reels: string[] = [];
  for (const reel of reels) {
    if (!reel.analysis) continue;
    source_reels.push(reel.url);
    for (let i = 0; i < reel.analysis.shots.length; i++) {
      const s = reel.analysis.shots[i];
      shots.push({
        source_url: reel.url,
        shot_idx: i,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        duration_ms: s.end_ms - s.start_ms,
        clip_type: s.clip_type,
        has_face: s.has_face,
        face_region: s.face_region,
        visual_caption: s.visual_caption,
        spoken_window: s.spoken_window,
        ocr_text: s.ocr_text,
        text_moments: s.text_moments,
        overlays: s.overlays,
      });
    }
  }
  return { shots, source_reels };
}

/** Compact one-line summary of a content shot for prompts. The
 *  synthesis engine feeds N of these to an LLM and asks which
 *  matches the target spoken line best. */
export function summarizeShot(shot: ContentShot, idx: number): string {
  const parts: string[] = [];
  parts.push(`[${idx}] ${shot.clip_type}`);
  parts.push(`${(shot.duration_ms / 1000).toFixed(1)}s`);
  if (shot.visual_caption) parts.push(`visual="${shot.visual_caption}"`);
  if (shot.spoken_window) {
    parts.push(`spoken="${shot.spoken_window.slice(0, 120)}"`);
  }
  if (shot.ocr_text) {
    parts.push(`onscreen_text="${shot.ocr_text.slice(0, 60)}"`);
  }
  return parts.join(' | ');
}
