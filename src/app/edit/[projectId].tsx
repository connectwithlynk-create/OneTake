import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
// NlePlayer drives the main timeline. expo-video is still used for the
// per-overlay muted/loop video previews (OverlayVideo below).
import { useVideoPlayer, VideoView } from 'expo-video';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  ScrollView,
} from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NlePlayerView, useNlePlayer } from '../../../modules/nle-player';
import type { NleClip as NleClipShape, NleTimeUpdateEvent, NlePlayingChangeEvent } from '../../../modules/nle-player';
import { ClipVideo } from '@/components/clip-video';
import { ErrorBoundary } from '@/components/error-boundary';
import { Loading } from '@/components/ui';
import { crumb } from '@/lib/crash-log';
import {
  persistClip,
  persistOverlayMedia,
  resolveClipUri,
  resolveOverlayMediaUri,
} from '@/lib/filestore';
import { id as newId } from '@/lib/id';
import {
  addClip,
  addOverlay,
  createSubjectOverlay,
  deleteOverlay,
  findSubjectOverlayFor,
  getProject,
  listClips,
  listOverlays,
  removeSubjectOverlayFor,
  setCaptionSettings,
  updateOverlay,
} from '@/lib/repo';
import {
  hydrate as hydrateTimeline,
  loadTimeline,
  patchRow,
  rowFromClip,
  saveTimeline,
  splitRow,
  type TimelineClip,
  type TimelineRow,
} from '@/lib/timeline';
import { rateClip } from '@/lib/rating';
import { invalidate, useData } from '@/lib/store';
import { maybeTranscribe } from '@/lib/transcribe';
import {
  activeLineAt,
  CAPTION_STYLES,
  type CaptionLine,
  type CaptionStyle,
  lineifyProject,
} from '@/lib/captions';
import { font, palette, radius, space } from '@/theme';
import type {
  Clip,
  ClipEffects,
  CaptionFont,
  Overlay,
  ProjectTransition,
  WordTiming,
} from '@/lib/types';
import {
  FILTER_PRESETS,
  getBeats,
  getEffects,
  getKeyframes,
  getTransitions,
  interpKeyframes,
  setBeats,
  setOverlayKeyframes,
  setTransition,
} from '@/lib/effects';
import { proposeForClip } from '@/lib/silences';
import {
  AdjustPanel,
  AudioPanel,
  BeatsPanel,
  CutSilencesPanel,
  CutoutPanel,
  FiltersPanel,
  GreenScreenPanel,
  KeyframesPanel,
  RestylePanel,
  TransitionsPanel,
  VoiceEnhancePanel,
  VoiceFxPanel,
  VoiceoverPanel,
} from './panels';
import * as DocumentPicker from 'expo-document-picker';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';

// === Timeline geometry =====================================================
// 60 px per second feels close to CapCut's default density.
const DEFAULT_PX_PER_MS = 0.06;
const MIN_PX_PER_MS = 0.015; // ~15 px/s — very zoomed out
const MAX_PX_PER_MS = 0.3; // ~300 px/s — very zoomed in

const CAPTION_FONT_OPTIONS: { key: CaptionFont; label: string }[] = [
  { key: 'display', label: 'Display' },
  { key: 'body', label: 'Body' },
  { key: 'mono', label: 'Mono' },
];

const CAPTION_FONT_FAMILY: Record<CaptionFont, string> = {
  display: font.displayHeavy,
  body: font.bodyBold,
  mono: font.monoBold,
};
const RULER_H = 22;
const SUBS_H = 30;
const OVRL_H = 30;
const CLIP_H = 64;
const AUDIO_H = 28;
const TRACK_GAP = 6;
const CLIP_TOP =
  RULER_H + TRACK_GAP + SUBS_H + TRACK_GAP + OVRL_H + TRACK_GAP;
const AUDIO_TOP = CLIP_TOP + CLIP_H + TRACK_GAP;
const TRACK_BLOCK_H = AUDIO_TOP + AUDIO_H;

/** Bottom-panel mode: which inline panel (if any) is open below the
 *  action bar. None of these are clip-state — they're just UI mode. */
type BottomMode =
  | 'none'
  | 'volume'
  | 'speed'
  | 'size'
  | 'captions'
  | 'slip'
  | 'teleprompter'
  | 'stickers'
  | 'adjust'
  | 'filters'
  | 'green'
  | 'voicefx'
  | 'voiceEnh'
  | 'cutout'
  | 'restyle'
  | 'keyframes'
  | 'transitions'
  | 'beats'
  | 'voiceover'
  | 'audio'
  | 'silences';

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
function effIn(c: Clip): number {
  return c.in_ms ?? 0;
}
function effOut(c: Clip): number {
  return c.out_ms ?? c.duration_ms;
}
function effLen(c: Clip): number {
  return Math.max(0, effOut(c) - effIn(c));
}

// ============================================================
// Editor screen
// ============================================================
export default function ManualEditScreen() {
  // The editor is the screen most likely to throw under user input
  // (timeline ScrollView + gestures + native composition rebuilds).
  // Catch render-tree errors here and route them through crash-log so
  // /debug-crash can surface a stack instead of a white screen.
  return (
    <ErrorBoundary source="editor">
      <ManualEditScreenInner />
    </ErrorBoundary>
  );
}

