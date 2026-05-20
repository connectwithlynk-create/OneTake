import { Ionicons } from '@expo/vector-icons';
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
  LayoutChangeEvent,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClipVideo } from '@/components/clip-video';
import { Loading } from '@/components/ui';
import { resolveClipUri } from '@/lib/filestore';
import {
  addOverlay,
  deleteClip,
  deleteOverlay,
  getProject,
  listClips,
  listOverlays,
  setClipExcluded,
  setClipTrim,
  setClipVolume,
  splitClipAt,
  updateOverlay,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, radius, space } from '@/theme';
import type { Clip, Overlay, WordTiming } from '@/lib/types';

// === Timeline geometry =====================================================
// 60 px per second feels close to CapCut's default density.
const PX_PER_MS = 0.06;
const RULER_H = 22;
const SUBS_H = 30;
const OVRL_H = 30;
const CLIP_H = 64;
const TRACK_GAP = 6;
const TRACK_BLOCK_H =
  RULER_H + TRACK_GAP + SUBS_H + TRACK_GAP + OVRL_H + TRACK_GAP + CLIP_H;
const SPEEDS = [0.5, 1, 1.25, 1.5, 2];

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

  const included = useMemo(
    () => clips.filter((c) => c.excluded === 0),
    [clips]
  );
  const cumulative = useMemo(() => {
    const out: number[] = [0];
    for (let i = 0; i < included.length; i++) {
      out.push(out[i] + effLen(included[i]));
    }
    return out;
  }, [included]);
  const totalMs = cumulative[cumulative.length - 1] ?? 0;

  // ----- selection -----
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && included.length > 0) setSelectedId(included[0].id);
  }, [included, selectedId]);
  const selected = clips.find((c) => c.id === selectedId) ?? null;

  // ----- player engine -----
  const player = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.1;
  });
  const [playing, setPlaying] = useState(false);
  const [globalMs, setGlobalMs] = useState(0);
  const activeIdx = useRef<number>(0);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1);
  speedRef.current = speed;

  const loadActive = useCallback(
    (idx: number, autoplay: boolean) => {
      const c = included[idx];
      if (!c) return;
      activeIdx.current = idx;
      try {
        player.replace(resolveClipUri(c.file_uri));
        player.currentTime = effIn(c) / 1000;
        player.volume = c.audio_volume ?? 1;
        player.playbackRate = speedRef.current;
        if (autoplay) player.play();
        else player.pause();
      } catch {
        /* player not ready */
      }
    },
    [included, player]
  );

  // Tap a timeline cell -> switch the active source.
  useEffect(() => {
    if (!selectedId) return;
    const idx = included.findIndex((c) => c.id === selectedId);
    if (idx >= 0 && idx !== activeIdx.current) {
      loadActive(idx, false);
      setGlobalMs(cumulative[idx]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Engine loop: poll player time, advance at clip bounds.
  useEffect(() => {
    if (included.length === 0) return;
    if (activeIdx.current >= included.length) loadActive(0, false);
    const t = setInterval(() => {
      try {
        setPlaying(player.playing);
        const idx = activeIdx.current;
        const c = included[idx];
        if (!c) return;
        const tMs = (player.currentTime ?? 0) * 1000;
        const outMs = effOut(c);
        const inMs = effIn(c);
        if (tMs >= outMs - 30) {
          if (idx + 1 < included.length) {
            loadActive(idx + 1, player.playing);
            setSelectedId(included[idx + 1].id);
          } else {
            player.pause();
            setGlobalMs(totalMs);
          }
          return;
        }
        const local = Math.max(0, tMs - inMs);
        setGlobalMs(cumulative[idx] + local);
      } catch {
        /* ignore */
      }
    }, 100);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [included, cumulative, totalMs]);

  function togglePlay() {
    try {
      if (player.playing) player.pause();
      else if (activeIdx.current >= included.length) loadActive(0, true);
      else player.play();
    } catch {
      /* ignore */
    }
  }

  // ----- bottom-bar modes (Volume / Speed open inline panels) -----
  const [bottomMode, setBottomMode] = useState<'none' | 'volume' | 'speed'>(
    'none'
  );

  async function doSplit() {
    if (!selected) return;
    const idx = included.findIndex((c) => c.id === selected.id);
    if (idx < 0) return;
    const atLocal = Math.max(0, globalMs - cumulative[idx]); // ms within the effective selected clip
    const res = await splitClipAt(selected.id, atLocal);
    if (res) invalidate();
  }

  async function doDelete() {
    if (!selected) return;
    await deleteClip(selected.id, selected.file_uri);
    setSelectedId(null);
    invalidate();
  }

  async function toggleExclude() {
    if (!selected) return;
    await setClipExcluded(selected.id, selected.excluded === 1 ? 0 : 1);
    invalidate();
  }

  function doSpeed(s: number) {
    setSpeed(s);
    try {
      player.playbackRate = s;
    } catch {
      /* ignore */
    }
  }

  async function changeVolume(v: number) {
    if (!selected) return;
    const clipId = selected.id;
    await setClipVolume(clipId, v);
    try {
      // only honor for the *currently playing* clip
      if (included[activeIdx.current]?.id === clipId) player.volume = v;
    } catch {
      /* ignore */
    }
    invalidate();
  }

  // ----- trim drag (selected clip in strip) -----
  async function persistTrim(inMs: number, outMs: number) {
    if (!selected) return;
    await setClipTrim(selected.id, Math.round(inMs), Math.round(outMs));
    invalidate();
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
    await addOverlay(projectId, { text, start_ms: start, end_ms: end });
    setOverlayDraft('');
    setOverlayModal(false);
    invalidate();
  }
  async function moveOverlay(o: Overlay, x: number, y: number) {
    await updateOverlay(o.id, { x, y });
    setOverlays((s) => s.map((it) => (it.id === o.id ? { ...it, x, y } : it)));
    invalidate();
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
    const localSec = player.currentTime ?? 0;
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

  // ----- timeline scroll -----
  const scrollRef = useRef<ScrollView>(null);
  const userScrolling = useRef(false);
  const timelineW = useMemo(
    () => Math.max(800, totalMs * PX_PER_MS + 200),
    [totalMs]
  );

  // Keep the playhead in view as time advances (unless the user is scrolling).
  useEffect(() => {
    if (userScrolling.current) return;
    const x = globalMs * PX_PER_MS - 80;
    scrollRef.current?.scrollTo({ x: Math.max(0, x), animated: false });
  }, [globalMs]);

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
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            nativeControls={false}
            contentFit="contain"
          />
          {overlays
            .filter((o) => globalMs >= o.start_ms && globalMs < o.end_ms)
            .map((o) => (
              <DraggableOverlay
                key={o.id}
                overlay={o}
                onMove={(x, y) => moveOverlay(o, x, y)}
                onDelete={async () => {
                  await deleteOverlay(o.id);
                  setOverlays((s) => s.filter((x) => x.id !== o.id));
                  invalidate();
                }}
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
        <Pressable style={styles.iconCircle} hitSlop={6}>
          <Ionicons name="arrow-undo" size={18} color={palette.textFaint} />
        </Pressable>
        <Pressable style={styles.iconCircle} hitSlop={6}>
          <Ionicons name="arrow-redo" size={18} color={palette.textFaint} />
        </Pressable>
      </View>

      {/* ===== Multi-track timeline ================================== */}
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={() => {
          userScrolling.current = true;
        }}
        onMomentumScrollEnd={() => {
          userScrolling.current = false;
        }}
        onScrollEndDrag={() => {
          setTimeout(() => {
            userScrolling.current = false;
          }, 800);
        }}
        style={styles.timelineScroll}
        contentContainerStyle={{ paddingHorizontal: 16 }}
      >
        <View
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
                  { left: s * 1000 * PX_PER_MS - 0.5 },
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
            {renderSubtitleChips(included, cumulative)}
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
              <View
                key={o.id}
                style={[
                  styles.overlayChip,
                  {
                    left: o.start_ms * PX_PER_MS,
                    width: Math.max(40, (o.end_ms - o.start_ms) * PX_PER_MS),
                  },
                ]}
              >
                <Text numberOfLines={1} style={styles.overlayChipText}>
                  {o.text}
                </Text>
              </View>
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
              {
                top:
                  RULER_H +
                  TRACK_GAP +
                  SUBS_H +
                  TRACK_GAP +
                  OVRL_H +
                  TRACK_GAP,
                height: CLIP_H,
              },
            ]}
          >
            {included.map((c, idx) => {
              const left = cumulative[idx] * PX_PER_MS;
              const width = Math.max(48, effLen(c) * PX_PER_MS);
              return (
                <ClipCell
                  key={c.id}
                  clip={c}
                  left={left}
                  width={width}
                  selected={c.id === selectedId}
                  onSelect={() => setSelectedId(c.id)}
                  onTrimRelease={(newIn, newOut) =>
                    persistTrim(newIn, newOut)
                  }
                />
              );
            })}
          </View>

          {/* Playhead */}
          <View
            pointerEvents="none"
            style={[
              styles.playhead,
              {
                left: globalMs * PX_PER_MS - 0.5,
                height: TRACK_BLOCK_H + 12,
              },
            ]}
          >
            <View style={styles.playheadCap} />
          </View>
        </View>
      </ScrollView>

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

      {/* ===== Bottom action bar ===================================== */}
      <View style={styles.actionBar}>
        <Pressable
          onPress={() => router.back()}
          style={styles.actionBack}
          hitSlop={6}
        >
          <Ionicons name="chevron-back" size={22} color={palette.text} />
        </Pressable>
        <ActionBtn
          icon="cut-outline"
          label="Split"
          onPress={doSplit}
          disabled={!selected}
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
          onPress={doDelete}
          disabled={!selected}
        />
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
function renderSubtitleChips(included: Clip[], cumulative: number[]) {
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
      const width = Math.max(20, (endGlobal - startGlobal) * PX_PER_MS);
      out.push(
        <View
          key={`${c.id}-${j}`}
          style={[
            styles.subChip,
            { left: startGlobal * PX_PER_MS, width },
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
  selected,
  onSelect,
  onTrimRelease,
}: {
  clip: Clip;
  left: number;
  width: number;
  selected: boolean;
  onSelect: () => void;
  onTrimRelease: (newIn: number, newOut: number) => void;
}) {
  // Live drag deltas in px; converted to ms on release. Width changes live;
  // surrounding clips re-flow on persistence.
  const [dxIn, setDxIn] = useState(0);
  const [dxOut, setDxOut] = useState(0);
  const inMs = effIn(clip);
  const outMs = effOut(clip);

  const inPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_, g) => setDxIn(g.dx),
      onPanResponderRelease: (_, g) => {
        const dMs = g.dx / PX_PER_MS;
        const newIn = clamp(inMs + dMs, 0, outMs - 200);
        setDxIn(0);
        onTrimRelease(newIn, outMs);
      },
      onPanResponderTerminate: () => setDxIn(0),
    })
  ).current;
  const outPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_, g) => setDxOut(g.dx),
      onPanResponderRelease: (_, g) => {
        const dMs = g.dx / PX_PER_MS;
        const newOut = clamp(outMs + dMs, inMs + 200, clip.duration_ms);
        setDxOut(0);
        onTrimRelease(inMs, newOut);
      },
      onPanResponderTerminate: () => setDxOut(0),
    })
  ).current;

  const liveLeft = left + (selected ? dxIn : 0);
  const liveW = Math.max(
    48,
    width - (selected ? dxIn : 0) + (selected ? dxOut : 0)
  );
  const excluded = clip.excluded === 1;

  return (
    <Pressable
      onPress={onSelect}
      style={[
        styles.cell,
        {
          left: liveLeft,
          width: liveW,
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
          <View
            {...inPan.panHandlers}
            style={[styles.trimHandle, styles.trimHandleLeft]}
          >
            <Ionicons
              name="chevron-back"
              size={14}
              color={palette.onBright}
            />
          </View>
          <View
            {...outPan.panHandlers}
            style={[styles.trimHandle, styles.trimHandleRight]}
          >
            <Ionicons
              name="chevron-forward"
              size={14}
              color={palette.onBright}
            />
          </View>
        </>
      ) : null}
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

function VolumePanel({
  value,
  onChange,
  onClose,
}: {
  value: number;
  onChange: (v: number) => void;
  onClose: () => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const trackW = useRef(0);
  const localRef = useRef(local);
  localRef.current = local;
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (e) => {
        const w = trackW.current;
        if (w <= 0) return;
        setLocal(clamp(e.nativeEvent.locationX / w, 0, 1));
      },
      onPanResponderRelease: () => onChange(localRef.current),
    })
  ).current;
  return (
    <View style={styles.bottomPanel}>
      <View style={styles.bottomPanelHead}>
        <Text style={styles.bottomPanelTitle}>Volume</Text>
        <Text style={styles.bottomPanelValue}>{Math.round(local * 100)}%</Text>
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={20} color={palette.textFaint} />
        </Pressable>
      </View>
      <View
        style={styles.sliderTrack}
        {...pan.panHandlers}
        onLayout={(e: LayoutChangeEvent) => {
          trackW.current = e.nativeEvent.layout.width;
        }}
      >
        <View style={styles.sliderBg} />
        <View
          style={[
            styles.sliderFill,
            { width: `${local * 100}%`, backgroundColor: palette.purple },
          ]}
        />
        <View style={[styles.sliderThumb, { left: `${local * 100}%` }]} />
      </View>
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
  return (
    <View style={styles.bottomPanel}>
      <View style={styles.bottomPanelHead}>
        <Text style={styles.bottomPanelTitle}>Speed</Text>
        <Text style={styles.bottomPanelValue}>{value}x</Text>
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={20} color={palette.textFaint} />
        </Pressable>
      </View>
      <View style={styles.speedRow}>
        {SPEEDS.map((s) => (
          <Pressable
            key={s}
            onPress={() => onChange(s)}
            style={[styles.speedChip, value === s && styles.speedChipActive]}
          >
            <Text
              style={[
                styles.speedChipText,
                value === s && styles.speedChipTextActive,
              ]}
            >
              {s}x
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.bottomPanelHint}>
        Preview-only; not persisted and not yet honored by export.
      </Text>
    </View>
  );
}

function DraggableOverlay({
  overlay,
  onMove,
  onDelete,
}: {
  overlay: Overlay;
  onMove: (x: number, y: number) => void;
  onDelete: () => void;
}) {
  const layout = useRef({ w: 0, h: 0 });
  const start = useRef({ x: overlay.x, y: overlay.y });
  const local = useRef({ x: overlay.x, y: overlay.y });
  const [pos, setPos] = useState({ x: overlay.x, y: overlay.y });
  useEffect(() => {
    setPos({ x: overlay.x, y: overlay.y });
    local.current = { x: overlay.x, y: overlay.y };
  }, [overlay.x, overlay.y]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        start.current = { ...local.current };
      },
      onPanResponderMove: (_, g) => {
        const { w, h } = layout.current;
        if (w <= 0 || h <= 0) return;
        const x = clamp(start.current.x + g.dx / w, 0.02, 0.98);
        const y = clamp(start.current.y + g.dy / h, 0.02, 0.98);
        local.current = { x, y };
        setPos({ x, y });
      },
      onPanResponderRelease: () => {
        onMove(local.current.x, local.current.y);
      },
    })
  ).current;

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
      <View
        {...pan.panHandlers}
        style={[
          styles.overlayBox,
          { left: `${pos.x * 100}%`, top: `${pos.y * 100}%` },
        ]}
      >
        <Text
          style={{
            color: overlay.color,
            fontSize: overlay.size,
            fontWeight: '900',
            textAlign: 'center',
          }}
        >
          {overlay.text}
        </Text>
        <Pressable style={styles.overlayDel} onPress={onDelete} hitSlop={6}>
          <Ionicons name="close" size={12} color="#fff" />
        </Pressable>
      </View>
    </View>
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
    fontSize: 16,
    fontWeight: '800',
    maxWidth: 160,
  },
  qualityLbl: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '800',
    marginLeft: 'auto',
  },
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: palette.yellow,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
  nextText: { color: palette.onBright, fontWeight: '900', fontSize: 14 },

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
    borderWidth: 2,
    borderColor: palette.yellow,
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
    fontSize: 14,
    fontWeight: '900',
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 3,
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
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
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
    fontSize: 14,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  timeTotal: {
    color: palette.textFaint,
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    marginTop: -2,
  },

  // Timeline scroll
  timelineScroll: { flexGrow: 0, marginTop: 4 },

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
    color: palette.textFaint,
    fontSize: 10,
    fontWeight: '700',
    marginLeft: 4,
  },

  // Tracks
  trackRow: {
    position: 'absolute',
    left: 0,
    right: 0,
  },

  // Subtitle chips
  subChip: {
    position: 'absolute',
    top: 4,
    height: 22,
    borderRadius: 6,
    backgroundColor: palette.blue,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  subChipText: { color: palette.onBright, fontSize: 11, fontWeight: '800' },

  // Overlay chips
  overlayChip: {
    position: 'absolute',
    top: 4,
    height: 22,
    borderRadius: 6,
    backgroundColor: palette.purple,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  overlayChipText: { color: palette.onBright, fontSize: 11, fontWeight: '800' },
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
  cellSelected: { borderColor: palette.yellow, borderWidth: 2 },
  cellBadge: {
    position: 'absolute',
    left: 4,
    top: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
  },
  cellBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  trimHandle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 16,
    backgroundColor: palette.yellow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trimHandleLeft: { left: 0 },
  trimHandleRight: { right: 0 },

  // Playhead
  playhead: {
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
    paddingVertical: 10,
    backgroundColor: '#0B0716',
    borderTopWidth: 1,
    borderTopColor: palette.border,
    marginTop: 'auto',
  },
  actionBack: { paddingHorizontal: 8, paddingVertical: 6 },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  actionLbl: { fontSize: 10, fontWeight: '700', marginTop: 2 },

  // Bottom inline panels
  bottomPanel: {
    backgroundColor: '#0B0716',
    borderTopWidth: 1,
    borderTopColor: palette.border,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.sm,
  },
  bottomPanelHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bottomPanelTitle: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '800',
    flex: 1,
  },
  bottomPanelValue: {
    color: palette.textDim,
    fontSize: 13,
    fontWeight: '700',
  },
  bottomPanelHint: { color: palette.textFaint, fontSize: 11 },
  speedRow: { flexDirection: 'row', gap: 8 },
  speedChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: 'center',
    backgroundColor: palette.surface,
  },
  speedChipActive: {
    backgroundColor: palette.yellow,
    borderColor: palette.yellow,
  },
  speedChipText: { color: palette.text, fontSize: 13, fontWeight: '800' },
  speedChipTextActive: { color: palette.onBright },

  // Sliders
  sliderTrack: { height: 28, justifyContent: 'center' },
  sliderBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.surfaceHi,
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
  modalTitle: { color: palette.text, fontSize: 16, fontWeight: '800' },
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
  modalBtnGhost: { backgroundColor: palette.surfaceHi },
  modalBtnGhostText: { color: palette.text, fontWeight: '800' },
  modalBtnPrimary: { backgroundColor: palette.yellow },
  modalBtnPrimaryText: { color: palette.onBright, fontWeight: '900' },
});
