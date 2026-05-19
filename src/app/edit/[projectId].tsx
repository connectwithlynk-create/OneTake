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
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import DraggableFlatList, {
  RenderItemParams,
} from 'react-native-draggable-flatlist';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClipVideo } from '@/components/clip-video';
import { AppText, Button, IconButton, Loading } from '@/components/ui';
import { resolveClipUri } from '@/lib/filestore';
import {
  addOverlay,
  deleteClip,
  deleteOverlay,
  getProject,
  listClips,
  listOverlays,
  reorderProjectClips,
  setClipExcluded,
  setClipTrim,
  setClipVolume,
  updateOverlay,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, radius, space, verdictColor } from '@/theme';
import type { Clip, Overlay, WordTiming } from '@/lib/types';

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// ----- effective trim helpers -----
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
    for (let i = 0; i < included.length; i++)
      out.push(out[i] + effLen(included[i]));
    return out;
  }, [included]);
  const totalMs = cumulative[cumulative.length - 1] ?? 0;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && included.length > 0) setSelectedId(included[0].id);
  }, [included, selectedId]);
  const selected = clips.find((c) => c.id === selectedId) ?? null;

  // ----- player + virtual playhead -----
  const player = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.1;
  });
  const [playing, setPlaying] = useState(false);
  const [globalMs, setGlobalMs] = useState(0);
  // Which included-clip the engine is currently playing.
  const activeIdx = useRef<number>(0);

  function loadActive(idx: number, autoplay: boolean) {
    const c = included[idx];
    if (!c) return;
    activeIdx.current = idx;
    try {
      player.replace(resolveClipUri(c.file_uri));
      player.currentTime = effIn(c) / 1000;
      player.volume = c.audio_volume ?? 1;
      if (autoplay) player.play();
      else player.pause();
    } catch {
      /* player not ready */
    }
  }

  // Sync active clip with selection when user picks a clip in the timeline.
  useEffect(() => {
    if (!selectedId) return;
    const idx = included.findIndex((c) => c.id === selectedId);
    if (idx >= 0 && idx !== activeIdx.current) {
      loadActive(idx, false);
      setGlobalMs(cumulative[idx]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Engine loop: read player time, advance to next clip when past out, etc.
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
          // advance
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
    }, 120);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [included, cumulative, totalMs]);

  function togglePlay() {
    try {
      if (player.playing) player.pause();
      else {
        if (activeIdx.current >= included.length) loadActive(0, true);
        else player.play();
      }
    } catch {
      /* ignore */
    }
  }

  // ----- selected clip: trim + volume drafts -----
  const [trimIn, setTrimIn] = useState(0);
  const [trimOut, setTrimOut] = useState(0);
  const [volume, setVolume] = useState(1);
  useEffect(() => {
    if (!selected) return;
    setTrimIn(effIn(selected));
    setTrimOut(effOut(selected));
    setVolume(selected.audio_volume ?? 1);
  }, [selected]);

  async function persistTrim(inMs: number, outMs: number) {
    if (!selected) return;
    await setClipTrim(selected.id, inMs, outMs);
    invalidate();
  }
  async function persistVolume(v: number) {
    if (!selected) return;
    await setClipVolume(selected.id, v);
    invalidate();
  }

  async function toggleExclude() {
    if (!selected) return;
    await setClipExcluded(selected.id, selected.excluded === 1 ? 0 : 1);
    invalidate();
  }
  async function removeSelected() {
    if (!selected) return;
    await deleteClip(selected.id, selected.file_uri);
    setSelectedId(null);
    invalidate();
  }

  // ----- reorder via timeline drag -----
  const onDragEnd = useCallback(
    async (params: { data: Clip[] }) => {
      setClips(params.data);
      await reorderProjectClips(projectId, params.data.map((c) => c.id));
      invalidate();
    },
    [projectId]
  );

  // ----- overlays -----
  const [overlayModal, setOverlayModal] = useState(false);
  const [overlayDraft, setOverlayDraft] = useState('');

  async function commitNewOverlay() {
    const text = overlayDraft.trim();
    if (!text) {
      setOverlayModal(false);
      return;
    }
    const start = globalMs;
    const end = Math.min(totalMs, globalMs + 3000);
    await addOverlay(projectId, { text, start_ms: start, end_ms: end });
    setOverlayDraft('');
    setOverlayModal(false);
    invalidate();
  }

  async function moveOverlay(o: Overlay, x: number, y: number) {
    await updateOverlay(o.id, { x, y });
    setOverlays((s) =>
      s.map((it) => (it.id === o.id ? { ...it, x, y } : it))
    );
    invalidate();
  }

  // ----- subtitles -----
  const [subsOn, setSubsOn] = useState(true);
  const activeWords: WordTiming[] = useMemo(() => {
    if (!subsOn) return [];
    const c = included[activeIdx.current];
    if (!c?.transcript_words) return [];
    try {
      const arr = JSON.parse(c.transcript_words) as WordTiming[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }, [included, subsOn, globalMs]);
  const subtitleNow = useMemo(() => {
    if (activeWords.length === 0) return '';
    const c = included[activeIdx.current];
    if (!c) return '';
    const localSec = (player.currentTime ?? 0);
    let i = activeWords.findIndex((w) => localSec >= w.s && localSec <= w.e);
    if (i < 0) {
      // pick the nearest preceding word so captions persist briefly
      for (let j = activeWords.length - 1; j >= 0; j--) {
        if (localSec >= activeWords[j].s) {
          i = j;
          break;
        }
      }
    }
    if (i < 0) return '';
    const start = Math.max(0, i - 2);
    const end = Math.min(activeWords.length, i + 3);
    return activeWords
      .slice(start, end)
      .map((w) => w.w)
      .join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWords, globalMs, included]);

  if (!project || !clipsDb) {
    return (
      <SafeAreaView style={styles.root}>
        <Loading />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* Header */}
      <View style={styles.headerRow}>
        <IconButton
          name="chevron-back"
          tone="surface"
          onPress={() => router.back()}
        />
        <AppText kind="subtitle" numberOfLines={1} style={{ flex: 1 }}>
          {project.title}
        </AppText>
        <Pressable style={styles.doneBtn} onPress={() => router.back()}>
          <AppText kind="body" style={{ color: palette.onBright, fontWeight: '900' }}>
            Done
          </AppText>
        </Pressable>
      </View>

      {/* Preview + overlay layer */}
      <View style={styles.previewWrap}>
        <View style={styles.preview}>
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            nativeControls={false}
            contentFit="contain"
          />
          {/* draggable text overlays */}
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
          {/* subtitles */}
          {subsOn && subtitleNow ? (
            <View style={styles.subWrap} pointerEvents="none">
              <Text style={styles.subText}>{subtitleNow}</Text>
            </View>
          ) : null}

          {/* global progress */}
          <View style={styles.progressBg} pointerEvents="none">
            <View
              style={[
                styles.progressFill,
                {
                  width: `${
                    totalMs > 0 ? (globalMs / totalMs) * 100 : 0
                  }%`,
                },
              ]}
            />
          </View>
        </View>
      </View>

      {/* Tools bar */}
      <View style={styles.toolsRow}>
        <Pressable style={styles.tool} onPress={togglePlay}>
          <Ionicons
            name={playing ? 'pause' : 'play'}
            size={20}
            color={palette.onBright}
          />
        </Pressable>
        <Pressable
          style={[styles.toolBtn, { borderColor: palette.purple }]}
          onPress={() => setOverlayModal(true)}
        >
          <Ionicons name="text" size={16} color={palette.purple} />
          <AppText kind="caption" style={{ color: palette.purple }}>
            TEXT
          </AppText>
        </Pressable>
        <Pressable
          style={[
            styles.toolBtn,
            { borderColor: subsOn ? palette.yellow : palette.border },
          ]}
          onPress={() => setSubsOn((v) => !v)}
        >
          <Ionicons
            name="text-outline"
            size={16}
            color={subsOn ? palette.yellow : palette.textFaint}
          />
          <AppText
            kind="caption"
            style={{ color: subsOn ? palette.yellow : palette.textFaint }}
          >
            SUBS
          </AppText>
        </Pressable>
        <AppText
          kind="caption"
          style={{ marginLeft: 'auto', color: palette.textFaint }}
        >
          {mmss(globalMs)} / {mmss(totalMs)}
        </AppText>
      </View>

      {/* Selected clip controls */}
      {selected ? (
        <View style={styles.selectedBlock}>
          <View style={styles.selectedRow}>
            <View
              style={[
                styles.selectedDot,
                { backgroundColor: verdictColor[selected.verdict] },
              ]}
            />
            <AppText kind="body" numberOfLines={1} style={{ flex: 1 }}>
              {selected.name ?? `Take ${selected.order_index + 1}`}
            </AppText>
            <IconButton
              name={selected.excluded === 1 ? 'eye-off' : 'eye'}
              tone="surface"
              onPress={toggleExclude}
            />
            <IconButton
              name="trash"
              tone="clear"
              color={palette.red}
              onPress={removeSelected}
            />
          </View>

          {/* trim sliders */}
          <RangeSlider
            label="IN"
            min={0}
            max={selected.duration_ms}
            value={trimIn}
            otherBound={trimOut - 200}
            onChange={setTrimIn}
            onRelease={(v) => {
              const next = clamp(v, 0, trimOut - 200);
              setTrimIn(next);
              persistTrim(next, trimOut);
            }}
          />
          <RangeSlider
            label="OUT"
            min={0}
            max={selected.duration_ms}
            value={trimOut}
            otherBound={trimIn + 200}
            onChange={setTrimOut}
            onRelease={(v) => {
              const next = clamp(v, trimIn + 200, selected.duration_ms);
              setTrimOut(next);
              persistTrim(trimIn, next);
            }}
          />
          {/* volume */}
          <VolumeSlider
            value={volume}
            onChange={setVolume}
            onRelease={(v) => {
              setVolume(v);
              persistVolume(v);
            }}
          />
        </View>
      ) : null}

      {/* Timeline (drag-reorder) */}
      <View style={styles.timelineWrap}>
        <DraggableFlatList<Clip>
          data={clips}
          horizontal
          keyExtractor={(c) => c.id}
          onDragEnd={onDragEnd}
          contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.lg }}
          renderItem={(params) => (
            <TimelineCell
              params={params}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId(id)}
            />
          )}
          activationDistance={6}
        />
      </View>

      {/* Add-overlay modal */}
      <Modal
        visible={overlayModal}
        transparent
        animationType="fade"
        onRequestClose={() => setOverlayModal(false)}
      >
        <View style={styles.modalScrim}>
          <View style={styles.modalCard}>
            <AppText kind="subtitle">Add text overlay</AppText>
            <TextInput
              value={overlayDraft}
              onChangeText={setOverlayDraft}
              placeholder="Your overlay text"
              placeholderTextColor={palette.textFaint}
              autoFocus
              style={styles.modalInput}
            />
            <AppText kind="caption" style={{ color: palette.textFaint }}>
              Starts at {mmss(globalMs)}, lasts 3s. Drag it on the preview to
              reposition.
            </AppText>
            <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.lg }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Cancel"
                  tone="ghost"
                  onPress={() => setOverlayModal(false)}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="Add" tone="accent" onPress={commitNewOverlay} />
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ============================================================
// Subcomponents
// ============================================================

