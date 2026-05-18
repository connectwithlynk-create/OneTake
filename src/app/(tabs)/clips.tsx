import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { FlatList, View } from 'react-native';

import {
  AppText,
  Card,
  Chip,
  Dot,
  EmptyState,
  Loading,
  Screen,
} from '@/components/ui';
import { listAllClips } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, space, tagColor, verdictColor } from '@/theme';
import type { Verdict } from '@/lib/types';

function fmt(ms: number) {
  const s = Math.round(ms / 1000);
  return `0:${s.toString().padStart(2, '0')}`;
}

type Filter = 'all' | Verdict;

export default function ClipsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const { data: clips, loading } = useData(listAllClips);

  useFocusEffect(
    useCallback(() => {
      invalidate();
    }, [])
  );

  const shown =
    filter === 'all'
      ? clips ?? []
      : (clips ?? []).filter((c) => c.verdict === filter);

  return (
    <Screen>
      <View style={{ paddingTop: space.lg, paddingBottom: space.lg }}>
        <AppText kind="hero">Clips</AppText>
        <AppText kind="dim" style={{ marginTop: space.xs }}>
          Every take across every project.
        </AppText>
      </View>

      {loading && !clips ? (
        <Loading />
      ) : !clips || clips.length === 0 ? (
        <EmptyState
          icon="videocam-outline"
          title="No clips yet"
          subtitle="Record takes in a talking-head project and they all land here."
        />
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
            <Chip label="All" color={palette.purple} active={filter === 'all'} onPress={() => setFilter('all')} />
            <Chip label="Perfect" color={verdictColor.perfect} active={filter === 'perfect'} onPress={() => setFilter('perfect')} />
            <Chip label="Keep" color={verdictColor.keep} active={filter === 'keep'} onPress={() => setFilter('keep')} />
            <Chip label="Dud" color={verdictColor.dud} active={filter === 'dud'} onPress={() => setFilter('dud')} />
          </View>

          <FlatList
            data={shown}
            keyExtractor={(c) => c.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ gap: space.md, paddingBottom: space.xxl }}
            renderItem={({ item }) => (
              <Card
                accent={verdictColor[item.verdict]}
                onPress={() =>
                  router.push({
                    pathname: '/project/[id]',
                    params: { id: item.project_id },
                  })
                }
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 }}>
                    <Dot color={verdictColor[item.verdict]} />
                    <AppText kind="subtitle" numberOfLines={1} style={{ flex: 1 }}>
                      Take {item.order_index + 1}
                    </AppText>
                  </View>
                  <AppText kind="dim">{fmt(item.duration_ms)}</AppText>
                </View>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: space.sm,
                  }}
                >
                  <AppText kind="dim" numberOfLines={1} style={{ flex: 1 }}>
                    {item.project_title}
                  </AppText>
                  <View
                    style={{
                      paddingHorizontal: space.md,
                      paddingVertical: 4,
                      borderRadius: 999,
                      backgroundColor: tagColor[item.tag],
                    }}
                  >
                    <AppText kind="caption" style={{ color: palette.onBright }}>
                      {item.tag === 'talking' ? 'TALKING' : 'B-ROLL'}
                    </AppText>
                  </View>
                </View>
              </Card>
            )}
          />
        </>
      )}
    </Screen>
  );
}
