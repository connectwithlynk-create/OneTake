import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
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

import { ClipVideo } from '@/components/clip-video';
import { Loading } from '@/components/ui';
import {
  persistOverlayMedia,
  resolveClipUri,
  resolveOverlayMediaUri,
} from '@/lib/filestore';
import { id as newId } from '@/lib/id';
import {
  addOverlay,
  deleteClip,
  deleteOverlay,
  getProject,
  listClips,
  listOverlays,
  setClipAudioDetached,
  setClipExcluded,
  setClipMirrored,
  setClipTrim,
  setClipVolume,
  splitClipAt,
  updateOverlay,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { maybeTranscribe } from '@/lib/transcribe';
import { font, palette, radius, space } from '@/theme';
import type { Clip, Overlay, WordTiming } from '@/lib/types';

// === Timeline geometry =====================================================
// 60 px per second feels close to CapCut's default density.
const DEFAULT_PX_PER_MS = 0.06;
const MIN_PX_PER_MS = 0.015; // ~15 px/s — very zoomed out
const MAX_PX_PER_MS = 0.3; // ~300 px/s — very zoomed in
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
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const router = useRouter();

  const { data: project } = useData(() => getProject(projectId), [projectId]);
  const { data: clipsDb } = useData(() => listClips(projectId), [projectId]);
  const { data: overlaysDb } = useData(
    () => listOverlays(projectId),
    [projectId]
  );

  const [clips, setClips] = useState<Clip[]>([]);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  useEffect(() => {
    if (clipsDb) setClips(clipsDb);
  }, [clipsDb]);
  useEffect(() => {
    if (overlaysDb) setOverlays(overlaysDb);
  }, [overlaysDb]);

  // Excluded clips are no longer removed from the playable timeline — the
  // "hide" toggle now just dims them visually (in the timeline cell and in
  // the live preview). They still occupy their slot, still play through.
  const included = clips;
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

  // ----- player engine: double-buffered ------------------------------
  // Two players, swap-on-boundary. While the active plays, the buffer
  // pre-loads the next clip and sits paused at its effIn. At a clip
  // boundary we flip which one is rendered, so the user never sees a
  // black-flash or replay() stall. This is what real video editors do.
  const playerA = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.1;
  });
  const playerB = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.1;
  });
  const [activeAB, setActiveAB] = useState<'A' | 'B'>('A');
  const activeABRef = useRef<'A' | 'B'>('A');
  activeABRef.current = activeAB;
  const active = useCallback(
    () => (activeABRef.current === 'A' ? playerA : playerB),
    [playerA, playerB]
  );
  const buffer = useCallback(
    () => (activeABRef.current === 'A' ? playerB : playerA),
    [playerA, playerB]
  );
  // Per-player state. Each player tracks its own loaded source + pending
  // load action so the listeners and load helpers stay symmetric.
  type LoadIntent = { seekMs: number; autoplay: boolean };
  const pendingLoadA = useRef<LoadIntent | null>(null);
  const pendingLoadB = useRef<LoadIntent | null>(null);
  const sourceA = useRef<string | null>(null);
  const sourceB = useRef<string | null>(null);
  const pendingTimerA = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTimerB = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLoadFor = (p: ReturnType<typeof useVideoPlayer>) =>
    p === playerA ? pendingLoadA : pendingLoadB;
  const sourceRefFor = (p: ReturnType<typeof useVideoPlayer>) =>
    p === playerA ? sourceA : sourceB;
  const pendingTimerFor = (p: ReturnType<typeof useVideoPlayer>) =>
    p === playerA ? pendingTimerA : pendingTimerB;
  const clearPendingTimer = (p: ReturnType<typeof useVideoPlayer>) => {
    const t = pendingTimerFor(p);
    if (t.current) {
      clearTimeout(t.current);
      t.current = null;
    }
  };
  // Which clip index is currently sitting prepared in the buffer player.
  // Lets advanceClip do an instant swap when this matches the next clip,
  // and skip pre-loading work when it's already right.
  const bufferIdxRef = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [globalMs, setGlobalMs] = useState(0);
  const globalMsRef = useRef(0);
  globalMsRef.current = globalMs;
  const activeIdx = useRef<number>(0);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1);
  speedRef.current = speed;
  // Tracks the user's *intent* to play, independent of the player's actual
  // playing state. The player can flip to !playing on its own (natural EOF
  // when a clip's effOut == file duration; replace() while a new asset
  // loads). Reading player.playing at those moments would auto-pause the
  // next clip in the timeline, so the boundary handler reads this ref
  // instead.
  const wantPlayingRef = useRef(false);

  // ----- zoom + viewport (centered playhead model) -----
  const [pxPerMs, setPxPerMs] = useState(DEFAULT_PX_PER_MS);
  const pxPerMsRef = useRef(pxPerMs);
  pxPerMsRef.current = pxPerMs;
  const [viewportW, setViewportW] = useState(0);
  const viewportWRef = useRef(0);
  viewportWRef.current = viewportW;

  // statusChange handler factory: applies the queued seek + (optional)
  // autoplay once the new asset is ready. Created per-player so each can
  // run its own pendingLoad slot without interference.
  useEffect(() => {
    const make = (p: ReturnType<typeof useVideoPlayer>) =>
      p.addListener('statusChange', (ev: { status?: string }) => {
        if (ev?.status !== 'readyToPlay') return;
        const pl = pendingLoadFor(p).current;
        if (!pl) return;
        pendingLoadFor(p).current = null;
        clearPendingTimer(p);
        try {
          p.currentTime = pl.seekMs / 1000;
          if (pl.autoplay) p.play();
        } catch {
          /* ignore */
        }
      });
    const subA = make(playerA);
    const subB = make(playerB);
    return () => {
      subA.remove();
      subB.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerA, playerB]);

  // Load a clip into a specific player at a given local seek (or its
  // effIn) and either auto-play or pause. Symmetric for active loads
  // and buffer pre-loads.
  const loadInto = useCallback(
    (
      p: ReturnType<typeof useVideoPlayer>,
      c: Clip,
      autoplay: boolean,
      seekMs?: number
    ) => {
      const newSrc = resolveClipUri(c.file_uri);
      const seek = seekMs ?? effIn(c);
      const srcRef = sourceRefFor(p);
      const sameSrc = srcRef.current === newSrc;
      const plRef = pendingLoadFor(p);
      try {
        clearPendingTimer(p);
        if (sameSrc) {
          // Same source — replace() is a no-op and statusChange won't
          // fire. Skip pendingLoad so fallbacks aren't suppressed.
          plRef.current = null;
        } else {
          plRef.current = { seekMs: seek, autoplay };
          p.replace(newSrc);
          srcRef.current = newSrc;
          // Watchdog in case statusChange doesn't report readyToPlay
          // (cached asset, error, etc.). Free up the slot after 1.5s so
          // the safety paths can recover.
          pendingTimerFor(p).current = setTimeout(() => {
            plRef.current = null;
            pendingTimerFor(p).current = null;
          }, 1500);
        }
        p.volume = c.audio_volume ?? 1;
        p.playbackRate = speedRef.current;
        try {
          p.currentTime = seek / 1000;
        } catch {
          /* not ready */
        }
        if (autoplay) {
          // Delay play() so the seek lands. Calling play() in the same
          // tick as the seek can silently no-op when the player was at
          // EOF. Keep an immediate attempt too for the non-EOF path.
          setTimeout(() => {
            if (!wantPlayingRef.current) return;
            try {
              p.play();
            } catch {
              /* */
            }
          }, 60);
          try {
            p.play();
          } catch {
            /* */
          }
        } else {
          try {
            p.pause();
          } catch {
            /* */
          }
        }
      } catch {
        /* player not ready */
      }
    },
    // pendingLoadFor/sourceRefFor/pendingTimerFor/clearPendingTimer are
    // stable closures over refs; safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Load a clip into the *active* player. Used by tap-to-select, entry,
  // and the engine's slow-path fallback.
  const loadActive = useCallback(
    (idx: number, autoplay: boolean) => {
      const c = included[idx];
      if (!c) return;
      activeIdx.current = idx;
      loadInto(active(), c, autoplay);
    },
    [included, loadInto, active]
  );

  // Pre-load a clip into the *buffer* player (paused at effIn). Skips
  // work when the buffer is already pointed at this index. Updates
  // bufferIdxRef so advanceClip can do an instant swap.
  const preloadBuffer = useCallback(
    (idx: number) => {
      const c = included[idx];
      if (!c) {
        bufferIdxRef.current = null;
        return;
      }
      if (bufferIdxRef.current === idx) return;
      bufferIdxRef.current = idx;
      loadInto(buffer(), c, false);
    },
    [included, loadInto, buffer]
  );

  // Tap a timeline cell -> switch the active source + re-prep buffer
  // with the new next-next.
  useEffect(() => {
    if (!selectedId) return;
    const idx = included.findIndex((c) => c.id === selectedId);
    if (idx >= 0 && idx !== activeIdx.current) {
      loadActive(idx, false);
      setGlobalMs(cumulative[idx]);
      preloadBuffer(idx + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Load the first clip's source on entry so the preview isn't blank, and
  // immediately start pre-loading clip 1 into the buffer so the first
  // boundary transition is seamless.
  const sourceLoaded = useRef(false);
  useEffect(() => {
    if (sourceLoaded.current) return;
    if (included.length === 0) return;
    sourceLoaded.current = true;
    loadActive(0, false);
    preloadBuffer(1);
  }, [included, loadActive, preloadBuffer]);

  // Whenever the clip list mutates (split, delete, reorder, trim) the
  // pre-loaded buffer may now point at the wrong index. Re-prep it.
  useEffect(() => {
    if (included.length === 0) return;
    preloadBuffer(activeIdx.current + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [included]);

  // Find which included clip a global ms maps into, returning [idx, localMs].
  const idxAt = useCallback(
    (ms: number): { idx: number; localMs: number } => {
      const target = clamp(ms, 0, totalMs);
      if (included.length === 0) return { idx: 0, localMs: 0 };
      let idx = included.length - 1;
      for (let i = 0; i < included.length; i++) {
        if (target < cumulative[i + 1]) {
          idx = i;
          break;
        }
      }
      const c = included[idx];
      const localMs = effIn(c) + (target - cumulative[idx]);
      return { idx, localMs };
    },
    [included, cumulative, totalMs]
  );

  // Deferred clip swap: while scrubbing we never call `player.replace()` (that
  // re-loads the asset and causes the freeze the user saw). Instead we record
  // the clip index the scrub last landed on and commit the swap once the
  // scroll settles.
  const pendingSwap = useRef<number | null>(null);

  // Seek the active player to a global timeline ms. With `deferSwap`,
  // cross-clip scrubs only freeze the current frame and record the
  // pending clip; the actual swap happens on scroll settle.
  const seekToGlobalMs = useCallback(
    (ms: number, deferSwap = false) => {
      if (included.length === 0) return;
      const target = clamp(ms, 0, totalMs);
      const { idx, localMs } = idxAt(target);
      const c = included[idx];
      if (!c) return;
      setGlobalMs(target);

      if (idx === activeIdx.current) {
        pendingSwap.current = null;
        try {
          active().currentTime = localMs / 1000;
        } catch {
          /* not ready */
        }
        return;
      }

      if (deferSwap) {
        pendingSwap.current = idx;
        // Freeze the current player on the nearest frame so the preview
        // doesn't black-flash mid-scrub.
        const cur = included[activeIdx.current];
        if (cur) {
          const freeze =
            idx > activeIdx.current
              ? Math.max(effIn(cur), effOut(cur) - 30)
              : effIn(cur);
          try {
            active().currentTime = freeze / 1000;
          } catch {
            /* not ready */
          }
        }
        return;
      }

      // Immediate swap (e.g. tap on a clip). Loads on active; buffer is
      // re-prepped below by the post-effect.
      activeIdx.current = idx;
      pendingSwap.current = null;
      loadInto(active(), c, false, localMs);
      preloadBuffer(idx + 1);
    },
    [included, totalMs, idxAt, active, loadInto, preloadBuffer]
  );

  // Commit a pending cross-clip swap that was deferred during scrubbing.
  const commitPendingSwap = useCallback(() => {
    const idx = pendingSwap.current;
    if (idx === null) return;
    pendingSwap.current = null;
    const c = included[idx];
    if (!c) return;
    const { localMs } = idxAt(globalMsRef.current);
    activeIdx.current = idx;
    loadInto(active(), c, false, localMs);
    preloadBuffer(idx + 1);
  }, [included, idxAt, active, loadInto, preloadBuffer]);

  // Advance to the next clip — by swapping to the buffer if it's ready
  // (seamless, no replace() flash), otherwise by loading on the active
  // (one-shot fallback for tiny clips where pre-load didn't finish in
  // time).
  const advanceClip = useCallback(() => {
    const idx = activeIdx.current;
    const nextIdx = idx + 1;
    if (nextIdx >= included.length) {
      wantPlayingRef.current = false;
      try {
        active().pause();
      } catch {
        /* ignore */
      }
      setGlobalMs(totalMs);
      return;
    }
    const nextClip = included[nextIdx];
    const wantPlay = wantPlayingRef.current;

    // Fast path: buffer is already pre-loaded with nextIdx. Swap
    // visibility, play the new active, pause the old active, then
    // pre-prep the buffer (now the OLD active) with nextIdx + 1.
    if (bufferIdxRef.current === nextIdx) {
      const oldActive = active();
      const newActive = buffer();
      // Mirror current per-clip params just in case (volume/rate may
      // have changed since the buffer was prepped).
      try {
        newActive.volume = nextClip.audio_volume ?? 1;
      } catch {
        /* */
      }
      try {
        newActive.playbackRate = speedRef.current;
      } catch {
        /* */
      }
      try {
        newActive.currentTime = effIn(nextClip) / 1000;
      } catch {
        /* */
      }
      // Flip role atomically. setActiveAB re-renders; activeABRef gives
      // the rest of the engine immediate read-after-write semantics.
      activeABRef.current = activeABRef.current === 'A' ? 'B' : 'A';
      setActiveAB((cur) => (cur === 'A' ? 'B' : 'A'));
      activeIdx.current = nextIdx;
      bufferIdxRef.current = null;
      try {
        oldActive.pause();
      } catch {
        /* */
      }
      if (wantPlay) {
        try {
          newActive.play();
        } catch {
          /* */
        }
      }
      setGlobalMs(cumulative[nextIdx]);
      // Schedule the next-next pre-load on the (newly) buffer player.
      preloadBuffer(nextIdx + 1);
      return;
    }

    // Slow path: buffer wasn't ready. Fall back to the previous
    // single-player load on active. Still try to pre-prep buffer for
    // nextIdx + 1.
    loadInto(active(), nextClip, wantPlay);
    activeIdx.current = nextIdx;
    setGlobalMs(cumulative[nextIdx]);
    preloadBuffer(nextIdx + 1);
  }, [
    included,
    cumulative,
    totalMs,
    active,
    buffer,
    loadInto,
    preloadBuffer,
  ]);

  // Fallback: when the *active* player reports playToEnd, treat it as a
  // boundary even if our 100ms poll missed the threshold. Listen on both
  // so we don't lose the event on swap; gate by which one is active.
  useEffect(() => {
    const makeEnd = (
      p: ReturnType<typeof useVideoPlayer>,
      role: 'A' | 'B'
    ) =>
      p.addListener('playToEnd', () => {
        if (activeABRef.current !== role) return;
        if (userScrolling.current) return;
        if (pendingLoadFor(p).current) return;
        advanceClip();
      });
    const subA = makeEnd(playerA, 'A');
    const subB = makeEnd(playerB, 'B');
    return () => {
      subA.remove();
      subB.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerA, playerB, advanceClip]);

  // Fast recovery: when the active player flips from playing → paused but
  // the user still wants to play, nudge it back.
  useEffect(() => {
    const makePc = (
      p: ReturnType<typeof useVideoPlayer>,
      role: 'A' | 'B'
    ) =>
      p.addListener('playingChange', (ev: { isPlaying?: boolean }) => {
        if (activeABRef.current !== role) return;
        if (ev?.isPlaying) return;
        if (!wantPlayingRef.current) return;
        if (userScrolling.current) return;
        setTimeout(() => {
          if (!wantPlayingRef.current) return;
          if (activeABRef.current !== role) return;
          if (p.playing) return;
          try {
            p.play();
          } catch {
            /* ignore */
          }
        }, 30);
      });
    const subA = makePc(playerA, 'A');
    const subB = makePc(playerB, 'B');
    return () => {
      subA.remove();
      subB.remove();
    };
  }, [playerA, playerB]);

  // Engine loop: poll the *active* player's time, advance at clip bounds.
  useEffect(() => {
    if (included.length === 0) return;
    if (activeIdx.current >= included.length) loadActive(0, false);
    const t = setInterval(() => {
      try {
        const p = active();
        setPlaying(p.playing);
        if (userScrolling.current) return;
        const idx = activeIdx.current;
        const c = included[idx];
        if (!c) return;
        const tMs = (p.currentTime ?? 0) * 1000;
        const outMs = effOut(c);
        const inMs = effIn(c);
        // 250ms threshold > 100ms poll interval, so the boundary fires
        // BEFORE the player auto-pauses at the file's natural end. The
        // buffer should already be pre-loaded with the next clip, so
        // advanceClip can swap visibility instantly.
        if (tMs >= outMs - 250) {
          advanceClip();
          return;
        }
        const local = Math.max(0, tMs - inMs);
        setGlobalMs(cumulative[idx] + local);
        // Safety: user wants to play but the active has stalled. play()
        // is idempotent on a playing/loading player, so don't gate on
        // pendingLoad.
        if (wantPlayingRef.current && !p.playing) {
          try {
            p.play();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }, 100);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [included, cumulative, totalMs, advanceClip]);

  function togglePlay() {
    try {
      const p = active();
      if (p.playing) {
        wantPlayingRef.current = false;
        p.pause();
      } else if (activeIdx.current >= included.length) {
        wantPlayingRef.current = true;
        loadActive(0, true);
      } else {
        wantPlayingRef.current = true;
        p.play();
      }
    } catch {
      /* ignore */
    }
  }

  // ----- bottom-bar modes (Volume / Speed open inline panels) -----
  const [bottomMode, setBottomMode] = useState<
    'none' | 'volume' | 'speed' | 'size'
  >('none');

  async function doSplit() {
    if (!selected) return;
    const idx = included.findIndex((c) => c.id === selected.id);
    if (idx < 0) return;
    const atLocal = Math.max(0, globalMs - cumulative[idx]); // ms within the effective selected clip
    const res = await splitClipAt(selected.id, atLocal);
    if (res) {
      // Split has no inverse (no merge primitive) — wipe history so the user
      // doesn't get a partial-undo into an inconsistent state.
      clearHistory();
      invalidate();
    }
  }

  async function doDelete() {
    if (!selected) return;
    // Delete removes the underlying file too — irreversible. Wipe history.
    clearHistory();
    await deleteClip(selected.id, selected.file_uri);
    clearSelection();
    invalidate();
  }

  // Unified delete for whatever's selected (clip, text overlay, or media
  // overlay). Overlay deletes are undoable; clip deletes wipe history because
  // we don't have an inverse for the file removal.
  async function doDeleteSelection() {
    if (selectedOverlay) {
      await removeOverlay(selectedOverlay);
      clearSelection();
      return;
    }
    if (selected) {
      await doDelete();
    }
  }

  async function toggleExclude() {
    if (!selected) return;
    const clipId = selected.id;
    const prev = selected.excluded === 1 ? 1 : 0;
    const next: 0 | 1 = prev === 1 ? 0 : 1;
    await runCmd({
      do: async () => {
        await setClipExcluded(clipId, next);
        invalidate();
      },
      undo: async () => {
        await setClipExcluded(clipId, prev);
        invalidate();
      },
    });
  }

  async function toggleMirror() {
    if (!selected) return;
    const clipId = selected.id;
    const prev: 0 | 1 = selected.mirrored === 1 ? 1 : 0;
    const next: 0 | 1 = prev === 1 ? 0 : 1;
    await runCmd({
      do: async () => {
        await setClipMirrored(clipId, next);
        invalidate();
      },
      undo: async () => {
        await setClipMirrored(clipId, prev);
        invalidate();
      },
    });
  }

  async function toggleAudioDetached() {
    if (!selected) return;
    const clipId = selected.id;
    const prev = (selected.audio_detached ?? 0) === 1 ? 1 : 0;
    const next: 0 | 1 = prev === 1 ? 0 : 1;
    await runCmd({
      do: async () => {
        await setClipAudioDetached(clipId, next);
        invalidate();
      },
      undo: async () => {
        await setClipAudioDetached(clipId, prev as 0 | 1);
        invalidate();
      },
    });
  }

  async function toggleMute() {
    if (!selected) return;
    const clipId = selected.id;
    const prev = selected.audio_volume ?? 1;
    const next = prev > 0 ? 0 : 1;
    const applyTo = (val: number) => {
      try {
        if (included[activeIdx.current]?.id === clipId) active().volume = val;
      } catch {
        /* ignore */
      }
    };
    await runCmd({
      do: async () => {
        await setClipVolume(clipId, next);
        applyTo(next);
        invalidate();
      },
      undo: async () => {
        await setClipVolume(clipId, prev);
        applyTo(prev);
        invalidate();
      },
    });
  }

  function doSpeed(s: number) {
    setSpeed(s);
    try {
      active().playbackRate = s;
    } catch {
      /* ignore */
    }
    // Keep the buffer in sync so it doesn't jump speeds on swap.
    try {
      buffer().playbackRate = s;
    } catch {
      /* ignore */
    }
  }

  async function changeVolume(v: number) {
    if (!selected) return;
    const clipId = selected.id;
    const prev = selected.audio_volume ?? 1;
    const applyTo = (val: number) => {
      try {
        if (included[activeIdx.current]?.id === clipId) active().volume = val;
      } catch {
        /* ignore */
      }
    };
    await runCmd({
      do: async () => {
        await setClipVolume(clipId, v);
        applyTo(v);
        invalidate();
      },
      undo: async () => {
        await setClipVolume(clipId, prev);
        applyTo(prev);
        invalidate();
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
    const clipId = selected.id;
    const prevIn = selected.in_ms ?? 0;
    const prevOut = selected.out_ms ?? selected.duration_ms;
    const newIn = Math.round(inMs);
    const newOut = Math.round(outMs);
    await runCmd({
      do: async () => {
        // Optimistic local update so the cell doesn't briefly snap back to
        // its old size between trimDrag clearing and clipsDb refetching.
        setClips((prev) =>
          prev.map((c) =>
            c.id === clipId ? { ...c, in_ms: newIn, out_ms: newOut } : c
          )
        );
        await setClipTrim(clipId, newIn, newOut);
        invalidate();
      },
      undo: async () => {
        setClips((prev) =>
          prev.map((c) =>
            c.id === clipId ? { ...c, in_ms: prevIn, out_ms: prevOut } : c
          )
        );
        await setClipTrim(clipId, prevIn, prevOut);
        invalidate();
      },
    });
  }

  // ----- text overlays -----
  const [overlayModal, setOverlayModal] = useState(false);
  const [overlayDraft, setOverlayDraft] = useState('');
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
  const [subsOn, setSubsOn] = useState(true);
  const activeWords: WordTiming[] = useMemo(() => {
    const c = included[activeIdx.current];
    if (!c?.transcript_words) return [];
    try {
      const arr = JSON.parse(c.transcript_words) as WordTiming[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [included, globalMs]);
  const subtitleNow = useMemo(() => {
    if (!subsOn || activeWords.length === 0) return '';
    const localSec = active().currentTime ?? 0;
    let i = activeWords.findIndex((w) => localSec >= w.s && localSec <= w.e);
    if (i < 0) {
      for (let j = activeWords.length - 1; j >= 0; j--) {
        if (localSec >= activeWords[j].s) {
          i = j;
          break;
        }
      }
    }
    if (i < 0) return '';
    const a = Math.max(0, i - 2);
    const b = Math.min(activeWords.length, i + 3);
    return activeWords
      .slice(a, b)
      .map((w) => w.w)
      .join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWords, subsOn, globalMs]);

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
  const timelineW = useMemo(
    () => Math.max(800, totalMs * pxPerMs + 200),
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
  const onTimelineScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!userScrolling.current) return;
      const x = e.nativeEvent.contentOffset.x;
      const ms = x / pxPerMsRef.current;
      seekToGlobalMs(ms, true);
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
    commitPendingSwap();
  }, [commitPendingSwap]);

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

  if (!project || !clipsDb) {
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
          {/* Double-buffered: both VideoViews mounted, only the active
              one is opaque. At a clip boundary we flip activeAB and the
              other view becomes visible in a single frame — no replace
              flash, no seek stutter. */}
          <VideoView
            player={playerA}
            style={[
              StyleSheet.absoluteFill,
              {
                opacity: activeAB === 'A' ? (activeDim ? 0.4 : 1) : 0,
                transform: activeMirrored ? [{ scaleX: -1 }] : [],
                zIndex: activeAB === 'A' ? 1 : 0,
              },
            ]}
            nativeControls={false}
            contentFit="contain"
          />
          <VideoView
            player={playerB}
            style={[
              StyleSheet.absoluteFill,
              {
                opacity: activeAB === 'B' ? (activeDim ? 0.4 : 1) : 0,
                transform: activeMirrored ? [{ scaleX: -1 }] : [],
                zIndex: activeAB === 'B' ? 1 : 0,
              },
            ]}
            nativeControls={false}
            contentFit="contain"
          />
          {overlays
            .filter((o) => globalMs >= o.start_ms && globalMs < o.end_ms)
            .map((o) => (
              <DraggableOverlay
                key={o.id}
                overlay={o}
                selected={o.id === selectedOverlayId}
                onSelect={() => selectOverlay(o.id)}
                onMove={(x, y) => moveOverlay(o, x, y)}
                onResize={(v) => persistOverlaySize(o, v)}
                onDelete={() => removeOverlay(o)}
              />
            ))}
          {subtitleNow ? (
            <View style={styles.subWrap} pointerEvents="none">
              <Text style={styles.subText}>{subtitleNow}</Text>
            </View>
          ) : null}
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
          onPress={() => setSubsOn((v) => !v)}
          hitSlop={6}
        >
          <Ionicons
            name="sparkles"
            size={18}
            color={subsOn ? palette.yellow : palette.textDim}
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
              if (scrubEndTimer.current) {
                clearTimeout(scrubEndTimer.current);
                scrubEndTimer.current = null;
              }
              try {
                wantPlayingRef.current = false;
                active().pause();
              } catch {
                /* ignore */
              }
            }}
            onScrollEndDrag={() => {
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
                  // Strict proportional width: short clips look short, long
                  // ones look long. Tiny floor only so a 0-len clip is still
                  // tappable.
                  const baseW = Math.max(4, effLen(c) * pxPerMs);
                  // Live-trim reflow: the trimmed clip gets dxIn/dxOut
                  // applied; clips AFTER it shift by dxOut so they stay
                  // glued to the moving right edge during an OUT drag (the
                  // IN edge in the current visual keeps the right edge
                  // anchored, so no shift is needed for IN).
                  let dispLeft = baseLeft;
                  let dispW = baseW;
                  if (trimDrag) {
                    const trimIdx = included.findIndex(
                      (x) => x.id === trimDrag.id
                    );
                    if (idx === trimIdx) {
                      dispLeft = baseLeft + trimDrag.dxIn;
                      dispW = Math.max(
                        48,
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
                      onSelect={() => selectClip(c.id)}
                      onTrimChange={(dxIn, dxOut) =>
                        setTrimDrag({ id: c.id, dxIn, dxOut })
                      }
                      onTrimEnd={() => setTrimDrag(null)}
                      onTrimRelease={(newIn, newOut) =>
                        persistTrim(newIn, newOut)
                      }
                    />
                  );
                })}
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
                  const baseW = Math.max(4, effLen(c) * pxPerMs);
                  let dispLeft = baseLeft;
                  let dispW = baseW;
                  if (trimDrag) {
                    const trimIdx = included.findIndex(
                      (x) => x.id === trimDrag.id
                    );
                    if (idx === trimIdx) {
                      dispLeft = baseLeft + trimDrag.dxIn;
                      dispW = Math.max(
                        48,
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

      {/* ===== Optional inline panel (Volume / Speed) ================ */}
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

      {/* ===== Bottom action bar (horizontally scrollable) =========== */}
      <View style={styles.actionBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.actionScrollContent}
        >
          <ActionBtn
            icon="cut-outline"
            label="Split"
            onPress={doSplit}
            disabled={!selected}
          />
          <ActionBtn
            icon="text-outline"
            label="Text"
            onPress={() => setOverlayModal(true)}
          />
          <ActionBtn
            icon="images-outline"
            label="Media"
            onPress={addMediaOverlay}
          />
          <ActionBtn
            icon="chatbubble-ellipses-outline"
            label="Captions"
            onPress={() => {
              setSubsOn((v) => !v);
              // Re-attempt transcription for any clip that still has no
              // word timings. Without this, captions stay empty whenever
              // server transcription failed silently at import.
              for (const c of clips) {
                if (!c.transcript_words) void maybeTranscribe(c.id);
              }
            }}
            active={subsOn}
          />
          <ActionBtn
            icon="volume-medium-outline"
            label="Volume"
            onPress={() =>
              setBottomMode((m) => (m === 'volume' ? 'none' : 'volume'))
            }
            active={bottomMode === 'volume'}
            disabled={!selected}
          />
          <ActionBtn
            icon="speedometer-outline"
            label="Speed"
            onPress={() =>
              setBottomMode((m) => (m === 'speed' ? 'none' : 'speed'))
            }
            active={bottomMode === 'speed'}
          />
          <ActionBtn
            icon="resize-outline"
            label="Size"
            onPress={() =>
              setBottomMode((m) => (m === 'size' ? 'none' : 'size'))
            }
            active={bottomMode === 'size'}
            disabled={!selectedOverlay}
          />
          <ActionBtn
            icon="swap-horizontal-outline"
            label="Mirror"
            onPress={toggleMirror}
            active={!!selected && selected.mirrored === 1}
            disabled={!selected}
          />
          <ActionBtn
            icon={
              selected && (selected.audio_volume ?? 1) === 0
                ? 'volume-mute-outline'
                : 'volume-high-outline'
            }
            label={
              selected && (selected.audio_volume ?? 1) === 0 ? 'Muted' : 'Mute'
            }
            onPress={toggleMute}
            active={!!selected && (selected.audio_volume ?? 1) === 0}
            disabled={!selected}
          />
          <ActionBtn
            icon="musical-notes-outline"
            label={
              selected && (selected.audio_detached ?? 0) === 1
                ? 'Attach'
                : 'Detach'
            }
            onPress={toggleAudioDetached}
            active={!!selected && (selected.audio_detached ?? 0) === 1}
            disabled={!selected}
          />
          <ActionBtn
            icon={
              selected && selected.excluded === 1
                ? 'eye-off-outline'
                : 'eye-outline'
            }
            label={selected && selected.excluded === 1 ? 'Hidden' : 'Show'}
            onPress={toggleExclude}
            disabled={!selected}
          />
          <ActionBtn
            icon="trash-outline"
            label="Delete"
            onPress={doDeleteSelection}
            disabled={!selected && !selectedOverlay}
          />
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
  onSelect,
  onTrimChange,
  onTrimEnd,
  onTrimRelease,
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
  onSelect: () => void;
  // Fired on every pan update so the parent can reflow the rest of the
  // timeline in lockstep with the drag.
  onTrimChange: (dxIn: number, dxOut: number) => void;
  onTrimEnd: () => void;
  onTrimRelease: (newIn: number, newOut: number) => void;
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
          onTrimChange(dx, 0);
        })
        .onEnd((g) => {
          const dx = applySnap(g.translationX, snapInRef.current);
          const dMs = dx / pxPerMsRef.current;
          const newIn = clamp(
            inMsRef.current + dMs,
            0,
            outMsRef.current - 200
          );
          onTrimRelease(newIn, outMsRef.current);
          onTrimEnd();
        })
        .onFinalize(() => onTrimEnd())
        .runOnJS(true),
    [onTrimChange, onTrimEnd, onTrimRelease]
  );
  const outPan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onUpdate((g) => {
          const dx = applySnap(g.translationX, snapOutRef.current);
          onTrimChange(0, dx);
        })
        .onEnd((g) => {
          const dx = applySnap(g.translationX, snapOutRef.current);
          const dMs = dx / pxPerMsRef.current;
          const newOut = clamp(
            outMsRef.current + dMs,
            inMsRef.current + 200,
            durationRef.current
          );
          onTrimRelease(inMsRef.current, newOut);
          onTrimEnd();
        })
        .onFinalize(() => onTrimEnd())
        .runOnJS(true),
    [onTrimChange, onTrimEnd, onTrimRelease]
  );

  const excluded = clip.excluded === 1;

  return (
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
          onTrimRelease(newStart, endRef.current);
        })
        .onFinalize(() => setDxStart(0))
        .runOnJS(true),
    [onTrimRelease]
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
          onTrimRelease(startRef.current, newEnd);
        })
        .onFinalize(() => setDxEnd(0))
        .runOnJS(true),
    [onTrimRelease]
  );

  const isMedia = overlay.kind === 'image' || overlay.kind === 'video';
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
        selected && styles.overlayChipSelected,
        { left: liveLeft, width: liveW },
      ]}
    >
      {isMedia ? (
        <Ionicons
          name={overlay.kind === 'video' ? 'videocam' : 'image-outline'}
          size={12}
          color={palette.onBright}
        />
      ) : null}
      <Text numberOfLines={1} style={styles.overlayChipText}>
        {isMedia
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
  cellSelected: {
    borderColor: palette.lime,
    borderWidth: 2,
    shadowColor: palette.lime,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
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
});
