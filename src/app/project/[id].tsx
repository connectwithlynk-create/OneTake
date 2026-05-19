import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, View } from 'react-native';

import { MediaTile, MEDIA_COLUMNS } from '@/components/media-tile';
import {
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  Header,
  IconButton,
  Loading,
  Screen,
} from '@/components/ui';
import { parseMeta } from '@/lib/autotag';
import { hoursLeft } from '@/lib/ephemeral';
import {
  deleteClip,
  getProject,
  listClips,
  setProjectStatus,
  setVerdict,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { relativeAge, fmtDuration } from '@/lib/time';
import { palette, space, verdictColor } from '@/theme';
import type { Clip, Verdict } from '@/lib/types';

const VERDICT_CYCLE: Verdict[] = ['dud', 'keep', 'perfect'];

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [filter, setFilter] = useState<'all' | 'keeps' | 'duds'>('all');

  const { data: project, loading: lp } = useData(() => getProject(id), [id]);
  const { data: clips, loading: lc } = useData(() => listClips(id), [id]);

  if (lp || lc || !project) return <Screen><Loading /></Screen>;

  const isPrompt = project.type === 'prompt';
  const keeps = (clips ?? []).filter((c) => c.verdict !== 'dud');
  const shown = (clips ?? []).filter((c) =>
    filter === 'all'
      ? true
      : filter === 'keeps'
      ? c.verdict !== 'dud'
      : c.verdict === 'dud'
  );

  // Verdict stays subtle: long-press a tile to cycle dud -> keep -> perfect.
  async function cycleVerdict(c: Clip) {
    const next =
      VERDICT_CYCLE[(VERDICT_CYCLE.indexOf(c.verdict) + 1) % 3];
    await setVerdict(c.id, next);
    invalidate();
  }
  async function remove(c: Clip) {
    await deleteClip(c.id, c.file_uri);
    invalidate();
  }
  async function finish() {
    await setProjectStatus(id, 'processing');
    invalidate();
    router.push({ pathname: '/preview/[projectId]', params: { projectId: id } });
  }

  return (
    <Screen>
      <Header
        title={project.title}
        back
        right={
          !isPrompt ? (
            <IconButton
              name="videocam"
              tone="accent"
              onPress={() =>
                router.push({
                  pathname: '/capture/[projectId]',
                  params: { projectId: id },
                })
              }
            />
          ) : undefined
        }
      />

      {isPrompt ? (
        <View style={{ flex: 1, gap: space.lg }}>
          <Card accent={palette.yellow}>
            <AppText kind="caption">PROMPT</AppText>
            <AppText kind="body" style={{ marginTop: space.sm }}>
              {project.prompt || 'No prompt set.'}
            </AppText>
          </Card>
          <Button
            label="Generate video"
            tone="accent"
            icon="sparkles"
            onPress={finish}
          />
        </View>
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
            <Chip label="All" color={palette.purple} active={filter === 'all'} onPress={() => setFilter('all')} />
            <Chip label="Keeps" color={palette.blue} active={filter === 'keeps'} onPress={() => setFilter('keeps')} />
            <Chip label="Duds" color={palette.red} active={filter === 'duds'} onPress={() => setFilter('duds')} />
          </View>

          {!clips || clips.length === 0 ? (
            <EmptyState
              icon="film-outline"
              title="No clips yet"
              subtitle="Tap the camera to record your first take."
            />
          ) : (
            <FlatList
              data={shown}
              key="project-media-grid"
              keyExtractor={(c) => c.id}
              numColumns={MEDIA_COLUMNS}
              columnWrapperStyle={{ gap: space.md }}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ gap: space.md, paddingBottom: 180 }}
              renderItem={({ item }) => {
                const meta = parseMeta(item.meta_tags);
                const tags = [
                  item.tag === 'talking' ? 'talking' : 'b-roll',
                  ...meta.map((m) => m.value),
                ];
                if (item.expires_at != null) {
                  tags.unshift(`${hoursLeft(item.expires_at)}h left`);
                }
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
                    onLongPress={() => cycleVerdict(item)}
                    onDelete={() => remove(item)}
                  />
                );
              }}
            />
          )}

          <View
            style={{
              position: 'absolute',
              left: space.xl,
              right: space.xl,
              bottom: space.xxl,
              gap: space.sm,
            }}
          >
            <AppText kind="caption" style={{ textAlign: 'center' }}>
              {keeps.length} KEEPER{keeps.length === 1 ? '' : 'S'} READY
            </AppText>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Manual edit"
                  tone="blue"
                  icon="construct"
                  onPress={() =>
                    router.push({
                      pathname: '/edit/[projectId]',
                      params: { projectId: id },
                    })
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="Auto-edit"
                  icon="sparkles"
                  disabled={keeps.length === 0}
                  onPress={finish}
                />
              </View>
            </View>
          </View>
        </>
      )}
    </Screen>
  );
}
