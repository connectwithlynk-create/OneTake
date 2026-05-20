import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ClipVideo } from '@/components/clip-video';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  IconButton,
  Loading,
  MonoLabel,
  Screen,
  StatusPill,
  TagPill,
  VerdictPill,
} from '@/components/ui';
import {
  deleteClip,
  getProject,
  listClips,
  renameProject,
  setProjectStatus,
  setVerdict,
} from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { fmtDuration } from '@/lib/time';
import type { Clip, Verdict } from '@/lib/types';
import { font, palette, verdictColor } from '@/theme';

const VERDICT_CYCLE: Verdict[] = ['dud', 'keep', 'perfect'];

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [filter, setFilter] = useState<'all' | 'keeps' | 'duds'>('all');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');

  const { data: project, loading: lp } = useData(() => getProject(id), [id]);
  const { data: clips, loading: lc } = useData(() => listClips(id), [id]);

  if (lp || lc || !project) return <Screen><Loading /></Screen>;

  const isPrompt = project.type === 'prompt';
  const all = clips ?? [];
  const keeps = all.filter((c) => c.verdict !== 'dud');
  const duds = all.filter((c) => c.verdict === 'dud');
  const shown =
    filter === 'all' ? all : filter === 'keeps' ? keeps : duds;

  async function cycleVerdict(c: Clip) {
    const next = VERDICT_CYCLE[(VERDICT_CYCLE.indexOf(c.verdict) + 1) % 3];
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

  function startEditTitle() {
    setTitleInput(project!.title);
    setEditingTitle(true);
  }
  async function saveTitle() {
    await renameProject(id, titleInput);
    invalidate();
    setEditingTitle(false);
  }

  const usableMs = keeps.reduce((sum, c) => sum + c.duration_ms, 0);

  return (
    <Screen pad={false}>
      <View style={s.topRow}>
        <IconButton name="chevron-back" tone="surface" size={36} onPress={() => router.back()} />
        {!isPrompt ? (
          <IconButton
            name="videocam"
            tone="accent"
            size={36}
            onPress={() =>
              router.push({
                pathname: '/capture/[projectId]',
                params: { projectId: id },
              })
            }
          />
        ) : (
          <View style={{ width: 36 }} />
        )}
      </View>

      <View style={{ paddingHorizontal: 22, paddingTop: 6, paddingBottom: 6 }}>
        <StatusPill s={project.status} />
      </View>

      <View style={s.titleBar}>
        {editingTitle ? (
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TextInput
              value={titleInput}
              onChangeText={setTitleInput}
              autoFocus
              placeholder={project.title}
              placeholderTextColor={palette.text3}
              style={s.titleInput}
              onSubmitEditing={saveTitle}
              returnKeyType="done"
            />
            <IconButton name="checkmark" tone="accent" size={36} onPress={saveTitle} />
          </View>
        ) : (
          <Pressable style={s.titleRow} onPress={startEditTitle}>
            <Text style={s.title} numberOfLines={1}>
              {project.title}
            </Text>
            <Ionicons name="pencil-outline" size={14} color={palette.text3} />
          </Pressable>
        )}
      </View>

      {isPrompt ? (
        <View style={{ paddingHorizontal: 18, gap: 14, flex: 1 }}>
          <Card accent={palette.gold} padding={18}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Ionicons name="sparkles" size={14} color={palette.gold} />
              <MonoLabel color={palette.gold}>PROMPT</MonoLabel>
            </View>
            <Text style={s.promptText}>
              {project.prompt
                ? `"${project.prompt}"`
                : 'No prompt set. Tap below to add one.'}
            </Text>
          </Card>

          <View style={{ marginTop: 'auto', paddingBottom: 30 }}>
            <Button
              label="Generate video"
              tone="gold"
              icon="sparkles"
              size="lg"
              full
              onPress={finish}
            />
          </View>
        </View>
      ) : (
        <>
          <View style={s.filters}>
            <Chip
              label={`All · ${all.length}`}
              color={palette.lime}
              active={filter === 'all'}
              onPress={() => setFilter('all')}
            />
            <Chip
              label={`Keeps · ${keeps.length}`}
              color={palette.cyan}
              active={filter === 'keeps'}
              onPress={() => setFilter('keeps')}
            />
            <Chip
              label={`Duds · ${duds.length}`}
              color={palette.coral}
              active={filter === 'duds'}
              onPress={() => setFilter('duds')}
            />
          </View>

          {all.length === 0 ? (
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
              numColumns={2}
              columnWrapperStyle={{ gap: 10 }}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{
                paddingHorizontal: 18,
                paddingBottom: 180,
                gap: 10,
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
                  onLongPress={() => cycleVerdict(item)}
                  onDelete={() => remove(item)}
                />
              )}
            />
          )}

          <View style={s.actionDock}>
            <MonoLabel style={{ textAlign: 'center', marginBottom: 10 }}>
              {keeps.length} KEEPER{keeps.length === 1 ? '' : 'S'} ·{' '}
              {fmtDuration(usableMs)} USABLE FOOTAGE
            </MonoLabel>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Manual edit"
                  tone="ghost"
                  full
                  icon="reorder-three"
                  onPress={() =>
                    router.push({
                      pathname: '/edit/[projectId]',
                      params: { projectId: id },
                    })
                  }
                />
              </View>
              <View style={{ flex: 1.2 }}>
                <Button
                  label="Auto-edit"
                  icon="sparkles"
                  full
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

function ClipTile({
  clip,
  onPress,
  onLongPress,
  onDelete,
}: {
  clip: Clip;
  onPress: () => void;
  onLongPress: () => void;
  onDelete: () => void;
}) {
  const accent = verdictColor[clip.verdict];
  const isDud = clip.verdict === 'dud';
  return (
    <Pressable
      style={[
        s.tile,
        {
          borderColor: `${accent}55`,
          opacity: isDud ? 0.55 : 1,
        },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
    >
      <View style={{ flex: 1 }}>
        <ClipVideo uri={clip.file_uri} style={StyleSheet.absoluteFillObject} />
        <View style={s.tileTopRow}>
          <VerdictPill v={clip.verdict} />
        </View>
        <Pressable style={s.tileDelete} onPress={onDelete} hitSlop={8}>
          <Ionicons name="trash" size={11} color="#fff" />
        </Pressable>
        <View style={s.tileGradient}>
          <Text style={s.tileTitle} numberOfLines={1}>
            {clip.name ?? `Take ${clip.order_index + 1}`}
          </Text>
          <View style={s.tileBottomRow}>
            <TagPill t={clip.tag} />
            <Text style={s.tileDuration}>{fmtDuration(clip.duration_ms)}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  topRow: {
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleBar: {
    paddingHorizontal: 22,
    paddingBottom: 18,
    flexDirection: 'row',
    alignItems: 'center',
  },
  titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: {
    flex: 1,
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 30,
    color: '#fff',
    letterSpacing: -0.9,
    lineHeight: 32,
  },
  titleInput: {
    flex: 1,
    backgroundColor: palette.bg1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    color: '#fff',
    fontFamily: font.displayHeavy,
    fontSize: 22,
    fontWeight: '800',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  promptText: {
    fontFamily: font.body,
    fontSize: 15,
    color: '#fff',
    lineHeight: 22,
    fontWeight: '500',
  },
  filters: { paddingHorizontal: 18, paddingBottom: 12, flexDirection: 'row', gap: 8 },
  tile: {
    flex: 1,
    maxWidth: '49%',
    aspectRatio: 9 / 14,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1.5,
    backgroundColor: palette.bg1,
  },
  tileTopRow: { position: 'absolute', top: 6, left: 6 },
  tileDelete: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 8,
    paddingTop: 20,
    paddingBottom: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  tileTitle: {
    fontFamily: font.bodyBold,
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },
  tileBottomRow: {
    marginTop: 2,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tileDuration: {
    fontFamily: font.monoBold,
    fontSize: 10,
    color: '#fff',
  },
  actionDock: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 40,
    padding: 14,
    borderRadius: 20,
    backgroundColor: 'rgba(11,11,20,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
});
