import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Button, Chip, Header, MonoLabel, Screen } from '@/components/ui';
import { addInspiration, listCollections } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { font, palette } from '@/theme';

const CHIP_COLORS = [
  palette.magenta,
  palette.cyan,
  palette.lime,
  palette.violet,
  palette.coral,
];

export default function InspirationAddScreen() {
  const router = useRouter();
  const { data: cols } = useData(listCollections);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState<string>('');

  async function add() {
    await addInspiration(target, url, note);
    invalidate();
    router.back();
  }

  return (
    <Screen scroll pad={false}>
      <Header title="Add reel" back />

      <View style={{ paddingHorizontal: 22, paddingTop: 4, paddingBottom: 22 }}>
        <MonoLabel style={{ marginBottom: 8 }}>REEL OR TIKTOK URL</MonoLabel>
        <View style={[s.fieldFocus]}>
          <TextInput
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            keyboardType="url"
            placeholder="https://..."
            placeholderTextColor={palette.text3}
            style={s.fieldMono}
            autoFocus
          />
        </View>
      </View>

      <View style={{ paddingHorizontal: 22, paddingBottom: 22 }}>
        <MonoLabel style={{ marginBottom: 8 }}>NOTE (OPTIONAL)</MonoLabel>
        <View style={s.field}>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="What's good about this one?"
            placeholderTextColor={palette.text3}
            style={s.fieldText}
          />
        </View>
      </View>

      <View style={{ paddingHorizontal: 22, paddingBottom: 22 }}>
        <MonoLabel style={{ marginBottom: 8 }}>SEND TO</MonoLabel>
        <View style={s.chipRow}>
          <Chip
            label="Unsorted (swipe later)"
            color={palette.gold}
            active={target === ''}
            onPress={() => setTarget('')}
          />
          {(cols ?? []).map((c, i) => (
            <Chip
              key={c.id}
              label={c.name}
              color={CHIP_COLORS[i % CHIP_COLORS.length]}
              active={target === c.id}
              onPress={() => setTarget(c.id)}
            />
          ))}
        </View>
      </View>

      <View style={{ paddingHorizontal: 22, paddingTop: 6, paddingBottom: 32 }}>
        <Button
          label="Add reel"
          icon="add"
          size="lg"
          full
          disabled={url.trim().length < 4}
          onPress={add}
        />
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  field: {
    backgroundColor: palette.bg1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  fieldFocus: {
    backgroundColor: palette.bg1,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: `${palette.lime}55`,
  },
  fieldText: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    color: '#fff',
    fontFamily: font.body,
    fontSize: 14,
  },
  fieldMono: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    color: '#fff',
    fontFamily: font.mono,
    fontSize: 14,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
