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
import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClipVideo } from '@/components/clip-video';
import { MediaTile, MEDIA_COLUMNS } from '@/components/media-tile';
import { Button, MonoLabel, TagPill } from '@/components/ui';
import { persistClip } from '@/lib/filestore';
import { id } from '@/lib/id';
import { rateClip } from '@/lib/rating';
import { addClip, deleteClip, getProject, listClips, setVerdict } from '@/lib/repo';
import { classifySpeech } from '@/lib/speech';
import { invalidate } from '@/lib/store';
import { relativeAge } from '@/lib/time';
import { maybeTranscribe } from '@/lib/transcribe';
import type { Clip, Project } from '@/lib/types';
import { font, palette, verdictColor } from '@/theme';

export default function CaptureScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const router = useRouter();
  const cam = useRef<CameraView>(null);
  const startedAt = useRef(0);

  const [camPerm, reqCam] = useCameraPermissions();
  const [micPerm, reqMic] = useMicrophonePermissions();

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
  const [taken, setTaken] = useState<Clip[] | null>(null);
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    getProject(projectId).then(setProject).catch(() => {});
  }, [projectId]);

  const ready = camPerm?.granted && micPerm?.granted;

  if (!camPerm || !micPerm) return <View style={styles.black} />;

  if (!ready) {
    return (
      <SafeAreaView style={[styles.black, styles.center]}>
        <View style={styles.permIcon}>
          <Ionicons name="videocam-off" size={32} color={palette.lime} />
        </View>
        <Text style={styles.permTitle}>Camera and mic access needed</Text>
        <Text style={styles.permBody}>OneTake records your takes locally on device.</Text>
        <Button
          label="Grant access"
          full
          icon="checkmark"
          onPress={async () => {
            if (!camPerm.granted) await reqCam();
            if (!micPerm.granted) await reqMic();
          }}
        />
        <View style={{ height: 12 }} />
        <Button label="Back" tone="ghost" full onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  async function record() {
    if (!cam.current || recording) return;
    setLast(null);
    setRecording(true);
    startedAt.current = Date.now();

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
            /* ignore */
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
      void maybeTranscribe(clip.id);
    } catch {
      setRecording(false);
      await stopMeter();
    }
  }

  function stop() {
    cam.current?.stopRecording();
  }

  async function markDud() {
    if (!last) return;
    await deleteClip(last.id, last.file_uri);
    invalidate();
    setCount((c) => Math.max(0, c - 1));
    setLast(null);
  }

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

  const takeNumber = count;

  return (
    <View style={styles.black}>
      <CameraView
        ref={cam}
        style={StyleSheet.absoluteFill}
        mode="video"
        facing={facing}
        videoQuality="1080p"
      />

      <SafeAreaView edges={['top']} style={styles.topBar}>
        <Pressable style={styles.round} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={18} color="#fff" />
        </Pressable>
        <Pressable style={styles.counter} onPress={openTaken}>
          <Ionicons name="film" size={13} color="#fff" />
          <Text style={styles.counterText}>
            {count} CLIP{count === 1 ? '' : 'S'}
          </Text>
        </Pressable>
        <Pressable
          style={styles.round}
          onPress={() => setFacing((f) => (f === 'front' ? 'back' : 'front'))}
        >
          <Ionicons name="camera-reverse" size={18} color="#fff" />
        </Pressable>
      </SafeAreaView>

      {project ? (
        <View style={styles.projectChipWrap} pointerEvents="none">
          <View style={styles.projectChip}>
            <Text style={styles.projectChipText} numberOfLines={1}>
              {project.title}
            </Text>
          </View>
        </View>
      ) : null}

      {last && (
        <View style={styles.reviewWrap}>
          <View style={styles.reviewHeader}>
            <MonoLabel color={palette.lime}>
              TAKE {String(takeNumber).padStart(2, '0')} ·{' '}
              {formatDuration(last.duration_ms)}
            </MonoLabel>
            <Text style={styles.reviewTitle}>How was that take?</Text>
          </View>

          <View style={styles.reviewPreviewWrap}>
            <View style={styles.reviewPreviewFrame}>
              <ClipVideo uri={last.file_uri} autoplay style={styles.preview} />
              <View style={styles.reviewTag}>
                <TagPill t={last.tag} />
              </View>
            </View>
          </View>

          <View style={styles.aiHint}>
            <Ionicons name="sparkles" size={11} color={palette.cyan} />
            <Text style={styles.aiHintText}>
              AI SAYS · {last.verdict.toUpperCase()}
            </Text>
          </View>

          <View style={styles.judgeRow}>
            <VerdictButton
              label="Dud"
              sub="Re-shoot"
              color={palette.coral}
              active={false}
              onPress={markDud}
            />
            <VerdictButton
              label="Keep"
              sub="Usable"
              color={palette.cyan}
              active={last.verdict === 'keep'}
              onPress={() => keepAs('keep')}
            />
            <VerdictButton
              label="Perfect"
              sub="Star it"
              color={palette.lime}
              active={last.verdict === 'perfect'}
              onPress={() => keepAs('perfect')}
            />
          </View>

          <Text style={styles.helperText}>
            DUD RE-SHOOTS · KEEP / PERFECT MOVE ON
          </Text>
        </View>
      )}

      {taken && (
        <View style={styles.sheetWrap}>
          <SafeAreaView edges={['top']} style={{ flex: 1 }}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Clips so far</Text>
              <Pressable style={styles.round} onPress={() => setTaken(null)}>
                <Ionicons name="close" size={18} color="#fff" />
              </Pressable>
            </View>
            {taken.length === 0 ? (
              <Text style={styles.sheetEmpty}>No clips yet. Hit record.</Text>
            ) : (
              <FlatList
                data={taken}
                keyExtractor={(c) => c.id}
                numColumns={MEDIA_COLUMNS}
                columnWrapperStyle={{ gap: 10 }}
                contentContainerStyle={{ gap: 10, padding: 16 }}
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

      {!last && !taken && (
        <SafeAreaView edges={['bottom']} style={styles.bottom}>
          <View style={styles.recRow}>
            <View style={{ width: 56 }} />
            <Pressable
              onPress={recording ? stop : record}
              style={styles.recOuter}
            >
              <View
                style={[
                  styles.recInner,
                  recording
                    ? { borderRadius: 6, width: 28, height: 28 }
                    : null,
                ]}
              />
            </Pressable>
            <Pressable style={styles.done} onPress={() => router.back()}>
              <Text style={styles.doneText}>DONE</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      )}
    </View>
  );
}

function VerdictButton({
  label,
  sub,
  color,
  active,
  onPress,
}: {
  label: string;
  sub: string;
  color: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.verdictBtn,
        {
          backgroundColor: active ? color : `${color}14`,
          borderColor: active ? color : `${color}55`,
          shadowColor: active ? color : 'transparent',
          shadowOpacity: active ? 0.5 : 0,
          shadowRadius: 18,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        style={{
          fontFamily: font.displayHeavy,
          fontWeight: '800',
          fontSize: 17,
          color: active ? palette.onBright : color,
          letterSpacing: -0.3,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontFamily: font.body,
          fontSize: 10.5,
          marginTop: 2,
          fontWeight: '600',
          color: active ? palette.onBright : color,
          opacity: 0.7,
        }}
      >
        {sub}
      </Text>
    </Pressable>
  );
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  black: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    backgroundColor: palette.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  permIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: `${palette.lime}22`,
    borderWidth: 1,
    borderColor: `${palette.lime}55`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  permTitle: {
    fontFamily: font.displayHeavy,
    fontSize: 22,
    color: '#fff',
    textAlign: 'center',
    letterSpacing: -0.4,
  },
  permBody: {
    fontFamily: font.body,
    fontSize: 14,
    color: palette.text2,
    textAlign: 'center',
    marginBottom: 16,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  round: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(8,8,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  counter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(8,8,15,0.55)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  counterText: {
    color: '#fff',
    fontFamily: font.monoBold,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  projectChipWrap: {
    position: 'absolute',
    top: 116,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  projectChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(8,8,15,0.55)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  projectChipText: {
    color: '#fff',
    fontFamily: font.bodyBold,
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 220,
  },
  reviewWrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,6,20,0.92)',
    paddingTop: 60,
    paddingHorizontal: 0,
  },
  reviewHeader: { paddingHorizontal: 22, paddingTop: 30, alignItems: 'center' },
  reviewTitle: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 28,
    color: '#fff',
    marginTop: 8,
    letterSpacing: -0.5,
  },
  reviewPreviewWrap: { alignItems: 'center', paddingVertical: 18 },
  reviewPreviewFrame: {
    width: 200,
    aspectRatio: 9 / 16,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: '#000',
  },
  preview: { width: '100%', height: '100%' },
  reviewTag: { position: 'absolute', top: 10, left: 10 },
  aiHint: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: `${palette.cyan}10`,
    borderWidth: 1,
    borderColor: `${palette.cyan}55`,
    marginBottom: 14,
  },
  aiHintText: {
    fontFamily: font.monoBold,
    fontSize: 10,
    color: palette.cyan,
    fontWeight: '700',
    letterSpacing: 1,
  },
  judgeRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 18,
  },
  verdictBtn: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderRadius: 18,
    borderWidth: 1.5,
    alignItems: 'center',
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
  },
  helperText: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontFamily: font.monoBold,
    fontSize: 10,
    color: palette.text3,
    letterSpacing: 1.5,
  },
  sheetWrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,6,20,0.97)',
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  sheetTitle: {
    color: '#fff',
    fontFamily: font.displayHeavy,
    fontWeight: '700',
    fontSize: 18,
  },
  sheetEmpty: {
    padding: 24,
    fontFamily: font.body,
    color: palette.text2,
  },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: 16 },
  recRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 38,
  },
  recOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
  recInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: palette.coral,
  },
  done: {
    width: 56,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(8,8,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: {
    color: '#fff',
    fontFamily: font.monoBold,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
