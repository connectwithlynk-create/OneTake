import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { FlatList, Pressable, View } from 'react-native';

import {
  AppText,
  Card,
  EmptyState,
  Header,
  Loading,
  Screen,
} from '@/components/ui';
import {
  getProject,
  listClips,
  moveClip,
  setClipExcluded,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, radius, space, verdictColor } from '@/theme';
import type { Clip } from '@/lib/types';

function fmt(ms: number) {
  const s = Math.round(ms / 1000);
  return `0:${s.toString().padStart(2, '0')}`;
}

function StepBtn({
  icon,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={{
        width: 36,
        height: 36,
        borderRadius: radius.sm,
        backgroundColor: palette.surfaceHi,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.3 : 1,
      }}
    >
      <Ionicons name={icon} size={18} color={palette.text} />
    </Pressable>
  );
}

export default function ManualEditScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const { data: project } = useData(() => getProject(projectId), [projectId]);
  const { data: clips, loading } = useData(
    () => listClips(projectId),
    [projectId]
  );

  if (loading || !project) return <Screen><Loading /></Screen>;

  const included = (clips ?? []).filter((c) => c.excluded === 0);
  const cutMs = included.reduce((s, c) => s + c.duration_ms, 0);

  async function move(c: Clip, dir: 'up' | 'down') {
    await moveClip(c.id, dir);
    invalidate();
  }
  async function toggle(c: Clip) {
    await setClipExcluded(c.id, c.excluded === 1 ? 0 : 1);
    invalidate();
  }

  return (
    <Screen>
      <Header title="Manual edit" back />

      {!clips || clips.length === 0 ? (
        <EmptyState
          icon="construct-outline"
          title="No clips to edit"
          subtitle="Record some takes first, then arrange the cut here."
        />
      ) : (
        <>
          <Card accent={palette.blue}>
            <AppText kind="caption">YOUR CUT</AppText>
            <AppText kind="title" style={{ marginTop: space.xs }}>
              {included.length} clip{included.length === 1 ? '' : 's'} ·{' '}
              {fmt(cutMs)}
            </AppText>
            <AppText kind="dim" style={{ marginTop: space.xs }}>
              Reorder takes and choose which ones make the edit. This is the
              order the export uses.
            </AppText>
          </Card>

          <FlatList
            data={clips}
            keyExtractor={(c) => c.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              gap: space.sm,
              paddingTop: space.lg,
              paddingBottom: space.xxl,
            }}
            renderItem={({ item, index }) => {
              const off = item.excluded === 1;
              return (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.md,
                    backgroundColor: palette.surface,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: palette.border,
                    padding: space.md,
                    opacity: off ? 0.45 : 1,
                  }}
                >
                  <AppText kind="subtitle" style={{ width: 24, color: palette.textFaint }}>
                    {index + 1}
                  </AppText>
                  <View
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      backgroundColor: verdictColor[item.verdict],
                    }}
                  />
                  <View style={{ flex: 1 }}>
                    <AppText kind="body" numberOfLines={1}>
                      Take {item.order_index + 1}
                    </AppText>
                    <AppText kind="dim">
                      {item.tag === 'talking' ? 'Talking' : 'B-roll'} ·{' '}
                      {fmt(item.duration_ms)}
                      {off ? ' · cut' : ''}
                    </AppText>
                  </View>
                  <StepBtn
                    icon="chevron-up"
                    disabled={index === 0}
                    onPress={() => move(item, 'up')}
                  />
                  <StepBtn
                    icon="chevron-down"
                    disabled={index === clips.length - 1}
                    onPress={() => move(item, 'down')}
                  />
                  <Pressable
                    onPress={() => toggle(item)}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: radius.sm,
                      backgroundColor: off ? palette.surfaceHi : palette.blue,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ionicons
                      name={off ? 'eye-off' : 'eye'}
                      size={18}
                      color={off ? palette.textFaint : palette.onBright}
                    />
                  </Pressable>
                </View>
              );
            }}
          />
        </>
      )}
    </Screen>
  );
}
