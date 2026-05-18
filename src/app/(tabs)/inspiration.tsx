import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppText, Card, EmptyState, Loading, Screen } from '@/components/ui';
import {
  createCollection,
  listCollectionsWithCounts,
  unfiledCount,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, radius, space } from '@/theme';

export default function InspirationScreen() {
  const router = useRouter();
  const { data: cols, loading } = useData(listCollectionsWithCounts);
  const { data: unfiled } = useData(unfiledCount);

  useFocusEffect(
    useCallback(() => {
      invalidate();
    }, [])
  );

  async function newCollection() {
    const n = (cols?.length ?? 0) + 1;
    await createCollection(`Collection ${n}`);
    invalidate();
  }

  return (
    <Screen>
      <View style={{ paddingTop: space.lg, paddingBottom: space.lg }}>
        <AppText kind="hero">Inspiration</AppText>
        <AppText kind="dim" style={{ marginTop: space.xs }}>
          Swipe reels into collections. Reuse one as an edit style later.
        </AppText>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: space.xxl * 3, gap: space.md }}
      >
        {(unfiled ?? 0) > 0 && (
          <Card accent={palette.yellow}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <View>
                <AppText kind="subtitle">{unfiled} reels to sort</AppText>
                <AppText kind="dim" style={{ marginTop: space.xs }}>
                  Open a collection to swipe them in.
                </AppText>
              </View>
              <Ionicons name="layers" size={28} color={palette.yellow} />
            </View>
          </Card>
        )}

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: space.sm,
          }}
        >
          <AppText kind="caption">COLLECTIONS</AppText>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Pressable style={styles.miniBtn(palette.surfaceHi)} onPress={newCollection}>
              <Ionicons name="add" size={18} color={palette.text} />
              <AppText kind="caption" style={{ color: palette.text }}>
                COLLECTION
              </AppText>
            </Pressable>
            <Pressable
              style={styles.miniBtn(palette.purple)}
              onPress={() => router.push('/inspiration-add')}
            >
              <Ionicons name="add" size={18} color={palette.onBright} />
              <AppText kind="caption" style={{ color: palette.onBright }}>
                ADD REEL
              </AppText>
            </Pressable>
          </View>
        </View>

        {loading && !cols ? (
          <Loading />
        ) : !cols || cols.length === 0 ? (
          <EmptyState
            icon="sparkles"
            title="No collections"
            subtitle="Make a collection, then add reels and swipe them in."
          />
        ) : (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: space.md,
            }}
          >
            {cols.map(({ collection, count }) => (
              <Pressable
                key={collection.id}
                style={{ width: '47%' }}
                onPress={() =>
                  router.push({
                    pathname: '/collection/[id]',
                    params: { id: collection.id },
                  })
                }
              >
                <View style={styles.tile}>
                  <View style={styles.tileTop}>
                    <Ionicons name="albums" size={26} color={palette.purple} />
                  </View>
                  <AppText kind="subtitle" numberOfLines={1}>
                    {collection.name}
                  </AppText>
                  <AppText kind="dim">
                    {count} reel{count === 1 ? '' : 's'}
                  </AppText>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = {
  miniBtn: (bg: string) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    backgroundColor: bg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  }),
  tile: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.border,
    padding: space.lg,
    gap: space.xs,
  },
  tileTop: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: palette.surfaceHi,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginBottom: space.sm,
  },
};
