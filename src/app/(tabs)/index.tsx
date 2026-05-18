import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { FlatList, View } from 'react-native';

import {
  AppText,
  Card,
  Dot,
  EmptyState,
  Loading,
  Screen,
} from '@/components/ui';
import { listProjects } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, space } from '@/theme';
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
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ gap: space.md, paddingBottom: space.xxl * 3 }}
          renderItem={({ item }) => (
            <Card
              accent={STATUS_COLOR[item.status]}
              onPress={() =>
                router.push({
                  pathname: '/project/[id]',
                  params: { id: item.id },
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
                <AppText kind="subtitle" numberOfLines={1} style={{ flex: 1 }}>
                  {item.title}
                </AppText>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.sm,
                  }}
                >
                  <Dot color={STATUS_COLOR[item.status]} />
                  <AppText kind="caption">
                    {STATUS_LABEL[item.status].toUpperCase()}
                  </AppText>
                </View>
              </View>
              <AppText kind="dim" style={{ marginTop: space.sm }}>
                {item.type === 'prompt' ? 'Prompt project' : 'Talking-head'} ·{' '}
                {new Date(item.created_at).toLocaleDateString()}
              </AppText>
            </Card>
          )}
        />
      )}
    </Screen>
  );
}
