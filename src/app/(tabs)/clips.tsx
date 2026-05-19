import { useFocusEffect, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { MediaTile, MEDIA_COLUMNS } from '@/components/media-tile';
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
import { maybeTranscribe } from '@/lib/transcribe';
import { invalidate, useData } from '@/lib/store';
import { relativeAge, fmtDuration } from '@/lib/time';
import { palette, space, verdictColor } from '@/theme';
import type { Verdict } from '@/lib/types';

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
        const r = rateClip({ clipId, durationMs, source: 'imported' });
        await addClip(pid, uri, durationMs, r.verdict, r.tag, clipId);
        // Background: transcribe -> real talking/b-roll + spoken title.
        void maybeTranscribe(clipId);
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
            key="clips-media-grid"
            keyExtractor={(c) => c.id}
            numColumns={MEDIA_COLUMNS}
            columnWrapperStyle={{ gap: space.md }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ gap: space.md, paddingBottom: space.xxl }}
            renderItem={({ item }) => {
              const meta = parseMeta(item.meta_tags);
              const tags = [
                item.tag === 'talking' ? 'talking' : 'b-roll',
                ...meta.map((m) => m.value),
              ];
              return (
                <MediaTile
                  uri={item.file_uri}
                  title={item.name ?? `Take ${item.order_index + 1}`}
                  date={`${relativeAge(item.created_at)} · ${fmtDuration(item.duration_ms)}`}
                  tags={tags}
                  accent={verdictColor[item.verdict]}
                  onPress={() =>
                    router.push({
                      pathname: '/player',
                      params: {
                        uri: item.file_uri,
                        title: item.name ?? `Take ${item.order_index + 1}`,
                      },
                    })
                  }
                />
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
});
