import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { AppText, EmptyState, Loading, Screen } from '@/components/ui';
import { listProjects } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, radius, space } from '@/theme';
import type { ProjectStatus } from '@/lib/types';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  recording: 'Recording',
  processing: 'Processing',
  ready: 'Ready',
};
const STATUS_COLOR: Record<ProjectStatus, string> = {
  recording: palette.yellow,
  processing: palette.blue,
  ready: palette.purple,
};

export default function ProjectsScreen() {
  const router = useRouter();
  const { data: projects, loading } = useData(listProjects);

  useFocusEffect(
    useCallback(() => {
      invalidate();
    }, [])
  );

  return (
    <Screen>
      <View style={{ paddingTop: space.lg, paddingBottom: space.lg }}>
        <AppText kind="hero">Projects</AppText>
        <AppText kind="dim" style={{ marginTop: space.xs }}>
          Film it. Know instantly. Ship it.
        </AppText>
      </View>

      {loading && !projects ? (
        <Loading />
      ) : !projects || projects.length === 0 ? (
        <EmptyState
          icon="videocam"
          title="No projects yet"
          subtitle="Start a talking-head shoot or write a prompt. Tap New to begin."
        />
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(p) => p.id}
          numColumns={2}
          showsVerticalScrollIndicator={false}
          columnWrapperStyle={{ gap: space.md }}
          contentContainerStyle={{ gap: space.md, paddingBottom: space.xxl }}
          renderItem={({ item }) => {
            const color = STATUS_COLOR[item.status];
            return (
              <Pressable
                style={styles.reel}
                onPress={() =>
                  router.push({
                    pathname: '/project/[id]',
                    params: { id: item.id },
                  })
                }
              >
                {/* thumbnail band */}
                <View style={[styles.thumb, { backgroundColor: color }]}>
                  <View style={styles.thumbScrim} />
                  <Ionicons
                    name={item.type === 'prompt' ? 'sparkles' : 'film'}
                    size={44}
                    color={palette.onBright}
                    style={{ opacity: 0.45 }}
                  />
                  <View style={styles.statusPill}>
                    <View style={[styles.dot, { backgroundColor: color }]} />
                    <AppText kind="caption" style={{ color: '#fff' }}>
                      {STATUS_LABEL[item.status].toUpperCase()}
                    </AppText>
                  </View>
                  <Ionicons
                    name="play-circle"
                    size={26}
                    color={palette.onBright}
                    style={styles.play}
                  />
                </View>
                {/* info */}
                <View style={styles.info}>
                  <AppText kind="subtitle" numberOfLines={1}>
                    {item.title}
                  </AppText>
                  <AppText kind="dim" numberOfLines={1}>
                    {item.type === 'prompt' ? 'Prompt' : 'Talking-head'} ·{' '}
                    {new Date(item.created_at).toLocaleDateString()}
                  </AppText>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  reel: {
    flex: 1,
    maxWidth: '48%',
    aspectRatio: 9 / 16,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
  },
  thumb: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.20)',
  },
  statusPill: {
    position: 'absolute',
    top: space.sm,
    left: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  play: { position: 'absolute', bottom: space.sm, right: space.sm },
  info: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: 2,
  },
});
