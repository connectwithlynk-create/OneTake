import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppText, Card, Header, Screen } from '@/components/ui';
import { createProject } from '@/lib/repo';
import { invalidate } from '@/lib/store';
import { palette, radius, space } from '@/theme';
import type { ProjectType } from '@/lib/types';

export default function NewProjectScreen() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(type: ProjectType) {
    if (busy) return;
    setBusy(true);
    if (type === 'talkinghead') {
      // Talking-head needs a project up front to attach recorded clips to.
      const p = await createProject('talkinghead', title);
      invalidate();
      router.replace({ pathname: '/project/[id]', params: { id: p.id } });
    } else {
      // Prompt projects are created only when the prompt is submitted, so
      // backing out of the prompt screen leaves nothing behind.
      router.replace({ pathname: '/prompt', params: { title } });
    }
  }

  return (
    <Screen scroll>
      <Header title="New project" back />

      <AppText kind="caption" style={{ marginBottom: space.sm }}>
        PROJECT NAME
      </AppText>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="My next video"
        placeholderTextColor={palette.textFaint}
        style={{
          backgroundColor: palette.surface,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: palette.border,
          color: palette.text,
          fontSize: 16,
          fontWeight: '600',
          padding: space.lg,
          marginBottom: space.xl,
        }}
      />

      <AppText kind="caption" style={{ marginBottom: space.sm }}>
        PICK A MODE
      </AppText>

      <View style={{ gap: space.md }}>
        <Card accent={palette.purple} onPress={() => start('talkinghead')}>
          <Ionicons name="videocam" size={28} color={palette.purple} />
          <AppText kind="subtitle" style={{ marginTop: space.sm }}>
            Talking-head
          </AppText>
          <AppText kind="dim" style={{ marginTop: space.xs }}>
            Record takes, get an instant verdict on each, auto-tag talking vs
            b-roll, then finish to auto-edit.
          </AppText>
        </Card>

        <Card accent={palette.yellow} onPress={() => start('prompt')}>
          <Ionicons name="sparkles" size={28} color={palette.yellow} />
          <AppText kind="subtitle" style={{ marginTop: space.sm }}>
            Prompt
          </AppText>
          <AppText kind="dim" style={{ marginTop: space.xs }}>
            Describe the video. It is assembled from footage already in your
            library.
          </AppText>
        </Card>
      </View>
    </Screen>
  );
}
