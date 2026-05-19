import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui';
import { resolveClipUri } from '@/lib/filestore';
import { getClip, setTag } from '@/lib/repo';
import { palette, radius, space, tagColor } from '@/theme';
import type { ClipTag } from '@/lib/types';

function mmss(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60)
    .toString()
    .padStart(2, '0')}`;
}

/** Custom in-app clip viewer: contained (not fullscreen), no Apple native
 *  controls. Our own play/pause + draggable scrubber. */
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
  const [scrub, setScrub] = useState<number | null>(null); // 0..1 while dragging
  const [transcript, setTranscript] = useState<string | null>(null);
  const [showTx, setShowTx] = useState(false);
  const [tag, setTagState] = useState<ClipTag | null>(null);

  // Load the clip's transcript + current tag (only when opened with an id).
  useEffect(() => {
    let alive = true;
    if (!id) {
      setTranscript(null);
      setTagState(null);
      return;
    }
    getClip(id)
      .then((c) => {
        if (!alive) return;
        setTranscript(c?.transcript?.trim() || null);
        setTagState(c?.tag ?? null);
      })
      .catch(() => {
        if (alive) {
          setTranscript(null);
          setTagState(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);

  async function flipTag() {
    if (!id || !tag) return;
    const next: ClipTag = tag === 'talking' ? 'broll' : 'talking';
    const prev = tag;
    setTagState(next); // optimistic
    try {
      await setTag(id, next);
    } catch {
      setTagState(prev); // revert
    }
  }

  // Poll the player's synchronous props (avoids event-name guesswork).
  useEffect(() => {
    const t = setInterval(() => {
      try {
        setPlaying(player.playing);
        setCur(player.currentTime ?? 0);
        setDur(player.duration ?? 0);
      } catch {
        /* player not ready */
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
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable style={styles.iconBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-down" size={22} color={palette.text} />
        </Pressable>
        <AppText kind="subtitle" numberOfLines={1} style={{ flex: 1 }}>
          {title ?? 'Clip'}
        </AppText>
        {tag && (
          <Pressable
            style={[styles.tagPill, { borderColor: tagColor[tag] }]}
            onPress={flipTag}
            hitSlop={6}
          >
            <AppText
              kind="caption"
              style={[styles.tagPillText, { color: tagColor[tag] }]}
            >
              {tag === 'talking' ? 'TALKING' : 'B-ROLL'}
            </AppText>
          </Pressable>
        )}
        <Pressable style={styles.iconBtn} onPress={toggleMute}>
          <Ionicons
            name={muted ? 'volume-mute' : 'volume-high'}
            size={20}
            color={palette.text}
          />
        </Pressable>
      </View>

      <Pressable style={styles.stage} onPress={toggle}>
        {uri ? (
          <View style={styles.frame}>
            <VideoView
              player={player}
              style={StyleSheet.absoluteFill}
              nativeControls={false}
              contentFit="contain"
            />
            {!playing && (
              <View style={styles.playOverlay} pointerEvents="none">
                <View style={styles.bigPlay}>
                  <Ionicons name="play" size={30} color={palette.onBright} />
                </View>
              </View>
            )}

            {playing && transcript && (
              <Pressable
                style={styles.txBtn}
                onPress={() => setShowTx((v) => !v)}
                hitSlop={8}
              >
                <Ionicons
                  name={showTx ? 'close' : 'document-text'}
                  size={16}
                  color="#fff"
                />
              </Pressable>
            )}

            {playing && transcript && showTx && (
              <View style={styles.txPanel}>
                <AppText kind="caption" style={styles.txLabel}>
                  TRANSCRIPT
                </AppText>
                <ScrollView
                  style={{ flex: 1 }}
                  showsVerticalScrollIndicator={false}
                >
                  <AppText kind="body" style={styles.txText}>
                    {transcript}
                  </AppText>
                </ScrollView>
              </View>
            )}
          </View>
        ) : (
          <AppText kind="dim">Clip unavailable.</AppText>
        )}
      </Pressable>

      <View style={styles.controls}>
        <Pressable style={styles.playBtn} onPress={toggle}>
          <Ionicons
            name={playing ? 'pause' : 'play'}
            size={22}
            color={palette.onBright}
          />
        </Pressable>

        <View style={{ flex: 1, gap: 6 }}>
          <View
            style={styles.track}
            onLayout={(e: LayoutChangeEvent) => {
              trackW.current = e.nativeEvent.layout.width;
            }}
            {...pan.panHandlers}
          >
            <View style={styles.trackBg} />
            <View style={[styles.fill, { width: `${progress * 100}%` }]} />
            <View style={[styles.thumb, { left: `${progress * 100}%` }]} />
          </View>
          <View style={styles.times}>
            <AppText kind="caption" style={{ color: palette.textDim }}>
              {mmss(scrub != null ? scrub * dur : cur)}
            </AppText>
            <AppText kind="caption" style={{ color: palette.textDim }}>
              {mmss(dur)}
            </AppText>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: palette.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagPill: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  tagPillText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  frame: {
    width: '100%',
    aspectRatio: 9 / 16,
    maxHeight: '100%',
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: palette.border,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigPlay: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: palette.purple,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txBtn: {
    position: 'absolute',
    bottom: 10,
    left: 10,
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
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.lg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  txLabel: {
    color: palette.textDim,
    letterSpacing: 1,
    marginBottom: space.sm,
  },
  txText: { color: '#fff', lineHeight: 22 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  playBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: palette.purple,
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: {
    height: 24,
    justifyContent: 'center',
  },
  trackBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.surfaceHi,
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.purple,
  },
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    backgroundColor: palette.text,
  },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
});
