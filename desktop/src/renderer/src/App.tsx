import React, { useEffect, useState } from 'react';
import type {
  AgentTrace,
  AgentTurn,
  AlternativeShot,
  AnalyzeHistoryEntry,
  ClipType,
  CurationResult,
  CuratorClarificationRequest,
  CuratorTurnEvent,
  ExtractClipsResponse,
  ExtractProgressEvent,
  ExtractedClip,
  FrameRegion,
  LibraryReel,
  MediaCandidate,
  PlanListEntry,
  RecordPageResponse,
  RecordProgressEvent,
  ReelAnalysisResult,
  ReelTag,
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
  SuggestedEdit,
  SynthesizeProgress,
  TargetInput,
  VideoFrame,
  VideoFrameProgressEvent,
  VideoFramesResponse,
} from './global';

type ViewMode = 'workflow' | 'analyze';

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
type Stage = 'inspire' | 'target' | 'plan' | 'review';

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
function getSelections(shot: ShotPlan | undefined): SelectedMedia[] {
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

function AppInner(): React.JSX.Element {
  const [view, setView] = useState<ViewMode>('workflow');
  const [stage, setStage] = useState<Stage>('inspire');
  const [progress, setProgress] = useState<StageProgress>({});
  const [devtools, setDevtools] = useDevtoolsState();

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
  analysis?: ReelAnalysisResult;
}

type Busy = null | 'hydrating' | 'synthesizing' | 'curating';

type TargetMode = 'reel_url' | 'script' | 'local_video';

interface WorkflowViewProps {
  stage: Stage;
  setStage: (s: Stage) => void;
  setStageDone: (s: Stage, done: boolean) => void;
}

/** Shared context for the inner timeline so the plan top bar's
 *  "Find media for all" + "Preview reel" buttons can reach the
 *  curate handler from the parent workflow. */
interface PlanTopActions {
  onCurateAll: () => void;
  curating: boolean;
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

function WorkflowView({
  stage,
  setStage,
  setStageDone,
}: WorkflowViewProps): React.JSX.Element {
  const [library, setLibrary] = useState<LibraryRow[]>([]);
  const [draftUrl, setDraftUrl] = useState('');
  const [draftTags, setDraftTags] = useState<ReelTag[]>(['content_reference']);

  const [targetMode, setTargetMode] = useState<TargetMode>('reel_url');
  const [targetUrl, setTargetUrl] = useState('');
  const [targetScript, setTargetScript] = useState('');
  const [targetFile, setTargetFile] = useState<string | null>(null);
  const [allowCopyrightedMedia, setAllowCopyrightedMedia] = useState(false);
  const [userInstructions, setUserInstructions] = useState('');

  const [plan, setPlan] = useState<SuggestedEdit | null>(null);
  const [curation, setCuration] = useState<CurationResult | null>(null);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
    latest?: ShotCuration;
  } | null>(null);
  const [synthProgress, setSynthProgress] = useState<SynthesizeProgress | null>(
    null,
  );
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

  // Subscribe to curate progress events.
  useEffect(() => {
    const unsubscribe = window.api.onCurateProgress(
      ({ curation: c, completed, total }) => {
        setProgress({ completed, total, latest: c });
      },
    );
    return unsubscribe;
  }, []);

  // Subscribe to synthesis progress events (milestones + streaming).
  useEffect(() => {
    const unsubscribe = window.api.onSynthesizeProgress((p) => {
      setSynthProgress(p);
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
      setPlan(loaded.plan);
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
      setTurnsByShot((prev) => {
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
      });
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
      setPendingClarifications((prev) => {
        const next = new Map(prev);
        next.set(req.shot_idx, req);
        return next;
      });
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

  // On mount: load the persisted library list, then for each URL try
  // its cached analysis. Cache hits show as 'ready' without forcing a
  // re-analyze on app launch; misses stay 'pending' until the user
  // clicks Hydrate.
  const initialLoadDone = React.useRef(false);
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    (async () => {
      const persisted = await window.api.loadLibrary();
      if (persisted.length === 0) return;
      const rows: LibraryRow[] = persisted.map((r) => ({
        url: r.url,
        tags: r.tags,
        status: 'pending',
      }));
      setLibrary(rows);
      // Fill in cached analyses (fast — disk read only).
      const updates = await Promise.all(
        persisted.map(async (r) => {
          const analysis = await window.api.loadCachedAnalysis(r.url);
          return { url: r.url, analysis };
        }),
      );
      setLibrary((prev) =>
        prev.map((row) => {
          const u = updates.find((x) => x.url === row.url);
          if (u && u.analysis) {
            return {
              ...row,
              status: 'ready',
              from_cache: true,
              analysis: u.analysis,
            };
          }
          return row;
        }),
      );
    })();
  }, []);

  // Auto-save library (URLs + tags) whenever it changes.
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const slim = library.map((r) => ({ url: r.url, tags: r.tags }));
    window.api.saveLibrary(slim).catch(() => {
      /* best-effort; surface error elsewhere if it matters */
    });
  }, [library]);

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

  const buildPlan = async (): Promise<void> => {
    const ready = library.filter(
      (r): r is LibraryRow & { analysis: ReelAnalysisResult } =>
        r.status === 'ready' && !!r.analysis,
    );
    if (ready.length === 0) {
      setError('Hydrate the library first.');
      return;
    }
    const target = buildTarget();
    if (typeof target === 'string') {
      setError(target);
      return;
    }
    setBusy('synthesizing');
    setPlan(null);
    setCuration(null);
    setError(null);
    setSynthProgress(null);
    try {
      const synth = await window.api.synthesizePlan({
        library: ready.map((r) => ({
          url: r.url,
          tags: r.tags,
          analysis: r.analysis,
        })),
        target,
        allowCopyrightedMedia,
        userInstructions,
      });
      setPlan(synth);
      refreshPastPlans();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const pickFile = async (): Promise<void> => {
    const filePath = await window.api.pickVideoFile();
    if (filePath) setTargetFile(filePath);
  };

  const approveCurate = async (): Promise<void> => {
    if (!plan) return;
    setBusy('curating');
    setProgress({ completed: 0, total: plan.shots.length });
    setTurnsByShot(new Map());
    setExpandedShots(new Set());
    setPendingClarifications(new Map());
    setClarificationTyping(new Map());
    setError(null);
    try {
      const result = await window.api.curatePlan(plan);
      setCuration(result);
      setProgress(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
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
    try {
      const result = await window.api.regenerateShot({
        shot_idx: shotIdx,
        user_prompt: userPrompt,
      });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setCuration((prev) => {
        if (!prev) return prev;
        const nextShots = prev.shots.map((s) =>
          s != null && s.shot_idx === shotIdx ? result.curation : s,
        );
        const nextTraces = prev.traces.map((t, i) =>
          plan && plan.shots[i].shot_idx === shotIdx ? result.trace : t,
        );
        return { ...prev, shots: nextShots, traces: nextTraces };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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

  const readyCount = library.filter((r) => r.status === 'ready').length;
  const targetReady =
    (targetMode === 'reel_url' && targetUrl.trim().length > 0) ||
    (targetMode === 'script' && targetScript.trim().length > 0) ||
    (targetMode === 'local_video' && targetFile !== null);
  const canBuildPlan = !busy && readyCount > 0 && targetReady;
  const canCurate = !busy && plan !== null;

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
                  <div className="library-url">{r.url}</div>
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
            What you're editing. Pick one input mode — paste a reel link to
            transcribe, write the script yourself, or upload footage you've
            already shot.
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
              Pick a local video or audio file. We extract its audio via
              ffmpeg and transcribe with Whisper.
            </p>
            <div className="row">
              <button className="btn" onClick={pickFile}>
                Pick file…
              </button>
              <div className="target-file">
                {targetFile ?? <span className="text-muted">no file selected</span>}
              </div>
              {targetFile && (
                <button
                  className="btn btn-mini"
                  onClick={() => setTargetFile(null)}
                >
                  ✕
                </button>
              )}
            </div>
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
        <label className="copyright-toggle">
          <input
            type="checkbox"
            checked={allowCopyrightedMedia}
            onChange={(e) => setAllowCopyrightedMedia(e.target.checked)}
            disabled={busy === 'synthesizing'}
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
          disabled={busy === 'synthesizing'}
        />
        <div className="instructions-hint">
          {/\b(stock|pexels|pond5|getty|shutterstock|archival\s*footage)\b/i.test(userInstructions)
            ? '✓ stock_search ENABLED (detected in instructions). Default: web_capture.'
            : 'Methods allowed: web_capture only (plus library_search when library present). Stock, manual, and generative AI all disabled.'}
        </div>

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
            onClick={buildPlan}
          >
            {busy === 'synthesizing' ? 'Synthesizing…' : '✦ Synthesize edit plan'}
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
          {busy === 'curating' && (
            <div className="curate-actions" style={{ marginBottom: 14 }}>
              <button
                className="btn btn-stop"
                onClick={stopCurate}
                title="Cancel the in-flight curator agents"
              >
                ■ Stop curating
              </button>
              {progress?.latest && (
                <span className="progress-latest">
                  shot {progress.latest.shot_idx}:{' '}
                  {progress.latest.candidates.length} candidate(s) ·{' '}
                  {progress.latest.research_notes}
                </span>
              )}
            </div>
          )}

          <PlanReview
            plan={plan}
            onPlanChange={async (next) => {
              setPlan(next);
              // Persist asynchronously; errors surface in the banner.
              const result = await window.api.savePlan(next);
              if (!result.ok && result.error) setError(result.error);
            }}
            curation={curation}
            onCurateShot={curateOneShot}
            onRegenerate={regenerateShot}
            onContinue={continueOneShot}
            topActions={{
              onCurateAll: approveCurate,
              curating: busy === 'curating',
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
          />
          </>
        )}

      </section>
      )}
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

/** Distill a shot's curation state into one of four UI states for
 *  the timeline segment's status pip. */
function curationStatus(
  sc: ShotCuration | null,
): 'idle' | 'working' | 'ready' | 'fail' {
  if (!sc) return 'idle';
  if (sc.failure_reason && sc.candidates.length === 0) return 'fail';
  if (sc.candidates.length > 0) return 'ready';
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

function PlanReview({
  plan,
  onPlanChange,
  curation,
  onCurateShot,
  onRegenerate,
  onContinue,
  topActions,
  stageNav,
  agentActivity,
}: {
  plan: SuggestedEdit;
  onPlanChange: (next: SuggestedEdit) => void;
  curation: CurationResult | null;
  onCurateShot: (shotIdx: number, userPrompt?: string) => Promise<void>;
  onRegenerate: (shotIdx: number, userPrompt: string) => Promise<void>;
  onContinue: (shotIdx: number, userPrompt: string) => Promise<void>;
  topActions?: PlanTopActions;
  stageNav?: StageNav;
  agentActivity?: AgentActivity;
}): React.JSX.Element {
  const totalCandidates =
    curation?.shots.reduce((n, s) => n + (s?.candidates?.length ?? 0), 0) ?? 0;

  // Per-shot concept selection: shot_idx → chosen index into
  // shot.options. Absent = the synthesizer's primary (index 0). Held in
  // local state so picking doesn't persist on every click — it commits
  // to the plan only when the user confirms.
  const [selections, setSelections] = useState<Map<number, number>>(
    () => new Map(),
  );
  const [storyboardOpen, setStoryboardOpen] = useState(false);
  const selectOption = (shotIdx: number, optionIdx: number): void => {
    setSelections((prev) => {
      const next = new Map(prev);
      next.set(shotIdx, optionIdx);
      return next;
    });
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
  const deleteShot = (shotIdx: number): void => {
    onPlanChange({
      ...plan,
      shots: plan.shots.filter((s) => s.shot_idx !== shotIdx),
    });
  };

  // Selected shot for the detail box. Defaults to the first shot when
  // the plan loads; clears if the shot is deleted. Null shows the
  // "Select a shot" empty state below the timeline.
  const [selectedShotIdx, setSelectedShotIdx] = useState<number | null>(
    () => plan.shots[0]?.shot_idx ?? null,
  );
  useEffect(() => {
    if (
      selectedShotIdx !== null &&
      !plan.shots.find((s) => s.shot_idx === selectedShotIdx)
    ) {
      setSelectedShotIdx(plan.shots[0]?.shot_idx ?? null);
    }
  }, [plan.shots, selectedShotIdx]);

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

  return (
    <div className="plan-review">
      {/* compact header — eyebrow on top, then stats + bulk actions */}
      <div className="plan2-top">
        <div className="plan2-eyebrow eyebrow">Step 3 · The plan</div>
        <div className="plan2-top-row">
          <div className="plan2-stats">
            <b>{(plan.total_duration_ms / 1000).toFixed(1)}s</b>
            <span className="sep">·</span>
            <b>{plan.shots.length}</b> shots
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
          </div>
          {topActions && (
            <div className="plan2-top-actions">
              <button
                type="button"
                className="btn btn-ai"
                onClick={topActions.onCurateAll}
                disabled={topActions.curating || shotsNeedingMedia === 0}
                title={
                  shotsNeedingMedia === 0
                    ? 'All shots have media'
                    : `Run the research agent for ${shotsNeedingMedia} shot(s) still needing media`
                }
              >
                {topActions.curating
                  ? `Curating…${topActions.curatingProgress ? ` (${topActions.curatingProgress.completed}/${topActions.curatingProgress.total})` : ''}`
                  : `✦ Find media for all ${shotsNeedingMedia || ''}`}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={topActions.onPreview}
              >
                ▶ Preview reel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* horizontal timeline rail — each shot as a clickable segment.
          Width is proportional to duration_ms via flex-grow. */}
      <div className="htimeline-wrap">
        <div className="htimeline-rail">
          {plan.shots.map((s) => {
            const sc =
              curation?.shots.find(
                (c) => c != null && c.shot_idx === s.shot_idx,
              ) ?? null;
            const status = curationStatus(sc);
            return (
              <HSeg
                key={s.shot_idx}
                shot={s}
                selected={s.shot_idx === selectedShotIdx}
                status={status}
                onSelect={() => setSelectedShotIdx(s.shot_idx)}
              />
            );
          })}
        </div>
      </div>

      {/* detail box (left) + persistent phone preview sidebar (right).
          The body row keeps the detail box scrollable and the phone
          pinned next to it as the user navigates between shots. */}
      <div className="plan-review-body">
        {selectedShot ? (
          <div className="detail-box">
            <ShotRow
              key={selectedShot.shot_idx}
              shot={selectedShot}
              onChange={(patch) => updateShot(selectedShot.shot_idx, patch)}
              onDelete={() => deleteShot(selectedShot.shot_idx)}
              curation={selectedCuration}
              trace={selectedTrace}
              onCurateShot={onCurateShot}
              onRegenerate={onRegenerate}
              onContinue={onContinue}
              selectedOptionIdx={selections.get(selectedShot.shot_idx) ?? 0}
              onSelectOption={selectOption}
              stageNav={stageNav}
              agentActivity={agentActivity}
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
          selectedOptionIdx={
            selectedShot
              ? (selections.get(selectedShot.shot_idx) ?? 0)
              : 0
          }
        />
      </div>

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
              <ReelMockup shot={s} previewImageUrl={previewImageUrl} />
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
  trace,
  onCurateShot,
  onRegenerate,
  onContinue,
  selectedOptionIdx,
  onSelectOption,
  stageNav,
  agentActivity,
}: {
  shot: ShotPlan;
  onChange: (patch: Partial<ShotPlan>) => void;
  onDelete: () => void;
  curation: ShotCuration | null;
  trace?: AgentTrace;
  onCurateShot: (shotIdx: number, userPrompt?: string) => Promise<void>;
  onRegenerate: (shotIdx: number, userPrompt: string) => Promise<void>;
  onContinue: (shotIdx: number, userPrompt: string) => Promise<void>;
  /** Index into shot.options of the concept the user has picked. */
  selectedOptionIdx: number;
  onSelectOption: (shotIdx: number, optionIdx: number) => void;
  /** Stage back/next surfaced inside the media header. */
  stageNav?: StageNav;
  /** Live curator agent activity scoped to this shot. */
  agentActivity?: AgentActivity;
}): React.JSX.Element {
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchPrompt, setSearchPrompt] = useState('');
  const [curateBusy, setCurateBusy] = useState(false);
  // Pair each option with its original index so selection survives the
  // ideal/fallback split below.
  const withIdx = shot.options.map((opt, idx) => ({ opt, idx }));
  // The primary slot (index 0) is always shown as a top-line idea even
  // if it isn't tagged 'ideal' — it's what drives the mockup + curator.
  const ideaList = withIdx.filter(
    ({ opt, idx }) => idx === 0 || opt.tier === 'ideal',
  );
  const fallbackList = withIdx.filter(
    ({ opt, idx }) => idx !== 0 && opt.tier !== 'ideal',
  );

  // (The phone mockup used to live here as well; it now renders in the
  // persistent `.phone-sidebar` on the right side of the plan-review,
  // sourced from PlanReview's selectedShot + selections.)

  const picks = getSelections(shot);
  const candidateCount = curation?.candidates?.length ?? 0;
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
        {shot.spoken_during && (
          <div className="shot-spoken-quote">"{shot.spoken_during}"</div>
        )}

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

        <div className="ideas-header">
          {ideaList.length} idea{ideaList.length === 1 ? '' : 's'} · pick the one
          you like
        </div>
        <div className="option-grid" role="radiogroup">
          {ideaList.map(({ opt, idx }, i) => (
            <OptionCard
              key={idx}
              label={`idea ${i + 1}`}
              opt={opt}
              primary={idx === 0}
              selected={selectedOptionIdx === idx}
              onSelect={() => onSelectOption(shot.shot_idx, idx)}
            />
          ))}
        </div>

        {shot.text_overlay && (
          <div className="shot-text-overlay">
            <span className="shot-text-overlay-label">text overlay</span>
            "{shot.text_overlay}"
            <span className="shot-text-overlay-pos"> @ {shot.text_position}</span>
          </div>
        )}

        {fallbackList.length > 0 && (
          <>
            <button
              className="ladder-toggle"
              onClick={() => setFallbackOpen((v) => !v)}
            >
              {fallbackOpen ? '▾' : '▸'} {fallbackList.length} fallback option
              {fallbackList.length === 1 ? '' : 's'}
            </button>
            {fallbackOpen && (
              <div className="option-grid" role="radiogroup">
                {fallbackList.map(({ opt, idx }) => (
                  <OptionCard
                    key={idx}
                    label={opt.tier}
                    opt={opt}
                    selected={selectedOptionIdx === idx}
                    onSelect={() => onSelectOption(shot.shot_idx, idx)}
                  />
                ))}
              </div>
            )}
          </>
        )}

      </div>

      {/* RIGHT — media: header (with stage back/next) + curation + candidates */}
      <div className="mp-right">
        <div className="mp-media-head">
          <div className="mp-media-head-title">
            <span className="mp-media-title">Media</span>
            <span className="mp-media-sub">
              {candidateCount > 0
                ? `${candidateCount} option${candidateCount === 1 ? '' : 's'} · click to choose`
                : 'no options yet · run agent below'}
            </span>
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
            <div className="shot-selected-media-list">
              {picks.map((p, i) => (
                <span key={i} className="shot-selected-media-chip">
                  <span className="shot-selected-media-chip-idx">#{i + 1}</span>
                  <span className="shot-selected-media-chip-kind">
                    {p.kind} · {p.origin.replace(/_/g, ' ')}
                  </span>
                  <button
                    type="button"
                    className="shot-selected-media-chip-remove"
                    title="Remove this pick"
                    onClick={() => {
                      const next = picks.slice();
                      next.splice(i, 1);
                      onChange({ selected_media: next });
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-mini btn-ghost"
              onClick={() => onChange({ selected_media: [] })}
              title="Clear all picks"
            >
              clear all
            </button>
          </div>
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
    return 'Creator talking';
  }
  return 'Creator talking';
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
  const pending = activity.pendingClarifications.get(shotIdx);
  if (history.length === 0 && !pending) return null;

  const latest = history[history.length - 1];
  const isExpanded = activity.expandedShots.has(shotIdx);
  const visible = isExpanded ? history : latest ? [latest] : [];

  return (
    <div className="mp-agent-activity">
      <div className="mp-agent-activity-head">
        <span className="mp-agent-activity-title">live agent activity</span>
        {latest?.finished && (
          <span className="agent-turn-done">done</span>
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
      {pending && (
        <ShotClarification
          req={pending}
          typedText={activity.clarificationTyping.get(pending.request_id)}
          setClarificationTyping={activity.setClarificationTyping}
          answerClarification={activity.answerClarification}
        />
      )}
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
            return (
              <button
                key={i}
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
            );
          })}
        </div>
      )}
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
  selectedOptionIdx,
}: {
  shot: ShotPlan | null;
  curation: ShotCuration | null;
  selectedOptionIdx: number;
}): React.JSX.Element {
  const picks = getSelections(shot ?? undefined);
  const [pickIdx, setPickIdx] = useState(0);

  // Clamp/reset the pick index whenever the underlying picks change or
  // the user switches shots — otherwise stale indices point past the
  // end of the array and the preview blanks out.
  useEffect(() => {
    if (pickIdx >= picks.length) setPickIdx(0);
  }, [pickIdx, picks.length]);
  useEffect(() => {
    setPickIdx(0);
  }, [shot?.shot_idx]);

  if (!shot) {
    return (
      <aside className="phone-sidebar phone-sidebar-empty">
        <div className="phone-sidebar-eyebrow">Preview</div>
        <div className="phone-sidebar-placeholder">
          Pick a shot to preview it here.
        </div>
      </aside>
    );
  }

  const selOpt = shot.options[selectedOptionIdx] ?? shot.options[0];
  const previewShot: ShotPlan = selOpt
    ? {
        ...shot,
        broll_description: selOpt.broll_description,
        asset: selOpt.asset,
        placement: selOpt.placement,
        source_type: selOpt.source_type,
      }
    : shot;

  // Source the on-screen media: a confirmed pick if one is highlighted,
  // otherwise the top curated candidate's thumbnail so the user always
  // sees *something* once research has run.
  const currentPick = picks[pickIdx] ?? null;
  let previewSrc: string | null = null;
  let previewKind: PreviewKind = 'image';
  if (currentPick) {
    if (currentPick.kind === 'image') {
      previewSrc = currentPick.url;
      previewKind = 'image';
    } else if (isPlayableVideoUrl(currentPick.url)) {
      // A local clip/recording or a real video file — play it inline.
      previewSrc = currentPick.url;
      previewKind = 'video';
    } else {
      // A platform/page URL (YouTube watch, IG permalink, marketing
      // page). It can't decode in a <video>, so embed it when possible
      // and otherwise show a proxied poster frame — never feed a
      // non-playable URL to <video> or it blanks out.
      const embed = videoEmbedUrl(currentPick.url);
      if (embed) {
        previewSrc = embed;
        previewKind = 'embed';
      } else {
        // Don't trust the candidate's raw thumbnail_url here: for IG /
        // TikTok it's a CDN URL the renderer can't hotlink (no Referer →
        // 403 → broken-image glyph). Route through ReelThumb, which
        // proxies the poster through the main process as a data: URL
        // (and falls back to og:image scraping). Pass the reel PAGE url
        // so it can resolve the poster.
        previewSrc =
          currentPick.from_candidate_url || currentPick.url;
        previewKind = 'reelthumb';
      }
    }
  } else {
    previewSrc = curation?.candidates?.[0]?.thumbnail_url ?? null;
    previewKind = 'image';
  }

  return (
    <aside className="phone-sidebar">
      <div className="phone-sidebar-head">
        <span className="phone-sidebar-eyebrow">Preview</span>
        <span className="phone-sidebar-time">
          {(shot.start_ms / 1000).toFixed(1)}s –{' '}
          {(shot.end_ms / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="phone-sidebar-stage">
        <ReelMockup
          shot={previewShot}
          previewImageUrl={previewSrc}
          previewKind={previewKind}
        />
      </div>
      <div className="phone-sidebar-caption">{shot.placement.fit}</div>

      {picks.length > 0 && (
        <div className="phone-sidebar-picks">
          <div className="phone-sidebar-picks-label">
            Showing pick {pickIdx + 1} of {picks.length}
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

function ReelMockup({
  shot,
  previewImageUrl,
  previewKind = 'image',
}: {
  shot: ShotPlan;
  /** When present, render this real media inside the b-roll block
   *  instead of the schematic label — e.g. a curated candidate's
   *  thumbnail, so the mockup shows what the shot will actually look
   *  like once media is attached. */
  previewImageUrl?: string | null;
  /** What kind of media `previewImageUrl` points to. `'image'` renders
   *  with <img>, `'video'` with an autoplay <video>, `'embed'` with an
   *  <iframe> (YouTube/Vimeo), `'reelthumb'` with <ReelThumb> (fetches a
   *  poster frame). Defaults to `'image'` so legacy callers (which
   *  always passed a thumbnail URL) keep working. */
  previewKind?: PreviewKind;
}): React.JSX.Element {
  // If a remote <video> source fails to decode (CORS, dead link, an mp4
  // the platform serves with the wrong content-type), drop back to the
  // schematic label rather than leaving Chromium's broken-media glyph.
  const [videoFailed, setVideoFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setVideoFailed(false);
    setImgFailed(false);
  }, [previewImageUrl]);
  const { placement, broll_description, text_overlay, text_position } = shot;
  const brollLabel = (broll_description || 'b-roll').replace(/\s+/g, ' ').trim();

  // Per fit, compute the broll block's CSS rect inside the 9:16 canvas
  // and what (if anything) sits behind / next to it.
  type Rect = { top: string; left: string; width: string; height: string };
  let brollRect: Rect | null = null;
  let backgroundLabel: string | null = null;
  let backgroundRect: Rect | null = null;

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
      backgroundLabel = complementaryLabel(shot.clip_type);
      break;
    case 'split_bottom':
      brollRect = { top: '50%', left: '0', width: '100%', height: '50%' };
      backgroundRect = { top: '0', left: '0', width: '100%', height: '50%' };
      backgroundLabel = complementaryLabel(shot.clip_type);
      break;
    case 'split_left':
      brollRect = { top: '0', left: '0', width: '50%', height: '100%' };
      backgroundRect = { top: '0', left: '50%', width: '50%', height: '100%' };
      backgroundLabel = complementaryLabel(shot.clip_type);
      break;
    case 'split_right':
      brollRect = { top: '0', left: '50%', width: '50%', height: '100%' };
      backgroundRect = { top: '0', left: '0', width: '50%', height: '100%' };
      backgroundLabel = complementaryLabel(shot.clip_type);
      break;
    case 'pip': {
      // Full-bleed background, small inset on top. Inset position
      // derived from placement.position (3x3 grid).
      backgroundRect = { top: '0', left: '0', width: '100%', height: '100%' };
      backgroundLabel = complementaryLabel(shot.clip_type);
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

  // Text overlay position: map the FrameRegion to CSS top/left + alignment.
  const overlayPosCss = ((): {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
    transform?: string;
  } => {
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

  return (
    <div className="reel-mockup" title={`Mockup of how shot ${shot.shot_idx} looks in the reel`}>
      <div className="reel-mockup-phone">
        <div className="reel-mockup-notch" />
        <div className="reel-mockup-canvas">
          {backgroundRect && (
            <div className="reel-block reel-block-bg" style={backgroundRect}>
              <span className="reel-block-label">{backgroundLabel}</span>
            </div>
          )}
          {brollRect && (
            <div className="reel-block reel-block-broll" style={brollRect}>
              {previewImageUrl &&
              !(previewKind === 'video' && videoFailed) &&
              !(previewKind === 'image' && imgFailed) ? (
                previewKind === 'video' ? (
                  <video
                    className="reel-block-img"
                    src={previewImageUrl}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
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
          {text_overlay && (
            <div className="reel-text-overlay" style={overlayPosCss}>
              {text_overlay}
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
  onToggleMedia?: (media: SelectedMedia | null) => void;
  nested?: boolean;
}): React.JSX.Element {
  const [traceOpen, setTraceOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [regenBusy, setRegenBusy] = useState(false);
  const [curateBusy, setCurateBusy] = useState(false);
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
  const handleCurate = async (): Promise<void> => {
    setCurateBusy(true);
    try {
      await onCurateShot(shotIdx);
    } finally {
      setCurateBusy(false);
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
          {notCurated ? 'not curated yet' : `${curation!.candidates.length} candidate(s)`}
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
        <button
          className="btn btn-mini btn-curate-one"
          onClick={handleCurate}
          disabled={curateBusy}
          title={
            notCurated
              ? 'Research media for just this shot'
              : 'Re-research this shot from scratch'
          }
        >
          {curateBusy
            ? 'Curating…'
            : notCurated
              ? '▶ curate this shot'
              : '↻ re-curate'}
        </button>
        <button
          className="btn btn-mini btn-regen"
          onClick={() => setRegenOpen((v) => !v)}
          disabled={regenBusy}
          title="Steer this shot with extra guidance"
        >
          {regenBusy ? 'Working…' : '✎ with prompt'}
        </button>
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
      </div>
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
      {curation && curation.candidates.length > 0 && (
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
      {curation?.alternatives && curation.alternatives.length > 0 && (
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
type PreviewKind = 'image' | 'video' | 'embed' | 'reelthumb';

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
  return /^(capture|clips|file|blob|data):/i.test(url) || isDirectVideoFile(url);
}

function CandidateCard({
  candidate,
  shot,
  brollOverride,
  onToggleMedia,
}: {
  candidate: MediaCandidate;
  shot?: ShotPlan;
  brollOverride?: string;
  onToggleMedia?: (media: SelectedMedia | null) => void;
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
  const toggleCandidate = (): void => {
    if (!onToggleMedia) return;
    onToggleMedia({
      url: candidate.url,
      kind: isImage ? 'image' : 'video',
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
  >(null);
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
  >(null);
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
    <div className="candidate">
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
          {onToggleMedia && (
            <button
              type="button"
              className={
                candidateSelected ? 'btn-select btn-select-on' : 'btn-select'
              }
              onClick={toggleCandidate}
              title={
                candidateSelected
                  ? `Pick #${candidateIndex + 1} — click to remove`
                  : 'Add this candidate to the shot picks'
              }
            >
              {candidateSelected
                ? `✓ #${candidateIndex + 1}`
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
        {canExtract && (
          <div className="candidate-extract">
            <div className="candidate-extract-actions">
              <button
                type="button"
                className={`btn btn-mini ${clips ? 'btn-view' : 'btn-extract'}`}
                onClick={clips ? openPreview : runExtract}
                disabled={extracting || framing}
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
              <button
                type="button"
                className={`btn btn-mini ${frames ? 'btn-view' : 'btn-extract'}`}
                onClick={frames ? openPreview : runVideoScreenshots}
                disabled={extracting || framing}
                title={
                  frames
                    ? `Open the ${frames.length} frame${frames.length === 1 ? '' : 's'} in the preview popup`
                    : 'Pick the most relevant frames from the source video and save them as still PNGs.'
                }
              >
                {framing
                  ? 'Capturing frames…'
                  : frames
                    ? `▷ View frames (${frames.length})`
                    : '📸 Screenshot frames'}
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
        {canRecord && (
          <div className="candidate-extract">
            <div className="candidate-extract-actions">
              <button
                type="button"
                className={`btn btn-mini ${recordResult ? 'btn-view' : 'btn-extract'}`}
                onClick={recordResult ? openPreview : runRecord}
                disabled={recording || screenshotting}
                title={
                  recordResult
                    ? 'Open the recorded mp4 in the preview popup'
                    : 'Open the page in stealth Chromium, scroll through the sections most relevant to this shot, and record the result as a clean mp4.'
                }
              >
                {recording
                  ? 'Recording…'
                  : recordResult
                    ? '▷ View recording'
                    : '⏺ Record'}
              </button>
              <button
                type="button"
                className={`btn btn-mini ${screenshotResult && (screenshotResult.screenshots?.length ?? 0) > 0 ? 'btn-view' : 'btn-extract'}`}
                onClick={
                  screenshotResult && (screenshotResult.screenshots?.length ?? 0) > 0
                    ? openPreview
                    : runScreenshot
                }
                disabled={recording || screenshotting}
                title={
                  screenshotResult
                    ? `Open the ${screenshotResult.screenshots.length} screenshot${screenshotResult.screenshots.length === 1 ? '' : 's'} in the preview popup`
                    : 'For static / one-screen pages — capture the whole page as a single full-page PNG instead of scrolling video.'
                }
              >
                {screenshotting
                  ? 'Screenshotting…'
                  : screenshotResult && (screenshotResult.screenshots?.length ?? 0) > 0
                    ? `▷ View screenshots (${screenshotResult.screenshots.length})`
                    : '📸 Screenshot'}
              </button>
            </div>
            {recordError && (
              <div className="candidate-extract-error">⚠ {recordError}</div>
            )}
            {screenshotError && (
              <div className="candidate-extract-error">⚠ {screenshotError}</div>
            )}
            {devtools && recordLog.length > 0 && (
              <div className="extract-log">
                <button
                  type="button"
                  className="extract-log-toggle"
                  onClick={() => setRecordLogOpen((v) => !v)}
                >
                  {recordLogOpen ? '▾' : '▸'} thought process ({recordLog.length}{' '}
                  step{recordLog.length === 1 ? '' : 's'})
                </button>
                {recordLogOpen && (
                  <ol className="extract-log-list">
                    {recordLog.map((ev, i) => (
                      <RecordLogEntry key={i} event={ev} />
                    ))}
                  </ol>
                )}
              </div>
            )}
            {devtools && screenshotLog.length > 0 && (
              <div className="extract-log">
                <button
                  type="button"
                  className="extract-log-toggle"
                  onClick={() => setScreenshotLogOpen((v) => !v)}
                >
                  {screenshotLogOpen ? '▾' : '▸'} screenshot thought process (
                  {screenshotLog.length} step
                  {screenshotLog.length === 1 ? '' : 's'})
                </button>
                {screenshotLogOpen && (
                  <ol className="extract-log-list">
                    {screenshotLog.map((ev, i) => (
                      <ScreenshotLogEntry key={i} event={ev} />
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
              ? { busy: recording || screenshotting, run: runRecord, label: '↻ Re-record' }
              : null,
            screenshots: canRecord
              ? { busy: recording || screenshotting, run: runScreenshot, label: '↻ Re-screenshot' }
              : null,
          }}
        />
      )}
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

function ReelThumb({
  url,
  size = 'sm',
}: {
  url: string;
  size?: 'sm' | 'md';
}): React.JSX.Element {
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

  return (
    <div className={`reel-thumb reel-thumb-${size}`}>
      {thumb === undefined && <div className="reel-thumb-loading">…</div>}
      {thumb === null && <div className="reel-thumb-missing">no preview</div>}
      {thumb && <img src={thumb} alt="reel preview" loading="lazy" />}
    </div>
  );
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

  // Every face-bearing shot, in playback order, with its original index
  // (needed to seek). Each row shows when (time range) + where (face
  // region) and is clickable to jump the preview there.
  const talkingMoments = a.shots
    .map((shot, idx) => ({ shot, idx }))
    .filter(({ shot }) => TALKING_TYPES.includes(shot.clip_type));

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
          {reel.playable_url ? (
            <video
              ref={videoRef}
              className="az-phone-video"
              src={reel.playable_url}
              muted
              loop
              playsInline
              autoPlay
            />
          ) : (
            <div className="az-phone-novideo">
              preview unavailable
              <span>source link expired</span>
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
