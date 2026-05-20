import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Button,
  Card,
  Header,
  Loading,
  MediaPlaceholder,
  MonoLabel,
  Screen,
  StatusPill,
  TagPill,
} from '@/components/ui';
import { getProject, listClips } from '@/lib/repo';
import { useData } from '@/lib/store';
import { fmtDuration } from '@/lib/time';
import { font, palette } from '@/theme';

const PIPELINE = [
  { t: 'Concatenate kept clips', done: true },
  { t: 'Transcribe (word timestamps)', done: true },
  { t: 'Cut silences + filler', done: true },
  { t: 'Match b-roll to transcript', done: true },
  { t: 'Burn captions', done: true },
  { t: 'Render vertical MP4', done: false, now: true },
];

export default function PreviewScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const router = useRouter();
  const { data: project } = useData(() => getProject(projectId), [projectId]);
  const { data: clips } = useData(() => listClips(projectId), [projectId]);

  if (!project) return <Screen><Loading /></Screen>;

  const keeps = (clips ?? []).filter((c) => c.verdict !== 'dud');
  const keepCount = keeps.length;
  const usableMs = keeps.reduce((sum, c) => sum + c.duration_ms, 0);
  const hasTalking = keeps.some((c) => c.tag === 'talking');
  const hasBroll = keeps.some((c) => c.tag === 'broll');

  return (
    <Screen scroll pad={false}>
      <Header title="Auto-edit" back />

      <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
        <View style={s.previewFrame}>
          <MediaPlaceholder
            variant="warm"
            label={`FINISHED · ${fmtDuration(usableMs)} · 1080×1920`}
          />
          <View style={s.previewCenter}>
            <View style={s.bigPlay}>
              <Ionicons name="play" size={20} color={palette.onBright} />
            </View>
          </View>
          <View style={s.captionWrap}>
            <View style={s.captionPill}>
              <Text style={s.captionText}>
                <Text>5AM </Text>
                <Text style={{ color: palette.lime }}>HIT</Text>
                <Text> DIFFERENT</Text>
              </Text>
            </View>
          </View>
          <View style={s.statusTopRight}>
            <StatusPill s="ready" />
          </View>
        </View>
      </View>

      <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
        <Card accent={palette.lime} padding={16}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <View>
              <MonoLabel color={palette.lime}>READY TO SHIP</MonoLabel>
              <Text style={s.cardHero}>
                {project.type === 'prompt'
                  ? 'Prompt project'
                  : `${keepCount} keeper${keepCount === 1 ? '' : 's'} · ${fmtDuration(usableMs)}`}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              {hasTalking ? <TagPill t="talking" /> : null}
              {hasBroll ? <TagPill t="broll" /> : null}
            </View>
          </View>
        </Card>
      </View>

      <View style={{ paddingHorizontal: 18, paddingBottom: 16 }}>
        <MonoLabel style={{ marginBottom: 10 }}>EDIT PIPELINE</MonoLabel>
        <View style={{ gap: 6 }}>
          {PIPELINE.map((step, i) => (
            <View key={step.t} style={s.stepRow}>
              <View
                style={[
                  s.stepBadge,
                  step.done
                    ? { backgroundColor: palette.lime }
                    : step.now
                    ? {
                        backgroundColor: `${palette.cyan}22`,
                        borderWidth: 1.5,
                        borderColor: palette.cyan,
                      }
                    : { backgroundColor: 'rgba(255,255,255,0.06)' },
                ]}
              >
                <Text
                  style={[
                    s.stepBadgeText,
                    {
                      color: step.done
                        ? palette.onBright
                        : step.now
                        ? palette.cyan
                        : palette.text3,
                    },
                  ]}
                >
                  {step.done ? '✓' : i + 1}
                </Text>
              </View>
              <Text
                style={[
                  s.stepText,
                  {
                    color: step.done
                      ? '#fff'
                      : step.now
                      ? palette.cyan
                      : palette.text3,
                  },
                ]}
              >
                {step.t}
              </Text>
              {step.now ? <Text style={s.renderingTag}>RENDERING…</Text> : null}
            </View>
          ))}
        </View>
      </View>

      <View
        style={{
          paddingHorizontal: 18,
          paddingTop: 8,
          paddingBottom: 32,
          flexDirection: 'row',
          gap: 10,
        }}
      >
        <View style={{ flex: 1 }}>
          <Button
            label="Restyle"
            tone="ghost"
            icon="refresh"
            full
            onPress={() => router.replace('/')}
          />
        </View>
        <View style={{ flex: 1.4 }}>
          <Button
            label="Export"
            icon="arrow-down"
            full
            onPress={() => router.replace('/')}
          />
        </View>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  previewFrame: {
    aspectRatio: 9 / 14,
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: `${palette.lime}55`,
    backgroundColor: '#000',
  },
  previewCenter: {
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
    shadowOpacity: 0.7,
    shadowRadius: 26,
  },
  captionWrap: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  captionPill: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
  },
  captionText: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 18,
    color: '#fff',
  },
  statusTopRight: { position: 'absolute', top: 12, right: 12 },
  cardHero: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 22,
    color: '#fff',
    marginTop: 4,
    letterSpacing: -0.5,
  },
  stepRow: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: palette.bg1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeText: {
    fontFamily: font.monoBold,
    fontWeight: '700',
    fontSize: 11,
  },
  stepText: {
    flex: 1,
    fontFamily: font.body,
    fontSize: 13.5,
    fontWeight: '500',
  },
  renderingTag: {
    fontFamily: font.monoBold,
    fontSize: 10,
    color: palette.cyan,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