function TimelineCell({
  params,
  selectedId,
  onSelect,
}: {
  params: RenderItemParams<Clip>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { item, drag, isActive } = params;
  const selected = item.id === selectedId;
  const excluded = item.excluded === 1;
  // Width proportional to (clamped) duration, with sane min/max.
  const w = clamp(effLen(item) / 200, 56, 200);
  return (
    <Pressable
      onPress={() => onSelect(item.id)}
      onLongPress={drag}
      delayLongPress={200}
      style={[
        styles.cell,
        { width: w, opacity: isActive ? 0.7 : excluded ? 0.4 : 1 },
        selected && { borderColor: palette.yellow, borderWidth: 2 },
      ]}
    >
      <View style={styles.cellThumb}>
        <ClipVideo uri={item.file_uri} style={StyleSheet.absoluteFill} />
      </View>
      <Text numberOfLines={1} style={styles.cellLabel}>
        {item.name ?? `Take ${item.order_index + 1}`}
      </Text>
    </Pressable>
  );
}

function RangeSlider({
  label,
  min,
  max,
  value,
  otherBound,
  onChange,
  onRelease,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  /** lower bound (for OUT) or upper bound (for IN) so the two thumbs can't cross. */
  otherBound: number;
  onChange: (v: number) => void;
  onRelease: (v: number) => void;
}) {
  const trackW = useRef(0);
  const isOut = label === 'OUT';
  const ratio = (value - min) / Math.max(1, max - min);
  const valueRef = useRef(value);
  valueRef.current = value;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (e) => {
        const w = trackW.current;
        if (w <= 0) return;
        const r = clamp(e.nativeEvent.locationX / w, 0, 1);
        let v = min + r * (max - min);
        v = isOut ? Math.max(v, otherBound) : Math.min(v, otherBound);
        onChange(v);
      },
      onPanResponderRelease: () => onRelease(valueRef.current),
    })
  ).current;

  return (
    <View style={{ gap: 4 }}>
      <View style={styles.sliderHead}>
        <AppText kind="caption" style={{ color: palette.textFaint }}>
          {label}
        </AppText>
        <AppText kind="caption" style={{ color: palette.textFaint }}>
          {mmss(value)}
        </AppText>
      </View>
      <View
        style={styles.sliderTrack}
        onLayout={(e: LayoutChangeEvent) => {
          trackW.current = e.nativeEvent.layout.width;
        }}
        {...pan.panHandlers}
      >
        <View style={styles.sliderBg} />
        <View
          style={[
            styles.sliderFill,
            { width: `${ratio * 100}%`, backgroundColor: palette.blue },
          ]}
        />
        <View style={[styles.sliderThumb, { left: `${ratio * 100}%` }]} />
      </View>
    </View>
  );
}

