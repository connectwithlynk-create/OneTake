import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconButton, MonoLabel, TagPill, VerdictPill } from '@/components/ui';
import { resolveClipUri } from '@/lib/filestore';
import { getClip, setClipMirrored, setTag } from '@/lib/repo';
import type { Clip, ClipTag } from '@/lib/types';
import { font, palette } from '@/theme';

function mmss(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

export default function PlayerScreen() {
  const { uri, title, id } = useLocalSearchParams<{
    uri?: string;
    title?: string;
    id?: string;
  }>();
  const router = useRouter();

  const player = useVideoPlayer(uri ? resolveClipUri(uri) : null, (p) => {
    p.loop = true;
    p.timeUpdateEventInterval = 0.25;
    p.play();
  });

  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [showTx, setShowTx] = useState(false);
  const [tag, setTagState] = useState<ClipTag | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'done'>('idle');
  const [mirrored, setMirroredState] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!id) {
      setClip(null);
      setTagState(null);
      return;
    }
    getClip(id)
      .then((c) => {
        if (!alive) return;
        setClip(c);
        setTagState(c?.tag ?? null);
        setMirroredState((c?.mirrored ?? 0) === 1);
      })
      .catch(() => {
        if (alive) setClip(null);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const transcript = clip?.transcript?.trim() || null;

  async function saveToCameraRoll() {
    if (!uri || saveState === 'saving') return;
    setSaveState('saving');
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        setSaveState('idle');
        return;
      }
      await MediaLibrary.saveToLibraryAsync(resolveClipUri(uri));
      setSaveState('done');
      setTimeout(() => setSaveState('idle'), 1800);
    } catch {
      setSaveState('idle');
    }
  }

  async function flipMirror() {
    if (!id) return;
    const next = !mirrored;
    setMirroredState(next);
    try {
      await setClipMirrored(id, next ? 1 : 0);
    } catch {
      setMirroredState(!next);
    }
  }

  async function flipTag() {
    if (!id || !tag) return;
    const next: ClipTag = tag === 'talking' ? 'broll' : 'talking';
    const prev = tag;
    setTagState(next);
    try {
      await setTag(id, next);
    } catch {
      setTagState(prev);
    }
  }

  useEffect(() => {
    const t = setInterval(() => {
      try {
        setPlaying(player.playing);
        setCur(player.currentTime ?? 0);
        setDur(player.duration ?? 0);
      } catch {
        /* not ready */
      }
    }, 250);
    return () => clearInterval(t);
  }, [player]);

  const trackW = useRef(0);
  const progress = scrub ?? (dur > 0 ? Math.min(1, cur / dur) : 0);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (e) => {
        if (trackW.current > 0) {
          setScrub(
            Math.max(0, Math.min(1, e.nativeEvent.locationX / trackW.current))
          );
        }
      },
      onPanResponderRelease: (e) => {
        const w = trackW.current;
        const r = w > 0 ? Math.max(0, Math.min(1, e.nativeEvent.locationX / w)) : 0;
        try {
          if (player.duration > 0) player.currentTime = r * player.duration;
        } catch {
          /* ignore */
        }
        setScrub(null);
      },
    })
  ).current;

  function toggle() {
    try {
      if (player.playing) player.pause();
      else player.play();
      setPlaying(!player.playing);
    } catch {
      /* ignore */
    }
  }

  function toggleMute() {
    try {
      player.muted = !player.muted;
      setMuted(player.muted);
    } catch {
      /* ignore */
    }
  }

  return (
    <SafeAreaView style={s.root} edges={['top', 'bottom']}>
      <View style={s.header}>
        <IconButton name="chevron-down" tone="surface" size={38} onPress={() => router.back()} />
        <Text style={s.title} numberOfLines={1}>
          {title ?? 'Clip'}
        </Text>
        {tag ? (
          <Pressable onPress={flipTag} hitSlop={6}>
            <TagPill t={tag} />
          </Pressable>
        ) : null}
        <IconButton
          name="swap-horizontal"
          tone={mirrored ? 'accent' : 'surface'}
          size={38}
          onPress={flipMirror}
        />
        <IconButton
          name={
            saveState === 'done'
              ? 'checkmark'
              : saveState === 'saving'
              ? 'hourglass-outline'
              : 'download-outline'
          }
          tone={saveState === 'done' ? 'accent' : 'surface'}
          size={38}
          onPress={saveToCameraRoll}
        />
        <IconButton
          name={muted ? 'volume-mute' : 'volume-high'}
          tone="surface"
          size={38}
          onPress={toggleMute}
        />
      </View>

      <Pressable style={s.stage} onPress={toggle}>
        {uri ? (
          <View style={s.frame}>
            <VideoView
              player={player}
              style={[
                StyleSheet.absoluteFill,
                mirrored ? { transform: [{ scaleX: -1 }] } : null,
              ]}
              nativeControls={false}
              contentFit="contain"
            />

            {clip ? (
              <View style={s.verdictOverlay}>
                <VerdictPill v={clip.verdict} />
              </View>
            ) : null}

            {!playing && (
              <View style={s.playOverlay} pointerEvents="none">
                <View style={s.bigPlay}>
                  <Ionicons name="play" size={22} color={palette.onBright} />
                </View>
              </View>
            )}

            {transcript ? (
              <Pressable
                style={s.txBtn}
                onPress={() => setShowTx((v) => !v)}
                hitSlop={8}
              >
                <Ionicons
                  name={showTx ? 'close' : 'document-text-outline'}
                  size={14}
                  color="#fff"
                />
              </Pressable>
            ) : null}

            {transcript && showTx ? (
              <View style={s.txPanel}>
                <MonoLabel style={{ marginBottom: 8 }}>TRANSCRIPT</MonoLabel>
                <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                  <Text style={s.txText}>{transcript}</Text>
                </ScrollView>
              </View>
            ) : null}
          </View>
        ) : (
          <Text style={{ color: palette.text2, fontFamily: font.body }}>
            Clip unavailable.
          </Text>
        )}
      </Pressable>

      <View style={s.controls}>
        <Pressable style={s.playBtn} onPress={toggle}>
          <Ionicons
            name={playing ? 'pause' : 'play'}
            size={16}
            color={palette.onBright}
          />
        </Pressable>

        <View style={{ flex: 1, gap: 6 }}>
          <View
            style={s.track}
            onLayout={(e: LayoutChangeEvent) => {
              trackW.current = e.nativeEvent.layout.width;
            }}
            {...pan.panHandlers}
          >
            <View style={s.trackBg} />
            <View style={[s.fill, { width: `${progress * 100}%` }]} />
            <View style={[s.thumbDot, { left: `${progress * 100}%` }]} />
          </View>
          <View style={s.times}>
            <Text style={s.timeText}>{mmss(scrub != null ? scrub * dur : cur)}</Text>
            <Text style={s.timeText}>{mmss(dur)}</Text>
          </View>
        </View>
      </View>

      {transcript ? (
        <View style={s.txCard}>
          <MonoLabel style={{ marginBottom: 8 }}>
            TRANSCRIPT · WORD-LEVEL
          </MonoLabel>
          <ScrollView style={{ maxHeight: 130 }}>
            <Text style={s.txCardBody}>{transcript}</Text>
          </ScrollView>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  title: {
    flex: 1,
    fontFamily: font.displayHeavy,
    fontWeight: '700',
    fontSize: 16,
    color: '#fff',
  },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingTop: 12,
  },
  frame: {
    width: '100%',
    aspectRatio: 9 / 16,
    maxHeight: '100%',
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  verdictOverlay: { position: 'absolute', top: 14, right: 14 },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigPlay: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: palette.lime,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: palette.lime,
    shadowOpacity: 0.6,
    shadowRadius: 24,
  },
  txBtn: {
    position: 'absolute',
    bottom: 14,
    left: 14,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  txPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '55%',
    backgroundColor: 'rgba(0,0,0,0.82)',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 18,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
  },
  txText: { color: '#fff', fontFamily: font.body, fontSize: 14, lineHeight: 22 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 12,
  },
  playBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: palette.lime,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: palette.lime,
    shadowOpacity: 0.5,
    shadowRadius: 16,
  },
  track: { height: 24, justifyContent: 'center' },
  trackBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.lime,
  },
  thumbDot: {
    position: 'absolute',
    width: 13,
    height: 13,
    borderRadius: 7,
    marginLeft: -6.5,
    top: -4,
    backgroundColor: '#fff',
  },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  timeText: { fontFamily: font.mono, fontSize: 11, color: palette.text2 },
  txCard: {
    marginHorizontal: 18,
    marginBottom: 18,
    padding: 16,
    backgroundColor: palette.bg1,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  txCardBody: {
    fontFamily: font.body,
    fontSize: 14,
    color: palette.text2,
    lineHeight: 22,
  },
});