function ManualEditScreenInner() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const router = useRouter();

  const { data: project } = useData(() => getProject(projectId), [projectId]);
  const { data: clipsDb } = useData(() => listClips(projectId), [projectId]);
  const { data: overlaysDb } = useData(
    () => listOverlays(projectId),
    [projectId]
  );

  // Editor's timeline rows — owned here, not derived from `clipsDb`. The
  // clips table is the recording library (read-only from the editor's
  // perspective); the timeline is the edit. Persisted as JSON on
  // projects.timeline_json via the debounced save below.
  //
  // invalidate() does NOT re-run loadTimeline — that would clobber
  // in-flight edits. Timeline lifecycle is owned by the editor mount.
  const [timeline, setTimeline] = useState<TimelineRow[] | null>(null);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  useEffect(() => {
    let alive = true;
    loadTimeline(projectId).then((rows) => {
      if (alive) setTimeline(rows);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);
  useEffect(() => {
    if (overlaysDb) setOverlays(overlaysDb);
  }, [overlaysDb]);

  // Read-only join: timeline rows × clips table for source media
  // metadata (file_uri, duration_ms, transcript_words, name). Rerunning
  // on clipsDb change lets late-arriving transcription / naming flow
  // into the editor without touching the timeline itself. Rows whose
  // source recording is gone are dropped from the playable list.
  //
  // Excluded clips are no longer removed from the playable timeline —
  // the "hide" toggle now just dims them visually. They still occupy
  // their slot, still play through.
  const included = useMemo<TimelineClip[]>(() => {
    if (!timeline || !clipsDb) return [];
    const byId = new Map(clipsDb.map((c) => [c.id, c]));
    return timeline.flatMap((row) => {
      const src = byId.get(row.source_clip_id);
      if (!src) return [];
      return [hydrateTimeline(row, src)];
    });
  }, [timeline, clipsDb]);
  // Alias kept so downstream caption / subtitle helpers read as before.
  const clips = included;

  // Debounced save. A trim drag fires many state updates per second;
  // 250ms means one write at most ~4Hz under continuous editing and a
  // durable timeline within ¼s of the last edit.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!timeline) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const rows = timeline;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      saveTimeline(projectId, rows).catch((e) => {
        crumb('editor.saveTimeline', 'threw', { err: (e as Error).message });
      });
    }, 250);
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [timeline, projectId]);

  // Helper: apply a partial patch to one timeline row.
  const updateTimelineRow = useCallback(
    (rowId: string, patch: Partial<TimelineRow>) => {
      setTimeline((prev) =>
        prev ? prev.map((r) => (r.id === rowId ? patchRow(r, patch) : r)) : prev
      );
    },
    []
  );
  const cumulative = useMemo(() => {
    const out: number[] = [0];
    for (let i = 0; i < included.length; i++) {
      out.push(out[i] + effLen(included[i]));
    }
    return out;
  }, [included]);
  const totalMs = cumulative[cumulative.length - 1] ?? 0;

  // ----- selection (tap-only; never set by scrub or auto-advance) -----
  // A single selection across all timeline elements. Clip and overlay
  // selections are mutually exclusive — picking one clears the other so
  // the action bar always reflects a single target.
  type SelectionKind = 'clip' | 'overlay';
  const [selection, setSelection] = useState<{
    kind: SelectionKind;
    id: string;
  } | null>(null);
  const selectClip = useCallback((id: string) => {
    setSelection({ kind: 'clip', id });
  }, []);
  const selectOverlay = useCallback((id: string) => {
    setSelection({ kind: 'overlay', id });
  }, []);
  const clearSelection = useCallback(() => setSelection(null), []);
  const selectedId = selection?.kind === 'clip' ? selection.id : null;
  const selectedOverlayId =
    selection?.kind === 'overlay' ? selection.id : null;
  const selected = clips.find((c) => c.id === selectedId) ?? null;
  const selectedOverlay =
    overlays.find((o) => o.id === selectedOverlayId) ?? null;

  // Kick off transcription for any clip missing word timings. The captions
  // feature renders nothing until transcript_words is populated, so without
  // this trigger captions stayed permanently empty whenever transcription
  // failed (or skipped) at import time. Best-effort; no-ops without
  // Supabase + Clerk configured.
  useEffect(() => {
    if (!clipsDb) return;
    for (const c of clipsDb) {
      if (!c.transcript_words) void maybeTranscribe(c.id);
    }
  }, [clipsDb]);

  // ----- undo / redo command stack -----
  // Each command stores its own forward + inverse closures over the values
  // captured at issue time. `do` runs immediately and pushes to the undo
  // stack; `undo` runs the inverse and moves the command to the redo stack.
  type Cmd = { do: () => Promise<void>; undo: () => Promise<void> };
  const undoStack = useRef<Cmd[]>([]);
  const redoStack = useRef<Cmd[]>([]);
  // Bump on stack mutation so the toolbar tints recompute.
  const [historyTick, setHistoryTick] = useState(0);
  const bumpHistory = () => setHistoryTick((n) => n + 1);
  const runCmd = useCallback(async (cmd: Cmd) => {
    await cmd.do();
    undoStack.current.push(cmd);
    redoStack.current = [];
    bumpHistory();
  }, []);
  const doUndo = useCallback(async () => {
    const cmd = undoStack.current.pop();
    if (!cmd) return;
    await cmd.undo();
    redoStack.current.push(cmd);
    bumpHistory();
  }, []);
  const doRedo = useCallback(async () => {
    const cmd = redoStack.current.pop();
    if (!cmd) return;
    await cmd.do();
    undoStack.current.push(cmd);
    bumpHistory();
  }, []);
  const clearHistory = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    bumpHistory();
  }, []);
  // Re-read after each mutation so disabled state is current.
  const canUndo = undoStack.current.length > 0;
  const canRedo = redoStack.current.length > 0;
  // Touch `historyTick` so the lints/optimizer keep the read in deps.
  void historyTick;

  // ----- player engine: native NLE composition -----------------------
  // One native player driven by a composed timeline. The native side
  // (AVMutableComposition on iOS, ConcatenatingMediaSource on Android)
  // handles boundary cuts, pre-warm, and frame-accurate seek for free.
  const player = useNlePlayer();
  // Measured height of the bottom action bar. The panel layer floats
  // exactly above this so the action bar's screen position never
  // shifts when a tool panel opens / closes.
  const [actionBarH, setActionBarH] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [globalMs, setGlobalMs] = useState(0);
  const globalMsRef = useRef(0);
  globalMsRef.current = globalMs;
  /** Which clip currently covers globalMs. Driven by the player's
   *  per-frame onTimeUpdate event; cheap derived state. */
  const activeIdx = useRef<number>(0);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1);
  speedRef.current = speed;

  // ----- zoom + viewport (centered playhead model) -----
  const [pxPerMs, setPxPerMs] = useState(DEFAULT_PX_PER_MS);
  const pxPerMsRef = useRef(pxPerMs);
  pxPerMsRef.current = pxPerMs;
  const [viewportW, setViewportW] = useState(0);
  const viewportWRef = useRef(0);
  viewportWRef.current = viewportW;

  // Push the current clip list down to the native composition. The
  // composition is rebuilt on any structural change (split, delete,
  // reorder, trim); the user only sees a brief load while the new
  // composition primes — boundary cuts within it are seamless.
  //
  // We diff against the last-pushed signature so we don't rebuild on
  // every re-render (trim drag updates lots of unrelated state). The
  // signature captures id + uri + in/out + volume — the fields that
  // shape the composition.
  const lastPushRef = useRef<string>('');
  useEffect(() => {
    if (included.length === 0) return;
    // Drop clips the native side will reject anyway. Avoids the engine
    // failing the whole composition because one row is zero-duration
    // or has a missing file_uri (mid-import edge cases).
    const valid = included.filter(
      (c) => c.file_uri && effLen(c) > 0
    );
    if (valid.length === 0) return;
    const composed: NleClipShape[] = valid.map((c) => {
      const ef = getEffects(c);
      // Voice Enhance shorthand: a +6dB-ish boost handled fully in JS
      // until the AudioUnit-based engine lands.
      const baseVol = c.audio_volume ?? 1;
      const vol = ef.voiceEnhance ? Math.min(1, baseVol + 0.25) : baseVol;
      return {
        id: c.id,
        uri: resolveClipUri(c.file_uri),
        inMs: effIn(c),
        outMs: effOut(c),
        volume: vol,
        // Color adjust — native applies via AVMutableVideoComposition.
        brightness: ef.brightness,
        contrast: ef.contrast,
        saturation: ef.saturation,
        warmth: ef.warmth,
        shadows: ef.shadows,
        highlights: ef.highlights,
        // Chroma key.
        chromaEnabled: ef.chromaEnabled,
        chromaColor: ef.chromaColor,
        chromaThreshold: ef.chromaThreshold,
        // Person segmentation — native applies Vision masking.
        cutoutEnabled: ef.cutoutEnabled,
      };
    });
    const sig = composed
      .map(
        (c) =>
          `${c.id}:${c.inMs}:${c.outMs}:${c.volume ?? 1}:${c.uri}:` +
          `${c.brightness ?? 0}:${c.contrast ?? 1}:${c.saturation ?? 1}:` +
          `${c.warmth ?? 0}:${c.shadows ?? 0}:${c.highlights ?? 0}:` +
          `${c.chromaEnabled ? 1 : 0}:${c.chromaColor ?? ''}:${c.chromaThreshold ?? 0}:` +
          `${c.cutoutEnabled ? 1 : 0}`
      )
      .join('|');
    if (sig === lastPushRef.current) return;
    lastPushRef.current = sig;
    // Per-clip effect summary — tells us exactly which expensive
    // path each clip will hit on the native side. cutout in
    // particular routes through Vision personSegmentation, which
    // was the prime suspect for scrub crashes.
    const effSummary = composed.map((c) => ({
      id: c.id.slice(0, 6),
      color:
        (c.brightness ?? 0) !== 0 ||
        (c.contrast ?? 1) !== 1 ||
        (c.saturation ?? 1) !== 1 ||
        (c.warmth ?? 0) !== 0 ||
        (c.shadows ?? 0) !== 0 ||
        (c.highlights ?? 0) !== 0
          ? 1
          : 0,
      chroma: c.chromaEnabled ? 1 : 0,
      cutout: c.cutoutEnabled ? 1 : 0,
    }));
    crumb('editor.setClips', 'push', {
      n: composed.length,
      needsColor: composed.some(
        (c) =>
          (c.brightness ?? 0) !== 0 ||
          (c.contrast ?? 1) !== 1 ||
          (c.saturation ?? 1) !== 1 ||
          (c.warmth ?? 0) !== 0 ||
          (c.shadows ?? 0) !== 0 ||
          (c.highlights ?? 0) !== 0 ||
          c.chromaEnabled ||
          c.cutoutEnabled
      ),
      cutoutClips: effSummary.filter((e) => e.cutout).length,
      chromaClips: effSummary.filter((e) => e.chroma).length,
      colorClips: effSummary.filter((e) => e.color).length,
      effects: effSummary,
    });
    try {
      player.setClips(composed);
    } catch (e) {
      crumb('editor.setClips', 'threw', { err: (e as Error).message });
    }
  }, [included, player]);

  // Tap a timeline cell → seek to the start of that clip on the composed
  // timeline. No source swap needed; the composition already covers
  // every clip.
  useEffect(() => {
    if (!selectedId) return;
    const idx = included.findIndex((c) => c.id === selectedId);
    if (idx >= 0 && idx !== activeIdx.current) {
      activeIdx.current = idx;
      setGlobalMs(cumulative[idx]);
      try {
        player.seek(cumulative[idx]);
      } catch {
        /* */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Drive globalMs from the player's per-frame time updates. The native
  // engine emits these on CADisplayLink / Choreographer cadence so the
  // playhead tracks the displayed frame.
  useEffect(() => {
    const sub = player.addListener(
      'onTimeUpdate',
      (ev: NleTimeUpdateEvent) => {
        if (userScrolling.current) return;
        activeIdx.current = Math.max(0, ev.clipIndex);
        setGlobalMs(ev.ms);
      }
    );
    return () => sub.remove();
  }, [player]);

  useEffect(() => {
    const sub = player.addListener(
      'onPlayingChange',
      (ev: NlePlayingChangeEvent) => {
        setPlaying(!!ev.isPlaying);
      }
    );
    return () => sub.remove();
  }, [player]);

  // Composition load status from native. Drives the preview banner so
  // the user actually sees when a clip failed to load instead of a
  // silently-black preview.
  const [loadStatus, setLoadStatus] = useState<{
    state: 'idle' | 'loading' | 'readyToPlay' | 'error';
    message?: string;
  }>({ state: 'idle' });
  useEffect(() => {
    const sub = player.addListener(
      'onStatusChange',
      (ev: { status?: string; error?: string; warning?: string }) => {
        const status =
          (ev?.status as 'idle' | 'loading' | 'readyToPlay' | 'error') ??
          'loading';
        crumb('player.status', status, {
          error: ev?.error,
          warning: ev?.warning,
        });
        setLoadStatus({
          state: status,
          message: ev?.error ?? ev?.warning,
        });
      }
    );
    return () => sub.remove();
  }, [player]);

  // Seek + commit helpers — kept so the scrub UI code below stays
  // unchanged. With the native composition, "swap" reduces to a single
  // player.seek(ms) call; there's no longer any deferred work.
  const seekToGlobalMs = useCallback(
    (ms: number) => {
      if (included.length === 0) return;
      const target = clamp(ms, 0, totalMs);
      setGlobalMs(target);
      try {
        player.seek(target);
      } catch (e) {
        crumb('editor.seek', 'player.seek threw', {
          target,
          err: (e as Error).message,
        });
      }
    },
    [included.length, totalMs, player]
  );

  const commitPendingSwap = useCallback(() => {
    // No-op with the native composition. Kept to satisfy existing scrub
    // wiring.
  }, []);

  function togglePlay() {
    try {
      if (player.isPlaying) {
        player.pause();
      } else {
        if (globalMsRef.current >= totalMs - 1) {
          player.seek(0);
        }
        player.play();
      }
    } catch {
      /* ignore */
    }
  }

  // ----- bottom-bar modes (open inline panels) -----
  const [bottomMode, setBottomMode] = useState<BottomMode>('none');

  // Cut Silences state. 0 = default breath buffer; positive keeps
  // more silence, negative trims deeper into the talk.
  const [silencesOffset, setSilencesOffset] = useState(0);

  // Reorder-drag state for the main clip strip. fromIdx = which cell
  // the user is long-press-dragging; dx = current translation. The
  // cell renders lifted at left + dx; release decides which slot to
  // drop it into.
  const [reorderDrag, setReorderDrag] = useState<{
    fromIdx: number;
    dx: number;
  } | null>(null);
  /** Commit the drop. Maps the dragged cell's CENTER (in composed-
   *  timeline px) to the slot whose midpoint it crossed, then splices
   *  the timeline row into its new slot (pure local state — the
   *  recording library is untouched). */
  function commitReorder(fromIdx: number, dx: number) {
    if (fromIdx < 0 || fromIdx >= included.length) return;
    const c = included[fromIdx];
    const myCenter =
      cumulative[fromIdx] * pxPerMs + (effLen(c) * pxPerMs) / 2 + dx;
    let dropIdx = fromIdx;
    for (let i = 0; i < included.length; i++) {
      const cLeft = cumulative[i] * pxPerMs;
      const cMid = cLeft + (effLen(included[i]) * pxPerMs) / 2;
      if (myCenter < cMid) {
        dropIdx = i;
        break;
      }
      dropIdx = i;
    }
    if (dropIdx === fromIdx) return;
    clearHistory();
    setTimeline((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(dropIdx, 0, moved);
      return next;
    });
  }
  const [silencesApplying, setSilencesApplying] = useState(false);
  const [silencesResult, setSilencesResult] = useState<
    { removedMs: number; trimmedClips: number } | null
  >(null);

  // Voiceover recording state
  const voRecorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
  });
  const voStartedAt = useRef(0);
  const [voRecording, setVoRecording] = useState(false);
  const [voElapsedMs, setVoElapsedMs] = useState(0);
  useEffect(() => {
    if (!voRecording) return;
    const t = setInterval(
      () => setVoElapsedMs(Date.now() - voStartedAt.current),
      100
    );
    return () => clearInterval(t);
  }, [voRecording]);

  // Effects helpers — current selection's effects bag
  const selectedEffects = useMemo<ClipEffects>(
    () => (selected ? getEffects(selected) : {}),
    [selected]
  );
  function patchSelectedEffects(patch: Partial<ClipEffects>) {
    if (!selected) return;
    const merged: ClipEffects = { ...getEffects(selected), ...patch };
    updateTimelineRow(selected.id, { effects_json: JSON.stringify(merged) });
  }
  function applyPreset(presetId: string) {
    if (!selected) return;
    const preset = FILTER_PRESETS[presetId as keyof typeof FILTER_PRESETS];
    if (!preset) return;
    const merged: ClipEffects = {
      ...getEffects(selected),
      ...preset.effects,
      filterPreset: presetId,
    };
    updateTimelineRow(selected.id, { effects_json: JSON.stringify(merged) });
  }

  // Boundary index nearest the playhead — Transition panel acts on this.
  const nearestBoundaryIdx = useMemo(() => {
    if (included.length < 2) return 0;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 1; i < included.length; i++) {
      const bms = cumulative[i] ?? 0;
      const dist = Math.abs(globalMs - bms);
      if (dist < bestDist) {
        bestDist = dist;
        best = i - 1;
      }
    }
    return best;
  }, [globalMs, cumulative, included.length]);

  // Project-scoped JSON blobs (transitions, beats) parsed once per render.
  const transitions = useMemo(
    () => getTransitions(project?.transitions_json ?? null),
    [project?.transitions_json]
  );
  const beats = useMemo(
    () => getBeats(project?.beats_json ?? null),
    [project?.beats_json]
  );

  // Keyframes for the currently-selected overlay (if any).
  const selectedOverlayKfs = useMemo(
    () => getKeyframes(selectedOverlay?.keyframes_json ?? null),
    [selectedOverlay?.keyframes_json]
  );

  function doSplit() {
    if (!selected) return;
    const idx = included.findIndex((c) => c.id === selected.id);
    if (idx < 0) return;
    const atLocal = Math.max(0, globalMs - cumulative[idx]);
    const parts = splitRow(selected, atLocal);
    if (!parts) return;
    // Split has no inverse — wipe history so undo can't land between
    // the two halves.
    clearHistory();
    setTimeline((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next.splice(idx, 1, parts[0], parts[1]);
      return next;
    });
  }

  function doDuplicate() {
    if (!selected) return;
    const idx = included.findIndex((c) => c.id === selected.id);
    if (idx < 0) return;
    clearHistory();
    setTimeline((prev) => {
      if (!prev) return prev;
      const src = prev[idx];
      if (!src) return prev;
      const dupe: TimelineRow = { ...src, id: newId() };
      const next = prev.slice();
      next.splice(idx + 1, 0, dupe);
      return next;
    });
  }

  async function doReplace() {
    if (!selected) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (res.canceled || !res.assets || res.assets.length === 0) return;
    const a = res.assets[0];
    // The new file goes into the clips table as a new recording — the
    // previous source stays in the library (other timeline rows may
    // still reference it). The selected timeline row swaps its
    // source_clip_id over and clears its trim so the new media plays
    // through end-to-end.
    const newClipId = newId();
    const persisted = persistClip(a.uri, newClipId);
    const durationMs = Math.round(a.duration ?? selected.duration_ms);
    const rating = rateClip({ clipId: newClipId, durationMs, source: 'imported' });
    await addClip(
      projectId,
      persisted,
      durationMs,
      rating.verdict,
      rating.tag,
      newClipId
    );
    clearHistory();
    updateTimelineRow(selected.id, {
      source_clip_id: newClipId,
      in_ms: null,
      out_ms: null,
    });
    // Refresh clipsDb so the new source clip shows up in the join.
    invalidate();
    void maybeTranscribe(newClipId);
  }

  function doSlip(deltaMs: number) {
    if (!selected) return;
    // Slip = shift in/out by the same delta, keeping the clip's length
    // constant. Clamp to source duration so we don't push the window
    // off the recording's end.
    const dur = selected.duration_ms;
    const oldIn = selected.in_ms ?? 0;
    const oldOut = selected.out_ms ?? dur;
    const len = oldOut - oldIn;
    let newIn = oldIn + deltaMs;
    newIn = Math.max(0, Math.min(dur - len, newIn));
    const newOut = newIn + len;
    updateTimelineRow(selected.id, { in_ms: newIn, out_ms: newOut });
  }

  // ---- Cut Silences ------------------------------------------------
  async function runCutSilences() {
    if (silencesApplying || included.length === 0) return;
    setSilencesApplying(true);
    try {
      let totalRemoved = 0;
      let trimmed = 0;
      const byRow = new Map<string, { newIn: number; newOut: number }>();
      for (const c of included) {
        const p = proposeForClip(c, silencesOffset);
        if (!p) continue;
        const removed = p.headRemovedMs + p.tailRemovedMs;
        if (removed <= 0) continue;
        byRow.set(c.id, { newIn: p.newIn, newOut: p.newOut });
        totalRemoved += removed;
        trimmed += 1;
      }
      setTimeline((prev) => {
        if (!prev) return prev;
        return prev.map((r) => {
          const upd = byRow.get(r.id);
          return upd ? patchRow(r, { in_ms: upd.newIn, out_ms: upd.newOut }) : r;
        });
      });
      setSilencesResult({ removedMs: totalRemoved, trimmedClips: trimmed });
      clearHistory();
    } catch {
      setSilencesResult({ removedMs: 0, trimmedClips: 0 });
    } finally {
      setSilencesApplying(false);
    }
  }

  // ---- Voiceover ---------------------------------------------------
  const voiceoverStartGlobalMs = useRef(0);
  async function startVoiceover() {
    if (voRecording) return;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) return;
      await setAudioModeAsync({ allowsRecording: true });
      await voRecorder.prepareToRecordAsync();
      voiceoverStartGlobalMs.current = globalMs;
      voStartedAt.current = Date.now();
      setVoElapsedMs(0);
      setVoRecording(true);
      voRecorder.record();
    } catch {
      setVoRecording(false);
    }
  }
  async function stopVoiceover() {
    if (!voRecording) return;
    try {
      const status = await voRecorder.stop();
      setVoRecording(false);
      const durMs = Date.now() - voStartedAt.current;
      const uri =
        (status as unknown as { uri?: string })?.uri ?? voRecorder.uri;
      if (!uri) return;
      // Persist into overlays/ and create a video-kind overlay (audio
      // overlays ride on the same column path; until we have a dedicated
      // 'audio' kind, we tag it as a media overlay and the rest of the
      // pipeline treats it as a hidden audio source).
      const overlayId = newId();
      const persisted = persistOverlayMedia(uri, overlayId, '.m4a');
      const start = voiceoverStartGlobalMs.current;
      const end = Math.max(start + 100, start + durMs);
      await addOverlay(projectId, {
        kind: 'video',
        file_uri: persisted,
        start_ms: start,
        end_ms: end,
        scale: 0, // hidden — audio-only
      });
      invalidate();
    } catch {
      setVoRecording(false);
    }
  }

  // ---- Audio library ----------------------------------------------
  async function pickAudio() {
    const res = await DocumentPicker.getDocumentAsync({
      type: 'audio/*',
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (res.canceled || !res.assets || res.assets.length === 0) return;
    const a = res.assets[0];
    const overlayId = newId();
    const ext = (a.name && a.name.includes('.'))
      ? '.' + a.name.split('.').pop()
      : '.m4a';
    const persisted = persistOverlayMedia(a.uri, overlayId, ext);
    // Default to a 10s span at the playhead — user can trim on the timeline.
    const start = globalMs;
    const end = Math.min(
      totalMs > 0 ? totalMs : start + 10000,
      start + 10000
    );
    await addOverlay(projectId, {
      kind: 'video',
      file_uri: persisted,
      start_ms: start,
      end_ms: end,
      scale: 0, // hidden — audio-only
    });
    invalidate();
  }

  function doDelete() {
    if (!selected) return;
    // Pure timeline mutation — no DB / file write. The recording stays
    // in the clips table; it just no longer appears on the timeline.
    // This eliminates the race where AVPlayer kept reading a file we
    // had just deleted.
    //
    // Defensive pause: a rebuild is about to fire (the included memo
    // changes → push effect → player.setClips). If the player is
    // mid-decode for a frame whose timestamp lands past the new
    // composition's total, the swap window is a known silent-kill
    // hazard. Pausing first means the next thing AVPlayer renders is
    // already the new composition.
    const rowId = selected.id;
    try { player.pause(); } catch { /* */ }
    crumb('editor.delete', 'tap', { rowId: rowId.slice(0, 6) });
    clearHistory();
    setTimeline((prev) => (prev ? prev.filter((r) => r.id !== rowId) : prev));
    clearSelection();
  }

  // Unified delete for whatever's selected (clip, text overlay, or media
  // overlay). Overlay deletes are still undoable (they're DB rows);
  // timeline deletes wipe history because splits aren't reversible.
  async function doDeleteSelection() {
    if (selectedOverlay) {
      await removeOverlay(selectedOverlay);
      clearSelection();
      return;
    }
    if (selected) {
      doDelete();
    }
  }

  async function toggleExclude() {
    if (!selected) return;
    const rowId = selected.id;
    const prev = selected.excluded === 1 ? 1 : 0;
    const next: 0 | 1 = prev === 1 ? 0 : 1;
    await runCmd({
      do: async () => updateTimelineRow(rowId, { excluded: next }),
      undo: async () => updateTimelineRow(rowId, { excluded: prev }),
    });
  }

  async function toggleMirror() {
    if (!selected) return;
    const rowId = selected.id;
    const prev: 0 | 1 = selected.mirrored === 1 ? 1 : 0;
    const next: 0 | 1 = prev === 1 ? 0 : 1;
    await runCmd({
      do: async () => updateTimelineRow(rowId, { mirrored: next }),
      undo: async () => updateTimelineRow(rowId, { mirrored: prev }),
    });
  }

  async function toggleAudioDetached() {
    if (!selected) return;
    const rowId = selected.id;
    const prev: 0 | 1 = selected.audio_detached === 1 ? 1 : 0;
    const next: 0 | 1 = prev === 1 ? 0 : 1;
    await runCmd({
      do: async () => updateTimelineRow(rowId, { audio_detached: next }),
      undo: async () => updateTimelineRow(rowId, { audio_detached: prev }),
    });
  }

  async function toggleMute() {
    if (!selected) return;
    const rowId = selected.id;
    const prev = selected.audio_volume ?? 1;
    const next = prev > 0 ? 0 : 1;
    // Push the volume into the native audio mix immediately so the
    // change is audible before the composition rebuild settles. The
    // rebuild then writes the same value via setClips's audio mix.
    const applyTo = (val: number) => {
      try {
        player.setClipVolume(rowId, val);
      } catch {
        /* ignore */
      }
    };
    await runCmd({
      do: async () => {
        updateTimelineRow(rowId, { audio_volume: next });
        applyTo(next);
      },
      undo: async () => {
        updateTimelineRow(rowId, { audio_volume: prev });
        applyTo(prev);
      },
    });
  }

  function doSpeed(s: number) {
    setSpeed(s);
    // NlePlayer doesn't yet expose per-clip playback rate; the
    // composition plays at 1x. Reserved for a future native pass.
  }

  async function changeVolume(v: number) {
    if (!selected) return;
    const rowId = selected.id;
    const prev = selected.audio_volume ?? 1;
    const applyTo = (val: number) => {
      try {
        player.setClipVolume(rowId, val);
      } catch {
        /* ignore */
      }
    };
    await runCmd({
      do: async () => {
        updateTimelineRow(rowId, { audio_volume: v });
        applyTo(v);
      },
      undo: async () => {
        updateTimelineRow(rowId, { audio_volume: prev });
        applyTo(prev);
      },
    });
  }

  // ----- trim drag (selected clip in strip) -----
  // Live drag deltas live in the parent so the rest of the timeline (clips
  // after the trimmed one) can reflow in lockstep with the OUT handle, and
  // so the gesture has access to globalMs for snap-to-playhead.
  const [trimDrag, setTrimDrag] = useState<{
    id: string;
    dxIn: number;
    dxOut: number;
  } | null>(null);

  async function persistTrim(inMs: number, outMs: number) {
    if (!selected) return;
    const rowId = selected.id;
    const prevIn = selected.in_ms;
    const prevOut = selected.out_ms;
    const newIn = Math.round(inMs);
    const newOut = Math.round(outMs);
    await runCmd({
      do: async () => updateTimelineRow(rowId, { in_ms: newIn, out_ms: newOut }),
      undo: async () => updateTimelineRow(rowId, { in_ms: prevIn, out_ms: prevOut }),
    });
  }

  // ----- text overlays -----
  const [overlayModal, setOverlayModal] = useState(false);
  const [overlayDraft, setOverlayDraft] = useState('');

  /** Shortcut to drop a text overlay at the playhead. Used by stickers
   *  (which are just big emoji text overlays) and any "quick text" path. */
  async function addTextOverlay(text: string) {
    const start = globalMs;
    const end = Math.min(
      totalMs > 0 ? totalMs : start + 3000,
      globalMs + 3000
    );
    let createdId: string | null = null;
    let createdSnap: Overlay | null = null;
    await runCmd({
      do: async () => {
        const re = createdSnap
          ? await addOverlay(projectId, createdSnap)
          : await addOverlay(projectId, {
              text,
              start_ms: start,
              end_ms: end,
              size: 48,
            });
        createdId = re.id;
        createdSnap = re;
        invalidate();
      },
      undo: async () => {
        if (createdId) {
          await deleteOverlay(createdId);
          invalidate();
        }
      },
    });
  }
  async function commitNewOverlay() {
    const text = overlayDraft.trim();
    if (!text) {
      setOverlayModal(false);
      return;
    }
    const start = globalMs;
    const end = Math.min(
      totalMs > 0 ? totalMs : start + 3000,
      globalMs + 3000
    );
    // `addOverlay` returns the new overlay id; capture it so undo can target
    // the exact row (and redo can re-create with the same id-like body).
    // addOverlay assigns a fresh id each call, so on redo we have to
    // re-capture both id and snapshot to keep delete-by-id consistent.
    let createdId: string | null = null;
    let createdSnap: Overlay | null = null;
    await runCmd({
      do: async () => {
        const re = createdSnap
          ? await addOverlay(projectId, createdSnap)
          : await addOverlay(projectId, {
              text,
              start_ms: start,
              end_ms: end,
            });
        createdId = re.id;
        createdSnap = re;
        invalidate();
      },
      undo: async () => {
        if (createdId) {
          await deleteOverlay(createdId);
          invalidate();
        }
      },
    });
    setOverlayDraft('');
    setOverlayModal(false);
  }

  /** Pick a video from the camera roll and append it to the project's
   *  MAIN TRACK as a new clip at the end. Used by the Media button on
   *  the global action bar and the "+" cell at the end of the main
   *  clip strip. Persists the file into the clips/ dir so the picker
   *  uri's lifecycle doesn't matter. */
  async function addClipToMainTrack() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsMultipleSelection: true,
        quality: 1,
      });
      if (res.canceled || !res.assets || res.assets.length === 0) return;
      // Wipe history — multi-clip imports are hard to undo cleanly.
      clearHistory();
      const newRows: TimelineRow[] = [];
      for (const a of res.assets) {
        const clipId = newId();
        const uri = persistClip(a.uri, clipId);
        const durationMs = Math.round(a.duration ?? 0);
        const rating = rateClip({
          clipId,
          durationMs,
          source: 'imported',
        });
        // The recording lands in clips (it's a new source); a timeline
        // row pointing at it gets appended below so it shows up on the
        // main track.
        const created = await addClip(
          projectId,
          uri,
          durationMs,
          rating.verdict,
          rating.tag,
          clipId
        );
        newRows.push(rowFromClip(created));
        void maybeTranscribe(clipId);
      }
      setTimeline((prev) => (prev ? [...prev, ...newRows] : newRows));
      invalidate(); // refresh clipsDb so the new sources show up in the join
    } catch {
      /* picker errors swallowed; nothing to roll back */
    }
  }

  // Pick an image or video from the photo library and add it as a media
  // overlay starting at the current playhead. The file is copied into the
  // app's overlays/ dir so it survives photo-library cleanup, and undo
  // wipes both the row and the on-disk file (via deleteOverlay).
  async function addMediaOverlay() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (res.canceled || !res.assets || res.assets.length === 0) return;
      const asset = res.assets[0];
      const isVideo =
        asset.type === 'video' ||
        /\.(mp4|mov|m4v)$/i.test(asset.uri ?? '');
      const overlayId = newId();
      // Pull the extension off the picker uri; fall back per kind so the
      // saved file is always playable/displayable.
      const m = (asset.uri ?? '').match(/\.[a-zA-Z0-9]+$/);
      const ext = m ? m[0] : isVideo ? '.mp4' : '.jpg';
      const rel = persistOverlayMedia(asset.uri, overlayId, ext);
      const start = globalMs;
      // Image overlays default to 4s; video overlays default to the asset's
      // own duration (or 5s if unknown).
      const assetDurationMs = isVideo
        ? Math.max(1000, Math.round((asset.duration ?? 5) * 1000))
        : 4000;
      const end = Math.min(
        totalMs > 0 ? totalMs : start + assetDurationMs,
        start + assetDurationMs
      );
      let createdId: string | null = null;
      let createdSnap: Overlay | null = null;
      await runCmd({
        do: async () => {
          const re = createdSnap
            ? await addOverlay(projectId, createdSnap)
            : await addOverlay(projectId, {
                kind: isVideo ? 'video' : 'image',
                file_uri: rel,
                start_ms: start,
                end_ms: end,
              });
          createdId = re.id;
          createdSnap = re;
          invalidate();
        },
        undo: async () => {
          if (createdId) {
            await deleteOverlay(createdId);
            invalidate();
          }
        },
      });
    } catch {
      /* picker failure — surface nothing, the user can retry */
    }
  }

  // Persist an overlay duration change (chip trim). Optimistic local
  // update so the chip width doesn't briefly snap back to its pre-drag
  // size while the DB write resolves.
  async function persistOverlayDuration(
    o: Overlay,
    newStart: number,
    newEnd: number
  ) {
    const id = o.id;
    const prevStart = o.start_ms;
    const prevEnd = o.end_ms;
    const start = Math.round(newStart);
    const end = Math.round(newEnd);
    if (start === prevStart && end === prevEnd) return;
    await runCmd({
      do: async () => {
        setOverlays((s) =>
          s.map((x) =>
            x.id === id ? { ...x, start_ms: start, end_ms: end } : x
          )
        );
        await updateOverlay(id, { start_ms: start, end_ms: end });
        invalidate();
      },
      undo: async () => {
        setOverlays((s) =>
          s.map((x) =>
            x.id === id
              ? { ...x, start_ms: prevStart, end_ms: prevEnd }
              : x
          )
        );
        await updateOverlay(id, { start_ms: prevStart, end_ms: prevEnd });
        invalidate();
      },
    });
  }

  // Persist a scale change. For text overlays we drive `size` (font px);
  // for media we drive `scale` (0..1 fraction of preview width).
  async function persistOverlaySize(o: Overlay, value: number) {
    const id = o.id;
    const isMedia = o.kind === 'image' || o.kind === 'video';
    const prev = isMedia ? o.scale : o.size;
    if (prev === value) return;
    const patch = isMedia ? { scale: value } : { size: value };
    const prevPatch = isMedia ? { scale: prev } : { size: prev };
    await runCmd({
      do: async () => {
        setOverlays((s) =>
          s.map((x) => (x.id === id ? { ...x, ...patch } : x))
        );
        await updateOverlay(id, patch);
        invalidate();
      },
      undo: async () => {
        setOverlays((s) =>
          s.map((x) => (x.id === id ? { ...x, ...prevPatch } : x))
        );
        await updateOverlay(id, prevPatch);
        invalidate();
      },
    });
  }

  async function moveOverlay(o: Overlay, x: number, y: number) {
    const id = o.id;
    const prevX = o.x;
    const prevY = o.y;
    await runCmd({
      do: async () => {
        await updateOverlay(id, { x, y });
        setOverlays((s) =>
          s.map((it) => (it.id === id ? { ...it, x, y } : it))
        );
        invalidate();
      },
      undo: async () => {
        await updateOverlay(id, { x: prevX, y: prevY });
        setOverlays((s) =>
          s.map((it) =>
            it.id === id ? { ...it, x: prevX, y: prevY } : it
          )
        );
        invalidate();
      },
    });
  }
  async function removeOverlay(o: Overlay) {
    // Track currentId so do/undo/redo always hit the live row id
    // (addOverlay generates a new id on each re-add).
    let currentId = o.id;
    const snap: Overlay = { ...o };
    await runCmd({
      do: async () => {
        await deleteOverlay(currentId);
        setOverlays((s) => s.filter((x) => x.id !== currentId));
        invalidate();
      },
      undo: async () => {
        const re = await addOverlay(projectId, { ...snap });
        currentId = re.id;
        invalidate();
      },
    });
  }

  // ----- subtitles (synced caption under preview) -----
  // Captions: auto-derived from per-clip transcript_words and remapped
  // into composed-timeline ms. Style + enable lives on the project row.
  const captionsEnabled = project?.captions_enabled !== 0;
  const captionStyle: CaptionStyle =
    (project?.caption_style as CaptionStyle) ?? 'karaoke';
  const captionFont: CaptionFont =
    (project?.caption_font as CaptionFont) ?? 'display';
  const captionLines: CaptionLine[] = useMemo(
    () => lineifyProject(included, cumulative),
    [included, cumulative]
  );
  const captionNow = useMemo(
    () => (captionsEnabled ? activeLineAt(captionLines, globalMs) : null),
    [captionLines, captionsEnabled, globalMs]
  );

  // Which clip is under the playhead right now (drives preview dimming for
  // the show/hide toggle — excluded clips render at 0.4 opacity).
  const currentIdx = useMemo(() => {
    if (included.length === 0) return -1;
    for (let i = 0; i < included.length; i++) {
      if (globalMs < cumulative[i + 1]) return i;
    }
    return included.length - 1;
  }, [globalMs, included, cumulative]);
  const activeDim =
    currentIdx >= 0 ? included[currentIdx]?.excluded === 1 : false;
  const activeMirrored =
    currentIdx >= 0 ? included[currentIdx]?.mirrored === 1 : false;

  // ----- timeline scroll (centered playhead model) -----
  const scrollRef = useRef<ScrollView>(null);
  const userScrolling = useRef(false);
  // Timeline width = composed length + headroom for the tail "+" cell.
  // The ScrollView's contentContainerStyle paddingLeft/Right already
  // gives the centered playhead room to reach either end.
  const timelineW = useMemo(
    () => Math.max(1, totalMs * pxPerMs) + CLIP_H + 16,
    [totalMs, pxPerMs]
  );

  // Keep the time-under-playhead pinned to viewport center while playing.
  // When the user is dragging the timeline, they own scroll position.
  useEffect(() => {
    if (userScrolling.current) return;
    if (viewportW === 0) return;
    const x = globalMs * pxPerMs;
    scrollRef.current?.scrollTo({ x: Math.max(0, x), animated: false });
  }, [globalMs, pxPerMs, viewportW]);

  // While the user drags the timeline, drive the player from scroll offset.
  // `deferSwap` means cross-clip transitions don't trigger an expensive
  // `player.replace()` mid-scroll; the swap happens once scrolling stops.
  // Breadcrumb counter lets us trace the last few scroll ticks before a
  // crash without spamming the buffer (one crumb per 8 ticks ≈ 8/s at
  // 60Hz scrollEventThrottle=16).
  const scrollCrumbCount = useRef(0);
  const onTimelineScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!userScrolling.current) return;
      const x = e.nativeEvent.contentOffset.x;
      const ms = x / pxPerMsRef.current;
      scrollCrumbCount.current = (scrollCrumbCount.current + 1) % 8;
      if (scrollCrumbCount.current === 0) {
        crumb('editor.scroll', 'tick', {
          x: Math.round(x),
          ms: Math.round(ms),
        });
      }
      seekToGlobalMs(ms);
    },
    [seekToGlobalMs]
  );

  // Settle-scroll timer: onScrollEndDrag fires when the finger lifts, even if
  // momentum is about to start. We wait briefly to see if momentum begins; if
  // it does, onMomentumScrollBegin cancels this timer and the real end fires
  // on onMomentumScrollEnd.
  const scrubEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endScrub = useCallback(() => {
    if (scrubEndTimer.current) {
      clearTimeout(scrubEndTimer.current);
      scrubEndTimer.current = null;
    }
    userScrolling.current = false;
    try {
      player.setScrubbing(false);
    } catch (e) {
      crumb('editor.scroll', 'setScrubbing(false) threw', {
        err: (e as Error).message,
      });
    }
    commitPendingSwap();
  }, [commitPendingSwap, player]);

  // Pinch-to-zoom on the timeline. `runOnJS(true)` is required because
  // Reanimated is installed — without it, gesture callbacks default to
  // worklets and our React state setters silently fail.
  const pinchBaseline = useRef(DEFAULT_PX_PER_MS);
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          pinchBaseline.current = pxPerMsRef.current;
        })
        .onUpdate((e) => {
          const next = clamp(
            pinchBaseline.current * e.scale,
            MIN_PX_PER_MS,
            MAX_PX_PER_MS
          );
          if (next !== pxPerMsRef.current) setPxPerMs(next);
        })
        .runOnJS(true),
    []
  );

  if (!project || !clipsDb || timeline === null) {
    return (
      <SafeAreaView style={styles.root}>
        <Loading />
      </SafeAreaView>
    );
  }

  const ticks: number[] = [];
  const totalSecCeil = Math.ceil((totalMs > 0 ? totalMs : 30_000) / 1000);
  for (let s = 0; s <= totalSecCeil; s++) ticks.push(s);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* ===== Header ================================================ */}
      <View style={styles.headerRow}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="close" size={26} color={palette.text} />
        </Pressable>
        <Pressable
          style={styles.titleChip}
          onPress={() => router.back()}
          hitSlop={6}
        >
          <Text numberOfLines={1} style={styles.titleText}>
            {project.title}
          </Text>
          <Ionicons name="chevron-down" size={14} color={palette.text} />
        </Pressable>
        <Text style={styles.qualityLbl}>4K</Text>
        <Pressable style={styles.nextBtn} onPress={() => router.back()}>
          <Text style={styles.nextText}>Next</Text>
          <Ionicons
            name="chevron-forward"
            size={14}
            color={palette.onBright}
          />
        </Pressable>
      </View>

      {/* ===== Preview =============================================== */}
      <View style={styles.previewWrap}>
        <View style={styles.previewFrame}>
          {/* One native composition player. AVMutableComposition /
              ExoPlayer handle boundary cuts internally, so there's no
              flash, swap, or stutter at clip junctions. */}
          <NlePlayerView
            player={player}
            style={[
              StyleSheet.absoluteFill,
              {
                opacity: activeDim ? 0.4 : 1,
                transform: activeMirrored ? [{ scaleX: -1 }] : [],
              },
            ]}
          />
          {overlays
            .filter((o) => globalMs >= o.start_ms && globalMs < o.end_ms)
            .map((o) => {
              // Apply keyframes if present: interp x/y/scale at globalMs.
              const kfs = getKeyframes(o.keyframes_json);
              const eff =
                kfs.length === 0
                  ? o
                  : {
                      ...o,
                      ...interpKeyframes(kfs, globalMs, {
                        x: o.x,
                        y: o.y,
                        scale: o.scale,
                        rotation: 0,
                      }),
                    };
              return (
                <DraggableOverlay
                  key={o.id}
                  overlay={eff}
                  selected={o.id === selectedOverlayId}
                  onSelect={() => selectOverlay(o.id)}
                  onMove={(x, y) => moveOverlay(o, x, y)}
                  onResize={(v) => persistOverlaySize(o, v)}
                  onDelete={() => removeOverlay(o)}
                />
              );
            })}
          {captionNow ? (
            <CaptionOverlay
              line={captionNow}
              style={captionStyle}
              fontKey={captionFont}
              nowMs={globalMs}
            />
          ) : null}
          <TransitionOverlay
            globalMs={globalMs}
            transitions={transitions}
            cumulative={cumulative}
          />
          <BeatMarkers beats={beats} globalMs={globalMs} />
          {voRecording ? <VoiceoverIndicator elapsedMs={voElapsedMs} /> : null}
          <LoadStatusBanner status={loadStatus} />
          <View style={styles.previewChevron}>
            <Ionicons
              name="chevron-down"
              size={18}
              color="rgba(255,255,255,0.85)"
            />
          </View>
        </View>
      </View>

      {/* ===== Transport ============================================= */}
      <View style={styles.transportRow}>
        <Pressable style={styles.playBtn} onPress={togglePlay}>
          <Ionicons
            name={playing ? 'pause' : 'play'}
            size={20}
            color={palette.text}
          />
        </Pressable>
        <Pressable
          style={styles.iconCircle}
          onPress={() => {
            const next: 0 | 1 = captionsEnabled ? 0 : 1;
            setCaptionSettings(projectId, { enabled: next }).catch(() => {});
            invalidate();
          }}
          hitSlop={6}
        >
          <Ionicons
            name="sparkles"
            size={18}
            color={captionsEnabled ? palette.yellow : palette.textDim}
          />
        </Pressable>
        <View style={styles.timeStack}>
          <Text style={styles.timeNow}>{mmss(globalMs)}</Text>
          <Text style={styles.timeTotal}>{mmss(totalMs)}</Text>
        </View>
        <Pressable
          style={styles.iconCircle}
          hitSlop={6}
          onPress={canUndo ? doUndo : undefined}
        >
          <Ionicons
            name="arrow-undo"
            size={18}
            color={canUndo ? palette.text : palette.textFaint}
          />
        </Pressable>
        <Pressable
          style={styles.iconCircle}
          hitSlop={6}
          onPress={canRedo ? doRedo : undefined}
        >
          <Ionicons
            name="arrow-redo"
            size={18}
            color={canRedo ? palette.text : palette.textFaint}
          />
        </Pressable>
      </View>

      {/* ===== Multi-track timeline ================================== */}
      <GestureDetector gesture={pinchGesture}>
        <View
          style={styles.timelineWrap}
          onLayout={(e) => setViewportW(e.nativeEvent.layout.width)}
        >
          <ScrollView
            ref={scrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={onTimelineScroll}
            onScrollBeginDrag={() => {
              userScrolling.current = true;
              crumb('editor.scroll', 'begin', {
                clipCount: included.length,
                totalMs: Math.round(totalMs),
                pxPerMs: pxPerMs.toFixed(2),
              });
              if (scrubEndTimer.current) {
                clearTimeout(scrubEndTimer.current);
                scrubEndTimer.current = null;
              }
              try {
                player.pause();
                // Tell the native CIFilter handler to skip color /
                // Vision processing while the user is dragging. Cheap
                // preview frames during scrub, full chain back on
                // settle.
                player.setScrubbing(true);
              } catch (e) {
                crumb('editor.scroll', 'pause threw', {
                  err: (e as Error).message,
                });
              }
            }}
            onScrollEndDrag={() => {
              crumb('editor.scroll', 'endDrag');
              // Wait briefly for momentum to begin; if it doesn't, end the
              // scrub and commit the deferred clip swap.
              if (scrubEndTimer.current) clearTimeout(scrubEndTimer.current);
              scrubEndTimer.current = setTimeout(endScrub, 120);
            }}
            onMomentumScrollBegin={() => {
              if (scrubEndTimer.current) {
                clearTimeout(scrubEndTimer.current);
                scrubEndTimer.current = null;
              }
            }}
            onMomentumScrollEnd={endScrub}
            style={styles.timelineScroll}
            contentContainerStyle={{
              paddingLeft: viewportW / 2,
              paddingRight: viewportW / 2,
            }}
          >
            <Pressable
              onPress={clearSelection}
              style={{
                width: timelineW,
                height: TRACK_BLOCK_H,
                position: 'relative',
              }}
            >
              {/* Ruler */}
              <View style={[styles.ruler, { width: timelineW }]}>
                {ticks.map((s) => (
                  <View
                    key={s}
                    style={[
                      styles.rulerTick,
                      { left: s * 1000 * pxPerMs - 0.5 },
                    ]}
                  >
                    <Text style={styles.rulerLabel}>{s}s</Text>
                  </View>
                ))}
              </View>

              {/* Subtitles row */}
              <View
                style={[
                  styles.trackRow,
                  { top: RULER_H + TRACK_GAP, height: SUBS_H },
                ]}
              >
                {renderSubtitleChips(included, cumulative, pxPerMs)}
              </View>

              {/* Overlays row */}
              <View
                style={[
                  styles.trackRow,
                  {
                    top: RULER_H + TRACK_GAP + SUBS_H + TRACK_GAP,
                    height: OVRL_H,
                  },
                ]}
              >
                {overlays.map((o) => (
                  <OverlayChip
                    key={o.id}
                    overlay={o}
                    pxPerMs={pxPerMs}
                    selected={o.id === selectedOverlayId}
                    onSelect={() => selectOverlay(o.id)}
                    onTrimRelease={(s, e) =>
                      persistOverlayDuration(o, s, e)
                    }
                  />
                ))}
                <Pressable
                  style={styles.overlayAddBtn}
                  onPress={() => setOverlayModal(true)}
                >
                  <Ionicons name="add" size={14} color={palette.purple} />
                </Pressable>
              </View>

              {/* Clip strip */}
              <View
                style={[
                  styles.trackRow,
                  { top: CLIP_TOP, height: CLIP_H },
                ]}
              >
                {included.map((c, idx) => {
                  const baseLeft = cumulative[idx] * pxPerMs;
                  // Exact proportional width so each clip ends graphically
                  // where it actually ends. No tap-area floor — the
                  // selection still works on a 1px cell, just gets harder
                  // to hit at extreme zoom-out.
                  const baseW = effLen(c) * pxPerMs;
                  let dispLeft = baseLeft;
                  let dispW = baseW;
                  // Reorder drag: shift just the dragged cell by dx;
                  // other cells stay put (the visual reflow happens on
                  // commit). Keeps the drop-target math simple.
                  if (reorderDrag && reorderDrag.fromIdx === idx) {
                    dispLeft = baseLeft + reorderDrag.dx;
                  }
                  if (trimDrag) {
                    const trimIdx = included.findIndex(
                      (x) => x.id === trimDrag.id
                    );
                    if (idx === trimIdx) {
                      dispLeft = baseLeft + trimDrag.dxIn;
                      // Keep a small min during an active trim drag so the
                      // user can see what they're trimming.
                      dispW = Math.max(
                        24,
                        baseW - trimDrag.dxIn + trimDrag.dxOut
                      );
                    } else if (idx > trimIdx) {
                      dispLeft = baseLeft + trimDrag.dxOut;
                    }
                  }
                  // Snap targets (in translationX terms) for this clip's
                  // handles — align the new IN/OUT edge with the playhead.
                  const snapInPx = (globalMs - cumulative[idx]) * pxPerMs;
                  const snapOutPx =
                    (globalMs - (cumulative[idx] + effLen(c))) * pxPerMs;
                  return (
                    <ClipCell
                      key={c.id}
                      clip={c}
                      left={dispLeft}
                      width={dispW}
                      pxPerMs={pxPerMs}
                      selected={c.id === selectedId}
                      snapInPx={snapInPx}
                      snapOutPx={snapOutPx}
                      reordering={reorderDrag?.fromIdx === idx}
                      onSelect={() => selectClip(c.id)}
                      onTrimChange={(dxIn, dxOut) =>
                        setTrimDrag({ id: c.id, dxIn, dxOut })
                      }
                      onTrimEnd={() => setTrimDrag(null)}
                      onTrimRelease={(newIn, newOut) =>
                        persistTrim(newIn, newOut)
                      }
                      onReorderStart={() =>
                        setReorderDrag({ fromIdx: idx, dx: 0 })
                      }
                      onReorderMove={(dx) =>
                        setReorderDrag({ fromIdx: idx, dx })
                      }
                      onReorderEnd={() => {
                        const r = reorderDrag;
                        setReorderDrag(null);
                        if (r) void commitReorder(r.fromIdx, r.dx);
                      }}
                    />
                  );
                })}
                {/* Tail "+" cell — opens the picker to append more clips
                    to the end of the main track. Sits right after the
                    last clip in the same coordinate space. */}
                <Pressable
                  style={[
                    styles.addClipCell,
                    { left: totalMs * pxPerMs + 4 },
                  ]}
                  onPress={addClipToMainTrack}
                >
                  <Ionicons name="add" size={20} color={palette.lime} />
                </Pressable>
              </View>

              {/* Audio strip: a violet block per detached clip */}
              <View
                style={[
                  styles.trackRow,
                  { top: AUDIO_TOP, height: AUDIO_H },
                ]}
              >
                {included.map((c, idx) => {
                  if (c.audio_detached !== 1) return null;
                  const baseLeft = cumulative[idx] * pxPerMs;
                  // Match the clip width exactly so the audio block ends
                  // where the clip ends.
                  const baseW = effLen(c) * pxPerMs;
                  let dispLeft = baseLeft;
                  let dispW = baseW;
                  if (trimDrag) {
                    const trimIdx = included.findIndex(
                      (x) => x.id === trimDrag.id
                    );
                    if (idx === trimIdx) {
                      dispLeft = baseLeft + trimDrag.dxIn;
                      dispW = Math.max(
                        24,
                        baseW - trimDrag.dxIn + trimDrag.dxOut
                      );
                    } else if (idx > trimIdx) {
                      dispLeft = baseLeft + trimDrag.dxOut;
                    }
                  }
                  return (
                    <AudioChip
                      key={c.id}
                      left={dispLeft}
                      width={dispW}
                      muted={(c.audio_volume ?? 1) === 0}
                      selected={c.id === selectedId}
                      onPress={() => selectClip(c.id)}
                    />
                  );
                })}
              </View>
            </Pressable>
          </ScrollView>

          {/* Centered playhead — fixed in viewport, content scrolls under it */}
          <View
            pointerEvents="none"
            style={[
              styles.playheadCenter,
              {
                left: Math.max(0, viewportW / 2 - 0.5),
                height: TRACK_BLOCK_H + 12,
              },
            ]}
          >
            <View style={styles.playheadCap} />
          </View>
        </View>
      </GestureDetector>

      {/* ===== Floating panel layer ==================================
          Renders any open bottom panel as an absolute overlay anchored
          to the bottom of the screen, sitting directly above the
          action bar. The action bar's own position never shifts when
          a panel opens/closes — it's also absolute-positioned, with
          the timeline content sized to leave room for it.
      */}
      <View
        style={[styles.panelLayer, { bottom: actionBarH }]}
        pointerEvents="box-none"
      >
      {bottomMode === 'volume' && selected ? (
        <VolumePanel
          value={selected.audio_volume ?? 1}
          onChange={changeVolume}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'speed' ? (
        <SpeedPanel
          value={speed}
          onChange={doSpeed}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'size' && selectedOverlay ? (
        <OverlaySizePanel
          overlay={selectedOverlay}
          onCommit={(v) => persistOverlaySize(selectedOverlay, v)}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'captions' ? (
        <CaptionsPanel
          enabled={captionsEnabled}
          style={captionStyle}
          fontKey={captionFont}
          lines={captionLines}
          onToggle={(en) => {
            setCaptionSettings(projectId, { enabled: en ? 1 : 0 }).catch(
              () => {}
            );
            invalidate();
          }}
          onStyleChange={(s) => {
            setCaptionSettings(projectId, { style: s }).catch(() => {});
            invalidate();
          }}
          onFontChange={(f) => {
            setCaptionSettings(projectId, { font: f }).catch(() => {});
            invalidate();
          }}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'slip' && selected ? (
        <SlipPanel
          clip={selected}
          onSlip={doSlip}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'stickers' ? (
        <StickerPanel
          onPick={(emoji) => {
            // Add as a text overlay at the playhead, 3s long.
            addTextOverlay(emoji);
            setBottomMode('none');
          }}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'teleprompter' ? (
        <TeleprompterPanel onClose={() => setBottomMode('none')} />
      ) : null}
      {bottomMode === 'adjust' && selected ? (
        <AdjustPanel
          effects={selectedEffects}
          onChange={patchSelectedEffects}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'filters' && selected ? (
        <FiltersPanel
          effects={selectedEffects}
          onPick={applyPreset}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'green' && selected ? (
        <GreenScreenPanel
          effects={selectedEffects}
          onChange={patchSelectedEffects}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'voicefx' && selected ? (
        <VoiceFxPanel
          effects={selectedEffects}
          onChange={patchSelectedEffects}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'voiceEnh' && selected ? (
        <VoiceEnhancePanel
          effects={selectedEffects}
          onChange={patchSelectedEffects}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'cutout' && selected ? (
        <CutoutPanel
          effects={selectedEffects}
          onChange={async (patch) => {
            // Side-effect: keep a "subject" overlay in sync with the
            // cutoutEnabled flag so the layer is visible in the
            // timeline + the native engine has a target to mask.
            if (
              typeof patch.cutoutEnabled === 'boolean' &&
              selected
            ) {
              const idx = included.findIndex(
                (c) => c.id === selected.id
              );
              const compStart = cumulative[idx] ?? 0;
              const compEnd = cumulative[idx + 1] ?? compStart;
              // Subject overlays key off the underlying recording, not
              // the timeline-row id — multiple timeline rows can share
              // a source, and the cutout's source frames come from
              // the original file.
              const srcId = selected.source_clip_id;
              if (patch.cutoutEnabled) {
                const existing = await findSubjectOverlayFor(srcId);
                if (!existing) {
                  await createSubjectOverlay(
                    projectId,
                    srcId,
                    compStart,
                    compEnd,
                    selected.file_uri
                  );
                }
              } else {
                await removeSubjectOverlayFor(srcId);
              }
            }
            await patchSelectedEffects(patch);
          }}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'restyle' && selected ? (
        <RestylePanel
          effects={selectedEffects}
          onChange={patchSelectedEffects}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'keyframes' && selectedOverlay ? (
        <KeyframesPanel
          keyframes={selectedOverlayKfs}
          currentMs={globalMs}
          baseXY={{
            x: selectedOverlay.x,
            y: selectedOverlay.y,
            scale: selectedOverlay.scale,
          }}
          onAdd={async (kf) => {
            const next = [...selectedOverlayKfs, kf].sort(
              (a, b) => a.tMs - b.tMs
            );
            await setOverlayKeyframes(selectedOverlay.id, next);
            invalidate();
          }}
          onClear={async () => {
            await setOverlayKeyframes(selectedOverlay.id, []);
            invalidate();
          }}
          onDelete={async (i) => {
            const next = selectedOverlayKfs
              .slice()
              .sort((a, b) => a.tMs - b.tMs)
              .filter((_, idx) => idx !== i);
            await setOverlayKeyframes(selectedOverlay.id, next);
            invalidate();
          }}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'transitions' ? (
        <TransitionsPanel
          boundaryIndex={nearestBoundaryIdx}
          current={
            transitions[nearestBoundaryIdx] ?? {
              kind: 'none',
              durationMs: 300,
            }
          }
          onPick={async (kind) => {
            await setTransition(projectId, nearestBoundaryIdx, {
              kind,
              durationMs:
                transitions[nearestBoundaryIdx]?.durationMs ?? 300,
            });
            invalidate();
          }}
          onDurationChange={async (ms) => {
            const cur = transitions[nearestBoundaryIdx];
            if (!cur || cur.kind === 'none') return;
            await setTransition(projectId, nearestBoundaryIdx, {
              kind: cur.kind,
              durationMs: ms,
            });
            invalidate();
          }}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'beats' ? (
        <BeatsPanel
          beats={beats}
          currentMs={globalMs}
          onAdd={async (ms) => {
            await setBeats(projectId, [...beats, ms]);
            invalidate();
          }}
          onClear={async () => {
            await setBeats(projectId, []);
            invalidate();
          }}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'voiceover' ? (
        <VoiceoverPanel
          isRecording={voRecording}
          elapsedMs={voElapsedMs}
          onStart={startVoiceover}
          onStop={stopVoiceover}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      {bottomMode === 'audio' ? (
        <AudioPanel onPick={pickAudio} onClose={() => setBottomMode('none')} />
      ) : null}
      {bottomMode === 'silences' ? (
        <CutSilencesPanel
          offsetMs={silencesOffset}
          isApplying={silencesApplying}
          lastResult={silencesResult}
          onOffsetChange={setSilencesOffset}
          onRun={runCutSilences}
          onClose={() => setBottomMode('none')}
        />
      ) : null}
      </View>

      {/* ===== Bottom action bar (selection-aware roster) ============ */}
      <View
        style={styles.actionBar}
        onLayout={(e) => setActionBarH(e.nativeEvent.layout.height)}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.actionScrollContent}
        >
          {selected || selectedOverlay ? (
            <ClipActions
              selected={selected}
              selectedOverlay={selectedOverlay}
              bottomMode={bottomMode}
              setBottomMode={setBottomMode}
              doSplit={doSplit}
              toggleMirror={toggleMirror}
              toggleMute={toggleMute}
              toggleAudioDetached={toggleAudioDetached}
              toggleExclude={toggleExclude}
              doDeleteSelection={doDeleteSelection}
              doDuplicate={doDuplicate}
              doReplace={doReplace}
            />
          ) : (
            <GlobalActions
              bottomMode={bottomMode}
              setBottomMode={setBottomMode}
              setOverlayModal={setOverlayModal}
              addMediaOverlay={addMediaOverlay}
              addClipToMainTrack={addClipToMainTrack}
              openCaptionsPanel={() => {
                // Re-attempt transcription for any clip that still has no
                // word timings — captions are empty until words exist.
                // c.id here is a timeline row id; transcription targets
                // the underlying recording.
                for (const c of clips) {
                  if (!c.transcript_words) void maybeTranscribe(c.source_clip_id);
                }
                setBottomMode((m) =>
                  m === 'captions' ? 'none' : 'captions'
                );
              }}
              captionsActive={bottomMode === 'captions'}
              onRecordTab={() => router.push('/(tabs)/camera')}
            />
          )}
        </ScrollView>
      </View>

      {/* ===== Add-overlay modal ===================================== */}
      <Modal
        visible={overlayModal}
        transparent
        animationType="fade"
        onRequestClose={() => setOverlayModal(false)}
      >
        <View style={styles.modalScrim}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add text</Text>
            <TextInput
              value={overlayDraft}
              onChangeText={setOverlayDraft}
              placeholder="Your overlay text"
              placeholderTextColor={palette.textFaint}
              autoFocus
              style={styles.modalInput}
            />
            <Text style={styles.modalHint}>
              Starts at {mmss(globalMs)}, lasts 3s. Drag it on the preview to
              reposition.
            </Text>
            <View style={styles.modalBtnRow}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setOverlayModal(false)}
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={commitNewOverlay}
              >
                <Text style={styles.modalBtnPrimaryText}>Add</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ============================================================
// Subtitle chip placement (one chip per word, time-positioned)
// ============================================================
function renderSubtitleChips(
  included: Clip[],
  cumulative: number[],
  pxPerMs: number
) {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < included.length; i++) {
    const c = included[i];
    if (!c.transcript_words) continue;
    let words: WordTiming[] = [];
    try {
      const arr = JSON.parse(c.transcript_words) as WordTiming[];
      if (Array.isArray(arr)) words = arr;
    } catch {
      /* ignore */
    }
    const base = cumulative[i];
    const inMs = c.in_ms ?? 0;
    const outMs = c.out_ms ?? c.duration_ms;
    for (let j = 0; j < words.length; j++) {
      const w = words[j];
      const wsMs = w.s * 1000;
      const weMs = w.e * 1000;
      if (weMs < inMs || wsMs > outMs) continue;
      const startGlobal = base + Math.max(0, wsMs - inMs);
      const endGlobal = base + Math.max(0, Math.min(outMs, weMs) - inMs);
      const width = Math.max(20, (endGlobal - startGlobal) * pxPerMs);
      out.push(
        <View
          key={`${c.id}-${j}`}
          style={[
            styles.subChip,
            { left: startGlobal * pxPerMs, width },
          ]}
        >
          <Text numberOfLines={1} style={styles.subChipText}>
            {w.w}
          </Text>
        </View>
      );
    }
  }
  return out;
}

// ============================================================
// Subcomponents
// ============================================================
function ClipCell({
  clip,
  left,
  width,
  pxPerMs,
  selected,
  snapInPx,
  snapOutPx,
  reordering,
  onSelect,
  onTrimChange,
  onTrimEnd,
  onTrimRelease,
  onReorderStart,
  onReorderMove,
  onReorderEnd,
}: {
  clip: Clip;
  left: number;
  width: number;
  pxPerMs: number;
  selected: boolean;
  // Snap targets in translationX (px) terms — the dx where the new IN/OUT
  // edge aligns with the playhead.
  snapInPx: number;
  snapOutPx: number;
  /** True while this cell is the one being long-press-dragged for
   *  reorder. Lifts it visually so the user sees they "have" it. */
  reordering?: boolean;
  onSelect: () => void;
  // Fired on every pan update so the parent can reflow the rest of the
  // timeline in lockstep with the drag.
  onTrimChange: (dxIn: number, dxOut: number) => void;
  onTrimEnd: () => void;
  onTrimRelease: (newIn: number, newOut: number) => void;
  onReorderStart: () => void;
  onReorderMove: (dx: number) => void;
  onReorderEnd: () => void;
}) {
  const inMs = effIn(clip);
  const outMs = effOut(clip);
  // pxPerMs and the trim bounds can change between drag start and release
  // (pinch zoom mid-trim, or stale closure when the gesture re-uses memo),
  // so read live values via refs at release time.
  const pxPerMsRef = useRef(pxPerMs);
  pxPerMsRef.current = pxPerMs;
  const inMsRef = useRef(inMs);
  inMsRef.current = inMs;
  const outMsRef = useRef(outMs);
  outMsRef.current = outMs;
  const durationRef = useRef(clip.duration_ms);
  durationRef.current = clip.duration_ms;
  const snapInRef = useRef(snapInPx);
  snapInRef.current = snapInPx;
  const snapOutRef = useRef(snapOutPx);
  snapOutRef.current = snapOutPx;

  // Stabilize callback identity. The parent passes inline arrow
  // functions for onTrimChange/onTrimEnd/onTrimRelease, so they get a
  // new identity on every parent render. If those were in useMemo's
  // deps the trim gesture would be rebuilt mid-drag, destroying the
  // in-flight gesture before its onEnd could fire — meaning the trim
  // never persisted and the cell appeared to snap back to its old
  // width. Refs pin the callbacks; useMemo runs once.
  const onTrimChangeRef = useRef(onTrimChange);
  onTrimChangeRef.current = onTrimChange;
  const onTrimEndRef = useRef(onTrimEnd);
  onTrimEndRef.current = onTrimEnd;
  const onTrimReleaseRef = useRef(onTrimRelease);
  onTrimReleaseRef.current = onTrimRelease;
  // Reorder callbacks — pinned to refs so the gesture doesn't rebuild
  // across renders (would lose any in-flight long-press-pan).
  const onReorderStartRef = useRef(onReorderStart);
  onReorderStartRef.current = onReorderStart;
  const onReorderMoveRef = useRef(onReorderMove);
  onReorderMoveRef.current = onReorderMove;
  const onReorderEndRef = useRef(onReorderEnd);
  onReorderEndRef.current = onReorderEnd;

  // Long-press + pan to drag this cell into a new slot on the main
  // track. Tap stays for select; the 300ms long-press latency keeps
  // casual taps from triggering reorder.
  const reorderGesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(300)
        .onStart(() => onReorderStartRef.current())
        .onUpdate((g) => onReorderMoveRef.current(g.translationX))
        .onEnd(() => onReorderEndRef.current())
        .onFinalize(() => onReorderEndRef.current())
        .runOnJS(true),
    []
  );

  // Snap window: within ~10px of the playhead the handle latches to it.
  const SNAP_PX = 10;
  const applySnap = (dx: number, target: number) =>
    Math.abs(dx - target) < SNAP_PX ? target : dx;

  // RNGH Gesture.Pan (not PanResponder): RNGH's ScrollView won't yield to
  // PanResponder children, which is why the old trim handles never fired.
  // Pan gestures inside the same gesture system coordinate properly — the
  // child pan claims touches that start on the handle.
  const inPan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onUpdate((g) => {
          const dx = applySnap(g.translationX, snapInRef.current);
          onTrimChangeRef.current(dx, 0);
        })
        .onEnd((g) => {
          const dx = applySnap(g.translationX, snapInRef.current);
          const dMs = dx / pxPerMsRef.current;
          const newIn = clamp(
            inMsRef.current + dMs,
            0,
            outMsRef.current - 200
          );
          onTrimReleaseRef.current(newIn, outMsRef.current);
          onTrimEndRef.current();
        })
        .onFinalize(() => onTrimEndRef.current())
        .runOnJS(true),
    []
  );
  const outPan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onUpdate((g) => {
          const dx = applySnap(g.translationX, snapOutRef.current);
          onTrimChangeRef.current(0, dx);
        })
        .onEnd((g) => {
          const dx = applySnap(g.translationX, snapOutRef.current);
          const dMs = dx / pxPerMsRef.current;
          const newOut = clamp(
            outMsRef.current + dMs,
            inMsRef.current + 200,
            durationRef.current
          );
          onTrimReleaseRef.current(inMsRef.current, newOut);
          onTrimEndRef.current();
        })
        .onFinalize(() => onTrimEndRef.current())
        .runOnJS(true),
    []
  );

  const excluded = clip.excluded === 1;

  return (
    <GestureDetector gesture={reorderGesture}>
      <Pressable
        onPress={onSelect}
        style={[
          styles.cell,
          {
            left,
            width,
            opacity: excluded ? 0.4 : 1,
          },
          selected && styles.cellSelected,
          reordering && styles.cellReordering,
        ]}
      >
        <View style={StyleSheet.absoluteFill}>
          <ClipVideo uri={clip.file_uri} style={StyleSheet.absoluteFill} />
        </View>
      <View style={styles.cellBadge}>
        <Text style={styles.cellBadgeText}>
          {(effLen(clip) / 1000).toFixed(1)}s
        </Text>
      </View>
      {selected ? (
        <>
          <GestureDetector gesture={inPan}>
            <View style={[styles.trimHandle, styles.trimHandleLeft]}>
              <Ionicons
                name="chevron-back"
                size={14}
                color={palette.onBright}
              />
            </View>
          </GestureDetector>
          <GestureDetector gesture={outPan}>
            <View style={[styles.trimHandle, styles.trimHandleRight]}>
              <Ionicons
                name="chevron-forward"
                size={14}
                color={palette.onBright}
              />
            </View>
          </GestureDetector>
        </>
      ) : null}
      </Pressable>
    </GestureDetector>
  );
}

// Timeline chip for a project overlay (text or media). When selected, two
// edge handles let the user trim start_ms / end_ms; gestures release through
// onTrimRelease so the parent can persist + invalidate.
function OverlayChip({
  overlay,
  pxPerMs,
  selected,
  onSelect,
  onTrimRelease,
}: {
  overlay: Overlay;
  pxPerMs: number;
  selected: boolean;
  onSelect: () => void;
  onTrimRelease: (newStart: number, newEnd: number) => void;
}) {
  const [dxStart, setDxStart] = useState(0);
  const [dxEnd, setDxEnd] = useState(0);
  // Live refs so the gesture's onEnd closure reads the latest bounds even
  // if the props changed mid-drag (pinch zoom, sibling chip selection).
  const pxPerMsRef = useRef(pxPerMs);
  pxPerMsRef.current = pxPerMs;
  const startRef = useRef(overlay.start_ms);
  startRef.current = overlay.start_ms;
  const endRef = useRef(overlay.end_ms);
  endRef.current = overlay.end_ms;
  // Same callback-identity guard as ClipCell: the parent passes a fresh
  // onTrimRelease every render, which would rebuild the gesture mid-drag
  // and lose the in-flight gesture's onEnd. Pin via ref; useMemo runs once.
  const onTrimReleaseRef = useRef(onTrimRelease);
  onTrimReleaseRef.current = onTrimRelease;

  const startPan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onUpdate((g) => setDxStart(g.translationX))
        .onEnd((g) => {
          const dMs = g.translationX / pxPerMsRef.current;
          const newStart = Math.max(
            0,
            Math.min(endRef.current - 200, startRef.current + dMs)
          );
          setDxStart(0);
          onTrimReleaseRef.current(newStart, endRef.current);
        })
        .onFinalize(() => setDxStart(0))
        .runOnJS(true),
    []
  );

  const endPan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onUpdate((g) => setDxEnd(g.translationX))
        .onEnd((g) => {
          const dMs = g.translationX / pxPerMsRef.current;
          const newEnd = Math.max(
            startRef.current + 200,
            endRef.current + dMs
          );
          setDxEnd(0);
          onTrimReleaseRef.current(startRef.current, newEnd);
        })
        .onFinalize(() => setDxEnd(0))
        .runOnJS(true),
    []
  );

  const isMedia = overlay.kind === 'image' || overlay.kind === 'video';
  const isSubject = overlay.kind === 'subject';
  const baseLeft = overlay.start_ms * pxPerMs;
  const baseW = Math.max(40, (overlay.end_ms - overlay.start_ms) * pxPerMs);
  const liveLeft = baseLeft + (selected ? dxStart : 0);
  const liveW = Math.max(
    32,
    baseW - (selected ? dxStart : 0) + (selected ? dxEnd : 0)
  );

  return (
    <Pressable
      onPress={onSelect}
      style={[
        styles.overlayChip,
        isMedia && styles.overlayChipMedia,
        isSubject && styles.overlayChipSubject,
        selected && styles.overlayChipSelected,
        { left: liveLeft, width: liveW },
      ]}
    >
      {isSubject ? (
        <Ionicons name="person" size={12} color={palette.onBright} />
      ) : isMedia ? (
        <Ionicons
          name={overlay.kind === 'video' ? 'videocam' : 'image-outline'}
          size={12}
          color={palette.onBright}
        />
      ) : null}
      <Text numberOfLines={1} style={styles.overlayChipText}>
        {isSubject
          ? 'Subject'
          : isMedia
            ? overlay.kind === 'video'
              ? 'Video'
              : 'Image'
            : overlay.text}
      </Text>
      {selected ? (
        <>
          <GestureDetector gesture={startPan}>
            <View
              style={[styles.overlayTrim, styles.overlayTrimLeft]}
            />
          </GestureDetector>
          <GestureDetector gesture={endPan}>
            <View
              style={[styles.overlayTrim, styles.overlayTrimRight]}
            />
          </GestureDetector>
        </>
      ) : null}
    </Pressable>
  );
}

// Detached-audio block on the audio track. The bars are a stylized
// waveform (no real audio analysis), enough to read as audio at a glance.
function AudioChip({
  left,
  width,
  muted,
  selected,
  onPress,
}: {
  left: number;
  width: number;
  muted: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  // Deterministic-ish bar heights derived from index so layout is stable
  // across renders, and dense enough to look like a waveform at any width.
  const barCount = Math.max(8, Math.floor(width / 4));
  const bars = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < barCount; i++) {
      const h =
        0.35 +
        0.35 * Math.abs(Math.sin(i * 0.7)) +
        0.25 * Math.abs(Math.sin(i * 0.31));
      out.push(Math.min(1, h));
    }
    return out;
  }, [barCount]);
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.audioChip,
        { left, width },
        selected ? styles.audioChipSelected : null,
        muted ? { opacity: 0.45 } : null,
      ]}
    >
      <View style={styles.audioBars} pointerEvents="none">
        {bars.map((h, i) => (
          <View
            key={i}
            style={[
              styles.audioBar,
              { height: `${Math.round(h * 100)}%` },
            ]}
          />
        ))}
      </View>
      <Ionicons
        name={muted ? 'volume-mute' : 'musical-notes'}
        size={10}
        color={palette.violet}
        style={styles.audioChipIcon}
      />
    </Pressable>
  );
}

function ActionBtn({
  icon,
  label,
  onPress,
  active,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  const tint = disabled
    ? palette.textFaint
    : active
      ? palette.yellow
      : palette.text;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={styles.actionBtn}
      hitSlop={4}
    >
      <Ionicons name={icon} size={22} color={tint} />
      <Text style={[styles.actionLbl, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}


// ============================================================
// Selection-aware action rosters
// ============================================================

type ClipActionsProps = {
  selected: Clip | null;
  selectedOverlay: Overlay | null;
  bottomMode: BottomMode;
  setBottomMode: React.Dispatch<React.SetStateAction<BottomMode>>;
  doSplit: () => void;
  toggleMirror: () => void;
  toggleMute: () => void;
  toggleAudioDetached: () => void;
  toggleExclude: () => void;
  doDeleteSelection: () => void;
  doDuplicate: () => void;
  doReplace: () => void;
};

function ClipActions(p: ClipActionsProps) {
  const { selected, selectedOverlay } = p;
  const mute = selected && (selected.audio_volume ?? 1) === 0;
  return (
    <>
      <ActionBtn
        icon="cut-outline"
        label="Split"
        onPress={p.doSplit}
        disabled={!selected}
      />
      <ActionBtn
        icon="volume-medium-outline"
        label="Volume"
        onPress={() =>
          p.setBottomMode((m) => (m === 'volume' ? 'none' : 'volume'))
        }
        active={p.bottomMode === 'volume'}
        disabled={!selected}
      />
      <ActionBtn
        icon="speedometer-outline"
        label="Speed"
        onPress={() =>
          p.setBottomMode((m) => (m === 'speed' ? 'none' : 'speed'))
        }
        active={p.bottomMode === 'speed'}
      />
      <ActionBtn
        icon="options-outline"
        label="Adjust"
        onPress={() =>
          p.setBottomMode((m) => (m === 'adjust' ? 'none' : 'adjust'))
        }
        active={p.bottomMode === 'adjust'}
        disabled={!selected}
      />
      <ActionBtn
        icon="color-palette-outline"
        label="Filters"
        onPress={() =>
          p.setBottomMode((m) => (m === 'filters' ? 'none' : 'filters'))
        }
        active={p.bottomMode === 'filters'}
        disabled={!selected}
      />
      <ActionBtn
        icon="resize-outline"
        label="Size"
        onPress={() =>
          p.setBottomMode((m) => (m === 'size' ? 'none' : 'size'))
        }
        active={p.bottomMode === 'size'}
        disabled={!selectedOverlay}
      />
      <ActionBtn
        icon="swap-horizontal-outline"
        label="Mirror"
        onPress={p.toggleMirror}
        active={!!selected && selected.mirrored === 1}
        disabled={!selected}
      />
      <ActionBtn
        icon={mute ? 'volume-mute-outline' : 'volume-high-outline'}
        label={mute ? 'Muted' : 'Mute'}
        onPress={p.toggleMute}
        active={!!mute}
        disabled={!selected}
      />
      <ActionBtn
        icon="musical-notes-outline"
        label={
          selected && (selected.audio_detached ?? 0) === 1
            ? 'Attach'
            : 'Extract'
        }
        onPress={p.toggleAudioDetached}
        active={!!selected && (selected.audio_detached ?? 0) === 1}
        disabled={!selected}
      />
      <ActionBtn
        icon="duplicate-outline"
        label="Duplicate"
        onPress={p.doDuplicate}
        disabled={!selected}
      />
      <ActionBtn
        icon="git-compare-outline"
        label="Slip"
        onPress={() =>
          p.setBottomMode((m) => (m === 'slip' ? 'none' : 'slip'))
        }
        active={p.bottomMode === 'slip'}
        disabled={!selected}
      />
      <ActionBtn
        icon="repeat-outline"
        label="Replace"
        onPress={p.doReplace}
        disabled={!selected}
      />
      <ActionBtn
        icon="aperture-outline"
        label="Green"
        onPress={() =>
          p.setBottomMode((m) => (m === 'green' ? 'none' : 'green'))
        }
        active={p.bottomMode === 'green'}
        disabled={!selected}
      />
      <ActionBtn
        icon="mic-outline"
        label="Voice FX"
        onPress={() =>
          p.setBottomMode((m) => (m === 'voicefx' ? 'none' : 'voicefx'))
        }
        active={p.bottomMode === 'voicefx'}
        disabled={!selected}
      />
      <ActionBtn
        icon="layers-outline"
        label="Cutout"
        onPress={() =>
          p.setBottomMode((m) => (m === 'cutout' ? 'none' : 'cutout'))
        }
        active={p.bottomMode === 'cutout'}
        disabled={!selected}
      />
      <ActionBtn
        icon="sparkles-outline"
        label="Restyle"
        onPress={() =>
          p.setBottomMode((m) => (m === 'restyle' ? 'none' : 'restyle'))
        }
        active={p.bottomMode === 'restyle'}
        disabled={!selected}
      />
      <ActionBtn
        icon="locate-outline"
        label="Keyframes"
        onPress={() =>
          p.setBottomMode((m) => (m === 'keyframes' ? 'none' : 'keyframes'))
        }
        active={p.bottomMode === 'keyframes'}
        disabled={!selectedOverlay}
      />
      <ActionBtn
        icon={
          selected && selected.excluded === 1 ? 'eye-off-outline' : 'eye-outline'
        }
        label={selected && selected.excluded === 1 ? 'Hidden' : 'Show'}
        onPress={p.toggleExclude}
        disabled={!selected}
      />
      <ActionBtn
        icon="trash-outline"
        label="Delete"
        onPress={p.doDeleteSelection}
        disabled={!selected && !selectedOverlay}
      />
    </>
  );
}

type GlobalActionsProps = {
  bottomMode: BottomMode;
  setBottomMode: React.Dispatch<React.SetStateAction<BottomMode>>;
  setOverlayModal: (v: boolean) => void;
  addMediaOverlay: () => void;
  addClipToMainTrack: () => void;
  openCaptionsPanel: () => void;
  captionsActive: boolean;
  onRecordTab: () => void;
};

function GlobalActions(p: GlobalActionsProps) {
  return (
    <>
      <ActionBtn
        icon="add-outline"
        label="Media"
        onPress={p.addClipToMainTrack}
      />
      <ActionBtn
        icon="videocam-outline"
        label="Record"
        onPress={p.onRecordTab}
      />
      <ActionBtn
        icon="musical-notes-outline"
        label="Audio"
        onPress={() =>
          p.setBottomMode((m) => (m === 'audio' ? 'none' : 'audio'))
        }
        active={p.bottomMode === 'audio'}
      />
      <ActionBtn
        icon="mic-outline"
        label="Voiceover"
        onPress={() =>
          p.setBottomMode((m) => (m === 'voiceover' ? 'none' : 'voiceover'))
        }
        active={p.bottomMode === 'voiceover'}
      />
      <ActionBtn
        icon="megaphone-outline"
        label="Voice Enh"
        onPress={() =>
          p.setBottomMode((m) => (m === 'voiceEnh' ? 'none' : 'voiceEnh'))
        }
        active={p.bottomMode === 'voiceEnh'}
      />
      <ActionBtn
        icon="text-outline"
        label="Text"
        onPress={() => p.setOverlayModal(true)}
      />
      <ActionBtn
        icon="chatbubble-ellipses-outline"
        label="Captions"
        onPress={p.openCaptionsPanel}
        active={p.captionsActive}
      />
      <ActionBtn
        icon="happy-outline"
        label="Stickers"
        onPress={() =>
          p.setBottomMode((m) => (m === 'stickers' ? 'none' : 'stickers'))
        }
        active={p.bottomMode === 'stickers'}
      />
      <ActionBtn
        icon="images-outline"
        label="Overlays"
        onPress={p.addMediaOverlay}
      />
      <ActionBtn
        icon="swap-vertical-outline"
        label="Transitions"
        onPress={() =>
          p.setBottomMode((m) =>
            m === 'transitions' ? 'none' : 'transitions'
          )
        }
        active={p.bottomMode === 'transitions'}
      />
      <ActionBtn
        icon="contract-outline"
        label="Cut Silences"
        onPress={() =>
          p.setBottomMode((m) =>
            m === 'silences' ? 'none' : 'silences'
          )
        }
        active={p.bottomMode === 'silences'}
      />
      <ActionBtn
        icon="pulse-outline"
        label="Beats"
        onPress={() =>
          p.setBottomMode((m) => (m === 'beats' ? 'none' : 'beats'))
        }
        active={p.bottomMode === 'beats'}
      />
      <ActionBtn
        icon="reader-outline"
        label="Teleprompter"
        onPress={() =>
          p.setBottomMode((m) =>
            m === 'teleprompter' ? 'none' : 'teleprompter'
          )
        }
        active={p.bottomMode === 'teleprompter'}
      />
    </>
  );
}

// ============================================================
// Caption overlay (rendered over preview)
// ============================================================

/** Crossfade / fade-black overlay over the preview during a transition
 *  window. Renders a dimming layer whose opacity ramps up to mid-point
 *  and back down so it reads like a real fade between cuts. */
function TransitionOverlay({
  globalMs,
  transitions,
  cumulative,
}: {
  globalMs: number;
  transitions: Record<number, ProjectTransition>;
  cumulative: number[];
}) {
  // Find a boundary within its transition window.
  for (const key of Object.keys(transitions)) {
    const i = Number(key);
    const t = transitions[i];
    if (!t || t.kind === 'none') continue;
    const bms = cumulative[i + 1];
    if (bms === undefined) continue;
    const half = t.durationMs / 2;
    if (globalMs >= bms - half && globalMs <= bms + half) {
      // 0 → 1 → 0 over the window.
      const u = (globalMs - (bms - half)) / Math.max(1, t.durationMs);
      const alpha = 1 - Math.abs(u - 0.5) * 2;
      const color =
        t.kind === 'fade-black'
          ? '#000'
          : t.kind === 'glitch'
          ? palette.magenta
          : '#000';
      return (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: color,
            opacity: Math.max(0, Math.min(1, alpha)),
          }}
        />
      );
    }
  }
  return null;
}

/** Subtle pulse on the preview when a beat marker is within ±100ms of
 *  the playhead. Reads as a "snap" feedback while editing to beats. */
function BeatMarkers({
  beats,
  globalMs,
}: {
  beats: number[];
  globalMs: number;
}) {
  for (const b of beats) {
    if (Math.abs(b - globalMs) < 100) {
      return (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: palette.lime,
            shadowColor: palette.lime,
            shadowOpacity: 0.8,
            shadowRadius: 6,
          }}
        />
      );
    }
  }
  return null;
}

/** Banner over the preview that surfaces composition build status.
 *  Shows nothing once the player is readyToPlay; flashes a coral
 *  message on error / loading-with-warning so failures aren't silent. */
function LoadStatusBanner({
  status,
}: {
  status: {
    state: 'idle' | 'loading' | 'readyToPlay' | 'error';
    message?: string;
  };
}) {
  if (status.state === 'readyToPlay' || status.state === 'idle') return null;
  const isError = status.state === 'error';
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 10,
        backgroundColor: isError
          ? 'rgba(255,77,109,0.92)'
          : 'rgba(0,0,0,0.65)',
      }}
    >
      <Text
        numberOfLines={2}
        style={{
          color: '#fff',
          fontFamily: font.bodyBold,
          fontSize: 12,
        }}
      >
        {isError ? 'Video failed to load' : 'Loading…'}
      </Text>
      {status.message ? (
        <Text
          numberOfLines={2}
          style={{
            color: 'rgba(255,255,255,0.85)',
            fontFamily: font.body,
            fontSize: 10,
            marginTop: 2,
          }}
        >
          {status.message}
        </Text>
      ) : null}
    </View>
  );
}

/** Recording-indicator dot during a voiceover capture. */
function VoiceoverIndicator({ elapsedMs }: { elapsedMs: number }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: 'rgba(0,0,0,0.55)',
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: palette.coral,
        }}
      />
      <Text style={{ color: '#fff', fontFamily: font.monoBold, fontSize: 10 }}>
        REC {Math.floor(elapsedMs / 1000)}s
      </Text>
    </View>
  );
}

