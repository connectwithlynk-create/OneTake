// Auto-curate the media overlays the plan assigned (from the overlay
// pattern) into REAL web-sourced assets — no AI generation, web only.
//
// Synthesis decides per shot whether it has_overlay and, when true, fills
// additional_elements (sticker / logo / reaction GIF / emoji burst, each
// subject-aware and placed per the detected overlay PATTERN). This pass
// resolves each of those layers to an actual image/GIF URL by searching
// the web and pulling a real image off the result page — so the overlay
// shows as the genuine asset in the preview instead of a placeholder.
//
// Best-effort: anything that can't be sourced (or the kinds that aren't
// web assets — face_cam is the creator's own webcam) is left unresolved
// and renders as the dashed placeholder. Never throws.
import { tavilySearch, fetchPage } from './tools';
import type { SceneElement, SceneElementKind } from '../analyze/synthesize';

/** Overlay kinds that ARE real web assets we can source. face_cam (the
 *  creator's own camera), lower_third (an editor-drawn text bar) and
 *  'other' aren't web-sourceable, so we skip them. */
const SOURCEABLE: ReadonlySet<SceneElementKind> = new Set([
  'sticker',
  'logo',
  'reaction_gif',
  'emoji_burst',
]);

/** Build a web-image search query from the element's subject-aware
 *  description plus a kind hint that biases toward a transparent asset. */
function queryFor(el: SceneElement): string {
  const desc = el.description.replace(/\s+/g, ' ').trim();
  switch (el.kind) {
    case 'logo':
      return `${desc} logo transparent png`;
    case 'reaction_gif':
      return `${desc} reaction gif`;
    case 'emoji_burst':
      return `${desc} emoji png`;
    case 'sticker':
      return `${desc} sticker png`;
    default:
      return desc;
  }
}

interface PageImage {
  url: string;
  alt: string | null;
  width: number;
  height: number;
}

/** Pick the best real image off a page for this overlay kind. GIF kinds
 *  prefer an animated .gif; everything else prefers the largest non-icon
 *  raster (PNG/SVG/JPG) so we don't grab a 16px favicon. */
function pickImage(images: PageImage[], kind: SceneElementKind): PageImage | null {
  const withUrl = images.filter((im) => !!im.url);
  if (withUrl.length === 0) return null;
  // GIF kinds want a real animated .gif when the page has one.
  if (kind === 'reaction_gif') {
    const gif = withUrl.find((im) => /\.gif(\?|#|$)/i.test(im.url));
    if (gif) return gif;
  }
  // Otherwise prefer a sizeable PNG (transparent-friendly for logos /
  // stickers / emoji), then fall back to the largest raster — skipping
  // tiny favicons / tracking pixels.
  const scored = withUrl
    .map((im) => {
      const area = Math.max(0, im.width) * Math.max(0, im.height);
      const isPng = /\.png(\?|#|$)/i.test(im.url) ? 1 : 0;
      const bigEnough = area >= 64 * 64 ? 1 : 0;
      return { im, rank: bigEnough * 1000 + isPng * 100 + Math.min(area / 1e4, 90) };
    })
    .filter((s) => s.rank > 0)
    .sort((a, b) => b.rank - a.rank);
  return scored.length ? scored[0].im : null;
}

/** Resolve one overlay element to a real asset. Returns the element with
 *  resolved_url / resolved_source_page filled in, or unchanged when the
 *  kind isn't sourceable or nothing was found. */
async function resolveElement(
  el: SceneElement,
  signal?: AbortSignal,
): Promise<SceneElement> {
  if (signal?.aborted || !SOURCEABLE.has(el.kind) || !el.description.trim()) {
    return el;
  }
  try {
    const search = await tavilySearch(queryFor(el), 4);
    if (search.blocked || search.results.length === 0) return el;
    for (const r of search.results.slice(0, 3)) {
      if (signal?.aborted) return el;
      const page = await fetchPage(r.url, { expectedContent: el.description });
      if (!('images' in page) || page.images.length === 0) continue;
      const img = pickImage(page.images, el.kind);
      if (img) {
        return {
          ...el,
          resolved_url: img.url,
          resolved_source_page: page.url,
        };
      }
    }
  } catch (err) {
    console.error(
      '[overlay-curate] resolve failed for',
      el.kind,
      err instanceof Error ? err.message : String(err),
    );
  }
  return el;
}

/** Resolve every overlay layer of a shot to real web media. Sequential —
 *  a shot has at most 3 layers and each launches a browser fetch, so
 *  concurrency here buys little and risks rate limits. */
export async function resolveShotOverlays(
  elements: SceneElement[],
  signal?: AbortSignal,
): Promise<SceneElement[]> {
  const out: SceneElement[] = [];
  for (const el of elements) {
    out.push(await resolveElement(el, signal));
  }
  return out;
}
