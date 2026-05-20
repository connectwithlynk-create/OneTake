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
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClipVideo } from '@/components/clip-video';
import { Button, MonoLabel } from '@/components/ui';
import { persistClip } from '@/lib/filestore';
import { id } from '@/lib/id';
import { rateClip } from '@/lib/rating';
import { addClip, createProject, listProjects } from '@/lib/repo';
import { classifySpeech } from '@/lib/speech';
import { invalidate, useData } from '@/lib/store';
import { relativeAge } from '@/lib/time';
import { maybeTranscribe } from '@/lib/transcribe';
import { font, palette } from '@/theme';

interface Pending {
  tempUri: string;
  durationMs: number;
  hasSpeech: boolean | undefined;
  facing: 'front' | 'back';
}

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
        <View style={styles.permIcon}>
          <Ionicons name="videocam-off" size={32} color={palette.lime} />
        </View>
        <Text style={styles.permTitle}>Camera and mic access needed</Text>
        <Text style={styles.permBody}>
          OneTake opens to the camera. Grant access to shoot.
        </Text>
        <Button
          label="Grant access"
          icon="checkmark"
          full
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
          <Ionicons name="camera-reverse" size={20} color="#fff" />
        </Pressable>
      </SafeAreaView>

      {!pending && !recording && (
        <View style={styles.hintWrap} pointerEvents="none">
          <View style={styles.hint}>
            <Text style={styles.hintText}>HOLD TO RECORD · TAP FOR FILE</Text>
          </View>
        </View>
      )}

      {!pending && (
        <View style={styles.recWrap}>
          <View style={{ width: 44 }} />
          <Pressable
            onPress={recording ? stop : record}
            style={[styles.recOuter, recording && styles.recOuterActive]}
          >
            <View
              style={[
                styles.recInner,
                recording && { borderRadius: 6, width: 28, height: 28 },
              ]}
            />
          </Pressable>
          <View style={styles.counter}>
            <Text style={styles.counterText}>3</Text>
          </View>
        </View>
      )}

      {pending && (
        <View style={styles.sheet}>
          <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
            <View style={styles.sheetHead}>
              <Pressable style={styles.headBtn} onPress={discard} hitSlop={6}>
                <Ionicons name="close" size={16} color="#fff" />
              </Pressable>
              <Text style={styles.sheetTitle}>Save to</Text>
              <View style={{ width: 40 }} />
            </View>

            <View style={styles.previewWrap}>
              <View style={styles.previewFrame}>
                <ClipVideo
                  uri={pending.tempUri}
                  autoplay
                  style={styles.preview}
                />
              </View>
            </View>

            <View style={styles.actionsRow}>
              <Button
                label="New project"
                icon="add"
                full
                disabled={saving}
                onPress={saveToNew}
              />
            </View>

            <View style={{ paddingHorizontal: 18, paddingBottom: 10 }}>
              <MonoLabel>EXISTING PROJECTS</MonoLabel>
            </View>

            {projects && projects.length > 0 ? (
              <FlatList
                data={projects}
                keyExtractor={(p) => p.id}
                contentContainerStyle={{
                  gap: 8,
                  paddingHorizontal: 14,
                  paddingBottom: 16,
                }}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.projectRow}
                    onPress={() => saveTo(item.id)}
                    disabled={saving}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={styles.rowMeta}>
                        {item.type === 'prompt' ? 'Prompt' : 'Talking-head'} ·{' '}
                        {relativeAge(item.created_at)}
                      </Text>
                    </View>
                    <Ionicons
                      name="arrow-forward"
                      size={18}
                      color={palette.lime}
                    />
                  </Pressable>
                )}
              />
            ) : (
              <ScrollView contentContainerStyle={{ padding: 20, alignItems: 'center' }}>
                <Text style={styles.empty}>
                  No projects yet. Tap &quot;New project&quot; above to save this clip
                  into a fresh one.
                </Text>
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
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(8,8,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hintWrap: {
    position: 'absolute',
    top: '46%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  hint: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(8,8,15,0.6)',
    borderWidth: 1,
    borderColor: `${palette.lime}55`,
  },
  hintText: {
    color: palette.lime,
    fontFamily: font.monoBold,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
  },
  recWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 30,
    paddingHorizontal: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recOuter: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: palette.lime,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 5,
    borderColor: 'rgba(8,8,15,0.6)',
    shadowColor: palette.lime,
    shadowOpacity: 0.7,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  recOuterActive: {
    backgroundColor: palette.coral,
    shadowColor: palette.coral,
  },
  recInner: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: palette.onBright,
  },
  counter: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(8,8,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  counterText: {
    color: '#fff',
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 12,
  },
  sheet: {
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
  headBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: {
    color: '#fff',
    fontFamily: font.displayHeavy,
    fontWeight: '700',
    fontSize: 18,
  },
  previewWrap: { alignItems: 'center', paddingVertical: 16 },
  previewFrame: {
    width: '46%',
    aspectRatio: 9 / 16,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  preview: { width: '100%', height: '100%' },
  actionsRow: { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 18 },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: palette.bg1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  rowTitle: { color: '#fff', fontFamily: font.bodyBold, fontSize: 14, fontWeight: '600' },
  rowMeta: { color: palette.text3, fontFamily: font.body, fontSize: 11, marginTop: 2 },
  empty: { color: palette.text2, fontFamily: font.body, textAlign: 'center' },
});