function CaptionOverlay({
  line,
  style,
  fontKey,
  nowMs,
}: {
  line: CaptionLine;
  style: CaptionStyle;
  fontKey: CaptionFont;
  nowMs: number;
}) {
  // For now all six presets render close-enough variations of the same
  // text — full per-style animation lands in the next pass. Style-specific
  // tweaks: typeout reveals letter-by-letter, bar paints a solid bg, bold
  // bumps weight + size, etc.
  const styleSpec: Record<
    CaptionStyle,
    { color: string; bg: string; size: number; pad: number }
  > = {
    karaoke: { color: '#fff', bg: 'rgba(0,0,0,0.65)', size: 18, pad: 5 },
    bold: { color: '#fff', bg: 'rgba(0,0,0,0.55)', size: 22, pad: 6 },
    pop: { color: palette.yellow, bg: 'rgba(0,0,0,0.55)', size: 20, pad: 6 },
    subtle: { color: '#fff', bg: 'rgba(0,0,0,0.35)', size: 14, pad: 4 },
    bar: { color: '#fff', bg: palette.purple, size: 18, pad: 6 },
    typeout: { color: '#fff', bg: 'rgba(0,0,0,0.6)', size: 18, pad: 5 },
  };
  const s = styleSpec[style];
  const text =
    style === 'typeout'
      ? line.words
          .filter((w) => nowMs >= w.s * 1000)
          .map((w) => w.w)
          .join(' ')
      : line.text;
  if (!text) return null;
  return (
    <View style={styles.subWrap} pointerEvents="none">
      <Text
        style={[
          styles.subText,
          {
            fontSize: s.size,
            color: s.color,
            fontFamily: CAPTION_FONT_FAMILY[fontKey],
            backgroundColor: s.bg,
            paddingHorizontal: s.pad + 5,
            paddingVertical: s.pad,
          },
        ]}
        numberOfLines={2}
      >
        {text}
      </Text>
    </View>
  );
}

