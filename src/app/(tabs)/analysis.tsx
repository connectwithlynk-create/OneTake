import { useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  Card,
  EmptyState,
  Hero,
  Loading,
  MonoLabel,
  Screen,
  StatusPill,
} from '@/components/ui';
import { getAnalytics } from '@/lib/repo';
import { invalidate, useData } from '@/lib/store';
import { font, palette, verdictColor } from '@/theme';

function StatTile({
  label,
  value,
  color = palette.lime,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={s.statTile}>
      <Text style={[s.statValue, { color }]}>{value}</Text>
      <MonoLabel style={{ marginTop: 8 }}>{label.toUpperCase()}</MonoLabel>
    </View>
  );
}

function Bar({
  parts,
}: {
  parts: { value: number; color: string; label: string }[];
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0) || 1;
  return (
    <>
      <View style={s.bar}>
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
      <View style={s.legend}>
        {parts.map((p) => (
          <View key={p.label} style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: p.color }]} />
            <Text style={s.legendLabel}>
              {p.label}{' '}
              <Text style={[s.legendValue, { color: '#fff' }]}>{p.value}</Text>
            </Text>
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
      <Screen pad={false}>
        <Hero title="Analysis" />
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
  const overrideTrend = mockTrend(a.verdictOverrideRate);

  return (
    <Screen pad={false}>
      <Hero title="Analysis" sub="On-device, across everything you've shot." />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 18,
          paddingBottom: 130,
          gap: 10,
        }}
      >
        <View style={s.statGrid}>
          <StatTile label="Projects" value={`${a.projects}`} color={palette.lime} />
          <StatTile label="Clips" value={`${a.clips}`} color={palette.cyan} />
          <StatTile
            label="Keeper rate"
            value={`${keepPct}%`}
            color={palette.gold}
          />
          <StatTile
            label="Footage"
            value={mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
            color={palette.magenta}
          />
        </View>

        <Card padding={16} style={{ marginTop: 4 }}>
          <MonoLabel style={{ marginBottom: 14 }}>VERDICT BREAKDOWN</MonoLabel>
          <Bar
            parts={[
              { value: a.verdicts.perfect, color: verdictColor.perfect, label: 'Perfect' },
              { value: a.verdicts.keep, color: verdictColor.keep, label: 'Keep' },
              { value: a.verdicts.dud, color: verdictColor.dud, label: 'Dud' },
            ]}
          />
        </Card>

        <Card padding={16}>
          <MonoLabel style={{ marginBottom: 14 }}>TALKING VS B-ROLL</MonoLabel>
          <Bar
            parts={[
              { value: a.tags.talking, color: palette.magenta, label: 'Talking' },
              { value: a.tags.broll, color: palette.violet, label: 'B-roll' },
            ]}
          />
        </Card>

        <Card accent={palette.gold} padding={16}>
          <MonoLabel color={palette.gold}>RATING TRUST</MonoLabel>
          <Text style={s.trustHero}>
            {Math.round(a.verdictOverrideRate * 100)}% verdicts overridden
          </Text>
          <Text style={s.trustBody}>
            {Math.round(a.tagOverrideRate * 100)}% of tags were corrected by
            hand. Lower means the on-device rating is trusted.
          </Text>
          <View style={s.sparkRow}>
            {overrideTrend.map((v, i) => (
              <View
                key={i}
                style={{
                  flex: 1,
                  height: `${v}%`,
                  marginHorizontal: 1.5,
                  borderRadius: 2,
                  backgroundColor:
                    i === overrideTrend.length - 1
                      ? palette.gold
                      : `${palette.gold}55`,
                }}
              />
            ))}
          </View>
        </Card>

        <View style={s.statGrid}>
          <StatTile label="Collections" value={`${a.collections}`} color={palette.cyan} />
          <StatTile label="Saved reels" value={`${a.reels}`} color={palette.gold} />
        </View>

        <Card padding={16}>
          <MonoLabel style={{ marginBottom: 10 }}>PROJECT STATUS</MonoLabel>
          {(['recording', 'processing', 'ready'] as const).map((k, i) => (
            <View
              key={k}
              style={[s.statusRow, i === 0 ? null : s.statusRowDiv]}
            >
              <StatusPill s={k} />
              <Text style={s.statusCount}>{a.projectsByStatus[k]}</Text>
            </View>
          ))}
        </Card>
      </ScrollView>
    </Screen>
  );
}

function mockTrend(current: number): number[] {
  const target = Math.round(current * 100) || 8;
  return [40, 35, 30, 32, 25, 22, 18, 16, 14, 12, 11, target + 1, target];
}

const s = StyleSheet.create({
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  statTile: {
    flex: 1,
    minWidth: '47%',
    padding: 14,
    borderRadius: 16,
    backgroundColor: palette.bg1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  statValue: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 32,
    letterSpacing: -1,
    lineHeight: 32,
  },
  bar: {
    height: 14,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: palette.bg2,
    flexDirection: 'row',
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    marginTop: 12,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { fontFamily: font.body, fontSize: 12, color: palette.text2 },
  legendValue: { fontFamily: font.monoBold, fontWeight: '700' },
  trustHero: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 24,
    color: '#fff',
    marginTop: 6,
    letterSpacing: -0.6,
  },
  trustBody: {
    fontFamily: font.body,
    fontSize: 13,
    color: palette.text2,
    marginTop: 6,
    lineHeight: 19,
  },
  sparkRow: {
    marginTop: 14,
    height: 32,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  statusRowDiv: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  statusCount: {
    fontFamily: font.displayHeavy,
    fontWeight: '700',
    fontSize: 18,
    color: '#fff',
  },
});
