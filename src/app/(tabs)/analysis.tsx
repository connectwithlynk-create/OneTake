import { useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText, Card, EmptyState, Loading, Screen } from '@/components/ui';
import { getAnalytics } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { palette, space, verdictColor } from '@/theme';

function StatTile({
  label,
  value,
  color = palette.purple,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={{ width: '47%' }}>
      <Card>
        <AppText kind="hero" style={{ color }}>
          {value}
        </AppText>
        <AppText kind="caption" style={{ marginTop: space.xs }}>
          {label.toUpperCase()}
        </AppText>
      </Card>
    </View>
  );
}

/** A single proportional segmented bar. */
function Bar({
  parts,
}: {
  parts: { value: number; color: string; label: string }[];
}) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          height: 16,
          borderRadius: 999,
          overflow: 'hidden',
          backgroundColor: palette.surfaceHi,
        }}
      >
        {parts.map(
          (p) =>
            p.value > 0 && (
              <View
                key={p.label}
                style={{ flex: p.value / total, backgroundColor: p.color }}
              />
            )
        )}
      </View>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: space.md,
          marginTop: space.md,
        }}
      >
        {parts.map((p) => (
          <View
            key={p.label}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: p.color,
              }}
            />
            <AppText kind="dim">
              {p.label} {p.value}
            </AppText>
          </View>
        ))}
      </View>
    </>
  );
}

export default function AnalysisScreen() {
  const { data: a, loading } = useData(getAnalytics);

  useFocusEffect(
    useCallback(() => {
      invalidate();
    }, [])
  );

  if (loading && !a) return <Screen><Loading /></Screen>;
  if (!a || a.clips === 0) {
    return (
      <Screen>
        <View style={{ paddingTop: space.lg, paddingBottom: space.lg }}>
          <AppText kind="hero">Analysis</AppText>
        </View>
        <EmptyState
          icon="stats-chart-outline"
          title="Nothing to analyze yet"
          subtitle="Record some clips and your stats show up here."
        />
      </Screen>
    );
  }

  const mins = Math.round(a.totalFootageMs / 60000);
  const secs = Math.round((a.totalFootageMs % 60000) / 1000);
  const keepPct = a.clips ? Math.round((a.keepers / a.clips) * 100) : 0;

  return (
    <Screen>
      <View style={{ paddingTop: space.lg, paddingBottom: space.lg }}>
        <AppText kind="hero">Analysis</AppText>
        <AppText kind="dim" style={{ marginTop: space.xs }}>
          On-device, across everything you have shot.
        </AppText>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: space.xxl, gap: space.md }}
      >
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: space.md,
            justifyContent: 'space-between',
          }}
        >
          <StatTile label="Projects" value={`${a.projects}`} />
          <StatTile label="Clips" value={`${a.clips}`} color={palette.blue} />
          <StatTile
            label="Keeper rate"
            value={`${keepPct}%`}
            color={palette.yellow}
          />
          <StatTile
            label="Footage"
            value={mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
            color={palette.purple}
          />
        </View>

        <Card>
          <AppText kind="caption" style={{ marginBottom: space.md }}>
            VERDICT BREAKDOWN
          </AppText>
          <Bar
            parts={[
              { value: a.verdicts.perfect, color: verdictColor.perfect, label: 'Perfect' },
              { value: a.verdicts.keep, color: verdictColor.keep, label: 'Keep' },
              { value: a.verdicts.dud, color: verdictColor.dud, label: 'Dud' },
            ]}
          />
        </Card>

        <Card>
          <AppText kind="caption" style={{ marginBottom: space.md }}>
            TALKING VS B-ROLL
          </AppText>
          <Bar
            parts={[
              { value: a.tags.talking, color: palette.purple, label: 'Talking' },
              { value: a.tags.broll, color: palette.blue, label: 'B-roll' },
            ]}
          />
        </Card>

        <Card accent={palette.yellow}>
          <AppText kind="caption">RATING TRUST</AppText>
          <AppText kind="title" style={{ marginTop: space.xs }}>
            {Math.round(a.verdictOverrideRate * 100)}% verdicts overridden
          </AppText>
          <AppText kind="dim" style={{ marginTop: space.xs }}>
            {Math.round(a.tagOverrideRate * 100)}% of tags were corrected by
            hand. Lower means the on-device rating is trusted (PRD success
            metric).
          </AppText>
        </Card>

        <View
          style={{
            flexDirection: 'row',
            gap: space.md,
            justifyContent: 'space-between',
          }}
        >
          <StatTile
            label="Collections"
            value={`${a.collections}`}
            color={palette.blue}
          />
          <StatTile
            label="Saved reels"
            value={`${a.reels}`}
            color={palette.yellow}
          />
        </View>

        <Card>
          <AppText kind="caption" style={{ marginBottom: space.sm }}>
            PROJECT STATUS
          </AppText>
          {(['recording', 'processing', 'ready'] as const).map((k) => (
            <View
              key={k}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                paddingVertical: 6,
              }}
            >
              <AppText kind="body" style={{ textTransform: 'capitalize' }}>
                {k}
              </AppText>
              <AppText kind="subtitle">{a.projectsByStatus[k]}</AppText>
            </View>
          ))}
        </Card>
      </ScrollView>
    </Screen>
  );
}
