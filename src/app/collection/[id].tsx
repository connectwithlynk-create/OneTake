import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';

import {
  AppText,
  Button,
  EmptyState,
  Header,
  IconButton,
  Loading,
  Screen,
} from '@/components/ui';
import {
  deleteCollection,
  getCollection,
  listInspiration,
  renameCollection,
  unfiledCount,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, radius, space } from '@/theme';

export default function CollectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  const { data: col } = useData(() => getCollection(id), [id]);
  const { data: items } = useData(() => listInspiration(id), [id]);
  const { data: unfiled } = useData(unfiledCount);

  if (!col) return <Screen><Loading /></Screen>;

  async function saveName() {
    if (name.trim()) {
      await renameCollection(id, name);
      invalidate();
    }
    setEditing(false);
  }
  async function removeCollection() {
    await deleteCollection(id);
    invalidate();
    router.back();
  }

  return (
    <Screen>
      <Header
        title={editing ? '' : col.name}
        back
        right={
          <IconButton
            name="trash"
            tone="clear"
            color={palette.red}
            onPress={removeCollection}
          />
        }
      />

      {editing ? (
        <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
          <TextInput
            value={name}
            onChangeText={setName}
            autoFocus
            placeholder={col.name}
            placeholderTextColor={palette.textFaint}
            style={{
              flex: 1,
              backgroundColor: palette.surface,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: palette.border,
              color: palette.text,
              fontSize: 16,
              fontWeight: '700',
              padding: space.lg,
            }}
          />
          <IconButton name="checkmark" tone="accent" onPress={saveName} />
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
          <IconButton
            name="create"
            tone="surface"
            onPress={() => {
              setName(col.name);
              setEditing(true);
            }}
          />
          {(unfiled ?? 0) > 0 && (
            <View style={{ flex: 1 }}>
              <Button
                label={`Sort ${unfiled} reels in here`}
                tone="accent"
                icon="layers"
                onPress={() =>
                  router.push({
                    pathname: '/swipe/[collectionId]',
                    params: { collectionId: id },
                  })
                }
              />
            </View>
          )}
        </View>
      )}

      {!items || items.length === 0 ? (
        <EmptyState
          icon="images"
          title="Empty collection"
          subtitle="Add reels from the Inspiration tab, then swipe them in here."
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: space.xxl * 2 }}
        >
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}
          >
            {items.map((it) => (
              <View key={it.id} style={{ width: '47%' }}>
                <View
                  style={{
                    height: 150,
                    borderRadius: radius.lg,
                    backgroundColor: it.thumb_color,
                    padding: space.md,
                    justifyContent: 'flex-end',
                  }}
                >
                  <Ionicons
                    name="play-circle"
                    size={26}
                    color={palette.onBright}
                  />
                </View>
                <AppText kind="dim" numberOfLines={1} style={{ marginTop: space.xs }}>
                  {it.note || it.source_url}
                </AppText>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