// ============================================================
// Captions panel — style picker + transcription preview
// ============================================================

function CaptionsPanel({
  enabled,
  style,
  fontKey,
  lines,
  onToggle,
  onStyleChange,
  onFontChange,
  onClose,
}: {
  enabled: boolean;
  style: CaptionStyle;
  fontKey: CaptionFont;
  lines: CaptionLine[];
  onToggle: (en: boolean) => void;
  onStyleChange: (s: CaptionStyle) => void;
  onFontChange: (f: CaptionFont) => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.bottomPanel}>
      <View style={styles.bottomPanelHead}>
        <Ionicons
          name="chatbubble-ellipses-outline"
          size={16}
          color={palette.text}
        />
        <Text style={styles.bottomPanelTitle}>Captions</Text>
        <Pressable
          onPress={() => onToggle(!enabled)}
          style={[
            styles.captionToggle,
            enabled && styles.captionToggleOn,
          ]}
        >
          <Text
            style={[
              styles.captionToggleText,
              enabled && styles.captionToggleTextOn,
            ]}
          >
            {enabled ? 'ON' : 'OFF'}
          </Text>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={18} color={palette.textFaint} />
        </Pressable>
      </View>
      <Text style={styles.bottomPanelHint}>
        {lines.length === 0
          ? 'Transcribing… captions appear here once word timings arrive.'
          : `${lines.length} line${lines.length === 1 ? '' : 's'} from transcript`}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
      >
        {CAPTION_STYLES.map((s) => {
          const active = s === style;
          return (
            <Pressable
              key={s}
              onPress={() => onStyleChange(s)}
              style={[
                styles.styleChip,
                active && styles.styleChipActive,
              ]}
            >
              <Text
                style={[
                  styles.styleChipText,
                  active && styles.styleChipTextActive,
                ]}
              >
                {s[0].toUpperCase() + s.slice(1)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Text style={styles.bottomPanelHint}>Font</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
      >
        {CAPTION_FONT_OPTIONS.map((option) => {
          const active = option.key === fontKey;
          return (
            <Pressable
              key={option.key}
              onPress={() => onFontChange(option.key)}
              style={[
                styles.styleChip,
                active && styles.styleChipActive,
              ]}
            >
              <Text
                style={[
                  styles.styleChipText,
                  { fontFamily: CAPTION_FONT_FAMILY[option.key] },
                  active && styles.styleChipTextActive,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ============================================================
// Slip panel — scrubs the source window without resizing the clip
// ============================================================

function SlipPanel({
  clip,
  onSlip,
  onClose,
}: {
  clip: Clip;
  onSlip: (deltaMs: number) => void;
  onClose: () => void;
}) {
  const inMs = clip.in_ms ?? 0;
  const outMs = clip.out_ms ?? clip.duration_ms;
  const window = outMs - inMs;
  // Headroom on each side: how far we can slip before bumping the source
  // edges. min(in, duration - out) doesn't quite work; use both edges.
  const headLeft = inMs;
  const headRight = clip.duration_ms - outMs;
  return (
    <View style={styles.bottomPanel}>
      <View style={styles.bottomPanelHead}>
        <Ionicons name="git-compare-outline" size={16} color={palette.text} />
        <Text style={styles.bottomPanelTitle}>
          Slip · {Math.round(window)} ms window
        </Text>
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={18} color={palette.textFaint} />
        </Pressable>
      </View>
      <Text style={styles.bottomPanelHint}>
        Same length on the timeline. Nudges which part of the source plays.
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable
          style={[styles.slipBtn, headLeft <= 0 && styles.slipBtnDisabled]}
          onPress={() => headLeft > 0 && onSlip(-500)}
        >
          <Text style={styles.slipBtnText}>− 500ms</Text>
        </Pressable>
        <Pressable
          style={[styles.slipBtn, headRight <= 0 && styles.slipBtnDisabled]}
          onPress={() => headRight > 0 && onSlip(500)}
        >
          <Text style={styles.slipBtnText}>+ 500ms</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ============================================================
// Sticker panel — emoji picker that drops a big text overlay
// ============================================================

const STICKER_EMOJI = [
  '🔥', '✨', '⭐', '💥', '💯', '⚡',
  '😎', '😂', '🤯', '🙃', '😅', '😍',
  '👀', '👏', '🙌', '💪', '🤙', '☝️',
  '❤️', '💕', '💛', '🤍', '🖤', '💚',
  '🚀', '🎯', '🏆', '🥇', '📈', '🎬',
];

function StickerPanel({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.bottomPanel}>
      <View style={styles.bottomPanelHead}>
        <Ionicons name="happy-outline" size={16} color={palette.text} />
        <Text style={styles.bottomPanelTitle}>Stickers</Text>
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={18} color={palette.textFaint} />
        </Pressable>
      </View>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 8,
          paddingTop: 6,
        }}
      >
        {STICKER_EMOJI.map((e) => (
          <Pressable
            key={e}
            onPress={() => onPick(e)}
            style={styles.stickerCell}
          >
            <Text style={{ fontSize: 26 }}>{e}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ============================================================
// Teleprompter panel — scrollable script text users can read while shooting
// ============================================================

function TeleprompterPanel({ onClose }: { onClose: () => void }) {
  const [script, setScript] = useState('');
  const [scrollSpeed, setScrollSpeed] = useState(1);
  return (
    <View style={styles.bottomPanel}>
      <View style={styles.bottomPanelHead}>
        <Ionicons name="reader-outline" size={16} color={palette.text} />
        <Text style={styles.bottomPanelTitle}>Teleprompter</Text>
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={18} color={palette.textFaint} />
        </Pressable>
      </View>
      <Text style={styles.bottomPanelHint}>
        Paste a script. While recording in-app, this scrolls over the
        viewfinder at the chosen speed.
      </Text>
      <TextInput
        value={script}
        onChangeText={setScript}
        multiline
        placeholder="Your script here…"
        placeholderTextColor={palette.textFaint}
        style={styles.teleprompterField}
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[0.5, 1, 1.5, 2].map((s) => (
          <Pressable
            key={s}
            onPress={() => setScrollSpeed(s)}
            style={[
              styles.speedChip,
              scrollSpeed === s && styles.speedChipActive,
            ]}
          >
            <Text
              style={[
                styles.speedChipText,
                scrollSpeed === s && styles.speedChipTextActive,
              ]}
            >
              {s}×
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// Smooth pageX-based slider. Avoids the jitter from `nativeEvent.locationX`
// (which switches reference frames as the touch moves over child views).
function SmoothSlider({
  value,
  min,
  max,
  fillColor,
  onChanging,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  fillColor: string;
  onChanging?: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const localRef = useRef(local);
  localRef.current = local;

  const trackRef = useRef<View>(null);
  const trackBox = useRef({ x: 0, w: 0 });
  const measure = useCallback(() => {
    trackRef.current?.measureInWindow((x, _y, w) => {
      trackBox.current = { x, w };
    });
  }, []);

  const fromPageX = (pageX: number): number => {
    const { x, w } = trackBox.current;
    if (w <= 0) return localRef.current;
    const t = clamp((pageX - x) / w, 0, 1);
    return min + t * (max - min);
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        measure();
        const v = fromPageX(e.nativeEvent.pageX);
        setLocal(v);
        onChanging?.(v);
      },
      onPanResponderMove: (e) => {
        const v = fromPageX(e.nativeEvent.pageX);
        setLocal(v);
        onChanging?.(v);
      },
      onPanResponderRelease: () => onCommit(localRef.current),
      onPanResponderTerminate: () => onCommit(localRef.current),
    })
  ).current;

  const frac = clamp((local - min) / (max - min), 0, 1);

  return (
    <View
      ref={trackRef}
      style={styles.sliderTrack}
      {...pan.panHandlers}
      onLayout={measure}
    >
      <View style={styles.sliderBg} />
      <View
        style={[
          styles.sliderFill,
          { width: `${frac * 100}%`, backgroundColor: fillColor },
        ]}
      />
      <View style={[styles.sliderThumb, { left: `${frac * 100}%` }]} />
    </View>
  );
}

function VolumePanel({
  value,
  onChange,
  onClose,
}: {
  value: number;
  onChange: (v: number) => void;
  onClose: () => void;
}) {
  const [display, setDisplay] = useState(value);
  useEffect(() => setDisplay(value), [value]);
  return (
    <View style={styles.bottomPanel}>
      <View style={styles.bottomPanelHead}>
        <Text style={styles.bottomPanelTitle}>Volume</Text>
        <Text style={styles.bottomPanelValue}>
          {Math.round(display * 100)}%
        </Text>
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={20} color={palette.textFaint} />
        </Pressable>
      </View>
      <SmoothSlider
        value={value}
        min={0}
        max={1}
        fillColor={palette.purple}
        onChanging={setDisplay}
        onCommit={(v) => {
          setDisplay(v);
          onChange(v);
        }}
      />
    </View>
  );
}

function SpeedPanel({
  value,
  onChange,
  onClose,
}: {
  value: number;
  onChange: (v: number) => void;
  onClose: () => void;
}) {
  const [display, setDisplay] = useState(value);
  useEffect(() => setDisplay(value), [value]);
  return (
    <View style={styles.bottomPanel}>
      <View style={styles.bottomPanelHead}>
        <Text style={styles.bottomPanelTitle}>Speed</Text>
        <Text style={styles.bottomPanelValue}>{display.toFixed(2)}x</Text>
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={20} color={palette.textFaint} />
        </Pressable>
      </View>
      <SmoothSlider
        value={value}
        min={0.5}
        max={2}
        fillColor={palette.yellow}
        onChanging={(v) => setDisplay(v)}
        onCommit={(v) => {
          setDisplay(v);
          onChange(v);
        }}
      />
      <Text style={styles.bottomPanelHint}>
        Preview-only; not persisted and not yet honored by export.
      </Text>
    </View>
  );
}

// Adjusts the selected overlay's visual size. Text overlays drive `size`
// (font px, 12-72); media overlays drive `scale` (0..1 fraction of preview
// width). Single panel handles both so the action bar stays uncluttered.
function OverlaySizePanel({
  overlay,
  onCommit,
  onClose,
}: {
  overlay: Overlay;
  onCommit: (value: number) => void;
  onClose: () => void;
}) {
  const isMedia = overlay.kind === 'image' || overlay.kind === 'video';
  const min = isMedia ? 0.1 : 12;
  const max = isMedia ? 1 : 72;
  const value = isMedia ? overlay.scale : overlay.size;
  const [display, setDisplay] = useState(value);
  useEffect(() => setDisplay(value), [value]);
  return (
    <View style={styles.bottomPanel}>
      <View style={styles.bottomPanelHead}>
        <Text style={styles.bottomPanelTitle}>
          {isMedia ? 'Scale' : 'Text size'}
        </Text>
        <Text style={styles.bottomPanelValue}>
          {isMedia ? `${Math.round(display * 100)}%` : `${Math.round(display)}px`}
        </Text>
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={20} color={palette.textFaint} />
        </Pressable>
      </View>
      <SmoothSlider
        value={value}
        min={min}
        max={max}
        fillColor={palette.purple}
        onChanging={setDisplay}
        onCommit={(v) => {
          setDisplay(v);
          onCommit(v);
        }}
      />
    </View>
  );
}

// Snap-to-align targets for overlay drag. Normalized 0..1 positions —
// center and rule-of-thirds along each axis. Pinch-scale uses a single
// fit-to-width latch at 1.0 for media overlays (no equivalent for text
// since font size is a unitless preference).
const ALIGN_TARGETS_POS = [0.5, 1 / 3, 2 / 3];
const ALIGN_THRESHOLD_POS = 0.022; // ~2.2% of preview width
const ALIGN_SCALE_TARGETS_MEDIA = [0.5, 1];
const ALIGN_SCALE_THRESHOLD_MEDIA = 0.04;

function snapTo(
  v: number,
  targets: number[],
  threshold: number
): { value: number; idx: number | null } {
  for (let i = 0; i < targets.length; i++) {
    if (Math.abs(v - targets[i]) < threshold) {
      return { value: targets[i], idx: i };
    }
  }
  return { value: v, idx: null };
}

function DraggableOverlay({
  overlay,
  selected,
  onSelect,
  onMove,
  onResize,
  onDelete,
}: {
  overlay: Overlay;
  selected: boolean;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
  // Commit a new visual size. Text overlays drive `size` (font px, 12-72);
  // media overlays drive `scale` (0..1 fraction of preview width).
  onResize: (value: number) => void;
  onDelete: () => void;
}) {
  const isMedia = overlay.kind === 'image' || overlay.kind === 'video';
  const minValue = isMedia ? 0.1 : 12;
  const maxValue = isMedia ? 1 : 72;
  const propValue = isMedia ? overlay.scale : overlay.size;

  const layout = useRef({ w: 0, h: 0 });

  // Live position + size during gestures. Refs let the gesture closures read
  // the latest value without resubscribing the gesture on every render.
  const [pos, setPos] = useState({ x: overlay.x, y: overlay.y });
  const posRef = useRef(pos);
  posRef.current = pos;
  useEffect(() => {
    setPos({ x: overlay.x, y: overlay.y });
  }, [overlay.x, overlay.y]);

  const [value, setValue] = useState(propValue);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    setValue(propValue);
  }, [propValue]);

  // Which align target is currently latched (null = none). Drives the on-
  // canvas guide lines so the user sees exactly what they snapped to.
  const [snapX, setSnapX] = useState<number | null>(null);
  const [snapY, setSnapY] = useState<number | null>(null);
  const [snapScale, setSnapScale] = useState<number | null>(null);

  // Snapshot of pos/value taken at gesture start so each pan/pinch update is
  // applied against a stable origin (not the prior frame).
  const panBase = useRef({ x: overlay.x, y: overlay.y });
  const pinchBase = useRef(propValue);

  // 1-finger drag. minDistance lets short taps reach the close button's
  // Pressable instead of being eaten by the pan.
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(4)
        .onBegin(() => {
          panBase.current = { ...posRef.current };
          onSelect();
        })
        .onUpdate((g) => {
          const { w, h } = layout.current;
          if (w <= 0 || h <= 0) return;
          const rawX = clamp(
            panBase.current.x + g.translationX / w,
            0.02,
            0.98
          );
          const rawY = clamp(
            panBase.current.y + g.translationY / h,
            0.02,
            0.98
          );
          const sx = snapTo(rawX, ALIGN_TARGETS_POS, ALIGN_THRESHOLD_POS);
          const sy = snapTo(rawY, ALIGN_TARGETS_POS, ALIGN_THRESHOLD_POS);
          setPos({ x: sx.value, y: sy.value });
          setSnapX(sx.idx);
          setSnapY(sy.idx);
        })
        .onEnd(() => {
          onMove(posRef.current.x, posRef.current.y);
        })
        .onFinalize(() => {
          setSnapX(null);
          setSnapY(null);
        })
        .runOnJS(true),
    [onMove, onSelect]
  );

  // 2-finger pinch resize. Runs simultaneously with pan so two-finger
  // gestures both scale and reposition the overlay (CapCut-style).
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          pinchBase.current = valueRef.current;
          onSelect();
        })
        .onUpdate((g) => {
          const raw = clamp(
            pinchBase.current * g.scale,
            minValue,
            maxValue
          );
          if (isMedia) {
            const s = snapTo(
              raw,
              ALIGN_SCALE_TARGETS_MEDIA,
              ALIGN_SCALE_THRESHOLD_MEDIA
            );
            setValue(s.value);
            setSnapScale(s.idx);
          } else {
            setValue(raw);
          }
        })
        .onEnd(() => {
          onResize(valueRef.current);
        })
        .onFinalize(() => {
          setSnapScale(null);
        })
        .runOnJS(true),
    [minValue, maxValue, onResize, onSelect, isMedia]
  );

  const composedGesture = useMemo(
    () => Gesture.Simultaneous(panGesture, pinchGesture),
    [panGesture, pinchGesture]
  );

  // Show guides only while a gesture is actively latched to a target. The
  // pinch-scale latch surfaces as a brief flash on the overlay's border
  // (handled inline via `snapScale` styling below).
  const guideX = snapX !== null ? ALIGN_TARGETS_POS[snapX] : null;
  const guideY = snapY !== null ? ALIGN_TARGETS_POS[snapY] : null;

  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={(e) => {
        layout.current = {
          w: e.nativeEvent.layout.width,
          h: e.nativeEvent.layout.height,
        };
      }}
      pointerEvents="box-none"
    >
      {guideX !== null ? (
        <View
          pointerEvents="none"
          style={[styles.alignGuideV, { left: `${guideX * 100}%` }]}
        />
      ) : null}
      {guideY !== null ? (
        <View
          pointerEvents="none"
          style={[styles.alignGuideH, { top: `${guideY * 100}%` }]}
        />
      ) : null}
      <GestureDetector gesture={composedGesture}>
        <View
          style={[
            isMedia ? styles.overlayMediaBox : styles.overlayBox,
            // Media overlays render at a fraction of the preview frame width
            // (`scale`). The transform centers the box on (x, y) so dragging
            // moves the center rather than the top-left corner.
            isMedia && { width: `${Math.max(0.1, value) * 100}%` },
            { left: `${pos.x * 100}%`, top: `${pos.y * 100}%` },
            selected && styles.overlaySelected,
            snapScale !== null && styles.overlayScaleSnapped,
          ]}
        >
          {isMedia && overlay.file_uri ? (
            <OverlayMedia overlay={overlay} />
          ) : (
            <Text
              style={{
                color: overlay.color,
                fontSize: value,
                fontWeight: '900',
                textAlign: 'center',
              }}
            >
              {overlay.text}
            </Text>
          )}
          {selected ? (
            <Pressable
              style={styles.overlayDel}
              onPress={onDelete}
              hitSlop={6}
            >
              <Ionicons name="close" size={12} color="#fff" />
            </Pressable>
          ) : null}
        </View>
      </GestureDetector>
    </View>
  );
}

// Picture-in-picture media for an overlay. Images render via expo-image
// (cached, low-overhead). Videos use a dedicated muted, looping player so
// they don't fight the main timeline player's source/time.
function OverlayMedia({ overlay }: { overlay: Overlay }) {
  if (overlay.kind === 'video' && overlay.file_uri) {
    return (
      <OverlayVideo
        uri={resolveOverlayMediaUri(overlay.file_uri)}
        style={styles.overlayMediaInner}
      />
    );
  }
  return (
    <Image
      source={{ uri: resolveOverlayMediaUri(overlay.file_uri ?? '') }}
      style={styles.overlayMediaInner}
      contentFit="contain"
    />
  );
}

function OverlayVideo({
  uri,
  style,
}: {
  uri: string;
  style: StyleProp<ViewStyle>;
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.muted = true;
    p.loop = true;
    p.play();
  });
  return (
    <VideoView
      player={player}
      style={style}
      nativeControls={false}
      contentFit="contain"
    />
  );
}

// ============================================================
// Styles
// ============================================================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },

  // Header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  titleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  titleText: {
    color: palette.text,
    fontFamily: font.bodyBold,
    fontSize: 12.5,
    fontWeight: '700',
    maxWidth: 160,
  },
  qualityLbl: {
    color: palette.text,
    fontFamily: font.monoBold,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginLeft: 'auto',
  },
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: palette.lime,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: palette.lime,
    shadowColor: palette.lime,
    shadowOpacity: 0.6,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  nextText: {
    color: palette.onBright,
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 12.5,
    letterSpacing: -0.2,
  },

  // Preview
  previewWrap: {
    alignItems: 'center',
    paddingTop: 4,
    paddingBottom: 6,
  },
  previewFrame: {
    width: '60%',
    aspectRatio: 9 / 16,
    maxHeight: 320,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
  },
  previewChevron: {
    position: 'absolute',
    bottom: 6,
    alignSelf: 'center',
    width: 30,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subWrap: {
    position: 'absolute',
    bottom: 26,
    left: 8,
    right: 8,
    alignItems: 'center',
  },
  subText: {
    color: '#fff',
    fontFamily: font.displayHeavy,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.2,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    overflow: 'hidden',
  },

  // Transport
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  playBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: palette.lime,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: palette.lime,
    shadowOpacity: 0.6,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeStack: { flex: 1, alignItems: 'center' },
  timeNow: {
    color: palette.text,
    fontFamily: font.monoBold,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  timeTotal: {
    color: palette.text3,
    fontFamily: font.mono,
    fontSize: 11,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    marginTop: -2,
  },

  // Timeline scroll
  timelineWrap: { position: 'relative', marginTop: 4 },
  timelineScroll: { flexGrow: 0 },

  // Ruler
  ruler: {
    position: 'absolute',
    height: RULER_H,
    top: 0,
    justifyContent: 'flex-end',
  },
  rulerTick: {
    position: 'absolute',
    height: RULER_H,
    width: 1,
    alignItems: 'flex-start',
  },
  rulerLabel: {
    color: palette.text3,
    fontFamily: font.mono,
    fontSize: 9,
    fontWeight: '500',
    letterSpacing: 0.3,
    marginLeft: 4,
  },

  // Tracks
  trackRow: {
    position: 'absolute',
    left: 0,
    right: 0,
  },

  // Subtitle chips (cyan track)
  subChip: {
    position: 'absolute',
    top: 4,
    height: 22,
    borderRadius: 4,
    backgroundColor: `${palette.cyan}1a`,
    borderWidth: 1,
    borderColor: `${palette.cyan}55`,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  subChipText: {
    color: palette.cyan,
    fontFamily: font.bodyBold,
    fontSize: 9.5,
    fontWeight: '700',
  },

  // Overlay chips (magenta track)
  overlayChip: {
    position: 'absolute',
    top: 4,
    height: 22,
    borderRadius: 4,
    backgroundColor: `${palette.magenta}22`,
    borderWidth: 1,
    borderColor: `${palette.magenta}88`,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 6,
  },
  // Media overlays get a gold tint so users can tell them apart from text overlays.
  overlayChipMedia: {
    backgroundColor: `${palette.gold}22`,
    borderColor: `${palette.gold}88`,
  },
  // Subject overlays (cutout person layer) get a distinct cyan tint
  // so the user can spot the AI layer at a glance.
  overlayChipSubject: {
    backgroundColor: `${palette.cyan}22`,
    borderColor: `${palette.cyan}88`,
  },
  overlayChipSelected: {
    borderWidth: 2,
    borderColor: palette.yellow,
  },
  overlayChipText: {
    color: palette.magenta,
    fontFamily: font.bodyBold,
    fontSize: 9.5,
    fontWeight: '800',
  },
  // Trim handles that appear on the selected overlay chip's edges. Slightly
  // overhanging so they're easier to grab on a 22px chip.
  overlayTrim: {
    position: 'absolute',
    top: -3,
    bottom: -3,
    width: 10,
    backgroundColor: palette.yellow,
    borderRadius: 3,
  },
  overlayTrimLeft: { left: -5 },
  overlayTrimRight: { right: -5 },
  overlayAddBtn: {
    position: 'absolute',
    right: 0,
    top: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: palette.purple,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.bg,
  },

  // Clip cells
  cell: {
    position: 'absolute',
    top: 0,
    height: CLIP_H,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: palette.border,
  },
  // Tail "+" cell on the main clip strip — same height as cells,
  // square footprint, lime-tinted to read as "add."
  addClipCell: {
    position: 'absolute',
    top: 0,
    width: CLIP_H,
    height: CLIP_H,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: `${palette.lime}55`,
    backgroundColor: `${palette.lime}14`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellSelected: {
    borderColor: palette.lime,
    borderWidth: 2,
    shadowColor: palette.lime,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  // Lift the cell while it's being long-press-dragged for reorder.
  cellReordering: {
    transform: [{ scale: 1.06 }],
    zIndex: 50,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },

  // Audio chips on the audio track (violet, faux waveform)
  audioChip: {
    position: 'absolute',
    top: 0,
    height: AUDIO_H,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: `${palette.violet}15`,
    borderWidth: 1,
    borderColor: `${palette.violet}55`,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  audioChipSelected: {
    borderColor: palette.lime,
    borderWidth: 2,
  },
  audioChipIcon: { position: 'absolute', top: 3, left: 4 },
  audioBars: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  audioBar: {
    flex: 1,
    marginHorizontal: 0.5,
    backgroundColor: palette.violet,
    opacity: 0.65,
    borderRadius: 0.5,
  },
  cellBadge: {
    position: 'absolute',
    left: 4,
    top: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
  },
  cellBadgeText: {
    color: '#fff',
    fontFamily: font.monoBold,
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  trimHandle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 14,
    backgroundColor: palette.lime,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: palette.lime,
    shadowOpacity: 0.8,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  trimHandleLeft: { left: 0 },
  trimHandleRight: { right: 0 },

  // Playhead — fixed at viewport center, timeline scrolls under it
  playheadCenter: {
    position: 'absolute',
    top: -6,
    width: 1,
    backgroundColor: '#fff',
    zIndex: 10,
  },
  playheadCap: {
    position: 'absolute',
    top: -2,
    left: -4,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#fff',
  },

  // Floating panel layer: sits above the action bar without taking
  // any space in the flex flow, so tool selection never shifts the
  // action bar's screen position. `bottom` is set inline from a
  // measured action-bar height (onLayout) so it pins exactly.
  panelLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
  },

  // Bottom action bar
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 8,
    paddingBottom: 30,
    backgroundColor: palette.bg0,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
    marginTop: 'auto',
  },
  actionScrollContent: {
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  actionBtn: {
    minWidth: 54,
    paddingHorizontal: 4,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  actionLbl: {
    fontFamily: font.bodyBold,
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.2,
    marginTop: 2,
  },

  // Bottom inline panels
  bottomPanel: {
    backgroundColor: palette.bg1,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.sm,
  },
  bottomPanelHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bottomPanelTitle: {
    color: palette.text,
    fontFamily: font.displayHeavy,
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
    letterSpacing: -0.2,
  },
  bottomPanelValue: {
    color: palette.text2,
    fontFamily: font.monoBold,
    fontSize: 12,
    fontWeight: '700',
  },
  bottomPanelHint: {
    color: palette.text3,
    fontFamily: font.body,
    fontSize: 11,
  },
  speedRow: { flexDirection: 'row', gap: 8 },
  speedChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  speedChipActive: {
    backgroundColor: `${palette.lime}22`,
    borderColor: palette.lime,
  },
  speedChipText: {
    color: palette.text2,
    fontFamily: font.bodyBold,
    fontSize: 12,
    fontWeight: '700',
  },
  speedChipTextActive: { color: palette.lime },

  // Sliders
  sliderTrack: { height: 28, justifyContent: 'center' },
  sliderBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    height: 5,
    borderRadius: 3,
  },
  sliderThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    backgroundColor: palette.text,
  },

  // Preview overlay (draggable text inside the preview)
  overlayBox: {
    position: 'absolute',
    transform: [{ translateX: -60 }, { translateY: -16 }],
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  // Media overlay container — `width` is set per-overlay from `scale`.
  // aspectRatio holds a usable preview frame; inner Image/Video uses
  // contentFit='contain' so the media never stretches.
  overlayMediaBox: {
    position: 'absolute',
    aspectRatio: 9 / 16,
    // Center the box on the (x, y) anchor point so dragging tracks the
    // center of the media, not its top-left. RN ≥ 0.74 supports
    // percentage-based transforms.
    transform: [{ translateX: '-50%' }, { translateY: '-50%' }],
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  overlayMediaInner: { width: '100%', height: '100%' },
  overlaySelected: {
    borderWidth: 2,
    borderColor: palette.yellow,
  },
  // Snap-alignment guides drawn inside the preview frame while a drag is
  // latched to a center/thirds target. Yellow at full opacity reads clearly
  // against both video and dark backgrounds.
  alignGuideV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    marginLeft: -0.5,
    backgroundColor: palette.yellow,
    opacity: 0.85,
  },
  alignGuideH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    marginTop: -0.5,
    backgroundColor: palette.yellow,
    opacity: 0.85,
  },
  // Brief border flash while pinch latches to a scale target (e.g. 50%, 100%).
  overlayScaleSnapped: {
    borderWidth: 2,
    borderColor: palette.yellow,
  },
  overlayDel: {
    position: 'absolute',
    top: -10,
    right: -10,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },

  // Modal
  modalScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  modalCard: {
    width: '100%',
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.border,
    padding: space.lg,
    gap: space.md,
  },
  modalTitle: {
    color: palette.text,
    fontFamily: font.displayHeavy,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  modalInput: {
    backgroundColor: palette.bg,
    color: palette.text,
    fontSize: 16,
    fontWeight: '600',
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
  },
  modalHint: { color: palette.textFaint, fontSize: 12 },
  modalBtnRow: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
  modalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  modalBtnGhost: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  modalBtnGhostText: {
    color: palette.text,
    fontFamily: font.displayHeavy,
    fontWeight: '700',
  },
  modalBtnPrimary: {
    backgroundColor: palette.lime,
    borderWidth: 1,
    borderColor: palette.lime,
  },
  modalBtnPrimaryText: {
    color: palette.onBright,
    fontFamily: font.displayHeavy,
    fontWeight: '800',
  },

  // Caption toggle pill (CaptionsPanel)
  captionToggle: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  captionToggleOn: {
    backgroundColor: `${palette.lime}22`,
    borderColor: palette.lime,
  },
  captionToggleText: {
    fontFamily: font.monoBold,
    fontSize: 10,
    color: palette.text2,
    letterSpacing: 1,
  },
  captionToggleTextOn: { color: palette.lime },

  // Caption style chip
  styleChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  styleChipActive: {
    backgroundColor: `${palette.lime}22`,
    borderColor: palette.lime,
  },
  styleChipText: {
    fontFamily: font.bodyBold,
    fontSize: 12,
    color: palette.text2,
  },
  styleChipTextActive: { color: palette.lime },

  // Slip nudge buttons
  slipBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
  },
  slipBtnDisabled: { opacity: 0.4 },
  slipBtnText: {
    fontFamily: font.bodyBold,
    fontSize: 13,
    color: '#fff',
  },

  // Sticker cell
  stickerCell: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Teleprompter input
  teleprompterField: {
    minHeight: 90,
    padding: 10,
    borderRadius: 10,
    backgroundColor: palette.bg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    color: '#fff',
    fontFamily: font.body,
    fontSize: 14,
    textAlignVertical: 'top',
  },
});
