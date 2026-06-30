import React, { useEffect, useState } from 'react';
import type {
  SuggestedEdit,
  CurationResult,
  ShotPlan,
  ShotCuration,
} from './global';
import { ReelMockup, resolveShotRender, getSelections } from './App';

/** The payload the main process injects (via window.__exportSetJob) before
 *  driving the frame loop. targetVideoUrl is a renderer-loadable URL for the
 *  creator/narration video (local-video:// etc) or null. */
export interface ExportJob {
  plan: SuggestedEdit;
  curation: CurationResult | null;
  targetVideoUrl: string | null;
  fps: number;
}

// Imperative bridge state. The main process calls window.__exportRenderFrame(T)
// over executeJavaScript; React state changes are async, so we keep the live
// values in module scope and force a re-render, then await a settle() that
// waits for the DOM + videos + images to reflect the new timeline position.
let job: ExportJob | null = null;
let currentT = 0;
let forceRerender: () => void = () => {};
// One-shot: document.fonts.ready only needs to resolve once per export.
let fontsReady = false;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Wait until the freshly-rendered frame is fully painted and stable:
 *  React has committed (2 rAFs), every <video> has finished seeking and has
 *  decodable data, and every <img> has loaded. Capped so a stuck remote
 *  asset can't hang the whole export. */
async function settle(): Promise<void> {
  await nextFrame();
  await nextFrame();
  // The matched caption font is injected async (getFontDataUrl IPC); wait so
  // early frames don't capture in the fallback face. Only needs to resolve
  // once per export — awaiting it on every frame added needless latency.
  if (!fontsReady) {
    try {
      await document.fonts.ready;
    } catch {
      /* fonts API unavailable — proceed */
    }
    fontsReady = true;
  }
  const root = document.getElementById('root');
  if (!root) return;
  for (let i = 0; i < 90; i++) {
    const videos = Array.from(root.querySelectorAll('video'));
    const images = Array.from(root.querySelectorAll('img'));
    const videosReady = videos.every((v) => !v.seeking && v.readyState >= 2);
    const imagesReady = images.every((img) => img.complete);
    if (videosReady && imagesReady) break;
    await new Promise((r) => setTimeout(r, 16));
  }
  await nextFrame();
}

/** Map an absolute timeline ms to the active shot, the curation for it, the
 *  active pick, and the local time fed to ReelMockup (which mirrors how the
 *  live PhoneSidebar preview drives a single shot). */
function frameProps(j: ExportJob, T: number): {
  mockupShot: ShotPlan;
  previewSrc: string | null;
  previewKind: ReturnType<typeof resolveShotRender>['previewKind'];
  previewVideoMode: ReturnType<typeof resolveShotRender>['previewVideoMode'];
  previewPlaybackStartMs: ReturnType<typeof resolveShotRender>['previewPlaybackStartMs'];
  previewPlaybackEndMs: ReturnType<typeof resolveShotRender>['previewPlaybackEndMs'];
  layeredPreviewMedia: ReturnType<typeof resolveShotRender>['layeredPreviewMedia'];
  renderTimeMs: number;
  shotStartMs: number;
  shotEndMs: number;
} {
  const shots = j.plan.shots ?? [];
  const shot =
    shots.find((s) => T >= s.start_ms && T < s.end_ms) ??
    shots[shots.length - 1];
  const curationForShot: ShotCuration | null =
    j.curation?.shots.find(
      (c) => c != null && c.shot_idx === shot.shot_idx,
    ) ?? null;
  const picks = getSelections(shot);
  const pickDurationMs =
    picks.length > 0
      ? Math.max(250, Math.round(shot.duration_ms / picks.length))
      : 0;
  const localT = Math.max(0, T - shot.start_ms);
  const placement = shot.options[0]?.placement ?? shot.placement;
  const isOverlayLayout = placement.fit === 'pip';
  const pickIdx =
    picks.length > 1 && !isOverlayLayout
      ? Math.min(Math.floor(localT / pickDurationMs), picks.length - 1)
      : 0;
  const {
    mockupShot,
    previewSrc,
    previewKind,
    previewVideoMode,
    previewPlaybackStartMs,
    previewPlaybackEndMs,
    layeredPreviewMedia,
  } = resolveShotRender(
    shot,
    curationForShot,
    0,
    pickIdx,
  );
  const pickLocalT = isOverlayLayout ? localT : localT - pickIdx * pickDurationMs;
  const renderTimeMs = mockupShot.start_ms + pickLocalT;
  return {
    mockupShot,
    previewSrc,
    previewKind,
    previewVideoMode,
    previewPlaybackStartMs,
    previewPlaybackEndMs,
    layeredPreviewMedia,
    renderTimeMs,
    shotStartMs: shot.start_ms,
    shotEndMs: shot.end_ms,
  };
}

export function RenderStage(): React.JSX.Element {
  const [, setTick] = useState(0);
  forceRerender = () => setTick((t) => t + 1);

  useEffect(() => {
    document.body.classList.add('render-mode');
    const w = window as unknown as Record<string, unknown>;
    w.__exportSetJob = (incoming: ExportJob) => {
      job = incoming;
      fontsReady = false;
      forceRerender();
    };
    w.__exportRenderFrame = async (T: number): Promise<boolean> => {
      currentT = T;
      forceRerender();
      await settle();
      return true;
    };
    // Total reel length so main knows how many frames to grab.
    w.__exportTotalDurationMs = () => job?.plan.total_duration_ms ?? 0;
    w.__exportReady = true;
    return () => {
      document.body.classList.remove('render-mode');
    };
  }, []);

  if (!job || !(job.plan.shots ?? []).length) {
    return <div className="export-root export-root-empty" />;
  }

  const {
    mockupShot,
    previewSrc,
    previewKind,
    previewVideoMode,
    previewPlaybackStartMs,
    previewPlaybackEndMs,
    layeredPreviewMedia,
    renderTimeMs,
    shotStartMs,
    shotEndMs,
  } = frameProps(job, currentT);

  return (
    <div className="export-root">
      <ReelMockup
        shot={mockupShot}
        previewImageUrl={previewSrc}
        previewKind={previewKind}
        previewVideoMode={previewVideoMode}
        previewPlaybackStartMs={previewPlaybackStartMs}
        previewPlaybackEndMs={previewPlaybackEndMs}
        layeredPreviewMedia={layeredPreviewMedia}
        subtitleSpec={job.plan.subtitle_spec ?? null}
        targetVideoUrl={job.targetVideoUrl}
        reelPlayback
        renderTimeMs={renderTimeMs}
        // Caption runs on the global frame time + real shot bounds so a
        // multi-media shot doesn't restart the caption per pick.
        captionTimeMs={currentT}
        captionShotStartMs={shotStartMs}
        captionShotEndMs={shotEndMs}
      />
    </div>
  );
}
