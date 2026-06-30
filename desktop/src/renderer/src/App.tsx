import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentTrace,
  AgentTurn,
  AlternativeShot,
  AnalyzeHistoryEntry,
  SfxCollectionPattern,
  SfxType,
  CaptionTreatment,
  ClipType,
  Collection,
  CurationResult,
  CuratorClarificationRequest,
  CuratorTurnEvent,
  EditingBrief,
  EditContractValidation,
  ExportProgressEvent,
  ExportReelResponse,
  ExtractClipsResponse,
  ExtractProgressEvent,
  ExtractedClip,
  FrameRegion,
  AnimationEasing,
  CameraMotionKind,
  SceneAnimation,
  LibraryReel,
  MediaCandidate,
  PastedMediaEntry,
  PlanListEntry,
  RecordPageResponse,
  RecordProgressEvent,
  ReelAnalysisResult,
  ReelTag,
  RemixProfile,
  ResolvedReel,
  ResolveResult,
  ScreenshotPageResponse,
  ScreenshotProgressEvent,
  SelectedMedia,
  ShotCuration,
  ShotOption,
  ShotOptionTier,
  ShotPlan,
  StructureSection,
  SubtitleSpec,
  SuggestedEdit,
  SynthesizeProgress,
  TargetInput,
  VideoFrame,
  VideoFrameProgressEvent,
  VideoFramesResponse,
} from './global';
import { subtitleTextForShot } from './subtitles';
import {
  MIN_SHOT_MS,
  alignShotEndsToTranscript,
  snapBoundaryToTranscript,
  splitAdjacentShotsAtTranscriptBoundary,
} from './shot-timing';

type ViewMode = 'workflow' | 'analyze';

/** Canvas composition for a shot's b-roll (aspect / fit / position /
 *  scale). Derived from the already-imported ShotOption so it always
 *  matches the source-of-truth shape without a separate import. */
type BrollPlacement = ShotOption['placement'];

/** Outcome of an "add clip" request, so the panel can report whether a
 *  new clip actually landed (vs. found-but-already-present vs. error). */
type AddClipResult =
  | { ok: false }
  | { ok: true; added: number; foundButDuplicate?: boolean };

function normalizeContractValue(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function validatePlanContractLocal(
  plan: SuggestedEdit,
): EditContractValidation | null {
  const contract = plan.edit_contract;
  if (!contract) return plan.contract_validation ?? null;
  const issues: EditContractValidation['issues'] = [];
  let total = 0;
  let passed = 0;
  const check = (ok: boolean): void => {
    total++;
    if (ok) passed++;
  };
  const warn = (
    rule_id: string,
    message: string,
    expected?: string,
    actual?: string,
    shot_idx?: number,
  ): void => {
    issues.push({
      severity: 'warning',
      rule_id,
      message,
      expected,
      actual,
      shot_idx,
    });
  };
  const checkSame = (
    rule_id: string,
    expected: string,
    actual: string,
    message: string,
    shot_idx?: number,
  ): void => {
    const ok = normalizeContractValue(expected) === normalizeContractValue(actual);
    check(ok);
    if (!ok) warn(rule_id, message, expected, actual, shot_idx);
  };

  check(plan.shots.length === contract.shots.length);
  if (plan.shots.length !== contract.shots.length) {
    issues.push({
      severity: 'error',
      rule_id: 'shot_count',
      message: 'Shot count drifted from the edit contract.',
      expected: String(contract.shots.length),
      actual: String(plan.shots.length),
    });
  }

  const expectedDuration = contract.shots[contract.shots.length - 1]?.end_ms ?? 0;
  if (expectedDuration > 0) {
    const ok = Math.abs(plan.total_duration_ms - expectedDuration) <= 1200;
    check(ok);
    if (!ok) {
      warn(
        'duration',
        'Total duration drifted by more than 1.2s.',
        `${expectedDuration}ms`,
        `${plan.total_duration_ms}ms`,
      );
    }
  }

  const byIdx = new Map(plan.shots.map((shot) => [shot.shot_idx, shot]));
  for (const expected of contract.shots) {
    const shot = byIdx.get(expected.shot_idx);
    check(!!shot);
    if (!shot) {
      issues.push({
        severity: 'error',
        rule_id: 'shot_present',
        shot_idx: expected.shot_idx,
        message: 'Contract shot is missing from the plan.',
      });
      continue;
    }
    checkSame(
      'structure_role',
      expected.structure_role,
      shot.structure_role,
      'Structure role no longer matches the contract.',
      shot.shot_idx,
    );
    checkSame(
      'layout_fit',
      expected.layout.fit,
      shot.placement.fit,
      'Layout fit no longer matches the contract.',
      shot.shot_idx,
    );
    checkSame(
      'layout_position',
      expected.layout.position,
      shot.placement.position,
      'Layout position no longer matches the contract.',
      shot.shot_idx,
    );
    checkSame(
      'source_method',
      expected.source_method,
      shot.asset.method,
      'Source method changed from the contract.',
      shot.shot_idx,
    );
    if (expected.motion && expected.motion !== 'none') {
      checkSame(
        'motion',
        expected.motion,
        shot.scene_animation,
        'Motion preset changed from the contract.',
        shot.shot_idx,
      );
    }
  }

  const hasError = issues.some((issue) => issue.severity === 'error');
  return {
    ok: !hasError,
    score: total > 0 ? Math.round((passed / total) * 100) : 100,
    passed,
    total,
    issues,
    checked_at: plan.contract_validation?.checked_at ?? Date.now(),
  };
}

export type PreviewMediaLayer = {
  src: string;
  kind: PreviewKind;
  shot: ShotPlan;
  label: string;
  playbackStartMs?: number | null;
  playbackEndMs?: number | null;
};

/** Devtools toggle — gates verbose "thought process" panels (extract /
 *  screenshot / record / video-frames logs) inside the candidate cards.
 *  Default false so the UI is clean for regular use; flip it on from the
 *  topbar to inspect what the curator agent is doing under the hood. */
const DEVTOOLS_STORAGE_KEY = 'reely:devtools';
const DevtoolsContext = React.createContext(false);

function useDevtoolsState(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(DEVTOOLS_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const set = React.useCallback((next: boolean): void => {
    setOn(next);
    try {
      window.localStorage.setItem(DEVTOOLS_STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* private mode / disabled storage — toggle still works in-session */
    }
  }, []);
  return [on, set];
}

/** The four stages of the make-a-reel flow, rendered as a horizontal
 *  progress stepper at the top of the app. Stays in lockstep with the
 *  sections inside WorkflowView. */
type Stage = 'dashboard' | 'inspire' | 'target' | 'plan' | 'review';

interface StageDef {
  id: Stage;
  num: string;
  title: string;
  sub: string;
}
const STAGES: StageDef[] = [
  { id: 'inspire', num: '1', title: 'Inspiration', sub: 'Reels you love' },
  { id: 'target', num: '2', title: 'Your video', sub: 'Script or footage' },
  { id: 'plan', num: '3', title: 'The plan', sub: 'Shots + media' },
  { id: 'review', num: '4', title: 'Review', sub: 'Full preview' },
];
const STAGE_ROUTES: Record<Stage, string> = {
  dashboard: 'dashboard',
  inspire: 'inspire',
  target: 'target',
  plan: 'plan',
  review: 'review',
};
const ROUTE_STAGES: Record<string, Stage> = {
  dashboard: 'dashboard',
  home: 'dashboard',
  inspire: 'inspire',
  inspiration: 'inspire',
  target: 'target',
  video: 'target',
  plan: 'plan',
  review: 'review',
};

function routeFromHash(): { view: ViewMode; stage: Stage } {
  const route = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (route === 'analyze') return { view: 'analyze', stage: 'inspire' };
  return { view: 'workflow', stage: ROUTE_STAGES[route] ?? 'dashboard' };
}

function hashForPage(view: ViewMode, stage: Stage): string {
  return view === 'analyze' ? '#/analyze' : `#/${STAGE_ROUTES[stage]}`;
}

/** Progress flag per stage — drives the stepper's "done" check icon. */
type StageProgress = Partial<Record<Stage, boolean>>;

/** Catch-all error boundary so a render-time exception (stale state
 *  shape, undefined dereference, etc.) shows an actionable message
 *  instead of unmounting the tree and leaving a blank window. */
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[AppErrorBoundary]', error, info.componentStack);
  }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary">
        <h2>Something broke in the renderer.</h2>
        <pre className="error-boundary-msg">{this.state.error.message}</pre>
        <p>
          This is usually a stale-state shape after a code change. Try
          reloading; if the issue persists, the cached plan / curation
          may need to be deleted from <code>.library/</code>.
        </p>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

/** Normalize shot.selected_media to an array — handles the legacy
 *  shape (single SelectedMedia object) from plans written before the
 *  multi-select rollout. Returns a fresh array each call; callers
 *  should mutate via setState, not in place. */
export function getSelections(shot: ShotPlan | undefined): SelectedMedia[] {
  if (!shot) return [];
  const raw = shot.selected_media as
    | SelectedMedia[]
    | SelectedMedia
    | null
    | undefined;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

/** Toggle membership of `media` in the existing selection list:
 *  if a pick with the same URL is already in the list, remove it;
 *  otherwise append. First-clicked = first-played. */
function toggleSelection(
  current: SelectedMedia[],
  media: SelectedMedia,
): SelectedMedia[] {
  const idx = current.findIndex((s) => s.url === media.url);
  if (idx >= 0) {
    const next = current.slice();
    next.splice(idx, 1);
    return next;
  }
  return [...current, media];
}

type LibraryCandidate = {
  candidate: MediaCandidate;
  sourceShotIdx: number;
  sourceLabel: string;
  brollOverride?: string;
};

type PickClipboard = {
  sourceShotIdx: number;
  picks: SelectedMedia[];
} | null;

function mediaKey(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return url.trim().replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  }
}

function libraryDedupeKey(candidate: MediaCandidate): string {
  // Key on the ACTUAL displayable media (the recording, each screenshot
  // image, or the page URL) — NOT the source page. buildMediaLibrary
  // explodes one captured candidate into separate entries (a recording
  // + one per screenshot) that all share the same source_page; keying
  // on source_page collapsed them into a single entry, which is why
  // screenshots never showed up in the library. candidate.url is set to
  // the specific media URL for each derived entry, so it dedupes
  // recordings vs screenshots correctly while still folding true
  // duplicates of the same asset.
  return mediaKey(
    candidate.url ||
      candidate.auto_recording_url ||
      candidate.thumbnail_url ||
      candidate.source_page,
  );
}

function shotDuplicateKey(shot: ShotPlan): string {
  const spoken = shot.spoken_during.trim().replace(/\s+/g, ' ').toLowerCase();
  const idea = shot.broll_description.trim().replace(/\s+/g, ' ').toLowerCase();
  return `${spoken}::${idea}`;
}

function buildMediaLibrary(curation: CurationResult | null): LibraryCandidate[] {
  if (!curation) return [];
  const seen = new Set<string>();
  const out: LibraryCandidate[] = [];
  const add = (
    candidate: MediaCandidate,
    sourceShotIdx: number,
    sourceLabel: string,
    brollOverride?: string,
  ): void => {
    const key = libraryDedupeKey(candidate);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ candidate, sourceShotIdx, sourceLabel, brollOverride });
  };
  const addResolved = (
    candidate: MediaCandidate,
    sourceShotIdx: number,
    sourceLabel: string,
    brollOverride?: string,
  ): void => {
    let addedCapture = false;
    if (candidate.auto_recording_url) {
      addedCapture = true;
      add(
        {
          ...candidate,
          source: 'web_video',
          url: candidate.auto_recording_url,
          source_page: candidate.source_page ?? candidate.url,
          title: candidate.title ? `${candidate.title} · recording` : 'Page recording',
          auto_recording_url: candidate.auto_recording_url,
        },
        sourceShotIdx,
        sourceLabel,
        brollOverride,
      );
    }
    for (const [i, shot] of (candidate.auto_screenshots ?? []).entries()) {
      addedCapture = true;
      add(
        {
          ...candidate,
          source: 'web_image',
          url: shot.image_url,
          source_page: candidate.source_page ?? candidate.url,
          title: candidate.title
            ? `${candidate.title} · screenshot ${i + 1}`
            : `Screenshot ${i + 1}`,
          auto_recording_url: null,
          auto_screenshots: [shot],
        },
        sourceShotIdx,
        sourceLabel,
        brollOverride,
      );
    }
    if (!addedCapture) {
      add(candidate, sourceShotIdx, sourceLabel, brollOverride);
    }
  };
  for (const sc of curation.shots) {
    if (!sc) continue;
    for (const c of sc.candidates ?? []) {
      addResolved(c, sc.shot_idx, `shot ${sc.shot_idx + 1}`);
    }
    for (const [i, alt] of (sc.alternatives ?? []).entries()) {
      for (const c of alt.candidates ?? []) {
        addResolved(c, sc.shot_idx, `shot ${sc.shot_idx + 1} alt ${i + 1}`, alt.broll_description);
      }
    }
  }
  return out;
}

/** Turn pasted clipboard media into library candidates so they show in
 *  the media library grid and can be assigned to shots like any other. */
function pastedMediaToLibrary(
  entries: PastedMediaEntry[],
): LibraryCandidate[] {
  return entries.map((entry) => ({
    candidate: {
      source: entry.kind === 'video' ? 'web_video' : 'web_image',
      url: entry.url,
      source_page: entry.url,
      title: entry.name || `Pasted ${entry.kind}`,
      notes: 'Pasted from clipboard',
      auto_recording_url: entry.kind === 'video' ? entry.url : null,
      auto_screenshots:
        entry.kind === 'image' ? [{ image_url: entry.url }] : [],
    } as MediaCandidate,
    sourceShotIdx: -1,
    sourceLabel: 'pasted',
  }));
}

function libraryCandidateToSelectedMedia(item: LibraryCandidate): SelectedMedia {
  const c = item.candidate;
  const hasScreenshot = !!c.auto_screenshots?.[0]?.image_url;
  const url = c.auto_recording_url || c.auto_screenshots?.[0]?.image_url || c.url;
  const kind: SelectedMedia['kind'] =
    hasScreenshot && !c.auto_recording_url
      ? 'image'
      : c.source === 'web_image' || c.source === 'generated_image'
        ? 'image'
        : 'video';
  return {
    url,
    kind,
    origin:
      c.auto_recording_url
        ? 'page_recording'
        : hasScreenshot
          ? 'page_screenshot'
          : 'original_candidate',
    from_candidate_url: c.url,
    reason: c.notes ?? null,
  };
}

function wordsForMatch(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function matchScore(shot: ShotPlan, item: LibraryCandidate): number {
  let score = item.sourceShotIdx === shot.shot_idx ? 10 : 0;
  const shotWords = wordsForMatch(
    `${shot.spoken_during} ${shot.broll_description} ${shot.source_type}`,
  );
  const mediaWords = wordsForMatch(
    `${item.candidate.title ?? ''} ${item.candidate.notes ?? ''} ${item.brollOverride ?? ''}`,
  );
  for (const w of shotWords) if (mediaWords.has(w)) score += 1;
  if (item.candidate.auto_recording_url) score += 1.5;
  if (item.candidate.auto_screenshots?.length) score += 0.75;
  return score;
}

export function animationForMedia(media: SelectedMedia, shotIdx: number): SceneAnimation {
  if (media.kind === 'video') return shotIdx % 3 === 0 ? 'punch_in' : 'zoom_in';
  return shotIdx % 4 === 0
    ? 'ken_burns'
    : shotIdx % 4 === 1
      ? 'zoom_in'
      : shotIdx % 4 === 2
        ? 'pan_left'
        : 'pan_right';
}

function shotWithMediaOverrides(shot: ShotPlan, media: SelectedMedia | null): ShotPlan {
  if (!media) return shot;
  return {
    ...shot,
    ...(media.scene_animation ? { scene_animation: media.scene_animation } : {}),
    ...(media.animation_scale !== undefined ? { animation_scale: media.animation_scale } : {}),
    ...(media.animation_duration_ms !== undefined ? { animation_duration_ms: media.animation_duration_ms } : {}),
    ...(media.animation_easing ? { animation_easing: media.animation_easing } : {}),
    ...(media.animation_origin ? { animation_origin: media.animation_origin } : {}),
    ...(media.animation_x !== undefined ? { animation_x: media.animation_x } : {}),
    ...(media.animation_y !== undefined ? { animation_y: media.animation_y } : {}),
    ...(media.media_start_zoom !== undefined ? { media_start_zoom: media.media_start_zoom } : {}),
    ...(media.zoom_region ? { zoom_region: media.zoom_region } : {}),
    ...(media.zoom_x !== undefined ? { zoom_x: media.zoom_x } : {}),
    ...(media.zoom_y !== undefined ? { zoom_y: media.zoom_y } : {}),
    ...(media.zoom_scale !== undefined ? { zoom_scale: media.zoom_scale } : {}),
  };
}

function previewFromSelectedMedia(
  media: SelectedMedia | null,
): { src: string | null; kind: PreviewKind } {
  if (!media) return { src: null, kind: 'image' };
  if (media.kind === 'image') return { src: media.url, kind: 'image' };
  if (isPlayableVideoUrl(media.url)) return { src: media.url, kind: 'video' };
  const embed = videoEmbedUrl(media.url);
  if (embed) return { src: embed, kind: 'embed' };
  return { src: media.from_candidate_url || media.url, kind: 'reelthumb' };
}

function previewLayerFromPick(
  pick: SelectedMedia,
  shot: ShotPlan,
  index: number,
  count: number,
): PreviewMediaLayer | null {
  const preview = previewFromSelectedMedia(pick);
  if (!preview.src) return null;
  const sliceMs = Math.max(250, Math.round(shot.duration_ms / Math.max(1, count)));
  const startMs = shot.start_ms + index * sliceMs;
  const endMs = index === count - 1 ? shot.end_ms : Math.min(shot.end_ms, startMs + sliceMs);
  return {
    src: preview.src,
    kind: preview.kind,
    shot: shotWithMediaOverrides(
      {
        ...shot,
        start_ms: startMs,
        end_ms: endMs,
        duration_ms: Math.max(250, endMs - startMs),
      },
      pick,
    ),
    label: `Overlay ${index + 1}`,
    playbackStartMs: pick.playback_start_ms ?? null,
    playbackEndMs: pick.playback_end_ms ?? null,
  };
}

/** Pure derivation of what a shot renders as: the preview ShotPlan (with
 *  overlays merged from curation), the per-pick mockup ShotPlan, and the
 *  on-screen media src/kind. Mirrors the inline logic in PhoneSidebar
 *  (the live shot preview) so the EXPORTED video composites identically.
 *  Keep the two in sync — this is what the deterministic renderer uses. */
export function resolveShotRender(
  shot: ShotPlan,
  curation: ShotCuration | null,
  optionIdx: number,
  pickIdx: number,
): {
  previewShot: ShotPlan;
  mockupShot: ShotPlan;
  previewSrc: string | null;
  previewKind: PreviewKind;
  previewVideoMode: 'segment' | 'full';
  previewPlaybackStartMs?: number | null;
  previewPlaybackEndMs?: number | null;
  layeredPreviewMedia: PreviewMediaLayer[];
  picks: SelectedMedia[];
  pickDurationMs: number;
} {
  const picks = getSelections(shot);
  const pickDurationMs =
    picks.length > 0
      ? Math.max(250, Math.round(shot.duration_ms / picks.length))
      : 0;
  const selOpt = shot.options[optionIdx] ?? shot.options[0];
  const baseShot: ShotPlan = selOpt
    ? {
        ...shot,
        broll_description: selOpt.broll_description,
        asset: selOpt.asset,
        placement: selOpt.placement,
        source_type: selOpt.source_type,
      }
    : shot;
  const previewShot: ShotPlan = {
    ...baseShot,
    has_overlay: false,
    additional_elements: [],
  };
  const isOverlayLayout = previewShot.placement.fit === 'pip';
  const layeredPreviewMedia =
    isOverlayLayout && picks.length > 1
      ? picks
          .map((pick, i) => previewLayerFromPick(pick, previewShot, i, picks.length))
          .filter((layer): layer is PreviewMediaLayer => !!layer)
      : [];
  const currentPick = picks[pickIdx] ?? null;
  const mockupShot: ShotPlan = {
    ...(picks.length > 1 && !isOverlayLayout
      ? {
          ...previewShot,
          start_ms: 0,
          end_ms: pickDurationMs,
          duration_ms: pickDurationMs,
        }
      : previewShot),
  };
  const mediaShot = shotWithMediaOverrides(mockupShot, currentPick);
  let previewSrc: string | null = null;
  let previewKind: PreviewKind = 'image';
  let previewVideoMode: 'segment' | 'full' = 'segment';
  let previewPlaybackStartMs: number | null = null;
  let previewPlaybackEndMs: number | null = null;
  if (currentPick && layeredPreviewMedia.length === 0) {
    const preview = previewFromSelectedMedia(currentPick);
    previewSrc = preview.src;
    previewKind = preview.kind;
    previewVideoMode = preview.kind === 'video' ? 'full' : 'segment';
    previewPlaybackStartMs = currentPick.playback_start_ms ?? null;
    previewPlaybackEndMs = currentPick.playback_end_ms ?? null;
  } else {
    previewSrc = curation?.candidates?.[0]?.thumbnail_url ?? null;
    previewKind = 'image';
  }
  return {
    previewShot,
    mockupShot: mediaShot,
    previewSrc,
    previewKind,
    previewVideoMode,
    previewPlaybackStartMs,
    previewPlaybackEndMs,
    layeredPreviewMedia,
    picks,
    pickDurationMs,
  };
}

/** Horizontal 4-step progress stepper. Coral fills as you advance,
 *  done steps show a check, current step is highlighted, locked
 *  steps are faded and non-clickable. */
function FlowStepper({
  stage,
  setStage,
  progress,
  locked,
}: {
  stage: Stage;
  setStage: (s: Stage) => void;
  progress: StageProgress;
  locked: Set<Stage>;
}): React.JSX.Element {
  const curIdx = STAGES.findIndex((s) => s.id === stage);
  return (
    <nav className="flow" aria-label="Make a reel">
      {STAGES.map((s, i) => {
        const done = !!progress[s.id];
        const active = stage === s.id;
        const isLocked = locked.has(s.id);
        return (
          <React.Fragment key={s.id}>
            {i > 0 && (
              <span className={`flow-line ${curIdx >= i ? 'fill' : ''}`} />
            )}
            <button
              type="button"
              className={`flow-step ${active ? 'active' : ''} ${done ? 'done' : ''} ${isLocked ? 'locked' : ''}`}
              onClick={() => !isLocked && setStage(s.id)}
              disabled={isLocked}
              title={isLocked ? 'Synthesize a plan first' : s.sub}
              aria-disabled={isLocked}
            >
              <span className="flow-node">
                {isLocked ? '🔒' : done && !active ? '✓' : s.num}
              </span>
              <span className="flow-text">
                <span className="flow-title">{s.title}</span>
                <span className="flow-sub">{s.sub}</span>
              </span>
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/** Top app bar: brand + flow stepper + Analyze tool + Preview shortcut
 *  + a thin coral progress fill at the bottom edge. */
function TopNav({
  view,
  setView,
  stage,
  setStage,
  progress,
  locked,
  devtools,
  setDevtools,
}: {
  view: ViewMode;
  setView: (v: ViewMode) => void;
  stage: Stage;
  setStage: (s: Stage) => void;
  progress: StageProgress;
  locked: Set<Stage>;
  devtools: boolean;
  setDevtools: (next: boolean) => void;
}): React.JSX.Element {
  const curIdx = STAGES.findIndex((s) => s.id === stage);
  const pct =
    view === 'analyze' || curIdx < 0
      ? 0
      : (curIdx / (STAGES.length - 1)) * 100;
  return (
    <header className="appbar">
      <div className="appbar-brand">
        <div className="appbar-logo">▶</div>
        <div className="appbar-word">
          Ree<span>ly</span>
        </div>
      </div>

      {view === 'workflow' ? (
        <FlowStepper
          stage={stage}
          setStage={setStage}
          progress={progress}
          locked={locked}
        />
      ) : (
        <div /> /* keep grid centered when analyze is active */
      )}

      <div className="appbar-right">
        <button
          type="button"
          className={`appbar-tool ${view === 'workflow' && stage === 'dashboard' ? 'on' : ''}`}
          onClick={() => setStage('dashboard')}
          title="Workspace dashboard"
        >
          ▦ Dashboard
        </button>
        <button
          type="button"
          className={`appbar-tool ${devtools ? 'on' : ''}`}
          onClick={() => setDevtools(!devtools)}
          title={
            devtools
              ? 'Devtools ON — extract / screenshot / record / frames thought-process panels are shown. Click to hide.'
              : 'Devtools OFF — agent thought-process panels are hidden. Click to reveal.'
          }
          aria-pressed={devtools}
        >
          {devtools ? '⚙ dev' : '⚙ dev'}
        </button>
        <button
          type="button"
          className={`appbar-tool ${view === 'analyze' ? 'on' : ''}`}
          onClick={() =>
            setView(view === 'analyze' ? 'workflow' : 'analyze')
          }
          title="Analyze any reel"
        >
          ⌕ Analyze
        </button>
        {view === 'workflow' && stage !== 'review' && !locked.has('review') && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setStage('review')}
          >
            ▶ Preview
          </button>
        )}
        <div className="project-pill">
          <span className="dot" />
          <span>desktop</span>
        </div>
      </div>

      <div className="appbar-progress">
        <i style={{ width: pct + '%' }} />
      </div>
    </header>
  );
}

/** Bottom command bar: type any instruction; a tool-calling agent inspects
 *  the plan, makes the edits, and returns the plan to adopt. */
function CommandBar({
  plan,
  onApply,
  onFindClip,
  onPrompt,
  narrationPath = null,
}: {
  plan: SuggestedEdit;
  onApply: (next: SuggestedEdit) => void;
  /** Run curation for a shot from a find_clip action (array index). */
  onFindClip?: (query: string, shotIdx: number | null) => void | Promise<void>;
  /** Record the raw command to the persistent prompt log. */
  onPrompt?: (text: string) => void;
  /** Narration source (with audio) so the agent can reason over word timings. */
  narrationPath?: string | null;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [clarify, setClarify] = useState<{
    question: string;
    options: string[];
  } | null>(null);
  // Library sounds the agent surfaced this run, so the user can hear each one.
  const [sounds, setSounds] = useState<
    { name: string; label: string | null }[]
  >([]);
  const lastCommandRef = useRef('');
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  // Play the SFX a disambiguation option refers to, so the user can hear
  // each candidate before choosing. Resolves the option text to a clip URL.
  const preview = async (option: string): Promise<void> => {
    try {
      const url = await window.api.resolveSfxUrl(option);
      if (!url) {
        setStatus(`No sound found for "${option}".`);
        return;
      }
      previewRef.current?.pause();
      const audio = new Audio(url);
      previewRef.current = audio;
      setPreviewing(option);
      audio.onended = () => setPreviewing((p) => (p === option ? null : p));
      await audio.play();
    } catch {
      setPreviewing(null);
    }
  };

  const run = async (command: string): Promise<void> => {
    if (!command || busy) return;
    lastCommandRef.current = command;
    onPrompt?.(command);
    setBusy(true);
    setStatus('Working…');
    setClarify(null);
    setSounds([]);
    try {
      const res = await window.api.agentEditPlan({
        command,
        plan,
        narrationPath,
      });
      // Adopt the agent's (possibly mutated) plan copy.
      onApply(res.plan);
      // Run queued actions (curation) the agent couldn't do itself.
      for (const a of res.actions) {
        if (a.kind === 'find_clip' && onFindClip) {
          void onFindClip(a.query, a.shot_idx);
        }
      }
      if (res.toolLog?.length) console.error('[cmdbar] tools:', res.toolLog);
      // Sounds the agent mentioned — let the user hear each, even when it
      // replied in prose rather than asking a structured question.
      setSounds(res.sounds ?? []);
      if (res.clarify && res.clarify.options.length > 0) {
        // Agent is unsure — let the user pick instead of guessing.
        setClarify(res.clarify);
        setStatus(res.clarify.question);
      } else {
        setStatus(res.reply || 'Done.');
        setText('');
      }
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const submit = (): Promise<void> => run(text.trim());
  // Picking a disambiguation option re-runs the original request, pinned to
  // the chosen option.
  const choose = (option: string): Promise<void> =>
    run(`${lastCommandRef.current}\n\nUse this option: ${option}`);

  return (
    <div className="cmdbar">
      {status && <div className="cmdbar-status">{status}</div>}
      {clarify && (
        <div className="cmdbar-choices">
          {clarify.options.map((opt) => (
            <span key={opt} className="cmdbar-choice-wrap">
              <button
                type="button"
                className="cmdbar-choice-play"
                disabled={busy}
                title={`Hear "${opt}"`}
                onClick={() => void preview(opt)}
              >
                {previewing === opt ? '♪' : '▶'}
              </button>
              <button
                type="button"
                className="cmdbar-choice"
                disabled={busy}
                onClick={() => void choose(opt)}
              >
                {opt}
              </button>
            </span>
          ))}
        </div>
      )}
      {sounds.filter((s) => !clarify?.options.includes(s.label ?? s.name))
        .length > 0 && (
        <div className="cmdbar-sounds">
          <span className="cmdbar-sounds-label">Hear:</span>
          {sounds
            .filter((s) => !clarify?.options.includes(s.label ?? s.name))
            .map((s) => {
              const display = s.label ?? s.name;
              return (
                <span key={s.name} className="cmdbar-choice-wrap">
                  <button
                    type="button"
                    className="cmdbar-choice-play"
                    disabled={busy}
                    title={`Hear "${display}"`}
                    onClick={() => void preview(s.name)}
                  >
                    {previewing === s.name ? '♪' : '▶'}
                  </button>
                  <button
                    type="button"
                    className="cmdbar-choice"
                    disabled={busy}
                    title={`Use the "${display}" sound effect`}
                    onClick={() => void run(`Use the "${display}" sound effect.`)}
                  >
                    {display}
                  </button>
                </span>
              );
            })}
        </div>
      )}
      <div className="cmdbar-row">
        <input
          className="cmdbar-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="Tell the editor what to change — e.g. “add a ding on every word”, “zoom in on everything”, “lower the SFX volume”"
          disabled={busy}
        />
        <button
          className="cmdbar-send"
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function AppInner(): React.JSX.Element {
  const initialPage = routeFromHash();
  const [view, setViewState] = useState<ViewMode>(initialPage.view);
  const [stage, setStageState] = useState<Stage>(initialPage.stage);
  const [progress, setProgress] = useState<StageProgress>({});
  const [devtools, setDevtools] = useDevtoolsState();

  const navigatePage = React.useCallback((nextView: ViewMode, nextStage: Stage): void => {
    setViewState(nextView);
    setStageState(nextStage);
    const nextHash = hashForPage(nextView, nextStage);
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash);
    }
  }, []);

  const setView = React.useCallback(
    (nextView: ViewMode): void => {
      navigatePage(nextView, nextView === 'workflow' ? stage : stage);
    },
    [navigatePage, stage],
  );

  const setStage = React.useCallback(
    (nextStage: Stage): void => {
      navigatePage('workflow', nextStage);
    },
    [navigatePage],
  );

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, '', hashForPage(view, stage));
    }
    const onHashChange = (): void => {
      const next = routeFromHash();
      setViewState(next.view);
      setStageState((prev) => (next.view === 'workflow' ? next.stage : prev));
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, [stage, view]);

  // Plan + review are locked until a plan has been synthesized. The
  // 'plan' progress flag is reported up by WorkflowView whenever the
  // plan state changes (see setStageDone('plan', plan !== null)).
  const locked = React.useMemo<Set<Stage>>(
    () => (progress.plan ? new Set() : new Set(['plan', 'review'])),
    [progress.plan],
  );

  return (
    <DevtoolsContext.Provider value={devtools}>
    <div className="app">
      <TopNav
        view={view}
        setView={setView}
        stage={stage}
        setStage={setStage}
        progress={progress}
        locked={locked}
        devtools={devtools}
        setDevtools={setDevtools}
      />

      <main className="main">
        {view === 'workflow' ? (
          <WorkflowView
            stage={stage}
            setStage={setStage}
            setStageDone={(s: Stage, done: boolean) =>
              setProgress((p) =>
                p[s] === done ? p : { ...p, [s]: done },
              )
            }
          />
        ) : (
          <AnalyzeView />
        )}
      </main>
    </div>
    </DevtoolsContext.Provider>
  );
}

// ============================================================
//  Workflow view: Library → Target → Plan → Curate
// ============================================================

interface LibraryRow {
  url: string;
  tags: ReelTag[];
  status: 'pending' | 'hydrating' | 'ready' | 'error';
  from_cache?: boolean;
  error?: string;
  caption_text?: string | null;
  analysis?: ReelAnalysisResult;
}

type Busy = null | 'hydrating' | 'synthesizing' | 'batch_synthesizing' | 'curating';

type TargetMode = 'reel_url' | 'script' | 'local_video';

function meanNumber(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function formatPct(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms >= 1000 ? 1 : 2)}s`;
}

function dominantClipType(rows: (LibraryRow & { analysis: ReelAnalysisResult })[]): {
  label: string;
  pct: string;
} | null {
  const totals = new Map<ClipType, number>();
  for (const row of rows) {
    const dist = row.analysis.clip_type_distribution;
    for (const key of Object.keys(dist) as ClipType[]) {
      totals.set(key, (totals.get(key) ?? 0) + dist[key]);
    }
  }
  if (totals.size === 0) return null;
  const [kind, value] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = value / rows.length;
  return {
    label: CLIP_META[kind]?.label ?? kind.replace(/_/g, ' '),
    pct: formatPct(share),
  };
}

function reelHost(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (/instagram\.com$/i.test(host)) {
      const kind = parts[0];
      const code = parts[1];
      if (kind && code && ['reel', 'reels', 'p', 'tv'].includes(kind)) {
        return `Instagram ${kind.replace(/^p$/, 'post')} ${code}`;
      }
      if (parts[0]) return `Instagram ${parts[0]}`;
      return 'Instagram';
    }
    if (/tiktok\.com$/i.test(host)) {
      const user = parts.find((p) => p.startsWith('@'));
      const videoIdx = parts.indexOf('video');
      const videoId = videoIdx >= 0 ? parts[videoIdx + 1] : null;
      if (user && videoId) return `TikTok ${user} ${videoId}`;
      if (user) return `TikTok ${user}`;
    }
    if (/youtu\.be$/i.test(host) && parts[0]) return `YouTube ${parts[0]}`;
    if (/youtube\.com$/i.test(host)) {
      const id = parsed.searchParams.get('v') || parts.at(-1);
      if (id) return `YouTube ${id}`;
    }
    const path = parts.slice(0, 2).join('/');
    return path ? `${host}/${path}` : host;
  } catch {
    return clipText(url, 56);
  }
}

function labelTextFromCaption(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#[\w-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length < 4) return null;
  const stop = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'but',
    'by',
    'for',
    'from',
    'has',
    'have',
    'he',
    'her',
    'his',
    'how',
    'i',
    'in',
    'is',
    'it',
    'its',
    'me',
    'my',
    'of',
    'on',
    'or',
    'our',
    'she',
    'that',
    'the',
    'their',
    'they',
    'this',
    'to',
    'was',
    'we',
    'what',
    'when',
    'where',
    'who',
    'why',
    'with',
    'you',
    'your',
  ]);
  const words = clean
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^['-]+|['-]+$/g, ''))
    .filter((word) => word.length > 2 && !stop.has(word.toLowerCase()));
  const picked: string[] = [];
  for (const word of words) {
    if (picked.some((w) => w.toLowerCase() === word.toLowerCase())) continue;
    picked.push(word);
    if (picked.length === 4) break;
  }
  return picked.length > 0 ? picked.join(' ') : null;
}

function reelDisplayName(row: LibraryRow & { analysis?: ReelAnalysisResult }): string {
  const caption = labelTextFromCaption(row.caption_text);
  if (caption) return caption;
  const hook = labelTextFromCaption(
    row.analysis?.hook_speech || row.analysis?.hook_text || null,
  );
  if (hook) return hook;
  const visual = labelTextFromCaption(
    row.analysis?.shots.find((shot) => shot.visual_caption)?.visual_caption ?? null,
  );
  if (visual) return visual;
  return reelHost(row.url);
}

function hookExamples(rows: (LibraryRow & { analysis: ReelAnalysisResult })[]): string[] {
  return rows
    .map((r) => r.analysis.hook_speech || r.analysis.hook_text || '')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3);
}

function clipText(text: string, max = 84): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function aggregateDistribution<T extends string>(
  rows: (LibraryRow & { analysis: ReelAnalysisResult })[],
  pick: (analysis: ReelAnalysisResult) => Partial<Record<T, number>> | null | undefined,
): Map<T, number> {
  const totals = new Map<T, number>();
  for (const row of rows) {
    const dist = pick(row.analysis);
    if (!dist) continue;
    for (const [key, value] of Object.entries(dist) as [T, number][]) {
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
  }
  return totals;
}

function topDistributionItems<T extends string>(
  rows: (LibraryRow & { analysis: ReelAnalysisResult })[],
  pick: (analysis: ReelAnalysisResult) => Partial<Record<T, number>> | null | undefined,
  label: (key: T) => string,
  max = 4,
): string[] {
  const totals = aggregateDistribution(rows, pick);
  return [...totals.entries()]
    .map(([key, value]) => [key, value / Math.max(1, rows.length)] as [T, number])
    .filter(([, value]) => value > 0.01)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key, value]) => `${label(key)} ${formatPct(value)}`);
}

function overlayPresetLabel(kind: string): string {
  switch (kind) {
    case 'gif':
      return 'reaction_gif';
    case 'emoji_graphic':
      return 'emoji_burst';
    case 'pip_video':
      return 'face_cam / PiP';
    case 'image':
      return 'image / logo / lower_third';
    default:
      return kind;
  }
}

function sfxLabel(kind: string): string {
  return kind.replace(/^impulse_/, '').replace(/_/g, ' ');
}

function captionOutcome(rows: (LibraryRow & { analysis: ReelAnalysisResult })[]): string[] {
  const captioned = rows
    .map((r) => r.analysis.caption_style)
    .filter((style): style is NonNullable<ReelAnalysisResult['caption_style']> =>
      !!style?.present,
    );
  if (captioned.length === 0) return ['No burned-in spoken captions detected.'];
  const first = captioned[0];
  const presetCounts = new Map<string, number>();
  for (const style of captioned) {
    const preset = style.preset_label || style.matched_preset || style.style_label || 'Custom';
    presetCounts.set(preset, (presetCounts.get(preset) ?? 0) + 1);
  }
  const preset = [...presetCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Custom';
  return [
    `${captioned.length}/${rows.length} reels use captions; preset/treatment: ${preset}.`,
    `${first.position}, ${first.chunking}, ${first.words_per_chunk || '?'} words/group, ${first.casing}, ${first.font_size}, ${first.animation}.`,
    `${first.text_treatment}${first.treatment_color ? ` ${first.treatment_color}` : ''}${first.highlight_color ? ` with ${first.highlight_color} highlight` : ''}; font ${first.font_family_name || first.font_descriptor || 'unmatched'}.`,
  ];
}

function structureShotRecipe(
  rows: (LibraryRow & { analysis: ReelAnalysisResult })[],
): string[] {
  const sourceRows = rows.slice(0, 2);
  if (sourceRows.length === 0) return ['No structure-tagged reel yet; structure will be inferred from the ready set.'];
  return sourceRows.map((row) => {
    const shots = row.analysis.shots.slice(0, 6).map((shot, idx) => {
      const role = idx === 0 ? 'hook' : idx === row.analysis.shots.length - 1 ? 'cta' : `beat ${idx + 1}`;
      const label = CLIP_META[shot.clip_type]?.label ?? shot.clip_type.replace(/_/g, ' ');
      const caption = shot.visual_caption ? ` (${clipText(shot.visual_caption, 46)})` : '';
      return `${role}: ${label}${caption}`;
    });
    return `${reelDisplayName(row)} -> ${shots.join(' -> ')}`;
  });
}

function contentExamples(
  rows: (LibraryRow & { analysis: ReelAnalysisResult })[],
): string[] {
  const examples: string[] = [];
  for (const row of rows) {
    for (const shot of row.analysis.shots) {
      if (!shot.visual_caption) continue;
      examples.push(`${reelDisplayName(row)}: ${clipText(shot.visual_caption, 92)}`);
      if (examples.length >= 5) return examples;
    }
  }
  return examples.length > 0 ? examples : ['No visual captions extracted yet.'];
}

function contentSourceKind(text: string): string {
  const t = text.toLowerCase();
  if (/\b(screen recording|website|homepage|browser|dashboard|app|ui|interface|landing page)\b/.test(t)) {
    return 'screen recordings / product UI';
  }
  if (/\b(tweet|x post|linkedin|instagram|tiktok|social|profile|post)\b/.test(t)) {
    return 'social posts / profile screenshots';
  }
  if (/\b(podcast|interview|stage|conference|talk|speaking|microphone)\b/.test(t)) {
    return 'founder/interview/stage clips';
  }
  if (/\b(photo|portrait|headshot|image|screenshot)\b/.test(t)) {
    return 'photos / screenshots';
  }
  if (/\b(product|device|robot|car|drone|prototype|hardware)\b/.test(t)) {
    return 'product or object b-roll';
  }
  if (/\b(chart|graph|map|document|paper|article|news|headline)\b/.test(t)) {
    return 'documents, articles, charts';
  }
  return 'general visual b-roll';
}

function contentSourceOutcomes(
  rows: (LibraryRow & { analysis: ReelAnalysisResult })[],
): { choices: string[]; details: string[] } {
  const counts = new Map<string, number>();
  const examples = new Map<string, string>();
  for (const row of rows) {
    for (const shot of row.analysis.shots) {
      const caption = shot.visual_caption?.trim();
      if (!caption) continue;
      const kind = contentSourceKind(caption);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (!examples.has(kind)) examples.set(kind, clipText(caption, 82));
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) {
    return {
      choices: [
        'Use concrete web-captured visuals for each idea.',
        'Generate multiple subject-specific options per shot.',
        'Fallback ideas should use reliable official pages or profiles.',
      ],
      details: contentExamples(rows),
    };
  }
  const choices = ranked.slice(0, 3).map(([kind]) => {
    const example = examples.get(kind);
    return `Pull from ${kind}${example ? `, like "${example}"` : ''}.`;
  });
  choices.push('Turn each script beat into several specific b-roll ideas plus a reliable fallback.');
  return {
    choices,
    details: ranked.map(([kind, count]) => {
      const example = examples.get(kind);
      return `${kind}: ${count} observed shot${count === 1 ? '' : 's'}${example ? `; example: ${example}` : ''}`;
    }),
  };
}

function shotRoleLabel(shot: ReelAnalysisResult['shots'][number]): string {
  if (shot.speaker_verdict === 'speaker' || shot.clip_type === 'talking_head') {
    return 'talking';
  }
  if (shot.clip_type === 'broll_talking_head') return 'b-roll talking';
  if (shot.clip_type === 'talking_head_unknown') return 'talking unknown';
  return 'no talking';
}

function shotLayoutCue(shot: ReelAnalysisResult['shots'][number]): string | null {
  const text = `${shot.visual_caption ?? ''}`.toLowerCase();
  if (/\b(top|bottom)\b/.test(text) && /\b(split|panel|half|above|below)\b/.test(text)) {
    return 'top/bottom split';
  }
  if (/\b(split|side[\s-]*by[\s-]*side|two[\s-]*(panel|up)|dual)\b/.test(text)) {
    return 'split layout';
  }
  if (/\b(pip|picture[\s-]*in[\s-]*picture|corner)\b/.test(text)) {
    return 'PiP/corner';
  }
  if (shot.overlays.some((o) => o.kind === 'pip_video')) return 'PiP video';
  if (shot.clip_type === 'talking_head' || shot.clip_type === 'talking_head_unknown') {
    return shot.face_region ? `talking head ${shot.face_region.replace(/_/g, ' ')}` : 'talking head full frame';
  }
  if (shot.clip_type === 'broll_talking_head') {
    return shot.face_region ? `b-roll talking ${shot.face_region.replace(/_/g, ' ')}` : 'b-roll talking full frame';
  }
  return 'full-screen b-roll';
}

function shotStructureKind(shot: ReelAnalysisResult['shots'][number]): string {
  const text = `${shot.visual_caption ?? ''}`.toLowerCase();
  const hasOverlay = shot.overlays.length > 0;
  const overlayKinds = new Set(shot.overlays.map((o) => o.kind));
  if (/\b(top|upper)\b/.test(text) && /\b(media|image|video|screenshot|panel|half)\b/.test(text)) {
    return 'top media layout';
  }
  if (/\b(bottom|lower)\b/.test(text) && /\b(media|image|video|screenshot|panel|half)\b/.test(text)) {
    return 'bottom media layout';
  }
  if (/\b(top|bottom)\b/.test(text) && /\b(split|panel|half|above|below)\b/.test(text)) {
    return 'top/bottom split layout';
  }
  if (/\b(actual[\s-]*size|uncropped|contained|letterbox|full screenshot|screenshot)\b/.test(text)) {
    return 'actual-size screenshot';
  }
  if (/\b(screen recording|website|homepage|browser|dashboard|app|ui|interface)\b/.test(text)) {
    return 'full-screen screen recording';
  }
  if (hasOverlay && overlayKinds.has('pip_video')) return 'PiP overlay shot';
  if (hasOverlay) return 'overlay shot';
  if (shot.clip_type === 'talking_head' || shot.clip_type === 'talking_head_unknown') {
    return shot.face_region
      ? `talking-head ${shot.face_region.replace(/_/g, ' ')}`
      : 'talking-head full frame';
  }
  if (shot.clip_type === 'broll_talking_head') {
    return shot.face_region
      ? `b-roll talking ${shot.face_region.replace(/_/g, ' ')}`
      : 'b-roll talking full frame';
  }
  return 'full-screen b-roll';
}

type ParsedLayeredVisual = {
  base: string | null;
  overlay: string | null;
};

const OVERLAY_MEDIA_WORD_RE =
  /\b(invitation|flyer|poster|card|slide|screenshot|screen grab|tweet|post|profile|article|headline|document|chart|graph|logo|badge|sticker|callout|panel)\b/i;
const BACKGROUND_MEDIA_WORD_RE =
  /\b(crowd|scene|background|room|stage|conference|audience|person|man|woman|speaker|host|presenter|interview|talking|webcam|video)\b/i;

function cleanLayerPhrase(text: string): string {
  return text
    .replace(/^(?:static|moving|animated)\s+/i, '')
    .replace(/^(?:image|video|shot|frame)\s+(?:showing|of)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.。]\s*$/, '')
    .trim();
}

function parseLayeredVisualDescription(
  caption: string | null | undefined,
): ParsedLayeredVisual {
  const text = caption?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return { base: null, overlay: null };

  const patterns: RegExp[] = [
    /^(.*?)\s+(?:is\s+)?overlaid\s+on\s+(.*)$/i,
    /^(.*?)\s+(?:is\s+)?overlaid\s+over\s+(.*)$/i,
    /^(.*?)\s+(?:sits|appears|floats)\s+(?:on|over|above)\s+(.*)$/i,
    /^(.*?)\s+(?:in|at)\s+(?:the\s+)?(?:foreground|corner)\s+(?:over|on)\s+(.*)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const overlay = cleanLayerPhrase(match[1]);
    const base = cleanLayerPhrase(match[2]);
    return {
      base: base || null,
      overlay: overlay || null,
    };
  }

  return { base: text, overlay: null };
}

function visualCaptionLooksLikeOverlayOnly(
  shot: ReelAnalysisResult['shots'][number],
): boolean {
  const caption = shot.visual_caption ?? '';
  if (!caption) return false;
  if (parseLayeredVisualDescription(caption).overlay) return false;
  const structure = shotStructureKind(shot);
  return (
    OVERLAY_MEDIA_WORD_RE.test(caption) &&
    (/top media|bottom media|split|overlay|PiP|actual-size screenshot/i.test(structure) ||
      /\b(top|bottom|overlaid|overlay|foreground|card|panel|invitation|flyer|poster|slide)\b/i.test(caption))
  );
}

function inferredOverlayOwnsTextRegion(
  shot: ReelAnalysisResult['shots'][number],
  region: FrameRegion | null | undefined,
): boolean {
  if (!region || !inferredVisualLayerCue(shot)) return false;
  if (shot.overlays.length > 0) {
    return shot.overlays.some((overlay) => overlay.region === region);
  }
  const row = region.split('_')[0];
  const structure = shotStructureKind(shot);
  const layout = shotLayoutCue(shot) ?? '';
  if (/top media|actual-size screenshot/i.test(structure)) {
    return row === 'top' || row === 'middle';
  }
  if (/bottom media/i.test(structure)) {
    return row === 'middle' || row === 'bottom';
  }
  if (/split|top\/bottom/i.test(`${structure} ${layout}`)) {
    return true;
  }
  if (visualCaptionLooksLikeOverlayOnly(shot)) {
    return row === 'top' || row === 'middle';
  }
  return false;
}

function inferredVisualLayerCue(
  shot: ReelAnalysisResult['shots'][number],
): string | null {
  const text = `${shot.visual_caption ?? ''}`.toLowerCase();
  const layout = shotLayoutCue(shot);
  const structure = shotStructureKind(shot);
  const parsed = parseLayeredVisualDescription(shot.visual_caption);
  if (shot.overlays.length > 0) {
    const kinds = [...new Set(shot.overlays.map((o) => overlayPresetLabel(o.kind)))];
    return kinds.join(' + ');
  }
  if (parsed.overlay) return 'foreground visual overlay';
  if (/pip|picture[\s-]*in[\s-]*picture|corner/.test(text) || /pip/i.test(structure)) {
    return 'PiP/corner media';
  }
  if (/top\/bottom split|split layout|split/.test(layout ?? structure)) {
    return 'split-panel media';
  }
  if (/top media|bottom media/.test(structure)) {
    return structure;
  }
  if (
    /\b(overlaid|overlay|floating|foreground|insert|card|sticker|badge|logo|callout|invitation|flyer|poster|slide)\b/.test(text) ||
    /\boverlay shot\b/.test(structure)
  ) {
    return 'foreground visual overlay';
  }
  if (
    /\b(screenshot|screen grab|tweet|post|profile|article|headline|document|chart|graph)\b/.test(text) &&
    (shot.clip_type === 'talking_head' ||
      shot.clip_type === 'broll_talking_head' ||
      /\b(face|talking|speaker|webcam)\b/.test(text))
  ) {
    return 'screenshot/card over talking media';
  }
  return null;
}

function inferredVisualLayerDetail(
  shot: ReelAnalysisResult['shots'][number],
): string | null {
  const cue = inferredVisualLayerCue(shot);
  if (!cue) return null;
  const parsed = parseLayeredVisualDescription(shot.visual_caption);
  if (parsed.overlay) {
    return `${cue}: ${clipText(parsed.overlay, 76)}${parsed.base ? ` over ${clipText(parsed.base, 76)}` : ''}`;
  }
  const visual = parsed.base ? `: ${clipText(parsed.base, 96)}` : '';
  return `${cue}${visual}`;
}

function scriptContextLabel(text: string | null | undefined): string | null {
  const clean = text?.replace(/\s+/g, ' ').trim() ?? '';
  if (!clean) return null;
  const trimmed = clean.replace(/^["'“”]+|["'“”]+$/g, '');
  if (!trimmed) return null;
  return `when "${clipText(trimmed, 72)}" is said`;
}

function layer2ScriptContext(
  shot: ReelAnalysisResult['shots'][number],
): string | null {
  const overlaySpoken = (shot.overlays ?? [])
    .map((overlay) => overlay.spoken_window?.trim())
    .find((text): text is string => !!text);
  return scriptContextLabel(overlaySpoken || shot.spoken_window);
}

function layer2ScriptDetail(
  shot: ReelAnalysisResult['shots'][number],
): string | null {
  const detail = inferredVisualLayerDetail(shot);
  if (!detail) return null;
  const context = layer2ScriptContext(shot);
  return context ? `${context}, show ${detail}` : `show ${detail}`;
}

function layoutOutcomes(
  rows: (LibraryRow & { analysis: ReelAnalysisResult })[],
): { choices: string[]; details: string[] } {
  const counts = new Map<string, number>();
  const examples = new Map<string, string>();
  for (const row of rows) {
    for (const shot of row.analysis.shots) {
      const cue = shotLayoutCue(shot) ?? 'unknown layout';
      counts.set(cue, (counts.get(cue) ?? 0) + 1);
      if (!examples.has(cue) && shot.visual_caption) {
        examples.set(cue, clipText(shot.visual_caption, 76));
      }
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const choices = ranked.slice(0, 3).map(([cue]) => {
    const example = examples.get(cue);
    return `Use ${cue}${example ? ` when the shot resembles "${example}"` : ''}.`;
  });
  if (choices.length === 0) {
    choices.push('Use the detected layout progression from each reference shot.');
  }
  return {
    choices,
    details: ranked.map(([cue, count]) => {
      const example = examples.get(cue);
      return `${cue}: ${count} shot${count === 1 ? '' : 's'}${example ? `; example: ${example}` : ''}`;
    }),
  };
}

function consistentShotStructureOutcomes(
  rows: (LibraryRow & { analysis: ReelAnalysisResult })[],
): { choices: string[]; details: string[] } {
  const choices: string[] = [];
  const details: string[] = [];
  for (const row of rows) {
    const shots = row.analysis.shots;
    if (shots.length === 0) continue;
    const kinds = shots.map(shotStructureKind);
    const counts = new Map<string, number>();
    for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [dominantKind, dominantCount] = ranked[0] ?? ['unknown layout', 0];
    const total = shots.length;
    const lastKind = kinds[kinds.length - 1];
    const firstKind = kinds[0];
    const overlayCount = shots.filter((shot) => shot.overlays.length > 0).length;
    const label = reelDisplayName(row);
    if (dominantCount >= Math.max(2, Math.ceil(total * 0.7))) {
      choices.push(`${label}: ${dominantCount}/${total} shots use ${dominantKind}.`);
    }
    if (total >= 2 && lastKind !== dominantKind && dominantCount >= total - 1) {
      choices.push(`${label}: keep the final-shot switch to ${lastKind}.`);
    } else if (total >= 3 && lastKind !== firstKind) {
      choices.push(`${label}: starts as ${firstKind}, ends as ${lastKind}.`);
    }
    if (overlayCount === total && total > 0) {
      choices.push(`${label}: every shot is an overlay shot.`);
    } else if (overlayCount >= Math.ceil(total * 0.7)) {
      choices.push(`${label}: ${overlayCount}/${total} shots use overlays.`);
    }
    details.push(
      `${label}: ${kinds.map((kind, idx) => `shot ${idx + 1} ${kind}`).join(' -> ')}`,
    );
  }
  if (choices.length === 0 && rows.length > 0) {
    choices.push('No single repeated shot layout dominates; follow the per-shot layout sequence.');
  }
  return {
    choices: [...new Set(choices)].slice(0, 5),
    details,
  };
}

function layerOutcomes(
  rows: (LibraryRow & { analysis: ReelAnalysisResult })[],
): { choices: string[]; details: string[]; scriptPatterns: string[] } {
  if (rows.length === 0) {
    return {
      choices: [
        'Layer 1 Media: infer the base visual track from ready references.',
        'Layer 2 Visual overlays: keep separate from text/captions.',
        'Layer 3 Text/captions: capture subtitles, OCR text, titles, and text overlays.',
      ],
      details: ['No hydrated references are ready yet.'],
      scriptPatterns: ['No Layer 2 script pattern available yet.'],
    };
  }
  const mediaMix = topDistributionItems(
    rows,
    (analysis) => analysis.clip_type_distribution,
    (kind) => CLIP_META[kind as ClipType]?.label ?? kind.replace(/_/g, ' '),
    3,
  );
  const visualOverlayMix = topDistributionItems(
    rows,
    (analysis) => analysis.overlay_kind_distribution,
    overlayPresetLabel,
    3,
  );
  const captioned = rows.filter((r) => r.analysis.caption_style?.present).length;
  let subtitleShots = 0;
  let nonImageTextShots = 0;
  let textTotalShots = 0;
  for (const row of rows) {
    for (const shot of row.analysis.shots) {
      textTotalShots += 1;
      if (shot.text_moments.some((m) => m.role === 'subtitle')) {
        subtitleShots += 1;
      }
      if (
        shot.text_moments.some(
          (m) => m.role !== 'image_text' && isMeaningfulLayerText(m.text),
        )
      ) {
        nonImageTextShots += 1;
      }
    }
  }
  const subtitlePct =
    textTotalShots > 0 ? subtitleShots / textTotalShots : 0;
  const nonImageTextPct =
    textTotalShots > 0 ? nonImageTextShots / textTotalShots : 0;
  let layer2Shots = 0;
  const layer2Counts = new Map<string, number>();
  const layer2Examples = new Map<string, string>();
  const layer2ScriptExamples: string[] = [];
  let totalShots = 0;
  for (const row of rows) {
    for (const shot of row.analysis.shots) {
      totalShots += 1;
      const cue = inferredVisualLayerCue(shot);
      if (!cue) continue;
      layer2Shots += 1;
      layer2Counts.set(cue, (layer2Counts.get(cue) ?? 0) + 1);
      const layerDetail = inferredVisualLayerDetail(shot);
      if (!layer2Examples.has(cue) && layerDetail) {
        layer2Examples.set(cue, clipText(layerDetail, 72));
      }
      const scriptDetail = layer2ScriptDetail(shot);
      if (scriptDetail) layer2ScriptExamples.push(scriptDetail);
    }
  }
  const inferredLayer2Pct = totalShots > 0 ? layer2Shots / totalShots : 0;
  const detectedOverlayPct = meanNumber(
    rows.map((r) => r.analysis.media_overlay_pct ?? 0),
  );
  const avgMediaOverlay = Math.max(inferredLayer2Pct, detectedOverlayPct);
  const inferredLayer2Mix = [...layer2Counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cue, count]) => {
      const example = layer2Examples.get(cue);
      return `${cue} ${formatPct(count / Math.max(1, totalShots))}${example ? `, e.g. ${example}` : ''}`;
    });
  const firstCaption = rows.find((r) => r.analysis.caption_style?.present)
    ?.analysis.caption_style;
  const captionPreset =
    firstCaption?.preset_label ||
    firstCaption?.matched_preset ||
    firstCaption?.style_label ||
    null;

  const choices = [
    `Layer 1 Media: build the base track from ${mediaMix.join(' · ') || 'mixed full-screen visuals'}.`,
    avgMediaOverlay > 0.04
      ? `Layer 2 Visual overlays: add ${inferredLayer2Mix.join(' · ') || visualOverlayMix.join(' · ') || 'detected/inferred visual overlays'} on about ${formatPct(avgMediaOverlay)} of shots.`
      : 'Layer 2 Visual overlays: keep this mostly empty; references do not rely on graphics/PiP/stickers.',
    captioned > 0 && subtitlePct > 0
      ? `Layer 3 Text/captions: reproduce spoken subtitles on about ${formatPct(subtitlePct)} of shots${captionPreset ? ` with ${captionPreset}` : ''}; do not treat in-image text as caption style.`
      : nonImageTextPct > 0.02
        ? `Layer 3 Text/captions: reproduce independent title/text overlays on about ${formatPct(nonImageTextPct)} of shots; ignore in-image text for caption style.`
        : 'Layer 3 Text/captions: keep text off unless needed for clarity.',
  ];

  const scriptPatterns =
    layer2ScriptExamples.length > 0
      ? [...new Set(layer2ScriptExamples)].slice(0, 5)
      : ['No repeated Layer 2 script trigger detected yet.'];

  const details = rows.map((row) => {
    const a = row.analysis;
    const rowMedia = topDistributionItems(
      [row],
      (analysis) => analysis.clip_type_distribution,
      (kind) => CLIP_META[kind as ClipType]?.label ?? kind.replace(/_/g, ' '),
      2,
    ).join(' · ') || 'mixed media';
    const rowOverlays = topDistributionItems(
      [row],
      (analysis) => analysis.overlay_kind_distribution,
      overlayPresetLabel,
      2,
    ).join(' · ');
    const inferred = row.analysis.shots
      .map(inferredVisualLayerDetail)
      .filter((cue): cue is string => !!cue);
    const inferredCounts = new Map<string, number>();
    for (const cue of inferred) {
      inferredCounts.set(cue, (inferredCounts.get(cue) ?? 0) + 1);
    }
    const inferredMix = [...inferredCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([cue, count]) => `${cue} (${count}/${row.analysis.shots.length})`)
      .join(' · ');
    const cap = a.caption_style?.present
      ? `${a.caption_style.position}, ${a.caption_style.chunking}, ${a.caption_style.animation}`
      : 'no spoken subtitle style';
    const textExamples = row.analysis.shots
      .flatMap((shot) =>
        (shot.text_moments ?? [])
          .filter((m) => m.role !== 'image_text')
          .map((m) => m.text),
      )
      .filter(isMeaningfulLayerText)
      .map((text) => clipText(text, 44))
      .slice(0, 2)
      .join(' · ');
    const rowScriptExamples = row.analysis.shots
      .map(layer2ScriptDetail)
      .filter((item): item is string => !!item)
      .slice(0, 2)
      .join(' · ');
    return `${reelDisplayName(row)}: L1 ${rowMedia}; L2 ${inferredMix || rowOverlays || 'none'}${rowScriptExamples ? `; script map: ${rowScriptExamples}` : ''}; L3 text/captions ${cap}${textExamples ? `; examples: ${textExamples}` : ''}.`;
  });

  return { choices, details, scriptPatterns };
}

function structureSequenceItems(
  analysis: ReelAnalysisResult,
): { range: string; label: string; detail: string }[] {
  if (analysis.shots.length === 0) return [];
  const signatures = analysis.shots.map((shot) => {
    const role = shotRoleLabel(shot);
    const layout = shotLayoutCue(shot);
    return {
      key: `${role}|${layout ?? ''}`,
      role,
      layout,
      shot,
    };
  });
  const groups: { start: number; end: number; role: string; layout: string | null; shot: ReelAnalysisResult['shots'][number] }[] = [];
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i];
    const prev = groups[groups.length - 1];
    if (prev && `${prev.role}|${prev.layout ?? ''}` === sig.key) {
      prev.end = i;
    } else {
      groups.push({
        start: i,
        end: i,
        role: sig.role,
        layout: sig.layout,
        shot: sig.shot,
      });
    }
  }
  return groups.map((group) => {
    const range = group.start === group.end
      ? `shot ${group.start + 1}`
      : `shots ${group.start + 1}-${group.end + 1}`;
    const layout = group.layout ? `, ${group.layout}` : '';
    const visual = group.shot.visual_caption
      ? `Example: ${clipText(group.shot.visual_caption, 86)}`
      : CLIP_META[group.shot.clip_type]?.label ?? group.shot.clip_type;
    return {
      range,
      label: `${group.role}${layout}`,
      detail: visual,
    };
  });
}

function perReelAnalysisRows(
  rows: (LibraryRow & { analysis: ReelAnalysisResult })[],
): {
  url: string;
  label: string;
  tags: ReelTag[];
  metrics: string;
  style: string[];
  content: string[];
  structure: { range: string; label: string; detail: string }[];
}[] {
  return rows.map((row) => {
    const a = row.analysis;
    const clipMix = topDistributionItems([row], (analysis) => analysis.clip_type_distribution, (kind) =>
      CLIP_META[kind as ClipType]?.label ?? kind.replace(/_/g, ' '),
    );
    const overlays = topDistributionItems([row], (analysis) => analysis.overlay_kind_distribution, overlayPresetLabel);
    const motion = topDistributionItems([row], (analysis) => analysis.camera_motion_distribution, (kind) =>
      MOTION_META[kind as CameraMotionKind]?.label ?? kind.replace(/_/g, ' '),
    );
    const sfx = topDistributionItems([row], (analysis) => analysis.sfx_type_distribution, sfxLabel);
    return {
      url: row.url,
      label: reelDisplayName(row),
      tags: row.tags,
      metrics: `${a.shots.length} shots · ${formatSeconds(a.median_shot_ms)} median · ${a.cuts_per_sec.toFixed(2)} cuts/sec`,
      style: [
        `Shot types: ${clipMix.join(' · ') || 'mixed'}`,
        ...captionOutcome([row]),
        `Overlay presets: ${overlays.join(' · ') || 'none detected'}`,
        `Motion: ${motion.join(' · ') || 'static/unknown'}`,
        `SFX: ${a.sfx_per_min.toFixed(1)}/min; ${sfx.join(' · ') || 'no dominant type'}`,
      ],
      content: contentExamples([row]).slice(0, 3),
      structure: structureSequenceItems(a),
    };
  });
}

function editPreviewOutcomes({
  avgShots,
  avgMedianShot,
  dominant,
  contentChoices,
  structureChoices,
  captioned,
  avgSfx,
}: {
  avgShots: number;
  avgMedianShot: number;
  dominant: { label: string; pct: string } | null;
  contentChoices: string[];
  structureChoices: string[];
  captioned: number;
  avgSfx: number;
}): string[] {
  const out = [
    `A ${Math.max(1, Math.round(avgShots))}-shot vertical edit with roughly ${formatSeconds(avgMedianShot)} shots.`,
  ];
  if (dominant) {
    out.push(`Mostly ${dominant.label.toLowerCase()} visuals (${dominant.pct} of style references).`);
  }
  out.push(contentChoices[0] ?? 'B-roll ideas will come from the strongest reference source pattern.');
  const layoutChoice = structureChoices.find((choice) =>
    /\d+\/\d+|layout|overlay|shot/.test(choice),
  );
  if (layoutChoice) out.push(layoutChoice);
  out.push(
    captioned > 0
      ? 'Captions will mirror the detected reference caption style.'
      : 'Captions will stay minimal unless the edit needs them.',
  );
  out.push(
    avgSfx > 8
      ? 'Sound design will use frequent hits on cuts and emphasis beats.'
      : avgSfx > 0
        ? 'Sound design will use selective hits on important beats.'
        : 'Sound design will stay minimal.',
  );
  return out;
}

function InspirationAnalysisPanel({
  library,
}: {
  library: LibraryRow[];
}): React.JSX.Element | null {
  const ready = library.filter(
    (r): r is LibraryRow & { analysis: ReelAnalysisResult } =>
      r.status === 'ready' && !!r.analysis,
  );
  if (ready.length === 0) return null;

  const styleRows = ready.filter((r) => r.tags.includes('style_reference'));
  const contentRows = ready.filter((r) => r.tags.includes('content_reference'));
  const structureRows = ready.filter((r) =>
    r.tags.includes('structure_reference'),
  );
  const metricsRows = styleRows.length > 0 ? styleRows : ready;
  const contentSourceRows = contentRows.length > 0 ? contentRows : ready;
  const dominant = dominantClipType(metricsRows);
  const avgShots = meanNumber(metricsRows.map((r) => r.analysis.shots.length));
  const avgMedianShot = meanNumber(
    metricsRows.map((r) => r.analysis.median_shot_ms),
  );
  const avgCuts = meanNumber(metricsRows.map((r) => r.analysis.cuts_per_sec));
  const avgTalking = meanNumber(metricsRows.map((r) => r.analysis.talking_pct));
  const avgBroll = meanNumber(metricsRows.map((r) => r.analysis.broll_pct));
  const avgText = meanNumber(
    metricsRows.map((r) => r.analysis.text_overlay_pct),
  );
  const avgMediaOverlay = meanNumber(
    metricsRows.map((r) => r.analysis.media_overlay_pct ?? 0),
  );
  const avgSfx = meanNumber(metricsRows.map((r) => r.analysis.sfx_per_min ?? 0));
  const captioned = metricsRows.filter(
    (r) => r.analysis.caption_style?.present,
  ).length;
  const hooks = hookExamples(metricsRows);
  const shotMix = topDistributionItems(
    metricsRows,
    (analysis) => analysis.clip_type_distribution,
    (kind) => CLIP_META[kind as ClipType]?.label ?? kind.replace(/_/g, ' '),
  );
  const overlayMix = topDistributionItems(
    metricsRows,
    (analysis) => analysis.overlay_kind_distribution,
    overlayPresetLabel,
  );
  const motionMix = topDistributionItems(
    metricsRows,
    (analysis) => analysis.camera_motion_distribution,
    (kind) => MOTION_META[kind as CameraMotionKind]?.label ?? kind.replace(/_/g, ' '),
  );
  const sfxMix = topDistributionItems(
    metricsRows,
    (analysis) => analysis.sfx_type_distribution,
    sfxLabel,
  );
  const captionDetails = captionOutcome(metricsRows);
  const contentDetails = contentExamples(contentSourceRows);
  const structureDetails = structureShotRecipe(
    structureRows.length > 0 ? structureRows : ready,
  );
  const contentSourceSummary = contentSourceOutcomes(contentSourceRows);
  const structureSourceRows = structureRows.length > 0 ? structureRows : ready;
  const layoutSummary = layoutOutcomes(structureSourceRows);
  const consistentStructure = consistentShotStructureOutcomes(structureSourceRows);
  const layerSummary = layerOutcomes(metricsRows);
  const styleChoices = [
    dominant
      ? `Use ${dominant.label.toLowerCase()} as the main on-screen format.`
      : 'Use a mixed on-screen format.',
    avgCuts >= 0.65
      ? 'Cut quickly and avoid long holds.'
      : avgCuts >= 0.35
        ? 'Use a steady cut rhythm.'
        : 'Let shots breathe with longer holds.',
    captioned > 0
      ? 'Match the detected caption preset and placement.'
      : 'Do not force burned-in spoken captions.',
    avgSfx > 8
      ? 'Use frequent sound hits on cuts and emphasis beats.'
      : avgSfx > 0
        ? 'Use selective sound hits, not every cut.'
        : 'Keep sound design minimal.',
  ];
  const contentChoices = [
    ...contentSourceSummary.choices,
  ];
  const structureChoices = [
    structureRows.length > 0
      ? `Follow ${structureRows.length} structure-tagged reference${structureRows.length === 1 ? '' : 's'}.`
      : 'Infer structure from all ready references.',
    `Target about ${avgShots.toFixed(0)} shots with ${formatSeconds(avgMedianShot)} median shots.`,
    ...consistentStructure.choices,
    'Preserve run-level patterns like no-talking sequences, talking-head returns, and CTA endings.',
  ];
  const patternReview = [
    `Source pattern: ${contentSourceSummary.details.slice(0, 2).join(' · ') || 'No dominant content source detected yet.'}`,
    `Shot structure: ${consistentStructure.choices.slice(0, 2).join(' · ') || 'No single repeated shot layout dominates.'}`,
    `Layout mix: ${layoutSummary.details.slice(0, 2).join(' · ') || 'No dominant layout detected yet.'}`,
    `Layering: ${layerSummary.choices.join(' ')}`,
    `Style mix: ${shotMix.join(' · ') || 'mixed'}; ${captioned}/${metricsRows.length} references use captions; SFX ${avgSfx.toFixed(1)}/min.`,
  ];
  const editPreview = editPreviewOutcomes({
    avgShots,
    avgMedianShot,
    dominant,
    contentChoices,
    structureChoices,
    captioned,
    avgSfx,
  });

  return (
    <section className="inspiration-analysis">
      <div className="ia-head">
        <div>
          <div className="eyebrow">After hydration</div>
          <h2>Edit analysis</h2>
        </div>
        <div className="ia-ready">
          {ready.length}/{library.length} ready
        </div>
      </div>

      <div className="ia-grid">
        <div className="ia-card ia-card-wide">
          <span>Pacing model</span>
          <strong>
            {avgShots.toFixed(1)} shots/reel · {formatSeconds(avgMedianShot)} median
          </strong>
          <p>
            The planner will use this to choose shot count and cut spacing
            before snapping cuts to your target transcript.
          </p>
        </div>
        <div className="ia-card">
          <span>Cuts</span>
          <strong>{avgCuts.toFixed(2)}/sec</strong>
          <p>{avgCuts >= 0.65 ? 'Fast-cut rhythm' : avgCuts >= 0.35 ? 'Steady rhythm' : 'Slower holds'}</p>
        </div>
        <div className="ia-card">
          <span>Screen mix</span>
          <strong>{dominant ? `${dominant.label} ${dominant.pct}` : 'Mixed'}</strong>
          <p>
            {formatPct(avgTalking)} talking · {formatPct(avgBroll)} b-roll
          </p>
        </div>
        <div className="ia-card">
          <span>Text + overlays</span>
          <strong>{formatPct(avgText)} text</strong>
          <p>{formatPct(avgMediaOverlay)} media overlays</p>
        </div>
        <div className="ia-card">
          <span>Sound design</span>
          <strong>{avgSfx.toFixed(1)} SFX/min</strong>
          <p>{captioned}/{metricsRows.length} reels with caption style</p>
        </div>
      </div>

      {hooks.length > 0 && (
        <div className="ia-hooks">
          <span>Hook examples</span>
          {hooks.map((hook) => (
            <q key={hook}>{hook}</q>
          ))}
        </div>
      )}

      <div className="ia-outcomes">
        <div className="ia-outcome">
          <b>Style outcome</b>
          <ul>
            {styleChoices.map((choice) => (
              <li key={choice}>{choice}</li>
            ))}
          </ul>
          <details className="ia-readmore">
            <summary>Read more</summary>
            <ul>
              <li>Shot types: {shotMix.join(' · ') || 'mixed'}</li>
              {captionDetails.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
              <li>Overlay presets: {overlayMix.join(' · ') || 'none detected'}</li>
              <li>Motion: {motionMix.join(' · ') || 'static/unknown'}</li>
              <li>SFX: {avgSfx.toFixed(1)}/min; {sfxMix.join(' · ') || 'no dominant type'}</li>
            </ul>
          </details>
        </div>
        <div className="ia-outcome">
          <b>Layer outcome</b>
          <ul>
            {layerSummary.choices.map((choice) => (
              <li key={choice}>{choice}</li>
            ))}
          </ul>
          <details className="ia-readmore">
            <summary>Read more</summary>
            <ul>
              {layerSummary.scriptPatterns.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
              {layerSummary.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </details>
        </div>
        <div className="ia-outcome">
          <b>Content outcome</b>
          <ul>
            {contentChoices.map((choice) => (
              <li key={choice}>{choice}</li>
            ))}
          </ul>
          <details className="ia-readmore">
            <summary>Read more</summary>
            <ul>
              <li>
                Sources: {contentSourceRows.slice(0, 3).map((r) => reelDisplayName(r)).join(', ')}.
              </li>
              {contentSourceSummary.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
              {contentDetails.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </details>
        </div>
        <div className="ia-outcome">
          <b>Structure outcome</b>
          <ul>
            {structureChoices.map((choice) => (
              <li key={choice}>{choice}</li>
            ))}
          </ul>
          <details className="ia-readmore">
            <summary>Read more</summary>
            <ul>
              <li>
                Source: {structureRows.length > 0
                  ? `${structureRows.length} structure-tagged reel${structureRows.length === 1 ? '' : 's'}`
                  : 'ready reels fallback'}
              </li>
              <li>
                Pacing: {avgShots.toFixed(1)} shots/reel, {formatSeconds(avgMedianShot)} median shot, {avgCuts.toFixed(2)} cuts/sec.
              </li>
              {consistentStructure.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
              {layoutSummary.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
              {structureDetails.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </details>
        </div>
      </div>

      <div className="ia-pattern-review">
        <div className="ia-section-title">
          <span>Overall pattern review</span>
          <small>Collection-level patterns the planner will carry into the edit.</small>
        </div>
        <div className="ia-review-grid">
          <div className="ia-review-card">
            <b>Patterns found</b>
            <ul>
              {patternReview.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="ia-review-card">
            <b>What the edit will show</b>
            <ul>
              {editPreview.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="ia-review-card">
            <b>Layer plan</b>
            <ul>
              {layerSummary.choices.map((item) => (
                <li key={item}>{item}</li>
              ))}
              {layerSummary.scriptPatterns.slice(0, 3).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
        <details className="ia-all-reels">
          <summary>Read more</summary>
          <ul>
            {layerSummary.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
            {layerSummary.scriptPatterns.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
            {consistentStructure.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
            {contentSourceSummary.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
            {layoutSummary.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
            {structureDetails.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}

function targetFromPlanMeta(meta: PlanListEntry | null | undefined): TargetInput | null {
  if (!meta) return null;
  if (meta.target_kind === 'reel_url' && meta.target_label.trim()) {
    return { kind: 'reel_url', url: meta.target_label.trim() };
  }
  if (
    meta.target_kind === 'local_video' &&
    meta.target_file_path &&
    meta.target_file_path.trim()
  ) {
    return { kind: 'local_video', filePath: meta.target_file_path };
  }
  return null;
}

function targetFromExistingPlan(plan: SuggestedEdit | null): TargetInput | null {
  const text = plan?.shots
    .map((shot) => shot.spoken_during.trim())
    .filter(Boolean)
    .join(' ');
  return text ? { kind: 'script', text } : null;
}

interface WorkflowViewProps {
  stage: Stage;
  setStage: (s: Stage) => void;
  setStageDone: (s: Stage, done: boolean) => void;
}

/** Shared context for the inner timeline so the plan top bar's
 *  "Curate library" + "Preview reel" buttons can reach the
 *  curate handler from the parent workflow. */
interface PlanTopActions {
  onCurateAll: (force?: boolean, userPrompt?: string) => Promise<void>;
  onFilterExistingScreenshots: () => Promise<void>;
  onRegeneratePlan: (details: string) => Promise<void>;
  onRegenerateShotIdea: (shotIdx: number, details: string) => Promise<void>;
  onRegenerateAllShotIdeas: (details: string) => Promise<void>;
  /** Cancel the in-flight bulk library curation. */
  onStop: () => void;
  curating: boolean;
  regeneratingPlan: boolean;
  agentRunningElsewhere: boolean;
  canRegeneratePlan: boolean;
  curatingProgress?: { completed: number; total: number };
  onPreview: () => void;
}

/** Stage navigation surfaced inside the detail box's media header. */
interface StageNav {
  onBack: () => void;
  backLabel: string;
  onNext?: () => void;
  nextLabel?: string;
}

/** Per-shot live agent activity surfaced under the media pane. Bundles
 *  the streaming state from window.api.onCuratorTurn / onCuratorClarification
 *  plus the callbacks for the inline reply flow. */
interface AgentActivity {
  turnsByShot: Map<number, CuratorTurnEvent[]>;
  expandedShots: Set<number>;
  toggleShotExpanded: (shotIdx: number) => void;
  pendingClarifications: Map<number, CuratorClarificationRequest>;
  clarificationTyping: Map<string, string>;
  setClarificationTyping: React.Dispatch<
    React.SetStateAction<Map<string, string>>
  >;
  answerClarification: (
    req: CuratorClarificationRequest,
    answer: string,
  ) => Promise<void>;
}

type ProjectStatusKind =
  | 'empty'
  | 'ready'
  | 'planning'
  | 'planned'
  | 'agent'
  | 'needs_input'
  | 'done'
  | 'error';

interface ProjectStatus {
  kind: ProjectStatusKind;
  label: string;
}

interface WorkflowProject {
  id: string;
  title: string;
  createdAt: number;
  stage: Stage;
  busy: Busy;
  targetMode: TargetMode;
  targetUrl: string;
  targetScript: string;
  targetFile: string | null;
  targetVideoUrl: string | null;
  targetPreviewVideoPath: string | null;
  planTarget: TargetInput | null;
  plan: SuggestedEdit | null;
  curation: CurationResult | null;
  progress: { completed: number; total: number; latest?: ShotCuration } | null;
  synthProgress: SynthesizeProgress | null;
  turnsByShot: Map<number, CuratorTurnEvent[]>;
  expandedShots: Set<number>;
  pendingClarifications: Map<number, CuratorClarificationRequest>;
  clarificationTyping: Map<string, string>;
  status: ProjectStatus;
}

function blankProject(title = 'Untitled reel'): WorkflowProject {
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: Date.now(),
    stage: 'inspire',
    busy: null,
    targetMode: 'local_video',
    targetUrl: '',
    targetScript: '',
    targetFile: null,
    targetVideoUrl: null,
    targetPreviewVideoPath: null,
    planTarget: null,
    plan: null,
    curation: null,
    progress: null,
    synthProgress: null,
    turnsByShot: new Map(),
    expandedShots: new Set(),
    pendingClarifications: new Map(),
    clarificationTyping: new Map(),
    status: { kind: 'empty', label: 'No target' },
  };
}

function projectFromFile(filePath: string): WorkflowProject {
  const p = blankProject(topicFromPath(filePath));
  return {
    ...p,
    stage: 'target',
    targetFile: filePath,
    status: { kind: 'ready', label: 'Ready to plan' },
  };
}

function projectTargetReady(project: WorkflowProject): boolean {
  return (
    (project.targetMode === 'reel_url' && project.targetUrl.trim().length > 0) ||
    (project.targetMode === 'script' && project.targetScript.trim().length > 0) ||
    (project.targetMode === 'local_video' && project.targetFile !== null)
  );
}

function projectStepProgress(
  project: WorkflowProject,
  readyInspirationCount: number,
): StageProgress {
  return {
    inspire: readyInspirationCount > 0,
    target: projectTargetReady(project),
    plan: project.plan !== null,
    review: project.curation !== null,
  };
}

function projectStatusStage(project: WorkflowProject): Stage {
  if (project.curation) return 'review';
  if (
    project.plan ||
    project.status.kind === 'planned' ||
    project.status.kind === 'agent' ||
    project.status.kind === 'needs_input'
  ) {
    return 'plan';
  }
  if (projectTargetReady(project)) return 'target';
  return 'inspire';
}

function topicFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? 'Untitled reel';
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 44) || 'Untitled reel';
}

function topicFromPlan(plan: SuggestedEdit | null, fallback: string): string {
  const text =
    plan?.structure_sections?.[0]?.target_fill ||
    plan?.shots
      ?.map((shot) => shot.spoken_during)
      .join(' ')
      .trim() ||
    fallback;
  return topicFromText(text, fallback);
}

function topicFromText(text: string, fallback: string): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\w\s'$-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  const stop = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'to',
    'of',
    'in',
    'on',
    'for',
    'with',
    'this',
    'that',
    'is',
    'are',
    'was',
    'were',
    'you',
    'your',
    'we',
    'our',
    'i',
  ]);
  const words = cleaned
    .split(' ')
    .filter((word) => word.length > 2 && !stop.has(word.toLowerCase()))
    .slice(0, 5);
  return (words.length ? words : cleaned.split(' ').slice(0, 5)).join(' ');
}

function computeProjectStatus(input: {
  busy: Busy;
  targetReady: boolean;
  plan: SuggestedEdit | null;
  curation: CurationResult | null;
  progress: { completed: number; total: number; latest?: ShotCuration } | null;
  pendingClarifications: Map<number, CuratorClarificationRequest>;
  error: string | null;
}): ProjectStatus {
  if (input.pendingClarifications.size > 0) {
    return { kind: 'needs_input', label: 'Task needed' };
  }
  if (input.busy === 'curating') {
    const suffix = input.progress
      ? ` ${input.progress.completed}/${input.progress.total}`
      : '';
    return { kind: 'agent', label: `Agent running${suffix}` };
  }
  if (input.busy === 'synthesizing') {
    return { kind: 'planning', label: 'Planning' };
  }
  if (input.busy === 'batch_synthesizing') {
    return { kind: 'planning', label: 'Batch planning' };
  }
  if (input.error) {
    return { kind: 'error', label: 'Needs attention' };
  }
  if (input.curation) {
    return { kind: 'done', label: 'Curated' };
  }
  if (input.plan) {
    return { kind: 'planned', label: 'Plan ready' };
  }
  if (input.targetReady) {
    return { kind: 'ready', label: 'Ready to plan' };
  }
  return { kind: 'empty', label: 'No target' };
}

function WorkflowView({
  stage,
  setStage,
  setStageDone,
}: WorkflowViewProps): React.JSX.Element {
  const [library, setLibrary] = useState<LibraryRow[]>([]);
  // Named collections of inspiration reels. `library` always reflects the
  // ACTIVE collection's reels; switching swaps the list. Each collection
  // is fingerprinted independently when you synthesize.
  const [collections, setCollections] = useState<Collection[]>([]);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(
    null,
  );
  const [renameDraft, setRenameDraft] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftTags, setDraftTags] = useState<ReelTag[]>(['content_reference']);

  const [targetMode, setTargetMode] = useState<TargetMode>('reel_url');
  const [targetUrl, setTargetUrl] = useState('');
  const [targetScript, setTargetScript] = useState('');
  const [targetFile, setTargetFile] = useState<string | null>(null);
  const [targetVideoUrl, setTargetVideoUrl] = useState<string | null>(null);
  const [targetPreviewVideoPath, setTargetPreviewVideoPath] = useState<string | null>(null);
  const [planTarget, setPlanTarget] = useState<TargetInput | null>(null);
  const [allowCopyrightedMedia, setAllowCopyrightedMedia] = useState(false);
  const [userInstructions, setUserInstructions] = useState('');

  const [plan, setPlan] = useState<SuggestedEdit | null>(null);
  const [curation, setCuration] = useState<CurationResult | null>(null);
  // Media the user pasted into the app (clipboard image/video). Global,
  // persisted in main; surfaced in every plan's media library.
  const [pastedMedia, setPastedMedia] = useState<PastedMediaEntry[]>([]);
  // Brief confirmation banner after a paste lands.
  const [pasteToast, setPasteToast] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
    latest?: ShotCuration;
  } | null>(null);
  const [synthProgress, setSynthProgress] = useState<SynthesizeProgress | null>(
    null,
  );
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    title: string;
  } | null>(null);
  /** Full turn history per shot. The agent emits twice per turn (pre +
   *  post tool execution, same turn number) — we de-dup by `turn` so
   *  the post-emission overwrites the pre-emission. Anything with a
   *  new turn number gets appended. This lets the UI show either the
   *  latest snapshot (collapsed) OR the whole chain (expanded). */
  const [turnsByShot, setTurnsByShot] = useState<
    Map<number, CuratorTurnEvent[]>
  >(() => new Map());
  /** Per-shot "show full history" toggle. When a shot's idx is in
   *  this set, the agent-activity panel renders every turn for that
   *  shot instead of just the latest. */
  const [expandedShots, setExpandedShots] = useState<Set<number>>(
    () => new Set(),
  );
  /** Pending ask_user_clarification requests, keyed by shot_idx. Each
   *  entry is rendered as an inline panel with option buttons; clicking
   *  one calls window.api.replyCuratorClarification(...) and removes
   *  the entry, which unblocks the parked agent loop in main. */
  const [pendingClarifications, setPendingClarifications] = useState<
    Map<number, CuratorClarificationRequest>
  >(() => new Map());
  /** Per-request "the user clicked a 'No' option and is typing a
   *  custom answer" state. Keyed by request_id so two concurrent
   *  clarifications don't clobber each other. */
  const [clarificationTyping, setClarificationTyping] = useState<
    Map<string, string>
  >(() => new Map());
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [pastPlans, setPastPlans] = useState<PlanListEntry[]>([]);
  const [remixProfiles, setRemixProfiles] = useState<RemixProfile[]>([]);
  const [selectedRemixProfileId, setSelectedRemixProfileId] = useState('');
  const selectedRemixProfile =
    remixProfiles.find((p) => p.id === selectedRemixProfileId) ?? null;
  const currentPlanProfile = plan?.reel_id
    ? remixProfiles.find((p) => p.reel_id === plan.reel_id)
    : null;
  const [projects, setProjects] = useState<WorkflowProject[]>(() => {
    const p = blankProject('Untitled reel');
    return [p];
  });
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const activeProjectIdRef = React.useRef<string | null>(activeProjectId);
  const synthJobProjectIdRef = React.useRef<string | null>(null);
  const curateJobProjectIdRef = React.useRef<string | null>(null);

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  // Subscribe to curate progress events. Each completed shot is
  // upserted into the curation state immediately so its clips render
  // without waiting for the whole bulk run to resolve.
  useEffect(() => {
    const unsubscribe = window.api.onCurateProgress(
      ({ curation: c, completed, total }) => {
        const projectId = curateJobProjectIdRef.current;
        if (projectId) {
          setProjects((prev) =>
            prev.map((project) =>
              project.id === projectId
                ? {
                    ...project,
                    progress: { completed, total, latest: c },
                    curation: upsertShotCuration(project.curation, c),
                    status: {
                      kind: 'agent',
                      label: `Agent running ${completed}/${total}`,
                    },
                  }
                : project,
            ),
          );
        }
        if (!projectId || activeProjectIdRef.current === projectId) {
          setProgress({ completed, total, latest: c });
          setCuration((prev) => upsertShotCuration(prev, c));
        }
      },
    );
    return unsubscribe;
  }, []);

  // Load previously-pasted media on mount.
  useEffect(() => {
    if (typeof window.api?.listPastedMedia !== 'function') return;
    window.api
      .listPastedMedia()
      .then((items) => setPastedMedia(items))
      .catch(() => {
        /* best-effort */
      });
  }, []);

  // Paste-to-add: any image/video on the clipboard is saved and added
  // to the media library automatically. Ignores pastes while typing in a
  // text field (so Cmd+V into a prompt box still works normally).
  useEffect(() => {
    if (typeof window.api?.savePastedMedia !== 'function') return;
    const onPaste = async (e: ClipboardEvent): Promise<void> => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const items = Array.from(e.clipboardData?.items ?? []);
      const mediaItems = items.filter(
        (it) =>
          it.kind === 'file' &&
          (it.type.startsWith('image/') || it.type.startsWith('video/')),
      );
      if (mediaItems.length === 0) return;
      e.preventDefault();
      let added = 0;
      for (const it of mediaItems) {
        const file = it.getAsFile();
        if (!file) continue;
        try {
          const buf = await file.arrayBuffer();
          let binary = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const data = btoa(binary);
          const res = await window.api.savePastedMedia({
            data,
            mime: file.type,
            name: file.name || null,
          });
          if ('entry' in res) {
            setPastedMedia((prev) =>
              prev.some((p) => p.id === res.entry.id)
                ? prev
                : [res.entry, ...prev],
            );
            added++;
          } else {
            setError(res.error);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      if (added > 0) {
        setPasteToast(
          `Added ${added} pasted ${added === 1 ? 'item' : 'items'} to your media library.`,
        );
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // Auto-dismiss the paste confirmation toast.
  useEffect(() => {
    if (!pasteToast) return;
    const t = window.setTimeout(() => setPasteToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [pasteToast]);

  // Subscribe to streaming per-shot partials: candidates appear as
  // soon as a shot's research lands, and each candidate's footage
  // (recording / screenshots) fills in as its capture finishes.
  // Guarded for stale preload bundles that predate the channel.
  useEffect(() => {
    if (typeof window.api?.onCurateShotPartial !== 'function') {
      return undefined;
    }
    const unsubscribe = window.api.onCurateShotPartial(({ curation: c }) => {
      const projectId = curateJobProjectIdRef.current;
      if (projectId) {
        setProjects((prev) =>
          prev.map((project) =>
            project.id === projectId
              ? { ...project, curation: upsertShotCuration(project.curation, c) }
              : project,
          ),
        );
      }
      if (!projectId || activeProjectIdRef.current === projectId) {
        setCuration((prev) => upsertShotCuration(prev, c));
      }
    });
    return unsubscribe;
  }, []);

  // Subscribe to synthesis progress events (milestones + streaming).
  useEffect(() => {
    const unsubscribe = window.api.onSynthesizeProgress((p) => {
      const projectId = synthJobProjectIdRef.current;
      if (projectId) {
        setProjects((prev) =>
          prev.map((project) =>
            project.id === projectId ? { ...project, synthProgress: p } : project,
          ),
        );
      }
      if (!projectId || activeProjectIdRef.current === projectId) {
        setSynthProgress(p);
      }
    });
    return unsubscribe;
  }, []);

  // Load the list of past synthesized plans on mount.
  const refreshPastPlans = React.useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.listCachedPlans();
      setPastPlans(list);
    } catch {
      /* listing is best-effort */
    }
  }, []);
  useEffect(() => {
    refreshPastPlans();
  }, [refreshPastPlans]);

  const refreshRemixProfiles = React.useCallback(async (): Promise<void> => {
    try {
      const profiles = await window.api.listRemixProfiles();
      setRemixProfiles(profiles);
    } catch {
      /* listing is best-effort */
    }
  }, []);
  useEffect(() => {
    refreshRemixProfiles();
  }, [refreshRemixProfiles]);

  const loadPastPlan = async (key: string): Promise<void> => {
    if (!key) return;
    setError(null);
    try {
      const loaded = await window.api.loadCachedPlan(key);
      if (!loaded) {
        setError('Cached plan not found (may have been deleted).');
        return;
      }
      // Clear any in-flight curator state from a prior session so the
      // freshly-loaded plan starts clean. Stale Map shapes (turn
      // history schema changes, HMR-preserved state, etc.) have
      // crashed render here before — wiping unconditionally is safe.
      setTurnsByShot(new Map());
      setExpandedShots(new Set());
      setPendingClarifications(new Map());
      setClarificationTyping(new Map());
      setProgress(null);
      setSynthProgress(null);
      setBusy(null);
      const planWithId: SuggestedEdit = loaded.plan.reel_id
        ? loaded.plan
        : { ...loaded.plan, reel_id: crypto.randomUUID() };
      setPlan(planWithId);
      if (!loaded.plan.reel_id) {
        void window.api.savePlan(planWithId);
      }
      setPlanTarget(targetFromPlanMeta(loaded.meta));
      // Restore the local target video so reel-mode narration audio + export
      // have an audio bed. Prefer the original source file recorded in meta;
      // setting targetFile re-prepares the preview video (cached/idempotent)
      // and re-resolves targetVideoUrl. Plans without a local target
      // (reel_url / script, or older plans missing the path) stay silent.
      if (
        loaded.meta?.target_kind === 'local_video' &&
        loaded.meta.target_file_path
      ) {
        setTargetPreviewVideoPath(null);
        setTargetFile(loaded.meta.target_file_path);
      } else {
        setTargetFile(null);
        setTargetVideoUrl(null);
        setTargetPreviewVideoPath(planWithId.target_video_path ?? null);
      }
      if (loaded.meta) {
        setAllowCopyrightedMedia(loaded.meta.allow_copyrighted);
        setUserInstructions(loaded.meta.user_instructions);
      }
      // Restore companion curation when one exists for this plan.
      // The curation cache is content-keyed off plan.shots, so if the
      // plan hasn't been edited since curation was saved, this is the
      // same set of candidates the user saw last time.
      setCuration(loaded.curation ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Subscribe to per-turn curator activity (which shot is on which
  // turn doing what tool calls). Each turn fires twice (pre + post
  // tool execution); we dedupe by `turn` so the post-emission with
  // result_summary replaces the pre-emission inline.
  useEffect(() => {
    const unsubscribe = window.api.onCuratorTurn((event) => {
      const projectId = curateJobProjectIdRef.current;
      const mergeTurn = (prev: Map<number, CuratorTurnEvent[]>) => {
        const next = new Map(prev);
        const existing = next.get(event.shot_idx) ?? [];
        const sameTurnIdx = existing.findIndex((t) => t.turn === event.turn);
        if (sameTurnIdx >= 0) {
          const updated = existing.slice();
          updated[sameTurnIdx] = event;
          next.set(event.shot_idx, updated);
        } else {
          next.set(event.shot_idx, [...existing, event]);
        }
        return next;
      };
      if (projectId) {
        setProjects((prev) =>
          prev.map((project) =>
            project.id === projectId
              ? { ...project, turnsByShot: mergeTurn(project.turnsByShot) }
              : project,
          ),
        );
      }
      if (!projectId || activeProjectIdRef.current === projectId) {
        setTurnsByShot(mergeTurn);
      }
    });
    return unsubscribe;
  }, []);

  const toggleShotExpanded = React.useCallback((shotIdx: number): void => {
    setExpandedShots((prev) => {
      const next = new Set(prev);
      if (next.has(shotIdx)) next.delete(shotIdx);
      else next.add(shotIdx);
      return next;
    });
  }, []);

  // Subscribe to ask_user_clarification requests from the curator.
  // Each request parks the agent in the main process until the user
  // clicks an option and we invoke replyCuratorClarification.
  useEffect(() => {
    const unsubscribe = window.api.onCuratorClarification((req) => {
      const projectId = curateJobProjectIdRef.current;
      const addRequest = (prev: Map<number, CuratorClarificationRequest>) => {
        const next = new Map(prev);
        next.set(req.shot_idx, req);
        return next;
      };
      if (projectId) {
        setProjects((prev) =>
          prev.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  pendingClarifications: addRequest(project.pendingClarifications),
                  status: { kind: 'needs_input', label: 'Task needed' },
                }
              : project,
          ),
        );
      }
      if (!projectId || activeProjectIdRef.current === projectId) {
        setPendingClarifications(addRequest);
      }
    });
    return unsubscribe;
  }, []);

  const answerClarification = React.useCallback(
    async (req: CuratorClarificationRequest, answer: string): Promise<void> => {
      // Optimistically remove the panel so it doesn't double-fire if
      // the user double-clicks; if the reply fails we'll get a fresh
      // request from the main process on the next ask.
      setPendingClarifications((prev) => {
        const next = new Map(prev);
        next.delete(req.shot_idx);
        return next;
      });
      // Also drop any in-progress typing buffer for this request.
      setClarificationTyping((prev) => {
        if (!prev.has(req.request_id)) return prev;
        const next = new Map(prev);
        next.delete(req.request_id);
        return next;
      });
      try {
        await window.api.replyCuratorClarification({
          request_id: req.request_id,
          answer,
        });
      } catch (err) {
        // Silent — main will reject the pending promise; the agent
        // will get clarification_aborted and fall back to its own
        // judgment.
        console.error('[clarification reply failed]', err);
      }
    },
    [],
  );

  // Load a collection's reels into `library` as pending rows, then fill
  // cached analyses (fast disk read; cache hits show 'ready' without
  // re-analyzing). Shared by initial load and collection switching.
  const applyCollectionReels = React.useCallback(
    async (reels: { url: string; tags: ReelTag[] }[]) => {
      const rows: LibraryRow[] = reels.map((r) => ({
        url: r.url,
        tags: r.tags,
        status: 'pending',
      }));
      setLibrary(rows);
      const updates = await Promise.all(
        reels.map(async (r) => ({
          url: r.url,
          analysis: await window.api.loadCachedAnalysis(r.url),
        })),
      );
      setLibrary((prev) =>
        prev.map((row) => {
          const u = updates.find((x) => x.url === row.url);
          return u && u.analysis
            ? { ...row, status: 'ready', from_cache: true, analysis: u.analysis }
            : row;
        }),
      );
    },
    [],
  );

  // On mount: load collections (migrates the legacy flat library on first
  // run), activate the first, and load its reels.
  const initialLoadDone = React.useRef(false);
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    (async () => {
      const cols = await window.api.listCollections();
      setCollections(cols);
      const active = cols[0] ?? null;
      if (active) {
        setActiveCollectionId(active.id);
        setRenameDraft(active.name);
        await applyCollectionReels(active.reels);
      }
    })();
  }, [applyCollectionReels]);

  // Auto-save the active collection's reels (URLs + tags) on change.
  // Mirror the same slim list into `collections` so switching away and
  // back restores this session's edits instead of the at-launch snapshot
  // (which the auto-save would then persist, deleting reels added since).
  useEffect(() => {
    if (!initialLoadDone.current || !activeCollectionId) return;
    const slim = library.map((r) => ({ url: r.url, tags: r.tags }));
    setCollections((prev) =>
      prev.map((c) => (c.id === activeCollectionId ? { ...c, reels: slim } : c)),
    );
    window.api.saveCollectionReels(activeCollectionId, slim).catch(() => {
      /* best-effort; surface error elsewhere if it matters */
    });
  }, [library, activeCollectionId]);

  // Switch the active collection — persist nothing here (the active
  // collection was already auto-saved); just load the target's reels.
  const switchCollection = (id: string): void => {
    if (id === activeCollectionId) return;
    const col = collections.find((c) => c.id === id);
    if (!col) return;
    setActiveCollectionId(id);
    setRenameDraft(col.name);
    void applyCollectionReels(col.reels);
  };

  const createCollectionHandler = async (): Promise<void> => {
    const col = await window.api.createCollection('New collection');
    setCollections((prev) => [...prev, col]);
    setActiveCollectionId(col.id);
    setRenameDraft(col.name);
    void applyCollectionReels(col.reels);
  };

  const commitRename = (): void => {
    if (!activeCollectionId) return;
    const name = renameDraft.trim();
    if (!name) return;
    setCollections((prev) =>
      prev.map((c) => (c.id === activeCollectionId ? { ...c, name } : c)),
    );
    void window.api.renameCollection(activeCollectionId, name);
  };

  const deleteCollectionHandler = async (): Promise<void> => {
    if (!activeCollectionId || collections.length <= 1) return;
    const next = await window.api.deleteCollection(activeCollectionId);
    setCollections(next);
    const active = next[0] ?? null;
    if (active) {
      setActiveCollectionId(active.id);
      setRenameDraft(active.name);
      void applyCollectionReels(active.reels);
    }
  };

  const addReel = (): void => {
    const url = draftUrl.trim();
    if (!url) return;
    if (library.some((r) => r.url === url)) {
      setError(`Already in library: ${url}`);
      return;
    }
    setLibrary([...library, { url, tags: [...draftTags], status: 'pending' }]);
    setDraftUrl('');
    setError(null);
  };

  const removeReel = (url: string): void => {
    setLibrary(library.filter((r) => r.url !== url));
  };

  const toggleTag = (url: string, tag: ReelTag): void => {
    setLibrary(
      library.map((r) => {
        if (r.url !== url) return r;
        const hasTag = r.tags.includes(tag);
        return {
          ...r,
          tags: hasTag ? r.tags.filter((t) => t !== tag) : [...r.tags, tag],
        };
      }),
    );
  };

  const hydrate = async (): Promise<void> => {
    setBusy('hydrating');
    setError(null);
    const pending = library
      .filter((r) => r.status !== 'ready')
      .map((r) => r.url);
    const CONCURRENCY = 3;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const url = pending[next++];
        setLibrary((prev) =>
          prev.map((r) => (r.url === url ? { ...r, status: 'hydrating' } : r)),
        );
        try {
          const result = await window.api.hydrateLibraryReel(url);
          setLibrary((prev) =>
            prev.map((r) =>
              r.url === url
                ? 'error' in result
                  ? { ...r, status: 'error', error: result.error }
                  : {
                      ...r,
                      status: 'ready',
                      from_cache: result.from_cache,
                      caption_text: result.caption_text ?? r.caption_text ?? null,
                      analysis: result.analysis,
                    }
                : r,
            ),
          );
        } catch (e) {
          setLibrary((prev) =>
            prev.map((r) =>
              r.url === url
                ? {
                    ...r,
                    status: 'error',
                    error: e instanceof Error ? e.message : String(e),
                  }
                : r,
            ),
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker),
    );
    setBusy(null);
  };

  // Re-run the analyzer for a single library reel, bypassing the on-disk
  // cache (force=true). Lets users refresh one reel to pick up analyzer
  // changes — e.g. the subtitle-style detection — without re-hydrating the
  // whole library or bumping ANALYSIS_VERSION.
  const reanalyzeReel = async (url: string): Promise<void> => {
    setError(null);
    setLibrary((prev) =>
      prev.map((r) => (r.url === url ? { ...r, status: 'hydrating' } : r)),
    );
    try {
      const result = await window.api.hydrateLibraryReel(url, true);
      setLibrary((prev) =>
        prev.map((r) =>
          r.url === url
            ? 'error' in result
              ? { ...r, status: 'error', error: result.error }
              : {
                  ...r,
                  status: 'ready',
                  from_cache: result.from_cache,
                  caption_text: result.caption_text ?? r.caption_text ?? null,
                  analysis: result.analysis,
                }
            : r,
        ),
      );
    } catch (e) {
      setLibrary((prev) =>
        prev.map((r) =>
          r.url === url
            ? {
                ...r,
                status: 'error',
                error: e instanceof Error ? e.message : String(e),
              }
            : r,
        ),
      );
    }
  };

  const reanalyzeAllReels = async (): Promise<void> => {
    setBusy('hydrating');
    setError(null);
    const urls = library.map((r) => r.url);
    setLibrary((prev) =>
      prev.map((r) => ({ ...r, status: 'hydrating', error: undefined })),
    );
    const CONCURRENCY = 2;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < urls.length) {
        const url = urls[next++];
        try {
          const result = await window.api.hydrateLibraryReel(url, true);
          setLibrary((prev) =>
            prev.map((r) =>
              r.url === url
                ? 'error' in result
                  ? { ...r, status: 'error', error: result.error }
                  : {
                      ...r,
                      status: 'ready',
                      from_cache: result.from_cache,
                      caption_text: result.caption_text ?? r.caption_text ?? null,
                      analysis: result.analysis,
                    }
                : r,
            ),
          );
        } catch (e) {
          setLibrary((prev) =>
            prev.map((r) =>
              r.url === url
                ? {
                    ...r,
                    status: 'error',
                    error: e instanceof Error ? e.message : String(e),
                  }
                : r,
            ),
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker),
    );
    setBusy(null);
  };

  const buildTarget = (): TargetInput | string => {
    if (targetMode === 'reel_url') {
      const url = targetUrl.trim();
      if (!url) return 'Paste a target reel URL.';
      return { kind: 'reel_url', url };
    }
    if (targetMode === 'script') {
      const text = targetScript.trim();
      if (!text) return 'Type or paste a script outline.';
      return { kind: 'script', text };
    }
    if (!targetFile) return 'Pick a local video / audio file.';
    return { kind: 'local_video', filePath: targetFile };
  };

  /** Append a user prompt to the persistent per-reel log. Best-effort. */
  const recordPrompt = (
    source: string,
    text: string,
    shotIdx?: number | null,
    reelIdOverride?: string,
  ): void => {
    const reel_id = reelIdOverride ?? plan?.reel_id;
    if (!reel_id || !text || !text.trim()) return;
    void window.api.recordPrompt({
      at: Date.now(),
      reel_id,
      source,
      text: text.trim(),
      shot_idx: shotIdx ?? null,
    });
  };

  const buildPlan = async (opts?: {
    userInstructionsOverride?: string;
    keepExistingPlan?: boolean;
    targetOverride?: TargetInput;
    reuseLastTarget?: boolean;
    remixProfile?: RemixProfile | null;
  }): Promise<void> => {
    const projectId = activeProjectId;
    const ready = library.filter(
      (r): r is LibraryRow & { analysis: ReelAnalysisResult } =>
        r.status === 'ready' && !!r.analysis,
    );
    if (ready.length === 0) {
      setError('Hydrate the library first.');
      return;
    }
    const target =
      opts?.targetOverride ??
      (opts?.reuseLastTarget ? undefined : buildTarget());
    if (typeof target === 'string') {
      setError(target);
      return;
    }
    if (!projectId) {
      setError('Open a project tab before synthesizing an edit plan.');
      return;
    }
    setBusy('synthesizing');
    synthJobProjectIdRef.current = projectId;
    if (!opts?.keepExistingPlan) setPlan(null);
    setCuration(null);
    setError(null);
    setSynthProgress(null);
    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectId
          ? {
              ...project,
              busy: 'synthesizing',
              stage: 'target',
              plan: opts?.keepExistingPlan ? project.plan : null,
              curation: null,
              synthProgress: null,
              status: { kind: 'planning', label: 'Planning' },
            }
          : project,
      ),
    );
    const remixProfile = opts?.remixProfile ?? selectedRemixProfile;
    const baseUserInstructions =
      opts?.userInstructionsOverride ?? userInstructions;
    const effectiveUserInstructions = [
      baseUserInstructions.trim(),
      remixProfile
        ? [
            `Use remix profile "${remixProfile.name}".`,
            remixProfile.preference_instructions,
          ].join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    // Stable reel id: reuse on regeneration, mint on a fresh synthesis.
    const reelId =
      (opts?.keepExistingPlan && plan?.reel_id) || crypto.randomUUID();
    try {
      const synth = await window.api.synthesizePlan({
        library: ready.map((r) => ({
          url: r.url,
          tags: r.tags,
          analysis: r.analysis,
        })),
        target,
        allowCopyrightedMedia,
        userInstructions: effectiveUserInstructions,
        reuseLastTarget: opts?.reuseLastTarget,
      });
      const nextPlan: SuggestedEdit =
        (target?.kind ?? targetMode) === 'local_video'
          ? {
              ...synth,
              reel_id: reelId,
              target_video_path:
                targetPreviewVideoPath ?? synth.target_video_path ?? targetFile,
            }
          : { ...synth, reel_id: reelId };
      const nextTitle = topicFromPlan(nextPlan, projects.find((p) => p.id === projectId)?.title ?? 'Untitled reel');
      setProjects((prev) =>
        prev.map((project) =>
          project.id === projectId
            ? {
                ...project,
                title: nextTitle,
                busy: null,
                stage: 'plan',
                planTarget: target ?? project.planTarget,
                plan: nextPlan,
                curation: null,
                progress: null,
                synthProgress: null,
                status: { kind: 'planned', label: 'Plan ready' },
              }
            : project,
        ),
      );
      if (activeProjectIdRef.current === projectId) {
        setPlan(nextPlan);
        if (target) setPlanTarget(target);
        setCuration(null);
        setProgress(null);
        setStage('plan');
      }
      // Log the synthesis inputs against this reel (instructions + target).
      const targetDesc =
        typeof target === 'object' && target
          ? ((target as { url?: string; path?: string }).url ??
            (target as { url?: string; path?: string }).path ??
            target.kind)
          : 'reused target';
      recordPrompt(
        'synthesis',
        `[${targetDesc}] ${baseUserInstructions || '(default)'}${
          remixProfile ? `\n\n[remix_profile] ${remixProfile.name}` : ''
        }`,
        null,
        reelId,
      );
      refreshPastPlans();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setProjects((prev) =>
        prev.map((project) =>
          project.id === projectId
            ? {
                ...project,
                busy: null,
                status: { kind: 'error', label: 'Needs attention' },
              }
            : project,
        ),
      );
      if (activeProjectIdRef.current === projectId) setError(message);
    } finally {
      if (synthJobProjectIdRef.current === projectId) {
        synthJobProjectIdRef.current = null;
      }
      if (activeProjectIdRef.current === projectId) setBusy(null);
    }
  };

  const batchBuildPlans = async (): Promise<void> => {
    const ready = library.filter(
      (r): r is LibraryRow & { analysis: ReelAnalysisResult } =>
        r.status === 'ready' && !!r.analysis,
    );
    if (ready.length === 0) {
      setError('Hydrate the inspiration library first.');
      return;
    }
    const activeSnapshot: WorkflowProject = {
      ...(projects.find((p) => p.id === activeProjectId) ?? blankProject()),
      targetMode,
      targetUrl,
      targetScript,
      targetFile,
      targetVideoUrl,
      targetPreviewVideoPath,
      planTarget,
      plan,
      curation,
      progress,
      synthProgress,
      turnsByShot,
      expandedShots,
      pendingClarifications,
      clarificationTyping,
      stage,
      busy,
      status: activeProjectStatus,
    };
    const queue = projects
      .map((project) => (project.id === activeProjectId ? activeSnapshot : project))
      .filter(
        (project) =>
          project.targetMode === 'local_video' &&
          !!project.targetFile &&
          !project.plan,
      );
    if (queue.length === 0) {
      setError('No uploaded videos need an edit plan.');
      return;
    }
    const remixProfile = selectedRemixProfile;
    const effectiveUserInstructions = [
      userInstructions.trim(),
      remixProfile
        ? [
            `Use remix profile "${remixProfile.name}".`,
            remixProfile.preference_instructions,
          ].join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    setBusy('batch_synthesizing');
    setError(null);
    setSynthProgress(null);
    setProjects((prev) =>
      prev.map((project) =>
        queue.some((queued) => queued.id === project.id)
          ? {
              ...project,
              busy: 'batch_synthesizing',
              status: { kind: 'planning', label: 'Batch planning' },
            }
          : project,
      ),
    );
    try {
      for (let i = 0; i < queue.length; i++) {
        const project = queue[i];
        if (!project.targetFile) continue;
        setBatchProgress({
          current: i + 1,
          total: queue.length,
          title: project.title,
        });
        setProjects((prev) =>
          prev.map((p) =>
            p.id === project.id
              ? { ...p, status: { kind: 'planning', label: 'Planning' } }
              : p,
          ),
        );
        const target: TargetInput = {
          kind: 'local_video',
          filePath: project.targetFile,
        };
        const reelId = project.plan?.reel_id ?? crypto.randomUUID();
        try {
          synthJobProjectIdRef.current = project.id;
          const synth = await window.api.synthesizePlan({
            library: ready.map((r) => ({
              url: r.url,
              tags: r.tags,
              analysis: r.analysis,
            })),
            target,
            allowCopyrightedMedia,
            userInstructions: effectiveUserInstructions,
          });
          const nextPlan: SuggestedEdit = {
            ...synth,
            reel_id: reelId,
            target_video_path:
              project.targetPreviewVideoPath ??
              synth.target_video_path ??
              project.targetFile,
          };
          const nextTitle = topicFromPlan(nextPlan, project.title);
          setProjects((prev) =>
            prev.map((p) =>
              p.id === project.id
                ? {
                    ...p,
                    title: nextTitle,
                    busy: null,
                    stage: 'plan',
                    planTarget: target,
                    plan: nextPlan,
                    curation: null,
                    progress: null,
                    synthProgress: null,
                    status: { kind: 'planned', label: 'Plan ready' },
                  }
                : p,
            ),
          );
          if (activeProjectIdRef.current === project.id) {
            setPlanTarget(target);
            setPlan(nextPlan);
            setCuration(null);
            setProgress(null);
            setStage('plan');
          }
          void window.api.recordPrompt({
            at: Date.now(),
            reel_id: reelId,
            source: 'batch_synthesis',
            text: `[${project.targetFile}] ${userInstructions || '(default)'}${
              remixProfile ? `\n\n[remix_profile] ${remixProfile.name}` : ''
            }`,
            shot_idx: null,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setProjects((prev) =>
            prev.map((p) =>
              p.id === project.id
                ? {
                    ...p,
                    busy: null,
                    status: { kind: 'error', label: 'Needs attention' },
                  }
                : p,
            ),
          );
          if (activeProjectIdRef.current === project.id) setError(msg);
        } finally {
          if (synthJobProjectIdRef.current === project.id) {
            synthJobProjectIdRef.current = null;
          }
        }
      }
      await refreshPastPlans();
      setPasteToast(`Built edit plans for ${queue.length} uploaded videos.`);
    } finally {
      setBusy(null);
      setBatchProgress(null);
      setProjects((prev) =>
        prev.map((project) =>
          project.busy === 'batch_synthesizing'
            ? { ...project, busy: null }
            : project,
        ),
      );
    }
  };

  const regeneratePlan = async (details: string): Promise<void> => {
    const trimmed = details.trim();
    if (!trimmed) {
      setError('Add a few details before regenerating the plan.');
      return;
    }
    recordPrompt('regenerate_plan', trimmed);
    const nextInstructions = [
      userInstructions.trim(),
      `Plan regeneration request: ${trimmed}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    setUserInstructions(nextInstructions);
    const fallbackTarget = planTarget ?? targetFromExistingPlan(plan);
    await buildPlan({
      userInstructionsOverride: nextInstructions,
      keepExistingPlan: true,
      targetOverride: fallbackTarget ?? undefined,
      reuseLastTarget: !fallbackTarget,
    });
  };

  const saveCurrentRemixProfile = async (): Promise<void> => {
    if (!plan) {
      setError('Build a plan before saving a remix profile.');
      return;
    }
    setError(null);
    try {
      if (typeof window.api.saveRemixProfile !== 'function') {
        setError('Remix profile API is not loaded. Restart the desktop app and try again.');
        return;
      }
      const planWithId = plan.reel_id
        ? plan
        : { ...plan, reel_id: crypto.randomUUID() };
      if (!plan.reel_id) {
        setPlan(planWithId);
        void window.api.savePlan(planWithId);
      }
      const result = await window.api.saveRemixProfile({ plan: planWithId });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setRemixProfiles((prev) => [
        result,
        ...prev.filter((p) => p.id !== result.id),
      ]);
      setSelectedRemixProfileId(result.id);
      setPasteToast(`Saved remix profile "${result.name}".`);
      recordPrompt('save_remix_profile', `Saved remix profile "${result.name}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickFile = async (): Promise<void> => {
    const filePath = await window.api.pickVideoFile();
    if (filePath) setTargetFile(filePath);
  };

  const pickBatchFiles = async (): Promise<void> => {
    const files =
      typeof window.api.pickVideoFiles === 'function'
        ? await window.api.pickVideoFiles()
        : [];
    addProjectsFromFiles(files);
  };

  useEffect(() => {
    let cancelled = false;
    if (!targetFile) {
      setTargetVideoUrl(null);
      setTargetPreviewVideoPath(null);
      return;
    }
    window.api
      .prepareLocalVideoPreview(targetFile)
      .catch(() => targetFile)
      .then((previewPath) => {
        if (cancelled) return null;
        setTargetPreviewVideoPath(previewPath);
        return window.api.localVideoUrl(previewPath);
      })
      .then((url) => {
        if (!cancelled && url) setTargetVideoUrl(url);
      })
      .catch(() => {
        if (!cancelled) setTargetVideoUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [targetFile]);

  const approveCurate = async (force = false, userPrompt?: string): Promise<void> => {
    if (!plan) return;
    const projectId = activeProjectId;
    if (!projectId) {
      setError('Open a project tab before running the agent.');
      return;
    }
    if (userPrompt) recordPrompt('curate', userPrompt);
    setBusy('curating');
    curateJobProjectIdRef.current = projectId;
    if (force) setCuration(null);
    setProgress({ completed: 0, total: plan.shots.length });
    setTurnsByShot(new Map());
    setExpandedShots(new Set());
    setPendingClarifications(new Map());
    setClarificationTyping(new Map());
    setError(null);
    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectId
          ? {
              ...project,
              busy: 'curating',
              stage: 'plan',
              curation: force ? null : project.curation,
              progress: { completed: 0, total: plan.shots.length },
              turnsByShot: new Map(),
              expandedShots: new Set(),
              pendingClarifications: new Map(),
              clarificationTyping: new Map(),
              status: { kind: 'agent', label: `Agent running 0/${plan.shots.length}` },
            }
          : project,
      ),
    );
    try {
      const result = await window.api.curatePlan(plan, { force, userPrompt });
      setProjects((prev) =>
        prev.map((project) =>
          project.id === projectId
            ? {
                ...project,
                busy: null,
                stage: 'review',
                curation: result,
                progress: null,
                status: { kind: 'done', label: 'Curated' },
              }
            : project,
        ),
      );
      if (activeProjectIdRef.current === projectId) {
        setCuration(result);
        setProgress(null);
        setStage('review');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setProjects((prev) =>
        prev.map((project) =>
          project.id === projectId
            ? {
                ...project,
                busy: null,
                status: { kind: 'error', label: 'Needs attention' },
              }
            : project,
        ),
      );
      if (activeProjectIdRef.current === projectId) setError(message);
    } finally {
      if (curateJobProjectIdRef.current === projectId) {
        curateJobProjectIdRef.current = null;
      }
      if (activeProjectIdRef.current === projectId) setBusy(null);
    }
  };

  const filterExistingScreenshots = async (): Promise<void> => {
    if (!plan || !curation) return;
    if (typeof window.api?.filterExistingScreenshots !== 'function') {
      setError(
        'filterExistingScreenshots not available yet — restart the desktop app so the new preload bundle loads.',
      );
      return;
    }
    setError(null);
    try {
      const result = await window.api.filterExistingScreenshots({
        plan,
        curation,
      });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setCuration(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stopCurate = async (): Promise<void> => {
    try {
      await window.api.stopCurate();
    } catch {
      /* best-effort; the main process logs failures */
    }
  };

  const regenerateShot = async (
    shotIdx: number,
    userPrompt: string,
  ): Promise<void> => {
    setError(null);
    recordPrompt('regenerate_shot', userPrompt, shotIdx);
    try {
      const result = await window.api.regenerateShot({
        shot_idx: shotIdx,
        user_prompt: userPrompt,
      });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      const rewritten = result.curation.rewritten_shot;
      if (rewritten) {
        setPlan((prev) =>
          prev
            ? {
                ...prev,
                shots: prev.shots.map((s) =>
                  s.shot_idx === shotIdx
                    ? {
                        ...s,
                        broll_description: rewritten.broll_description,
                        asset: rewritten.asset,
                        placement: rewritten.placement,
                        source_type: rewritten.source_type,
                        options: rewritten.options,
                        rationale: rewritten.rationale,
                      }
                    : s,
                ),
              }
            : prev,
        );
      }
      setCuration((prev) => {
        if (!prev) return prev;
        // Upsert by shot_idx — the curation arrays are keyed by shot_idx,
        // not aligned to plan.shots positions (which shift on delete).
        const existing = prev.shots.findIndex(
          (s) => s != null && s.shot_idx === shotIdx,
        );
        const nextShots =
          existing >= 0
            ? prev.shots.map((s) =>
                s != null && s.shot_idx === shotIdx ? result.curation : s,
              )
            : [...prev.shots, result.curation];
        const nextTraces =
          existing >= 0
            ? (prev.traces ?? []).map((t, i) =>
                i === existing ? result.trace : t,
              )
            : [...(prev.traces ?? []), result.trace];
        return { ...prev, shots: nextShots, traces: nextTraces };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const applyRewrittenShots = (rewrittenShots: ShotPlan[]): void => {
    if (rewrittenShots.length === 0) return;
    const byIdx = new Map(rewrittenShots.map((s) => [s.shot_idx, s]));
    setPlan((prev) =>
      prev
        ? {
            ...prev,
            shots: prev.shots.map((s) => {
              const rewritten = byIdx.get(s.shot_idx);
              return rewritten
                ? {
                    ...s,
                    broll_description: rewritten.broll_description,
                    asset: rewritten.asset,
                    placement: rewritten.placement,
                    source_type: rewritten.source_type,
                    options: rewritten.options,
                    rationale: rewritten.rationale,
                  }
                : s;
            }),
          }
        : prev,
    );
  };

  const rewriteShotIdeas = async (
    shotIdxs: number[],
    userPrompt: string,
  ): Promise<void> => {
    if (!plan) return;
    setError(null);
    recordPrompt(
      'rewrite_shot_ideas',
      userPrompt,
      shotIdxs.length === 1 ? shotIdxs[0] : null,
    );
    try {
      const result = await window.api.rewriteShotIdeas({
        plan,
        shot_idxs: shotIdxs,
        user_prompt: userPrompt,
      });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      if (result.shots.length === 0) {
        setError(
          'No shot ideas were rewritten. Try a more specific instruction.',
        );
        return;
      }
      applyRewrittenShots(result.shots);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const regenerateShotIdeaOnly = async (
    shotIdx: number,
    userPrompt: string,
  ): Promise<void> => {
    await rewriteShotIdeas([shotIdx], userPrompt);
  };

  const regenerateAllShotIdeas = async (userPrompt: string): Promise<void> => {
    if (!plan) return;
    await rewriteShotIdeas(
      plan.shots.map((shot) => shot.shot_idx),
      userPrompt,
    );
  };

  /** Continue the same agent session for a shot with a follow-up
   *  user instruction. Unlike regenerate (which starts fresh), this
   *  reuses all the agent's prior reasoning + tool calls so it
   *  doesn't redo work — it just tweaks the output. */
  const continueOneShot = async (
    shotIdx: number,
    userPrompt: string,
  ): Promise<void> => {
    console.log(
      `[continueOneShot] firing shot_idx=${shotIdx} prompt="${userPrompt.slice(0, 80)}"`,
    );
    setError(null);
    recordPrompt('continue_shot', userPrompt, shotIdx);
    try {
      const result = await window.api.continueShot({
        shot_idx: shotIdx,
        user_prompt: userPrompt,
      });
      console.log('[continueOneShot] IPC returned:', result);
      if ('error' in result) {
        console.warn('[continueOneShot] error from IPC:', result.error);
        setError(result.error);
        return;
      }
      console.log(
        `[continueOneShot] applying new curation: ${result.curation.candidates.length} candidates, failure_reason=${result.curation.failure_reason ?? 'null'}`,
      );
      setCuration((prev) => {
        if (!prev) {
          console.warn(
            '[continueOneShot] prev curation was null — initializing from result',
          );
          return {
            shots: [result.curation],
            traces: [result.trace],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            duration_ms: 0,
          };
        }
        const existing = prev.shots.findIndex(
          (s) => s != null && s.shot_idx === shotIdx,
        );
        const nextShots =
          existing >= 0
            ? prev.shots.map((s) =>
                s != null && s.shot_idx === shotIdx ? result.curation : s,
              )
            : [...prev.shots, result.curation];
        const nextTraces =
          existing >= 0
            ? (prev.traces ?? []).map((t, i) =>
                i === existing ? result.trace : t,
              )
            : [...(prev.traces ?? []), result.trace];
        return { ...prev, shots: nextShots, traces: nextTraces };
      });
    } catch (e) {
      console.error('[continueOneShot] threw:', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Curate (or recurate) a single shot. Used when the user wants
   *  per-shot control instead of bulk "Approve & curate". */
  const curateOneShot = async (
    shotIdx: number,
    userPrompt?: string,
  ): Promise<void> => {
    if (!plan) return;
    if (userPrompt) recordPrompt('curate_shot', userPrompt, shotIdx);
    setError(null);
    try {
      const result = await window.api.curateShot({
        plan,
        shot_idx: shotIdx,
        user_prompt: userPrompt,
      });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setCuration((prev) => {
        // Initialize curation state if this is the first per-shot run.
        const base: CurationResult =
          prev ?? {
            shots: [],
            traces: [],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            duration_ms: 0,
          };
        const existing = base.shots.findIndex(
          (s) => s != null && s.shot_idx === shotIdx,
        );
        const nextShots =
          existing >= 0
            ? base.shots.map((s) =>
                s != null && s.shot_idx === shotIdx ? result.curation : s,
              )
            : [...base.shots, result.curation];
        const nextTraces =
          existing >= 0
            ? (base.traces ?? []).map((t, i) =>
                i === existing ? result.trace : t,
              )
            : [...(base.traces ?? []), result.trace];
        return { ...base, shots: nextShots, traces: nextTraces };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Research a user-described clip and APPEND it to the shot's
   *  candidates (the "Add clip" button). Streaming partials update the
   *  card live; this final upsert lands the authoritative merged set. */
  const addClipToShot = async (
    shotIdx: number,
    description: string,
  ): Promise<AddClipResult> => {
    if (!plan) return { ok: false };
    setError(null);
    recordPrompt('add_clip', description, shotIdx);
    try {
      const result = await window.api.addShotClip({
        plan,
        shot_idx: shotIdx,
        description,
      });
      if ('error' in result) {
        setError(result.error);
        return { ok: false };
      }
      setCuration((prev) => upsertShotCuration(prev, result.curation));
      return {
        ok: true,
        added: result.added,
        foundButDuplicate: result.foundButDuplicate,
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return { ok: false };
    }
  };

  const readyCount = library.filter((r) => r.status === 'ready').length;
  const targetReady =
    (targetMode === 'reel_url' && targetUrl.trim().length > 0) ||
    (targetMode === 'script' && targetScript.trim().length > 0) ||
    (targetMode === 'local_video' && targetFile !== null);
  const projectAgentRunning =
    busy === 'synthesizing' ||
    busy === 'batch_synthesizing' ||
    busy === 'curating' ||
    projects.some(
      (project) =>
        project.busy === 'synthesizing' ||
        project.busy === 'batch_synthesizing' ||
        project.busy === 'curating',
    );
  const canBuildPlan =
    !busy && !projectAgentRunning && readyCount > 0 && targetReady;
  const batchReadyCount = projects.filter(
    (project) =>
      project.targetMode === 'local_video' &&
      !!project.targetFile &&
      !project.plan,
  ).length;
  const canBatchBuildPlans =
    !busy && !projectAgentRunning && readyCount > 0 && batchReadyCount > 1;
  const canCurate = !busy && !projectAgentRunning && plan !== null;
  const activeProjectStatus = useMemo(
    () =>
      computeProjectStatus({
        busy,
        targetReady,
        plan,
        curation,
        progress,
        pendingClarifications,
        error,
      }),
    [busy, curation, error, pendingClarifications, plan, progress, targetReady],
  );

  useEffect(() => {
    if (!activeProjectId) return;
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== activeProjectId) return project;
        const fallbackTitle =
          targetMode === 'local_video' && targetFile
            ? topicFromPath(targetFile)
            : targetMode === 'script'
              ? topicFromText(targetScript, project.title)
              : project.title;
        return {
          ...project,
          busy,
          stage: stage === 'dashboard' ? project.stage : stage,
          title: topicFromPlan(plan, fallbackTitle),
          targetMode,
          targetUrl,
          targetScript,
          targetFile,
          targetVideoUrl,
          targetPreviewVideoPath,
          planTarget,
          plan,
          curation,
          progress,
          synthProgress,
          turnsByShot,
          expandedShots,
          pendingClarifications,
          clarificationTyping,
          status: activeProjectStatus,
        };
      }),
    );
  }, [
    activeProjectId,
    activeProjectStatus,
    curation,
    clarificationTyping,
    expandedShots,
    pendingClarifications,
    plan,
    planTarget,
    progress,
    stage,
    synthProgress,
    busy,
    targetFile,
    targetMode,
    targetPreviewVideoPath,
    targetScript,
    targetUrl,
    targetVideoUrl,
    turnsByShot,
  ]);

  const activateProject = (projectId: string): void => {
    const project = projects.find((p) => p.id === projectId);
    if (!project || project.id === activeProjectId) return;
    setActiveProjectId(project.id);
    setTargetMode(project.targetMode);
    setTargetUrl(project.targetUrl);
    setTargetScript(project.targetScript);
    setTargetFile(project.targetFile);
    setTargetVideoUrl(project.targetVideoUrl);
    setTargetPreviewVideoPath(project.targetPreviewVideoPath);
    setPlanTarget(project.planTarget);
    setPlan(project.plan);
    setCuration(project.curation);
    setProgress(project.progress);
    setSynthProgress(project.synthProgress);
    setTurnsByShot(project.turnsByShot);
    setExpandedShots(project.expandedShots);
    setPendingClarifications(project.pendingClarifications);
    setClarificationTyping(project.clarificationTyping);
    setBusy(project.busy);
    setError(null);
    setStage(projectStatusStage(project));
  };

  const showDashboard = (): void => {
    setActiveProjectId(null);
    setBusy(null);
    setError(null);
    setStage('dashboard');
  };

  useEffect(() => {
    if (stage === 'dashboard' && activeProjectId) {
      setActiveProjectId(null);
      setBusy(null);
    }
  }, [activeProjectId, stage]);

  useEffect(() => {
    if (!activeProjectId && stage !== 'dashboard') {
      setStage('dashboard');
    }
  }, [activeProjectId, setStage, stage]);

  const addProjectsFromFiles = (files: string[]): void => {
    const uniqueFiles = files.filter(
      (filePath) =>
        filePath &&
        !projects.some((p) => p.targetFile === filePath) &&
        filePath !== targetFile,
    );
    if (uniqueFiles.length === 0) return;
    const nextProjects = uniqueFiles.map(projectFromFile);
    setProjects((prev) => [...prev, ...nextProjects]);
    const first = nextProjects[0];
    setActiveProjectId(first.id);
    setTargetMode('local_video');
    setTargetUrl('');
    setTargetScript('');
    setTargetFile(first.targetFile);
    setTargetVideoUrl(null);
    setTargetPreviewVideoPath(null);
    setPlanTarget(null);
    setPlan(null);
    setCuration(null);
    setProgress(null);
    setSynthProgress(null);
    setTurnsByShot(new Map());
    setExpandedShots(new Set());
    setPendingClarifications(new Map());
    setClarificationTyping(new Map());
    setBusy(first.busy);
    setError(null);
    setStage(first.stage);
    setPasteToast(
      `Created ${nextProjects.length} ${nextProjects.length === 1 ? 'project' : 'projects'} from batch upload.`,
    );
  };

  const createNewProject = (): void => {
    const fresh = blankProject(`Untitled ${projects.length + 1}`);
    setProjects((prev) => [...prev, fresh]);
    setActiveProjectId(fresh.id);
    setPlan(null);
    setCuration(null);
    setPlanTarget(null);
    setTargetMode('local_video');
    setTargetUrl('');
    setTargetScript('');
    setTargetFile(null);
    setTargetVideoUrl(null);
    setTargetPreviewVideoPath(null);
    setUserInstructions('');
    setSynthProgress(null);
    setProgress(null);
    setTurnsByShot(new Map());
    setExpandedShots(new Set());
    setPendingClarifications(new Map());
    setClarificationTyping(new Map());
    setBusy(fresh.busy);
    setError(null);
    setStage(fresh.stage);
  };

  const saveWorkspace = async (): Promise<void> => {
    try {
      if (activeCollectionId) {
        await window.api.saveCollectionReels(
          activeCollectionId,
          library.map((r) => ({ url: r.url, tags: r.tags })),
        );
      } else {
        await window.api.saveLibrary(
          library.map((r) => ({ url: r.url, tags: r.tags })),
        );
      }
      if (plan) {
        const result = await window.api.savePlan(plan);
        if (!result.ok) throw new Error(result.error ?? 'Plan save failed.');
      }
      await refreshPastPlans();
      await refreshRemixProfiles();
      setPasteToast('Workspace saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openCollectionFromDashboard = (id: string): void => {
    switchCollection(id);
    setStage('inspire');
  };

  const openProjectFromDashboard = async (key: string): Promise<void> => {
    await loadPastPlan(key);
    setStage('plan');
  };

  // Push stage-done flags up to the top stepper. Inspiration is done
  // once at least one reel is hydrated; target is done once any input
  // is provided; plan is done once a plan exists.
  useEffect(() => {
    setStageDone('inspire', readyCount > 0);
  }, [readyCount, setStageDone]);
  useEffect(() => {
    setStageDone('target', !!targetReady);
  }, [targetReady, setStageDone]);
  useEffect(() => {
    setStageDone('plan', plan !== null);
  }, [plan, setStageDone]);
  // Auto-advance from step 2 → step 3 as soon as a plan exists.
  // Plan creation can happen via Synthesize OR loading a past plan;
  // both paths land here. Only fires from 'target' so we don't yank
  // the user out of step 1.
  useEffect(() => {
    if (plan && stage === 'target') {
      setStage('plan');
    }
  }, [plan, stage, setStage]);

  return (
    <div className="scroll">
      <div className="canvas canvas-wide workflow">
        {error && <div className="error">{error}</div>}
        {pasteToast && <div className="paste-toast">📋 {pasteToast}</div>}

        <div className="project-tabs" aria-label="Editing projects">
          <div className="project-tabs-head">
            <div>
              <div className="project-tabs-kicker">Edit queue</div>
              <div className="project-tabs-title">
                {projects.length} {projects.length === 1 ? 'video' : 'videos'} loaded
              </div>
            </div>
            <span className={`project-tabs-live status-${activeProjectId ? activeProjectStatus.kind : 'empty'}`}>
              <span className="project-tab-dot" aria-hidden="true" />
              {activeProjectId ? activeProjectStatus.label : 'Dashboard'}
            </span>
          </div>
          <div className="project-tabs-scroll">
            <button
              type="button"
              role="tab"
              aria-selected={activeProjectId === null}
              className={`project-tab project-tab-dashboard ${activeProjectId === null ? 'active' : ''} status-empty`}
              onClick={showDashboard}
              title="Workspace dashboard"
            >
              <span className="project-tab-index">▦</span>
              <span className="project-tab-main">
                <span className="project-tab-title">Dashboard</span>
                <span className="project-tab-status">
                  <span className="project-tab-dot" aria-hidden="true" />
                  No tab selected
                </span>
              </span>
            </button>
            {projects.map((project, index) => {
              const status =
                project.id === activeProjectId ? activeProjectStatus : project.status;
              const tabProject: WorkflowProject =
                project.id === activeProjectId
                  ? {
                      ...project,
                      stage,
                      targetMode,
                      targetUrl,
                      targetScript,
                      targetFile,
                      plan,
                      curation,
                    }
                  : project;
              const tabProgress = projectStepProgress(tabProject, readyCount);
              return (
                <button
                  key={project.id}
                  type="button"
                  role="tab"
                  aria-selected={project.id === activeProjectId}
                  className={`project-tab ${project.id === activeProjectId ? 'active' : ''} status-${status.kind}`}
                  onClick={() => activateProject(project.id)}
                  title={`${project.title} — ${status.label}`}
                >
                  <span className="project-tab-index">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="project-tab-main">
                    <span className="project-tab-title">{project.title}</span>
                    <span className="project-tab-status">
                      <span className="project-tab-dot" aria-hidden="true" />
                      {status.label}
                    </span>
                    <span className="project-tab-flow" aria-hidden="true">
                      {STAGES.map((step) => (
                        <span
                          key={step.id}
                          className={`project-tab-step ${tabProject.stage === step.id ? 'active' : ''} ${tabProgress[step.id] ? 'done' : ''}`}
                          title={step.title}
                        >
                          {tabProgress[step.id] && tabProject.stage !== step.id
                            ? '✓'
                            : step.num}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="project-tabs-actions">
            <button
              type="button"
              className="queue-action"
              onClick={createNewProject}
              disabled={busy === 'hydrating'}
            >
              + New
            </button>
            <button
              type="button"
              className="queue-action queue-action-primary"
              onClick={() => void pickBatchFiles()}
              disabled={busy === 'hydrating'}
            >
              Batch upload…
            </button>
          </div>
        </div>

      {stage === 'dashboard' && (
      <section className="workflow-section dashboard-page rise">
        <header className="dashboard-hero">
          <div>
            <div className="eyebrow">Workspace</div>
            <h1 className="stage-title">
              Control <em>room</em>
            </h1>
            <p className="stage-desc">
              Collections, projects, remix profiles, and the current reel live here.
              Create, open, and save without digging through the flow.
            </p>
          </div>
          <div className="dashboard-actions">
            <button type="button" className="btn btn-primary" onClick={createNewProject}>
              + New project
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void createCollectionHandler()}
            >
              + Collection
            </button>
            <button type="button" className="btn" onClick={() => void saveWorkspace()}>
              Save everything
            </button>
          </div>
        </header>

        <div className="dash-metrics">
          <div className="dash-metric">
            <span>Collections</span>
            <strong>{collections.length}</strong>
          </div>
          <div className="dash-metric">
            <span>Saved projects</span>
            <strong>{pastPlans.length}</strong>
          </div>
          <div className="dash-metric">
            <span>Remix profiles</span>
            <strong>{remixProfiles.length}</strong>
          </div>
          <div className="dash-metric">
            <span>Active reels</span>
            <strong>{library.length}</strong>
          </div>
        </div>

        <div className="dashboard-grid">
          <section className="dash-panel dash-panel-wide">
            <div className="dash-panel-head">
              <div>
                <div className="dash-kicker">Now editing</div>
                <h2>Current project</h2>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!plan}
                onClick={() => void saveWorkspace()}
              >
                Save
              </button>
            </div>
            {plan ? (
              <div className="dash-current">
                <div>
                  <strong>{plan.shots.length} shots</strong>
                  <p>{plan.structure_sections[0]?.target_fill || plan.style_summary}</p>
                </div>
                <div className="dash-current-actions">
                  <button type="button" className="btn" onClick={() => setStage('plan')}>
                    Open plan
                  </button>
                  <button type="button" className="btn" onClick={() => setStage('review')}>
                    Preview
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void saveCurrentRemixProfile()}
                  >
                    Save profile
                  </button>
                </div>
              </div>
            ) : (
              <div className="dash-empty">
                No active project. Start from a target, or open a saved plan.
              </div>
            )}
          </section>

          <section className="dash-panel">
            <div className="dash-panel-head">
              <div>
                <div className="dash-kicker">Libraries</div>
                <h2>Collections</h2>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void createCollectionHandler()}
              >
                New
              </button>
            </div>
            <div className="dash-list">
              {collections.length === 0 ? (
                <div className="dash-empty">No collections yet.</div>
              ) : (
                collections.map((collection) => (
                  <button
                    key={collection.id}
                    type="button"
                    className={`dash-row ${collection.id === activeCollectionId ? 'active' : ''}`}
                    onClick={() => openCollectionFromDashboard(collection.id)}
                  >
                    <span>
                      <strong>{collection.name}</strong>
                      <small>{collection.reels.length} reels</small>
                    </span>
                    <b>Open</b>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="dash-panel">
            <div className="dash-panel-head">
              <div>
                <div className="dash-kicker">Projects</div>
                <h2>Saved plans</h2>
              </div>
              <button type="button" className="btn btn-sm" onClick={createNewProject}>
                New
              </button>
            </div>
            <div className="dash-list">
              {pastPlans.length === 0 ? (
                <div className="dash-empty">No saved plans yet.</div>
              ) : (
                pastPlans.slice(0, 8).map((project) => (
                  <button
                    key={project.key}
                    type="button"
                    className="dash-row"
                    onClick={() => void openProjectFromDashboard(project.key)}
                  >
                    <span>
                      <strong>{project.target_label}</strong>
                      <small>
                        {project.shot_count} shots ·{' '}
                        {new Date(project.created_at).toLocaleDateString()}
                      </small>
                    </span>
                    <b>Open</b>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="dash-panel">
            <div className="dash-panel-head">
              <div>
                <div className="dash-kicker">Memory</div>
                <h2>Remix profiles</h2>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!plan}
                onClick={() => void saveCurrentRemixProfile()}
              >
                Save
              </button>
            </div>
            <div className="dash-list">
              {remixProfiles.length === 0 ? (
                <div className="dash-empty">No profiles saved yet.</div>
              ) : (
                remixProfiles.slice(0, 8).map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={`dash-row ${profile.id === selectedRemixProfileId ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedRemixProfileId(profile.id);
                      setStage('target');
                    }}
                  >
                    <span>
                      <strong>{profile.name}</strong>
                      <small>{profile.prompt_count} prompts</small>
                    </span>
                    <b>Use</b>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="dash-panel">
            <div className="dash-panel-head">
              <div>
                <div className="dash-kicker">Pipeline</div>
                <h2>Continue</h2>
              </div>
            </div>
            <div className="dash-steps">
              {STAGES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="dash-step"
                  onClick={() => setStage(s.id)}
                  disabled={(s.id === 'plan' || s.id === 'review') && !plan}
                >
                  <span>{s.num}</span>
                  <strong>{s.title}</strong>
                  <small>{s.sub}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
      </section>
      )}

      {/* ---------- 1 · Inspiration ---------- */}
      {stage === 'inspire' && (
      <section className="workflow-section rise">
        <header className="stage-head">
          <div className="eyebrow">Step 1 of 4</div>
          <h1 className="stage-title">
            Reels you <em>love</em>
          </h1>
          <p className="stage-desc">
            Drop in the reels you want to borrow from. Tag <code>content</code>{' '}
            for "use this kind of b-roll", <code>style</code> for "use this
            editing pattern", and <code>structure</code> for "use this
            narrative script template (hook → intro → body → cta)." A reel
            can carry any combination.
          </p>
        </header>

        {/* Collections: each is a separate set of inspiration reels,
            fingerprinted independently at synthesis time. */}
        <div className="coll-bar">
          {collections.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`coll-pill ${c.id === activeCollectionId ? 'on' : ''}`}
              onClick={() => switchCollection(c.id)}
            >
              {c.name}
              {c.id === activeCollectionId ? ` · ${library.length}` : ''}
            </button>
          ))}
          <button
            type="button"
            className="coll-pill coll-new"
            onClick={() => void createCollectionHandler()}
          >
            + New collection
          </button>
        </div>
        {activeCollectionId && (
          <div className="coll-actions">
            <input
              className="coll-rename"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              spellCheck={false}
              aria-label="Collection name"
            />
            {collections.length > 1 && (
              <button
                type="button"
                className="coll-del"
                onClick={() => void deleteCollectionHandler()}
                title="Delete this collection"
              >
                Delete collection
              </button>
            )}
          </div>
        )}

        <div className="row">
          <input
            className="input"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addReel()}
            placeholder="https://www.instagram.com/reel/..."
            spellCheck={false}
          />
          <div className="tag-chips">
            <TagChip
              tag="content_reference"
              label="content"
              active={draftTags.includes('content_reference')}
              onClick={() =>
                setDraftTags(
                  draftTags.includes('content_reference')
                    ? draftTags.filter((t) => t !== 'content_reference')
                    : [...draftTags, 'content_reference'],
                )
              }
            />
            <TagChip
              tag="style_reference"
              label="style"
              active={draftTags.includes('style_reference')}
              onClick={() =>
                setDraftTags(
                  draftTags.includes('style_reference')
                    ? draftTags.filter((t) => t !== 'style_reference')
                    : [...draftTags, 'style_reference'],
                )
              }
            />
            <TagChip
              tag="structure_reference"
              label="structure"
              active={draftTags.includes('structure_reference')}
              onClick={() =>
                setDraftTags(
                  draftTags.includes('structure_reference')
                    ? draftTags.filter((t) => t !== 'structure_reference')
                    : [...draftTags, 'structure_reference'],
                )
              }
            />
          </div>
          <button
            className="btn"
            onClick={addReel}
            disabled={!draftUrl.trim() || draftTags.length === 0}
          >
            Add
          </button>
        </div>

        {library.length > 0 && (
          <>
            <div className="library-list">
              {library.map((r) => (
                <div key={r.url} className="library-row">
                  <span className={`library-status status-${r.status}`}>
                    {r.status === 'pending'
                      ? '·'
                      : r.status === 'hydrating'
                        ? '⟳'
                        : r.status === 'ready'
                          ? r.from_cache
                            ? '⚡'
                            : '✓'
                          : '⚠'}
                  </span>
                  <ReelThumb url={r.url} size="sm" />
                  <button
                    type="button"
                    className="library-url"
                    title={`Open ${r.url} in your browser`}
                    onClick={() => {
                      void window.api.openExternal(r.url);
                    }}
                  >
                    {r.url}
                  </button>
                  <div className="library-tags">
                    <TagChip
                      tag="content_reference"
                      label="content"
                      active={r.tags.includes('content_reference')}
                      small
                      onClick={() => toggleTag(r.url, 'content_reference')}
                    />
                    <TagChip
                      tag="style_reference"
                      label="style"
                      active={r.tags.includes('style_reference')}
                      small
                      onClick={() => toggleTag(r.url, 'style_reference')}
                    />
                    <TagChip
                      tag="structure_reference"
                      label="structure"
                      active={r.tags.includes('structure_reference')}
                      small
                      onClick={() => toggleTag(r.url, 'structure_reference')}
                    />
                  </div>
                  {r.status === 'ready' && r.analysis && (
                    <span className="library-stat">
                      {r.analysis.shots.length} shots
                    </span>
                  )}
                  {r.status === 'error' && (
                    <span className="library-stat library-err">{r.error}</span>
                  )}
                  {(r.status === 'ready' || r.status === 'error') && (
                    <button
                      className="btn btn-mini"
                      title="Re-analyze (bypass cache)"
                      disabled={busy !== null}
                      onClick={() => reanalyzeReel(r.url)}
                    >
                      ⟳
                    </button>
                  )}
                  <button
                    className="btn btn-mini"
                    onClick={() => removeReel(r.url)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              className="btn"
              onClick={hydrate}
              disabled={busy !== null || library.every((r) => r.status === 'ready')}
            >
              {busy === 'hydrating' ? 'Hydrating…' : 'Hydrate library'}
            </button>
            <button
              className="btn"
              onClick={reanalyzeAllReels}
              disabled={busy !== null || library.length === 0}
            >
              {busy === 'hydrating' ? 'Regenerating…' : 'Regenerate edit analysis'}
            </button>
            <InspirationAnalysisPanel library={library} />
          </>
        )}

        <div className="curate-actions" style={{ marginTop: 28 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={readyCount === 0}
            onClick={() => setStage('target')}
          >
            Next: Your video →
          </button>
          <span className="text-muted">{readyCount} reel{readyCount === 1 ? '' : 's'} ready</span>
        </div>
      </section>
      )}

      {/* ---------- 2 · Your video ---------- */}
      {stage === 'target' && (
      <section className="workflow-section rise">
        <header className="stage-head">
          <div className="eyebrow">Step 2 of 4</div>
          <h1 className="stage-title">
            Your <em>video</em>
          </h1>
          <p className="stage-desc">
            What you're editing. Upload one video for the active tab, or batch
            upload several videos and Clipnosis will create an edit plan for
            each one using the same taste profile.
          </p>
        </header>
        <div className="target-modes">
          <button
            className={`mode-tab ${targetMode === 'reel_url' ? 'active' : ''}`}
            onClick={() => setTargetMode('reel_url')}
          >
            Reel URL
          </button>
          <button
            className={`mode-tab ${targetMode === 'script' ? 'active' : ''}`}
            onClick={() => setTargetMode('script')}
          >
            Script outline
          </button>
          <button
            className={`mode-tab ${targetMode === 'local_video' ? 'active' : ''}`}
            onClick={() => setTargetMode('local_video')}
          >
            Upload video
          </button>
        </div>

        {targetMode === 'reel_url' && (
          <>
            <p className="section-hint section-hint-sub">
              We transcribe its voiceover via Whisper and use that as the script.
            </p>
            <input
              className="input"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://www.instagram.com/p/..."
              spellCheck={false}
            />
            {targetUrl.trim().length > 0 && (
              <div className="target-thumb-wrap">
                <ReelThumb url={targetUrl.trim()} size="md" />
              </div>
            )}
          </>
        )}

        {targetMode === 'script' && (
          <>
            <p className="section-hint section-hint-sub">
              Paste the script you want the reel to deliver. Word timestamps
              are estimated at conversational pace (~165 wpm) so the
              planner can slice shots. Re-record voiceover at edit time
              with real timing.
            </p>
            <textarea
              className="input target-script"
              value={targetScript}
              onChange={(e) => setTargetScript(e.target.value)}
              placeholder={'What\'s this startup that\'s building robotic surveillance birds? This is Ornadyne and they just got into YC. Their primary client is the government and their main investor is FC. Would you support this up and coming startup?'}
              rows={6}
              spellCheck={false}
            />
            <div className="script-meta">
              {targetScript.trim().split(/\s+/).filter(Boolean).length} words ·{' '}
              ~{(targetScript.trim().split(/\s+/).filter(Boolean).length * 0.36).toFixed(0)}s estimated
            </div>
          </>
        )}

        {targetMode === 'local_video' && (
          <>
            <p className="section-hint section-hint-sub">
              Pick one file for this tab, or batch upload multiple videos.
              Each file becomes its own project tab and can be edited in the
              same batch run.
            </p>
            <div className="row">
              <button className="btn" onClick={pickFile}>
                Pick file…
              </button>
              <button className="btn" onClick={() => void pickBatchFiles()}>
                Batch upload…
              </button>
              <div className="target-file">
                {targetFile ?? <span className="text-muted">no file selected</span>}
              </div>
              {targetFile && (
                <button
                  className="btn btn-mini"
                  onClick={() => {
                    setTargetFile(null);
                    setTargetVideoUrl(null);
                    setTargetPreviewVideoPath(null);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            {projects.length > 1 && (
              <div className="batch-summary">
                <div>
                  <div className="batch-summary-title">
                    {batchReadyCount} uploaded {batchReadyCount === 1 ? 'video' : 'videos'} ready for an edit plan
                  </div>
                  <div className="batch-summary-sub">
                    Batch edit uses the same inspiration library, copyright
                    setting, remix profile, and instructions for every video.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canBatchBuildPlans}
                  onClick={() => void batchBuildPlans()}
                >
                  {busy === 'batch_synthesizing'
                    ? 'Editing batch…'
                    : `✦ Edit all uploaded (${batchReadyCount})`}
                </button>
              </div>
            )}
          </>
        )}

        <hr className="hr" />

        {/* Plan synthesis controls (moved out of step 3). Clicking
            Synthesize builds the plan; on success we auto-advance to
            step 3 via the effect below. */}
        {pastPlans.length > 0 && (
          <div className="past-plans">
            <label className="past-plans-label" htmlFor="past-plans-select">
              Past plans
            </label>
            <select
              id="past-plans-select"
              className="past-plans-select"
              value=""
              disabled={busy === 'synthesizing'}
              onChange={(e) => {
                const key = e.target.value;
                e.target.value = '';
                loadPastPlan(key);
              }}
            >
              <option value="" disabled>
                Load a past plan… ({pastPlans.length})
              </option>
              {pastPlans.map((p) => {
                const when = new Date(p.created_at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                });
                return (
                  <option key={p.key} value={p.key}>
                    {when} · {p.shot_count} shots · {p.target_label}
                  </option>
                );
              })}
            </select>
          </div>
        )}
        {remixProfiles.length > 0 && (
          <div className="past-plans">
            <label className="past-plans-label" htmlFor="remix-profile-select">
              Remix profile
            </label>
            <select
              id="remix-profile-select"
              className="past-plans-select"
              value={selectedRemixProfileId}
              disabled={busy === 'synthesizing'}
              onChange={(e) => setSelectedRemixProfileId(e.target.value)}
            >
              <option value="">No saved profile</option>
              {remixProfiles.map((profile) => {
                const when = new Date(profile.updated_at).toLocaleString(
                  undefined,
                  {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  },
                );
                return (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.prompt_count} prompts · {when}
                  </option>
                );
              })}
            </select>
            {selectedRemixProfile && (
              <div className="instructions-hint">
                Remix will reuse preferences from: {selectedRemixProfile.source_summary}
              </div>
            )}
          </div>
        )}
        <label className="copyright-toggle">
          <input
            type="checkbox"
            checked={allowCopyrightedMedia}
            onChange={(e) => setAllowCopyrightedMedia(e.target.checked)}
            disabled={busy === 'synthesizing' || busy === 'batch_synthesizing'}
          />
          <span className="copyright-toggle-text">
            Allow copyrighted media (YouTube clips, news / TV footage, branded
            content). Off = subject-owned + public sources only.
          </span>
        </label>
        <label className="instructions-label" htmlFor="user-instructions">
          Additional instructions (optional)
        </label>
        <textarea
          id="user-instructions"
          className="instructions-textarea"
          rows={3}
          placeholder='e.g. "use stock footage for cityscape shots", "focus on close-ups", "avoid talking-head"…  Stock search is DISABLED by default — mention "stock" / "pexels" / "archival footage" here to enable it.'
          value={userInstructions}
          onChange={(e) => setUserInstructions(e.target.value)}
          disabled={busy === 'synthesizing' || busy === 'batch_synthesizing'}
        />
        <div className="instructions-hint">
          {/\b(stock|pexels|pond5|getty|shutterstock|archival\s*footage)\b/i.test(userInstructions)
            ? '✓ stock_search ENABLED (detected in instructions). Default: web_capture.'
            : 'Methods allowed: web_capture only (plus library_search when library present). Stock, manual, and generative AI all disabled.'}
        </div>

        {busy === 'batch_synthesizing' && batchProgress && (
          <div className="synth-progress">
            <div className="synth-stage">
              batch edit {batchProgress.current}/{batchProgress.total}
            </div>
            <div className="synth-msg">
              Building edit plan for {batchProgress.title}
            </div>
          </div>
        )}

        {busy === 'synthesizing' && synthProgress && (
          <div className="synth-progress">
            <div className="synth-stage">{synthProgress.stage.replace(/_/g, ' ')}</div>
            <div className="synth-msg">{synthProgress.message}</div>
            {synthProgress.stage === 'generating' && synthProgress.received_chars > 0 && (
              <div className="synth-bytes">
                {synthProgress.received_chars.toLocaleString()} chars received
              </div>
            )}
          </div>
        )}

        <div className="curate-actions" style={{ marginTop: 22 }}>
          <button
            type="button"
            className="btn"
            onClick={() => setStage('inspire')}
            disabled={busy === 'synthesizing'}
          >
            ← Back
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canBuildPlan}
            onClick={() => void buildPlan()}
          >
            {busy === 'synthesizing' || busy === 'batch_synthesizing'
              ? 'Synthesizing…'
              : selectedRemixProfile
                ? '↻ Remix with profile'
                : '✦ Synthesize edit plan'}
          </button>
        </div>
      </section>
      )}

      {/* ---------- 3 · The plan + 4 · Review ---------- */}
      {(stage === 'plan' || stage === 'review') && (
      <section className="workflow-section rise">
        {/* No plan = locked state. The synthesize form lives in step 2
            now; this just nudges the user back there. */}
        {!plan && (
          <div className="please-select">
            <div className="please-select-ic">🔒</div>
            <div className="please-select-title">
              {stage === 'plan' ? 'Plan not yet built' : 'Nothing to preview'}
            </div>
            <div className="please-select-sub">
              Finish step 2 first — pick your script or footage, then click
              <b> ✦ Synthesize edit plan </b> to generate the shot plan.
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStage('target')}
              style={{ marginTop: 6 }}
            >
              ← Back to Your video
            </button>
          </div>
        )}

        {plan && (
          <>
          <div className="remix-profile-bar">
            <div>
              <div className="remix-profile-title">Remix profile</div>
              <div className="remix-profile-sub">
                Save this reel's edits and prompts, then reuse them on future targets.
              </div>
            </div>
            <button
              type="button"
              className="btn"
              disabled={!!busy}
              onClick={() => void saveCurrentRemixProfile()}
            >
              {currentPlanProfile ? '↻ Update profile' : '↻ Save current as profile'}
            </button>
          </div>
          <PlanReview
            plan={plan}
            onPlanChange={async (next) => {
              setPlan(next);
              // Persist asynchronously; errors surface in the banner.
              const result = await window.api.savePlan(next);
              if (!result.ok && result.error) setError(result.error);
            }}
            curation={curation}
            pastedMedia={pastedMedia}
            recordPrompt={recordPrompt}
            onCurateShot={curateOneShot}
            onRegenerate={regenerateShot}
            onContinue={continueOneShot}
            onAddClip={addClipToShot}
            topActions={{
              onCurateAll: approveCurate,
              onFilterExistingScreenshots: filterExistingScreenshots,
              onRegeneratePlan: regeneratePlan,
              onRegenerateShotIdea: regenerateShotIdeaOnly,
              onRegenerateAllShotIdeas: regenerateAllShotIdeas,
              onStop: stopCurate,
              curating: busy === 'curating',
              regeneratingPlan: busy === 'synthesizing',
              agentRunningElsewhere: projectAgentRunning && !busy,
              canRegeneratePlan: plan !== null && !busy && !projectAgentRunning,
              curatingProgress: progress
                ? { completed: progress.completed, total: progress.total }
                : undefined,
              onPreview: () => setStage('review'),
            }}
            stageNav={{
              onBack: () => setStage('target'),
              backLabel: '← Your video',
              onNext: () => setStage('review'),
              nextLabel: 'Review →',
            }}
            agentActivity={{
              turnsByShot,
              expandedShots,
              toggleShotExpanded,
              pendingClarifications,
              clarificationTyping,
              setClarificationTyping,
              answerClarification,
            }}
            targetVideoUrl={targetVideoUrl}
            targetVideoPath={
              targetPreviewVideoPath ?? targetFile ?? plan.target_video_path ?? null
            }
            narrationVideoPath={targetFile ?? plan.target_video_path ?? null}
          />
          </>
        )}

      </section>
      )}

      <ClarificationModal
        pending={pendingClarifications}
        plan={plan}
        clarificationTyping={clarificationTyping}
        setClarificationTyping={setClarificationTyping}
        answerClarification={answerClarification}
      />
      </div>
    </div>
  );
}

// ============================================================
//  Plan review — horizontal timeline + detail box
// ============================================================

/** Map a shot's structure role (hook / intro / body / cta / outro / …)
 *  to a CSS color, used for the beat-colored top bar on each timeline
 *  segment. */
function roleColor(role: string): string {
  const r = role.toLowerCase();
  if (r.includes('hook')) return 'var(--accent)';
  if (r.includes('intro')) return '#9ecbff';
  if (r.includes('body')) return 'var(--ai)';
  if (r.includes('cta') || r.includes('outro')) return 'var(--good)';
  return 'var(--ink-3)';
}

/** Upsert one shot's curation into the (possibly null) curation state.
 *  Used by the streaming progress / partial events so each shot's clips
 *  appear the moment they're collected; the awaited bulk result still
 *  replaces the whole state at the end as the authoritative version. */
function upsertShotCuration(
  prev: CurationResult | null,
  shot: ShotCuration,
): CurationResult {
  const base: CurationResult = prev ?? {
    shots: [],
    traces: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    duration_ms: 0,
  };
  const i = base.shots.findIndex(
    (s) => s != null && s.shot_idx === shot.shot_idx,
  );
  const shots =
    i >= 0
      ? base.shots.map((s, j) => (j === i ? shot : s))
      : [...base.shots, shot];
  return { ...base, shots };
}

/** Distill a shot's curation state into one of four UI states for
 *  the timeline segment's status pip. */
function curationStatus(
  sc: ShotCuration | null,
): 'idle' | 'working' | 'ready' | 'fail' {
  if (!sc) return 'idle';
  if (sc.failure_reason && sc.candidates.length === 0) return 'fail';
  if (sc.candidates.length > 0 || sc.library_fulfilled) return 'ready';
  return 'working';
}

/** Inline SVG icons used by timeline segments. Single-purpose, no
 *  styling — color is driven by parent .hseg-icon class. */
function StateIcon({
  status,
}: {
  status: 'idle' | 'working' | 'ready' | 'fail';
}): React.JSX.Element {
  // refresh — re-run an already-curated shot
  if (status === 'ready') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
        <path d="M13 3v3h-3" />
        <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
        <path d="M3 13v-3h3" />
      </svg>
    );
  }
  // search — needs media found
  if (status === 'idle') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7" cy="7" r="4" />
        <path d="m13 13-2.8-2.8" />
      </svg>
    );
  }
  // spinner — agent working
  if (status === 'working') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M8 1.5v3" />
        <path d="M8 11.5v3" opacity="0.3" />
        <path d="M14.5 8h-3" opacity="0.5" />
        <path d="M4.5 8h-3" opacity="0.7" />
        <path d="m12.6 3.4-2.1 2.1" opacity="0.4" />
        <path d="m5.5 10.5-2.1 2.1" opacity="0.8" />
        <path d="m12.6 12.6-2.1-2.1" opacity="0.6" />
        <path d="m5.5 5.5-2.1-2.1" opacity="0.9" />
      </svg>
    );
  }
  // alert — failed
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v6" />
      <circle cx="8" cy="12" r="0.5" fill="currentColor" />
      <path d="M8 1.5 14.5 13H1.5L8 1.5Z" />
    </svg>
  );
}

function ClockGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 1.5" />
    </svg>
  );
}

function RefreshGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
      <path d="M13 3v3h-3" />
      <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
      <path d="M3 13v-3h3" />
    </svg>
  );
}

function PencilGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m11 2.5 2.5 2.5L5 13.5H2.5V11Z" />
      <path d="m9.5 4 2.5 2.5" />
    </svg>
  );
}

function TrashGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h10" />
      <path d="M6 4V2.5h4V4" />
      <path d="M4.5 4 5 13.5h6L11.5 4" />
      <path d="M6.5 6.5v5" />
      <path d="M9.5 6.5v5" />
    </svg>
  );
}

function PlayGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3.5v9l7-4.5Z" />
    </svg>
  );
}

/** One segment in the horizontal timeline. Width is proportional to
 *  the shot's duration via flex-grow. Colored top bar by structure
 *  role, small status dot in the top-right, action icon in the
 *  bottom-left, click the card to select. */
function HSeg({
  shot,
  selected,
  status,
  onSelect,
}: {
  shot: ShotPlan;
  selected: boolean;
  status: 'idle' | 'working' | 'ready' | 'fail';
  onSelect: () => void;
}): React.JSX.Element {
  const start = shot.start_ms / 1000;
  const dur = shot.duration_ms / 1000;
  return (
    <button
      type="button"
      className={`hseg ${selected ? 'sel' : ''}`}
      style={{
        flexGrow: Math.max(1, shot.duration_ms),
        ['--seg-color' as string]: roleColor(shot.structure_role),
      }}
      onClick={onSelect}
    >
      <span className="hseg-bar" />
      <div className="hseg-top">
        <span className="hseg-num">{String(shot.shot_idx + 1).padStart(2, '0')}</span>
        <span className="hseg-beat">{shot.structure_role}</span>
        <span className={`hseg-dot ${status}`} />
      </div>
      <div className="hseg-time">
        {start.toFixed(1)}s
        <span className="hseg-dur">+{dur.toFixed(1)}s</span>
      </div>
      <div className="hseg-script">
        {shot.spoken_during || shot.broll_description || '—'}
      </div>
      <div className={`hseg-icon ${status}`}>
        <StateIcon status={status} />
      </div>
    </button>
  );
}

/** Vertical timeline segment — a fixed-height shot row. The rail scrolls
 *  when the shots overflow the column (the rail is the only scroller in
 *  the plan view). */
/** Reads the audio clip's length off its metadata for the hover popup. SFX
 *  events are point onsets, so the "duration" is the clip's own play length. */
function SfxDuration({ url }: { url?: string }): React.JSX.Element | null {
  const [secs, setSecs] = useState<number | null>(null);
  useEffect(() => {
    setSecs(null);
    if (!url) return;
    const audio = new Audio();
    audio.preload = 'metadata';
    const onLoaded = (): void => {
      if (Number.isFinite(audio.duration)) setSecs(audio.duration);
    };
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.src = url;
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.src = '';
    };
  }, [url]);
  if (secs === null) return null;
  return <span> · {secs.toFixed(2)}s long</span>;
}

/** Horizontal, duration-proportional timeline with draggable boundaries.
 *  Dragging the handle between two shots moves their SHARED edge — shot i's
 *  end and shot i+1's start move together — so the total reel length and all
 *  other shots stay put. Commits on release (live drag is local-only so the
 *  plan/curation don't thrash mid-drag). */
function ShotTimelineBar({
  shots,
  totalDurationMs,
  selectedShotIdx,
  onSelectShot,
  onCommitBoundary,
  onSnapBoundary,
  sfxEvents = [],
  onMoveSfx,
  onRemoveSfx,
}: {
  shots: ShotPlan[];
  totalDurationMs: number;
  selectedShotIdx: number | null;
  onSelectShot: (shotIdx: number) => void;
  /** boundaryIdx = array index of the LEFT shot of the dragged edge. */
  onCommitBoundary: (boundaryIdx: number, newMs: number) => void;
  /** Snap a boundary back to its original position (double-click). */
  onSnapBoundary: (boundaryIdx: number) => void;
  /** SFX markers to show on a lane above the bar, by reel-time ms. */
  sfxEvents?: { ms: number; type: string; sound?: string; url?: string }[];
  /** Commit a dragged SFX marker to a new reel-time ms. */
  onMoveSfx?: (index: number, newMs: number) => void;
  /** Delete an SFX onset (from the hover popup). */
  onRemoveSfx?: (index: number) => void;
}): React.JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ idx: number; ms: number } | null>(null);
  const [sfxDrag, setSfxDrag] = useState<{ idx: number; ms: number } | null>(
    null,
  );
  // Index of the SFX marker whose hover popup is open. A short close-delay
  // (cleared when the cursor enters the popup) lets the user move from the
  // marker onto the popup to click delete without it vanishing.
  const [sfxHover, setSfxHover] = useState<number | null>(null);
  const hoverCloseRef = useRef<number | null>(null);
  const openSfxHover = (i: number): void => {
    if (hoverCloseRef.current !== null) {
      window.clearTimeout(hoverCloseRef.current);
      hoverCloseRef.current = null;
    }
    setSfxHover(i);
  };
  const closeSfxHoverSoon = (): void => {
    if (hoverCloseRef.current !== null)
      window.clearTimeout(hoverCloseRef.current);
    hoverCloseRef.current = window.setTimeout(() => setSfxHover(null), 140);
  };
  const total = Math.max(1, totalDurationMs);

  // Apply the active drag to a local view so the bar updates live.
  const bounds = shots.map((s) => ({ start: s.start_ms, end: s.end_ms }));
  if (drag && bounds[drag.idx] && bounds[drag.idx + 1]) {
    bounds[drag.idx] = { ...bounds[drag.idx], end: drag.ms };
    bounds[drag.idx + 1] = { ...bounds[drag.idx + 1], start: drag.ms };
  }

  const clampBoundary = (idx: number, ms: number): number => {
    return snapBoundaryToTranscript(shots[idx], shots[idx + 1], ms);
  };
  const msFromX = (clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.round(((clientX - rect.left) / rect.width) * total);
  };

  const onMove = (e: React.PointerEvent): void => {
    if (sfxDrag) {
      setSfxDrag({
        idx: sfxDrag.idx,
        ms: Math.max(0, Math.min(total, msFromX(e.clientX))),
      });
      return;
    }
    if (!drag) return;
    setDrag({ idx: drag.idx, ms: clampBoundary(drag.idx, msFromX(e.clientX)) });
  };
  const onUp = (): void => {
    if (sfxDrag) {
      onMoveSfx?.(sfxDrag.idx, sfxDrag.ms);
      setSfxDrag(null);
      return;
    }
    if (drag) onCommitBoundary(drag.idx, drag.ms);
    setDrag(null);
  };

  return (
    <div className="shot-tl">
      <div
        className="shot-tl-bar"
        ref={barRef}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => drag && onUp()}
      >
        {shots.map((s, i) => {
          const b = bounds[i];
          const w = ((b.end - b.start) / total) * 100;
          return (
            <button
              type="button"
              key={s.shot_idx}
              className={`shot-tl-seg${s.shot_idx === selectedShotIdx ? ' sel' : ''}`}
              style={{
                width: `${w}%`,
                ['--seg-color' as string]: roleColor(s.structure_role),
              }}
              onClick={() => onSelectShot(s.shot_idx)}
              title={`Shot ${s.shot_idx + 1} · ${(b.start / 1000).toFixed(1)}s – ${(b.end / 1000).toFixed(1)}s (${((b.end - b.start) / 1000).toFixed(1)}s)`}
            >
              <span className="shot-tl-seg-num">{s.shot_idx + 1}</span>
            </button>
          );
        })}
        {shots.slice(0, -1).map((s, i) => (
          <div
            key={`h-${s.shot_idx}`}
            className={`shot-tl-handle${drag?.idx === i ? ' drag' : ''}`}
            style={{ left: `${(bounds[i].end / total) * 100}%` }}
            onPointerDown={(e) => {
              e.preventDefault();
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              setDrag({ idx: i, ms: shots[i].end_ms });
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              setDrag(null);
              onSnapBoundary(i);
            }}
            title="Drag to move the cut · double-click to snap back"
          />
        ))}
        {sfxEvents.map((ev, i) => {
          const ms = sfxDrag?.idx === i ? sfxDrag.ms : ev.ms;
          return (
            <button
              type="button"
              key={`sfx-${i}`}
              className={`shot-tl-sfx${sfxDrag?.idx === i ? ' drag' : ''}`}
              style={{
                left: `${(ms / total) * 100}%`,
                background: colorForSfx(ev),
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                setSfxDrag({ idx: i, ms: ev.ms });
              }}
              onMouseEnter={() => {
                if (!sfxDrag) openSfxHover(i);
              }}
              onMouseLeave={closeSfxHoverSoon}
            />
          );
        })}
      </div>
      {sfxHover !== null && sfxEvents[sfxHover] && !sfxDrag && (
        <div
          className="shot-tl-sfx-pop"
          style={{ left: `${(sfxEvents[sfxHover].ms / total) * 100}%` }}
          onMouseEnter={() => openSfxHover(sfxHover)}
          onMouseLeave={closeSfxHoverSoon}
        >
          <span
            className="shot-tl-sfx-pop-dot"
            style={{ background: colorForSfx(sfxEvents[sfxHover]) }}
          />
          <div className="shot-tl-sfx-pop-body">
            <div className="shot-tl-sfx-pop-name">
              {sfxEvents[sfxHover].sound ??
                SFX_TYPE_LABELS[sfxEvents[sfxHover].type] ??
                sfxEvents[sfxHover].type}
            </div>
            <div className="shot-tl-sfx-pop-meta">
              {(sfxEvents[sfxHover].ms / 1000).toFixed(2)}s
              <SfxDuration url={sfxEvents[sfxHover].url} />
            </div>
          </div>
          <button
            type="button"
            className="shot-tl-sfx-pop-del"
            title="Delete this sound effect"
            onClick={() => {
              const idx = sfxHover;
              setSfxHover(null);
              onRemoveSfx?.(idx);
            }}
          >
            Delete
          </button>
        </div>
      )}
      <div className="shot-tl-scale">
        <span>0s</span>
        <span>
          {drag
            ? `cut @ ${(drag.ms / 1000).toFixed(2)}s`
            : 'drag a divider to move a cut'}
        </span>
        <span>{(total / 1000).toFixed(1)}s</span>
      </div>
    </div>
  );
}

function VSeg({
  shot,
  selected,
  status,
  onSelect,
  draggingPick = false,
  onPickDrop,
  copiedPickCount = 0,
  onPastePicks,
}: {
  shot: ShotPlan;
  selected: boolean;
  status: 'idle' | 'working' | 'ready' | 'fail';
  onSelect: () => void;
  draggingPick?: boolean;
  onPickDrop?: () => void;
  copiedPickCount?: number;
  onPastePicks?: () => void;
}): React.JSX.Element {
  const start = shot.start_ms / 1000;
  const dur = shot.duration_ms / 1000;
  return (
    <button
      type="button"
      className={`vseg ${selected ? 'sel' : ''}${draggingPick ? ' vseg-drop' : ''}`}
      style={{ ['--seg-color' as string]: roleColor(shot.structure_role) }}
      onClick={onSelect}
      onDragOver={(e) => {
        if (!onPickDrop) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        if (!onPickDrop) return;
        e.preventDefault();
        onPickDrop();
        onSelect();
      }}
      onContextMenu={(e) => {
        if (!onPastePicks || copiedPickCount <= 0) return;
        e.preventDefault();
        onPastePicks();
        onSelect();
      }}
      title={
        copiedPickCount > 0
          ? `Right-click to paste ${copiedPickCount} copied pick${copiedPickCount === 1 ? '' : 's'}`
          : undefined
      }
    >
      <span className="vseg-bar" />
      <span className="vseg-num">
        {String(shot.shot_idx + 1).padStart(2, '0')}
      </span>
      <span className="vseg-mid">
        <span className="vseg-beat">{shot.structure_role}</span>
        <span className="vseg-time">
          {start.toFixed(1)}s +{dur.toFixed(1)}s
        </span>
      </span>
      <span className={`vseg-dot ${status}`} />
    </button>
  );
}

/** "Export video" action: renders the current plan into a real mp4 via the
 *  deterministic frame-capture pipeline in main, showing live progress and a
 *  playable result. Self-contained so it can sit in the review toolbar. */
function ExportReelButton({
  plan,
  curation,
  targetVideoUrl = null,
  targetVideoPath = null,
}: {
  plan: SuggestedEdit;
  curation: CurationResult | null;
  /** The resolved creator/narration video the preview uses — needed so the
   *  export's narration bed + creator-shot video match the preview (the plan's
   *  own target_video_path is often null for non-local targets). */
  targetVideoUrl?: string | null;
  targetVideoPath?: string | null;
}): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>(
    'idle',
  );
  const [progress, setProgress] = useState<ExportProgressEvent | null>(null);
  const [result, setResult] = useState<{
    url: string | null;
    outPath: string;
    hasAudio: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef<string | null>(null);

  const phaseLabel = (p: ExportProgressEvent | null): string => {
    if (!p) return 'Preparing…';
    if (p.phase === 'frames') {
      const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
      return `Rendering frames ${p.done}/${p.total} (${pct}%)`;
    }
    if (p.phase === 'audio') return 'Building audio…';
    if (p.phase === 'mux') return 'Muxing…';
    if (p.phase === 'done') return 'Done';
    return 'Error';
  };

  const run = async (): Promise<void> => {
    if (typeof window.api?.exportReel !== 'function') {
      setError('exportReel not available — restart the dev server.');
      setStatus('error');
      return;
    }
    const request_id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `exp-${Date.now()}`;
    reqRef.current = request_id;
    setStatus('running');
    setProgress(null);
    setError(null);
    setResult(null);
    const unsub = window.api.onExportProgress(({ request_id: id, event }) => {
      if (id !== request_id) return;
      setProgress(event);
    });
    try {
      const res = (await window.api.exportReel({
        request_id,
        plan,
        curation,
        fps: 30,
        target_video_url: targetVideoUrl,
        target_video_path: targetVideoPath,
      })) as ExportReelResponse;
      if (res.ok) {
        setResult({
          url: res.url,
          outPath: res.out_path,
          hasAudio: res.has_audio,
        });
        setStatus('done');
      } else {
        setError(res.error);
        setStatus('error');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    } finally {
      unsub();
      reqRef.current = null;
    }
  };

  const cancel = (): void => {
    if (reqRef.current) void window.api.stopExport(reqRef.current);
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void run()}
        disabled={status === 'running' || !(plan.shots ?? []).length}
        title="Render this plan into a vertical mp4"
      >
        {status === 'running' ? phaseLabel(progress) : '⬇ Export video'}
      </button>
      {status === 'running' && (
        <button type="button" className="btn btn-ghost" onClick={cancel}>
          Cancel
        </button>
      )}
      {status === 'error' && error && (
        <span className="export-error" title={error}>
          ⚠ {error.length > 80 ? error.slice(0, 80) + '…' : error}
        </span>
      )}
      {status === 'done' && result && (
        <div
          className="preview-modal-backdrop"
          onClick={() => setStatus('idle')}
        >
          <div
            className="export-result-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="preview-modal-head">
              <div className="preview-modal-head-text">
                <span className="preview-modal-eyebrow">Exported reel</span>
                <span className="preview-modal-title">
                  {result.hasAudio ? 'With audio' : 'No audio track'}
                </span>
              </div>
              <button
                type="button"
                className="preview-modal-close"
                onClick={() => setStatus('idle')}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="export-result-media">
              {result.url ? (
                <video src={result.url} controls autoPlay playsInline />
              ) : (
                <div className="export-result-path">{result.outPath}</div>
              )}
            </div>
            <div className="export-result-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void window.api.showItemInFolder(result.outPath)}
              >
                Reveal in Finder
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStatus('idle')}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PlanReview({
  plan,
  onPlanChange,
  curation,
  pastedMedia,
  recordPrompt,
  onCurateShot,
  onRegenerate,
  onContinue,
  onAddClip,
  topActions,
  stageNav,
  agentActivity,
  targetVideoUrl = null,
  targetVideoPath = null,
  narrationVideoPath = null,
}: {
  plan: SuggestedEdit;
  onPlanChange: (next: SuggestedEdit) => void;
  curation: CurationResult | null;
  pastedMedia: PastedMediaEntry[];
  recordPrompt?: (source: string, text: string, shotIdx?: number | null) => void;
  onCurateShot: (shotIdx: number, userPrompt?: string) => Promise<void>;
  onRegenerate: (shotIdx: number, userPrompt: string) => Promise<void>;
  onContinue: (shotIdx: number, userPrompt: string) => Promise<void>;
  onAddClip: (shotIdx: number, description: string) => Promise<AddClipResult>;
  topActions?: PlanTopActions;
  stageNav?: StageNav;
  agentActivity?: AgentActivity;
  targetVideoUrl?: string | null;
  targetVideoPath?: string | null;
  /** Original target file (with audio) for narration — distinct from the
   *  -an-stripped preview video used for visuals. */
  narrationVideoPath?: string | null;
}): React.JSX.Element {
  const totalCandidates =
    curation?.shots.reduce((n, s) => n + (s?.candidates?.length ?? 0), 0) ?? 0;
  // Pasted clipboard media leads the library (most recent first), then
  // the curated candidates.
  const mediaLibrary = useMemo(
    () => [...pastedMediaToLibrary(pastedMedia), ...buildMediaLibrary(curation)],
    [curation, pastedMedia],
  );
  const devtools = React.useContext(DevtoolsContext);
  const contractValidation = useMemo(
    () => validatePlanContractLocal(plan),
    [plan],
  );

  // SFX timeline shown (and dragged) on the top timeline bar. Resolved by
  // main from hand-edited events if present, else the transcript+inspiration
  // cadence. Dragging a marker materializes plan.sfx_events.
  const [sfxTimeline, setSfxTimeline] = useState<
    { ms: number; type: string; sound?: string; url?: string; volume?: number }[]
  >([]);
  const sfxKey =
    `${narrationVideoPath ?? ''}#` +
    `${(plan.sfx_events ?? []).map((e) => `${e.ms}:${e.type}:${e.sound ?? ''}:${e.volume ?? ''}`).join(',')}#` +
    `${plan.sfx_override?.cadence ?? ''}:${plan.sfx_override?.type ?? ''}:${plan.sfx_override?.sound ?? ''}#` +
    `${plan.sfx_plan?.signals.sfx_per_word.toFixed(2) ?? ''}`;
  useEffect(() => {
    if (typeof window.api?.getSfxTimeline !== 'function') {
      setSfxTimeline([]);
      return;
    }
    if (!narrationVideoPath && !(plan.sfx_events?.length)) {
      setSfxTimeline([]);
      return;
    }
    let cancelled = false;
    void window.api
      .getSfxTimeline({
        narrationPath: narrationVideoPath ?? '',
        shots: plan.shots.map((s) => ({
          sfx_cue: s.sfx_cue ?? null,
          start_ms: s.start_ms,
          duration_ms: s.duration_ms,
        })),
        sfxPlan: plan.sfx_plan ?? null,
        override: plan.sfx_override ?? null,
        events: plan.sfx_events ?? null,
      })
      .then((tl) => {
        if (!cancelled) {
          setSfxTimeline(
            (tl ?? []).map((e) => ({
              ms: e.ms,
              type: e.type,
              sound: e.sound,
              url: e.url,
              volume: e.volume,
            })),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setSfxTimeline([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sfxKey]);

  // Drag a marker -> materialize the displayed timeline into editable
  // plan.sfx_events with that one moved. From then on, sfx_events is the
  // source of truth for preview + export.
  const materializeTimeline = (): {
    ms: number;
    type: SfxType;
    sound?: string;
    volume?: number;
  }[] =>
    sfxTimeline.map((e) => ({
      ms: e.ms,
      type: e.type as SfxType,
      ...(e.sound ? { sound: e.sound } : {}),
      ...(typeof e.volume === 'number' ? { volume: e.volume } : {}),
    }));
  const moveSfxEvent = (index: number, newMs: number): void => {
    const base = materializeTimeline();
    if (!base[index]) return;
    base[index] = { ...base[index], ms: Math.max(0, Math.round(newMs)) };
    base.sort((a, b) => a.ms - b.ms);
    onPlanChange({ ...plan, sfx_events: base });
  };
  // Delete one SFX onset (from the hover popup). Materializes the displayed
  // timeline minus that event so sfx_events becomes the source of truth.
  const removeSfxEvent = (index: number): void => {
    const base = materializeTimeline().filter((_, i) => i !== index);
    onPlanChange({ ...plan, sfx_events: base });
  };

  useEffect(() => {
    const seen = new Set<string>();
    const nextShots: ShotPlan[] = [];
    let removed = false;
    for (const shot of plan.shots) {
      const key = shotDuplicateKey(shot);
      if (seen.has(key)) {
        removed = true;
        continue;
      }
      seen.add(key);
      nextShots.push(shot);
    }
    if (!removed) return;
    let cursor = 0;
    const reflowed = nextShots.map((shot, i) => {
      const duration = Math.max(1, shot.duration_ms || shot.end_ms - shot.start_ms);
      const start_ms = cursor;
      const end_ms = start_ms + duration;
      cursor = end_ms;
      return { ...shot, shot_idx: i, start_ms, end_ms, duration_ms: duration };
    });
    onPlanChange({ ...plan, total_duration_ms: cursor, shots: reflowed });
  }, [plan, onPlanChange]);

  // Per-shot concept selection: shot_idx → chosen index into
  // shot.options. Absent = the synthesizer's primary (index 0). Held in
  // local state so picking doesn't persist on every click — it commits
  // to the plan only when the user confirms.
  const [selections, setSelections] = useState<Map<number, number>>(
    () => new Map(),
  );
  const [storyboardOpen, setStoryboardOpen] = useState(false);
  const [repromptOpen, setRepromptOpen] = useState(false);
  const [repromptMode, setRepromptMode] = useState<'plan' | 'shot' | 'all_shots'>('plan');
  const [repromptText, setRepromptText] = useState('');
  const [repromptBusy, setRepromptBusy] = useState(false);
  const [regenerateAllOpen, setRegenerateAllOpen] = useState(false);
  const [regenerateAllText, setRegenerateAllText] = useState('');
  const [regenerateAllBusy, setRegenerateAllBusy] = useState(false);
  const [filterExistingBusy, setFilterExistingBusy] = useState(false);
  const [autoAssignBusy, setAutoAssignBusy] = useState(false);
  const [draggedPick, setDraggedPick] = useState<{
    sourceShotIdx: number;
    sourcePickIdx: number;
  } | null>(null);
  const [pickClipboard, setPickClipboard] = useState<PickClipboard>(null);
  const transcriptRef = useRef<HTMLTextAreaElement | null>(null);
  const selectOption = (shotIdx: number, optionIdx: number): void => {
    setSelections((prev) => {
      const next = new Map(prev);
      next.set(shotIdx, optionIdx);
      return next;
    });
  };
  const autoAssignLibraryMedia = async (): Promise<void> => {
    if (mediaLibrary.length === 0 || !curation) return;
    if (typeof window.api?.autoAssignMedia !== 'function') {
      alert('autoAssignMedia not available yet — restart the desktop app so the new preload bundle loads.');
      return;
    }
    setAutoAssignBusy(true);
    try {
      const result = await window.api.autoAssignMedia({ plan, curation });
      if ('error' in result) {
        alert(result.error);
        return;
      }
      await onPlanChange(result);
    } finally {
      setAutoAssignBusy(false);
    }
  };
  const pendingSelections = Array.from(selections.entries()).filter(
    ([shotIdx, idx]) => {
      const shot = plan.shots.find((s) => s.shot_idx === shotIdx);
      return idx > 0 && !!shot && !!shot.options[idx];
    },
  ).length;
  /** Commit each shot's picked concept: promote it to options[0] (the
   *  primary slot the curator + mockup read) and mirror its fields to
   *  the top level. Then reveal the storyboard. */
  const confirmSelections = (): void => {
    const nextShots = plan.shots.map((s) => {
      const sel = selections.get(s.shot_idx) ?? 0;
      const chosen = s.options[sel];
      if (sel === 0 || !chosen) return s;
      const reordered = [chosen, ...s.options.filter((_, i) => i !== sel)];
      return {
        ...s,
        options: reordered,
        broll_description: chosen.broll_description,
        asset: chosen.asset,
        placement: chosen.placement,
        source_type: chosen.source_type,
      };
    });
    setSelections(new Map());
    setStoryboardOpen(true);
    onPlanChange({ ...plan, shots: nextShots });
  };
  /** Update one shot in the plan (matched by shot_idx). Mutates the
   *  top-level mirror fields AND options[0] so the curator sees the
   *  edited values whichever path it reads. */
  const updateShot = (shotIdx: number, patch: Partial<ShotPlan>): void => {
    const nextShots = plan.shots.map((s) => {
      if (s.shot_idx !== shotIdx) return s;
      const merged = { ...s, ...patch };
      // Keep options[0] in sync with the user-edited top-level mirror.
      if (merged.options.length > 0) {
        merged.options = merged.options.map((o, i) =>
          i === 0
            ? {
                ...o,
                broll_description: merged.broll_description,
                asset: merged.asset,
                placement: merged.placement,
                source_type: merged.source_type,
              }
            : o,
        );
      }
      return merged;
    });
    onPlanChange({ ...plan, shots: nextShots });
  };
  // Move the shared cut between shots[boundaryIdx] and shots[boundaryIdx+1] to
  // newMs: the left shot's end and the right shot's start move together, so the
  // total reel length and every other shot are untouched. Clamped so neither
  // side drops below MIN_SHOT_MS.
  const adjustShotBoundary = (boundaryIdx: number, newMs: number): void => {
    const shots = plan.shots;
    if (boundaryIdx < 0 || boundaryIdx >= shots.length - 1) return;
    const left = shots[boundaryIdx];
    const right = shots[boundaryIdx + 1];
    const lo = left.start_ms + MIN_SHOT_MS;
    const hi = right.end_ms - MIN_SHOT_MS;
    const edge = snapBoundaryToTranscript(
      left,
      right,
      Math.max(lo, Math.min(hi, Math.round(newMs))),
    );
    if (edge === left.end_ms) return;
    const split = splitAdjacentShotsAtTranscriptBoundary(left, right, edge);
    const nextShots = shots.map((s, i) => {
      if (i === boundaryIdx) {
        return split.left;
      }
      if (i === boundaryIdx + 1) {
        return split.right;
      }
      return s;
    });
    setTimingUndo((prev) => [...prev, shots].slice(-50));
    onPlanChange({ ...plan, shots: nextShots });
  };
  // Snap one boundary back to its original (as-loaded) position.
  const snapBoundary = (boundaryIdx: number): void => {
    const orig = originalBoundsRef.current.get(
      plan.shots[boundaryIdx]?.shot_idx,
    );
    if (orig) adjustShotBoundary(boundaryIdx, orig.end_ms);
  };
  // Undo the most recent timing edit by restoring only the timing fields from
  // the snapshot (so unrelated edits made since aren't clobbered).
  const undoTiming = (): void => {
    if (!timingUndo.length) return;
    const snap = timingUndo[timingUndo.length - 1];
    const byIdx = new Map(snap.map((s) => [s.shot_idx, s]));
    const nextShots = plan.shots.map((s) => {
      const o = byIdx.get(s.shot_idx);
      return o
        ? { ...s, start_ms: o.start_ms, end_ms: o.end_ms, duration_ms: o.duration_ms }
        : s;
    });
    setTimingUndo((prev) => prev.slice(0, -1));
    onPlanChange({ ...plan, shots: nextShots });
  };
  // Reset ALL boundaries to their original (as-loaded) positions.
  const resetTiming = (): void => {
    const orig = originalBoundsRef.current;
    const changed = plan.shots.some((s) => {
      const o = orig.get(s.shot_idx);
      return o && (o.start_ms !== s.start_ms || o.end_ms !== s.end_ms);
    });
    if (!changed) return;
    const nextShots = plan.shots.map((s) => {
      const o = orig.get(s.shot_idx);
      return o
        ? { ...s, start_ms: o.start_ms, end_ms: o.end_ms, duration_ms: o.duration_ms }
        : s;
    });
    setTimingUndo((prev) => [...prev, plan.shots].slice(-50));
    onPlanChange({ ...plan, shots: nextShots });
  };
  const moveSelectedMediaPick = (
    sourceShotIdx: number,
    sourcePickIdx: number,
    destShotIdx: number,
    destPickIdx?: number,
  ): void => {
    const sourceShot = plan.shots.find((s) => s.shot_idx === sourceShotIdx);
    const pick = sourceShot ? getSelections(sourceShot)[sourcePickIdx] : null;
    if (!pick) return;

    if (sourceShotIdx === destShotIdx) {
      const sourcePicks = getSelections(sourceShot);
      const nextPicks = sourcePicks.slice();
      const [moved] = nextPicks.splice(sourcePickIdx, 1);
      if (!moved) return;
      const rawInsert = destPickIdx ?? nextPicks.length;
      const insertIdx =
        destPickIdx !== undefined && destPickIdx > sourcePickIdx
          ? rawInsert - 1
          : rawInsert;
      nextPicks.splice(Math.max(0, Math.min(nextPicks.length, insertIdx)), 0, moved);
      updateShot(sourceShotIdx, { selected_media: nextPicks });
      return;
    }

    const nextShots = plan.shots.map((shot) => {
      if (shot.shot_idx === sourceShotIdx) {
        const nextPicks = getSelections(shot).filter((_, i) => i !== sourcePickIdx);
        return { ...shot, selected_media: nextPicks };
      }
      if (shot.shot_idx === destShotIdx) {
        const nextPicks = getSelections(shot).slice();
        const insertIdx = Math.max(
          0,
          Math.min(nextPicks.length, destPickIdx ?? nextPicks.length),
        );
        nextPicks.splice(insertIdx, 0, pick);
        return { ...shot, selected_media: nextPicks };
      }
      return shot;
    });
    onPlanChange({ ...plan, shots: nextShots });
  };
  const copySelectedMediaPicks = (
    sourceShotIdx: number,
    sourcePickIdx?: number,
  ): void => {
    const sourceShot = plan.shots.find((s) => s.shot_idx === sourceShotIdx);
    const sourcePicks = getSelections(sourceShot);
    const picksToCopy =
      sourcePickIdx === undefined
        ? sourcePicks
        : sourcePicks[sourcePickIdx]
          ? [sourcePicks[sourcePickIdx]]
          : [];
    if (picksToCopy.length === 0) return;
    setPickClipboard({
      sourceShotIdx,
      picks: picksToCopy.map((pick) => ({ ...pick })),
    });
  };
  const pasteSelectedMediaPicks = (
    destShotIdx: number,
    destPickIdx?: number,
  ): void => {
    if (!pickClipboard || pickClipboard.picks.length === 0) return;
    const copied = pickClipboard.picks.map((pick) => ({ ...pick }));
    const nextShots = plan.shots.map((shot) => {
      if (shot.shot_idx !== destShotIdx) return shot;
      const nextPicks = getSelections(shot).slice();
      const insertIdx = Math.max(
        0,
        Math.min(nextPicks.length, destPickIdx ?? nextPicks.length),
      );
      nextPicks.splice(insertIdx, 0, ...copied);
      return { ...shot, selected_media: nextPicks };
    });
    onPlanChange({ ...plan, shots: nextShots });
  };
  /** Patch the plan-level subtitle (caption) style and persist. Mirrors
   *  updateShot but for the single top-level subtitle_spec the burned-in
   *  captions read from. When the plan never had a detected caption style
   *  (subtitle_spec === null), the patch is applied on top of a default so
   *  the user can author one from scratch. */
  const updateSubtitleSpec = (patch: Partial<SubtitleSpec>): void => {
    const base = plan.subtitle_spec ?? defaultSubtitleSpec();
    onPlanChange({ ...plan, subtitle_spec: { ...base, ...patch } });
  };
  const deleteShot = (shotIdx: number): void => {
    const idx = plan.shots.findIndex((s) => s.shot_idx === shotIdx);
    if (idx === -1) return;
    const removed = plan.shots[idx];
    const prev = idx > 0 ? plan.shots[idx - 1] : null;
    const next = idx < plan.shots.length - 1 ? plan.shots[idx + 1] : null;

    // Split the removed shot's time range AND its spoken script between
    // both neighbors so the timeline stays contiguous (no silent gap,
    // total duration unchanged) and no narration is dropped. The neighbors
    // meet at the midpoint, and the spoken words split there too — head to
    // the previous shot, tail to the next. With only one neighbor, it
    // absorbs the whole range + script.
    const hasBoth = !!prev && !!next;
    const mid = hasBoth
      ? Math.round((removed.start_ms + removed.end_ms) / 2)
      : null;
    const words = removed.spoken_during.trim().split(/\s+/).filter(Boolean);
    const cut = mid !== null ? Math.round(words.length / 2) : 0;
    const headScript = mid !== null ? words.slice(0, cut).join(' ') : '';
    const tailScript = mid !== null ? words.slice(cut).join(' ') : '';
    const removedWords = removed.spoken_words ?? [];
    const headWords = mid !== null ? removedWords.slice(0, cut) : removedWords;
    const tailWords = mid !== null ? removedWords.slice(cut) : removedWords;
    const joinSpoken = (a: string, b: string): string =>
      [a.trim(), b.trim()].filter(Boolean).join(' ');

    const shots = plan.shots
      .filter((s) => s.shot_idx !== shotIdx)
      .map((s) => {
        if (prev && s.shot_idx === prev.shot_idx) {
          const end_ms = mid ?? removed.end_ms;
          return {
            ...s,
            end_ms,
            duration_ms: end_ms - s.start_ms,
            spoken_during: joinSpoken(
              s.spoken_during,
              mid !== null ? headScript : removed.spoken_during,
            ),
            spoken_words: [...(s.spoken_words ?? []), ...headWords],
          };
        }
        if (next && s.shot_idx === next.shot_idx) {
          const start_ms = mid ?? removed.start_ms;
          return {
            ...s,
            start_ms,
            duration_ms: s.end_ms - start_ms,
            spoken_during: joinSpoken(
              mid !== null ? tailScript : removed.spoken_during,
              s.spoken_during,
            ),
            spoken_words: [...tailWords, ...(s.spoken_words ?? [])],
          };
        }
        return s;
      });
    onPlanChange({ ...plan, shots });
  };
  /** Override the layout (placement) of a shot's option. Persists to the
   *  plan immediately so the phone preview reflects it; when the edited
   *  option is the primary (index 0) the top-level mirror is updated too
   *  so the curator + downstream consumers see the new placement. */
  const setLayout = (
    shotIdx: number,
    optionIdx: number,
    placement: BrollPlacement,
  ): void => {
    const nextShots = plan.shots.map((s) => {
      if (s.shot_idx !== shotIdx) return s;
      const options = s.options.map((o, i) =>
        i === optionIdx ? { ...o, placement } : o,
      );
      return optionIdx === 0
        ? { ...s, options, placement }
        : { ...s, options };
    });
    onPlanChange({ ...plan, shots: nextShots });
  };
  /** Set the structured motion preset for a shot's base media. Lives at
   *  the shot level (not per option) — it's a directorial choice for the
   *  slot, applied to whatever media fills it. Persists immediately so
   *  the phone preview animates. */
  const setAnimation = (shotIdx: number, anim: SceneAnimation): void => {
    updateShot(shotIdx, { scene_animation: anim });
  };

  // Selected shot for the detail box. Defaults to the first shot when
  // the plan loads; clears if the shot is deleted. Null shows the
  // "Select a shot" empty state below the timeline.
  const [selectedShotIdx, setSelectedShotIdx] = useState<number | null>(
    () => plan.shots[0]?.shot_idx ?? null,
  );
  // Undo history for shot-timing edits (snapshots of the pre-edit shots),
  // plus the per-shot "original" bounds so a boundary drag can snap back to
  // where it started. Both reset when the shot SET changes (add/delete/merge).
  type ShotBounds = { start_ms: number; end_ms: number; duration_ms: number };
  const [timingUndo, setTimingUndo] = useState<ShotPlan[][]>([]);
  const boundsOf = (ss: ShotPlan[]): Map<number, ShotBounds> =>
    new Map(
      ss.map((s) => [
        s.shot_idx,
        { start_ms: s.start_ms, end_ms: s.end_ms, duration_ms: s.duration_ms },
      ]),
    );
  const originalBoundsRef = useRef<Map<number, ShotBounds>>(
    boundsOf(plan.shots),
  );
  const shotSig = plan.shots.map((s) => s.shot_idx).join(',');
  useEffect(() => {
    originalBoundsRef.current = boundsOf(plan.shots);
    setTimingUndo([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotSig]);
  useEffect(() => {
    if (
      selectedShotIdx !== null &&
      !plan.shots.find((s) => s.shot_idx === selectedShotIdx)
    ) {
      setSelectedShotIdx(plan.shots[0]?.shot_idx ?? null);
    }
  }, [plan.shots, selectedShotIdx]);
  const transcriptBoundsSig = plan.shots
    .map((s) => {
      const words = s.spoken_words ?? [];
      const last = words[words.length - 1];
      return `${s.shot_idx}:${s.start_ms}:${s.end_ms}:${last?.end_ms ?? ''}`;
    })
    .join('|');
  useEffect(() => {
    const aligned = alignShotEndsToTranscript(plan.shots);
    if (!aligned.changed) return;
    setTimingUndo((prev) => [...prev, plan.shots].slice(-50));
    onPlanChange({ ...plan, shots: aligned.shots });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptBoundsSig]);

  const selectedShot =
    selectedShotIdx !== null
      ? (plan.shots.find((s) => s.shot_idx === selectedShotIdx) ?? null)
      : null;
  const selectedCuration =
    selectedShot && curation
      ? (curation.shots.find(
          (c) => c != null && c.shot_idx === selectedShot.shot_idx,
        ) ?? null)
      : null;
  const selectedTrace =
    selectedCuration && curation?.traces
      ? curation.traces[curation.shots.indexOf(selectedCuration)]
      : undefined;

  const shotsWithMedia =
    curation?.shots.filter(
      (s) => s != null && s.candidates.length > 0,
    ).length ?? 0;
  const shotsNeedingMedia = plan.shots.length - shotsWithMedia;
  // Only ACTUAL curation counts as "curated" for the curate/recurate
  // button — pasted media in the library shouldn't make a never-curated
  // plan offer "Recurate".
  const curatedLibraryCount = useMemo(
    () => buildMediaLibrary(curation).length,
    [curation],
  );
  const hasCuratedMedia = shotsWithMedia > 0 || curatedLibraryCount > 0;
  const selectedScript = selectedShot?.spoken_during.trim() ?? '';
  const updateSelectedScript = (value: string): void => {
    if (!selectedShot) return;
    updateShot(selectedShot.shot_idx, { spoken_during: value });
  };
  const findSelectedShotIndex = (): number =>
    selectedShot
      ? plan.shots.findIndex((s) => s.shot_idx === selectedShot.shot_idx)
      : -1;
  const splitSelectedShot = (): void => {
    if (!selectedShot) return;
    const text = selectedShot.spoken_during;
    const cursor =
      transcriptRef.current?.selectionStart ??
      transcriptRef.current?.value.length ??
      0;
    let cut = cursor;
    if (cut <= 0 || cut >= text.length) {
      const words = text.trim().split(/\s+/).filter(Boolean);
      if (words.length < 2) return;
      const head = words.slice(0, Math.ceil(words.length / 2)).join(' ');
      cut = head.length;
    }
    while (cut > 0 && /\S/.test(text[cut - 1] ?? '')) cut -= 1;
    if (cut <= 0) {
      cut = cursor;
      while (cut < text.length && /\S/.test(text[cut] ?? '')) cut += 1;
    }
    const firstText = text.slice(0, cut).trim();
    const secondText = text.slice(cut).trim();
    if (!firstText || !secondText) return;

    const idx = findSelectedShotIndex();
    if (idx < 0) return;
    const firstWords = firstText.split(/\s+/).filter(Boolean).length;
    const secondWords = secondText.split(/\s+/).filter(Boolean).length;
    const timedWords = selectedShot.spoken_words ?? [];
    const ratio = firstWords / Math.max(1, firstWords + secondWords);
    const minMs = Math.min(350, Math.floor(selectedShot.duration_ms / 2));
    const splitMs = Math.max(
      selectedShot.start_ms + minMs,
      Math.min(
        selectedShot.end_ms - minMs,
        Math.round(selectedShot.start_ms + selectedShot.duration_ms * ratio),
      ),
    );
    const nextShotIdx =
      Math.max(...plan.shots.map((s) => s.shot_idx), selectedShot.shot_idx) + 1;
    const first: ShotPlan = {
      ...selectedShot,
      end_ms: splitMs,
      duration_ms: splitMs - selectedShot.start_ms,
      spoken_during: firstText,
      spoken_words: timedWords.slice(0, firstWords),
    };
    const second: ShotPlan = {
      ...selectedShot,
      shot_idx: nextShotIdx,
      start_ms: splitMs,
      duration_ms: selectedShot.end_ms - splitMs,
      spoken_during: secondText,
      spoken_words: timedWords.slice(firstWords),
      selected_media: [],
    };
    const shots = [
      ...plan.shots.slice(0, idx),
      first,
      second,
      ...plan.shots.slice(idx + 1),
    ];
    onPlanChange({ ...plan, shots });
    setSelectedShotIdx(second.shot_idx);
  };
  const combineSelectedShot = (direction: 'prev' | 'next'): void => {
    const idx = findSelectedShotIndex();
    if (!selectedShot || idx < 0) return;
    const neighborIdx = direction === 'prev' ? idx - 1 : idx + 1;
    const neighbor = plan.shots[neighborIdx];
    if (!neighbor) return;
    const first = direction === 'prev' ? neighbor : selectedShot;
    const second = direction === 'prev' ? selectedShot : neighbor;
    const merged: ShotPlan = {
      ...first,
      end_ms: second.end_ms,
      duration_ms: second.end_ms - first.start_ms,
      spoken_during: [first.spoken_during.trim(), second.spoken_during.trim()]
        .filter(Boolean)
        .join(' '),
      spoken_words: [...(first.spoken_words ?? []), ...(second.spoken_words ?? [])],
      text_overlay: selectedShot.text_overlay,
      text_position: selectedShot.text_position,
      selected_media: getSelections(first).length
        ? getSelections(first)
        : getSelections(second),
    };
    const start = Math.min(idx, neighborIdx);
    const end = Math.max(idx, neighborIdx);
    const shots = [
      ...plan.shots.slice(0, start),
      merged,
      ...plan.shots.slice(end + 1),
    ];
    onPlanChange({ ...plan, shots });
    setSelectedShotIdx(merged.shot_idx);
  };

  return (
    <div className="plan-review">
      <CommandBar
        plan={plan}
        onApply={onPlanChange}
        narrationPath={narrationVideoPath ?? plan.target_video_path ?? null}
        onPrompt={(text) => recordPrompt?.('command_bar', text)}
        onFindClip={(query, shotIdx) => {
          const target =
            shotIdx != null
              ? (plan.shots[shotIdx]?.shot_idx ??
                plan.shots[0]?.shot_idx ??
                0)
              : (selectedShotIdx ?? plan.shots[0]?.shot_idx ?? 0);
          void onCurateShot(target, `find a clip that's ${query}`);
        }}
      />
      {/* compact header — eyebrow on top, then stats + bulk actions */}
      <div className="plan2-top">
        <div className="plan2-eyebrow eyebrow">Step 3 · The plan</div>
        <div className="plan2-top-row">
          <div className="plan2-stats">
            <b>{(plan.total_duration_ms / 1000).toFixed(1)}s</b>
            {curation && (
              <>
                <span className="sep">·</span>
                <b>{shotsWithMedia}</b> with media
              </>
            )}
            <span className="sep">·</span>
            <span className={`conf conf-${plan.structure_confidence}`}>
              ✓ {plan.structure_confidence}
            </span>
            {contractValidation && (
              <>
                <span className="sep">·</span>
                <span
                  className={`contract-score ${contractValidation.issues.length > 0 ? 'warn' : 'ok'}`}
                  title={`${contractValidation.passed}/${contractValidation.total} contract checks passed`}
                >
                  Contract {contractValidation.score}%
                </span>
              </>
            )}
          </div>
          {selectedShot && (
            <div className="plan2-script" title={selectedScript}>
              <span className="plan2-script-label">
                Shot {String(selectedShot.shot_idx + 1).padStart(2, '0')}
              </span>
              <textarea
                ref={transcriptRef}
                className="plan2-script-input plan2-script-textarea"
                rows={2}
                value={selectedShot.spoken_during}
                onChange={(e) => updateSelectedScript(e.currentTarget.value)}
                aria-label={`Edit shot ${selectedShot.shot_idx + 1} script`}
                placeholder="Edit caption/script..."
              />
              <span className="plan2-script-actions">
                <button
                  type="button"
                  className="plan2-script-btn"
                  onClick={() => combineSelectedShot('prev')}
                  disabled={findSelectedShotIndex() <= 0}
                  title="Combine with previous shot"
                >
                  ←
                </button>
                <button
                  type="button"
                  className="plan2-script-btn"
                  onClick={splitSelectedShot}
                  disabled={selectedScript.split(/\s+/).filter(Boolean).length < 2}
                  title="Split at cursor"
                >
                  Split
                </button>
                <button
                  type="button"
                  className="plan2-script-btn"
                  onClick={() => combineSelectedShot('next')}
                  disabled={findSelectedShotIndex() >= plan.shots.length - 1}
                  title="Combine with next shot"
                >
                  →
                </button>
              </span>
            </div>
          )}
          {topActions && (
            <div className="plan2-top-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setRepromptOpen((open) => !open)}
                disabled={
                  topActions.curating ||
                  topActions.regeneratingPlan ||
                  topActions.agentRunningElsewhere
                }
                title="Add details and regenerate the whole shot plan"
              >
                ↻ Reprompt plan
              </button>
              {topActions.curating ? (
                <button
                  type="button"
                  className="btn btn-stop btn-curating"
                  onClick={topActions.onStop}
                  title="Cancel the in-flight library curator agents"
                >
                  <span className="agent-status-spinner" aria-hidden="true" />
                  Curating
                  {topActions.curatingProgress
                    ? ` ${topActions.curatingProgress.completed}/${topActions.curatingProgress.total}`
                    : '…'}
                  <span className="btn-curating-stop">■ stop</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ai"
                  onClick={() => {
                    if (hasCuratedMedia) {
                      setRegenerateAllOpen(true);
                    } else {
                      topActions.onCurateAll(false);
                    }
                  }}
                  disabled={
                    topActions.agentRunningElsewhere ||
                    (!hasCuratedMedia && shotsNeedingMedia === 0)
                  }
                  title={
                    topActions.agentRunningElsewhere
                      ? 'Another project agent is running in the background'
                      : hasCuratedMedia
                      ? 'Recurate the transcript media library from scratch'
                      : shotsNeedingMedia === 0
                        ? 'All shots have media'
                        : `Curate at least ${shotsNeedingMedia} library clip(s) from the transcript`
                  }
                >
                  {hasCuratedMedia
                    ? '↻ Recurate library'
                    : `✦ Curate library ${shotsNeedingMedia || ''}`}
                </button>
              )}
              {devtools && curation && mediaLibrary.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={async () => {
                    setFilterExistingBusy(true);
                    try {
                      await topActions.onFilterExistingScreenshots();
                    } finally {
                      setFilterExistingBusy(false);
                    }
                  }}
                  disabled={filterExistingBusy || topActions.curating}
                  title="Drop off-topic clips (relevance gate), then re-judge the screenshots of what survives"
                >
                  {filterExistingBusy ? 'Filtering…' : 'Filter off-topic'}
                </button>
              )}
              {mediaLibrary.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void autoAssignLibraryMedia()}
                  disabled={autoAssignBusy}
                  title="Pick the best library item and motion for each shot"
                >
                  {autoAssignBusy ? 'Assigning…' : 'Auto assign'}
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={topActions.onPreview}
                disabled={topActions.regeneratingPlan}
              >
                ▶ Preview reel
              </button>
              <ExportReelButton
                plan={plan}
                curation={curation}
                targetVideoUrl={targetVideoUrl}
                // Narration audio must come from the ORIGINAL file — the
                // preview copy (target_video_path) is transcoded with -an
                // (no audio). Fall back to the preview only for the visual.
                targetVideoPath={
                  narrationVideoPath ?? targetVideoPath ?? plan.target_video_path ?? null
                }
              />
            </div>
          )}
        </div>
        {/* Reel-level library curation activity. The library agent
            researches ALL shots in one pass before per-shot capture
            starts, emitting turn events under the synthetic shot_idx -1
            — surface them here so the run isn't silent during phase 1. */}
        {agentActivity && topActions?.curating && (
          <ShotAgentActivity shotIdx={-1} activity={agentActivity} />
        )}
        {topActions && repromptOpen && (
          <form
            className="plan-reprompt"
            onSubmit={async (e) => {
              e.preventDefault();
              setRepromptBusy(true);
              try {
                if (repromptMode === 'shot' && selectedShot) {
                  await topActions.onRegenerateShotIdea(
                    selectedShot.shot_idx,
                    repromptText,
                  );
                } else if (repromptMode === 'all_shots') {
                  await topActions.onRegenerateAllShotIdeas(repromptText);
                } else {
                  await topActions.onRegeneratePlan(repromptText);
                }
                setRepromptText('');
                setRepromptOpen(false);
              } finally {
                setRepromptBusy(false);
              }
            }}
          >
            <div className="plan-reprompt-mode" role="radiogroup">
              <button
                type="button"
                className={`plan-reprompt-mode-btn ${repromptMode === 'plan' ? 'on' : ''}`}
                onClick={() => setRepromptMode('plan')}
                aria-pressed={repromptMode === 'plan'}
              >
                Whole plan
              </button>
              <button
                type="button"
                className={`plan-reprompt-mode-btn ${repromptMode === 'shot' ? 'on' : ''}`}
                onClick={() => setRepromptMode('shot')}
                disabled={!selectedShot}
                aria-pressed={repromptMode === 'shot'}
              >
                Selected shot idea
              </button>
              <button
                type="button"
                className={`plan-reprompt-mode-btn ${repromptMode === 'all_shots' ? 'on' : ''}`}
                onClick={() => setRepromptMode('all_shots')}
                aria-pressed={repromptMode === 'all_shots'}
              >
                All shot ideas
              </button>
            </div>
            <textarea
              className="plan-reprompt-textarea"
              rows={3}
              value={repromptText}
              onChange={(e) => setRepromptText(e.currentTarget.value)}
              placeholder={
                repromptMode === 'shot'
                  ? 'Describe the new visual idea for the selected shot, e.g. "use review/demo clips from YouTube instead of the company homepage."'
                  : repromptMode === 'all_shots'
                    ? 'Describe how to regenerate every shot idea, e.g. "use different sources for each shot and include review/demo reels where relevant."'
                  : 'Add what should change, e.g. "make the first half faster, include more founder visuals, and avoid product screenshots."'
              }
              disabled={topActions.regeneratingPlan || repromptBusy}
              aria-label="Plan regeneration details"
            />
            <div className="plan-reprompt-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setRepromptOpen(false)}
                disabled={topActions.regeneratingPlan || repromptBusy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-ai"
                disabled={
                  topActions.regeneratingPlan ||
                  repromptBusy ||
                  !topActions.canRegeneratePlan ||
                  (repromptMode === 'shot' && !selectedShot) ||
                  repromptText.trim().length === 0
                }
                title={
                  topActions.canRegeneratePlan
                    ? 'Regenerate the full plan with these details'
                    : 'Wait for the current operation to finish'
                }
              >
                {topActions.regeneratingPlan || repromptBusy
                  ? 'Regenerating…'
                  : repromptMode === 'shot'
                    ? '✦ Regenerate shot idea'
                    : repromptMode === 'all_shots'
                      ? '✦ Regenerate all shot ideas'
                    : '✦ Regenerate plan'}
              </button>
            </div>
          </form>
        )}
        {topActions?.regeneratingPlan && (
          <div className="plan-reprompt-status">
            Regenerating plan with updated instructions…
          </div>
        )}
        {repromptBusy && !topActions?.regeneratingPlan && (
          <div className="plan-reprompt-status">
            Regenerating shot ideas…
          </div>
        )}
        {topActions && regenerateAllOpen && (
          <div
            className="regen-modal-backdrop"
            onClick={() => setRegenerateAllOpen(false)}
          >
            <form
              className="regen-modal"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                setRegenerateAllBusy(true);
                setRegenerateAllOpen(false);
                void topActions
                  .onCurateAll(
                    true,
                    regenerateAllText.trim() || undefined,
                  )
                  .finally(() => setRegenerateAllBusy(false));
                setRegenerateAllText('');
              }}
            >
              <div className="regen-modal-head">
                <span className="regen-modal-title">Recurate library</span>
                <button
                  type="button"
                  className="preview-modal-close"
                  onClick={() => setRegenerateAllOpen(false)}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <label className="regen-label" htmlFor="regen-all-media">
                What do you want to see instead?
              </label>
              <textarea
                id="regen-all-media"
                className="regen-textarea"
                rows={4}
                value={regenerateAllText}
                onChange={(e) => setRegenerateAllText(e.currentTarget.value)}
                placeholder='e.g. "more product demo screenshots, fewer homepage hero shots"'
                disabled={regenerateAllBusy}
                autoFocus
              />
              <div className="regen-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setRegenerateAllOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-ai" disabled={regenerateAllBusy}>
                  {regenerateAllBusy ? 'Recurating…' : '↻ Recurate library'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* Draggable shot-boundary timeline — move a cut without shifting the
          rest of the reel. Double-click a divider to snap it back; Undo /
          Reset revert timing edits. */}
      {plan.shots.length > 1 && (
        <div className="shot-tl-wrap">
          <div className="shot-tl-toolbar">
            <span className="shot-tl-title">Shot timing</span>
            <span className="shot-tl-toolbar-spacer" />
            <button
              type="button"
              className="btn btn-mini"
              onClick={undoTiming}
              disabled={timingUndo.length === 0}
              title="Undo the last timing change"
            >
              ↶ Undo{timingUndo.length ? ` (${timingUndo.length})` : ''}
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={resetTiming}
              title="Snap every cut back to its original position"
            >
              ⤺ Reset
            </button>
          </div>
          <ShotTimelineBar
            shots={plan.shots}
            totalDurationMs={plan.total_duration_ms}
            selectedShotIdx={selectedShotIdx}
            onSelectShot={setSelectedShotIdx}
            onCommitBoundary={adjustShotBoundary}
            onSnapBoundary={snapBoundary}
            sfxEvents={sfxTimeline}
            onMoveSfx={moveSfxEvent}
            onRemoveSfx={removeSfxEvent}
          />
        </div>
      )}

      {/* Main row: plan content. */}
      <div className="plan-main-row">
        <div className="plan-main">
          {/* detail box (left) + persistent phone preview sidebar (right). */}
          <div className="plan-review-body">
        {selectedShot ? (
          <div className="detail-box">
            <ShotRow
              key={selectedShot.shot_idx}
              shot={selectedShot}
              onChange={(patch) => updateShot(selectedShot.shot_idx, patch)}
              onDelete={() => deleteShot(selectedShot.shot_idx)}
              curation={selectedCuration}
              mediaLibrary={mediaLibrary}
              trace={selectedTrace}
              onCurateShot={onCurateShot}
              onRegenerate={onRegenerate}
              onContinue={onContinue}
              onAddClip={onAddClip}
              selectedOptionIdx={selections.get(selectedShot.shot_idx) ?? 0}
              onSelectOption={selectOption}
              onSetLayout={setLayout}
              onSetAnimation={setAnimation}
              subtitleSpec={plan.subtitle_spec}
              onSubtitleChange={updateSubtitleSpec}
              stageNav={stageNav}
              agentActivity={agentActivity}
              onPickDragStart={(sourcePickIdx) =>
                setDraggedPick({
                  sourceShotIdx: selectedShot.shot_idx,
                  sourcePickIdx,
                })
              }
              onPickDragEnd={() => setDraggedPick(null)}
              onPickDrop={(destPickIdx) => {
                if (!draggedPick) return;
                moveSelectedMediaPick(
                  draggedPick.sourceShotIdx,
                  draggedPick.sourcePickIdx,
                  selectedShot.shot_idx,
                  destPickIdx,
                );
                setDraggedPick(null);
              }}
              copiedPickCount={pickClipboard?.picks.length ?? 0}
              onCopyPick={(sourcePickIdx) =>
                copySelectedMediaPicks(selectedShot.shot_idx, sourcePickIdx)
              }
              onCopyAllPicks={() =>
                copySelectedMediaPicks(selectedShot.shot_idx)
              }
              onPastePicks={(destPickIdx) =>
                pasteSelectedMediaPicks(selectedShot.shot_idx, destPickIdx)
              }
            />
          </div>
        ) : (
          <div className="please-select">
            <div className="please-select-ic">▶</div>
            <div className="please-select-title">Select a shot</div>
            <div className="please-select-sub">
              Click any segment on the timeline above to open its idea,
              scores, and media options.
            </div>
          </div>
        )}

        <PhoneSidebar
          shot={selectedShot}
          curation={selectedCuration}
          allShots={plan.shots}
          allCuration={curation}
          selectedOptionIdx={
            selectedShot
              ? (selections.get(selectedShot.shot_idx) ?? 0)
              : 0
          }
          subtitleSpec={plan.subtitle_spec}
          targetVideoUrl={targetVideoUrl}
          targetVideoPath={targetVideoPath ?? plan.target_video_path ?? null}
          narrationVideoPath={narrationVideoPath}
          sfxPlan={plan.sfx_plan ?? null}
          sfxOverride={plan.sfx_override ?? null}
          sfxVolume={plan.sfx_volume}
          sfxEvents={plan.sfx_events ?? null}
          sfxLeadMs={plan.sfx_lead_ms ?? 0}
          narrationVolume={plan.narration_volume ?? 1}
          onNarrationVolumeChange={(v) =>
            onPlanChange({ ...plan, narration_volume: v })
          }
        />
          </div>
        </div>
      </div>

      <EditContractPanel
        plan={plan}
        validation={contractValidation}
        selectedShotIdx={selectedShotIdx}
      />

      {/* Structure + patterns metadata — tucked into a collapsed
          disclosure below the detail box so it doesn't push the
          timeline down. */}
      {(plan.structure_sections.length > 0 ||
        plan.content_source_patterns.length > 0) && (
        <details className="plan-meta">
          <summary>
            <span className="label">Structure + patterns</span>
            <span className="text-muted">
              {plan.structure_sections.length} section
              {plan.structure_sections.length === 1 ? '' : 's'}
              {plan.content_source_patterns.length > 0 &&
                ` · ${plan.content_source_patterns.length} pattern${plan.content_source_patterns.length === 1 ? '' : 's'}`}
            </span>
          </summary>
          {plan.structure_sections.length > 0 && (
            <div className="plan-structure">
              {plan.structure_sections.map((s, i) => (
                <SectionRow key={i} section={s} />
              ))}
            </div>
          )}
          {plan.content_source_patterns.length > 0 && (
            <div className="plan-patterns">
              <label className="label">Content patterns</label>
              <ul>
                {plan.content_source_patterns.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}

      {pendingSelections > 0 && (
        <div className="confirm-bar">
          <button
            className="btn btn-wide btn-confirm-selections"
            onClick={confirmSelections}
          >
            Confirm {pendingSelections} change
            {pendingSelections === 1 ? '' : 's'} & preview storyboard
          </button>
          <span className="confirm-bar-hint">
            Pick the idea you like on each shot, then confirm to see the
            whole reel laid out frame by frame.
          </span>
        </div>
      )}

      {storyboardOpen && <Storyboard plan={plan} curation={curation} />}
    </div>
  );
}

// ============================================================
//  SubtitleSpecCard — the resolved subtitle style the edit will apply
// ============================================================

/** A neutral caption style used when a plan has no detected captions, so
 *  the user can still author one from scratch. Mirrors the fallbacks in
 *  the main process's deriveSubtitleSpec (subtitle-spec.ts). */
function defaultSubtitleSpec(): SubtitleSpec {
  return {
    enabled: true,
    preset_id: '',
    preset_label: '',
    font_family: '',
    font_family_name: '',
    font_size: 'large',
    position: 'bottom',
    chunking: 'phrase',
    words_per_chunk: 3,
    casing: 'uppercase',
    emphasis: 'none',
    animation: 'pop',
    text_treatment: 'bordered',
    text_color: 'white',
    treatment_color: 'black',
    highlight_color: null,
    has_emoji: false,
    low_confidence: false,
  };
}

function SubtitleSpecCard({
  spec,
  onChange,
}: {
  spec: SubtitleSpec;
  /** When provided, the style fields render as editable controls and each
   *  change patches the plan's subtitle_spec (persisted via onPlanChange).
   *  Omitted → read-only display. */
  onChange?: (patch: Partial<SubtitleSpec>) => void;
}): React.JSX.Element {
  // Render the preview in the actual matched font (same mechanism as the
  // analysis panel).
  const [fontFamily, setFontFamily] = useState<string | null>(null);
  useEffect(() => {
    setFontFamily(null);
    if (!spec.font_family) return;
    let cancelled = false;
    void window.api.getFontDataUrl(spec.font_family).then((dataUrl) => {
      if (cancelled || !dataUrl) return;
      const fam = `cap-${spec.font_family}`;
      injectFontFace(fam, dataUrl);
      setFontFamily(fam);
    });
    return () => {
      cancelled = true;
    };
  }, [spec.font_family]);

  const treatColor = namedColorToHex(spec.treatment_color) ?? '#000000';
  const rows: [string, string][] = [
    ['Preset', spec.preset_label || '(none)'],
    ['Font', spec.font_family_name || '(unmatched)'],
    ['Size', spec.font_size],
    ['Position', spec.position],
    ['Words/group', String(spec.words_per_chunk)],
    ['Chunking', spec.chunking],
    ['Casing', spec.casing],
    ['Animation', spec.animation],
    ['Emphasis', spec.emphasis],
    ['Treatment', spec.text_treatment],
    ['Text color', spec.text_color],
    ['Border/BG', spec.treatment_color ?? '-'],
  ];

  // Editable enum control (rendered when `onChange` is provided). Each
  // change patches the plan's subtitle_spec immediately.
  const enumSelect = (
    key: keyof SubtitleSpec,
    opts: readonly string[],
  ): React.JSX.Element => (
    <select
      className="select"
      value={String(spec[key])}
      onChange={(e) =>
        onChange?.({ [key]: e.target.value } as Partial<SubtitleSpec>)
      }
    >
      {opts.map((o) => (
        <option key={o} value={o}>
          {o.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  );
  // Genuinely-dynamic preview styling (depends on the spec's font + colors);
  // static layout lives in CSS (.subspec-preview-text + .treat-* modifiers).
  // Live "People" sample reflects both the size preset and the fine
  // multiplier (preview base is scaled up for legibility in the box).
  const previewBase =
    spec.font_size === 'small' ? 20 : spec.font_size === 'medium' ? 26 : 34;
  const previewTextStyle: React.CSSProperties = {
    fontFamily: fontFamily ?? undefined,
    fontSize: `${previewBase * subtitleFontScale(spec)}px`,
    textTransform: spec.casing === 'uppercase' ? 'uppercase' : 'none',
    color: namedColorToHex(spec.text_color) ?? '#ffffff',
    ...(spec.text_treatment === 'bordered'
      ? { WebkitTextStroke: `${subtitleBorderWidth(spec)}px ${treatColor}` }
      : spec.text_treatment === 'backgrounded'
        ? { background: treatColor }
        : { textShadow: '0 2px 6px rgba(0,0,0,0.6)' }),
  };

  // One labelled field cell, matching the app's .label + control rhythm.
  const field = (
    label: string,
    control: React.ReactNode,
  ): React.JSX.Element => (
    <div className="subspec-field">
      <span className="subspec-field-label">{label}</span>
      {control}
    </div>
  );

  return (
    <div className="subspec-card">
      <div className="subspec-head">
        <span className="label">Captions · subtitle style</span>
        <span className="subspec-status">
          {spec.enabled ? 'on' : 'off'}
          {spec.preset_label ? ` · ${spec.preset_label}` : ''}
          {spec.low_confidence ? ' · low confidence' : ''}
        </span>
      </div>
      <div className="subspec-body">
        {/* Live preview */}
        <div className="subspec-preview">
          <span
            className={`subspec-preview-text treat-${spec.text_treatment}`}
            style={previewTextStyle}
          >
            People
          </span>
        </div>

        {/* Fields */}
        {onChange ? (
          <div className="subspec-grid">
            <label className="subspec-toggle">
              <input
                type="checkbox"
                checked={spec.enabled}
                onChange={(e) => onChange({ enabled: e.target.checked })}
              />
              <span>Captions enabled</span>
            </label>

            {field(
              'Preset',
              <span className="subspec-static">
                {spec.preset_label || '(none)'}
              </span>,
            )}
            {field(
              'Font',
              <span className="subspec-static">
                {spec.font_family_name || '(unmatched)'}
              </span>,
            )}
            {field('Size', enumSelect('font_size', ['small', 'medium', 'large']))}
            {field(
              'Fine size',
              <div className="subspec-size-fine">
                <input
                  type="range"
                  className="scale-range"
                  min={0.5}
                  max={3}
                  step={0.05}
                  value={subtitleFontScale(spec)}
                  aria-label="Subtitle fine size"
                  onChange={(e) =>
                    onChange?.({ font_scale: Number(e.target.value) })
                  }
                />
                <span className="scale-row-num">
                  <input
                    type="number"
                    className="scale-num-input"
                    min={50}
                    max={300}
                    step={5}
                    value={Math.round(subtitleFontScale(spec) * 100)}
                    aria-label="Subtitle size percent"
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isNaN(v)) return;
                      onChange?.({
                        font_scale: Math.max(0.5, Math.min(3, v / 100)),
                      });
                    }}
                  />
                  <span className="scale-num-suffix">%</span>
                </span>
              </div>,
            )}
            {field(
              'Position',
              enumSelect('position', [
                'center',
                'lower_third',
                'bottom',
                'top',
                'varies',
              ]),
            )}
            {field(
              'Words/group',
              <input
                className="input subspec-num"
                type="number"
                min={1}
                value={spec.words_per_chunk}
                onChange={(e) =>
                  onChange({
                    words_per_chunk: Math.max(
                      1,
                      Math.round(Number(e.target.value) || 1),
                    ),
                  })
                }
              />,
            )}
            {field(
              'Chunking',
              enumSelect('chunking', [
                'word_by_word',
                'phrase',
                'sentence',
                'mixed',
              ]),
            )}
            {field(
              'Casing',
              enumSelect('casing', [
                'uppercase',
                'title_case',
                'sentence_case',
                'mixed',
              ]),
            )}
            {field(
              'Animation',
              enumSelect('animation', [
                'pop',
                'karaoke_fill',
                'fade',
                'typewriter',
                'static',
                'none',
              ]),
            )}
            {field(
              'Emphasis',
              enumSelect('emphasis', [
                'active_word_highlight',
                'keyword_highlight',
                'none',
              ]),
            )}
            {field(
              'Treatment',
              enumSelect('text_treatment', [
                'bordered',
                'backgrounded',
                'clear',
              ]),
            )}
            {field(
              'Text color',
              <input
                className="subspec-color"
                type="color"
                value={namedColorToHex(spec.text_color) ?? '#ffffff'}
                onChange={(e) => onChange({ text_color: e.target.value })}
              />,
            )}
            {field(
              'Border / BG',
              spec.text_treatment === 'clear' ? (
                <span className="subspec-static">— (none)</span>
              ) : (
                <input
                  className="subspec-color"
                  type="color"
                  value={namedColorToHex(spec.treatment_color) ?? '#000000'}
                  onChange={(e) => onChange({ treatment_color: e.target.value })}
                />
              ),
            )}
            {spec.text_treatment === 'bordered' &&
              field(
                'Border width',
                <div className="subspec-size-fine">
                  <input
                    type="range"
                    className="scale-range"
                    min={0}
                    max={8}
                    step={0.5}
                    value={spec.border_width ?? 2}
                    aria-label="Subtitle border width"
                    onChange={(e) =>
                      onChange?.({ border_width: Number(e.target.value) })
                    }
                  />
                  <span className="scale-row-num">
                    <input
                      type="number"
                      className="scale-num-input"
                      min={0}
                      max={8}
                      step={0.5}
                      value={spec.border_width ?? 2}
                      aria-label="Subtitle border width px"
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isNaN(v)) return;
                        onChange?.({
                          border_width: Math.max(0, Math.min(8, v)),
                        });
                      }}
                    />
                    <span className="scale-num-suffix">px</span>
                  </span>
                </div>,
              )}
          </div>
        ) : (
          <dl className="subspec-readonly">
            {rows
              .filter(([, v]) => v && v.length > 0)
              .map(([k, v]) => (
                <div className="subspec-readonly-row" key={k}>
                  <dt>{k}</dt>
                  <dd>{v.replace(/_/g, ' ')}</dd>
                </div>
              ))}
          </dl>
        )}
      </div>
    </div>
  );
}

// ============================================================
//  Storyboard — confirmed shots laid out as a 9:16 mockup strip
// ============================================================

function Storyboard({
  plan,
  curation,
}: {
  plan: SuggestedEdit;
  curation: CurationResult | null;
}): React.JSX.Element {
  return (
    <div className="storyboard">
      <div className="storyboard-head">
        <span className="storyboard-title">Storyboard</span>
        <span className="storyboard-sub">
          {plan.shots.length} shots ·{' '}
          {(plan.total_duration_ms / 1000).toFixed(1)}s · this is how each shot
          reads in sequence
        </span>
      </div>
      <div className="storyboard-strip">
        {plan.shots.map((s) => {
          const sc =
            curation?.shots.find(
              (c) => c != null && c.shot_idx === s.shot_idx,
            ) ?? null;
          const previewImageUrl = sc?.candidates?.[0]?.thumbnail_url ?? null;
          return (
            <div key={s.shot_idx} className="storyboard-frame">
              <div className="storyboard-frame-num">
                {String(s.shot_idx).padStart(2, '0')}
              </div>
              <ReelMockup
                shot={s}
                previewImageUrl={previewImageUrl}
                subtitleSpec={plan.subtitle_spec}
              />
              {s.spoken_during && (
                <div className="storyboard-frame-vo">"{s.spoken_during}"</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SectionRow({ section }: { section: StructureSection }): React.JSX.Element {
  const signature = section.visual_signature;
  const signatureRows: [string, string | undefined][] = [
    ['shots', signature.shot_type_pattern || signature.dominant_clip_type],
    ['layout', signature.placement_pattern],
    ['captions', signature.text_overlay_pattern],
    ['motion', signature.motion_pattern],
    ['sfx', signature.sfx_pattern],
    [
      'overlays',
      signature.scene_elements.length > 0
        ? signature.scene_elements.join(', ')
        : 'none',
    ],
  ];
  return (
    <div className="section-row">
      <div className="section-row-head">
        <span className="section-role">{section.role}</span>
        <span className="section-time">
          {(section.target_start_ms / 1000).toFixed(2)}s –{' '}
          {(section.target_end_ms / 1000).toFixed(2)}s · {section.shot_count}{' '}
          shot(s)
        </span>
      </div>
      {section.script_template && (
        <div className="section-template">tmpl: "{section.script_template}"</div>
      )}
      {section.target_fill && (
        <div className="section-fill">fill: "{section.target_fill}"</div>
      )}
      <div className="section-signature">
        {signatureRows
          .filter(([, value]) => value && value !== 'unspecified')
          .map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              {value}
            </div>
          ))}
      </div>
    </div>
  );
}

function EditContractPanel({
  plan,
  validation,
  selectedShotIdx,
}: {
  plan: SuggestedEdit;
  validation: EditContractValidation | null;
  selectedShotIdx: number | null;
}): React.JSX.Element | null {
  const contract = plan.edit_contract;
  if (!contract) return null;
  const selected =
    contract.shots.find((shot) => shot.shot_idx === selectedShotIdx) ??
    contract.shots[0] ??
    null;
  const issues = validation?.issues ?? [];
  const selectedIssues = selected
    ? issues.filter((issue) => issue.shot_idx === selected.shot_idx)
    : [];
  const globalIssues = issues.filter((issue) => issue.shot_idx == null);
  const score = validation?.score ?? plan.contract_validation?.score ?? 100;
  const ok = issues.length === 0;

  return (
    <details className="plan-meta plan-contract" open={!ok}>
      <summary>
        <span className="label">Edit contract</span>
        <span className="text-muted">
          {score}% match
          {issues.length > 0 &&
            ` · ${issues.length} issue${issues.length === 1 ? '' : 's'}`}
        </span>
      </summary>
      <div className="contract-body">
        <div className="contract-summary">
          <span className={`contract-badge ${ok ? 'ok' : 'warn'}`}>
            {ok ? 'Passing' : 'Needs review'}
          </span>
          <span>{contract.summary}</span>
        </div>
        <div className="contract-grid">
          <section className="contract-section">
            <h4>Global rules</h4>
            <ul>
              {contract.global_rules.slice(0, 6).map((rule) => (
                <li key={rule.id}>
                  <b>{rule.label}</b>
                  <span>{rule.requirement}</span>
                </li>
              ))}
            </ul>
          </section>
          {selected && (
            <section className="contract-section">
              <h4>Selected shot</h4>
              <dl>
                <div>
                  <dt>Trigger</dt>
                  <dd>{selected.script_trigger || '(silent beat)'}</dd>
                </div>
                <div>
                  <dt>L1 media</dt>
                  <dd>{selected.l1_media}</dd>
                </div>
                <div>
                  <dt>L2 visual</dt>
                  <dd>{selected.l2_visual_overlay}</dd>
                </div>
                <div>
                  <dt>L3 captions</dt>
                  <dd>{selected.l3_captions}</dd>
                </div>
                <div>
                  <dt>Layout</dt>
                  <dd>
                    {selected.layout.fit} · {selected.layout.position}
                  </dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    {selected.source_category} via {selected.source_method}
                  </dd>
                </div>
              </dl>
            </section>
          )}
          <section className="contract-section">
            <h4>Validation</h4>
            {issues.length === 0 ? (
              <p className="contract-empty">Current plan matches the contract.</p>
            ) : (
              <ul>
                {[...globalIssues, ...selectedIssues, ...issues.filter((issue) => issue.shot_idx !== selected?.shot_idx && issue.shot_idx != null)]
                  .slice(0, 8)
                  .map((issue, i) => (
                    <li key={`${issue.rule_id}-${issue.shot_idx ?? 'global'}-${i}`}>
                      <b>
                        {issue.shot_idx != null
                          ? `Shot ${issue.shot_idx + 1}`
                          : issue.rule_id}
                      </b>
                      <span>{issue.message}</span>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </details>
  );
}

function VideoClipTrimEditor({
  media,
  onChange,
}: {
  media: SelectedMedia;
  onChange: (patch: Partial<SelectedMedia>) => void;
}): React.JSX.Element {
  const [durationMs, setDurationMs] = useState<number | null>(null);
  useEffect(() => setDurationMs(null), [media.url]);
  const duration = durationMs ?? Math.max(media.playback_end_ms ?? 0, 1000);
  const startMs = Math.max(0, Math.min(duration, media.playback_start_ms ?? 0));
  const endMs = Math.max(
    startMs + 100,
    Math.min(duration, media.playback_end_ms ?? duration),
  );
  const durationSec = Math.max(0.1, duration / 1000);
  const patchRange = (nextStartMs: number, nextEndMs: number): void => {
    const clampedStart = Math.max(0, Math.min(duration, Math.round(nextStartMs)));
    const clampedEnd = Math.max(
      clampedStart + 100,
      Math.min(duration, Math.round(nextEndMs)),
    );
    onChange({
      playback_start_ms: clampedStart > 0 ? clampedStart : null,
      playback_end_ms:
        durationMs !== null && clampedEnd >= durationMs - 50
          ? null
          : clampedEnd,
    });
  };
  return (
    <div className="clip-trim-editor">
      <video
        src={media.url}
        preload="metadata"
        muted
        playsInline
        style={{ display: 'none' }}
        onLoadedMetadata={(e) => {
          const sec = e.currentTarget.duration;
          if (Number.isFinite(sec) && sec > 0) {
            setDurationMs(Math.round(sec * 1000));
          }
        }}
      />
      <div className="clip-trim-head">
        <span>Clip range</span>
        <button
          type="button"
          className="btn btn-mini btn-ghost"
          onClick={() =>
            onChange({ playback_start_ms: null, playback_end_ms: null })
          }
        >
          reset
        </button>
      </div>
      <div className="scale-row">
        <span className="scale-row-label">Start</span>
        <input
          type="range"
          className="scale-range"
          min={0}
          max={durationSec}
          step={0.05}
          value={Math.min(startMs / 1000, durationSec)}
          onChange={(e) =>
            patchRange(Number(e.currentTarget.value) * 1000, endMs)
          }
        />
        <span className="scale-row-val">{(startMs / 1000).toFixed(2)}s</span>
      </div>
      <div className="scale-row">
        <span className="scale-row-label">End</span>
        <input
          type="range"
          className="scale-range"
          min={0}
          max={durationSec}
          step={0.05}
          value={Math.min(endMs / 1000, durationSec)}
          onChange={(e) =>
            patchRange(startMs, Number(e.currentTarget.value) * 1000)
          }
        />
        <span className="scale-row-val">{(endMs / 1000).toFixed(2)}s</span>
      </div>
    </div>
  );
}

const FRAME_REGIONS: FrameRegion[] = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'middle_center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
];

const CLIP_TYPES: ClipType[] = [
  'talking_head',
  'broll_talking_head',
  'talking_head_unknown',
  'broll_visual',
];

function ShotRow({
  shot,
  onChange,
  onDelete,
  curation,
  mediaLibrary,
  trace,
  onCurateShot,
  onRegenerate,
  onContinue,
  onAddClip,
  selectedOptionIdx,
  onSelectOption,
  onSetLayout,
  onSetAnimation,
  subtitleSpec,
  onSubtitleChange,
  stageNav,
  agentActivity,
  onPickDragStart,
  onPickDragEnd,
  onPickDrop,
  copiedPickCount,
  onCopyPick,
  onCopyAllPicks,
  onPastePicks,
}: {
  shot: ShotPlan;
  onChange: (patch: Partial<ShotPlan>) => void;
  onDelete: () => void;
  curation: ShotCuration | null;
  mediaLibrary: LibraryCandidate[];
  trace?: AgentTrace;
  onCurateShot: (shotIdx: number, userPrompt?: string) => Promise<void>;
  onRegenerate: (shotIdx: number, userPrompt: string) => Promise<void>;
  onContinue: (shotIdx: number, userPrompt: string) => Promise<void>;
  onAddClip: (shotIdx: number, description: string) => Promise<AddClipResult>;
  /** Index into shot.options of the concept the user has picked. */
  selectedOptionIdx: number;
  onSelectOption: (shotIdx: number, optionIdx: number) => void;
  /** Override the placement (layout) of the currently selected option. */
  onSetLayout: (
    shotIdx: number,
    optionIdx: number,
    placement: BrollPlacement,
  ) => void;
  /** Set the shot's structured motion preset (zoom/pan/Ken Burns). */
  onSetAnimation: (shotIdx: number, anim: SceneAnimation) => void;
  /** Reel-global caption style (null when none was detected) + its setter,
   *  so the caption editor can sit under the layout picker in this shot's
   *  left column. */
  subtitleSpec: SubtitleSpec | null;
  onSubtitleChange: (patch: Partial<SubtitleSpec>) => void;
  /** Stage back/next surfaced inside the media header. */
  stageNav?: StageNav;
  /** Live curator agent activity scoped to this shot. */
  agentActivity?: AgentActivity;
  onPickDragStart: (sourcePickIdx: number) => void;
  onPickDragEnd: () => void;
  onPickDrop: (destPickIdx?: number) => void;
  copiedPickCount: number;
  onCopyPick: (sourcePickIdx: number) => void;
  onCopyAllPicks: () => void;
  onPastePicks: (destPickIdx?: number) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchPrompt, setSearchPrompt] = useState('');
  const [curateBusy, setCurateBusy] = useState(false);
  const [selectedPickIdx, setSelectedPickIdx] = useState<number | null>(null);
  const [pickMenu, setPickMenu] = useState<{
    x: number;
    y: number;
    pickIdx: number | null;
  } | null>(null);
  useEffect(() => {
    if (!pickMenu) return;
    const close = (): void => setPickMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [pickMenu]);

  // (The phone mockup used to live here as well; it now renders in the
  // persistent `.phone-sidebar` on the right side of the plan-review,
  // sourced from PlanReview's selectedShot + selections.)

  const picks = getSelections(shot);
  const selectedPick =
    selectedPickIdx !== null ? (picks[selectedPickIdx] ?? null) : null;
  const patchPick = (index: number, patch: Partial<SelectedMedia>): void => {
    const next = picks.map((p, i) => (i === index ? { ...p, ...patch } : p));
    onChange({ selected_media: next });
  };
  const candidateCount = curation?.candidates?.length ?? 0;
  const libraryCount = mediaLibrary.length;
  const status = curationStatus(curation);

  // Search again opens a prompt panel so the user can optionally steer the
  // re-search with guidance; an empty prompt just re-researches as before.
  const runSearch = async (): Promise<void> => {
    const text = searchPrompt.trim();
    setCurateBusy(true);
    try {
      await onCurateShot(shot.shot_idx, text || undefined);
      setSearchOpen(false);
      setSearchPrompt('');
    } finally {
      setCurateBusy(false);
    }
  };

  return (
    <div className="mp-split">
      {/* LEFT — script chips, italic quote, phone, action buttons,
          visual idea, and shot edit/delete. */}
      <div className="mp-left">
        <div className="shot-card-meta">
          <span className="shot-pill shot-pill-time">
            <ClockGlyph />
            {(shot.start_ms / 1000).toFixed(1)}s – {(shot.end_ms / 1000).toFixed(1)}s
          </span>
          <span className="shot-pill shot-pill-role">{shot.structure_role}</span>
          <span className={`shot-pill shot-pill-status status-${status}`}>
            {status}
          </span>
        </div>
        {/* Editing controls — layout, then the reel-global caption style,
            then the text overlay. The shot's visual idea + scores moved up
            under the timeline (ShotIdeas). */}
        <LayoutPicker
          placement={
            (shot.options[selectedOptionIdx] ?? shot.options[0])?.placement ??
            shot.placement
          }
          clipType={shot.clip_type}
          containBackgroundMode={shot.contain_background_mode ?? 'autofill'}
          originalVideoPosition={shot.original_video_position ?? 'middle_center'}
          splitMediaFit={shot.split_media_fit ?? 'fill'}
          overlayStackMode={shot.overlay_stack_mode ?? 'accumulate'}
          onPick={(p) => onSetLayout(shot.shot_idx, selectedOptionIdx, p)}
          onContainBackgroundMode={(mode) =>
            onChange({ contain_background_mode: mode })
          }
          onBrollPosition={(position) => {
            const current =
              (shot.options[selectedOptionIdx] ?? shot.options[0])?.placement ??
              shot.placement;
            onSetLayout(shot.shot_idx, selectedOptionIdx, {
              ...current,
              position,
            });
          }}
          onOriginalVideoPosition={(position) =>
            onChange({ original_video_position: position })
          }
          onSplitMediaFit={(mode) => onChange({ split_media_fit: mode })}
          onOverlayStackMode={(mode) => onChange({ overlay_stack_mode: mode })}
        />

        <AnimationPicker
          animation={shot.scene_animation ?? 'none'}
          onPick={(a) => onSetAnimation(shot.shot_idx, a)}
          intensity={shot.animation_scale ?? 1}
          onIntensity={(n) => onChange({ animation_scale: n })}
          startZoom={shot.media_start_zoom ?? 1}
          onStartZoom={(n) => onChange({ media_start_zoom: n })}
          durationMs={shot.animation_duration_ms ?? shot.duration_ms}
          onDurationMs={(n) => onChange({ animation_duration_ms: n })}
          shotDurationMs={shot.duration_ms}
          easing={shot.animation_easing ?? 'ease-in-out'}
          onEasing={(e) => onChange({ animation_easing: e })}
          origin={shot.animation_origin ?? 'middle_center'}
          onOrigin={(r) => onChange({ animation_origin: r })}
          x={shot.animation_x}
          y={shot.animation_y}
          onPoint={({ x, y }) =>
            onChange({
              animation_x: Math.max(0, Math.min(1, x)),
              animation_y: Math.max(0, Math.min(1, y)),
            })
          }
        />

        {/* In a split layout the original/creator video gets its own
            half — let the user animate it independently of the b-roll. */}
        {(
          (shot.options[selectedOptionIdx] ?? shot.options[0])?.placement ??
          shot.placement
        ).fit.startsWith('split') && (
          <AnimationPicker
            title="Original video · how it moves"
            animation={shot.original_scene_animation ?? 'none'}
            onPick={(a) => onChange({ original_scene_animation: a })}
            intensity={shot.original_animation_scale ?? 1}
            onIntensity={(n) => onChange({ original_animation_scale: n })}
            startZoom={shot.original_media_start_zoom ?? 1}
            onStartZoom={(n) => onChange({ original_media_start_zoom: n })}
            durationMs={
              shot.original_animation_duration_ms ?? shot.duration_ms
            }
            onDurationMs={(n) =>
              onChange({ original_animation_duration_ms: n })
            }
            shotDurationMs={shot.duration_ms}
            easing={shot.original_animation_easing ?? 'ease-in-out'}
            onEasing={(e) => onChange({ original_animation_easing: e })}
            origin={shot.original_animation_origin ?? 'middle_center'}
            onOrigin={(r) => onChange({ original_animation_origin: r })}
            x={shot.original_animation_x}
            y={shot.original_animation_y}
            onPoint={({ x, y }) =>
              onChange({
                original_animation_x: Math.max(0, Math.min(1, x)),
                original_animation_y: Math.max(0, Math.min(1, y)),
              })
            }
          />
        )}

        <ZoomPointPicker
          region={shot.zoom_region ?? shot.animation_origin ?? 'middle_center'}
          onRegion={(r) => onChange({ zoom_region: r })}
          x={shot.zoom_x}
          y={shot.zoom_y}
          onPoint={({ x, y }) =>
            onChange({
              zoom_x: Math.max(0, Math.min(1, x)),
              zoom_y: Math.max(0, Math.min(1, y)),
            })
          }
          scale={shot.zoom_scale ?? 1}
          onScale={(n) => onChange({ zoom_scale: n })}
        />

        <SubtitleSpecCard
          spec={subtitleSpec ?? defaultSubtitleSpec()}
          onChange={onSubtitleChange}
        />

        {/* Per-shot caption position override — captions can sit in a
            different spot on this shot than the reel-wide default. */}
        {(subtitleSpec ?? defaultSubtitleSpec()).enabled && (
          <div className="shot-subpos">
            <span className="shot-subpos-label">Caption position · this shot</span>
            <select
              className="input shot-subpos-select"
              value={shot.subtitle_position ?? ''}
              onChange={(e) =>
                onChange({
                  subtitle_position: e.target.value
                    ? (e.target.value as SubtitleSpec['position'])
                    : undefined,
                })
              }
            >
              <option value="">
                Default ({(subtitleSpec ?? defaultSubtitleSpec()).position})
              </option>
              <option value="top">Top</option>
              <option value="center">Center</option>
              <option value="lower_third">Lower third</option>
              <option value="bottom">Bottom</option>
            </select>
          </div>
        )}

        {shot.text_overlay && (
          <div className="shot-text-overlay">
            <span className="shot-text-overlay-label">text overlay</span>
            "{shot.text_overlay}"
            <span className="shot-text-overlay-pos"> @ {shot.text_position}</span>
          </div>
        )}

      </div>

      {/* RIGHT — media: header (with stage back/next) + curation + candidates */}
      <div className="mp-right">
        <div className="mp-media-head">
          <div className="mp-media-head-title">
            <span className="mp-media-title">Media</span>
            <span className="mp-media-sub">
              {libraryCount > 0
                ? `${libraryCount} library item${libraryCount === 1 ? '' : 's'} · assign anything to this shot`
                : 'library empty · run agent below'}
            </span>
          </div>
          <div className="mp-media-head-right">
            <div className="mp-actions">
              <button
                type="button"
                className={`mp-action${searchOpen ? ' mp-action-on' : ''}`}
                onClick={() => setSearchOpen((v) => !v)}
                disabled={curateBusy}
                title="Search again with optional guidance"
                aria-label="Search again"
              >
                <RefreshGlyph />
              </button>
              <button
                type="button"
                className={`mp-action${editing ? ' mp-action-on' : ''}`}
                onClick={() => setEditing((v) => !v)}
                title="Edit this shot's idea, asset URL, text overlay, etc."
                aria-label={editing ? 'Done editing' : 'Edit shot'}
              >
                <PencilGlyph />
              </button>
              <button
                type="button"
                className="mp-trash"
                onClick={() => {
                  if (confirm(`Delete shot ${shot.shot_idx}?`)) onDelete();
                }}
                title="Delete shot"
                aria-label="Delete shot"
              >
                <TrashGlyph />
              </button>
            </div>
            {stageNav && (
              <div className="mp-media-nav">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={stageNav.onBack}
                >
                  {stageNav.backLabel}
                </button>
                {stageNav.onNext && stageNav.nextLabel && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={stageNav.onNext}
                  >
                    {stageNav.nextLabel}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {searchOpen && (
          <div className="regen-panel">
            <label className="regen-label" htmlFor={`search-${shot.shot_idx}`}>
              Any guidance for the new search? (optional)
            </label>
            <textarea
              id={`search-${shot.shot_idx}`}
              className="regen-textarea"
              rows={2}
              placeholder='e.g. "use a Wikipedia photo of the founder, not the company homepage"'
              value={searchPrompt}
              onChange={(e) => setSearchPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  runSearch();
                }
              }}
              disabled={curateBusy}
              autoFocus
            />
            <div className="regen-actions">
              <button
                className="btn btn-mini"
                onClick={runSearch}
                disabled={curateBusy}
              >
                {curateBusy ? 'Searching…' : 'Search'}
              </button>
              <button
                className="btn btn-mini btn-ghost"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchPrompt('');
                }}
                disabled={curateBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {editing && <ShotEditor shot={shot} onChange={onChange} />}

        {candidateCount > 0 && (
          <div className="mp-media-bar">
            <i style={{ width: `${Math.min(100, candidateCount * 20)}%` }} />
          </div>
        )}

        {picks.length > 0 && (
          <div className="shot-selected-media">
            <span className="shot-selected-media-label">
              {picks.length} pick{picks.length === 1 ? '' : 's'} ·{' '}
              {(((shot.end_ms - shot.start_ms) / picks.length) / 1000).toFixed(1)}s each
            </span>
            <div
              className="shot-selected-media-list"
              onContextMenu={(e) => {
                e.preventDefault();
                setPickMenu({ x: e.clientX, y: e.clientY, pickIdx: null });
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                onPickDrop();
                setSelectedPickIdx(null);
              }}
            >
              {picks.map((p, i) => (
                <span
                  key={i}
                  role="button"
                  tabIndex={0}
                  draggable
                  className={`shot-selected-media-chip${selectedPickIdx === i ? ' shot-selected-media-chip-on' : ''}`}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData(
                      'application/x-onetake-pick',
                      JSON.stringify({ shot_idx: shot.shot_idx, pick_idx: i }),
                    );
                    onPickDragStart(i);
                    setSelectedPickIdx(i);
                  }}
                  onDragEnd={onPickDragEnd}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onPickDrop(i);
                    setSelectedPickIdx(i);
                  }}
                  onClick={() =>
                    setSelectedPickIdx((current) => (current === i ? null : i))
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedPickIdx(i);
                    setPickMenu({ x: e.clientX, y: e.clientY, pickIdx: i });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedPickIdx((current) => (current === i ? null : i));
                    }
                  }}
                  aria-pressed={selectedPickIdx === i}
                >
                  <SelectedMediaPreview media={p} />
                  <span className="shot-selected-media-chip-idx">#{i + 1}</span>
                  <span className="shot-selected-media-chip-kind">
                    {p.kind} · {p.origin.replace(/_/g, ' ')}
                  </span>
                  <button
                    type="button"
                    className="shot-selected-media-chip-remove"
                    title="Remove this pick"
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = picks.slice();
                      next.splice(i, 1);
                      onChange({ selected_media: next });
                      setSelectedPickIdx((current) => {
                        if (current === null) return null;
                        if (current === i) return null;
                        return current > i ? current - 1 : current;
                      });
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            {pickMenu && (
              <div
                className="pick-context-menu"
                style={{ left: pickMenu.x, top: pickMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                {pickMenu.pickIdx !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      onCopyPick(pickMenu.pickIdx!);
                      setPickMenu(null);
                    }}
                  >
                    Copy this pick
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    onCopyAllPicks();
                    setPickMenu(null);
                  }}
                  disabled={picks.length === 0}
                >
                  Copy all picks
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onPastePicks(
                      pickMenu.pickIdx === null
                        ? undefined
                        : pickMenu.pickIdx + 1,
                    );
                    setPickMenu(null);
                  }}
                  disabled={copiedPickCount === 0}
                >
                  Paste {copiedPickCount > 1 ? `${copiedPickCount} picks` : 'pick'}
                  {pickMenu.pickIdx === null ? '' : ' after this'}
                </button>
              </div>
            )}
            {selectedPickIdx !== null && selectedPick && (
              <div className="shot-selected-media-editor">
                <div className="shot-selected-media-editor-head">
                  Pick #{selectedPickIdx + 1}
                </div>
                {selectedPick.kind === 'video' && (
                  <VideoClipTrimEditor
                    media={selectedPick}
                    onChange={(patch) => patchPick(selectedPickIdx, patch)}
                  />
                )}
                <AnimationPicker
                  animation={
                    selectedPick.scene_animation ?? shot.scene_animation ?? 'none'
                  }
                  onPick={(a) =>
                    patchPick(selectedPickIdx, { scene_animation: a })
                  }
                  intensity={selectedPick.animation_scale ?? shot.animation_scale ?? 1}
                  onIntensity={(n) =>
                    patchPick(selectedPickIdx, { animation_scale: n })
                  }
                  startZoom={
                    selectedPick.media_start_zoom ?? shot.media_start_zoom ?? 1
                  }
                  onStartZoom={(n) =>
                    patchPick(selectedPickIdx, { media_start_zoom: n })
                  }
                  durationMs={
                    selectedPick.animation_duration_ms ?? shot.animation_duration_ms ?? shot.duration_ms
                  }
                  onDurationMs={(n) =>
                    patchPick(selectedPickIdx, { animation_duration_ms: n })
                  }
                  shotDurationMs={shot.duration_ms}
                  easing={
                    selectedPick.animation_easing ??
                    shot.animation_easing ??
                    'ease-in-out'
                  }
                  onEasing={(e) =>
                    patchPick(selectedPickIdx, { animation_easing: e })
                  }
                  origin={
                    selectedPick.animation_origin ??
                    shot.animation_origin ??
                    'middle_center'
                  }
                  onOrigin={(r) =>
                    patchPick(selectedPickIdx, { animation_origin: r })
                  }
                  x={selectedPick.animation_x ?? shot.animation_x}
                  y={selectedPick.animation_y ?? shot.animation_y}
                  onPoint={({ x, y }) =>
                    patchPick(selectedPickIdx, {
                      animation_x: Math.max(0, Math.min(1, x)),
                      animation_y: Math.max(0, Math.min(1, y)),
                    })
                  }
                />
                <ZoomPointPicker
                  region={
                    selectedPick.zoom_region ??
                    shot.zoom_region ??
                    shot.animation_origin ??
                    'middle_center'
                  }
                  onRegion={(r) => patchPick(selectedPickIdx, { zoom_region: r })}
                  x={selectedPick.zoom_x ?? shot.zoom_x}
                  y={selectedPick.zoom_y ?? shot.zoom_y}
                  onPoint={({ x, y }) =>
                    patchPick(selectedPickIdx, {
                      zoom_x: Math.max(0, Math.min(1, x)),
                      zoom_y: Math.max(0, Math.min(1, y)),
                    })
                  }
                  scale={selectedPick.zoom_scale ?? shot.zoom_scale ?? 1}
                  onScale={(n) => patchPick(selectedPickIdx, { zoom_scale: n })}
                />
              </div>
            )}
            <button
              type="button"
              className="btn btn-mini btn-ghost"
              onClick={() => {
                onChange({ selected_media: [] });
                setSelectedPickIdx(null);
              }}
              title="Clear all picks"
            >
              clear all
            </button>
          </div>
        )}

        {libraryCount > 0 && (
          <SharedMediaLibrary
            items={mediaLibrary}
            shot={shot}
            onRegenerateMedia={onCurateShot}
            onToggleMedia={(media) => {
              const next = media
                ? toggleSelection(getSelections(shot), media)
                : [];
              onChange({ selected_media: next });
            }}
          />
        )}

        <ShotCurationRow
          nested
          shotIdx={shot.shot_idx}
          curation={curation}
          shot={shot}
          trace={trace}
          onCurateShot={onCurateShot}
          onRegenerate={onRegenerate}
          onContinue={onContinue}
          onAddClip={onAddClip}
          hideCandidates={libraryCount > 0}
          onToggleMedia={(media) => {
            const next = media
              ? toggleSelection(getSelections(shot), media)
              : [];
            onChange({ selected_media: next });
          }}
        />

        {agentActivity && (
          <ShotAgentActivity
            shotIdx={shot.shot_idx}
            activity={agentActivity}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================
//  Per-shot inline editor
// ============================================================

function ShotEditor({
  shot,
  onChange,
}: {
  shot: ShotPlan;
  onChange: (patch: Partial<ShotPlan>) => void;
}): React.JSX.Element {
  // Snapshot the shot fields into local state so the user can edit
  // freely without firing a save on every keystroke. We commit via the
  // Save button, which calls onChange with the diff.
  const [broll, setBroll] = useState(shot.broll_description);
  const [role, setRole] = useState(shot.structure_role);
  const [clipType, setClipType] = useState<ClipType>(shot.clip_type);
  const [textOverlay, setTextOverlay] = useState(shot.text_overlay ?? '');
  const [textPos, setTextPos] = useState<FrameRegion>(shot.text_position);
  const isWebCapture = shot.asset.method === 'web_capture';
  const [assetUrl, setAssetUrl] = useState(
    shot.asset.web_capture?.url ?? '',
  );
  const [assetFocus, setAssetFocus] = useState(
    shot.asset.web_capture?.focus ?? '',
  );

  const save = (): void => {
    const patch: Partial<ShotPlan> = {
      broll_description: broll.trim() || shot.broll_description,
      structure_role: role.trim() || shot.structure_role,
      clip_type: clipType,
      text_overlay: textOverlay,
      text_position: textPos,
    };
    if (isWebCapture) {
      patch.asset = {
        ...shot.asset,
        web_capture: {
          url: assetUrl.trim(),
          focus: assetFocus.trim(),
        },
      };
    }
    onChange(patch);
  };

  return (
    <div className="shot-editor">
      <div className="shot-editor-field">
        <label>broll description</label>
        <textarea
          rows={2}
          value={broll}
          onChange={(e) => setBroll(e.target.value)}
        />
      </div>
      <div className="shot-editor-row">
        <div className="shot-editor-field">
          <label>structure role</label>
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </div>
        <div className="shot-editor-field">
          <label>clip type</label>
          <select
            value={clipType}
            onChange={(e) => setClipType(e.target.value as ClipType)}
          >
            {CLIP_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>
      {isWebCapture && (
        <>
          <div className="shot-editor-field">
            <label>web_capture URL</label>
            <input
              type="text"
              value={assetUrl}
              onChange={(e) => setAssetUrl(e.target.value)}
              placeholder="https://example.com/page"
            />
          </div>
          <div className="shot-editor-field">
            <label>focus (what to capture on that page)</label>
            <input
              type="text"
              value={assetFocus}
              onChange={(e) => setAssetFocus(e.target.value)}
              placeholder="e.g. hero section + logo lockup"
            />
          </div>
        </>
      )}
      {!isWebCapture && (
        <div className="shot-editor-readonly">
          asset.method = <code>{shot.asset.method}</code> (edit not supported
          here — use the regenerate flow to switch acquisition method)
        </div>
      )}
      <div className="shot-editor-row">
        <div className="shot-editor-field">
          <label>text overlay</label>
          <input
            type="text"
            value={textOverlay}
            onChange={(e) => setTextOverlay(e.target.value)}
            placeholder="(no overlay)"
          />
        </div>
        <div className="shot-editor-field">
          <label>text position</label>
          <select
            value={textPos}
            onChange={(e) => setTextPos(e.target.value as FrameRegion)}
          >
            {FRAME_REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="shot-editor-actions">
        <button className="btn btn-mini" onClick={save}>
          Save changes
        </button>
      </div>
    </div>
  );
}

// ============================================================
//  Reel mockup — phone-shaped 9:16 placeholder per shot
// ============================================================

/** What the "other half" / background of the canvas should be labelled
 *  given the shot's clip_type. Splits + PiP need this so the non-broll
 *  portion isn't blank. */
function complementaryLabel(clipType: string): string {
  if (clipType === 'talking_head' || clipType === 'broll_talking_head') {
    return '';
  }
  return '';
}

function isCreatorSpeakingClip(clipType: string): boolean {
  return (
    clipType === 'talking_head' ||
    clipType === 'broll_talking_head' ||
    clipType === 'talking_head_unknown'
  );
}

type MockupRect = { top: string; left: string; width: string; height: string };

/** Given a placement (fit / position / scale) compute the CSS rects for
 *  the b-roll block and the background block inside the 9:16 canvas.
 *  Shared by ReelMockup (the live preview) and LayoutTile (the picker
 *  thumbnails) so both render identical schematics. */
function computePlacementRects(
  placement: BrollPlacement,
  clipType: string,
): {
  brollRect: MockupRect | null;
  backgroundRect: MockupRect | null;
  backgroundLabel: string | null;
} {
  let brollRect: MockupRect | null = null;
  let backgroundLabel: string | null = null;
  let backgroundRect: MockupRect | null = null;

  switch (placement.fit) {
    case 'fill':
      brollRect = { top: '0', left: '0', width: '100%', height: '100%' };
      break;
    case 'contain': {
      const pad = '8%';
      brollRect = { top: pad, left: '0', width: '100%', height: '84%' };
      break;
    }
    case 'split_top':
      brollRect = { top: '0', left: '0', width: '100%', height: '50%' };
      backgroundRect = { top: '50%', left: '0', width: '100%', height: '50%' };
      backgroundLabel = complementaryLabel(clipType);
      break;
    case 'split_bottom':
      brollRect = { top: '50%', left: '0', width: '100%', height: '50%' };
      backgroundRect = { top: '0', left: '0', width: '100%', height: '50%' };
      backgroundLabel = complementaryLabel(clipType);
      break;
    case 'split_left':
      brollRect = { top: '0', left: '0', width: '50%', height: '100%' };
      backgroundRect = { top: '0', left: '50%', width: '50%', height: '100%' };
      backgroundLabel = complementaryLabel(clipType);
      break;
    case 'split_right':
      brollRect = { top: '0', left: '50%', width: '50%', height: '100%' };
      backgroundRect = { top: '0', left: '0', width: '50%', height: '100%' };
      backgroundLabel = complementaryLabel(clipType);
      break;
    case 'pip': {
      // Full-bleed background, small inset on top. Inset position
      // derived from placement.position (3x3 grid).
      backgroundRect = { top: '0', left: '0', width: '100%', height: '100%' };
      backgroundLabel = complementaryLabel(clipType);
      const sizePct = Math.max(0.2, Math.min(0.45, placement.scale || 0.3));
      const w = `${(sizePct * 100).toFixed(0)}%`;
      const h = `${(sizePct * 100 * (16 / 9)).toFixed(0) /* keep visible */}%`;
      const padding = 6;
      const [vRegion, hRegion] = placement.position.split('_');
      const top =
        vRegion === 'top'
          ? `${padding}%`
          : vRegion === 'bottom'
            ? `calc(100% - ${h} - ${padding}%)`
            : `calc(50% - ${parseFloat(h) / 2}%)`;
      const left =
        hRegion === 'left'
          ? `${padding}%`
          : hRegion === 'right'
            ? `calc(100% - ${w} - ${padding}%)`
            : `calc(50% - ${parseFloat(w) / 2}%)`;
      brollRect = { top, left, width: w, height: h };
      break;
    }
  }

  return { brollRect, backgroundRect, backgroundLabel };
}

/** Canonical layout presets the user can pick between for any shot. A
 *  "layout" is just the fit / position / scale of the b-roll on the
 *  9:16 canvas — the asset's native `aspect` is preserved when a preset
 *  is applied (it's a property of the media, not the composition). */
const LAYOUT_PRESETS: { id: string; label: string; placement: BrollPlacement }[] =
  [
    {
      id: 'fill',
      label: 'Fit frame',
      placement: { aspect: 'original', fit: 'fill', position: 'middle_center', scale: 1 },
    },
    {
      id: 'contain',
      label: 'Actual size',
      placement: { aspect: 'original', fit: 'contain', position: 'middle_center', scale: 1 },
    },
    {
      id: 'split_top',
      label: 'Split up',
      placement: { aspect: 'original', fit: 'split_top', position: 'top_center', scale: 0.5 },
    },
    {
      id: 'split_bottom',
      label: 'Split down',
      placement: { aspect: 'original', fit: 'split_bottom', position: 'bottom_center', scale: 0.5 },
    },
    {
      id: 'overlay',
      label: 'Overlay',
      placement: { aspect: 'original', fit: 'pip', position: 'middle_center', scale: 0.42 },
    },
  ];

/** A preset is the active layout when the fit matches; for Overlay the
 *  inset position/scale must match too. Splits encode their side in the
 *  fit itself. */
function layoutPresetActive(
  current: BrollPlacement,
  preset: BrollPlacement,
): boolean {
  if (current.fit !== preset.fit) return false;
  if (preset.fit === 'pip') {
    return current.position === preset.position && current.scale === preset.scale;
  }
  return true;
}

/** A single layout thumbnail — a miniature 9:16 canvas rendering the
 *  same schematic ReelMockup uses, so the picker previews exactly how
 *  the shot will be composited. */
function LayoutTile({
  placement,
  clipType,
  label,
  selected,
  onPick,
}: {
  placement: BrollPlacement;
  clipType: string;
  label: string;
  selected: boolean;
  onPick: () => void;
}): React.JSX.Element {
  const { brollRect, backgroundRect } = computePlacementRects(placement, clipType);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      className={`layout-tile${selected ? ' layout-tile-on' : ''}`}
      onClick={onPick}
    >
      <span className="layout-tile-canvas">
        {backgroundRect && (
          <span className="layout-tile-bg" style={backgroundRect} />
        )}
        {brollRect && <span className="layout-tile-broll" style={brollRect} />}
      </span>
      <span className="layout-tile-label">{label}</span>
    </button>
  );
}

/** Row of layout presets for the currently selected shot option. Picking
 *  one overrides that option's placement (fit / position / scale) while
 *  keeping its native aspect. */
function LayoutPicker({
  placement,
  clipType,
  containBackgroundMode,
  originalVideoPosition,
  splitMediaFit,
  overlayStackMode,
  onPick,
  onContainBackgroundMode,
  onBrollPosition,
  onOriginalVideoPosition,
  onSplitMediaFit,
  onOverlayStackMode,
}: {
  placement: BrollPlacement;
  clipType: string;
  containBackgroundMode: 'autofill' | 'show_background';
  originalVideoPosition: FrameRegion;
  splitMediaFit: 'fill' | 'contain';
  overlayStackMode: 'accumulate' | 'replace';
  onPick: (next: BrollPlacement) => void;
  onContainBackgroundMode: (mode: 'autofill' | 'show_background') => void;
  onBrollPosition: (position: FrameRegion) => void;
  onOriginalVideoPosition: (position: FrameRegion) => void;
  onSplitMediaFit: (mode: 'fill' | 'contain') => void;
  onOverlayStackMode: (mode: 'accumulate' | 'replace') => void;
}): React.JSX.Element {
  const isSplit = placement.fit.startsWith('split');
  return (
    <div className="layout-picker">
      <div className="ideas-header">Layout · how the media sits on screen</div>
      <div className="layout-tile-row" role="radiogroup">
        {LAYOUT_PRESETS.map((preset) => {
          const next: BrollPlacement = {
            ...preset.placement,
            aspect: placement.aspect,
          };
          return (
            <LayoutTile
              key={preset.id}
              label={preset.label}
              clipType={clipType}
              placement={next}
              selected={layoutPresetActive(placement, preset.placement)}
              onPick={() => onPick(next)}
            />
          );
        })}
      </div>
      {placement.fit === 'contain' && (
        <div className="contain-bg-toggle" role="radiogroup" aria-label="Actual size background">
          <button
            type="button"
            role="radio"
            aria-checked={containBackgroundMode === 'autofill'}
            className={`contain-bg-btn${containBackgroundMode === 'autofill' ? ' on' : ''}`}
            onClick={() => onContainBackgroundMode('autofill')}
          >
            Autofill
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={containBackgroundMode === 'show_background'}
            className={`contain-bg-btn${containBackgroundMode === 'show_background' ? ' on' : ''}`}
            onClick={() => onContainBackgroundMode('show_background')}
          >
            Show background
          </button>
        </div>
      )}
      {placement.fit === 'pip' && (
        <div className="contain-bg-toggle" role="radiogroup" aria-label="Overlay stack mode">
          <button
            type="button"
            role="radio"
            aria-checked={overlayStackMode === 'accumulate'}
            className={`contain-bg-btn${overlayStackMode === 'accumulate' ? ' on' : ''}`}
            onClick={() => onOverlayStackMode('accumulate')}
          >
            Show previous
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={overlayStackMode === 'replace'}
            className={`contain-bg-btn${overlayStackMode === 'replace' ? ' on' : ''}`}
            onClick={() => onOverlayStackMode('replace')}
          >
            Hide previous
          </button>
        </div>
      )}
      {isSplit && (
        <div className="split-controls">
          <div className="contain-bg-toggle" role="radiogroup" aria-label="Split media fit">
            <button
              type="button"
              role="radio"
              aria-checked={splitMediaFit === 'fill'}
              className={`contain-bg-btn${splitMediaFit === 'fill' ? ' on' : ''}`}
              onClick={() => onSplitMediaFit('fill')}
            >
              Fill
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={splitMediaFit === 'contain'}
              className={`contain-bg-btn${splitMediaFit === 'contain' ? ' on' : ''}`}
              onClick={() => onSplitMediaFit('contain')}
            >
              Original size
            </button>
          </div>
          <div className="focus-row">
            <span className="scale-row-label">Clip position</span>
            <FocusGrid origin={placement.position} onPick={onBrollPosition} />
          </div>
          <div className="focus-row">
            <span className="scale-row-label">Original position</span>
            <FocusGrid origin={originalVideoPosition} onPick={onOriginalVideoPosition} />
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
//  Animation picker — per-shot motion preset (zoom / pan / etc.)
// ============================================================

/** Canonical motion presets the user can apply to a shot's base media.
 *  Mirrors the SceneAnimation enum the synthesizer emits from the
 *  inspiration's motion treatment, so the picker reflects what was
 *  detected and lets the user override it. */
const ANIMATION_PRESETS: { id: SceneAnimation; label: string }[] = [
  { id: 'none', label: 'Static' },
  { id: 'zoom_in', label: 'Zoom in' },
  { id: 'zoom_out', label: 'Zoom out' },
  { id: 'pan_left', label: 'Pan ◀' },
  { id: 'pan_right', label: 'Pan ▶' },
  { id: 'ken_burns', label: 'Ken Burns' },
  { id: 'punch_in', label: 'Punch in' },
];

/** CSS class that drives the matching keyframe animation. Shared by the
 *  picker tiles (live motion preview) and the phone mockup (applied to
 *  the actual shot media), so the preview is exactly what renders. */
function sceneAnimationClass(anim: SceneAnimation | null | undefined): string {
  return anim && anim !== 'none' ? `anim-${anim.replace(/_/g, '-')}` : '';
}

/** A single animation thumbnail — a mini 9:16 canvas whose inner block
 *  continuously runs the preset's motion so the user can see it. */
function AnimationTile({
  id,
  label,
  selected,
  onPick,
}: {
  id: SceneAnimation;
  label: string;
  selected: boolean;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      className={`layout-tile anim-tile${selected ? ' layout-tile-on' : ''}`}
      onClick={onPick}
    >
      <span className="layout-tile-canvas">
        <span className={`anim-tile-box ${sceneAnimationClass(id)}`} />
      </span>
      <span className="layout-tile-label">{label}</span>
    </button>
  );
}

const EASING_OPTIONS: { id: AnimationEasing; label: string }[] = [
  { id: 'ease-in-out', label: 'Smooth' },
  { id: 'linear', label: 'Linear' },
  { id: 'ease-out', label: 'Ease out' },
  { id: 'ease-in', label: 'Ease in' },
];

/** Compact 3x3 grid for picking a focal point (transform-origin) — the
 *  point the zoom/Ken Burns motion pivots toward, e.g. a subject's face. */
function FocusGrid({
  origin,
  onPick,
  disabled,
}: {
  origin: FrameRegion;
  onPick: (next: FrameRegion) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="focus-grid" role="radiogroup" aria-label="Focal point">
      {FRAME_REGIONS.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={origin === r}
          aria-label={r.replace(/_/g, ' ')}
          title={r.replace(/_/g, ' ')}
          disabled={disabled}
          className={`focus-cell${origin === r ? ' focus-cell-on' : ''}`}
          onClick={() => onPick(r)}
        />
      ))}
    </div>
  );
}

/** Row of motion presets for the selected shot plus the per-shot motion
 *  variables: intensity (magnitude), speed (duration), easing (curve),
 *  and focal point (transform-origin). Each maps to a CSS var / property
 *  the phone preview animates live and the compositor applies at render. */
function AnimationPicker({
  animation,
  onPick,
  intensity,
  onIntensity,
  startZoom,
  onStartZoom,
  durationMs,
  onDurationMs,
  shotDurationMs,
  easing,
  onEasing,
  origin,
  onOrigin,
  x,
  y,
  onPoint,
  title = 'Animation · how the shot moves',
}: {
  animation: SceneAnimation;
  onPick: (next: SceneAnimation) => void;
  /** Header label — lets a second instance (e.g. the original-video
   *  animation in split layouts) distinguish itself. */
  title?: string;
  /** Current intensity multiplier (1 = preset default). */
  intensity: number;
  onIntensity: (next: number) => void;
  startZoom: number;
  onStartZoom: (next: number) => void;
  /** How long the motion plays, in ms (runs once, then holds). */
  durationMs: number;
  onDurationMs: (next: number) => void;
  /** The shot's own length, in ms — the default + max for the duration. */
  shotDurationMs: number;
  easing: AnimationEasing;
  onEasing: (next: AnimationEasing) => void;
  origin: FrameRegion;
  onOrigin: (next: FrameRegion) => void;
  x?: number;
  y?: number;
  onPoint: (next: { x: number; y: number }) => void;
}): React.JSX.Element {
  const hasMotion = animation !== 'none';
  // Focal point only changes the look of scale-based moves.
  const originMatters =
    animation === 'zoom_in' ||
    animation === 'zoom_out' ||
    animation === 'ken_burns' ||
    animation === 'punch_in';
  // The focus picker drives the transform-origin of any scale toward a
  // point — that's an origin-based animation OR a static start zoom
  // (which scales the media even when animation = none). So focus is NOT
  // gated by the animation: it's active whenever something is zoomed.
  const focusActive = originMatters || startZoom > 1;
  const originPoint = frameRegionPoint(origin);
  const px = typeof x === 'number' ? Math.max(0, Math.min(1, x)) : originPoint.x;
  const py = typeof y === 'number' ? Math.max(0, Math.min(1, y)) : originPoint.y;
  const pickFromEvent = (target: HTMLDivElement, clientX: number, clientY: number): void => {
    const rect = target.getBoundingClientRect();
    onPoint({
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    });
  };
  const pickPreset = (next: FrameRegion): void => {
    onOrigin(next);
    onPoint(frameRegionPoint(next));
  };
  return (
    <div className="layout-picker">
      <div className="ideas-header">{title}</div>
      <div className="layout-tile-row" role="radiogroup">
        {ANIMATION_PRESETS.map((p) => (
          <AnimationTile
            key={p.id}
            id={p.id}
            label={p.label}
            selected={animation === p.id}
            onPick={() => onPick(p.id)}
          />
        ))}
      </div>
      <div className={`scale-row${hasMotion ? '' : ' scale-row-off'}`}>
        <span className="scale-row-label">Intensity</span>
        <input
          type="range"
          className="scale-range"
          min={0}
          max={2}
          step={0.05}
          value={Math.min(intensity, 2)}
          disabled={!hasMotion}
          aria-label="Animation intensity"
          onChange={(e) => onIntensity(Number(e.target.value))}
        />
        <span className="scale-row-num">
          <input
            type="number"
            className="scale-num-input"
            min={0}
            max={1000}
            step={5}
            value={Math.round(intensity * 100)}
            disabled={!hasMotion}
            aria-label="Animation intensity percent"
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isNaN(v)) return;
              // Allow typed values well beyond the slider's 200% range.
              onIntensity(Math.max(0, Math.min(10, v / 100)));
            }}
          />
          <span className="scale-num-suffix">%</span>
        </span>
      </div>
      {/* Start zoom is a STATIC base zoom on the shot's media — it is NOT
          gated by the animation (it applies even when animation = none),
          and when an animation does play it sets the motion's starting
          scale. Always editable. */}
      <div className="scale-row">
        <span className="scale-row-label">Start zoom</span>
        <input
          type="range"
          className="scale-range"
          min={1}
          max={1.6}
          step={0.01}
          value={Math.min(Math.max(startZoom, 1), 1.6)}
          aria-label="Starting zoom"
          onChange={(e) => onStartZoom(Number(e.target.value))}
        />
        <span className="scale-row-num">
          <input
            type="number"
            className="scale-num-input"
            min={1}
            max={5}
            step={0.05}
            value={Number(startZoom.toFixed(2))}
            aria-label="Starting zoom multiplier"
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isNaN(v)) return;
              // Allow typed values beyond the slider's 1.6x range.
              onStartZoom(Math.max(1, Math.min(5, v)));
            }}
          />
          <span className="scale-num-suffix">×</span>
        </span>
      </div>
      <div className={`scale-row${hasMotion ? '' : ' scale-row-off'}`}>
        <span className="scale-row-label">Duration</span>
        <input
          type="range"
          className="scale-range"
          min={0.2}
          max={Math.max(0.2, shotDurationMs / 1000)}
          step={0.1}
          value={Math.min(durationMs, shotDurationMs) / 1000}
          disabled={!hasMotion}
          aria-label="Animation duration"
          onChange={(e) => onDurationMs(Math.round(Number(e.target.value) * 1000))}
        />
        <span className="scale-row-val">{(durationMs / 1000).toFixed(1)}s</span>
      </div>
      <div className={`scale-row${hasMotion ? '' : ' scale-row-off'}`}>
        <span className="scale-row-label">Curve</span>
        <div className="ease-row" role="radiogroup" aria-label="Easing curve">
          {EASING_OPTIONS.map((e) => (
            <button
              key={e.id}
              type="button"
              role="radio"
              aria-checked={easing === e.id}
              disabled={!hasMotion}
              className={`ease-chip${easing === e.id ? ' ease-chip-on' : ''}`}
              onClick={() => onEasing(e.id)}
            >
              {e.label}
            </button>
          ))}
        </div>
      </div>
      <div
        className={`scale-row focus-row${focusActive ? '' : ' scale-row-off'}`}
      >
        <span className="scale-row-label">Focus</span>
        <div className="free-point-wrap">
          <div
            className="free-point-pad"
            role="slider"
            aria-label="Focal point"
            aria-valuetext={`${Math.round(px * 100)}% x, ${Math.round(py * 100)}% y`}
            tabIndex={focusActive ? 0 : -1}
            onPointerDown={(e) => {
              if (!focusActive) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              pickFromEvent(e.currentTarget, e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (!focusActive) return;
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              pickFromEvent(e.currentTarget, e.clientX, e.clientY);
            }}
            onKeyDown={(e) => {
              if (!focusActive) return;
              const step = e.shiftKey ? 0.1 : 0.025;
              if (e.key === 'ArrowLeft') onPoint({ x: px - step, y: py });
              else if (e.key === 'ArrowRight') onPoint({ x: px + step, y: py });
              else if (e.key === 'ArrowUp') onPoint({ x: px, y: py - step });
              else if (e.key === 'ArrowDown') onPoint({ x: px, y: py + step });
              else return;
              e.preventDefault();
            }}
          >
            <span
              className="free-point-dot"
              style={{ left: `${px * 100}%`, top: `${py * 100}%` }}
            />
          </div>
          <FocusGrid
            origin={origin}
            onPick={pickPreset}
            disabled={!focusActive}
          />
          <span className="scale-row-val free-point-val">
            {Math.round(px * 100)},{Math.round(py * 100)}
          </span>
        </div>
      </div>
    </div>
  );
}

function ZoomPointPicker({
  region,
  onRegion,
  x,
  y,
  onPoint,
  scale,
  onScale,
}: {
  region: FrameRegion;
  onRegion: (next: FrameRegion) => void;
  x?: number;
  y?: number;
  onPoint: (next: { x: number; y: number }) => void;
  scale: number;
  onScale: (next: number) => void;
}): React.JSX.Element {
  const clamped = Math.max(1, Math.min(3, scale || 1));
  const regionPoint = frameRegionPoint(region);
  const px = typeof x === 'number' ? Math.max(0, Math.min(1, x)) : regionPoint.x;
  const py = typeof y === 'number' ? Math.max(0, Math.min(1, y)) : regionPoint.y;
  const pickFromEvent = (target: HTMLDivElement, clientX: number, clientY: number): void => {
    const rect = target.getBoundingClientRect();
    const nextX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const nextY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    onPoint({ x: nextX, y: nextY });
  };
  const pickPreset = (next: FrameRegion): void => {
    const p = frameRegionPoint(next);
    onRegion(next);
    onPoint(p);
  };
  return (
    <div className="layout-picker">
      <div className="ideas-header">Zoom point · interesting area</div>
      <div className="scale-row focus-row">
        <span className="scale-row-label">Point</span>
        <div className="free-point-wrap">
          <div
            className="free-point-pad"
            role="slider"
            aria-label="Zoom focal point"
            aria-valuetext={`${Math.round(px * 100)}% x, ${Math.round(py * 100)}% y`}
            tabIndex={0}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              pickFromEvent(e.currentTarget, e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              pickFromEvent(e.currentTarget, e.clientX, e.clientY);
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.1 : 0.025;
              if (e.key === 'ArrowLeft') onPoint({ x: px - step, y: py });
              else if (e.key === 'ArrowRight') onPoint({ x: px + step, y: py });
              else if (e.key === 'ArrowUp') onPoint({ x: px, y: py - step });
              else if (e.key === 'ArrowDown') onPoint({ x: px, y: py + step });
              else return;
              e.preventDefault();
            }}
          >
            <span
              className="free-point-dot"
              style={{ left: `${px * 100}%`, top: `${py * 100}%` }}
            />
          </div>
          <FocusGrid origin={region} onPick={pickPreset} />
          <span className="scale-row-val free-point-val">
            {Math.round(px * 100)},{Math.round(py * 100)}
          </span>
        </div>
      </div>
      <div className="scale-row">
        <span className="scale-row-label">Zoom</span>
        <input
          type="range"
          className="scale-range"
          min={1}
          max={3}
          step={0.05}
          value={clamped}
          aria-label="Media zoom scale"
          onChange={(e) => onScale(Number(e.target.value))}
        />
        <span className="scale-row-num">
          <input
            type="number"
            className="scale-num-input"
            min={100}
            max={300}
            step={5}
            value={Math.round(clamped * 100)}
            aria-label="Media zoom percent"
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isNaN(v)) return;
              onScale(Math.max(1, Math.min(3, v / 100)));
            }}
          />
          <span className="scale-num-suffix">%</span>
        </span>
      </div>
    </div>
  );
}

/** Map a 3x3 FrameRegion to a CSS transform-origin string, so a zoom can
 *  pivot toward the chosen focal point (e.g. 'top_right' → 'right top'). */
function frameRegionOrigin(region: FrameRegion): string {
  const [v, h] = (region || 'middle_center').split('_');
  const x = h === 'left' ? 'left' : h === 'right' ? 'right' : 'center';
  const y = v === 'top' ? 'top' : v === 'bottom' ? 'bottom' : 'center';
  return `${x} ${y}`;
}

function frameRegionPoint(region: FrameRegion): { x: number; y: number } {
  const [v, h] = (region || 'middle_center').split('_');
  return {
    x: h === 'left' ? 0 : h === 'right' ? 1 : 0.5,
    y: v === 'top' ? 0 : v === 'bottom' ? 1 : 0.5,
  };
}

function pointOrigin(x: number | undefined, y: number | undefined, fallback: FrameRegion): string {
  if (typeof x !== 'number' || typeof y !== 'number') return frameRegionOrigin(fallback);
  const cx = Math.max(0, Math.min(1, x));
  const cy = Math.max(0, Math.min(1, y));
  return `${(cx * 100).toFixed(1)}% ${(cy * 100).toFixed(1)}%`;
}

/** Live curator agent activity scoped to a single shot. Renders the
 *  turn-by-turn tool call log streamed over window.api.onCuratorTurn,
 *  plus any pending ask_user_clarification request for this shot. */
function ShotAgentActivity({
  shotIdx,
  activity,
}: {
  shotIdx: number;
  activity: AgentActivity;
}): React.JSX.Element | null {
  const history = activity.turnsByShot.get(shotIdx) ?? [];
  // Clarification questions are surfaced globally via <ClarificationModal>
  // (so they're never missed during bulk curate-all), not inline here.
  if (history.length === 0) return null;

  const latest = history[history.length - 1];
  const isExpanded = activity.expandedShots.has(shotIdx);
  const visible = isExpanded ? history : latest ? [latest] : [];
  const running = !!latest && !latest.finished;

  return (
    <div
      className={`mp-agent-activity${running ? ' mp-agent-activity-running' : ' mp-agent-activity-done'}`}
    >
      <div className="mp-agent-activity-head">
        <span className="mp-agent-activity-title">agent activity</span>
        {running ? (
          <span className="agent-status agent-status-running">
            <span className="agent-status-spinner" aria-hidden="true" />
            agent running…
          </span>
        ) : (
          <span className="agent-status agent-status-done">
            <span className="agent-status-check" aria-hidden="true">
              ✓
            </span>
            agent done
          </span>
        )}
        {history.length > 1 && (
          <button
            type="button"
            className="agent-history-toggle"
            onClick={() => activity.toggleShotExpanded(shotIdx)}
          >
            {isExpanded
              ? '▾ hide history'
              : `▸ show all ${history.length} turn${history.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
      {visible.map((t) => (
        <div key={t.turn} className="agent-turn">
          <span className="agent-turn-n">turn {t.turn}</span>
          <span className="agent-tools">
            {t.tool_calls.length === 0 ? (
              t.finished ? '(final answer)' : '(thinking…)'
            ) : (
              t.tool_calls.map((c, i) => {
                const isFailure =
                  !!c.result_summary &&
                  /FAILED|BLOCKED|err=/.test(c.result_summary);
                return (
                  <React.Fragment key={i}>
                    {i > 0 && ' · '}
                    <span>
                      {c.name}
                      {c.summary ? `(${c.summary.slice(0, 60)})` : ''}
                    </span>
                    {c.result_summary && (
                      <span
                        className={
                          isFailure
                            ? 'agent-tool-result warn'
                            : 'agent-tool-result'
                        }
                      >
                        {' → '}
                        {c.result_summary}
                      </span>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function ShotClarification({
  req,
  typedText,
  setClarificationTyping,
  answerClarification,
}: {
  req: CuratorClarificationRequest;
  typedText: string | undefined;
  setClarificationTyping: React.Dispatch<
    React.SetStateAction<Map<string, string>>
  >;
  answerClarification: (
    req: CuratorClarificationRequest,
    answer: string,
  ) => Promise<void>;
}): React.JSX.Element {
  const isTyping = typedText !== undefined;
  return (
    <div className="agent-clarification">
      <div className="agent-clarification-head">
        <span className="agent-clarification-label">needs your input</span>
      </div>
      <div className="agent-clarification-question">{req.question}</div>
      {req.reason && (
        <div className="agent-clarification-reason">{req.reason}</div>
      )}
      {isTyping ? (
        <div className="agent-clarification-typing">
          <label
            className="regen-label"
            htmlFor={`clarify-${req.request_id}`}
          >
            What would you actually like?
          </label>
          <textarea
            id={`clarify-${req.request_id}`}
            className="regen-textarea"
            rows={2}
            autoFocus
            placeholder='e.g. "look on Crunchbase instead", "find the YC company page", "skip this shot"'
            value={typedText}
            onChange={(e) =>
              setClarificationTyping((prev) => {
                const next = new Map(prev);
                next.set(req.request_id, e.target.value);
                return next;
              })
            }
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                (e.metaKey || e.ctrlKey) &&
                typedText.trim().length > 0
              ) {
                answerClarification(req, typedText.trim());
              }
            }}
          />
          <div className="regen-actions">
            <button
              type="button"
              className="btn btn-mini btn-ghost"
              onClick={() =>
                setClarificationTyping((prev) => {
                  const next = new Map(prev);
                  next.delete(req.request_id);
                  return next;
                })
              }
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-mini"
              disabled={typedText.trim().length === 0}
              onClick={() => answerClarification(req, typedText.trim())}
            >
              Send answer
            </button>
          </div>
        </div>
      ) : (
        <div className="agent-clarification-options">
          {req.options.map((opt, i) => {
            const isNo = /^\s*no\b/i.test(opt);
            const url = extractClarifyUrl(opt);
            return (
              <span key={i} className="agent-clarification-option-row">
                <button
                  type="button"
                  className="agent-clarification-option"
                  onClick={() => {
                    if (isNo) {
                      setClarificationTyping((prev) => {
                        const next = new Map(prev);
                        next.set(req.request_id, '');
                        return next;
                      });
                    } else {
                      answerClarification(req, opt);
                    }
                  }}
                >
                  {opt}
                </button>
                {url && (
                  <button
                    type="button"
                    className="agent-clarification-visit"
                    title={`Open ${url} in your browser`}
                    onClick={() => {
                      void window.api.openExternal(url);
                    }}
                  >
                    ↗ visit
                  </button>
                )}
              </span>
            );
          })}
          {/* Always offer a free-text escape hatch — e.g. when the
              question lists several sources and the user wants a
              different one, or to give the agent custom instructions. */}
          <button
            type="button"
            className="agent-clarification-option agent-clarification-other"
            onClick={() =>
              setClarificationTyping((prev) => {
                const next = new Map(prev);
                next.set(req.request_id, '');
                return next;
              })
            }
          >
            Other…
          </button>
        </div>
      )}
    </div>
  );
}

const CLARIFY_URL_RE = /((?:https?:\/\/|www\.)[^\s)]+)/i;
/** Pull the first URL out of a clarification option so we can offer a
 *  "visit" link next to it. Trims trailing punctuation and upgrades a
 *  bare www. host to https so shell.openExternal accepts it. */
function extractClarifyUrl(text: string): string | null {
  const m = text.match(CLARIFY_URL_RE);
  if (!m) return null;
  let u = m[0].replace(/[).,]+$/, '');
  if (u.toLowerCase().startsWith('www.')) u = `https://${u}`;
  return u;
}

/** Blocking popup that surfaces curator clarification questions. The
 *  per-shot agent panel used to render these inline, which meant a
 *  question for a shot the user wasn't looking at — common during bulk
 *  "Curate library", where 4 transcript beats research in parallel — went
 *  unseen and the agent stalled waiting for an answer. This lifts them
 *  to a single global modal. Pending requests form a FIFO queue keyed
 *  by shot_idx; we show the oldest and reveal the next once answered. */
function ClarificationModal({
  pending,
  plan,
  clarificationTyping,
  setClarificationTyping,
  answerClarification,
}: {
  pending: Map<number, CuratorClarificationRequest>;
  plan: SuggestedEdit | null;
  clarificationTyping: Map<string, string>;
  setClarificationTyping: React.Dispatch<
    React.SetStateAction<Map<string, string>>
  >;
  answerClarification: (
    req: CuratorClarificationRequest,
    answer: string,
  ) => Promise<void>;
}): React.JSX.Element | null {
  const queue = Array.from(pending.values());
  if (queue.length === 0) return null;
  const req = queue[0];
  // Look up the shot so the popup can show what it's actually for —
  // its role, timing, the line being spoken over it, and the b-roll
  // the curator is trying to source — instead of just a bare question.
  const shot = plan?.shots.find((s) => s.shot_idx === req.shot_idx) ?? null;
  const broll = shot?.options[0]?.broll_description || shot?.broll_description;
  return (
    <div
      className="clarify-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Curator needs your input"
    >
      <div className="clarify-modal">
        <div className="clarify-modal-head">
          <span className="clarify-modal-shot">
            {req.shot_idx < 0 ? 'Library curation' : `Shot ${req.shot_idx}`}
          </span>
          {shot && (
            <span className="clarify-modal-role">{shot.structure_role}</span>
          )}
          {shot && (
            <span className="clarify-modal-time">
              {(shot.start_ms / 1000).toFixed(1)}s–
              {(shot.end_ms / 1000).toFixed(1)}s
            </span>
          )}
          {queue.length > 1 && (
            <span className="clarify-modal-queue">
              +{queue.length - 1} more question
              {queue.length - 1 === 1 ? '' : 's'} waiting
            </span>
          )}
        </div>
        {shot && (shot.spoken_during || broll) && (
          <div className="clarify-shot-detail">
            {shot.spoken_during && (
              <div className="clarify-shot-line">"{shot.spoken_during}"</div>
            )}
            {broll && (
              <div className="clarify-shot-broll">
                <span className="clarify-shot-broll-label">
                  what this shot is for
                </span>
                {broll}
              </div>
            )}
          </div>
        )}
        <ShotClarification
          req={req}
          typedText={clarificationTyping.get(req.request_id)}
          setClarificationTyping={setClarificationTyping}
          answerClarification={answerClarification}
        />
      </div>
    </div>
  );
}

/** Persistent right-rail phone preview. Shows the currently selected
 *  shot inside a real-iPhone-proportion mockup, with a chip strip that
 *  lets the user flip through their picks to see each one rendered on
 *  the device. Falls back to the top curated candidate's thumbnail when
 *  no picks have been confirmed yet. */
function PhoneSidebar({
  shot,
  curation,
  allShots = [],
  allCuration = null,
  selectedOptionIdx,
  subtitleSpec = null,
  targetVideoUrl = null,
  targetVideoPath = null,
  narrationVideoPath = null,
  sfxPlan = null,
  sfxOverride = null,
  sfxVolume,
  sfxEvents = null,
  sfxLeadMs = 0,
  narrationVolume = 1,
  onNarrationVolumeChange,
}: {
  shot: ShotPlan | null;
  curation: ShotCuration | null;
  allShots?: ShotPlan[];
  allCuration?: CurationResult | null;
  selectedOptionIdx: number;
  subtitleSpec?: SubtitleSpec | null;
  targetVideoUrl?: string | null;
  targetVideoPath?: string | null;
  /** Original target file (with audio) for narration playback — the visual
   *  target (targetVideoPath) is the preview copy, which is audio-stripped. */
  narrationVideoPath?: string | null;
  /** Inspiration-derived SFX placement pattern (from the fingerprint).
   *  Determines the live preview's SFX cadence/type, mirroring export. */
  sfxPlan?: SfxCollectionPattern | null;
  /** Command-bar SFX override (cadence/type), overrides the pattern. */
  sfxOverride?: import('./global').SfxOverride | null;
  /** SFX playback gain for the preview (0-1). */
  sfxVolume?: number;
  /** Hand-edited SFX events; when set they drive the preview verbatim. */
  sfxEvents?:
    | { ms: number; type: SfxType; sound?: string; volume?: number }[]
    | null;
  /** Fire each SFX this many ms before its word (default 0). */
  sfxLeadMs?: number;
  /** Original video audio gain for preview playback, 0-1 (default 1). */
  narrationVolume?: number;
  /** Persist a new original-video audio gain to the plan. */
  onNarrationVolumeChange?: (volume: number) => void;
}): React.JSX.Element {
  const [pickIdx, setPickIdx] = useState(0);
  const [reelMode, setReelMode] = useState(false);
  const [reelShotIdx, setReelShotIdx] = useState(0);
  const activeShot = reelMode ? (allShots[reelShotIdx] ?? shot) : shot;
  const activeCuration =
    reelMode && activeShot && allCuration
      ? (allCuration.shots.find(
          (c) => c != null && c.shot_idx === activeShot.shot_idx,
        ) ?? null)
      : curation;
  const picks = getSelections(activeShot ?? undefined);
  const pickDurationMs =
    activeShot && picks.length > 0
      ? Math.max(250, Math.round(activeShot.duration_ms / picks.length))
      : 0;
  const [resolvedTargetVideoUrl, setResolvedTargetVideoUrl] = useState<string | null>(
    targetVideoUrl,
  );
  // Reel-mode narration: the target video's audio plays as the master clock
  // so the preview is audible AND shot advancement stays in sync with the
  // voiceover (instead of drifting timers). Falls back to timers only if the
  // browser blocks autoplay.
  const narrationRef = useRef<HTMLVideoElement | null>(null);
  const [narrationBlocked, setNarrationBlocked] = useState(false);
  const [narrationStatus, setNarrationStatus] = useState<string>('idle');
  // Web Audio graph on the narration <video> so its volume can exceed 100%.
  // HTML media element .volume is clamped to [0,1] (and throws above it), so a
  // GainNode is the only way to boost the original audio up to 400%.
  const narrationAudioCtxRef = useRef<AudioContext | null>(null);
  const narrationGainRef = useRef<GainNode | null>(null);
  // Lazily build the gain graph. Must run inside a user gesture — an
  // AudioContext starts suspended, and createMediaElementSource reroutes the
  // element's audio through the graph (silent until the context resumes).
  const ensureNarrationGain = React.useCallback((): GainNode | null => {
    const el = narrationRef.current;
    if (!el) return null;
    if (!narrationGainRef.current) {
      try {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctx();
        const source = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();
        source.connect(gain).connect(ctx.destination);
        narrationAudioCtxRef.current = ctx;
        narrationGainRef.current = gain;
      } catch {
        return null;
      }
    }
    void narrationAudioCtxRef.current?.resume().catch(() => {});
    return narrationGainRef.current;
  }, []);
  // Apply the narration gain. Only routes through Web Audio when boosting above
  // 100% (the GainNode is the only way past the element's 0-1 clamp); at or
  // below 100% it uses native element volume so default playback is untouched.
  const applyNarrationVolume = React.useCallback(
    (vol: number): void => {
      const el = narrationRef.current;
      if (!el) return;
      const gain = vol > 1 ? ensureNarrationGain() : narrationGainRef.current;
      if (gain) {
        gain.gain.value = Math.max(0, vol);
        el.volume = 1;
      } else {
        el.volume = Math.min(1, Math.max(0, vol));
      }
    },
    [ensureNarrationGain],
  );
  // The narration source is the ORIGINAL target file (has audio). The visual
  // target (resolvedTargetVideoUrl) is the preview copy, transcoded with -an.
  const [resolvedNarrationUrl, setResolvedNarrationUrl] = useState<string | null>(
    null,
  );
  const audioDriven = reelMode && !!resolvedNarrationUrl && !narrationBlocked;

  // SFX on their own transcript-driven timeline (shot-independent): main
  // transcribes the narration + places SFX on word onsets per the learned
  // cadence; the preview fires each as the playback clock crosses its ms.
  const [sfxTimeline, setSfxTimeline] = useState<
    {
      ms: number;
      url: string;
      word: string;
      type: string;
      sound?: string;
      volume?: number;
    }[]
  >([]);
  const sfxFiredMsRef = useRef(-1);
  const sfxCuesKey =
    (allShots ?? []).map((s) => s.sfx_cue ?? '').join('|') +
    '#' +
    (sfxPlan
      ? `${sfxPlan.signals.sfx_per_word.toFixed(2)}:${sfxPlan.signals.body_dominant_type ?? ''}:${sfxPlan.signals.hook_escalation.toFixed(2)}`
      : 'none') +
    '#' +
    `${sfxOverride?.cadence ?? ''}:${sfxOverride?.type ?? ''}` +
    '#' +
    (sfxEvents
      ? sfxEvents
          .map((e) => `${e.ms}:${e.type}:${e.sound ?? ''}:${e.volume ?? ''}`)
          .join(',')
      : '');

  // Clamp/reset the pick index whenever the underlying picks change or
  // the user switches shots — otherwise stale indices point past the
  // end of the array and the preview blanks out.
  useEffect(() => {
    if (pickIdx >= picks.length) setPickIdx(0);
  }, [pickIdx, picks.length]);
  useEffect(() => {
    setPickIdx(0);
  }, [activeShot?.shot_idx]);
  useEffect(() => {
    if (!activeShot || picks.length <= 1 || reelMode) return;
    const timeout = window.setTimeout(() => {
      setPickIdx((idx) => (idx + 1) % picks.length);
    }, pickDurationMs);
    return () => window.clearTimeout(timeout);
  }, [activeShot?.shot_idx, picks.length, pickIdx, pickDurationMs, reelMode]);
  useEffect(() => {
    if (reelShotIdx >= allShots.length) setReelShotIdx(0);
  }, [allShots.length, reelShotIdx]);
  useEffect(() => {
    // Timer advancement is only the fallback for when there's no narration
    // audio (or autoplay was blocked). When audio drives the reel, the
    // <audio> onTimeUpdate handler advances shots instead.
    if (!reelMode || audioDriven || !activeShot || allShots.length === 0) return;
    const timeout = window.setTimeout(() => {
      setReelShotIdx((idx) => (idx + 1) % allShots.length);
    }, Math.max(250, activeShot.duration_ms));
    const pickTimeout =
      picks.length > 1
        ? window.setInterval(() => {
            setPickIdx((idx) => (idx + 1) % picks.length);
          }, pickDurationMs)
        : null;
    return () => {
      window.clearTimeout(timeout);
      if (pickTimeout !== null) window.clearInterval(pickTimeout);
    };
  }, [
    activeShot?.shot_idx,
    activeShot?.duration_ms,
    allShots.length,
    reelMode,
    audioDriven,
    picks.length,
    pickDurationMs,
  ]);
  // Playback is started from the Reel button's click (a user gesture, so
  // autoplay-with-sound is allowed). Here we only stop narration when leaving
  // reel mode.
  useEffect(() => {
    if (!reelMode) narrationRef.current?.pause();
  }, [reelMode]);

  // Keep the playing narration's gain in sync with the slider live.
  useEffect(() => {
    applyNarrationVolume(narrationVolume ?? 1);
  }, [narrationVolume, applyNarrationVolume]);

  // Build the transcript-driven SFX timeline (main transcribes narration +
  // places per cadence). Keyed on the narration + cues so it refetches when
  // the plan changes.
  useEffect(() => {
    if (
      !narrationVideoPath ||
      typeof window.api?.getSfxTimeline !== 'function'
    ) {
      setSfxTimeline([]);
      return;
    }
    let cancelled = false;
    void window.api
      .getSfxTimeline({
        narrationPath: narrationVideoPath,
        shots: (allShots ?? []).map((s) => ({
          sfx_cue: s.sfx_cue ?? null,
          start_ms: s.start_ms,
          duration_ms: s.duration_ms,
        })),
        sfxPlan,
        override: sfxOverride ?? null,
        events: sfxEvents ?? null,
      })
      .then((tl) => {
        if (!cancelled) setSfxTimeline(tl ?? []);
      })
      .catch(() => {
        if (!cancelled) setSfxTimeline([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrationVideoPath, sfxCuesKey]);

  // Reset the playback cursor whenever reel mode (re)starts.
  useEffect(() => {
    sfxFiredMsRef.current = -1;
  }, [reelMode]);
  // Caption clock: while audio drives the reel, sample the narration's real
  // currentTime so the karaoke caption tracks the voiceover. This REPLACES the
  // ReelMockup wall-clock ticker, which loops every shot duration and — once
  // it drifts from the audio — wraps the caption back to the first word
  // mid-shot (the flicker). null when not audio-driven (mockup keeps its own
  // ticker). 80ms = same cadence as the ticker it replaces.
  const [captionAudioMs, setCaptionAudioMs] = useState<number | null>(null);
  useEffect(() => {
    if (!audioDriven) {
      setCaptionAudioMs(null);
      return;
    }
    // Single audio-clock sampler driving shot + pick + caption together at
    // 60ms, so they all track the narration tightly (the old onTimeUpdate
    // path only fired ~4x/sec, lagging shot changes up to 250ms).
    const id = window.setInterval(() => {
      const v = narrationRef.current;
      if (!v) return;
      const t = v.currentTime * 1000;
      setCaptionAudioMs(t);
      // Fire SFX whose onset the playback clock just crossed. Reset on loop
      // (t jumps backwards past the cursor).
      if (t < sfxFiredMsRef.current) sfxFiredMsRef.current = -1;
      for (const ev of sfxTimeline) {
        const fireAt = ev.ms - sfxLeadMs; // lead = fire before the word
        if (fireAt > sfxFiredMsRef.current && fireAt <= t) {
          try {
            const a = new Audio(ev.url);
            // Per-event gain wins; else the plan-wide SFX level.
            a.volume =
              typeof ev.volume === 'number' ? ev.volume : (sfxVolume ?? 0.6);
            void a.play().catch(() => {});
          } catch {
            /* ignore */
          }
        }
      }
      sfxFiredMsRef.current = t;
      const idx = allShots.findIndex((s) => t >= s.start_ms && t < s.end_ms);
      if (idx < 0) return;
      setReelShotIdx((prev) => (idx !== prev ? idx : prev));
      const s = allShots[idx];
      const sPicks = getSelections(s);
      if (sPicks.length > 1) {
        const pd = Math.max(250, Math.round(s.duration_ms / sPicks.length));
        const pi = Math.min(
          Math.floor((t - s.start_ms) / pd),
          sPicks.length - 1,
        );
        setPickIdx((prev) => (pi !== prev ? pi : prev));
      }
    }, 60);
    return () => window.clearInterval(id);
  }, [audioDriven, allShots, sfxTimeline, sfxVolume, sfxLeadMs]);
  useEffect(() => {
    let cancelled = false;
    if (targetVideoUrl) {
      setResolvedTargetVideoUrl(targetVideoUrl);
      return;
    }
    if (!targetVideoPath) {
      setResolvedTargetVideoUrl(null);
      return;
    }
    window.api
      .localVideoUrl(targetVideoPath)
      .then((url) => {
        if (!cancelled) setResolvedTargetVideoUrl(url);
      })
      .catch(() => {
        if (!cancelled) setResolvedTargetVideoUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [targetVideoPath, targetVideoUrl]);
  // Resolve the narration source (original file, with audio) to a playable URL.
  useEffect(() => {
    let cancelled = false;
    if (!narrationVideoPath) {
      setResolvedNarrationUrl(null);
      return;
    }
    window.api
      .localVideoUrl(narrationVideoPath)
      .then((url) => {
        if (!cancelled) setResolvedNarrationUrl(url);
      })
      .catch(() => {
        if (!cancelled) setResolvedNarrationUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [narrationVideoPath]);

  if (!activeShot) {
    return (
      <aside className="phone-sidebar phone-sidebar-empty">
        <div className="phone-sidebar-eyebrow">Preview</div>
        <div className="phone-sidebar-placeholder">
          Pick a shot to preview it here.
        </div>
      </aside>
    );
  }

  const selOpt =
    activeShot.options[reelMode ? 0 : selectedOptionIdx] ??
    activeShot.options[0];
  const baseShot: ShotPlan = selOpt
    ? {
        ...activeShot,
        broll_description: selOpt.broll_description,
        asset: selOpt.asset,
        placement: selOpt.placement,
        source_type: selOpt.source_type,
      }
    : activeShot;
  const previewShot: ShotPlan = {
    ...baseShot,
    has_overlay: false,
    additional_elements: [],
  };
  const isOverlayLayout = previewShot.placement.fit === 'pip';
  const layeredPreviewMedia =
    isOverlayLayout && picks.length > 1
      ? picks
          .map((pick, i) => previewLayerFromPick(pick, previewShot, i, picks.length))
          .filter((layer): layer is PreviewMediaLayer => !!layer)
      : [];
  // Source the on-screen media: a confirmed pick if one is highlighted,
  // otherwise the top curated candidate's thumbnail so the user always
  // sees *something* once research has run.
  const currentPick = picks[pickIdx] ?? null;
  const mockupShot: ShotPlan = {
    ...(picks.length > 1 && !isOverlayLayout
      ? {
          ...previewShot,
          start_ms: 0,
          end_ms: pickDurationMs,
          duration_ms: pickDurationMs,
        }
      : previewShot),
  };
  const mediaShot = shotWithMediaOverrides(mockupShot, currentPick);
  let previewSrc: string | null = null;
  let previewKind: PreviewKind = 'image';
  let previewVideoMode: 'segment' | 'full' = 'segment';
  let previewPlaybackStartMs: number | null = null;
  let previewPlaybackEndMs: number | null = null;
  if (currentPick && layeredPreviewMedia.length === 0) {
    const preview = previewFromSelectedMedia(currentPick);
    previewSrc = preview.src;
    previewKind = preview.kind;
    previewVideoMode = preview.kind === 'video' ? 'full' : 'segment';
    previewPlaybackStartMs = currentPick.playback_start_ms ?? null;
    previewPlaybackEndMs = currentPick.playback_end_ms ?? null;
  } else {
    previewSrc = activeCuration?.candidates?.[0]?.thumbnail_url ?? null;
    previewKind = 'image';
  }

  // Audio-synced caption clock = the narration's real (global) time. The
  // caption is timed against the REAL shot (passed as captionShotStart/EndMs
  // below), NOT the per-pick mockupShot window, so a multi-media shot runs the
  // caption once across the whole shot instead of replaying it per pick. null
  // when not audio-driven, so the mockup falls back to its own wall ticker.
  const captionTimeMs = captionAudioMs;
  const canPreviewFullReel = allShots.length > 0;

  return (
    <aside className="phone-sidebar">
      <div className="phone-sidebar-head">
        <span className="phone-sidebar-eyebrow">Preview</span>
        <span className="phone-sidebar-head-right">
          {canPreviewFullReel && (
            <span className="phone-preview-mode" role="group" aria-label="Preview mode">
              <button
                type="button"
                className={`phone-preview-mode-btn${!reelMode ? ' on' : ''}`}
                onClick={() => {
                  narrationRef.current?.pause();
                  setReelMode(false);
                }}
              >
                Shot
              </button>
              <button
                type="button"
                className={`phone-preview-mode-btn${reelMode ? ' on' : ''}`}
                onClick={() => {
                  setReelShotIdx(0);
                  setReelMode(true);
                  // Start narration synchronously inside the click so the
                  // browser's autoplay-with-sound gate is satisfied.
                  const v = narrationRef.current;
                  if (v) {
                    setNarrationBlocked(false);
                    applyNarrationVolume(narrationVolume ?? 1);
                    try {
                      v.currentTime = 0;
                    } catch {
                      /* not seekable yet */
                    }
                    void v.play().catch(() => setNarrationBlocked(true));
                  }
                }}
              >
                Reel
              </button>
            </span>
          )}
          <span className="phone-sidebar-time">
            {reelMode
              ? `${reelShotIdx + 1}/${allShots.length}`
              : `${(activeShot.start_ms / 1000).toFixed(1)}s – ${(activeShot.end_ms / 1000).toFixed(1)}s`}
          </span>
        </span>
      </div>
      <div className="phone-sidebar-stage">
        <ReelMockup
          shot={mediaShot}
          previewImageUrl={previewSrc}
          previewKind={previewKind}
          previewVideoMode={previewVideoMode}
          previewPlaybackStartMs={previewPlaybackStartMs}
          previewPlaybackEndMs={previewPlaybackEndMs}
          layeredPreviewMedia={layeredPreviewMedia}
          subtitleSpec={subtitleSpec}
          targetVideoUrl={resolvedTargetVideoUrl}
          reelPlayback={reelMode}
          captionTimeMs={captionTimeMs}
          captionShotStartMs={activeShot.start_ms}
          captionShotEndMs={activeShot.end_ms}
        />
        {resolvedNarrationUrl && (
          // Hidden narration track — the ORIGINAL target file's audio (the
          // preview copy is transcoded with -an, no audio). Mounted
          // persistently so the Reel button can call play() inside its click
          // (autoplay-with-sound needs a user gesture). Drives shot + pick
          // advancement off its real clock so the preview is audible and stays
          // in sync with the voiceover. Per-shot b-roll videos inside
          // ReelMockup stay muted, so this is the only sound. A <video> (not
          // <audio>) reliably decodes the mp4 audio track.
          <video
            ref={narrationRef}
            src={resolvedNarrationUrl}
            // CORS-clean fetch so createMediaElementSource (used to boost the
            // audio above 100%) doesn't taint the output to silence.
            crossOrigin="anonymous"
            loop
            playsInline
            preload="auto"
            // Off-screen rather than display:none — a display:none <video> can
            // get its playback suspended in Chromium; 1px offscreen keeps it
            // "rendered" so audio keeps flowing.
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: 'none',
              left: -9999,
            }}
            onError={() =>
              setNarrationStatus(
                `error ${narrationRef.current?.error?.code ?? '?'}`,
              )
            }
            onLoadedMetadata={() => setNarrationStatus('ready')}
            onPlay={() => setNarrationStatus('playing')}
            onPlaying={() => setNarrationStatus('playing')}
            onPause={() => setNarrationStatus('paused')}
          />
        )}
      </div>
      {reelMode && (
        <div className="phone-sidebar-audio">
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              const v = narrationRef.current;
              if (!v) {
                setNarrationStatus('no element');
                return;
              }
              if (!v.paused) {
                v.pause();
                return;
              }
              v.muted = false;
              applyNarrationVolume(narrationVolume ?? 1);
              setNarrationBlocked(false);
              void v
                .play()
                .then(() => setNarrationStatus('playing'))
                .catch((err) => {
                  setNarrationBlocked(true);
                  setNarrationStatus(`play rejected: ${err?.name ?? err}`);
                });
            }}
          >
            {narrationStatus === 'playing' ? '⏸ Pause' : '🔊 Play sound'}
          </button>
          <span className="phone-sidebar-audio-status">
            {resolvedNarrationUrl
              ? `${narrationStatus} · ${
                  (() => {
                    try {
                      return new URL(resolvedNarrationUrl).protocol.replace(
                        ':',
                        '',
                      );
                    } catch {
                      return 'src';
                    }
                  })()
                }`
              : 'no audio source'}
          </span>
          {onNarrationVolumeChange && (
            <label className="phone-sidebar-vol" title="Original video audio volume">
              <span className="phone-sidebar-vol-ic">🎙</span>
              <input
                type="range"
                min={0}
                max={4}
                step={0.05}
                value={narrationVolume ?? 1}
                onChange={(e) =>
                  onNarrationVolumeChange(Number(e.target.value))
                }
              />
              <span className="phone-sidebar-vol-val">
                {Math.round((narrationVolume ?? 1) * 100)}%
              </span>
            </label>
          )}
        </div>
      )}
      <div className="phone-sidebar-caption">{previewShot.placement.fit}</div>

      {picks.length > 0 && (
        <div className="phone-sidebar-picks">
          <div className="phone-sidebar-picks-label">
            Showing pick {pickIdx + 1} of {picks.length}
            {picks.length > 1
              ? ` · ${(pickDurationMs / 1000).toFixed(1)}s each`
              : ''}
          </div>
          <div className="phone-sidebar-picks-list" role="radiogroup">
            {picks.map((p, i) => {
              const active = i === pickIdx;
              return (
                <button
                  key={`${p.url}-${i}`}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`phone-sidebar-pick${active ? ' phone-sidebar-pick-on' : ''}`}
                  onClick={() => setPickIdx(i)}
                  title={`${p.kind} · ${p.origin.replace(/_/g, ' ')}${p.reason ? ` — ${p.reason}` : ''}`}
                >
                  <span className="phone-sidebar-pick-num">#{i + 1}</span>
                  <span className="phone-sidebar-pick-kind">{p.kind}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}

function boundedVideoSegment(
  durationSec: number,
  startMs: number,
  endMs: number,
): { start: number; end: number } {
  const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const shotLen = Math.max(0.1, (endMs - startMs) / 1000);
  if (duration <= 0) return { start: 0, end: 0 };
  const rawStart = Math.max(0, startMs / 1000);
  const rawEnd = Math.max(rawStart + 0.1, endMs / 1000);
  if (rawStart >= duration) {
    const start = Math.max(0, duration - Math.min(shotLen, duration));
    return { start, end: duration };
  }
  return {
    start: Math.min(rawStart, duration),
    end: Math.min(rawEnd, duration),
  };
}

function sourcePlaybackSegment(
  durationSec: number,
  mode: 'segment' | 'full',
  shot: ShotPlan,
  sourceStartMs?: number | null,
  sourceEndMs?: number | null,
): { start: number; end: number; trimmed: boolean } {
  const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const hasTrim =
    typeof sourceStartMs === 'number' || typeof sourceEndMs === 'number';
  if (duration <= 0) return { start: 0, end: 0, trimmed: hasTrim };
  if (!hasTrim) {
    return mode === 'full'
      ? { start: 0, end: duration, trimmed: false }
      : { ...boundedVideoSegment(duration, shot.start_ms, shot.end_ms), trimmed: false };
  }
  const start = Math.max(0, Math.min(duration, (sourceStartMs ?? 0) / 1000));
  const rawEnd =
    typeof sourceEndMs === 'number' ? sourceEndMs / 1000 : duration;
  const end = Math.max(start + 0.05, Math.min(duration, rawEnd));
  return { start, end, trimmed: true };
}

export function SegmentVideo({
  src,
  shot,
  className,
  mode = 'segment',
  sourceStartMs = null,
  sourceEndMs = null,
  controls = false,
  loopSegment = true,
  renderTimeMs = null,
  onPlaybackMs,
  onSegmentEnd,
  onError,
  onMetadata,
}: {
  src: string;
  shot: ShotPlan;
  className: string;
  mode?: 'segment' | 'full';
  sourceStartMs?: number | null;
  sourceEndMs?: number | null;
  controls?: boolean;
  loopSegment?: boolean;
  /** Deterministic export mode: when set, the video does NOT autoplay or
   *  loop. It seeks to the exact source frame for this timeline position
   *  (mapped through the same boundedVideoSegment math the live preview
   *  uses) and pauses, so a frame-grabber captures a settled image. */
  renderTimeMs?: number | null;
  onPlaybackMs?: (ms: number) => void;
  onSegmentEnd?: () => void;
  onError?: () => void;
  onMetadata?: (width: number, height: number) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement | null>(null);
  const segmentRef = useRef({ start: Math.max(0, shot.start_ms / 1000), end: 0 });
  const deterministic = renderTimeMs != null;
  const segmentKey =
    mode === 'full'
      ? `${src}:full:${sourceStartMs ?? ''}:${sourceEndMs ?? ''}`
      : `${src}:${shot.shot_idx}:${shot.start_ms}:${shot.end_ms}:${sourceStartMs ?? ''}:${sourceEndMs ?? ''}`;

  // Deterministic seek: map the timeline position to an exact source
  // currentTime using the SAME segment math as live playback, then pause.
  const seekDeterministic = React.useCallback((attempt = 0) => {
    const video = ref.current;
    if (!video) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      if (attempt < 12) window.setTimeout(() => seekDeterministic(attempt + 1), 60);
      return;
    }
    const seg = sourcePlaybackSegment(
      video.duration,
      mode,
      shot,
      sourceStartMs,
      sourceEndMs,
    );
    const span = Math.max(0.05, seg.end - seg.start);
    const localSec = Math.max(0, ((renderTimeMs ?? 0) - shot.start_ms) / 1000);
    const t = seg.start + (localSec % span);
    video.pause();
    if (Math.abs(video.currentTime - t) > 0.005) video.currentTime = t;
  }, [mode, renderTimeMs, shot, sourceEndMs, sourceStartMs]);

  useEffect(() => {
    if (deterministic) seekDeterministic();
  }, [deterministic, seekDeterministic, segmentKey]);

  const syncToSegment = React.useCallback((attempt = 0) => {
    if (deterministic) return;
    const hasTrim =
      typeof sourceStartMs === 'number' || typeof sourceEndMs === 'number';
    if (mode === 'full' && !hasTrim) return;
    const video = ref.current;
    if (!video) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      if (attempt < 8) {
        window.setTimeout(() => syncToSegment(attempt + 1), 80);
      }
      return;
    }
    const segment = sourcePlaybackSegment(
      video.duration,
      mode,
      shot,
      sourceStartMs,
      sourceEndMs,
    );
    segmentRef.current = segment;
    if (Math.abs(video.currentTime - segment.start) > 0.05) {
      video.currentTime = segment.start;
    }
    onPlaybackMs?.(segment.start * 1000);
    void video.play().catch(() => {
      /* autoplay can be blocked until the user interacts; controls still work */
    });
  }, [mode, onPlaybackMs, shot, sourceEndMs, sourceStartMs]);

  useEffect(() => {
    if (deterministic) return;
    const hasTrim =
      typeof sourceStartMs === 'number' || typeof sourceEndMs === 'number';
    if (mode === 'full' && !hasTrim) {
      const video = ref.current;
      if (video) void video.play().catch(() => {});
      return;
    }
    segmentRef.current = {
      start: Math.max(0, shot.start_ms / 1000),
      end: Math.max(0, shot.end_ms / 1000),
    };
    syncToSegment();
    const raf = window.requestAnimationFrame(() => syncToSegment());
    return () => window.cancelAnimationFrame(raf);
  }, [deterministic, mode, segmentKey, syncToSegment, shot.end_ms, shot.start_ms, sourceEndMs, sourceStartMs]);

  return (
    <video
      key={segmentKey}
      ref={ref}
      className={className}
      src={src}
      autoPlay={!deterministic}
      muted
      playsInline
      preload="metadata"
      controls={controls}
      onLoadedMetadata={(e) => {
        onMetadata?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight);
        if (deterministic) seekDeterministic();
        else syncToSegment();
      }}
      onLoadedData={() => (deterministic ? seekDeterministic() : syncToSegment())}
      onCanPlay={() => (deterministic ? seekDeterministic() : syncToSegment())}
      onTimeUpdate={(e) => {
        if (deterministic) return;
        const video = e.currentTarget;
        onPlaybackMs?.(video.currentTime * 1000);
        const hasTrim =
          typeof sourceStartMs === 'number' || typeof sourceEndMs === 'number';
        if (mode === 'full' && !hasTrim) return;
        const segment = segmentRef.current;
        if (segment.end > 0 && video.currentTime >= segment.end - 0.03) {
          if (loopSegment) {
            video.currentTime = segment.start;
            void video.play().catch(() => {});
          } else {
            onSegmentEnd?.();
          }
        }
      }}
      onError={onError}
    />
  );
}

export function ReelMockup({
  shot,
  previewImageUrl,
  previewKind = 'image',
  previewVideoMode = 'segment',
  previewPlaybackStartMs = null,
  previewPlaybackEndMs = null,
  layeredPreviewMedia = [],
  subtitleSpec = null,
  targetVideoUrl = null,
  reelPlayback = false,
  renderTimeMs = null,
  captionTimeMs = null,
  captionShotStartMs = null,
  captionShotEndMs = null,
  onSegmentEnd,
}: {
  shot: ShotPlan;
  /** Caption clock (ms, on the REAL shot timeline). When set, the karaoke
   *  caption tracks this instead of the internal wall-clock ticker — used to
   *  sync captions to the narration audio (live) or the frame time (export). */
  captionTimeMs?: number | null;
  /** Real shot start/end for caption timing, independent of `shot` (which may
   *  be remapped to a single media-pick window when a shot has multiple
   *  medias). Keeps the caption running ONCE across the whole shot instead of
   *  restarting per pick. Falls back to shot.start_ms/end_ms. */
  captionShotStartMs?: number | null;
  captionShotEndMs?: number | null;
  /** Deterministic export mode. When set, all motion (scene animations,
   *  overlay anims, captions, videos) is pinned to this timeline position
   *  instead of running on the wall clock: CSS animations are paused and
   *  scrubbed via a negative animation-delay, videos seek-and-pause, and
   *  the caption is computed at exactly this ms. Lets a frame-grabber
   *  capture an identical-to-preview still for any time T. */
  renderTimeMs?: number | null;
  /** When present + enabled, the shot's text overlay renders in this
   *  detected subtitle style (font, treatment, color, casing) so the
   *  mockup matches what the burned-in caption will look like. */
  subtitleSpec?: SubtitleSpec | null;
  /** When present, render this real media inside the b-roll block
   *  instead of the schematic label — e.g. a curated candidate's
   *  thumbnail, so the mockup shows what the shot will actually look
   *  like once media is attached. */
  previewImageUrl?: string | null;
  /** Multiple selected clips for the Overlay layout. Later layers sit on
   *  top of earlier layers while staying offset so all remain visible. */
  layeredPreviewMedia?: PreviewMediaLayer[];
  /** What kind of media `previewImageUrl` points to. `'image'` renders
   *  with <img>, `'video'` with an autoplay <video>, `'embed'` with an
   *  <iframe> (YouTube/Vimeo), `'reelthumb'` with <ReelThumb> (fetches a
   *  poster frame). Defaults to `'image'` so legacy callers (which
   *  always passed a thumbnail URL) keep working. */
  previewKind?: PreviewKind;
  previewVideoMode?: 'segment' | 'full';
  previewPlaybackStartMs?: number | null;
  previewPlaybackEndMs?: number | null;
  targetVideoUrl?: string | null;
  reelPlayback?: boolean;
  onSegmentEnd?: () => void;
}): React.JSX.Element {
  // If a remote <video> source fails to decode (CORS, dead link, an mp4
  // the platform serves with the wrong content-type), drop back to the
  // schematic label rather than leaving Chromium's broken-media glyph.
  const [videoFailed, setVideoFailed] = useState(false);
  const [targetVideoFailed, setTargetVideoFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [wideLayerKeys, setWideLayerKeys] = useState<Set<string>>(() => new Set());
  const deterministic = renderTimeMs != null;
  const [playbackMs, setPlaybackMs] = useState(
    deterministic ? (renderTimeMs as number) : shot.start_ms,
  );
  // In deterministic mode the video must not feed the clock back; the
  // timeline drives everything top-down.
  const reportPlayback = deterministic ? undefined : setPlaybackMs;
  useEffect(() => {
    setVideoFailed(false);
    setTargetVideoFailed(false);
    setImgFailed(false);
    if (!deterministic) setPlaybackMs(shot.start_ms);
  }, [previewImageUrl, targetVideoUrl, deterministic]);
  useEffect(() => {
    if (!deterministic) setPlaybackMs(shot.start_ms);
  }, [shot.shot_idx, shot.start_ms, deterministic]);
  useEffect(() => {
    if (deterministic) setPlaybackMs(renderTimeMs as number);
  }, [deterministic, renderTimeMs]);
  const { placement, broll_description, text_overlay, text_position } = shot;
  // Scrub the (paused) CSS keyframe animations to the current timeline
  // position via a negative animation-delay. animation-fill-mode: both
  // holds the end state past the duration, matching the live "play once
  // then hold" behaviour. Applied to every animated block + overlay.
  const detLocalMs = deterministic
    ? Math.max(0, (renderTimeMs as number) - shot.start_ms)
    : 0;
  const scrubStyle: React.CSSProperties = deterministic
    ? { animationDelay: `-${detLocalMs}ms`, animationPlayState: 'paused' }
    : {};
  const brollLabel = (broll_description || 'b-roll').replace(/\s+/g, ' ').trim();
  // Structured motion preset → CSS animation class applied to the base
  // media block.
  const animClass = sceneAnimationClass(shot.scene_animation);
  const animIntensity = shot.animation_scale ?? 1;
  // Default the motion to the shot's own length so it plays exactly once
  // across the shot; the user can shorten it. Never loops.
  const animDurationMs = shot.animation_duration_ms ?? shot.duration_ms;
  const animEasing = shot.animation_easing ?? 'ease-in-out';
  const animRegion = shot.animation_origin ?? 'middle_center';
  const animOrigin = pointOrigin(shot.animation_x, shot.animation_y, animRegion);
  // Slider tops out at 1.6x but the typed field allows up to 5x — honor
  // the larger ceiling here so typed values actually render.
  const mediaStartZoom = Math.max(1, Math.min(5, shot.media_start_zoom ?? 1));
  // Start zoom is independent of the animation. When a scene animation
  // plays, its keyframes consume --anim-start-zoom as the motion's
  // starting scale (so we only set the transform-origin here). When
  // there's NO animation, apply it as a static container scale so the
  // zoom still takes effect.
  const startZoomStyle: React.CSSProperties = animClass
    ? { transformOrigin: animOrigin }
    : mediaStartZoom !== 1
      ? { transform: `scale(${mediaStartZoom})`, transformOrigin: animOrigin }
      : {};
  const mediaZoom = Math.max(1, Math.min(3, shot.zoom_scale ?? 1));
  const mediaZoomRegion =
    shot.zoom_region ?? shot.animation_origin ?? 'middle_center';
  const mediaZoomOrigin = pointOrigin(
    shot.zoom_x,
    shot.zoom_y,
    mediaZoomRegion,
  );
  const mediaPosition = frameRegionOrigin(placement.position ?? 'middle_center');
  const originalPosition = frameRegionOrigin(
    shot.original_video_position ?? 'middle_center',
  );
  // The scene animation runs once and holds (animation-fill-mode: both),
  // so changing a parameter wouldn't restart a finished animation. Re-fire
  // it with the standard reset-reflow trick whenever the shot or any motion
  // parameter changes, so the preview reflects edits without remounting the
  // media element underneath.
  const brollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (deterministic) return;
    const el = brollRef.current;
    if (!el || !animClass) return;
    el.style.animationName = 'none';
    void el.offsetWidth; // force reflow so the cancel takes effect
    el.style.animationName = '';
  }, [
    animClass,
    animDurationMs,
    animIntensity,
    mediaStartZoom,
    animEasing,
    animOrigin,
    shot.shot_idx,
  ]);

  // Original/creator video animation (split layouts only) — a parallel
  // set of motion params targeting the original-video block.
  const origAnimClass = sceneAnimationClass(shot.original_scene_animation);
  const origAnimIntensity = shot.original_animation_scale ?? 1;
  const origAnimDurationMs =
    shot.original_animation_duration_ms ?? shot.duration_ms;
  const origAnimEasing = shot.original_animation_easing ?? 'ease-in-out';
  const origAnimRegion = shot.original_animation_origin ?? 'middle_center';
  const origAnimOrigin = pointOrigin(
    shot.original_animation_x,
    shot.original_animation_y,
    origAnimRegion,
  );
  const origMediaStartZoom = Math.max(
    1,
    Math.min(5, shot.original_media_start_zoom ?? 1),
  );
  const origStartZoomStyle: React.CSSProperties = origAnimClass
    ? { transformOrigin: origAnimOrigin }
    : origMediaStartZoom !== 1
      ? {
          transform: `scale(${origMediaStartZoom})`,
          transformOrigin: origAnimOrigin,
        }
      : {};
  const origVideoRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (deterministic) return;
    const el = origVideoRef.current;
    if (!el || !origAnimClass) return;
    el.style.animationName = 'none';
    void el.offsetWidth;
    el.style.animationName = '';
  }, [
    origAnimClass,
    origAnimDurationMs,
    origAnimIntensity,
    origMediaStartZoom,
    origAnimEasing,
    origAnimOrigin,
    shot.shot_idx,
  ]);
  // Render the caption in the detected subtitle style when one applies.
  const applySpec = subtitleSpec?.enabled ? subtitleSpec : null;
  const capFont = useMatchedFont(applySpec?.font_family);
  const capStyle = applySpec ? subtitleSpecCss(applySpec, capFont) : null;
  // Stable flag (vs. the every-80ms captionTimeMs value) so the ticker effect
  // doesn't re-run on every clock tick.
  const hasExternalCaptionClock = captionTimeMs != null;
  useEffect(() => {
    if (deterministic) return;
    // An external caption clock (audio-synced reel mode) supersedes the
    // wall-clock ticker — running both makes the caption fight itself.
    if (hasExternalCaptionClock) return;
    if (!applySpec || !shot.spoken_during.trim()) return;
    const startWall = performance.now();
    const shotStart = shot.start_ms;
    const duration = Math.max(250, shot.end_ms - shot.start_ms);
    const tick = window.setInterval(() => {
      const elapsed = (performance.now() - startWall) % duration;
      setPlaybackMs(shotStart + elapsed);
    }, 80);
    return () => window.clearInterval(tick);
  }, [
    applySpec,
    deterministic,
    hasExternalCaptionClock,
    shot.end_ms,
    shot.shot_idx,
    shot.spoken_during,
    shot.start_ms,
  ]);
  // In deterministic mode read the timeline position straight off the
  // prop so the karaoke caption is correct on the first paint (the
  // playbackMs state only catches up one render later via effect).
  // Caption clock: an explicit captionTimeMs (audio/frame time on the real
  // shot timeline) wins; else deterministic frame time; else the wall ticker.
  const effPlaybackMs =
    captionTimeMs != null
      ? captionTimeMs
      : deterministic
        ? (renderTimeMs as number)
        : playbackMs;
  // Time captions against the REAL shot, not the per-pick `shot` window, so a
  // multi-media shot doesn't replay the caption once per media. Only when an
  // external clock (captionTimeMs) drives — the wall-clock ticker produces
  // playbackMs in `shot`'s own (possibly per-pick) frame, so it must keep
  // using `shot`.
  const captionShot: ShotPlan =
    captionTimeMs != null &&
    (captionShotStartMs != null || captionShotEndMs != null)
      ? {
          ...shot,
          start_ms: captionShotStartMs ?? shot.start_ms,
          end_ms: captionShotEndMs ?? shot.end_ms,
        }
      : shot;
  const captionText = applySpec
    ? subtitleTextForShot(shot.spoken_during, applySpec, captionShot, effPlaybackMs)
    : text_overlay;

  // Per fit, compute the broll block's CSS rect inside the 9:16 canvas
  // and what (if anything) sits behind / next to it. Shared with the
  // layout-picker tiles so both render identical schematics.
  const { brollRect, backgroundRect, backgroundLabel } = computePlacementRects(
    placement,
    shot.clip_type,
  );

  // Text overlay position: map the FrameRegion to CSS top/left + alignment.
  const overlayPosCss = ((): {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
    transform?: string;
  } => {
    // Per-shot subtitle position wins over the plan-wide spec position.
    if (applySpec)
      return subtitlePositionCss(shot.subtitle_position ?? applySpec.position);
    const [v, h] = (text_position || 'middle_center').split('_');
    const css: Record<string, string> = {};
    if (v === 'top') css.top = '8%';
    else if (v === 'bottom') css.bottom = '8%';
    else {
      css.top = '50%';
      css.transform = 'translateY(-50%)';
    }
    if (h === 'left') css.left = '6%';
    else if (h === 'right') css.right = '6%';
    else {
      css.left = '50%';
      css.transform = (css.transform ? css.transform + ' ' : '') + 'translateX(-50%)';
    }
    return css;
  })();

  // The foreground media renders fit-to-width (.reel-block-img is
  // width:100% / height:auto, vertically centered), so any asset shorter
  // than the tall 9:19.5 phone canvas leaves dead space above/below.
  // Render a scaled-up, blurred copy of the same media as a full-bleed
  // backdrop (TikTok/IG style) so those gaps read as intentional instead
  // of black bars. Only the 'contain' fit ("Actual size") leaves gaps —
  // 'fill' covers the whole frame, and pip/split fill the rest with the
  // complementary clip (backgroundRect). Covers direct img/video sources
  // AND proxied reel/page posters (reelthumb), which resolve to a data:
  // URL we can blur. Embeds (iframes) can't be blurred, so they keep the
  // plain backdrop.
  const showBlurBackdrop =
    !!previewImageUrl &&
    !backgroundRect &&
    placement.fit === 'contain' &&
    (shot.contain_background_mode ?? 'autofill') === 'autofill' &&
    ((previewKind === 'image' && !imgFailed) ||
      (previewKind === 'video' && !videoFailed) ||
      previewKind === 'reelthumb');

  // Split + "Original size" (split_media_fit='contain') letterboxes the
  // media inside its split half, leaving gaps. Fill those with the same
  // blurred-media backdrop the full-screen "Actual size" mode uses,
  // scoped to the broll's split rect so it reads as one frame instead of
  // black bars.
  const showSplitContainBlur =
    !!previewImageUrl &&
    placement.fit.startsWith('split') &&
    (shot.split_media_fit ?? 'fill') === 'contain' &&
    ((previewKind === 'image' && !imgFailed) ||
      (previewKind === 'video' && !videoFailed) ||
      previewKind === 'reelthumb');

  // Whether the broll block actually shows media (vs the schematic label).
  // When it does, the block drops its green-accent placeholder gradient so
  // the media — and, in Actual-size mode, the blurred backdrop behind it —
  // shows cleanly instead of a green wash.
  const mediaShown =
    !!previewImageUrl &&
    layeredPreviewMedia.length === 0 &&
    !(previewKind === 'video' && videoFailed) &&
    !(previewKind === 'image' && imgFailed);
  const layerSliceMs =
    layeredPreviewMedia.length > 0
      ? Math.max(250, Math.round(shot.duration_ms / layeredPreviewMedia.length))
      : 0;
  const layerElapsedMs = Math.max(0, effPlaybackMs - shot.start_ms);
  const visibleLayerCount =
    layeredPreviewMedia.length > 0
      ? Math.max(
          1,
          Math.min(
            layeredPreviewMedia.length,
            Math.floor(layerElapsedMs / layerSliceMs) + 1,
          ),
        )
      : 0;
  const visibleLayeredPreviewMedia =
    shot.overlay_stack_mode === 'replace'
      ? layeredPreviewMedia.slice(Math.max(0, visibleLayerCount - 1), visibleLayerCount)
      : layeredPreviewMedia.slice(0, visibleLayerCount);
  const layeredMediaShown = visibleLayeredPreviewMedia.length > 0;
  const foregroundMediaShown = mediaShown || layeredMediaShown;
  const markLayerWide = (key: string, width: number, height: number): void => {
    if (!(width > height)) return;
    setWideLayerKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };
  const canShowCreatorVideo =
    !!targetVideoUrl && isCreatorSpeakingClip(shot.clip_type);
  const containMode = shot.contain_background_mode ?? 'autofill';
  const showCreatorBehindContain =
    !!targetVideoUrl && placement.fit === 'contain' && containMode === 'show_background';
  const showCreatorInBackgroundRect =
    !!targetVideoUrl && !!backgroundRect && (placement.fit === 'pip' || canShowCreatorVideo);
  const showTargetVideoBase =
    !!targetVideoUrl &&
    !targetVideoFailed &&
    (!foregroundMediaShown || showCreatorBehindContain);
  const suppressEmptyBrollPlaceholder =
    showTargetVideoBase && !foregroundMediaShown;
  const suppressEmptyBackgroundPlaceholder =
    showTargetVideoBase && !showCreatorInBackgroundRect;

  return (
    <div className="reel-mockup" title={`Mockup of how shot ${shot.shot_idx} looks in the reel`}>
      <div className="reel-mockup-phone">
        <div className="reel-mockup-notch" />
        <div
          className="reel-mockup-canvas"
        >
          {showBlurBackdrop && previewImageUrl && (
            <div className="reel-block reel-block-blur" aria-hidden="true">
              {previewKind === 'video' ? (
                <SegmentVideo
                  className="reel-block-blur-media"
                  src={previewImageUrl}
                  shot={shot}
                  mode={previewVideoMode}
                  sourceStartMs={previewPlaybackStartMs}
                  sourceEndMs={previewPlaybackEndMs}
                  onPlaybackMs={reportPlayback}
                  renderTimeMs={renderTimeMs}
                />
              ) : previewKind === 'reelthumb' ? (
                <ReelThumbBlurMedia url={previewImageUrl} />
              ) : (
                <img
                  className="reel-block-blur-media"
                  src={previewImageUrl}
                  alt=""
                />
              )}
            </div>
          )}
          {showTargetVideoBase && !showCreatorBehindContain && (
            <SegmentVideo
              className="reel-block-base-video"
              src={targetVideoUrl}
              shot={shot}
              loopSegment={!reelPlayback}
              onPlaybackMs={foregroundMediaShown ? undefined : reportPlayback}
              renderTimeMs={renderTimeMs}
              onSegmentEnd={foregroundMediaShown ? undefined : onSegmentEnd}
              onError={() => setTargetVideoFailed(true)}
            />
          )}
          {showCreatorBehindContain && targetVideoUrl && (
            <SegmentVideo
              className="reel-block-base-video"
              src={targetVideoUrl}
              shot={shot}
              loopSegment={!reelPlayback}
              onPlaybackMs={reportPlayback}
              renderTimeMs={renderTimeMs}
              onSegmentEnd={onSegmentEnd}
              onError={() => setTargetVideoFailed(true)}
            />
          )}
          {backgroundRect && !suppressEmptyBackgroundPlaceholder && (
            <div
              ref={origVideoRef}
              className={`reel-block reel-block-bg${origAnimClass ? ' ' + origAnimClass : ''}`}
              style={
                {
                  ...backgroundRect,
                  '--original-position': originalPosition,
                  '--anim-intensity': origAnimIntensity,
                  '--anim-start-zoom': origMediaStartZoom,
                  '--anim-duration': `${origAnimDurationMs}ms`,
                  '--anim-ease': origAnimEasing,
                  ...origStartZoomStyle,
                  ...scrubStyle,
                } as React.CSSProperties
              }
            >
              {showCreatorInBackgroundRect && targetVideoUrl ? (
                <SegmentVideo
                  className="reel-block-img reel-block-img-cover"
                  src={targetVideoUrl}
                  shot={shot}
                  loopSegment={!reelPlayback}
                  onPlaybackMs={reportPlayback}
                  renderTimeMs={renderTimeMs}
                  onSegmentEnd={onSegmentEnd}
                  onError={() => setTargetVideoFailed(true)}
                />
              ) : backgroundLabel ? (
                <span className="reel-block-label">{backgroundLabel}</span>
              ) : (
                <span className="reel-block-empty" aria-hidden="true" />
              )}
            </div>
          )}
          {showSplitContainBlur && brollRect && previewImageUrl && (
            <div
              className="reel-block reel-block-split-blur"
              style={brollRect as React.CSSProperties}
              aria-hidden="true"
            >
              {previewKind === 'video' ? (
                <SegmentVideo
                  className="reel-block-blur-media"
                  src={previewImageUrl}
                  shot={shot}
                  mode={previewVideoMode}
                  sourceStartMs={previewPlaybackStartMs}
                  sourceEndMs={previewPlaybackEndMs}
                  onPlaybackMs={reportPlayback}
                  renderTimeMs={renderTimeMs}
                />
              ) : previewKind === 'reelthumb' ? (
                <ReelThumbBlurMedia url={previewImageUrl} />
              ) : (
                <img
                  className="reel-block-blur-media"
                  src={previewImageUrl}
                  alt=""
                />
              )}
            </div>
          )}
          {brollRect && !suppressEmptyBrollPlaceholder && (
            <div
              ref={brollRef}
              className={`reel-block reel-block-broll${placement.fit === 'contain' ? ' reel-block-broll-contain' : placement.fit === 'fill' ? ' reel-block-broll-fill' : placement.fit.startsWith('split') ? ' reel-block-broll-split' : ''}${placement.fit.startsWith('split') && (shot.split_media_fit ?? 'fill') === 'contain' ? ' reel-block-broll-split-contain' : ''}${mediaShown || layeredMediaShown ? ' reel-block-broll-media' : ''}${layeredMediaShown ? ' reel-block-broll-overlay-stack' : ''}${!layeredMediaShown && animClass ? ' ' + animClass : ''}`}
              style={
                {
                  ...brollRect,
                  '--anim-intensity': animIntensity,
                  '--anim-start-zoom': mediaStartZoom,
                  '--anim-duration': `${animDurationMs}ms`,
                  '--anim-ease': animEasing,
                  '--media-zoom': mediaZoom,
                  '--media-zoom-origin': mediaZoomOrigin,
                  '--media-position': mediaPosition,
                  '--overlay-parent-scale': placement.scale || 0.42,
                  ...startZoomStyle,
                  ...scrubStyle,
                } as React.CSSProperties
              }
            >
              {layeredMediaShown ? (
                visibleLayeredPreviewMedia.map((layer, i) => (
                  <div
                    key={`${layer.src}-${i}`}
                    className={`reel-overlay-stack-layer${wideLayerKeys.has(layer.src) ? ' reel-overlay-stack-layer-wide' : ''} ${sceneAnimationClass(layer.shot.scene_animation)}`}
                    style={
                      {
                        '--layer-index': i,
                        '--layer-count': layeredPreviewMedia.length,
                        '--anim-intensity': layer.shot.animation_scale ?? 1,
                        '--anim-start-zoom': layer.shot.media_start_zoom ?? 1,
                        '--anim-duration': `${layer.shot.animation_duration_ms ?? layer.shot.duration_ms}ms`,
                        '--anim-ease': layer.shot.animation_easing ?? 'ease-in-out',
                        '--media-zoom': layer.shot.zoom_scale ?? 1,
                        '--media-zoom-origin': pointOrigin(
                          layer.shot.zoom_x,
                          layer.shot.zoom_y,
                          layer.shot.zoom_region ?? layer.shot.animation_origin ?? 'middle_center',
                        ),
                        '--media-position': frameRegionOrigin(layer.shot.placement.position ?? 'middle_center'),
                        zIndex: 2 + i,
                        ...scrubStyle,
                      } as React.CSSProperties
                    }
                    title={layer.label}
                  >
                    {layer.kind === 'video' ? (
                      <SegmentVideo
                        className="reel-block-img"
                        src={layer.src}
                        shot={layer.shot}
                        mode="full"
                        sourceStartMs={layer.playbackStartMs}
                        sourceEndMs={layer.playbackEndMs}
                        onPlaybackMs={reportPlayback}
                        renderTimeMs={renderTimeMs}
                        onMetadata={(w, h) => markLayerWide(layer.src, w, h)}
                      />
                    ) : layer.kind === 'embed' ? (
                      <iframe
                        className="reel-block-img"
                        src={layer.src}
                        title={layer.label}
                        allow="autoplay; encrypted-media; picture-in-picture"
                        allowFullScreen
                      />
                    ) : layer.kind === 'reelthumb' ? (
                      <ReelThumb url={layer.src} size="md" />
                    ) : (
                      <img
                        className="reel-block-img"
                        src={layer.src}
                        alt={layer.label}
                        loading="lazy"
                        onLoad={(e) =>
                          markLayerWide(
                            layer.src,
                            e.currentTarget.naturalWidth,
                            e.currentTarget.naturalHeight,
                          )
                        }
                      />
                    )}
                  </div>
                ))
              ) : mediaShown ? (
                previewKind === 'video' ? (
                  <SegmentVideo
                    className="reel-block-img"
                    src={previewImageUrl}
                    shot={shot}
                    mode={previewVideoMode}
                    sourceStartMs={previewPlaybackStartMs}
                    sourceEndMs={previewPlaybackEndMs}
                    onPlaybackMs={reportPlayback}
                    renderTimeMs={renderTimeMs}
                    onError={() => setVideoFailed(true)}
                  />
                ) : previewKind === 'embed' ? (
                  <iframe
                    className="reel-block-img"
                    src={previewImageUrl}
                    title={brollLabel}
                    allow="autoplay; encrypted-media; picture-in-picture"
                    allowFullScreen
                  />
                ) : previewKind === 'reelthumb' ? (
                  <ReelThumb url={previewImageUrl} size="md" />
                ) : (
                  <img
                    className="reel-block-img"
                    src={previewImageUrl}
                    alt={brollLabel}
                    loading="lazy"
                    onError={() => setImgFailed(true)}
                  />
                )
              ) : (
                <span className="reel-block-label">{brollLabel}</span>
              )}
            </div>
          )}
          {captionText && (
            <div
              className={`reel-text-overlay${applySpec ? ' reel-subtitle-overlay' : ''}`}
              style={{ ...overlayPosCss, ...(capStyle ?? {}) }}
            >
              {captionText}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OptionCard({
  opt,
  label,
  primary,
  selected,
  onSelect,
}: {
  opt: ShotOption;
  label: string;
  primary?: boolean;
  /** True when this is the concept the user has picked for the shot. */
  selected?: boolean;
  /** When provided, the card becomes a selectable radio for picking the
   *  shot's concept. Omitting it renders a plain, non-interactive card. */
  onSelect?: () => void;
}): React.JSX.Element {
  const selectable = !!onSelect;
  const classes = [
    'opt-card',
    primary ? 'opt-card-primary' : '',
    selectable ? 'opt-card-selectable' : '',
    selected ? 'opt-card-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      role={selectable ? 'radio' : undefined}
      aria-checked={selectable ? selected : undefined}
      tabIndex={selectable ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={
        selectable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
    >
      <div className="opt-card-head">
        <span className="opt-card-label">{primary ? 'VISUAL IDEA' : label}</span>
        <span className={`tier-chip tier-${opt.tier}`}>{opt.tier}</span>
        <span className="opt-clip-chip">
          <PlayGlyph />
          Video clip
        </span>
      </div>
      <div className="opt-card-body">
        <div className="opt-broll">{opt.broll_description}</div>
        {opt.rationale && <div className="opt-rationale">{opt.rationale}</div>}
        <OptionScores
          tier={opt.tier}
          fit={opt.fit_score}
          likelihood={opt.likelihood}
        />
      </div>
    </div>
  );
}

function OptionScores({
  tier,
  fit,
  likelihood,
}: {
  tier: ShotOptionTier;
  fit: number;
  likelihood: number | null;
}): React.JSX.Element {
  const fitPct = Math.round(fit * 100);
  const likPct = likelihood !== null ? Math.round(likelihood * 100) : null;
  return (
    <div className="score-block">
      <div className={`tier-chip tier-${tier}`}>{tier}</div>
      <div className="score-bar-row">
        <span className="score-label">fit</span>
        <div className="score-bar">
          <div
            className="score-bar-fill score-bar-fit"
            style={{ width: `${fitPct}%` }}
          />
        </div>
        <span className="score-num">{fitPct}%</span>
      </div>
      <div className="score-bar-row">
        <span className="score-label">get</span>
        {likPct !== null ? (
          <>
            <div className="score-bar">
              <div
                className="score-bar-fill score-bar-likelihood"
                style={{ width: `${likPct}%` }}
              />
            </div>
            <span className="score-num">{likPct}%</span>
          </>
        ) : (
          <span
            className="score-na"
            title="Not from web search — depends on user footage or shoot"
          >
            n/a
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================
//  ShotIdeas — the selected shot's concept(s) as compact one-line
//  rows (under the timeline). Space-saving alternative to the tall
//  OptionCard; scores render as small circular rings, not bars.
// ============================================================

/** A small circular progress ring (donut) for a 0–100 score. `pct` null
 *  renders an empty ring labelled n/a. */
function ScoreCircle({
  label,
  pct,
  kind,
}: {
  label: string;
  pct: number | null;
  kind: 'fit' | 'get';
}): React.JSX.Element {
  const deg = (pct ?? 0) * 3.6;
  const color = kind === 'fit' ? 'var(--accent)' : 'var(--ai)';
  return (
    <span
      className="score-circle"
      title={`${label}: ${pct === null ? 'n/a' : `${pct}%`}`}
    >
      <span
        className="score-circle-ring"
        style={{
          background:
            pct === null
              ? 'conic-gradient(var(--bg-3) 0deg 360deg)'
              : `conic-gradient(${color} ${deg}deg, var(--bg-3) ${deg}deg)`,
        }}
      >
        <span className="score-circle-val">{pct === null ? 'n/a' : pct}</span>
      </span>
      <span className="score-circle-label">{label}</span>
    </span>
  );
}

/** One idea rendered as a single horizontal, selectable row. */
function ShotIdeaLine({
  opt,
  label,
  primary,
  selected,
  onSelect,
}: {
  opt: ShotOption;
  label: string;
  primary?: boolean;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const classes = [
    'idea-line',
    primary ? 'idea-line-primary' : '',
    selected ? 'idea-line-on' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      title={opt.broll_description}
    >
      <span className="idea-line-label">
        {primary ? 'VISUAL IDEA' : label}
      </span>
      <span className={`tier-chip tier-${opt.tier}`}>{opt.tier}</span>
      <span className="idea-line-desc">{opt.broll_description}</span>
      <span className="idea-line-scores">
        <ScoreCircle label="fit" pct={Math.round(opt.fit_score * 100)} kind="fit" />
        <ScoreCircle
          label="get"
          pct={opt.likelihood !== null ? Math.round(opt.likelihood * 100) : null}
          kind="get"
        />
      </span>
    </div>
  );
}

function ShotIdeas({
  shot,
  selectedOptionIdx,
  onSelectOption,
}: {
  shot: ShotPlan;
  selectedOptionIdx: number;
  onSelectOption: (shotIdx: number, optionIdx: number) => void;
}): React.JSX.Element {
  const [fallbackOpen, setFallbackOpen] = useState(false);
  // Pair each option with its original index so selection survives the
  // ideal/fallback split. The primary slot (index 0) is always shown.
  const withIdx = shot.options.map((opt, idx) => ({ opt, idx }));
  const ideaList = withIdx.filter(
    ({ opt, idx }) => idx === 0 || opt.tier === 'ideal',
  );
  const fallbackList = withIdx.filter(
    ({ opt, idx }) => idx !== 0 && opt.tier !== 'ideal',
  );
  return (
    <div className="shot-ideas" role="radiogroup">
      {ideaList.map(({ opt, idx }, i) => (
        <ShotIdeaLine
          key={idx}
          opt={opt}
          label={`idea ${i + 1}`}
          primary={idx === 0}
          selected={selectedOptionIdx === idx}
          onSelect={() => onSelectOption(shot.shot_idx, idx)}
        />
      ))}
      {fallbackList.length > 0 && (
        <>
          <button
            className="ladder-toggle"
            onClick={() => setFallbackOpen((v) => !v)}
          >
            {fallbackOpen ? '▾' : '▸'} {fallbackList.length} fallback option
            {fallbackList.length === 1 ? '' : 's'}
          </button>
          {fallbackOpen &&
            fallbackList.map(({ opt, idx }) => (
              <ShotIdeaLine
                key={idx}
                opt={opt}
                label={opt.tier}
                selected={selectedOptionIdx === idx}
                onSelect={() => onSelectOption(shot.shot_idx, idx)}
              />
            ))}
        </>
      )}
    </div>
  );
}

// ============================================================
//  Curation view
// ============================================================

function ShotCurationRow({
  shotIdx,
  curation,
  shot,
  trace,
  onCurateShot,
  onRegenerate,
  onContinue,
  onAddClip,
  hideCandidates = false,
  onToggleMedia,
  nested = false,
}: {
  shotIdx: number;
  curation: ShotCuration | null;
  shot: ShotPlan | undefined;
  trace?: AgentTrace;
  onCurateShot: (shotIdx: number, userPrompt?: string) => Promise<void>;
  onRegenerate: (shotIdx: number, userPrompt: string) => Promise<void>;
  onContinue: (shotIdx: number, userPrompt: string) => Promise<void>;
  onAddClip?: (shotIdx: number, description: string) => Promise<AddClipResult>;
  hideCandidates?: boolean;
  onToggleMedia?: (media: SelectedMedia | null) => void;
  nested?: boolean;
}): React.JSX.Element {
  const [traceOpen, setTraceOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [regenBusy, setRegenBusy] = useState(false);
  // Add-clip panel — describe a specific extra clip to research and
  // append to this shot's candidates.
  const [addOpen, setAddOpen] = useState(false);
  const [addPrompt, setAddPrompt] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  // Result banner shown after a run finishes, so the user always knows
  // whether a clip actually landed in the library.
  const [addResult, setAddResult] = useState<{
    kind: 'added' | 'duplicate' | 'none';
    count: number;
  } | null>(null);
  const submitAddClip = async (): Promise<void> => {
    const description = addPrompt.trim();
    if (!description || !onAddClip) return;
    setAddBusy(true);
    setAddResult(null);
    try {
      const res = await onAddClip(shotIdx, description);
      if (!res.ok) return; // error already surfaced in the global banner
      if (res.added > 0) {
        setAddResult({ kind: 'added', count: res.added });
        setAddPrompt('');
      } else if (res.foundButDuplicate) {
        setAddResult({ kind: 'duplicate', count: 0 });
      } else {
        setAddResult({ kind: 'none', count: 0 });
      }
    } finally {
      setAddBusy(false);
    }
  };
  // Edit-result panel — only available after at least one curation
  // has happened (otherwise there's no session to continue from).
  const [editOpen, setEditOpen] = useState(false);
  const [editPrompt, setEditPrompt] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const submitRegen = async (): Promise<void> => {
    const prompt = regenPrompt.trim();
    if (!prompt) return;
    setRegenBusy(true);
    try {
      if (curation) {
        await onRegenerate(shotIdx, prompt);
      } else {
        // No prior curation — first-time curate with the prompt as
        // initial guidance.
        await onCurateShot(shotIdx, prompt);
      }
      setRegenOpen(false);
      setRegenPrompt('');
    } finally {
      setRegenBusy(false);
    }
  };
  const submitEdit = async (): Promise<void> => {
    const prompt = editPrompt.trim();
    if (!prompt) return;
    setEditBusy(true);
    try {
      await onContinue(shotIdx, prompt);
      setEditOpen(false);
      setEditPrompt('');
    } finally {
      setEditBusy(false);
    }
  };
  const rewritten = curation?.rewritten_shot ?? null;
  // When the curator auto-rewrote the shot, prefer the rewritten
  // broll_description over the original (the candidates target the new
  // idea, not the failed one).
  const displayedBroll =
    rewritten?.broll_description ?? shot?.broll_description ?? '';
  const notCurated = !curation || curation.candidates.length === 0;
  return (
    <div className={nested ? 'shot-curation shot-curation-nested' : 'shot-curation'}>
      <div className="shot-curation-head">
        {!nested && (
          <span className="shot-idx-plan">
            {String(shotIdx).padStart(2, '0')}
          </span>
        )}
        {!nested && displayedBroll && (
          <span className="shot-broll-short">
            {displayedBroll.slice(0, 80)}
            {displayedBroll.length > 80 ? '…' : ''}
          </span>
        )}
        {rewritten && (
          <span
            className="shot-rewritten-pill"
            title="Original idea failed curation; this is an auto-rewritten replacement"
          >
            auto-rewritten
          </span>
        )}
        <span className="cand-count">
          {curation?.library_fulfilled
            ? 'uses your footage'
            : notCurated
              ? 'not curated yet'
              : `${curation!.candidates.length} candidate(s)`}
        </span>
        {trace && (
          <button
            className="btn btn-mini"
            onClick={() => setTraceOpen((v) => !v)}
            title={`${trace.turns.length} turn(s) · ${trace.tokens.total.toLocaleString()} tokens · ${trace.reason}`}
          >
            {traceOpen ? '▾ trace' : '▸ trace'}
          </button>
        )}
        {!notCurated && (
          <button
            className="btn btn-mini btn-edit-result"
            onClick={() => setEditOpen((v) => !v)}
            disabled={editBusy}
            title="Tweak this result — continues the same agent session instead of starting over (cheaper + faster)"
          >
            {editBusy ? 'Editing…' : '↪ edit result'}
          </button>
        )}
        {onAddClip && (
          <button
            className={`btn btn-mini${addBusy ? ' btn-curating' : ''}`}
            onClick={() => setAddOpen((v) => !v)}
            disabled={addBusy}
            title="Describe a specific clip you want — the curator finds it and adds it to this shot's candidates"
          >
            {addBusy && (
              <span className="agent-status-spinner" aria-hidden="true" />
            )}
            {addBusy ? 'Adding clip…' : '＋ add clip'}
          </button>
        )}
      </div>
      {addOpen && onAddClip && (
        <div
          className={`regen-panel add-clip-panel${addBusy ? ' add-clip-panel-running' : ''}`}
        >
          <label className="regen-label" htmlFor={`addclip-${shotIdx}`}>
            Describe the clip you want to add
          </label>
          <textarea
            id={`addclip-${shotIdx}`}
            className="regen-textarea"
            rows={2}
            placeholder='e.g. "a close-up of the product packaging", "the founder speaking at a conference", "a Wikipedia photo of the Golden Gate Bridge"'
            value={addPrompt}
            onChange={(e) => {
              setAddPrompt(e.target.value);
              if (addResult) setAddResult(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                submitAddClip();
              }
            }}
            disabled={addBusy}
            autoFocus
          />
          {/* Prominent running / done status so it's never ambiguous
              whether the agent is working or finished. */}
          {addBusy ? (
            <div className="add-clip-status add-clip-status-running">
              <span className="agent-status-spinner" aria-hidden="true" />
              Researching &amp; capturing your clip… this can take a bit.
            </div>
          ) : addResult ? (
            <div
              className={`add-clip-status ${
                addResult.kind === 'added'
                  ? 'add-clip-status-done'
                  : 'add-clip-status-warn'
              }`}
            >
              {addResult.kind === 'added' ? (
                <>
                  <span className="agent-status-check" aria-hidden="true">
                    ✓
                  </span>
                  Added {addResult.count} clip{addResult.count === 1 ? '' : 's'}{' '}
                  to the library below.
                </>
              ) : addResult.kind === 'duplicate' ? (
                <>That clip was already in your library — nothing new to add.</>
              ) : (
                <>
                  Couldn&apos;t find that clip. Try a more specific
                  description (a name, place, or source).
                </>
              )}
            </div>
          ) : null}
          <div className="regen-actions">
            <button
              className="btn btn-mini"
              onClick={submitAddClip}
              disabled={addBusy || addPrompt.trim().length === 0}
              title="Researches your described clip and appends it to this shot's existing candidates"
            >
              {addBusy ? 'Adding…' : 'Add clip'}
            </button>
            <button
              className="btn btn-mini btn-ghost"
              onClick={() => {
                setAddOpen(false);
                setAddPrompt('');
                setAddResult(null);
              }}
              disabled={addBusy}
            >
              {addResult?.kind === 'added' ? 'Done' : 'Cancel'}
            </button>
          </div>
        </div>
      )}
      {regenOpen && (
        <div className="regen-panel">
          <label className="regen-label" htmlFor={`regen-${shotIdx}`}>
            What should this shot show instead?
          </label>
          <textarea
            id={`regen-${shotIdx}`}
            className="regen-textarea"
            rows={2}
            placeholder='e.g. "use a Wikipedia photo of the founder, not the company homepage"'
            value={regenPrompt}
            onChange={(e) => setRegenPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                submitRegen();
              }
            }}
            disabled={regenBusy}
            autoFocus
          />
          <div className="regen-actions">
            <button
              className="btn btn-mini"
              onClick={submitRegen}
              disabled={regenBusy || regenPrompt.trim().length === 0}
            >
              {regenBusy ? 'Regenerating…' : 'Regenerate'}
            </button>
            <button
              className="btn btn-mini btn-ghost"
              onClick={() => {
                setRegenOpen(false);
                setRegenPrompt('');
              }}
              disabled={regenBusy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {editOpen && (
        <div className="regen-panel edit-panel">
          <label className="regen-label" htmlFor={`edit-${shotIdx}`}>
            Tweak the result — continues the same agent session
          </label>
          <textarea
            id={`edit-${shotIdx}`}
            className="regen-textarea"
            rows={2}
            placeholder='e.g. "swap candidate 2 for a Crunchbase page instead", "rank the TechCrunch hit first"'
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                submitEdit();
              }
            }}
            disabled={editBusy}
            autoFocus
          />
          <div className="regen-actions">
            <button
              className="btn btn-mini"
              onClick={submitEdit}
              disabled={editBusy || editPrompt.trim().length === 0}
              title="Continues the existing agent conversation — keeps prior tool results in context"
            >
              {editBusy ? 'Editing…' : 'Apply edit'}
            </button>
            <button
              className="btn btn-mini btn-ghost"
              onClick={() => {
                setEditOpen(false);
                setEditPrompt('');
              }}
              disabled={editBusy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {rewritten && shot && (
        <div className="shot-rewrite-note">
          rewrote from: <span className="shot-rewrite-old">"{shot.broll_description}"</span>
        </div>
      )}
      {curation?.research_notes && (
        <div className="research-notes">{curation.research_notes}</div>
      )}
      {curation?.failure_reason && (
        <div className="research-fail">⚠ {curation.failure_reason}</div>
      )}
      {traceOpen && trace && <AgentTraceView trace={trace} />}
      {!hideCandidates && curation && curation.candidates.length > 0 && (
        <div className="candidates">
          {curation.candidates.map((c, i) => (
            <CandidateCard
              key={i}
              candidate={c}
              shot={shot}
              onToggleMedia={onToggleMedia}
            />
          ))}
        </div>
      )}
      {!hideCandidates && curation?.alternatives && curation.alternatives.length > 0 && (
        <AlternativesView
          alternatives={curation.alternatives}
          shot={shot}
          onToggleMedia={onToggleMedia}
        />
      )}
    </div>
  );
}

function AlternativesView({
  alternatives,
  shot,
  onToggleMedia,
}: {
  alternatives: AlternativeShot[];
  shot: ShotPlan | undefined;
  onToggleMedia?: (media: SelectedMedia | null) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const totalCandidates = alternatives.reduce(
    (n, a) => n + a.candidates.length,
    0,
  );
  return (
    <div className="alt-block">
      <button
        className="alt-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} {alternatives.length} alternative shot
        {alternatives.length === 1 ? '' : 's'} ({totalCandidates} candidate{totalCandidates === 1 ? '' : 's'})
      </button>
      {open &&
        alternatives.map((alt, i) => (
          <div key={i} className="alt-shot">
            <div className="alt-shot-head">
              <span className="alt-label">ALT {i + 1}</span>
              <span className="alt-desc">{alt.broll_description}</span>
            </div>
            {alt.rationale && (
              <div className="alt-rationale">{alt.rationale}</div>
            )}
            <div className="candidates">
              {alt.candidates.map((c, j) => (
                <CandidateCard
                  key={j}
                  candidate={c}
                  shot={shot}
                  brollOverride={alt.broll_description}
                  onToggleMedia={onToggleMedia}
                />
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

function SharedMediaLibrary({
  items,
  shot,
  onRegenerateMedia,
  onToggleMedia,
}: {
  items: LibraryCandidate[];
  shot: ShotPlan;
  onRegenerateMedia: (shotIdx: number, userPrompt?: string) => Promise<void>;
  onToggleMedia: (media: SelectedMedia | null) => void;
}): React.JSX.Element {
  return (
    <div className="shared-library">
      <div className="shared-library-head">
        <span className="shared-library-title">Library</span>
        <span className="shared-library-sub">
          {items.length} unique item{items.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="candidates shared-library-grid">
        {items.map((item) => (
          <div
            className="shared-library-item"
            key={`${item.sourceShotIdx}-${mediaKey(item.candidate.auto_recording_url || item.candidate.url)}`}
          >
            <span className="shared-library-origin">{item.sourceLabel}</span>
            <CandidateCard
              candidate={item.candidate}
              shot={shot}
              brollOverride={item.brollOverride}
              onToggleMedia={onToggleMedia}
              onRegenerateMedia={
                // Pasted media (sourceShotIdx < 0) has no shot to
                // regenerate against — hide the regenerate affordance.
                item.sourceShotIdx < 0
                  ? undefined
                  : (prompt) => onRegenerateMedia(item.sourceShotIdx, prompt)
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentTraceView({ trace }: { trace: AgentTrace }): React.JSX.Element {
  return (
    <div className="agent-trace">
      <div className="trace-meta">
        {trace.turns.length} turn{trace.turns.length === 1 ? '' : 's'} ·{' '}
        finished at turn {trace.finished_at_turn} · {trace.reason} ·{' '}
        {trace.tokens.total.toLocaleString()} tokens
      </div>
      {trace.turns.map((turn) => (
        <TraceTurnView key={turn.turn_idx} turn={turn} />
      ))}
      {trace.final_text && (
        <details className="trace-final">
          <summary>final json ({trace.final_text.length} chars)</summary>
          <pre>{trace.final_text}</pre>
        </details>
      )}
    </div>
  );
}

function TraceTurnView({ turn }: { turn: AgentTurn }): React.JSX.Element {
  return (
    <div className="trace-turn">
      <div className="trace-turn-head">turn {turn.turn_idx}</div>
      {turn.message_text && (
        <div className="trace-message">
          <span className="trace-label">say</span>
          <pre>{turn.message_text}</pre>
        </div>
      )}
      {turn.web_search_calls > 0 && (
        <div className="trace-tool">
          <span className="trace-label">web_search</span>
          <span className="trace-tool-summary">
            {turn.web_search_calls} call{turn.web_search_calls === 1 ? '' : 's'}{' '}
            (queries handled by OpenAI)
          </span>
        </div>
      )}
      {turn.function_calls.map((fc, i) => (
        <TraceFunctionCallView key={i} call={fc} />
      ))}
    </div>
  );
}

function TraceFunctionCallView({
  call,
}: {
  call: AgentTurn['function_calls'][number];
}): React.JSX.Element {
  return (
    <div className="trace-tool">
      <div className="trace-tool-head">
        <span className="trace-label">{call.name}</span>
      </div>
      <details className="trace-tool-args">
        <summary>args</summary>
        <pre>{prettyJson(call.arguments)}</pre>
      </details>
      <details className="trace-tool-result">
        <summary>result ({call.result.length} chars)</summary>
        <pre>{prettyJson(call.result)}</pre>
      </details>
    </div>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function videoEmbedUrl(url: string): string | null {
  const ytWatch = url.match(/(?:youtube\.com\/watch\?[^"]*v=|youtu\.be\/)([\w-]{6,})/);
  if (ytWatch) return `https://www.youtube.com/embed/${ytWatch[1]}`;
  const ytShorts = url.match(/youtube\.com\/shorts\/([\w-]{6,})/);
  if (ytShorts) return `https://www.youtube.com/embed/${ytShorts[1]}`;
  const ytEmbed = url.match(/youtube\.com\/embed\/([\w-]{6,})/);
  if (ytEmbed) return `https://www.youtube.com/embed/${ytEmbed[1]}`;
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return null;
}

/** How the phone preview should render its source URL. */
export type PreviewKind = 'image' | 'video' | 'embed' | 'reelthumb';

function isDirectVideoFile(url: string): boolean {
  return /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(url);
}

/** Can this URL be dropped straight into a <video src=> and actually
 *  decode? Local schemes we serve ourselves (capture://, clips://,
 *  file://, blob:, data:) always can; remote URLs only if they point at
 *  a real video file. Platform/page/embed URLs (a YouTube watch page, an
 *  IG permalink, a marketing page) return false — feeding those to a
 *  <video> just renders Chromium's broken-media glyph. */
function isPlayableVideoUrl(url: string): boolean {
  return /^(capture|clips|local-video|file|blob|data):/i.test(url) || isDirectVideoFile(url);
}

function SelectedMediaPreview({
  media,
}: {
  media: SelectedMedia;
}): React.JSX.Element {
  if (media.kind === 'image') {
    return (
      <span className="shot-selected-media-preview">
        <img src={media.url} alt="" loading="lazy" draggable={false} />
      </span>
    );
  }

  if (isPlayableVideoUrl(media.url)) {
    return (
      <span className="shot-selected-media-preview">
        <video
          src={media.url}
          muted
          playsInline
          preload="metadata"
          draggable={false}
        />
      </span>
    );
  }

  return (
    <span className="shot-selected-media-preview">
      <ReelThumb url={media.from_candidate_url || media.url} size="sm" />
    </span>
  );
}

function CandidateCard({
  candidate,
  shot,
  brollOverride,
  onToggleMedia,
  onRegenerateMedia,
}: {
  candidate: MediaCandidate;
  shot?: ShotPlan;
  brollOverride?: string;
  onToggleMedia?: (media: SelectedMedia | null) => void;
  onRegenerateMedia?: (userPrompt?: string) => Promise<void>;
}): React.JSX.Element {
  const devtools = React.useContext(DevtoolsContext);
  const isImage =
    candidate.source === 'web_image' || candidate.source === 'generated_image';
  const isVideo = candidate.source === 'web_video';
  const embed = isVideo ? videoEmbedUrl(candidate.url) : null;
  const direct = isVideo && !embed && isDirectVideoFile(candidate.url);
  const thumb = candidate.thumbnail_url || candidate.url;

  // Multi-select model: shot.selected_media is an ordered array. A
  // piece of media is "selected" when its URL appears in the list;
  // its position in the list is the playback order (1-indexed).
  const selections = getSelections(shot);
  const indexOf = (url: string): number =>
    selections.findIndex((s) => s.url === url);
  const candidateIndex = indexOf(candidate.url);
  const candidateSelected = candidateIndex >= 0;
  const primaryMediaUrl =
    candidate.auto_recording_url ||
    candidate.auto_screenshots?.[0]?.image_url ||
    candidate.url;
  const primaryKind: SelectedMedia['kind'] =
    candidate.auto_screenshots?.[0]?.image_url && !candidate.auto_recording_url
      ? 'image'
      : isImage
        ? 'image'
        : 'video';
  const primaryIndex = indexOf(primaryMediaUrl);
  const primarySelected = primaryIndex >= 0 || candidateSelected;
  const toggleCandidate = (): void => {
    if (!onToggleMedia) return;
    onToggleMedia({
      url: primaryMediaUrl,
      kind: primaryKind,
      origin: 'original_candidate',
      from_candidate_url: candidate.url,
      reason: candidate.notes ?? null,
    });
  };

  const isWebPage = candidate.source === 'web_page';
  const canRecord = isWebPage && !!shot;

  // Extract-clips state. Only meaningful for web_video candidates with
  // a shot context; the button is hidden otherwise.
  const canExtract = isVideo && !!shot;
  const [clips, setClips] = useState<ExtractedClip[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractFromCache, setExtractFromCache] = useState(false);
  // Live progress log — one entry per stage event from the backend.
  // Kept across re-extractions so the user can compare runs; cleared on
  // a fresh click. The active request_id filters events from other
  // simultaneous extractions (multiple cards in the same shot).
  const [progressLog, setProgressLog] = useState<ExtractProgressEvent[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(true);

  useEffect(() => {
    if (!activeRequestId) return;
    // Guard for stale preload — if onExtractClipsProgress hasn't been
    // exposed yet (renderer-only reload without dev-server restart),
    // skip the subscription rather than crash.
    if (typeof window.api?.onExtractClipsProgress !== 'function') return;
    const unsub = window.api.onExtractClipsProgress(({ request_id, event }) => {
      if (request_id !== activeRequestId) return;
      setProgressLog((prev) => [...prev, event]);
    });
    return () => unsub();
  }, [activeRequestId]);

  const runExtract = async (): Promise<void> => {
    if (!shot) return;
    if (typeof window.api?.extractClips !== 'function') {
      setExtractError(
        'extractClips not available — restart the dev server so the new preload bundle loads.',
      );
      return;
    }
    const request_id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setExtracting(true);
    setExtractError(null);
    setProgressLog([]);
    setActiveRequestId(request_id);
    try {
      const res = (await window.api.extractClips({
        request_id,
        candidate_url: candidate.url,
        source_page: candidate.source_page ?? null,
        shot_idx: shot.shot_idx,
        broll_description: brollOverride ?? shot.broll_description ?? '',
        spoken_during: shot.spoken_during ?? '',
        shot_duration_ms: shot.end_ms - shot.start_ms,
        // Re-extract button (clips already exist) forces a fresh
        // pipeline pass — the user wants new output, not the cache.
        force: clips !== null,
      })) as ExtractClipsResponse;
      if (res.ok) {
        setClips(res.clips);
        setExtractFromCache(res.from_cache);
      } else {
        setExtractError(`${res.stage}: ${res.error}`);
      }
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : String(e));
    } finally {
      setExtracting(false);
      setActiveRequestId(null);
    }
  };

  // Video-screenshots state. Mirrors extract-clips but produces still
  // PNGs from the source mp4 instead of mp4 slices. Only enabled for
  // web_video candidates with a shot context.
  const [frames, setFrames] = useState<VideoFrame[] | null>(null);
  const [framing, setFraming] = useState(false);
  const [framesError, setFramesError] = useState<string | null>(null);
  const [framesLog, setFramesLog] = useState<VideoFrameProgressEvent[]>([]);
  const [activeFramesId, setActiveFramesId] = useState<string | null>(null);
  const [framesLogOpen, setFramesLogOpen] = useState(true);
  const [regeneratingMedia, setRegeneratingMedia] = useState(false);
  const [mediaRegenOpen, setMediaRegenOpen] = useState(false);
  const [mediaRegenText, setMediaRegenText] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (!activeFramesId) return;
    if (typeof window.api?.onVideoScreenshotsProgress !== 'function') return;
    const unsub = window.api.onVideoScreenshotsProgress(({ request_id, event }) => {
      if (request_id !== activeFramesId) return;
      setFramesLog((prev) => [...prev, event]);
    });
    return () => unsub();
  }, [activeFramesId]);

  const runVideoScreenshots = async (): Promise<void> => {
    if (!shot) return;
    if (typeof window.api?.videoScreenshots !== 'function') {
      setFramesError(
        'videoScreenshots not available — restart the dev server so the new preload bundle loads.',
      );
      return;
    }
    const request_id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setFraming(true);
    setFramesError(null);
    setFrames(null);
    setFramesLog([]);
    setActiveFramesId(request_id);
    try {
      const res = (await window.api.videoScreenshots({
        request_id,
        candidate_url: candidate.url,
        source_page: candidate.source_page ?? null,
        shot_idx: shot.shot_idx,
        broll_description: brollOverride ?? shot.broll_description ?? '',
        spoken_during: shot.spoken_during ?? '',
        shot_duration_ms: shot.end_ms - shot.start_ms,
        // Re-screenshot button (frames already exist) forces a fresh
        // scene-detect + rank + ffmpeg pass.
        force: frames !== null,
      })) as VideoFramesResponse;
      if (res.ok) {
        setFrames(res.frames);
      } else {
        setFramesError(`${res.stage}: ${res.error}`);
      }
    } catch (e) {
      setFramesError(e instanceof Error ? e.message : String(e));
    } finally {
      setFraming(false);
      setActiveFramesId(null);
    }
  };

  // Record-page state. Only meaningful for web_page candidates with a
  // shot context. The pipeline: fetch_page → LLM plans scroll_segments
  // → recordUrl produces an mp4 served over capture://.
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordResult, setRecordResult] = useState<
    Extract<RecordPageResponse, { ok: true }> | null
  >(() =>
    candidate.auto_recording_url
      ? {
          ok: true,
          recording_url: candidate.auto_recording_url,
          recording_path: '',
          duration_ms: candidate.duration_ms ?? shot?.duration_ms ?? 0,
          page_title: candidate.title ?? null,
          reasoning: candidate.notes ?? 'auto-captured',
          segments: [],
        }
      : null,
  );
  const [recordLog, setRecordLog] = useState<RecordProgressEvent[]>([]);
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [recordLogOpen, setRecordLogOpen] = useState(true);

  useEffect(() => {
    if (!activeRecordId) return;
    if (typeof window.api?.onRecordPageProgress !== 'function') return;
    const unsub = window.api.onRecordPageProgress(({ request_id, event }) => {
      if (request_id !== activeRecordId) return;
      setRecordLog((prev) => [...prev, event]);
    });
    return () => unsub();
  }, [activeRecordId]);

  const runRecord = async (): Promise<void> => {
    if (!shot) return;
    if (typeof window.api?.recordPage !== 'function') {
      setRecordError(
        'recordPage not available — restart the dev server so the new preload bundle loads.',
      );
      return;
    }
    const request_id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setRecording(true);
    setRecordError(null);
    setRecordResult(null);
    setRecordLog([]);
    setActiveRecordId(request_id);
    try {
      const res = (await window.api.recordPage({
        request_id,
        candidate_url: candidate.url,
        shot_idx: shot.shot_idx,
        broll_description: brollOverride ?? shot.broll_description ?? '',
        spoken_during: shot.spoken_during ?? '',
        shot_duration_ms: shot.end_ms - shot.start_ms,
      })) as RecordPageResponse;
      if (res.ok) {
        setRecordResult(res);
        setPreviewOpen(true);
      } else {
        setRecordError(`${res.stage}: ${res.error}`);
      }
    } catch (e) {
      setRecordError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecording(false);
      setActiveRecordId(null);
    }
  };

  // Screenshot-page state. Same surface as record-page but produces a
  // single PNG instead of a scrolling mp4 — used for static / one-
  // screen pages where a recording would add nothing.
  const [screenshotting, setScreenshotting] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [screenshotResult, setScreenshotResult] = useState<
    Extract<ScreenshotPageResponse, { ok: true }> | null
  >(() =>
    candidate.auto_screenshots?.length
      ? {
          ok: true,
          page_title: candidate.title ?? null,
          screenshots: candidate.auto_screenshots.map((s, i) => ({
            screenshot_id: `${mediaKey(s.image_url)}-${i}`,
            region_id: i,
            reason: candidate.notes ?? 'auto-captured',
            preview: candidate.title ?? candidate.url,
            kind: 'image',
            image_url: s.image_url,
            image_path: s.image_path ?? '',
            width: 0,
            height: 0,
          })),
        }
      : null,
  );
  const [screenshotLog, setScreenshotLog] = useState<ScreenshotProgressEvent[]>(
    [],
  );
  const [activeScreenshotId, setActiveScreenshotId] = useState<string | null>(
    null,
  );
  const [screenshotLogOpen, setScreenshotLogOpen] = useState(true);

  // Single popup that surfaces every extracted material (clips, frames,
  // recordings, screenshots) for this candidate. Action buttons swap to
  // "View" once a capture is on file — they open this popup instead of
  // re-running. Re-running lives inside the popup as a section regen.
  const [previewOpen, setPreviewOpen] = useState(false);
  const openPreview = (): void => setPreviewOpen(true);

  useEffect(() => {
    if (!activeScreenshotId) return;
    if (typeof window.api?.onScreenshotPageProgress !== 'function') return;
    const unsub = window.api.onScreenshotPageProgress(({ request_id, event }) => {
      if (request_id !== activeScreenshotId) return;
      setScreenshotLog((prev) => [...prev, event]);
    });
    return () => unsub();
  }, [activeScreenshotId]);

  const runScreenshot = async (): Promise<void> => {
    if (!shot) return;
    if (typeof window.api?.screenshotPage !== 'function') {
      setScreenshotError(
        'screenshotPage not available — restart the dev server so the new preload bundle loads.',
      );
      return;
    }
    const request_id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setScreenshotting(true);
    setScreenshotError(null);
    setScreenshotResult(null);
    setScreenshotLog([]);
    setActiveScreenshotId(request_id);
    try {
      const res = (await window.api.screenshotPage({
        request_id,
        candidate_url: candidate.url,
        shot_idx: shot.shot_idx,
        broll_description: brollOverride ?? shot.broll_description ?? '',
      })) as ScreenshotPageResponse;
      if (res.ok) {
        setScreenshotResult(res);
        setPreviewOpen(true);
      } else {
        setScreenshotError(`${res.stage}: ${res.error}`);
      }
    } catch (e) {
      setScreenshotError(e instanceof Error ? e.message : String(e));
    } finally {
      setScreenshotting(false);
      setActiveScreenshotId(null);
    }
  };

  return (
    <div
      className="candidate"
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('button,a,input,textarea,select,video,iframe')) return;
        setDetailsOpen(true);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setDetailsOpen(true);
        }
      }}
    >
      <div className="candidate-thumb">
        {isImage ? (
          <img src={thumb} alt={candidate.title ?? ''} loading="lazy" />
        ) : embed ? (
          <iframe
            src={embed}
            title={candidate.title ?? 'video'}
            allow="autoplay; clipboard-write; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : direct ? (
          <video
            src={candidate.url}
            poster={candidate.thumbnail_url ?? undefined}
            controls
            preload="metadata"
          />
        ) : candidate.thumbnail_url ? (
          <img
            src={candidate.thumbnail_url}
            alt={candidate.title ?? ''}
            loading="lazy"
          />
        ) : isVideo ? (
          // ig/tiktok/facebook (and any web_video without a curator-
          // provided thumbnail) — ask yt-dlp for the poster frame.
          <ReelThumb url={candidate.url} size="md" />
        ) : (
          <div className="candidate-thumb-placeholder">
            {candidate.source.replace(/_/g, ' ')}
          </div>
        )}
      </div>
      <div className="candidate-body">
        <div className="candidate-source">
          [{candidate.source}]
          {onRegenerateMedia && (
            <button
              type="button"
              className="btn-select btn-regenerate-media"
              onClick={() => setMediaRegenOpen(true)}
              disabled={regeneratingMedia}
              title="Regenerate this media source"
            >
              {regeneratingMedia ? 'Working…' : '↻'}
            </button>
          )}
          {onToggleMedia &&
            (!isWebPage ||
              !!candidate.auto_recording_url ||
              !!candidate.auto_screenshots?.length) && (
            <button
              type="button"
              className={
                primarySelected ? 'btn-select btn-select-on' : 'btn-select'
              }
              onClick={toggleCandidate}
              title={
                primarySelected
                  ? `Pick #${Math.max(primaryIndex, candidateIndex) + 1} — click to remove`
                  : 'Add this item to the shot picks'
              }
            >
              {primarySelected
                ? `✓ #${Math.max(primaryIndex, candidateIndex) + 1}`
                : '+ Use this'}
            </button>
          )}
        </div>
        {candidate.title && <div className="candidate-title">{candidate.title}</div>}
        <a
          className="candidate-url"
          href={candidate.url}
          target="_blank"
          rel="noreferrer"
        >
          {candidate.url}
        </a>
        {candidate.source_page && (
          <div className="candidate-meta">
            via{' '}
            <a href={candidate.source_page} target="_blank" rel="noreferrer">
              {new URL(candidate.source_page).hostname}
            </a>
          </div>
        )}
        {candidate.notes && <div className="candidate-notes">{candidate.notes}</div>}
        {candidate.recommended_segment_ms && (
          <div className="candidate-meta">
            segment: {(candidate.recommended_segment_ms.start_ms / 1000).toFixed(1)}s
            –{' '}
            {(candidate.recommended_segment_ms.end_ms / 1000).toFixed(1)}s
          </div>
        )}
        {canRecord && (
          <div className="candidate-extract">
            <div className="candidate-extract-actions">
              <button
                type="button"
                className={`btn btn-mini ${recordResult ? 'btn-view' : 'btn-extract'}`}
                onClick={recordResult ? openPreview : runRecord}
                disabled={recording}
                title={
                  recordResult
                    ? 'Open the page recording'
                    : 'Record this page as a vertical clip'
                }
              >
                {recording
                  ? 'Recording…'
                  : recordResult
                    ? '▷ View recording'
                    : '● Record page'}
              </button>
              <button
                type="button"
                className={`btn btn-mini ${screenshotResult ? 'btn-view' : 'btn-extract'}`}
                onClick={screenshotResult ? openPreview : runScreenshot}
                disabled={screenshotting}
                title={
                  screenshotResult
                    ? 'Open captured page screenshots'
                    : 'Capture screenshots from this page'
                }
              >
                {screenshotting
                  ? 'Capturing…'
                  : screenshotResult
                    ? `▣ View screenshots (${screenshotResult.screenshots.length})`
                    : '▣ Screenshot page'}
              </button>
            </div>
            {recordError && (
              <div className="candidate-extract-error">⚠ {recordError}</div>
            )}
            {screenshotError && (
              <div className="candidate-extract-error">⚠ {screenshotError}</div>
            )}
          </div>
        )}
        {canExtract && (
          <div className="candidate-extract">
            <div className="candidate-extract-actions">
              <button
                type="button"
                className={`btn btn-mini ${clips ? 'btn-view' : 'btn-extract'}`}
                onClick={clips ? openPreview : runExtract}
                disabled={extracting}
                title={
                  clips
                    ? `Open the ${clips.length} extracted clip${clips.length === 1 ? '' : 's'} in the preview popup`
                    : 'Download the source video, transcribe it, and slice out the parts that match this shot.'
                }
              >
                {extracting
                  ? 'Extracting…'
                  : clips
                    ? `▷ View clips (${clips.length})`
                    : '✂ Extract clips'}
              </button>
            </div>
            {extractError && (
              <div className="candidate-extract-error">⚠ {extractError}</div>
            )}
            {devtools && progressLog.length > 0 && (
              <div className="extract-log">
                <button
                  type="button"
                  className="extract-log-toggle"
                  onClick={() => setLogOpen((v) => !v)}
                >
                  {logOpen ? '▾' : '▸'} thought process ({progressLog.length} step
                  {progressLog.length === 1 ? '' : 's'})
                </button>
                {logOpen && (
                  <ol className="extract-log-list">
                    {progressLog.map((ev, i) => (
                      <ExtractLogEntry key={i} event={ev} />
                    ))}
                  </ol>
                )}
              </div>
            )}
            {framesError && (
              <div className="candidate-extract-error">⚠ {framesError}</div>
            )}
            {devtools && framesLog.length > 0 && (
              <div className="extract-log">
                <button
                  type="button"
                  className="extract-log-toggle"
                  onClick={() => setFramesLogOpen((v) => !v)}
                >
                  {framesLogOpen ? '▾' : '▸'} screenshot thought process (
                  {framesLog.length} step{framesLog.length === 1 ? '' : 's'})
                </button>
                {framesLogOpen && (
                  <ol className="extract-log-list">
                    {framesLog.map((ev, i) => (
                      <VideoFramesLogEntry key={i} event={ev} />
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {previewOpen && (
        <MediaPreviewModal
          candidate={candidate}
          clips={clips}
          frames={frames}
          recordResult={recordResult}
          screenshots={screenshotResult?.screenshots ?? null}
          selections={selections}
          onToggleMedia={onToggleMedia}
          onClose={() => setPreviewOpen(false)}
          regenerate={{
            clips: canExtract
              ? { busy: extracting || framing, run: runExtract, label: '↻ Re-extract clips' }
              : null,
            frames: canExtract
              ? { busy: extracting || framing, run: runVideoScreenshots, label: '↻ Re-screenshot frames' }
              : null,
            recording: canRecord
              ? { busy: recording, run: runRecord, label: '↻ Re-record page' }
              : null,
            screenshots: canRecord
              ? { busy: screenshotting, run: runScreenshot, label: '↻ Re-screenshot page' }
              : null,
          }}
        />
      )}
      {detailsOpen && (
        <CandidateDetailsModal
          candidate={candidate}
          mediaUrl={primaryMediaUrl}
          mediaKind={primaryKind}
          onClose={() => setDetailsOpen(false)}
        />
      )}
      {mediaRegenOpen && onRegenerateMedia && (
        <div className="regen-modal-backdrop" onClick={() => setMediaRegenOpen(false)}>
          <form
            className="regen-modal regen-media-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              setRegeneratingMedia(true);
              setMediaRegenOpen(false);
              void onRegenerateMedia(mediaRegenText.trim() || undefined).finally(
                () => setRegeneratingMedia(false),
              );
              setMediaRegenText('');
            }}
          >
            <div className="regen-modal-head">
              <span className="regen-modal-title">Regenerate media</span>
              <button
                type="button"
                className="preview-modal-close"
                onClick={() => setMediaRegenOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="regen-media-preview">
              {primaryKind === 'image' ? (
                <img src={primaryMediaUrl} alt={candidate.title ?? ''} />
              ) : (
                <video src={primaryMediaUrl} controls preload="metadata" />
              )}
            </div>
            <label className="regen-label" htmlFor={`regen-media-${mediaKey(primaryMediaUrl)}`}>
              What do you want to see instead?
            </label>
            <textarea
              id={`regen-media-${mediaKey(primaryMediaUrl)}`}
              className="regen-textarea"
              rows={4}
              value={mediaRegenText}
              onChange={(e) => setMediaRegenText(e.currentTarget.value)}
              placeholder='e.g. "use an actual product demo screen, not the homepage"'
              autoFocus
            />
            <div className="regen-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setMediaRegenOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-ai" disabled={regeneratingMedia}>
                {regeneratingMedia ? 'Regenerating…' : '↻ Regenerate'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function CandidateDetailsModal({
  candidate,
  mediaUrl,
  mediaKind,
  onClose,
}: {
  candidate: MediaCandidate;
  mediaUrl: string;
  mediaKind: SelectedMedia['kind'];
  onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="preview-modal-backdrop" onClick={onClose}>
      <div
        className="candidate-detail-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-modal-head">
          <div className="preview-modal-head-text">
            <span className="preview-modal-eyebrow">
              {candidate.source.replace(/_/g, ' ')}
            </span>
            <span className="preview-modal-title">
              {candidate.title || mediaUrl}
            </span>
          </div>
          <button
            type="button"
            className="preview-modal-close"
            onClick={onClose}
            aria-label="Close preview"
          >
            ✕
          </button>
        </div>
        <div className="candidate-detail-media">
          {mediaKind === 'image' ? (
            <img src={mediaUrl} alt={candidate.title ?? ''} />
          ) : (
            <video src={mediaUrl} controls autoPlay preload="metadata" />
          )}
        </div>
        <div className="candidate-detail-body">
          {candidate.notes && (
            <p className="candidate-detail-notes">{candidate.notes}</p>
          )}
          <div className="candidate-detail-grid">
            <span>media</span>
            <a href={mediaUrl} target="_blank" rel="noreferrer">
              {mediaUrl}
            </a>
            {candidate.source_page && (
              <>
                <span>source</span>
                <a href={candidate.source_page} target="_blank" rel="noreferrer">
                  {candidate.source_page}
                </a>
              </>
            )}
            {candidate.recommended_segment_ms && (
              <>
                <span>segment</span>
                <span>
                  {(candidate.recommended_segment_ms.start_ms / 1000).toFixed(1)}s
                  {' - '}
                  {(candidate.recommended_segment_ms.end_ms / 1000).toFixed(1)}s
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Modal popup that surfaces every piece of extracted media (clips,
 *  frames, full-page recording, screenshots) for one candidate. Reuses
 *  the `.extracted-clip*` card styling but in a centered overlay with
 *  per-source section headers. */
type RegenAction = { busy: boolean; run: () => void; label: string } | null;

function MediaPreviewModal({
  candidate,
  clips,
  frames,
  recordResult,
  screenshots,
  selections,
  onToggleMedia,
  onClose,
  regenerate,
}: {
  candidate: MediaCandidate;
  clips: ExtractedClip[] | null;
  frames: VideoFrame[] | null;
  recordResult: Extract<RecordPageResponse, { ok: true }> | null;
  screenshots:
    | Extract<ScreenshotPageResponse, { ok: true }>['screenshots']
    | null;
  selections: SelectedMedia[];
  onToggleMedia?: (media: SelectedMedia | null) => void;
  onClose: () => void;
  regenerate?: {
    clips?: RegenAction;
    frames?: RegenAction;
    recording?: RegenAction;
    screenshots?: RegenAction;
  };
}): React.JSX.Element {
  const indexOf = (url: string): number =>
    selections.findIndex((s) => s.url === url);

  // Esc closes the modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasClips = !!clips && clips.length > 0;
  const hasFrames = !!frames && frames.length > 0;
  const hasRecording = !!recordResult;
  const hasScreenshots = !!screenshots && screenshots.length > 0;

  const renderRegen = (action: RegenAction | undefined): React.JSX.Element | null => {
    if (!action) return null;
    return (
      <button
        type="button"
        className="preview-section-regen"
        onClick={action.run}
        disabled={action.busy}
        title="Re-run this capture"
      >
        {action.busy ? 'Working…' : action.label}
      </button>
    );
  };

  return (
    <div className="preview-modal-backdrop" onClick={onClose}>
      <div
        className="preview-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-modal-head">
          <div className="preview-modal-head-text">
            <span className="preview-modal-eyebrow">Extracted media</span>
            <span className="preview-modal-title">
              {candidate.title || candidate.url}
            </span>
          </div>
          <button
            type="button"
            className="preview-modal-close"
            onClick={onClose}
            aria-label="Close preview"
          >
            ✕
          </button>
        </div>
        <div className="preview-modal-body">
          {hasRecording && (
            <section className="preview-section">
              <header className="preview-section-head">
                <span className="preview-section-label">Page recording</span>
                <span className="preview-section-count">1</span>
                {renderRegen(regenerate?.recording)}
              </header>
              <div className="extracted-clips preview-clips">
                {(() => {
                  const i = indexOf(recordResult.recording_url);
                  const isSelected = i >= 0;
                  return (
                    <div
                      className={
                        isSelected
                          ? 'extracted-clip extracted-clip-selected'
                          : 'extracted-clip'
                      }
                    >
                      <video
                        src={recordResult.recording_url}
                        className="extracted-clip-video"
                        controls
                        preload="metadata"
                      />
                      <div className="extracted-clip-meta">
                        <span className="extracted-clip-time">
                          {(recordResult.duration_ms / 1000).toFixed(1)}s ·{' '}
                          {recordResult.segments?.length ?? 0} segment(s)
                        </span>
                        {recordResult.reasoning && (
                          <span className="extracted-clip-reason">
                            {recordResult.reasoning}
                          </span>
                        )}
                        {onToggleMedia && (
                          <button
                            type="button"
                            className={
                              isSelected
                                ? 'btn-select btn-select-on'
                                : 'btn-select'
                            }
                            onClick={() =>
                              onToggleMedia({
                                url: recordResult.recording_url,
                                kind: 'video',
                                origin: 'page_recording',
                                from_candidate_url: candidate.url,
                                reason: recordResult.reasoning ?? null,
                              })
                            }
                          >
                            {isSelected
                              ? `✓ #${i + 1}`
                              : '+ Use this recording'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </section>
          )}

          {hasScreenshots && (
            <section className="preview-section">
              <header className="preview-section-head">
                <span className="preview-section-label">Page screenshots</span>
                <span className="preview-section-count">
                  {screenshots.length}
                </span>
                {renderRegen(regenerate?.screenshots)}
              </header>
              <div className="extracted-clips preview-clips">
                {screenshots.map((s) => {
                  const i = indexOf(s.image_url);
                  const isSelected = i >= 0;
                  return (
                    <div
                      key={s.screenshot_id}
                      className={
                        isSelected
                          ? 'extracted-clip extracted-clip-selected'
                          : 'extracted-clip'
                      }
                    >
                      <img
                        src={s.image_url}
                        className="extracted-clip-shot"
                        alt={s.preview || 'screenshot'}
                      />
                      <div className="extracted-clip-meta">
                        <span className="extracted-clip-time">
                          {s.kind} · {s.width}×{s.height}px
                        </span>
                        <span className="extracted-clip-reason">
                          {s.reason}
                        </span>
                        {s.preview && s.preview !== s.reason && (
                          <span className="extracted-clip-reason">
                            “{s.preview.slice(0, 100)}
                            {s.preview.length > 100 ? '…' : ''}”
                          </span>
                        )}
                        {onToggleMedia && (
                          <button
                            type="button"
                            className={
                              isSelected
                                ? 'btn-select btn-select-on'
                                : 'btn-select'
                            }
                            onClick={() =>
                              onToggleMedia({
                                url: s.image_url,
                                kind: 'image',
                                origin: 'page_screenshot',
                                from_candidate_url: candidate.url,
                                reason: s.reason,
                              })
                            }
                          >
                            {isSelected
                              ? `✓ #${i + 1}`
                              : '+ Use this screenshot'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {hasClips && (
            <section className="preview-section">
              <header className="preview-section-head">
                <span className="preview-section-label">Extracted clips</span>
                <span className="preview-section-count">{clips.length}</span>
                {renderRegen(regenerate?.clips)}
              </header>
              <div className="extracted-clips preview-clips">
                {clips.map((c) => {
                  const i = indexOf(c.clip_url);
                  return (
                    <ExtractedClipCard
                      key={c.clip_id}
                      clip={c}
                      selectionIndex={i}
                      onToggle={
                        onToggleMedia
                          ? () =>
                              onToggleMedia({
                                url: c.clip_url,
                                kind: 'video',
                                origin: 'extract_clip',
                                from_candidate_url: candidate.url,
                                reason: c.reason,
                                start_ms: c.start_ms,
                                end_ms: c.end_ms,
                              })
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            </section>
          )}

          {hasFrames && (
            <section className="preview-section">
              <header className="preview-section-head">
                <span className="preview-section-label">Frame stills</span>
                <span className="preview-section-count">{frames.length}</span>
                {renderRegen(regenerate?.frames)}
              </header>
              <div className="extracted-clips preview-clips">
                {frames.map((f) => {
                  const i = indexOf(f.image_url);
                  const isSelected = i >= 0;
                  return (
                    <div
                      key={f.frame_id}
                      className={
                        isSelected
                          ? 'extracted-clip extracted-clip-selected'
                          : 'extracted-clip'
                      }
                    >
                      <img
                        src={f.image_url}
                        className="extracted-clip-shot"
                        alt={f.reason || 'frame'}
                      />
                      <div className="extracted-clip-meta">
                        <span className="extracted-clip-time">
                          @ {(f.timestamp_ms / 1000).toFixed(2)}s
                        </span>
                        <span className="extracted-clip-reason">
                          {f.reason}
                        </span>
                        {onToggleMedia && (
                          <button
                            type="button"
                            className={
                              isSelected
                                ? 'btn-select btn-select-on'
                                : 'btn-select'
                            }
                            onClick={() =>
                              onToggleMedia({
                                url: f.image_url,
                                kind: 'image',
                                origin: 'video_frame',
                                from_candidate_url: candidate.url,
                                reason: f.reason,
                                timestamp_ms: f.timestamp_ms,
                              })
                            }
                          >
                            {isSelected
                              ? `✓ #${i + 1}`
                              : '+ Use this frame'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function ExtractedClipCard({
  clip,
  selectionIndex,
  onToggle,
}: {
  clip: ExtractedClip;
  /** Position in the shot's selected_media array (0-indexed), or -1
   *  when this clip isn't selected. */
  selectionIndex?: number;
  onToggle?: () => void;
}): React.JSX.Element {
  const dur_s = ((clip.end_ms - clip.start_ms) / 1000).toFixed(1);
  const isSelected = (selectionIndex ?? -1) >= 0;
  return (
    <div
      className={
        isSelected ? 'extracted-clip extracted-clip-selected' : 'extracted-clip'
      }
    >
      <video
        src={clip.clip_url}
        className="extracted-clip-video"
        controls
        preload="metadata"
      />
      <div className="extracted-clip-meta">
        <span className="extracted-clip-time">
          {(clip.start_ms / 1000).toFixed(1)}s –{' '}
          {(clip.end_ms / 1000).toFixed(1)}s · {dur_s}s
        </span>
        <span className="extracted-clip-reason">{clip.reason}</span>
        {onToggle && (
          <button
            type="button"
            className={
              isSelected ? 'btn-select btn-select-on' : 'btn-select'
            }
            onClick={onToggle}
          >
            {isSelected
              ? `✓ #${(selectionIndex ?? 0) + 1}`
              : '+ Use this clip'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Single entry in the extract-clips thought-process log. Renders the
 *  stage label + message, and optionally a disclosure-triggered detail
 *  block when the event carries structured payload (transcript
 *  windows, ranked ranges, scene cuts). */
function ExtractLogEntry({
  event,
}: {
  event: ExtractProgressEvent;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const detail = event.detail;
  const hasWindows = !!detail?.transcript_windows?.length;
  const hasRanges = !!detail?.ranges?.length;
  const hasCuts = !!detail?.scene_cuts_ms?.length;
  const hasDetail = hasWindows || hasRanges || hasCuts;
  return (
    <li className={`extract-log-entry extract-log-${event.stage}`}>
      <div className="extract-log-head">
        <span className="extract-log-stage">{event.stage}</span>
        <span className="extract-log-msg">{event.message}</span>
        {hasDetail && (
          <button
            type="button"
            className="extract-log-detail-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'hide' : 'show'} detail
          </button>
        )}
      </div>
      {open && hasDetail && (
        <div className="extract-log-detail">
          {hasWindows && (
            <details className="extract-log-section">
              <summary>
                {detail!.transcript_windows!.length} transcript window(s)
                sent to ranker
              </summary>
              <ol className="extract-log-windows">
                {detail!.transcript_windows!.map((w, i) => (
                  <li key={i}>
                    <span className="extract-log-time">
                      [{(w.start_ms / 1000).toFixed(1)}s–
                      {(w.end_ms / 1000).toFixed(1)}s]
                    </span>{' '}
                    {w.text}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {hasRanges && (
            <details className="extract-log-section" open>
              <summary>
                model picked {detail!.ranges!.length} range(s)
              </summary>
              <ol className="extract-log-ranges">
                {detail!.ranges!.map((r, i) => (
                  <li key={i}>
                    <span className="extract-log-time">
                      [{(r.start_ms / 1000).toFixed(2)}s–
                      {(r.end_ms / 1000).toFixed(2)}s]
                    </span>{' '}
                    {r.reason}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {hasCuts && (
            <details className="extract-log-section">
              <summary>
                {new Set(detail!.scene_cuts_ms!).size} scene cut point(s)
              </summary>
              <div className="extract-log-cuts">
                {Array.from(new Set(detail!.scene_cuts_ms!))
                  .sort((a, b) => a - b)
                  .map((c) => `${(c / 1000).toFixed(2)}s`)
                  .join(' · ')}
              </div>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

/** Live log entry for the video-screenshots pipeline. Surfaces the
 *  candidate scenes + picked frame midpoints so the user can see
 *  exactly which visually-distinct moment each screenshot came from. */
function VideoFramesLogEntry({
  event,
}: {
  event: VideoFrameProgressEvent;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const detail = event.detail;
  const hasScenes = !!detail?.scenes?.length;
  const hasPicks = !!detail?.picks?.length;
  const hasDetail = hasScenes || hasPicks;
  return (
    <li className={`extract-log-entry extract-log-${event.stage}`}>
      <div className="extract-log-head">
        <span className="extract-log-stage">{event.stage}</span>
        <span className="extract-log-msg">{event.message}</span>
        {hasDetail && (
          <button
            type="button"
            className="extract-log-detail-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'hide' : 'show'} detail
          </button>
        )}
      </div>
      {open && hasDetail && (
        <div className="extract-log-detail">
          {hasScenes && (
            <details className="extract-log-section">
              <summary>
                {detail!.scenes!.length} candidate scene(s) sent to ranker
              </summary>
              <ol className="extract-log-windows">
                {detail!.scenes!.map((s) => (
                  <li key={s.scene_idx}>
                    <span className="extract-log-time">
                      [{s.scene_idx}] {(s.start_ms / 1000).toFixed(1)}s–
                      {(s.end_ms / 1000).toFixed(1)}s
                    </span>{' '}
                    {s.spoken_text || '(silent)'}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {hasPicks && (
            <details className="extract-log-section" open>
              <summary>{detail!.picks!.length} frame midpoint(s)</summary>
              <ol className="extract-log-ranges">
                {detail!.picks!.map((p, i) => (
                  <li key={i}>
                    <span className="extract-log-time">
                      @ {(p.timestamp_ms / 1000).toFixed(2)}s
                    </span>{' '}
                    {p.reason}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

/** Live log entry for the record-page pipeline. Mirrors
 *  ExtractLogEntry: header + optional structured detail (page
 *  sections, planned scroll segments, LLM reasoning). */
function RecordLogEntry({
  event,
}: {
  event: RecordProgressEvent;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const detail = event.detail;
  const hasSections = !!detail?.sections?.length;
  const hasSegments = !!detail?.segments?.length;
  const hasReasoning = !!detail?.reasoning;
  const hasDetail = hasSections || hasSegments || hasReasoning;
  return (
    <li className={`extract-log-entry extract-log-${event.stage}`}>
      <div className="extract-log-head">
        <span className="extract-log-stage">{event.stage}</span>
        <span className="extract-log-msg">{event.message}</span>
        {hasDetail && (
          <button
            type="button"
            className="extract-log-detail-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'hide' : 'show'} detail
          </button>
        )}
      </div>
      {open && hasDetail && (
        <div className="extract-log-detail">
          {hasSections && (
            <details className="extract-log-section">
              <summary>{detail!.sections!.length} page section(s) detected</summary>
              <ol className="extract-log-windows">
                {detail!.sections!.map((s, i) => (
                  <li key={i}>
                    <span className="extract-log-time">
                      [{(s.position_fraction * 100).toFixed(0)}%]
                    </span>{' '}
                    {s.label}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {hasSegments && (
            <details className="extract-log-section" open>
              <summary>{detail!.segments!.length} planned scroll segment(s)</summary>
              <ol className="extract-log-ranges">
                {detail!.segments!.map((s, i) => (
                  <li key={i}>
                    <span className="extract-log-time">
                      → {(s.scroll_to * 100).toFixed(0)}%
                    </span>{' '}
                    travel {s.travel_ms}ms · hold {s.hold_ms}ms
                  </li>
                ))}
              </ol>
            </details>
          )}
          {hasReasoning && (
            <details className="extract-log-section" open>
              <summary>model reasoning</summary>
              <div className="extract-log-cuts">{detail!.reasoning}</div>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

/** Live log entry for the screenshot-page pipeline. Surfaces the
 *  regions scan + LLM picks via a disclosure so the user can see why
 *  a particular crop was chosen. */
function ScreenshotLogEntry({
  event,
}: {
  event: ScreenshotProgressEvent;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const detail = event.detail;
  const hasRegions = !!detail?.regions?.length;
  const hasPicks = !!detail?.picks?.length;
  const hasDetail = hasRegions || hasPicks;
  return (
    <li className={`extract-log-entry extract-log-${event.stage}`}>
      <div className="extract-log-head">
        <span className="extract-log-stage">{event.stage}</span>
        <span className="extract-log-msg">{event.message}</span>
        {hasDetail && (
          <button
            type="button"
            className="extract-log-detail-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'hide' : 'show'} detail
          </button>
        )}
      </div>
      {open && hasDetail && (
        <div className="extract-log-detail">
          {hasRegions && (
            <details className="extract-log-section">
              <summary>{detail!.regions!.length} region(s) considered</summary>
              <ol className="extract-log-windows">
                {detail!.regions!.map((r) => (
                  <li key={r.id}>
                    <span className="extract-log-time">
                      [{r.id}] {r.kind} {r.width}×{r.height}
                    </span>{' '}
                    {r.preview || '(no preview)'}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {hasPicks && (
            <details className="extract-log-section" open>
              <summary>{detail!.picks!.length} pick(s)</summary>
              <ol className="extract-log-ranges">
                {detail!.picks!.map((p) => (
                  <li key={p.id}>
                    <span className="extract-log-time">[{p.id}]</span>{' '}
                    {p.reason}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

// ============================================================
//  Reel thumbnail (og:image fetch, memoized per URL)
// ============================================================

// Only successful (non-null) thumbnails are cached. A null result
// means the fetch failed; we re-attempt next time the component
// mounts rather than caching the failure forever.
const thumbCache = new Map<string, string>();

/** Resolve a reel/page poster frame to a renderable (data:) URL via the
 *  main process, cached across mounts. `undefined` = still loading,
 *  `null` = no poster available. Shared by <ReelThumb> and the blurred
 *  backdrop so both draw the same resolved image. */
function useReelThumb(url: string): string | null | undefined {
  const [thumb, setThumb] = useState<string | null | undefined>(
    () => thumbCache.get(url) ?? undefined,
  );

  useEffect(() => {
    const cached = thumbCache.get(url);
    if (cached) {
      setThumb(cached);
      return;
    }
    let cancelled = false;
    setThumb(undefined);
    window.api.fetchReelThumbnail(url).then((result) => {
      if (cancelled) return;
      if (result) thumbCache.set(url, result);
      setThumb(result);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return thumb;
}

function ReelThumb({
  url,
  size = 'sm',
}: {
  url: string;
  size?: 'sm' | 'md';
}): React.JSX.Element {
  const thumb = useReelThumb(url);

  return (
    <div className={`reel-thumb reel-thumb-${size}`}>
      {thumb === undefined && <div className="reel-thumb-loading">…</div>}
      {thumb === null && <div className="reel-thumb-missing">no preview</div>}
      {thumb && <img src={thumb} alt="reel preview" loading="lazy" />}
    </div>
  );
}

/** Blurred, darkened copy of a reel/page poster used as a full-bleed
 *  backdrop behind letterboxed foreground media. Resolves the same
 *  poster <ReelThumb> uses; renders nothing until it's available. */
function ReelThumbBlurMedia({ url }: { url: string }): React.JSX.Element | null {
  const thumb = useReelThumb(url);
  if (!thumb) return null;
  return <img className="reel-block-blur-media" src={thumb} alt="" />;
}

// ============================================================
//  Tag chip
// ============================================================

function TagChip({
  label,
  active,
  onClick,
  small,
}: {
  tag: ReelTag;
  label: string;
  active: boolean;
  onClick: () => void;
  small?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tag-chip ${active ? 'active' : ''} ${small ? 'small' : ''}`}
    >
      {label}
    </button>
  );
}

// ============================================================
//  Analyze view (existing single-reel inspector, preserved)
// ============================================================

function isReel(r: ResolveResult): r is ResolvedReel {
  return !('error' in r);
}

/** Phase of the single-click analyze flow: resolve the URL, then run the
 *  analyzer, then render the dashboard. One button drives all of it. */
type AnalyzePhase = 'idle' | 'resolving' | 'analyzing' | 'done' | 'error';

const PLATFORM_BADGE: Record<ResolvedReel['platform'], string> = {
  instagram: 'IG',
  youtube: 'YT',
  tiktok: 'TT',
  unknown: '—',
};

/** Friendly labels for the coarse SFX acoustic buckets. */
const SFX_TYPE_LABELS: Record<string, string> = {
  impulse_tonal: 'ding / bell',
  impulse_noisy: 'clap / impact',
  sweep: 'whoosh / sweep',
  vocal: 'vocal stinger',
  sustained: 'drone / sustained',
  other: 'other',
};

/** Marker colors per SFX acoustic bucket, for the timeline overlay. */
const SFX_TYPE_COLORS: Record<string, string> = {
  impulse_tonal: '#ffd24a',
  impulse_noisy: '#ff7a59',
  sweep: '#5ac8fa',
  vocal: '#c98bff',
  sustained: '#9aa0a6',
  other: '#ffffff',
};

/** Stable, distinct color for a named sound (so a "ding" lane and a "wow" lane
 *  read as different colors even within the same acoustic bucket). Falls back
 *  to the bucket color when no specific sound is set. */
function colorForSfx(ev: { type: string; sound?: string }): string {
  if (!ev.sound) return SFX_TYPE_COLORS[ev.type] ?? '#ffffff';
  let h = 0;
  const s = ev.sound.toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 75% 62%)`;
}

/** Display order for clip types in the "What's on screen" breakdown,
 *  largest-share-first regardless, but this fixes the iteration set
 *  (the renderer can't import the runtime CLIP_TYPES from main). */
const CLIP_TYPE_ORDER: ClipType[] = [
  'broll_visual',
  'talking_head',
  'broll_talking_head',
  'talking_head_unknown',
];

/** Display label + bar color for each clip type, used by the
 *  "What's on screen" breakdown. */
const CLIP_META: Record<ClipType, { label: string; color: string }> = {
  broll_visual: { label: 'B-roll visual', color: 'var(--accent)' },
  talking_head: { label: 'Talking head', color: 'var(--az-blue)' },
  broll_talking_head: { label: 'B-roll + talking', color: 'var(--az-purple)' },
  talking_head_unknown: {
    label: 'Talking head (unsure)',
    color: 'var(--az-gray)',
  },
};

/** Display label + bar color for each measured camera-motion kind. */
const MOTION_META: Record<CameraMotionKind, { label: string; color: string }> = {
  none: { label: 'Static', color: 'var(--az-gray)' },
  zoom_in: { label: 'Zoom in', color: 'var(--accent)' },
  zoom_out: { label: 'Zoom out', color: 'var(--az-blue)' },
  pan_left: { label: 'Pan left', color: 'var(--az-purple)' },
  pan_right: { label: 'Pan right', color: 'var(--az-purple)' },
  ken_burns: { label: 'Ken Burns', color: 'var(--az-blue)' },
};

/** The face-bearing clip types the "Talking-head moments" section
 *  surfaces with per-shot timing + framing. b-roll_visual (no face)
 *  is excluded. */
const TALKING_TYPES: ClipType[] = [
  'talking_head',
  'broll_talking_head',
  'talking_head_unknown',
];

/** 3x3 frame regions in row-major order, so mapping them into a
 *  3-column grid reproduces the on-screen layout. Local runtime copy —
 *  the renderer can't import the value from main. */
const FRAME_REGION_GRID: FrameRegion[] = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'middle_center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
];

/** Tiny 3x3 grid glyph with the cell containing the face lit — a
 *  compact "where in frame" indicator. */
function RegionGlyph({
  region,
  color,
}: {
  region: FrameRegion | null;
  color: string;
}): React.JSX.Element {
  return (
    <span className="az-regiongrid" aria-hidden>
      {FRAME_REGION_GRID.map((cell) => (
        <i
          key={cell}
          className={cell === region ? 'on' : ''}
          style={cell === region ? { background: color } : undefined}
        />
      ))}
    </span>
  );
}

function regionLabel(region: FrameRegion | null | undefined): string {
  return region ? region.replace(/_/g, ' ') : 'unknown region';
}

function isMeaningfulLayerText(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 3) return false;
  if (!/[A-Za-z0-9]/.test(clean)) return false;
  if (/^[^\p{L}\p{N}]+$/u.test(clean)) return false;
  if (/^[£$€¥]?\d{1,2}[.,]?$/.test(clean)) return false;
  if (/^[A-Za-z]{1,2}$/.test(clean)) return false;
  return true;
}

type ShotLayerBreakdown = {
  media: string[];
  overlays: string[];
  captions: string[];
};

function shotLayerBreakdown(
  shot: ReelAnalysisResult['shots'][number],
): ShotLayerBreakdown {
  const parsedVisual = parseLayeredVisualDescription(shot.visual_caption);
  const overlayOnlyVisual = visualCaptionLooksLikeOverlayOnly(shot);
  const media: string[] = [
    parsedVisual.overlay || overlayOnlyVisual
      ? 'Base media'
      : CLIP_META[shot.clip_type]?.label ?? shot.clip_type.replace(/_/g, ' '),
  ];
  if (parsedVisual.base && !overlayOnlyVisual) {
    media.push(clipText(parsedVisual.base, 118));
  } else if (overlayOnlyVisual) {
    media.push('underlying/background video not separately identified');
  }
  const baseLooksPersonLike =
    parsedVisual.base &&
    /\b(face|person|man|woman|speaker|talking|interview|host|presenter)\b/i.test(
      parsedVisual.base,
    );
  if (
    shot.face_region &&
    !overlayOnlyVisual &&
    (!parsedVisual.overlay || baseLooksPersonLike)
  ) {
    media.push(`face framed ${regionLabel(shot.face_region)}`);
  }
  if (shot.detected_motion && shot.detected_motion.kind !== 'none') {
    media.push(
      `${MOTION_META[shot.detected_motion.kind].label} media motion`,
    );
  }

  const overlays: string[] = [];
  for (const overlay of shot.overlays ?? []) {
    const context = scriptContextLabel(overlay.spoken_window || shot.spoken_window);
    overlays.push(
      `${overlay.kind.replace(/_/g, ' ')} ${regionLabel(overlay.region)} · ${overlay.motion}${context ? ` · ${context}` : ''}`,
    );
  }
  const inferredOverlay = inferredVisualLayerDetail(shot);
  if (inferredOverlay && overlays.length === 0) {
    const context = layer2ScriptContext(shot);
    overlays.push(
      `inferred ${inferredOverlay}${context ? ` · ${context}` : ''}`,
    );
  }

  const captions: string[] = [];
  const embeddedOverlayText: string[] = [];
  for (const text of shot.text_moments ?? []) {
    if (!isMeaningfulLayerText(text.text)) continue;
    if (
      text.role === 'image_text' ||
      inferredOverlayOwnsTextRegion(shot, text.region)
    ) {
      embeddedOverlayText.push(
        `${regionLabel(text.region)}: "${clipText(text.text, 42)}"`,
      );
      continue;
    }
    const label =
      text.role === 'subtitle'
        ? 'subtitle'
        : text.role === 'title'
          ? 'title/text overlay'
          : 'text overlay';
    captions.push(
      `${label} ${regionLabel(text.region)}: "${clipText(text.text, 52)}"`,
    );
  }
  if (embeddedOverlayText.length > 0) {
    overlays.push(
      `embedded text in visual overlay: ${embeddedOverlayText.slice(0, 4).join(' · ')}`,
    );
  }
  if (
    shot.ocr_text &&
    captions.length === 0 &&
    isMeaningfulLayerText(shot.ocr_text) &&
    !visualCaptionLooksLikeOverlayOnly(shot)
  ) {
    captions.push(`OCR text overlay: "${clipText(shot.ocr_text, 64)}"`);
  }

  return {
    media,
    overlays: overlays.length ? overlays : ['No visual overlay detected'],
    captions: captions.length ? captions : ['No text/caption layer detected'],
  };
}

function msRange(startMs: number, endMs: number): string {
  const s = (startMs / 1000).toFixed(1);
  const e = (endMs / 1000).toFixed(1);
  return `${s}s – ${e}s`;
}

function AnalyzeView(): React.JSX.Element {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<AnalyzePhase>('idle');
  const [reel, setReel] = useState<ResolvedReel | null>(null);
  const [analysis, setAnalysis] = useState<ReelAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AnalyzeHistoryEntry[]>([]);

  // Load the recent-analyses list on mount.
  useEffect(() => {
    window.api
      .listAnalyzeHistory()
      .then(setHistory)
      .catch(() => {
        /* history is best-effort */
      });
  }, []);

  // One click: resolve the URL, reuse a cached analysis if one exists
  // (re-analyzing is 1-3 min), else run the analyzer, then record it to
  // history. `target` lets a history-row click drive the same flow
  // without waiting on a setUrl render.
  async function run(target0?: string): Promise<void> {
    const target = (target0 ?? url).trim();
    if (!target) return;
    if (target !== url) setUrl(target);
    setPhase('resolving');
    setReel(null);
    setAnalysis(null);
    setError(null);
    try {
      const resolved = await window.api.resolveReel(target);
      if (!isReel(resolved)) {
        // Resolve failed — but if we've analyzed this URL before, show
        // the cached analysis without a live video rather than erroring.
        const cachedOnFail = await window.api.loadCachedAnalysis(target);
        const hist = history.find((h) => h.url === target);
        if (cachedOnFail && hist) {
          setReel({
            platform: hist.platform as ResolvedReel['platform'],
            playable_url: '',
            playable_url_expires_at: null,
            duration_ms: hist.duration_ms,
            width: hist.width,
            height: hist.height,
            caption_text: hist.caption_text,
          });
          setAnalysis(cachedOnFail);
          setPhase('done');
          return;
        }
        setError(resolved.error);
        setPhase('error');
        return;
      }
      setReel(resolved);
      setPhase('analyzing');
      const cached = await window.api.loadCachedAnalysis(target);
      const result =
        cached ??
        (await window.api.analyzeReel({
          playableUrl: resolved.playable_url,
          durationMs: resolved.duration_ms,
        }));
      setAnalysis(result);
      setPhase('done');
      // Record it (writes the shared cache + upserts the history entry).
      try {
        const next = await window.api.recordAnalysis({
          url: target,
          platform: resolved.platform,
          duration_ms: resolved.duration_ms,
          width: resolved.width,
          height: resolved.height,
          caption_text: resolved.caption_text,
          analysis: result,
          analyzed_at: Date.now(),
        });
        setHistory(next);
      } catch {
        /* history is best-effort */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }

  async function removeEntry(u: string): Promise<void> {
    try {
      setHistory(await window.api.deleteAnalyzeHistory(u));
    } catch {
      /* best-effort */
    }
  }

  // Return to the recent-analyses list without clearing the URL.
  function reset(): void {
    setPhase('idle');
    setReel(null);
    setAnalysis(null);
    setError(null);
  }

  const busy = phase === 'resolving' || phase === 'analyzing';
  const buttonLabel =
    phase === 'resolving'
      ? 'Resolving…'
      : phase === 'analyzing'
        ? 'Analyzing…'
        : 'Analyze';
  const hasDashboard =
    phase === 'done' && !!reel && !!analysis && analysis.shots.length > 0;

  return (
    <div className="scroll">
      <div className="canvas canvas-wide analyze">
        <label className="label">REEL URL</label>
        <div className="row">
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && run()}
            placeholder="https://www.instagram.com/p/..."
            spellCheck={false}
          />
          <button
            className="btn btn-primary"
            onClick={() => run()}
            disabled={busy || !url.trim()}
          >
            {buttonLabel}
          </button>
        </div>

        {busy && (
          <div className="az-progress">
            <span className="az-spinner" />
            {phase === 'resolving'
              ? 'Resolving reel…'
              : 'Analyzing — scenes, faces, speech, overlays, sound…'}
          </div>
        )}

        {error && <div className="error">{error}</div>}

        {phase === 'done' && reel && analysis && analysis.shots.length > 0 && (
          <>
            <button type="button" className="az-back" onClick={reset}>
              ‹ Recent analyses
            </button>
            <AnalyzeDashboard reel={reel} analysis={analysis} />
          </>
        )}
        {phase === 'done' && analysis && analysis.shots.length === 0 && (
          <div className="error">
            No shots detected — the reel may be too short or failed to decode.
          </div>
        )}

        {!busy && !hasDashboard && history.length > 0 && (
          <AnalyzeHistoryList
            entries={history}
            onOpen={(u) => run(u)}
            onDelete={removeEntry}
          />
        )}
      </div>
    </div>
  );
}

/** Relative-time label for history rows (e.g. "3h ago", "2d ago"). */
function timeAgo(epochMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** "Recent analyses" list shown under the URL bar when no dashboard is
 *  open. Each row reopens the analysis (cache hit = instant) or can be
 *  removed. */
function AnalyzeHistoryList({
  entries,
  onOpen,
  onDelete,
}: {
  entries: AnalyzeHistoryEntry[];
  onOpen: (url: string) => void;
  onDelete: (url: string) => void;
}): React.JSX.Element {
  return (
    <section className="az-history">
      <h3 className="az-section-title">
        Recent analyses{' '}
        <span className="az-section-count">{entries.length}</span>
      </h3>
      <div className="az-history-list">
        {entries.map((e) => (
          <div
            key={e.url}
            className="az-history-row"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(e.url)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') onOpen(e.url);
            }}
          >
            <ReelThumb url={e.url} size="sm" />
            <div className="az-history-main">
              <div className="az-history-hook">
                {e.hook || e.caption_text || e.url}
              </div>
              <div className="az-history-meta">
                <span className="az-history-badge">
                  {PLATFORM_BADGE[
                    (e.platform as ResolvedReel['platform']) ?? 'unknown'
                  ] ?? '—'}
                </span>
                <span>{e.shot_count} shots</span>
                <span>{(e.duration_ms / 1000).toFixed(1)}s</span>
                <span>{timeAgo(e.analyzed_at)}</span>
              </div>
            </div>
            <button
              type="button"
              className="az-history-del"
              title="Remove from history"
              onClick={(ev) => {
                ev.stopPropagation();
                onDelete(e.url);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Big-number stat tile, optionally with a labeled progress bar
 *  underneath (used for the percentage stats). */
function StatCard({
  value,
  unit,
  label,
  bar,
  barColor,
}: {
  value: string;
  unit?: string;
  label: string;
  bar?: number;
  barColor?: string;
}): React.JSX.Element {
  return (
    <div className="az-stat">
      <div className="az-stat-num">
        {value}
        {unit && <span className="az-stat-unit">{unit}</span>}
      </div>
      <div className="az-stat-label">{label}</div>
      {bar !== undefined && (
        <div className="az-stat-bar">
          <i
            style={{
              width: `${Math.round(Math.max(0, Math.min(1, bar)) * 100)}%`,
              background: barColor,
            }}
          />
        </div>
      )}
    </div>
  );
}

/** One labeled horizontal bar with a right-aligned percentage, used by
 *  the "What's on screen" and "Sound mix" panels. */
function BarRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}): React.JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="az-row">
      <div className="az-row-label">{label}</div>
      <div className="az-row-track">
        <i style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="az-row-pct">{pct}%</div>
    </div>
  );
}

/** Map a detected color word ("yellow", "black") or hex string to a hex
 *  value usable by <input type="color">. Returns null when unknown so
 *  callers can fall back to a default. */
const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  yellow: '#ffe000',
  green: '#22dd55',
  red: '#ff3b30',
  blue: '#2d7dff',
  cyan: '#22d3ee',
  pink: '#ff5fa2',
  purple: '#a855f7',
  orange: '#ff8a00',
  gray: '#808080',
  grey: '#808080',
};
function namedColorToHex(color: string | null | undefined): string | null {
  if (!color) return null;
  const c = color.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(c)) return c;
  return NAMED_COLORS[c] ?? null;
}

/** Inject an @font-face for a matched caption font (served as a data URL
 *  by the main process) so the Subtitle-style preview renders in the
 *  ACTUAL detected font. Idempotent per family. */
const injectedFontFaces = new Set<string>();
function injectFontFace(family: string, dataUrl: string): void {
  if (injectedFontFaces.has(family)) return;
  injectedFontFaces.add(family);
  const style = document.createElement('style');
  style.textContent = `@font-face{font-family:'${family}';src:url(${dataUrl}) format('truetype');font-display:swap;}`;
  document.head.appendChild(style);
}

/** Resolve a matched caption font id to a usable CSS family, loading +
 *  injecting it on demand. Returns null until ready (caller falls back).
 *  The data-URL fetch is cached per id so many mockups sharing one font
 *  don't each hit IPC. */
const fontDataUrlCache = new Map<string, Promise<string | null>>();
function useMatchedFont(fontId: string | null | undefined): string | null {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    setFamily(null);
    if (!fontId) return;
    let cancelled = false;
    let p = fontDataUrlCache.get(fontId);
    if (!p) {
      p = window.api.getFontDataUrl(fontId);
      fontDataUrlCache.set(fontId, p);
    }
    void p.then((dataUrl) => {
      if (cancelled || !dataUrl) return;
      const fam = `cap-${fontId}`;
      injectFontFace(fam, dataUrl);
      setFamily(fam);
    });
    return () => {
      cancelled = true;
    };
  }, [fontId]);
  return family;
}

function subtitlePositionCss(position: SubtitleSpec['position']): {
  top?: string;
  bottom?: string;
  left?: string;
  transform?: string;
} {
  const pos = position === 'varies' ? 'bottom' : position;
  if (pos === 'top') {
    return { top: '12%', left: '50%', transform: 'translateX(-50%)' };
  }
  if (pos === 'center') {
    return {
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    };
  }
  if (pos === 'lower_third') {
    return { bottom: '24%', left: '50%', transform: 'translateX(-50%)' };
  }
  return { bottom: '10%', left: '50%', transform: 'translateX(-50%)' };
}

/** Inline CSS that reproduces a SubtitleSpec's look on a text overlay —
 *  used in the storyboard/preview so the burned-in caption matches the
 *  detected style (font, treatment, color, casing) instead of a generic
 *  default. `fontFamily` is the resolved CSS family from useMatchedFont. */
/** Clamped subtitle fine-size multiplier (1 = preset default). Slider
 *  range is 0.5x–3x; typed values are clamped to the same window. */
function subtitleFontScale(spec: SubtitleSpec): number {
  const s = spec.font_scale ?? 1;
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.max(0.5, Math.min(3, s));
}

/** Outline thickness (px) for the 'bordered' treatment, scaled with the
 *  font so it stays proportional. Base clamps to 0–8px. */
function subtitleBorderWidth(spec: SubtitleSpec): number {
  const w = spec.border_width ?? 2;
  const base = Number.isFinite(w) ? Math.max(0, Math.min(8, w)) : 2;
  return base * subtitleFontScale(spec);
}

function subtitleSpecCss(
  spec: SubtitleSpec,
  fontFamily: string | null,
): React.CSSProperties {
  const treat = namedColorToHex(spec.treatment_color) ?? '#000000';
  const baseSize =
    spec.font_size === 'small' ? 11 : spec.font_size === 'medium' ? 14 : 18;
  const fontSize = baseSize * subtitleFontScale(spec);
  return {
    fontFamily: fontFamily ?? undefined,
    fontWeight: 800,
    textTransform:
      spec.casing === 'uppercase'
        ? 'uppercase'
        : spec.casing === 'title_case'
          ? 'capitalize'
          : 'none',
    color: namedColorToHex(spec.text_color) ?? '#ffffff',
    fontSize,
    padding: spec.text_treatment === 'backgrounded' ? '3px 9px' : 0,
    borderRadius: spec.text_treatment === 'backgrounded' ? 4 : 0,
    ...(spec.text_treatment === 'bordered'
      ? {
          background: 'transparent',
          WebkitTextStroke: `${subtitleBorderWidth(spec)}px ${treat}`,
          // paintOrder keeps the stroke behind the fill so thin glyphs
          // stay legible.
          paintOrder: 'stroke fill',
        }
      : spec.text_treatment === 'backgrounded'
        ? { background: treat }
        : {
            background: 'transparent',
            textShadow: '0 1px 3px rgba(0,0,0,0.7)',
          }),
  };
}

/** The reel as an EDITING BRIEF — the spec you'd hand a pro social editor
 *  to recreate this video's style. Generated on demand by the main process
 *  (LLM grounded on the per-shot script/footage/overlay breakdown, with a
 *  deterministic fallback). Explains what footage runs on the main track,
 *  what overlays sit on top and how they're organized, and how the visuals
 *  map to the script. Cached per reel so toggling views doesn't refetch. */
const briefCache = new Map<string, EditingBrief>();

function ReelBrief({
  reel,
  a,
}: {
  reel: ResolvedReel;
  a: ReelAnalysisResult;
}): React.JSX.Element {
  // Cache key: the reel URL plus shot count is enough to distinguish a
  // re-analysis of the same reel within a session.
  const cacheKey = `${reel.playable_url}::${a.shots.length}`;
  const [brief, setBrief] = useState<EditingBrief | null>(
    () => briefCache.get(cacheKey) ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (briefCache.has(cacheKey)) {
      setBrief(briefCache.get(cacheKey)!);
      return;
    }
    let cancelled = false;
    setBrief(null);
    setError(null);
    void window.api
      .generateBrief({ analysis: a, durationMs: reel.duration_ms })
      .then((b) => {
        if (cancelled) return;
        briefCache.set(cacheKey, b);
        setBrief(b);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Failed to write brief.');
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, a, reel.duration_ms]);

  if (error) {
    return (
      <div className="az-brief">
        <div className="error">{error}</div>
      </div>
    );
  }
  if (!brief) {
    return (
      <div className="az-brief az-brief-loading">
        <span className="az-spinner" />
        Writing the editing brief…
      </div>
    );
  }

  return (
    <div className="az-brief">
      {brief.summary && <p className="az-brief-intro">{brief.summary}</p>}

      {brief.sections.map((sec) => (
        <section className="az-section" key={sec.title}>
          <h3 className="az-section-title">
            {sec.title}
            {sec.tag && <span className="az-section-count">{sec.tag}</span>}
          </h3>
          <ul className="az-brief-directives">
            {sec.directives.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      ))}

      {brief.script_map.length > 0 && (
        <section className="az-section">
          <h3 className="az-section-title">
            Script → screen
            <span className="az-section-count">what shows when it&apos;s said</span>
          </h3>
          <div className="az-brief-map">
            {brief.script_map.map((beat, i) => (
              <div className="az-brief-beat" key={i}>
                <div className="az-brief-says">“{beat.says}”</div>
                <div className="az-brief-shows">
                  <span className="az-brief-shows-tag">Footage</span>
                  {beat.footage}
                </div>
                {beat.overlay && (
                  <div className="az-brief-shows az-brief-shows-ov">
                    <span className="az-brief-shows-tag">Overlay</span>
                    {beat.overlay}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {!brief.ai_generated && (
        <p className="az-brief-note">
          Generated from metrics — set OPENAI_API_KEY for a fuller,
          script-aware brief.
        </p>
      )}
    </div>
  );
}

function AnalyzeDashboard({
  reel,
  analysis: a,
}: {
  reel: ResolvedReel;
  analysis: ReelAnalysisResult;
}): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  // Which shot the user is inspecting — drives the bbox overlay on the
  // preview and the highlight on the scene strip + moments list.
  const [activeShotIdx, setActiveShotIdx] = useState<number | null>(null);
  // Current preview playback position (ms), driven by the video's
  // timeupdate — used to pop the SFX badge as playback crosses each onset.
  const [playMs, setPlayMs] = useState(0);

  // Right-column view: the metric "Insights" panels, or a readable
  // narrative "Brief" of the reel and what it looks like.
  const [azView, setAzView] = useState<'insights' | 'brief'>('insights');

  // User override of the subtitle treatment, seeded from what was
  // detected. Lets the user shuffle bordered / backgrounded / clear and
  // recolor it; the detected values are the starting point.
  const [subTreatment, setSubTreatment] = useState<CaptionTreatment>(
    a.caption_style?.text_treatment ?? 'clear',
  );
  const [subTreatmentColor, setSubTreatmentColor] = useState<string>(
    namedColorToHex(a.caption_style?.treatment_color) ?? '#000000',
  );

  // What kinds of SFX were detected across the reel (coarse acoustic
  // buckets), and any named AudioSet labels the model assigned. Tallied
  // from each shot's sfx_classifications.
  const sfxDetected = React.useMemo(() => {
    const types = new Map<string, number>();
    const labels = new Map<string, number>();
    const events: { ms: number; type: string; label?: string }[] = [];
    for (const s of a.shots) {
      for (const e of s.sfx_classifications ?? []) {
        types.set(e.type, (types.get(e.type) ?? 0) + 1);
        if (e.label) labels.set(e.label, (labels.get(e.label) ?? 0) + 1);
        events.push({ ms: e.ms, type: e.type, label: e.label ?? undefined });
      }
    }
    events.sort((x, y) => x.ms - y.ms);
    return {
      types: [...types.entries()].sort((x, y) => y[1] - x[1]),
      labels: [...labels.entries()].sort((x, y) => y[1] - x[1]),
      events,
    };
  }, [a.shots]);

  // Load the matched caption font so the preview renders in it. Returns
  // the CSS family once the font is fetched + injected, else null (preview
  // falls back to a generic bold sans).
  const matchedFontId = a.caption_style?.font_family ?? '';
  const [previewFontFamily, setPreviewFontFamily] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setPreviewFontFamily(null);
    if (!matchedFontId) return;
    let cancelled = false;
    void window.api.getFontDataUrl(matchedFontId).then((dataUrl) => {
      if (cancelled || !dataUrl) return;
      const family = `cap-${matchedFontId}`;
      injectFontFace(family, dataUrl);
      setPreviewFontFamily(family);
    });
    return () => {
      cancelled = true;
    };
  }, [matchedFontId]);

  /** Seek the preview video to a shot's start and play it (muted), so
   *  clicking a moment jumps the footage to exactly when it happens. */
  const seekToShot = (idx: number): void => {
    setActiveShotIdx(idx);
    const v = videoRef.current;
    const shot = a.shots[idx];
    if (!v || !shot) return;
    try {
      v.currentTime = shot.start_ms / 1000;
      void v.play().catch(() => {
        /* autoplay policies — first frame still seeks */
      });
    } catch {
      /* seeking before metadata loads — ignore */
    }
  };

  /** Seek the preview to an exact ms (used by the SFX timeline markers). */
  const seekToMs = (ms: number): void => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = ms / 1000;
      void v.play().catch(() => {});
    } catch {
      /* ignore */
    }
  };

  const activeShot = activeShotIdx != null ? a.shots[activeShotIdx] : null;
  const hook = a.hook_speech || a.hook_text;
  const hookSecs =
    a.hook_duration_ms != null ? (a.hook_duration_ms / 1000).toFixed(1) : null;
  const faceSpot =
    a.face_region_dominant && a.face_region_dominant !== 'mixed'
      ? a.face_region_dominant.replace(/_/g, ' ')
      : a.face_region_dominant ?? '—';

  // Total duration for the scene-segment strip — fall back to the reel
  // duration if shots don't cover the full length.
  const lastEnd = a.shots.length ? a.shots[a.shots.length - 1].end_ms : 0;
  const totalMs = Math.max(lastEnd, reel.duration_ms, 1);

  // Clip-type rows, largest share first; skip empty buckets.
  const onScreen = CLIP_TYPE_ORDER.map((t) => ({
    type: t,
    value: a.clip_type_distribution[t] ?? 0,
  }))
    .filter((r) => r.value > 0.005)
    .sort((x, y) => y.value - x.value);

  // Camera-motion rows (optical flow). Skip 'none' in the bars — the
  // headline already states the moving vs static share. Empty when the
  // motion pass didn't run.
  const motionDist = a.camera_motion_distribution;
  const motionRows = motionDist
    ? (Object.keys(MOTION_META) as CameraMotionKind[])
        .filter((k) => k !== 'none')
        .map((k) => ({ kind: k, value: motionDist[k] ?? 0 }))
        .filter((r) => r.value > 0.005)
        .sort((x, y) => y.value - x.value)
    : [];
  const movingPct = motionDist ? Math.round((1 - motionDist.none) * 100) : null;

  // Every face-bearing shot, in playback order, with its original index
  // (needed to seek). Each row shows when (time range) + where (face
  // region) and is clickable to jump the preview there.
  const talkingMoments = a.shots
    .map((shot, idx) => ({ shot, idx }))
    .filter(({ shot }) => TALKING_TYPES.includes(shot.clip_type));

  const layerReview = React.useMemo(() => {
    const shotLayers = a.shots.map((shot) => shotLayerBreakdown(shot));
    const mediaCounts = new Map<string, number>();
    const overlayKinds = new Map<string, number>();
    const captionPlacements = new Map<string, number>();
    let textOverlayShots = 0;
    let mediaOverlayShots = 0;
    let noOverlayShots = 0;
    let noCaptionShots = 0;

    for (const shot of a.shots) {
      const mediaLabel =
        CLIP_META[shot.clip_type]?.label ?? shot.clip_type.replace(/_/g, ' ');
      mediaCounts.set(mediaLabel, (mediaCounts.get(mediaLabel) ?? 0) + 1);
      const captionLikeText = (shot.text_moments ?? []).filter(
        (text) => text.role !== 'image_text' && isMeaningfulLayerText(text.text),
      );
      if (captionLikeText.length > 0) textOverlayShots += 1;
      const inferredOverlay = inferredVisualLayerCue(shot);
      if (inferredOverlay) {
        mediaOverlayShots += 1;
      } else {
        noOverlayShots += 1;
      }
      if (captionLikeText.length === 0) {
        noCaptionShots += 1;
      }
      for (const text of captionLikeText) {
        const label = regionLabel(text.region);
        captionPlacements.set(label, (captionPlacements.get(label) ?? 0) + 1);
      }
      for (const overlay of shot.overlays ?? []) {
        const label = `${overlay.kind.replace(/_/g, ' ')} ${regionLabel(overlay.region)}`;
        overlayKinds.set(label, (overlayKinds.get(label) ?? 0) + 1);
      }
      if (inferredOverlay && (shot.overlays ?? []).length === 0) {
        const detail = inferredVisualLayerDetail(shot);
        const label = detail
          ? detail.replace(/^inferred\s+/i, '').split(':')[0]
          : inferredOverlay;
        overlayKinds.set(label, (overlayKinds.get(label) ?? 0) + 1);
      }
    }

    return {
      shotLayers,
      mediaCounts: [...mediaCounts.entries()].sort((x, y) => y[1] - x[1]),
      overlayKinds: [...overlayKinds.entries()].sort((x, y) => y[1] - x[1]),
      captionPlacements: [...captionPlacements.entries()].sort(
        (x, y) => y[1] - x[1],
      ),
      textOverlayShots,
      mediaOverlayShots,
      noOverlayShots,
      noCaptionShots,
    };
  }, [a.shots]);

  // The SFX onset closest to the current playback position (within a small
  // window) — drives the on-video badge + the highlighted timeline marker.
  const SFX_BADGE_WINDOW_MS = 220;
  let activeSfx: { ms: number; type: string; label?: string } | null = null;
  for (const e of sfxDetected.events) {
    const d = Math.abs(e.ms - playMs);
    if (d <= SFX_BADGE_WINDOW_MS && (!activeSfx || d < Math.abs(activeSfx.ms - playMs))) {
      activeSfx = e;
    }
  }

  return (
    <div className="az-grid">
      {/* ---------- left: reel preview + meta ---------- */}
      <aside className="az-left">
        <div className="az-phone">
          <div className="az-segments">
            {a.shots.map((s, i) => (
              <button
                key={i}
                type="button"
                className={`az-seg ${i === activeShotIdx ? 'active' : ''}`}
                style={{
                  flexGrow: Math.max(1, s.end_ms - s.start_ms),
                  background: CLIP_META[s.clip_type].color,
                }}
                title={`${CLIP_META[s.clip_type].label} · ${msRange(s.start_ms, s.end_ms)}`}
                onClick={() => seekToShot(i)}
              />
            ))}
          </div>
          {sfxDetected.events.length > 0 && (
            <div className="az-sfx-markers" aria-hidden={false}>
              {sfxDetected.events.map((e, i) => (
                <button
                  key={i}
                  type="button"
                  className={`az-sfx-marker ${activeSfx && activeSfx.ms === e.ms ? 'active' : ''}`}
                  style={{
                    left: `${(e.ms / totalMs) * 100}%`,
                    background: SFX_TYPE_COLORS[e.type] ?? '#fff',
                  }}
                  title={`${e.label ?? SFX_TYPE_LABELS[e.type] ?? e.type} · ${(e.ms / 1000).toFixed(2)}s`}
                  onClick={() => seekToMs(e.ms)}
                />
              ))}
            </div>
          )}
          {reel.playable_url ? (
            <video
              ref={videoRef}
              className="az-phone-video"
              src={reel.playable_url}
              muted
              loop
              playsInline
              autoPlay
              onTimeUpdate={(e) =>
                setPlayMs(e.currentTarget.currentTime * 1000)
              }
            />
          ) : (
            <div className="az-phone-novideo">
              preview unavailable
              <span>source link expired</span>
            </div>
          )}
          {activeSfx && (
            <div
              key={activeSfx.ms}
              className="az-sfx-pop"
              style={{
                borderColor: SFX_TYPE_COLORS[activeSfx.type] ?? '#fff',
                color: SFX_TYPE_COLORS[activeSfx.type] ?? '#fff',
              }}
            >
              <span
                className="az-sfx-pop-dot"
                style={{ background: SFX_TYPE_COLORS[activeSfx.type] ?? '#fff' }}
              />
              {activeSfx.label ?? SFX_TYPE_LABELS[activeSfx.type] ?? activeSfx.type}
            </div>
          )}
          {activeShot?.face_bbox && (
            <div
              className="az-facebox"
              style={{
                left: `${activeShot.face_bbox.x * 100}%`,
                top: `${activeShot.face_bbox.y * 100}%`,
                width: `${activeShot.face_bbox.w * 100}%`,
                height: `${activeShot.face_bbox.h * 100}%`,
                borderColor: CLIP_META[activeShot.clip_type].color,
              }}
            />
          )}
          {hook && (
            <div className="az-phone-caption">
              <span className="az-phone-handle">@you</span>
              {hook}
            </div>
          )}
        </div>

        <div className="az-meta">
          <div className="az-meta-head">
            <span className="az-meta-source">reel source</span>
            <span className="az-meta-badge">{PLATFORM_BADGE[reel.platform]}</span>
          </div>
          <dl className="az-meta-facts">
            <div>
              <dt>length</dt>
              <dd>{(reel.duration_ms / 1000).toFixed(1)} s</dd>
            </div>
            <div>
              <dt>face spot</dt>
              <dd>{faceSpot}</dd>
            </div>
            <div>
              <dt>sfx rate</dt>
              <dd>{a.sfx_per_min.toFixed(1)} /min</dd>
            </div>
          </dl>
        </div>
      </aside>

      {/* ---------- right: hook + metrics ---------- */}
      <div className="az-right">
        {hook && (
          <div className="az-hook">
            <div className="az-hook-eyebrow">
              The hook{hookSecs ? ` · first ${hookSecs}s` : ''}
            </div>
            <div className="az-hook-text">“{hook}”</div>
          </div>
        )}

        <div className="az-viewtoggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={azView === 'insights'}
            className={`az-viewtoggle-btn ${azView === 'insights' ? 'on' : ''}`}
            onClick={() => setAzView('insights')}
          >
            Insights
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={azView === 'brief'}
            className={`az-viewtoggle-btn ${azView === 'brief' ? 'on' : ''}`}
            onClick={() => setAzView('brief')}
          >
            Brief
          </button>
        </div>

        {azView === 'brief' ? (
          <ReelBrief reel={reel} a={a} />
        ) : (
          <>
        {a.style_signature && (
          <section className="az-section">
            <h3 className="az-section-title">
              Clipnosis signature{' '}
              <span className="az-section-count">
                proprietary edit fingerprint · {Math.round(a.style_signature.confidence * 100)}% confidence
              </span>
            </h3>
            <div className="az-signature-panel">
              <div className="az-signature-summary">
                {a.style_signature.summary}
              </div>
              <div className="az-signature-kpis">
                <span>
                  Tempo <b>{a.style_signature.rhythm.tempo}</b>
                </span>
                <span>
                  Shots <b>{a.style_signature.shot_count}</b>
                </span>
                <span>
                  Median <b>{(a.style_signature.rhythm.median_shot_ms / 1000).toFixed(1)}s</b>
                </span>
                <span>
                  Cuts/sec <b>{a.style_signature.rhythm.cuts_per_sec.toFixed(2)}</b>
                </span>
              </div>
              <div className="az-signature-grid">
                <div>
                  <span className="az-signature-label">Layer grammar</span>
                  <div className="az-signature-tokens">
                    {a.style_signature.grammar.layer_sequence.slice(0, 6).map((token) => (
                      <span key={token}>{token}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="az-signature-label">Layout grammar</span>
                  <div className="az-signature-tokens">
                    {a.style_signature.grammar.layout_sequence.slice(0, 6).map((token) => (
                      <span key={token}>{token}</span>
                    ))}
                  </div>
                </div>
              </div>
              {a.style_signature.script_visual_rules.length > 0 && (
                <div className="az-signature-rules">
                  <span className="az-signature-label">Script to visual rules</span>
                  {a.style_signature.script_visual_rules.slice(0, 4).map((rule, idx) => (
                    <div className="az-signature-rule" key={`${rule.visual_response}-${idx}`}>
                      <b>
                        when {rule.trigger_keywords.join(', ') || 'matched beat'}
                      </b>
                      <span>show {rule.visual_response}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="az-signature-rules">
                <span className="az-signature-label">Reproduction rules</span>
                {a.style_signature.reproduction_rules.slice(0, 6).map((rule, idx) => (
                  <div className="az-signature-rule" key={idx}>
                    <span>{rule}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="az-section">
          <h3 className="az-section-title">Pacing &amp; build</h3>
          <div className="az-stats">
            <StatCard value={String(a.shots.length)} label="scenes" />
            <StatCard
              value={(a.median_shot_ms / 1000).toFixed(1)}
              unit="s"
              label="median shot"
            />
            <StatCard
              value={a.cuts_per_sec.toFixed(1)}
              label="cuts / second"
            />
            <StatCard
              value={`${Math.round(a.text_overlay_pct * 100)}%`}
              label="has on-screen text"
              bar={a.text_overlay_pct}
              barColor="var(--accent)"
            />
            <StatCard
              value={`${Math.round(a.talking_pct * 100)}%`}
              label="talking head"
              bar={a.talking_pct}
              barColor="var(--az-blue)"
            />
            <StatCard
              value={`${Math.round(a.real_speaker_pct * 100)}%`}
              label="real speaker"
              bar={a.real_speaker_pct}
              barColor="var(--az-purple)"
            />
          </div>
        </section>

        <section className="az-section">
          <h3 className="az-section-title">
            Layer split{' '}
            <span className="az-section-count">
              media, visual overlays, text/captions
            </span>
          </h3>
          <div className="az-layer-panel">
            <div className="az-layer-summary">
              <div className="az-layer-summary-col">
                <span className="az-layer-kicker">Layer 1 · Media</span>
                <div className="az-layer-chips">
                  {layerReview.mediaCounts.slice(0, 4).map(([label, count]) => (
                    <span key={label} className="az-layer-chip">
                      {label}
                      <b>{count}/{a.shots.length}</b>
                    </span>
                  ))}
                </div>
              </div>
              <div className="az-layer-summary-col">
                <span className="az-layer-kicker">Layer 2 · Visual overlay</span>
                <div className="az-layer-chips">
                  <span className="az-layer-chip">
                    visual layer
                    <b>{layerReview.mediaOverlayShots}/{a.shots.length}</b>
                  </span>
                  <span className="az-layer-chip">
                    none
                    <b>{layerReview.noOverlayShots}/{a.shots.length}</b>
                  </span>
                </div>
                {layerReview.overlayKinds.length > 0 && (
                  <p className="az-layer-note">
                    Common overlay placements:{' '}
                    {layerReview.overlayKinds
                      .slice(0, 3)
                      .map(([label, count]) => `${label} (${count})`)
                      .join(', ')}
                  </p>
                )}
              </div>
              <div className="az-layer-summary-col">
                <span className="az-layer-kicker">Layer 3 · Text/captions</span>
                <div className="az-layer-chips">
                  <span className="az-layer-chip">
                    text/captions
                    <b>{layerReview.textOverlayShots}/{a.shots.length}</b>
                  </span>
                  <span className="az-layer-chip">
                    none
                    <b>{layerReview.noCaptionShots}/{a.shots.length}</b>
                  </span>
                </div>
                {layerReview.captionPlacements.length > 0 && (
                  <p className="az-layer-note">
                    Common caption placements:{' '}
                    {layerReview.captionPlacements
                      .slice(0, 3)
                      .map(([label, count]) => `${label} (${count})`)
                      .join(', ')}
                  </p>
                )}
              </div>
            </div>
            <div className="az-layer-shots">
              {a.shots.map((shot, idx) => {
                const layers = layerReview.shotLayers[idx];
                const meta = CLIP_META[shot.clip_type];
                return (
                  <button
                    key={idx}
                    type="button"
                    className={`az-layer-shot ${idx === activeShotIdx ? 'active' : ''}`}
                    style={{ ['--layer-shot-color' as string]: meta.color }}
                    onClick={() => seekToShot(idx)}
                  >
                    <span className="az-layer-shot-head">
                      <span>Shot {idx + 1}</span>
                      <span>{msRange(shot.start_ms, shot.end_ms)}</span>
                    </span>
                    <span className="az-layer-stack">
                      <span className="az-layer-row">
                        <span className="az-layer-name">L1 Media</span>
                        <span className="az-layer-items">
                          {layers.media.map((item, i) => (
                            <span key={i}>{item}</span>
                          ))}
                        </span>
                      </span>
                      <span className="az-layer-row">
                        <span className="az-layer-name">L2 Visual Overlay</span>
                        <span className="az-layer-items">
                          {layers.overlays.map((item, i) => (
                            <span key={i}>{item}</span>
                          ))}
                        </span>
                      </span>
                      <span className="az-layer-row">
                        <span className="az-layer-name">L3 Text/Captions</span>
                        <span className="az-layer-items">
                          {layers.captions.map((item, i) => (
                            <span key={i}>{item}</span>
                          ))}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {onScreen.length > 0 && (
          <section className="az-section">
            <h3 className="az-section-title">What's on screen</h3>
            <div className="az-panel">
              {onScreen.map((r) => (
                <BarRow
                  key={r.type}
                  label={CLIP_META[r.type].label}
                  value={r.value}
                  color={CLIP_META[r.type].color}
                />
              ))}
            </div>
          </section>
        )}

        {movingPct !== null && (
          <section className="az-section">
            <h3 className="az-section-title">
              Camera motion{' '}
              <span className="az-section-count">
                {movingPct}% of shots move
                {a.camera_motion_confidence != null
                  ? ` · ${Math.round(a.camera_motion_confidence * 100)}% conf`
                  : ''}
              </span>
            </h3>
            <div className="az-panel">
              {motionRows.length > 0 ? (
                motionRows.map((r) => (
                  <BarRow
                    key={r.kind}
                    label={MOTION_META[r.kind].label}
                    value={r.value}
                    color={MOTION_META[r.kind].color}
                  />
                ))
              ) : (
                <div className="az-empty-note">
                  Mostly static holds — no significant camera movement detected.
                </div>
              )}
            </div>
          </section>
        )}

        {talkingMoments.length > 0 && (
          <section className="az-section">
            <h3 className="az-section-title">
              Talking-head moments{' '}
              <span className="az-section-count">
                {talkingMoments.length} · click to jump
              </span>
            </h3>
            <div className="az-moments">
              {talkingMoments.map(({ shot, idx }) => {
                const meta = CLIP_META[shot.clip_type];
                return (
                  <button
                    key={idx}
                    type="button"
                    className={`az-moment ${idx === activeShotIdx ? 'active' : ''}`}
                    style={{ ['--moment-color' as string]: meta.color }}
                    onClick={() => seekToShot(idx)}
                  >
                    <span className="az-moment-bar" />
                    <span className="az-moment-main">
                      <span className="az-moment-head">
                        <span className="az-moment-type">{meta.label}</span>
                        <span className="az-moment-time">
                          {msRange(shot.start_ms, shot.end_ms)}
                        </span>
                      </span>
                      <span className="az-moment-sub">
                        <RegionGlyph
                          region={shot.face_region}
                          color={meta.color}
                        />
                        <span className="az-moment-where">
                          {shot.face_region
                            ? shot.face_region.replace(/_/g, ' ')
                            : 'no face'}
                        </span>
                        <span className="az-moment-conf">
                          {Math.round(shot.speaker_confidence * 100)}% conf
                        </span>
                        {shot.detected_motion &&
                          shot.detected_motion.kind !== 'none' && (
                            <span className="az-moment-motion">
                              {MOTION_META[shot.detected_motion.kind].label}
                            </span>
                          )}
                      </span>
                      {shot.visual_caption && (
                        <span className="az-moment-caption">
                          {shot.visual_caption}
                        </span>
                      )}
                    </span>
                    <span className="az-moment-play">▶</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {a.caption_style?.present && (
          <section className="az-section">
            <h3 className="az-section-title">Subtitle style</h3>
            <div className="az-panel">
              {a.caption_style.preset_label && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      opacity: 0.6,
                    }}
                  >
                    Matches
                  </span>
                  <span
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      padding: '2px 10px',
                      borderRadius: 6,
                      background: 'rgba(120,140,255,0.18)',
                    }}
                  >
                    {a.caption_style.preset_label}
                  </span>
                  <span style={{ fontSize: 12, opacity: 0.55 }}>
                    {Math.round(a.caption_style.preset_confidence * 100)}% fit
                  </span>
                </div>
              )}
              {a.caption_style.style_label && (
                <div
                  style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}
                >
                  {a.caption_style.style_label}
                </div>
              )}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  rowGap: 6,
                  columnGap: 14,
                  fontSize: 13,
                }}
              >
                {(
                  [
                    ['Position', a.caption_style.position],
                    ['Chunking', a.caption_style.chunking],
                    [
                      'Words/group',
                      a.caption_style.words_per_chunk > 0
                        ? String(a.caption_style.words_per_chunk)
                        : '',
                    ],
                    ['Size', a.caption_style.font_size],
                    ['Emphasis', a.caption_style.emphasis],
                    ['Casing', a.caption_style.casing],
                    ['Animation', a.caption_style.animation],
                    [
                      'Font',
                      a.caption_style.font_family_name
                        ? `${a.caption_style.font_family_name} — ${a.caption_style.font_descriptor}`
                        : a.caption_style.font_descriptor,
                    ],
                    ['Text color', a.caption_style.text_color],
                    ['Treatment', a.caption_style.text_treatment],
                    [
                      'Border/BG color',
                      a.caption_style.treatment_color ?? '',
                    ],
                    ['Highlight', a.caption_style.highlight_color ?? ''],
                    ['Emoji', a.caption_style.has_emoji ? 'yes' : 'no'],
                  ] as [string, string][]
                )
                  .filter(([, v]) => v.length > 0)
                  .map(([label, v]) => (
                    <React.Fragment key={label}>
                      <span style={{ opacity: 0.6 }}>{label}</span>
                      <span>{v.replace(/_/g, ' ')}</span>
                    </React.Fragment>
                  ))}
              </div>

              {/* Shuffle the legibility treatment + its color. Seeded
                  from the detected style; the user can override. */}
              <div
                style={{
                  marginTop: 14,
                  paddingTop: 12,
                  borderTop: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.6,
                    marginBottom: 8,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Treatment
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  {(
                    ['bordered', 'backgrounded', 'clear'] as CaptionTreatment[]
                  ).map((t) => (
                    <button
                      key={t}
                      onClick={() => setSubTreatment(t)}
                      style={{
                        flex: 1,
                        padding: '6px 8px',
                        fontSize: 12,
                        borderRadius: 6,
                        cursor: 'pointer',
                        textTransform: 'capitalize',
                        border:
                          subTreatment === t
                            ? '1px solid rgba(120,140,255,0.9)'
                            : '1px solid rgba(255,255,255,0.12)',
                        background:
                          subTreatment === t
                            ? 'rgba(120,140,255,0.18)'
                            : 'transparent',
                        color: 'inherit',
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                {subTreatment !== 'clear' && (
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                      marginBottom: 10,
                    }}
                  >
                    <span style={{ opacity: 0.6 }}>
                      {subTreatment === 'bordered' ? 'Border' : 'Background'}{' '}
                      color
                    </span>
                    <input
                      type="color"
                      value={subTreatmentColor}
                      onChange={(e) => setSubTreatmentColor(e.target.value)}
                      style={{
                        width: 32,
                        height: 24,
                        padding: 0,
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                      }}
                    />
                    <span style={{ opacity: 0.55 }}>{subTreatmentColor}</span>
                  </label>
                )}
                {/* Live preview of the chosen treatment. */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    padding: '14px 8px',
                    borderRadius: 8,
                    background:
                      'repeating-conic-gradient(#2a2a2a 0% 25%, #1f1f1f 0% 50%) 50% / 18px 18px',
                  }}
                >
                  <span
                    style={{
                      fontSize: 34,
                      fontWeight: 800,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      fontFamily: previewFontFamily ?? undefined,
                      color:
                        namedColorToHex(a.caption_style.text_color) ??
                        '#ffe000',
                      ...(subTreatment === 'bordered'
                        ? {
                            WebkitTextStroke: `2px ${subTreatmentColor}`,
                          }
                        : subTreatment === 'backgrounded'
                          ? {
                              background: subTreatmentColor,
                              padding: '2px 10px',
                              borderRadius: 4,
                            }
                          : {
                              textShadow: '0 2px 6px rgba(0,0,0,0.6)',
                            }),
                    }}
                  >
                    People
                  </span>
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="az-section">
          <h3 className="az-section-title">Sound mix</h3>
          <div className="az-panel">
            <BarRow
              label="Voiceover"
              value={a.voiceover_pct}
              color="var(--az-green)"
            />
            <BarRow
              label="Music bed"
              value={a.music_pct}
              color="var(--az-gold)"
            />
            <BarRow
              label="Silence"
              value={a.audio_silence_pct}
              color="var(--az-gray)"
            />
          </div>
        </section>

        {sfxDetected.types.length > 0 && (
          <section className="az-section">
            <h3 className="az-section-title">SFX</h3>
            <div className="az-panel">
              <div className="az-sfx-types">
                <span className="az-sfx-types-label">types detected</span>
                <div className="az-sfx-chips">
                  {sfxDetected.types.map(([type, n]) => (
                    <span key={type} className="az-sfx-chip">
                      <span
                        className="az-sfx-chip-dot"
                        style={{ background: SFX_TYPE_COLORS[type] ?? '#fff' }}
                      />
                      {SFX_TYPE_LABELS[type] ?? type}
                      <span className="az-sfx-chip-n">{n}</span>
                    </span>
                  ))}
                </div>
              </div>
              {sfxDetected.labels.length > 0 && (
                <div className="az-sfx-types">
                  <span className="az-sfx-types-label">sounds</span>
                  <div className="az-sfx-chips">
                    {sfxDetected.labels.slice(0, 8).map(([label, n]) => (
                      <span key={label} className="az-sfx-chip">
                        {label}
                        <span className="az-sfx-chip-n">{n}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {a.sfx_context && a.sfx_context.signals.sfx_count > 0 && (
                <>
                  <p className="az-sfx-summary">
                    {a.sfx_context.pattern_summary}
                  </p>
                  <div className="az-stats">
                    <StatCard
                      value={a.sfx_context.signals.sfx_per_word.toFixed(2)}
                      label="SFX / word"
                    />
                    <StatCard
                      value={`${Math.round(a.sfx_context.signals.on_word_pct * 100)}%`}
                      label="land on a word"
                      bar={a.sfx_context.signals.on_word_pct}
                      barColor="var(--az-gold)"
                    />
                    <StatCard
                      value={
                        a.sfx_context.signals.hook_escalation >= 0.2
                          ? 'yes'
                          : 'no'
                      }
                      label="hook escalation"
                    />
                  </div>
                  {a.sfx_context.rules.length > 0 && (
                    <ul className="az-sfx-rules">
                      {a.sfx_context.rules.map((r, i) => (
                        <li key={i}>
                          <span className="az-sfx-rule-type">
                            {SFX_TYPE_LABELS[r.sfx_type] ?? r.sfx_type}
                          </span>
                          {' — '}
                          {r.trigger}
                          {r.example ? ` (e.g. “${r.example}”)` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </section>
        )}
          </>
        )}
      </div>
    </div>
  );
}

/** Public App component: AppInner wrapped in an error boundary so a
 *  render-time crash shows a fallback message instead of unmounting
 *  the whole tree. */
export function App(): React.JSX.Element {
  return (
    <AppErrorBoundary>
      <AppInner />
    </AppErrorBoundary>
  );
}
