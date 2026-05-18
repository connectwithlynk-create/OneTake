import { useFocusEffect, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ClipVideo } from '@/components/clip-video';
import {
  AppText,
  Chip,
  EmptyState,
  IconButton,
  Loading,
  Screen,
} from '@/components/ui';
import { parseMeta } from '@/lib/autotag';
import { persistClip } from '@/lib/filestore';
import { id } from '@/lib/id';
import { rateClip } from '@/lib/rating';
import { addClip, ensureImportProject, listAllClips } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, space, verdictColor } from '@/theme';
import type { Verdict } from '@/lib/types';

function fmt(ms: number) {
  const s = Math.round(ms / 1000);
  return `0:${s.toString().padStart(2, '0')}`;
}

type Filter = 'all' | Verdict;

export default function ClipsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const [importing, setImporting] = useState(false);
  const { data: clips, loading } = useData(listAllClips);

  useFocusEffect(
    useCallback(() => {
      invalidate();
    }, [])
  );

  async function importVideos() {
    if (importing) return;
    setImporting(true);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsMultipleSelection: true,
        quality: 1,
      });
      if (res.canceled || !res.assets) return;
      const pid = await ensureImportProject();
      for (const a of res.assets) {
        const clipId = id();
        const uri = persistClip(a.uri, clipId);
        const durationMs = Math.round(a.duration ?? 0);
        // Imported footage defaults to b-roll; tags auto-assigned.
        const r = rateClip({ clipId, durationMs, defaultTag: 'broll' });
        await addClip(pid, uri, durationMs, r.verdict, r.tag, clipId);
      }
      invalidate();
    } finally {
      setImporting(false);
    }
  }

  const shown =
    filter === 'all'
      ? clips ?? []
      : (clips ?? []).filter((c) => c.verdict === filter);

  return (
    <Screen>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <AppText kind="hero">Clips</AppText>
          <AppText kind="dim" style={{ marginTop: space.xs }}>
            Every take, plus anything you import.
          </AppText>
        </View>
        <IconButton
          name={importing ? 'hourglass' : 'add'}
          tone="accent"
          onPress={importVideos}
        />
      </View>

      {loading && !clips ? (
        <Loading />
      ) : !clips || clips.length === 0 ? (
        <EmptyState
          icon="videocam-outline"
          title="No clips yet"
          subtitle="Record takes, or tap + to import video from your device."
        />
      ) : (
        <>
          <View style={styles.filters}>
            <Chip label="All" color={palette.purple} active={filter === 'all'} onPress={() => setFilter('all')} />
            <Chip label="Perfect" color={verdictColor.perfect} active={filter === 'perfect'} onPress={() => setFilter('perfect')} />
            <Chip label="Keep" color={verdictColor.keep} active={filter === 'keep'} onPress={() => setFilter('keep')} />
            <Chip label="Dud" color={verdictColor.dud} active={filter === 'dud'} onPress={() => setFilter('dud')} />
          </View>

          <FlatList
            data={shown}
            keyExtractor={(c) => c.id}
            numColumns={2}
            key="clips-grid"
            columnWrapperStyle={{ gap: space.md }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ gap: space.md, paddingBottom: space.xxl }}
            renderItem={({ item }) => {
              const meta = parseMeta(item.meta_tags);
              const tagLine = [
                item.tag === 'talking' ? 'talking' : 'b-roll',
                ...meta.map((m) => m.value),
              ].join(' · ');
              return (
                <Pressable
                  style={[styles.tile, { borderColor: verdictColor[item.verdict] }]}
                  onPress={() =>
                    router.push({
                      pathname: '/project/[id]',
                      params: { id: item.project_id },
                    })
                  }
                >
                  <View style={styles.thumb}>
                    <ClipVideo uri={item.file_uri} style={StyleSheet.absoluteFill} />
                    <View style={styles.dur}>
                      <AppText kind="caption" style={{ color: '#fff' }}>
                        {fmt(item.duration_ms)}
                      </AppText>
                    </View>
                  </View>
                  <View style={{ padding: space.md, gap: 2 }}>
                    <AppText kind="body" numberOfLines={1}>
                      {item.name ?? `Take ${item.order_index + 1}`}
                    </AppText>
                    <AppText kind="caption" numberOfLines={1}>
                      {tagLine.toUpperCase()}
                    </AppText>
                    <AppText kind="caption" numberOfLines={1} style={{ color: palette.textFaint }}>
                      {item.project_title}
                    </AppText>
                  </View>
                </Pressable>
              );
            }}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingTop: space.lg,
    paddingBottom: space.lg,
  },
  filters: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg },
  tile: {
    flex: 1,
    maxWidth: '48%',
    backgroundColor: palette.surface,
    borderRadius: 16,
    borderWidth: 2,
    overflow: 'hidden',
  },
  thumb: {
    aspectRatio: 9 / 16,
    backgroundColor: '#111',
  },
  dur: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
});
