import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { ClipVideo } from '@/components/clip-video';
import {
  Chip,
  EmptyState,
  IconButton,
  Loading,
  Screen,
  TagPill,
  VerdictPill,
} from '@/components/ui';
import { persistClip } from '@/lib/filestore';
import { id } from '@/lib/id';
import { rateClip } from '@/lib/rating';
import { addClip, deleteClip, ensureImportProject, listAllClips } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { relativeAge, fmtDuration } from '@/lib/time';
import { maybeTranscribe } from '@/lib/transcribe';
import type { Clip, Verdict } from '@/lib/types';
import { font, palette, verdictColor } from '@/theme';

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
        void maybeTranscribe(clipId);
      }
      invalidate();
    } finally {
      setImporting(false);
    }
  }

  function confirmDelete(clipId: string, fileUri: string, label: string) {
    Alert.alert(
      'Delete clip?',
      `"${label}" will be removed from this device. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteClip(clipId, fileUri);
            invalidate();
          },
        },
      ]
    );
  }

  const all = clips ?? [];
  const counts = {
    all: all.length,
    perfect: all.filter((c) => c.verdict === 'perfect').length,
    keep: all.filter((c) => c.verdict === 'keep').length,
    dud: all.filter((c) => c.verdict === 'dud').length,
  };
  const shown = filter === 'all' ? all : all.filter((c) => c.verdict === filter);

  return (
    <Screen pad={false}>
      <View style={s.head}>
        <View style={{ flex: 1 }}>
          <Text style={s.hero}>Clips</Text>
          <Text style={s.sub}>Every take, plus anything you import.</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <IconButton
            name="albums-outline"
            tone="cyan"
            size={40}
            onPress={() => router.push('/broll-library' as never)}
          />
          <IconButton
            name={importing ? 'hourglass' : 'add'}
            tone="accent"
            size={40}
            onPress={importVideos}
          />
        </View>
      </View>

      {loading && !all.length ? (
        <Loading />
      ) : all.length === 0 ? (
        <EmptyState
          icon="videocam-outline"
          title="No clips yet"
          subtitle="Record takes, or tap + to import video from your device."
        />
      ) : (
        <>
          <View style={s.filters}>
            <Chip
              label={`All · ${counts.all}`}
              color={palette.lime}
              active={filter === 'all'}
              onPress={() => setFilter('all')}
            />
            <Chip
              label={`Perfect · ${counts.perfect}`}
              color={palette.lime}
              active={filter === 'perfect'}
              onPress={() => setFilter('perfect')}
            />
            <Chip
              label={`Keep · ${counts.keep}`}
              color={palette.cyan}
              active={filter === 'keep'}
              onPress={() => setFilter('keep')}
            />
            <Chip
              label={`Dud · ${counts.dud}`}
              color={palette.coral}
              active={filter === 'dud'}
              onPress={() => setFilter('dud')}
            />
          </View>

          <FlatList
            data={shown}
            key="clips-media-grid"
            keyExtractor={(c) => c.id}
            numColumns={2}
            columnWrapperStyle={{ gap: 12 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              gap: 12,
              paddingHorizontal: 18,
              paddingBottom: 130,
            }}
            renderItem={({ item }) => (
              <ClipTile
                clip={item}
                onPress={() =>
                  router.push({
                    pathname: '/player',
                    params: {
                      id: item.id,
                      uri: item.file_uri,
                      title: item.name ?? `Take ${item.order_index + 1}`,
                    },
                  })
                }
                onDelete={() =>
                  confirmDelete(
                    item.id,
                    item.file_uri,
                    item.name ?? `Take ${item.order_index + 1}`
                  )
                }
              />
            )}
          />
        </>
      )}
    </Screen>
  );
}

function ClipTile({
  clip,
  onPress,
  onDelete,
}: {
  clip: Clip;
  onPress: () => void;
  onDelete: () => void;
}) {
  const accent = verdictColor[clip.verdict];
  const isDud = clip.verdict === 'dud';
  return (
    <Pressable
      style={[
        s.tile,
        {
          borderColor: `${accent}40`,
          opacity: isDud ? 0.55 : 1,
        },
      ]}
      onPress={onPress}
    >
      <View style={s.tileThumb}>
        <ClipVideo uri={clip.file_uri} style={StyleSheet.absoluteFillObject} />
        <View style={s.tileVerdict}>
          <VerdictPill v={clip.verdict} />
        </View>
        <View style={s.tileDur}>
          <Text style={s.tileDurText}>{fmtDuration(clip.duration_ms)}</Text>
        </View>
        <Pressable style={s.tileDel} onPress={onDelete} hitSlop={6}>
          <Ionicons name="trash" size={11} color="#fff" />
        </Pressable>
      </View>
      <View style={s.tileInfo}>
        <Text style={s.tileTitle} numberOfLines={1}>
          {clip.name ?? `Take ${clip.order_index + 1}`}
        </Text>
        <View style={s.tileBottom}>
          <TagPill t={clip.tag} />
          <Text style={s.tileAge}>{relativeAge(clip.created_at)} ago</Text>
        </View>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  hero: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 34,
    color: '#fff',
    letterSpacing: -1,
    lineHeight: 34,
  },
  sub: { marginTop: 6, fontFamily: font.body, fontSize: 13.5, color: palette.text2 },
  filters: {
    paddingHorizontal: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  tile: {
    flex: 1,
    maxWidth: '49%',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1.5,
    backgroundColor: palette.bg1,
  },
  tileThumb: { aspectRatio: 9 / 14, position: 'relative' },
  tileVerdict: { position: 'absolute', top: 6, left: 6 },
  tileDur: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  tileDurText: {
    fontFamily: font.monoBold,
    fontSize: 9.5,
    color: '#fff',
    fontWeight: '700',
  },
  tileDel: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileInfo: { padding: 10 },
  tileTitle: {
    fontFamily: font.bodyBold,
    fontWeight: '700',
    fontSize: 12.5,
    color: '#fff',
  },
  tileBottom: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tileAge: { fontFamily: font.body, fontSize: 10.5, color: palette.text3 },
});
