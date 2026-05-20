import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  EmptyState,
  Hero,
  Loading,
  MediaPlaceholder,
  MonoLabel,
  Screen,
} from '@/components/ui';
import {
  createCollection,
  listCollectionsWithCounts,
  unfiledCount,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { font, palette } from '@/theme';

const TINTS = ['magenta', 'cool', 'lime', 'gold', 'violet', 'warm'] as const;

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
    <Screen pad={false}>
      <Hero
        title="Inspiration"
        sub="Swipe reels into collections. Reuse one as an edit style later."
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 140 }}
      >
        {(unfiled ?? 0) > 0 && (
          <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
            <View style={s.unfiledCard}>
              <View style={s.unfiledIcon}>
                <Ionicons name="layers" size={22} color={palette.gold} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.unfiledTitle}>{unfiled} reels to sort</Text>
                <Text style={s.unfiledSub}>Open a collection to swipe them in.</Text>
              </View>
              <Ionicons name="chevron-forward" size={14} color={palette.gold} />
            </View>
          </View>
        )}

        <View style={s.toolbar}>
          <MonoLabel>COLLECTIONS · {cols?.length ?? 0}</MonoLabel>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable style={s.miniBtnSurface} onPress={newCollection}>
              <Ionicons name="add" size={10} color="#fff" />
              <Text style={s.miniBtnText}>COLLECTION</Text>
            </Pressable>
            <Pressable
              style={s.miniBtnLime}
              onPress={() => router.push('/inspiration-add')}
            >
              <Ionicons name="add" size={10} color={palette.onBright} />
              <Text style={[s.miniBtnText, { color: palette.onBright }]}>
                ADD REEL
              </Text>
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
          <View style={s.grid}>
            {cols.map(({ collection, count }, i) => {
              const tint = TINTS[i % TINTS.length];
              return (
                <Pressable
                  key={collection.id}
                  style={s.cell}
                  onPress={() =>
                    router.push({
                      pathname: '/collection/[id]',
                      params: { id: collection.id },
                    })
                  }
                >
                  <View style={s.cellInner}>
                    <View style={s.stack}>
                      <View style={[s.thumbStacked, s.thumb1]}>
                        <MediaPlaceholder variant={tint} />
                      </View>
                      <View style={[s.thumbStacked, s.thumb2]}>
                        <MediaPlaceholder variant={tint} />
                      </View>
                      <View style={[s.thumbStacked, s.thumb3]}>
                        <MediaPlaceholder variant={tint} />
                      </View>
                    </View>
                    <Text style={s.tileTitle} numberOfLines={1}>
                      {collection.name}
                    </Text>
                    <Text style={s.tileSub}>
                      {count} reel{count === 1 ? '' : 's'}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  unfiledCard: {
    padding: 14,
    borderRadius: 18,
    backgroundColor: `${palette.gold}10`,
    borderWidth: 1,
    borderColor: `${palette.gold}55`,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  unfiledIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: `${palette.gold}22`,
    borderWidth: 1,
    borderColor: `${palette.gold}55`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unfiledTitle: {
    fontFamily: font.displayHeavy,
    fontWeight: '700',
    fontSize: 17,
    color: '#fff',
  },
  unfiledSub: {
    fontFamily: font.body,
    fontSize: 12,
    color: palette.text3,
    marginTop: 2,
  },
  toolbar: {
    paddingHorizontal: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  miniBtnSurface: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  miniBtnLime: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: palette.lime,
  },
  miniBtnText: {
    fontFamily: font.monoBold,
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.5,
  },
  grid: {
    paddingHorizontal: 18,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  cell: { width: '47.5%' },
  cellInner: {
    padding: 14,
    borderRadius: 18,
    backgroundColor: palette.bg1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  stack: { position: 'relative', height: 80, marginBottom: 12 },
  thumbStacked: {
    position: 'absolute',
    width: 44,
    height: 68,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  thumb1: { left: 4, top: 6, transform: [{ rotate: '-8deg' }] },
  thumb2: {
    left: 22,
    top: 0,
    width: 46,
    height: 70,
    transform: [{ rotate: '2deg' }],
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  thumb3: { left: 50, top: 4, transform: [{ rotate: '10deg' }] },
  tileTitle: {
    fontFamily: font.bodyBold,
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
  tileSub: {
    fontFamily: font.body,
    fontSize: 11.5,
    color: palette.text3,
    marginTop: 2,
  },
});
