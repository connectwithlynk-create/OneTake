import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { TextInput } from 'react-native';

import { AppText, Button, Header, Screen } from '@/components/ui';
import { createProject, setProjectStatus } from '@/lib/repo';
import { invalidate } from '@/lib/store';
import { palette, radius, space } from '@/theme';

export default function PromptScreen() {
  const { title } = useLocalSearchParams<{ title?: string }>();
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (busy || text.trim().length < 4) return;
    setBusy(true);
    // The project is created here, on submit, not when "Prompt" was picked.
    const p = await createProject('prompt', title ?? '', text);
    await setProjectStatus(p.id, 'processing');
    invalidate();
    router.replace({
      pathname: '/preview/[projectId]',
      params: { projectId: p.id },
    });
  }

  return (
    <Screen scroll>
      <Header title="Describe it" back />
      <AppText kind="dim" style={{ marginBottom: space.lg }}>
        The video is assembled from footage already in your library. Be
        specific about vibe, length, and which clips to lean on.
      </AppText>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder="A punchy 30s intro about the launch using the office b-roll, energetic, fast cuts"
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
          minHeight: 160,
          textAlignVertical: 'top',
          marginBottom: space.xl,
        }}
      />
      <Button
        label="Generate video"
        tone="accent"
        icon="sparkles"
        disabled={text.trim().length < 4 || busy}
        onPress={generate}
      />
    </Screen>
  );
}
