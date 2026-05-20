import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip, EmptyState, IconButton, Loading, MediaPlaceholder, Screen } from '@/components/ui';
import {
  deleteCollection,
  getCollection,
  listInspiration,
  renameCollection,
  unfiledCount,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { font, palette } from '@/theme';

const TINTS = ['magenta', 'lime', 'cool', 'gold', 'violet', 'warm'] as const;

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
    <Screen pad={false}>
      <View style={s.head}>
        <IconButton
          name="chevron-back"
          tone="surface"
          size={38}
          onPress={() => router.back()}
        />
        {editing ? (
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              autoFocus
              placeholder={col.name}
              placeholderTextColor={palette.text3}
              style={s.titleInput}
              onSubmitEditing={saveName}
              returnKeyType="done"
            />
          </View>
        ) : (
          <Pressable
            style={s.titleWrap}
            onPress={() => {
              setName(col.name);
              setEditing(true);
            }}
          >
            <Text style={s.title} numberOfLines={1}>
              {col.name}
            </Text>
          </Pressable>
        )}
        <IconButton
          name="trash-outline"
          tone="danger"
          size={38}
          onPress={removeCollection}
        />
      </View>

      <View style={s.metaRow}>
        <Chip label={`${items?.length ?? 0} REELS`} mono color={palette.cyan} />
        <Chip label="STYLE: FAST CUTS" mono color={palette.magenta} />
      </View>

      {(unfiled ?? 0) > 0 ? (
        <Pressable
          style={s.sortCta}
          onPress={() =>
            router.push({
              pathname: '/swipe/[collectionId]',
              params: { collectionId: id },
            })
          }
        >
          <View style={s.sortIcon}>
            <Ionicons name="layers" size={18} color={palette.lime} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.sortTitle}>Sort {unfiled} unfiled reels in here</Text>
            <Text style={s.sortSub}>Swipe right to save, left to discard.</Text>
          </View>
          <Ionicons name="chevron-forward" size={14} color={palette.lime} />
        </Pressable>
      ) : null}

      {!items || items.length === 0 ? (
        <EmptyState
          icon="images"
          title="Empty collection"
          subtitle="Add reels from the Inspiration tab, then swipe them in here."
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 30 }}
        >
          <View style={s.grid}>
            {items.map((it, i) => (
              <View key={it.id} style={s.gridCell}>
                <View style={s.gridFrame}>
                  <MediaPlaceholder
                    variant={TINTS[i % TINTS.length]}
                    label={it.note ?? it.source_url}
                  />
                  <View style={s.playPill}>
                    <Ionicons name="play" size={9} color="#fff" />
                  </View>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  head: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  titleWrap: { flex: 1, alignItems: 'center' },
  title: {
    fontFamily: font.displayHeavy,
    fontWeight: '700',
    fontSize: 17,
    color: '#fff',
  },
  titleInput: {
    flex: 1,
    backgroundColor: palette.bg1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    color: '#fff',
    fontFamily: font.bodyBold,
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  metaRow: {
    paddingHorizontal: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sortCta: {
    marginHorizontal: 18,
    marginBottom: 16,
    padding: 14,
    borderRadius: 16,
    backgroundColor: `${palette.lime}12`,
    borderWidth: 1,
    borderColor: `${palette.lime}55`,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sortIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: `${palette.lime}22`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sortTitle: {
    fontFamily: font.bodyBold,
    fontSize: 13.5,
    fontWeight: '700',
    color: '#fff',
  },
  sortSub: {
    fontFamily: font.body,
    fontSize: 11.5,
    color: palette.text3,
    marginTop: 1,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gridCell: {
    width: '31.5%',
    aspectRatio: 9 / 14,
  },
  gridFrame: {
    flex: 1,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    position: 'relative',
  },
  playPill: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
