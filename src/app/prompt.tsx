import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Chip, Header, MonoLabel, Screen } from '@/components/ui';
import { createProject, setProjectStatus } from '@/lib/repo';
import { invalidate } from '@/lib/store';
import { font, palette } from '@/theme';

const QUICK_PROMPTS: { label: string; color: string }[] = [
  { label: '30s launch tease', color: palette.gold },
  { label: '15s hook', color: palette.magenta },
  { label: '60s explainer', color: palette.cyan },
  { label: 'Behind-the-scenes', color: palette.violet },
];

export default function PromptScreen() {
  const { title } = useLocalSearchParams<{ title?: string }>();
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (busy || text.trim().length < 4) return;
    setBusy(true);
    const p = await createProject('prompt', title ?? '', text);
    await setProjectStatus(p.id, 'processing');
    invalidate();
    router.replace({
      pathname: '/preview/[projectId]',
      params: { projectId: p.id },
    });
  }

  return (
    <Screen scroll pad={false}>
      <Header title="Describe it" back />

      <View style={{ paddingHorizontal: 22, paddingTop: 4, paddingBottom: 24 }}>
        <Text style={s.intro}>
          The video is assembled from footage already in your library. Be
          specific about vibe, length, and which clips to lean on.
        </Text>
      </View>

      <View style={{ paddingHorizontal: 22, paddingBottom: 18 }}>
        <MonoLabel style={{ marginBottom: 8 }}>YOUR PROMPT</MonoLabel>
        <View style={s.promptWrap}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder="A punchy 30s intro about the launch using the office b-roll, energetic, fast cuts"
            placeholderTextColor={palette.text3}
            style={s.promptField}
            autoFocus
          />
        </View>
        <View style={s.counterRow}>
          <Text style={s.counterMsg}>
            Prompt mode <Text style={{ color: palette.gold, fontFamily: font.bodyBold }}>SELECTS</Text>{' '}
            from your library — it doesn&apos;t generate footage.
          </Text>
          <Text style={s.counterCount}>{text.length} / 500</Text>
        </View>
      </View>

      <View style={{ paddingHorizontal: 22, paddingBottom: 16 }}>
        <MonoLabel style={{ marginBottom: 8 }}>QUICK PROMPTS</MonoLabel>
        <View style={s.quickRow}>
          {QUICK_PROMPTS.map((q) => (
            <Chip
              key={q.label}
              label={q.label}
              color={q.color}
              onPress={() => setText((t) => (t ? t + ' · ' + q.label : q.label))}
            />
          ))}
        </View>
      </View>

      <View style={{ paddingHorizontal: 22, paddingTop: 6, paddingBottom: 32 }}>
        <Button
          label="Generate video"
          tone="gold"
          icon="sparkles"
          size="lg"
          full
          disabled={text.trim().length < 4 || busy}
          onPress={generate}
        />
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  intro: {
    fontFamily: font.body,
    fontSize: 13.5,
    color: palette.text2,
    lineHeight: 20,
  },
  promptWrap: {
    padding: 4,
    borderRadius: 18,
    backgroundColor: `${palette.gold}10`,
    borderWidth: 1.5,
    borderColor: `${palette.gold}55`,
  },
  promptField: {
    padding: 14,
    minHeight: 160,
    textAlignVertical: 'top',
    color: '#fff',
    fontFamily: font.body,
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 22,
  },
  counterRow: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  counterMsg: {
    flex: 1,
    fontFamily: font.body,
    fontSize: 11,
    color: palette.text3,
  },
  counterCount: {
    fontFamily: font.mono,
    fontSize: 11,
    color: palette.text3,
  },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
