import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { EmptyState, Hero, Loading, Screen, StatusPill } from '@/components/ui';
import { listProjects } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { relativeAge } from '@/lib/time';
import type { Project } from '@/lib/types';
import { font, palette } from '@/theme';

export default function ProjectsScreen() {
  const router = useRouter();
  const { data: projects, loading } = useData(listProjects);

  useFocusEffect(
    useCallback(() => {
      invalidate();
    }, [])
  );

  return (
    <Screen pad={false}>
      <Hero title="Projects" sub="Film it. Know instantly. Ship it." />

      <FlatList
        key="projects-grid"
        data={projects ?? []}
        keyExtractor={(p) => p.id}
        numColumns={2}
        showsVerticalScrollIndicator={false}
        columnWrapperStyle={{ gap: 12 }}
        contentContainerStyle={{
          gap: 12,
          paddingHorizontal: 18,
          paddingBottom: 130,
          flexGrow: 1,
        }}
        ListEmptyComponent={
          loading && !projects ? (
            <Loading />
          ) : (
            <EmptyState
              icon="videocam"
              title="No projects yet"
              subtitle="Start a talking-head shoot or write a prompt. Tap New to begin."
            />
          )
        }
        renderItem={({ item, index }) => (
          <ProjectCard
            item={item}
            index={index}
            onPress={() =>
              router.push({ pathname: '/project/[id]', params: { id: item.id } })
            }
          />
        )}
      />
    </Screen>
  );
}

const TILE_TINT: Record<string, string> = {
  'lime': palette.lime,
  'cyan': palette.cyan,
  'magenta': palette.magenta,
  'gold': palette.gold,
  'violet': palette.violet,
  'coral': palette.coral,
};
const TINT_ORDER = ['lime', 'magenta', 'cyan', 'gold', 'violet', 'coral'] as const;

function ProjectCard({
  item,
  onPress,
  index,
}: {
  item: Project;
  onPress: () => void;
  index: number;
}) {
  const tint = TILE_TINT[TINT_ORDER[index % TINT_ORDER.length]];
  return (
    <Pressable style={s.card} onPress={onPress}>
      <View
        style={[
          s.thumb,
          {
            backgroundColor: `${tint}10`,
            borderBottomWidth: 1,
            borderColor: `${tint}22`,
          },
        ]}
      >
        <View style={s.thumbInner}>
          <Ionicons
            name={item.type === 'prompt' ? 'sparkles' : 'film'}
            size={36}
            color={`${tint}55`}
          />
        </View>
        <View style={s.statusOverlay}>
          <StatusPill s={item.status} />
        </View>
        <View style={s.play}>
          <Ionicons name="play" size={11} color="#fff" />
        </View>
      </View>
      <View style={s.info}>
        <Text style={s.title} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {item.type === 'prompt' ? 'Prompt' : 'Talking-head'} ·{' '}
          {relativeAge(item.created_at)}
        </Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    flex: 1,
    maxWidth: '48.5%',
    aspectRatio: 9 / 16,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: palette.bg1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  thumb: {
    flex: 1,
    backgroundColor: palette.bg2,
    position: 'relative',
  },
  thumbInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusOverlay: { position: 'absolute', top: 8, left: 8 },
  play: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { paddingHorizontal: 12, paddingVertical: 10 },
  title: { fontFamily: font.bodyBold, fontWeight: '700', fontSize: 13, color: '#fff' },
  meta: { fontFamily: font.body, fontSize: 11, color: palette.text3, marginTop: 2 },
});
