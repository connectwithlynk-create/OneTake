import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { AppText, Button, Card, Header, Loading, Screen } from '@/components/ui';
import { getProject, listClips } from '@/lib/repo';
import { useData } from '@/lib/store';
import { palette, radius, space } from '@/theme';

const PIPELINE = [
  'Concatenate kept clips',
  'Transcribe (word timestamps)',
  'Cut silences + filler',
  'Match b-roll to transcript',
  'Burn captions',
  'Render vertical MP4',
];

export default function PreviewScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const router = useRouter();
  const { data: project } = useData(() => getProject(projectId), [projectId]);
  const { data: clips } = useData(() => listClips(projectId), [projectId]);

  if (!project) return <Screen><Loading /></Screen>;

  const keeps = (clips ?? []).filter((c) => c.verdict !== 'dud').length;

  return (
    <Screen scroll>
      <Header title="Auto-edit" back />

      <Card accent={palette.purple}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Ionicons name="sparkles" size={22} color={palette.purple} />
          <AppText kind="subtitle">The moat</AppText>
        </View>
        <AppText kind="dim" style={{ marginTop: space.sm }}>
          One-tap auto-edit is Phase 4 of the roadmap and is intentionally not
          built in this basic build. Everything that feeds it is here: capture,
          instant rating, tagging, and the library.
        </AppText>
      </Card>

      <View style={{ height: space.lg }} />

      <Card>
        <AppText kind="caption">READY TO HAND OFF</AppText>
        <AppText kind="title" style={{ marginTop: space.xs }}>
          {project.type === 'prompt'
            ? 'Prompt project'
            : `${keeps} keeper${keeps === 1 ? '' : 's'}`}
        </AppText>
        {project.type === 'prompt' && project.prompt ? (
          <AppText kind="dim" style={{ marginTop: space.sm }}>
            “{project.prompt}”
          </AppText>
        ) : null}
      </Card>

      <View style={{ height: space.lg }} />

      <AppText kind="caption" style={{ marginBottom: space.md }}>
        WHAT PHASE 4 WILL DO
      </AppText>
      {PIPELINE.map((step, i) => (
        <View
          key={step}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            backgroundColor: palette.surface,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: palette.border,
            padding: space.lg,
            marginBottom: space.sm,
          }}
        >
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: i === PIPELINE.length - 1 ? palette.purple : palette.surfaceHi,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <AppText
              kind="caption"
              style={{ color: i === PIPELINE.length - 1 ? palette.onBright : palette.textDim }}
            >
              {i + 1}
            </AppText>
          </View>
          <AppText kind="body">{step}</AppText>
        </View>
      ))}

      <View style={{ height: space.xl }} />
      <Button
        label="Back to projects"
        onPress={() => router.replace('/')}
      />
    </Screen>
  );
}
