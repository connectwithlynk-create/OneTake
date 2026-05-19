import { Ionicons } from '@expo/vector-icons';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClipVideo } from '@/components/clip-video';
import { MediaTile, MEDIA_COLUMNS } from '@/components/media-tile';
import { AppText, Button } from '@/components/ui';
import { relativeAge } from '@/lib/time';
import { persistClip } from '@/lib/filestore';
import { id } from '@/lib/id';
import { rateClip } from '@/lib/rating';
import { classifySpeech } from '@/lib/speech';
import { maybeTranscribe } from '@/lib/transcribe';
import { addClip, deleteClip, listClips, setVerdict } from '@/lib/repo';
import { invalidate } from '@/lib/store';
import { palette, radius, space, verdictColor } from '@/theme';
import type { Clip } from '@/lib/types';

export default function CaptureScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const router = useRouter();
  const cam = useRef<CameraView>(null);
  const startedAt = useRef(0);

  const [camPerm, reqCam] = useCameraPermissions();
  const [micPerm, reqMic] = useMicrophonePermissions();

  // Best-effort speech meter that runs alongside the camera recording so
  // talking vs b-roll is detected from real audio, not just the lens.
  const meterSamples = useRef<number[]>([]);
  const meterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorder = useAudioRecorder({
    ...RecordingPresets.LOW_QUALITY,
    isMeteringEnabled: true,
  });

  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [last, setLast] = useState<Clip | null>(null);
  const [taken, setTaken] = useState<Clip[] | null>(null); // non-null = sheet open

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

    // Start the speech meter alongside the camera. Best-effort: if the
    // audio session can't host a second recorder, we skip it and fall back
    // to the lens heuristic - recording itself is never blocked.
    meterSamples.current = [];
    let meterOn = false;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (perm.granted) {
        await setAudioModeAsync({ allowsRecording: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        meterTimer.current = setInterval(() => {
          try {
            const m = recorder.getStatus().metering;
            if (typeof m === 'number') meterSamples.current.push(m);
          } catch {
            /* ignore a bad sample */
          }
        }, 200);
        meterOn = true;
      }
    } catch {
      meterOn = false;
    }

    const stopMeter = async (): Promise<boolean | undefined> => {
      if (meterTimer.current) {
        clearInterval(meterTimer.current);
        meterTimer.current = null;
      }
      if (!meterOn) return undefined;
      try {
        await recorder.stop();
      } catch {
        /* ignore */
      }
      return classifySpeech(meterSamples.current);
    };

    try {
      const video = await cam.current.recordAsync({ maxDuration: 60 });
      const durationMs = Date.now() - startedAt.current;
      setRecording(false);
      const hasSpeech = await stopMeter();
      if (!video?.uri) return;
      const clipId = id();
      const uri = persistClip(video.uri, clipId);
      // Talking vs b-roll: real speech signal wins, lens is the fallback.
      const rating = rateClip({
        clipId,
        durationMs,
        source: 'recorded',
        facing,
        hasSpeech,
      });
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
      // Background: server transcript -> real tag + spoken-words title.
      void maybeTranscribe(clip.id);
    } catch {
      setRecording(false);
      await stopMeter();
    }
  }

  function stop() {
    cam.current?.stopRecording();
  }

  // Dud => discard and let them shoot the take again.
  async function markDud() {
    if (!last) return;
    await deleteClip(last.id, last.file_uri);
    invalidate();
    setCount((c) => Math.max(0, c - 1));
    setLast(null);
  }

  // Keep / Perfect => record it, move to the next take.
  async function keepAs(v: 'keep' | 'perfect') {
    if (!last) return;
    await setVerdict(last.id, v);
    invalidate();
    setLast(null);
  }

  async function openTaken() {
    const clips = await listClips(projectId);
    setTaken(clips);
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
        <Pressable style={styles.counter} onPress={openTaken}>
          <Ionicons name="film" size={14} color="#fff" />
          <AppText kind="caption" style={{ color: '#fff' }}>
            {count} CLIP{count === 1 ? '' : 'S'}
          </AppText>
        </Pressable>
        <Pressable
          style={styles.round}
          onPress={() => setFacing((f) => (f === 'front' ? 'back' : 'front'))}
        >
          <Ionicons name="camera-reverse" size={22} color="#fff" />
        </Pressable>
      </SafeAreaView>

      {/* post-record review: small preview + 3 calls */}
      {last && (
        <View style={styles.reviewWrap}>
          <ClipVideo uri={last.file_uri} autoplay style={styles.preview} />
          <AppText kind="dim" style={{ marginVertical: space.lg }}>
            How was that take?
          </AppText>
          <View style={styles.judgeRow}>
            <View style={{ flex: 1 }}>
              <Button label="Dud" tone="danger" icon="refresh" onPress={markDud} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Keep" tone="blue" onPress={() => keepAs('keep')} />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label="Perfect"
                tone="accent"
                onPress={() => keepAs('perfect')}
              />
            </View>
          </View>
          <AppText kind="caption" style={{ marginTop: space.md, color: '#9a9db3' }}>
            DUD RE-SHOOTS · KEEP/PERFECT MOVES ON
          </AppText>
        </View>
      )}

      {/* taken-clips sheet */}
      {taken && (
        <View style={styles.sheetWrap}>
          <SafeAreaView edges={['top']} style={{ flex: 1 }}>
            <View style={styles.sheetHead}>
              <AppText kind="subtitle" style={{ color: '#fff' }}>
                Clips so far
              </AppText>
              <Pressable style={styles.round} onPress={() => setTaken(null)}>
                <Ionicons name="close" size={22} color="#fff" />
              </Pressable>
            </View>
            {taken.length === 0 ? (
              <AppText kind="dim" style={{ padding: space.xl }}>
                No clips yet. Hit record.
              </AppText>
            ) : (
              <FlatList
                data={taken}
                keyExtractor={(c) => c.id}
                numColumns={MEDIA_COLUMNS}
                columnWrapperStyle={{ gap: space.md }}
                contentContainerStyle={{ gap: space.md, padding: space.lg }}
                renderItem={({ item }) => (
                  <MediaTile
                    uri={item.file_uri}
                    title={item.name ?? 'Clip'}
                    date={relativeAge(item.created_at)}
                    accent={verdictColor[item.verdict]}
                    onPress={() =>
                      router.push({
                        pathname: '/player',
                        params: {
                          id: item.id,
                          uri: item.file_uri,
                          title: item.name ?? 'Clip',
                        },
                      })
                    }
                  />
                )}
              />
            )}
          </SafeAreaView>
        </View>
      )}

      {/* record control */}
      {!last && !taken && (
        <SafeAreaView edges={['bottom']} style={styles.bottom}>
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  reviewWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    backgroundColor: 'rgba(0,0,0,0.78)',
  },
  preview: {
    width: '64%',
    aspectRatio: 9 / 16,
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  judgeRow: { flexDirection: 'row', gap: space.sm, alignSelf: 'stretch' },
  sheetWrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,6,20,0.96)',
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: space.lg },
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
