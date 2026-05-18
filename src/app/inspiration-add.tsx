import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { TextInput, View } from 'react-native';

import { AppText, Button, Chip, Header, Screen } from '@/components/ui';
import { addInspiration, listCollections } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, radius, space } from '@/theme';

export default function InspirationAddScreen() {
  const router = useRouter();
  const { data: cols } = useData(listCollections);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState<string>(''); // '' = Unsorted

  async function add() {
    await addInspiration(target, url, note);
    invalidate();
    router.back();
  }

  const field = {
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    color: palette.text,
    fontSize: 16,
    fontWeight: '600' as const,
    padding: space.lg,
  };

  return (
    <Screen scroll>
      <Header title="Add reel" back />

      <AppText kind="caption" style={{ marginBottom: space.sm }}>
        REEL OR TIKTOK URL
      </AppText>
      <TextInput
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        keyboardType="url"
        placeholder="https://..."
        placeholderTextColor={palette.textFaint}
        style={[field, { marginBottom: space.xl }]}
      />

      <AppText kind="caption" style={{ marginBottom: space.sm }}>
        NOTE (OPTIONAL)
      </AppText>
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="What is good about this one"
        placeholderTextColor={palette.textFaint}
        style={[field, { marginBottom: space.xl }]}
      />

      <AppText kind="caption" style={{ marginBottom: space.sm }}>
        SEND TO
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.xl }}>
        <Chip
          label="Unsorted (swipe later)"
          color={palette.yellow}
          active={target === ''}
          onPress={() => setTarget('')}
        />
        {(cols ?? []).map((c) => (
          <Chip
            key={c.id}
            label={c.name}
            color={palette.purple}
            active={target === c.id}
            onPress={() => setTarget(c.id)}
          />
        ))}
      </View>

      <Button
        label="Add reel"
        icon="add"
        disabled={url.trim().length < 4}
        onPress={add}
      />
    </Screen>
  );
}
