import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Header, MonoLabel, Screen } from '@/components/ui';
import { createProject } from '@/lib/repo';
import { invalidate } from '@/lib/store';
import type { ProjectType } from '@/lib/types';
import { font, palette } from '@/theme';

export default function NewProjectScreen() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(type: ProjectType) {
    if (busy) return;
    setBusy(true);
    const finalTitle = title.trim() || 'My next video';
    if (type === 'talkinghead') {
      const p = await createProject('talkinghead', finalTitle);
      invalidate();
      router.replace({ pathname: '/project/[id]', params: { id: p.id } });
    } else {
      router.replace({ pathname: '/prompt', params: { title: finalTitle } });
    }
  }

  return (
    <Screen scroll pad={false}>
      <Header title="New project" back />

      <View style={{ paddingHorizontal: 22, paddingTop: 4, paddingBottom: 26 }}>
        <MonoLabel style={{ marginBottom: 8 }}>PROJECT NAME</MonoLabel>
        <View style={s.fieldWrap}>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="My next video"
            placeholderTextColor={palette.text3}
            style={s.field}
            autoFocus
          />
        </View>
      </View>

      <View style={{ paddingHorizontal: 22, paddingBottom: 12 }}>
        <MonoLabel>PICK A MODE</MonoLabel>
      </View>

      <View style={{ paddingHorizontal: 22, gap: 12 }}>
        <Pressable
          onPress={() => start('talkinghead')}
          style={({ pressed }) => [
            s.modeCard,
            s.modeCardActive,
            { transform: [{ scale: pressed ? 0.98 : 1 }] },
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
            <View
              style={[
                s.modeIcon,
                {
                  backgroundColor: `${palette.lime}22`,
                  borderColor: `${palette.lime}66`,
                },
              ]}
            >
              <Ionicons name="videocam" size={22} color={palette.lime} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.modeTitle}>Talking-head</Text>
              <Text style={s.modeBody}>
                Record takes, get an instant verdict on each, auto-tag talking
                vs b-roll, then finish to auto-edit.
              </Text>
            </View>
          </View>
        </Pressable>

        <Pressable
          onPress={() => start('prompt')}
          style={({ pressed }) => [
            s.modeCard,
            { transform: [{ scale: pressed ? 0.98 : 1 }] },
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
            <View
              style={[
                s.modeIcon,
                {
                  backgroundColor: `${palette.gold}18`,
                  borderColor: `${palette.gold}55`,
                },
              ]}
            >
              <Ionicons name="sparkles" size={22} color={palette.gold} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.modeTitle}>Prompt</Text>
              <Text style={s.modeBody}>
                Describe the video. It&apos;s assembled from footage already in your
                library.
              </Text>
            </View>
          </View>
        </Pressable>
      </View>

      <Text style={s.footer}>Both modes are private until you finish.</Text>
    </Screen>
  );
}

const s = StyleSheet.create({
  fieldWrap: {
    paddingVertical: 4,
    borderRadius: 14,
    backgroundColor: palette.bg1,
    borderWidth: 1.5,
    borderColor: `${palette.lime}66`,
    shadowColor: palette.lime,
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  field: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    color: '#fff',
    fontFamily: font.bodyBold,
    fontSize: 16,
    fontWeight: '600',
  },
  modeCard: {
    padding: 18,
    borderRadius: 20,
    backgroundColor: palette.bg1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  modeCardActive: {
    backgroundColor: `${palette.lime}12`,
    borderColor: `${palette.lime}66`,
    borderWidth: 1.5,
    shadowColor: palette.lime,
    shadowOpacity: 0.3,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
  },
  modeIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeTitle: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 19,
    color: '#fff',
  },
  modeBody: {
    fontFamily: font.body,
    fontSize: 13,
    color: palette.text2,
    marginTop: 4,
    lineHeight: 18,
  },
  footer: {
    marginTop: 32,
    paddingHorizontal: 22,
    textAlign: 'center',
    fontFamily: font.body,
    fontSize: 12,
    color: palette.text3,
  },
});
