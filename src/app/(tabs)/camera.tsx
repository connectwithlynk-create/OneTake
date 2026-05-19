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
import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClipVideo } from '@/components/clip-video';
import { AppText, Button } from '@/components/ui';
import { persistClip } from '@/lib/filestore';
import { id } from '@/lib/id';
import { rateClip } from '@/lib/rating';
import { addClip, createProject, listProjects } from '@/lib/repo';
import { classifySpeech } from '@/lib/speech';
import { invalidate, useData } from '@/lib/store';
import { relativeAge } from '@/lib/time';
import { maybeTranscribe } from '@/lib/transcribe';
import { palette, radius, space } from '@/theme';

interface Pending {
  tempUri: string;
  durationMs: number;
  hasSpeech: boolean | undefined;
  facing: 'front' | 'back';
}

/**
 * Snapchat-style opening view: full-screen camera, big record button,
 * post-record sheet to send the take into an existing or new project.
 */
export default function CameraTab() {
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

  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: projects } = useData(listProjects);

  const ready = camPerm?.granted && micPerm?.granted;

  if (!camPerm || !micPerm) return <View style={styles.black} />;

  if (!ready) {
    return (
      <SafeAreaView style={[styles.black, styles.center]}>
        <Ionicons name="videocam-off" size={48} color={palette.purple} />
        <AppText
          kind="subtitle"
          style={{ marginTop: space.lg, textAlign: 'center' }}
        >
          Camera and mic access needed
        </AppText>
        <AppText
          kind="dim"
          style={{ textAlign: 'center', marginVertical: space.md }}
        >
          OneTake opens to the camera. Grant access to shoot.
        </AppText>
        <Button
          label="Grant access"
          onPress={async () => {
            if (!camPerm.granted) await reqCam();
            if (!micPerm.granted) await reqMic();
          }}
        />
      </SafeAreaView>
    );
  }

  async function record() {
    if (!cam.current || recording) return;
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
      setPending({ tempUri: video.uri, durationMs, hasSpeech, facing });
    } catch {
      setRecording(false);
      await stopMeter();
    }
  }

  function stop() {
    cam.current?.stopRecording();
  }

  async function saveTo(projectId: string, navigateToProject = false) {
    if (!pending || saving) return;
    setSaving(true);
    try {
      const clipId = id();
      const uri = persistClip(pending.tempUri, clipId);
      const rating = rateClip({
        clipId,
        durationMs: pending.durationMs,
        source: 'recorded',
        facing: pending.facing,
        hasSpeech: pending.hasSpeech,
      });
      await addClip(
        projectId,
        uri,
        pending.durationMs,
        rating.verdict,
        rating.tag,
        clipId
      );
      invalidate();
      void maybeTranscribe(clipId);
      setPending(null);
      if (navigateToProject) {
        router.push({ pathname: '/project/[id]', params: { id: projectId } });
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveToNew() {
    if (!pending || saving) return;
    setSaving(true);
    try {
      const p = await createProject('talkinghead', 'Untitled');
      invalidate();
      await saveTo(p.id, true);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setPending(null);
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

      <SafeAreaView edges={['top']} style={styles.topBar}>
        <View style={{ flex: 1 }} />
        <Pressable
          style={styles.round}
          onPress={() => setFacing((f) => (f === 'front' ? 'back' : 'front'))}
        >
          <Ionicons name="camera-reverse" size={22} color="#fff" />
        </Pressable>
      </SafeAreaView>

      {!pending && (
        <View style={styles.recWrap}>
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
        </View>
      )}

      {pending && (
        <View style={styles.sheet}>
          <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
            <View style={styles.sheetHead}>
              <Pressable style={styles.round} onPress={discard} hitSlop={6}>
                <Ionicons name="close" size={22} color="#fff" />
              </Pressable>
              <AppText kind="subtitle" style={{ color: '#fff' }}>
                Save to
              </AppText>
              <View style={{ width: 44 }} />
            </View>

            <View style={styles.previewWrap}>
              <ClipVideo
                uri={pending.tempUri}
                autoplay
                style={styles.preview}
              />
            </View>

            <View style={styles.actionsRow}>
              <View style={{ flex: 1 }}>
                <Button
                  label="New project"
                  icon="add"
                  tone="accent"
                  disabled={saving}
                  onPress={saveToNew}
                />
              </View>
            </View>

            <AppText kind="caption" style={styles.listLabel}>
              EXISTING PROJECTS
            </AppText>

            {projects && projects.length > 0 ? (
              <FlatList
                data={projects}
                keyExtractor={(p) => p.id}
                contentContainerStyle={{
                  gap: space.sm,
                  paddingHorizontal: space.lg,
                  paddingBottom: space.lg,
                }}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.projectRow}
                    onPress={() => saveTo(item.id)}
                    disabled={saving}
                  >
                    <View style={{ flex: 1 }}>
                      <AppText kind="body" numberOfLines={1}>
                        {item.title}
                      </AppText>
                      <AppText kind="caption" style={{ color: palette.textFaint }}>
                        {item.type === 'prompt' ? 'Prompt' : 'Talking-head'} ·{' '}
                        {relativeAge(item.created_at)}
                      </AppText>
                    </View>
                    <Ionicons
                      name="arrow-forward"
                      size={20}
                      color={palette.purple}
                    />
                  </Pressable>
                )}
              />
            ) : (
              <ScrollView
                contentContainerStyle={{ padding: space.lg, alignItems: 'center' }}
              >
                <AppText kind="dim" style={{ textAlign: 'center' }}>
                  No projects yet. Tap “New project” above to save this clip
                  into a fresh one.
                </AppText>
              </ScrollView>
            )}
          </SafeAreaView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  black: { flex: 1, backgroundColor: '#000' },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
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
  recWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: space.lg,
    alignItems: 'center',
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
  sheet: {
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
  previewWrap: { alignItems: 'center', paddingHorizontal: space.xl },
  preview: {
    width: '52%',
    aspectRatio: 9 / 16,
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  actionsRow: {
    flexDirection: 'row',
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  listLabel: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
    color: palette.textFaint,
  },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    padding: space.md,
  },
});
