import { Ionicons } from '@expo/vector-icons';
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Button, Chip } from '@/components/ui';
import { persistClip } from '@/lib/filestore';
import { id } from '@/lib/id';
import { rateClip } from '@/lib/rating';
import { addClip, deleteClip, setTag, setVerdict } from '@/lib/repo';
import { invalidate } from '@/lib/store';
import { palette, radius, space, tagColor, verdictColor } from '@/theme';
import type { Clip, ClipTag, Verdict } from '@/lib/types';

const VERDICTS: Verdict[] = ['dud', 'keep', 'perfect'];

export default function CaptureScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const router = useRouter();
  const cam = useRef<CameraView>(null);
  const startedAt = useRef(0);

  const [camPerm, reqCam] = useCameraPermissions();
  const [micPerm, reqMic] = useMicrophonePermissions();

  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [defaultTag, setDefaultTag] = useState<ClipTag>('talking');
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [last, setLast] = useState<Clip | null>(null);

  const ready = camPerm?.granted && micPerm?.granted;

  if (!camPerm || !micPerm) return <View style={styles.black} />;

  if (!ready) {
    return (
      <SafeAreaView style={[styles.black, styles.center]}>
        <Ionicons name="videocam-off" size={48} color={palette.purple} />
        <AppText kind="subtitle" style={{ marginTop: space.lg, textAlign: 'center' }}>
          Camera and mic access needed
        </AppText>
        <AppText kind="dim" style={{ textAlign: 'center', marginVertical: space.md }}>
          OneTake records your takes locally on device.
        </AppText>
        <Button
          label="Grant access"
          onPress={async () => {
            if (!camPerm.granted) await reqCam();
            if (!micPerm.granted) await reqMic();
          }}
        />
        <View style={{ height: space.md }} />
        <Button label="Back" tone="ghost" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  async function record() {
    if (!cam.current || recording) return;
    setLast(null);
    setRecording(true);
    startedAt.current = Date.now();
    try {
      const video = await cam.current.recordAsync({ maxDuration: 60 });
      const durationMs = Date.now() - startedAt.current;
      setRecording(false);
      if (!video?.uri) return;
      const clipId = id();
      const uri = persistClip(video.uri, clipId);
      const rating = rateClip({ clipId, durationMs, defaultTag });
      const clip = await addClip(
        projectId,
        uri,
        durationMs,
        rating.verdict,
        rating.tag,
        clipId
      );
      invalidate();
      setCount((c) => c + 1);
      setLast(clip);
    } catch {
      setRecording(false);
    }
  }

  function stop() {
    cam.current?.stopRecording();
  }

  async function retake() {
    if (last) {
      await deleteClip(last.id, last.file_uri);
      invalidate();
      setCount((c) => Math.max(0, c - 1));
    }
    setLast(null);
  }

  async function changeVerdict(v: Verdict) {
    if (!last) return;
    await setVerdict(last.id, v);
    invalidate();
    setLast({ ...last, verdict: v });
  }
  async function changeTag(t: ClipTag) {
    if (!last) return;
    await setTag(last.id, t);
    invalidate();
    setLast({ ...last, tag: t });
  }

  return (
    <View style={styles.black}>
      <CameraView
        ref={cam}
        style={StyleSheet.absoluteFill}
        mode="video"
        facing={facing}
        videoQuality="1080p"
      />

      {/* top bar */}
      <SafeAreaView edges={['top']} style={styles.topBar}>
        <Pressable style={styles.round} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </Pressable>
        <View style={styles.counter}>
          <AppText kind="caption" style={{ color: '#fff' }}>
            {count} CLIP{count === 1 ? '' : 'S'}
          </AppText>
        </View>
        <Pressable
          style={styles.round}
          onPress={() => setFacing((f) => (f === 'front' ? 'back' : 'front'))}
        >
          <Ionicons name="camera-reverse" size={22} color="#fff" />
        </Pressable>
      </SafeAreaView>

      {/* verdict overlay */}
      {last && (
        <View style={styles.verdictWrap}>
          <View
            style={[
              styles.verdictCard,
              { borderColor: verdictColor[last.verdict] },
            ]}
          >
            <AppText
              kind="hero"
              style={{ color: verdictColor[last.verdict], textAlign: 'center' }}
            >
              {last.verdict.toUpperCase()}
            </AppText>
            <AppText kind="dim" style={{ textAlign: 'center', marginBottom: space.md }}>
              Tap to fix the call or the tag
            </AppText>
            <View style={styles.chipRow}>
              {VERDICTS.map((v) => (
                <Chip
                  key={v}
                  label={v}
                  color={verdictColor[v]}
                  active={last.verdict === v}
                  onPress={() => changeVerdict(v)}
                />
              ))}
            </View>
            <View style={[styles.chipRow, { marginTop: space.sm }]}>
              <Chip
                label="Talking"
                color={tagColor.talking}
                active={last.tag === 'talking'}
                onPress={() => changeTag('talking')}
              />
              <Chip
                label="B-roll"
                color={tagColor.broll}
                active={last.tag === 'broll'}
                onPress={() => changeTag('broll')}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.lg }}>
              <View style={{ flex: 1 }}>
                <Button label="Retake" tone="ghost" onPress={retake} />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="Keep going" onPress={() => setLast(null)} />
              </View>
            </View>
          </View>
        </View>
      )}

      {/* bottom controls */}
      {!last && (
        <SafeAreaView edges={['bottom']} style={styles.bottom}>
          <View style={styles.tagToggle}>
            <Chip
              label="Talking"
              color={tagColor.talking}
              active={defaultTag === 'talking'}
              onPress={() => setDefaultTag('talking')}
            />
            <Chip
              label="B-roll"
              color={tagColor.broll}
              active={defaultTag === 'broll'}
              onPress={() => setDefaultTag('broll')}
            />
          </View>
          <View style={styles.recRow}>
            <View style={{ width: 56 }} />
            <Pressable onPress={recording ? stop : record} style={styles.recOuter}>
              <View
                style={[
                  styles.recInner,
                  recording
                    ? { borderRadius: 8, width: 32, height: 32 }
                    : { borderRadius: 28, width: 56, height: 56 },
                ]}
              />
            </Pressable>
            <Pressable style={styles.done} onPress={() => router.back()}>
              <AppText kind="caption" style={{ color: '#fff' }}>
                DONE
              </AppText>
            </Pressable>
          </View>
        </SafeAreaView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  black: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  counter: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  verdictWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  verdictCard: {
    width: '100%',
    backgroundColor: palette.surface,
    borderRadius: radius.xl,
    borderWidth: 2,
    padding: space.xl,
  },
  chipRow: { flexDirection: 'row', gap: space.sm, justifyContent: 'center', flexWrap: 'wrap' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: space.lg },
  tagToggle: {
    flexDirection: 'row',
    gap: space.sm,
    justifyContent: 'center',
    marginBottom: space.lg,
  },
  recRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xxl,
  },
  recOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recInner: { backgroundColor: palette.red },
  done: {
    width: 56,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
