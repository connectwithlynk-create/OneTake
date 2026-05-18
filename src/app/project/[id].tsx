import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, View } from 'react-native';

import {
  AppText,
  Button,
  Card,
  Chip,
  Dot,
  EmptyState,
  Header,
  IconButton,
  Loading,
  Screen,
} from '@/components/ui';
import {
  deleteClip,
  getProject,
  listClips,
  setProjectStatus,
  setTag,
  setVerdict,
} from '@/lib/repo';
import { hoursLeft } from '@/lib/ephemeral';
import { invalidate, useData } from '@/lib/store';
import { palette, space, verdictColor, tagColor } from '@/theme';
import type { Clip, Verdict } from '@/lib/types';

const VERDICTS: Verdict[] = ['dud', 'keep', 'perfect'];

function fmt(ms: number) {
  const s = Math.round(ms / 1000);
  return `0:${s.toString().padStart(2, '0')}`;
}

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

  async function pickVerdict(c: Clip, v: Verdict) {
    if (c.verdict === v) return;
    await setVerdict(c.id, v);
    invalidate();
  }
  async function toggleTag(c: Clip) {
    await setTag(c.id, c.tag === 'talking' ? 'broll' : 'talking');
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
              keyExtractor={(c) => c.id}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ gap: space.md, paddingBottom: 180 }}
              renderItem={({ item }) => (
                <Card accent={verdictColor[item.verdict]}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                      <Dot color={verdictColor[item.verdict]} />
                      <AppText kind="subtitle">
                        Take {item.order_index + 1}
                      </AppText>
                      <AppText kind="dim">· {fmt(item.duration_ms)}</AppText>
                    </View>
                    <IconButton name="trash" tone="clear" color={palette.red} onPress={() => remove(item)} />
                  </View>

                  <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
                    {VERDICTS.map((v) => (
                      <Chip
                        key={v}
                        label={v}
                        color={verdictColor[v]}
                        active={item.verdict === v}
                        onPress={() => pickVerdict(item, v)}
                      />
                    ))}
                  </View>

                  <View style={{ flexDirection: 'row', marginTop: space.sm }}>
                    <Chip
                      label={item.tag === 'talking' ? 'Talking' : 'B-roll'}
                      color={tagColor[item.tag]}
                      active
                      onPress={() => toggleTag(item)}
                    />
                    {(item.verdict_overridden === 1 || item.tag_overridden === 1) && (
                      <View style={{ justifyContent: 'center', marginLeft: space.sm }}>
                        <AppText kind="caption">EDITED</AppText>
                      </View>
                    )}
                  </View>

                  {item.expires_at != null && (
                    <AppText
                      kind="caption"
                      style={{ marginTop: space.sm, color: palette.red }}
                    >
                      DISAPPEARS IN {hoursLeft(item.expires_at)}H · KEEP IT TO
                      SAVE
                    </AppText>
                  )}
                </Card>
              )}
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