function VolumeSlider({
  value,
  onChange,
  onRelease,
}: {
  value: number;
  onChange: (v: number) => void;
  onRelease: (v: number) => void;
}) {
  const trackW = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (e) => {
        const w = trackW.current;
        if (w <= 0) return;
        const r = clamp(e.nativeEvent.locationX / w, 0, 1);
        onChange(r);
      },
      onPanResponderRelease: () => onRelease(valueRef.current),
    })
  ).current;
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.sliderHead}>
        <AppText kind="caption" style={{ color: palette.textFaint }}>
          VOLUME
        </AppText>
        <AppText kind="caption" style={{ color: palette.textFaint }}>
          {Math.round(value * 100)}%
        </AppText>
      </View>
      <View
        style={styles.sliderTrack}
        onLayout={(e: LayoutChangeEvent) => {
          trackW.current = e.nativeEvent.layout.width;
        }}
        {...pan.panHandlers}
      >
        <View style={styles.sliderBg} />
        <View
          style={[
            styles.sliderFill,
            { width: `${value * 100}%`, backgroundColor: palette.purple },
          ]}
        />
        <View style={[styles.sliderThumb, { left: `${value * 100}%` }]} />
      </View>
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
  // We do simple position updates relative to the preview frame size. The
  // overlay container measures itself; PanResponder updates x/y on release.
  const layout = useRef({ w: 0, h: 0 });
  const start = useRef({ x: overlay.x, y: overlay.y });
  const local = useRef({ x: overlay.x, y: overlay.y });
  const [pos, setPos] = useState({ x: overlay.x, y: overlay.y });
  useEffect(() => {
    setPos({ x: overlay.x, y: overlay.y });
    local.current = { x: overlay.x, y: overlay.y };
  }, [overlay.x, overlay.y]);

  const parent = useRef<View>(null);
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
      ref={parent}
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  doneBtn: {
    backgroundColor: palette.yellow,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  previewWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  preview: {
    width: '100%',
    aspectRatio: 9 / 16,
    maxHeight: 360,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: palette.border,
  },
  subWrap: {
    position: 'absolute',
    bottom: 16,
    left: 12,
    right: 12,
    alignItems: 'center',
  },
  subText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
  },
  progressBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  progressFill: { height: 3, backgroundColor: palette.purple },
  toolsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  tool: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: palette.purple,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  selectedBlock: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  selectedRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  selectedDot: { width: 10, height: 10, borderRadius: 5 },
  sliderHead: { flexDirection: 'row', justifyContent: 'space-between' },
  sliderTrack: { height: 24, justifyContent: 'center' },
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
  timelineWrap: {
    paddingVertical: space.lg,
  },
  cell: {
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    overflow: 'hidden',
    padding: 4,
    gap: 4,
  },
  cellThumb: {
    height: 80,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  cellLabel: {
    color: palette.text,
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  overlayBox: {
    position: 'absolute',
    transform: [{ translateX: -60 }, { translateY: -16 }],
    backgroundColor: 'transparent',
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
});
