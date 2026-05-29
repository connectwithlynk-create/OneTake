import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  buildCombinedReport,
  clearCrashLog,
  type Breadcrumb,
  LogEntry,
  readCrashLog,
  readJsBreadcrumbs,
  readNativeBreadcrumbs,
} from '@/lib/crash-log';
import { font, palette } from '@/theme';

const SEV_COLOR: Record<LogEntry['sev'], string> = {
  info: palette.text2,
  warn: palette.gold,
  error: palette.coral,
  fatal: palette.coral,
};

export default function DebugCrashScreen() {
  const router = useRouter();
  const [revision, setRevision] = useState(0);
  const entries = useMemo(() => readCrashLog(), [revision]);
  // Most recent first.
  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.ts.localeCompare(a.ts)),
    [entries]
  );
  const persistedTrace = useMemo<Breadcrumb[]>(() => {
    // Merge JS + native crumbs by ts; keep the last 80 entries — this is
    // the "what was happening right before iOS killed us" view.
    const merged = [...readJsBreadcrumbs(), ...readNativeBreadcrumbs()];
    merged.sort((a, b) => a.ts - b.ts);
    return merged.slice(-80);
  }, [revision]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [showTrace, setShowTrace] = useState(true);

  const refresh = useCallback(() => setRevision((r) => r + 1), []);

  const onClear = useCallback(() => {
    Alert.alert(
      'Clear crash log?',
      `Deletes ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from this device. The breadcrumb buffer also resets.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            clearCrashLog();
            refresh();
          },
        },
      ]
    );
  }, [entries.length, refresh]);

  const onShare = useCallback(async () => {
    // Build a single combined report (crash entries + both breadcrumb
    // files in a single time-ordered text file) so the share is one
    // attachment, not three.
    const uri = buildCombinedReport();
    if (!uri) {
      Alert.alert(
        'Nothing to share',
        'No crash log or breadcrumbs on disk yet.'
      );
      return;
    }
    try {
      await Share.share({ url: uri, message: 'OneTake crash report' });
    } catch (e) {
      Alert.alert('Share failed', (e as Error).message);
    }
  }, []);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.head}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={s.headBtn}
        >
          <Ionicons name="chevron-back" size={22} color={palette.text} />
        </Pressable>
        <Text style={s.title}>Crash log</Text>
        <Pressable onPress={refresh} hitSlop={10} style={s.headBtn}>
          <Ionicons name="refresh" size={20} color={palette.text2} />
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, gap: 10 }}
      >
        {persistedTrace.length > 0 ? (
          <View style={s.card}>
            <Pressable
              onPress={() => setShowTrace((v) => !v)}
              style={s.cardHeader}
            >
              <Text style={[s.sev, { color: palette.lime }]}>TRACE</Text>
              <Text style={s.source}>
                last {persistedTrace.length} crumbs (JS + native)
              </Text>
              <Ionicons
                name={showTrace ? 'chevron-down' : 'chevron-forward'}
                size={14}
                color={palette.text3}
              />
            </Pressable>
            {showTrace ? (
              <View style={{ marginTop: 6 }}>
                {persistedTrace.map((b, i) => (
                  <Text key={i} style={s.crumb} selectable>
                    {new Date(b.ts).toLocaleTimeString()} [{b.source}]{' '}
                    {b.msg}
                    {b.data ? ' ' + JSON.stringify(b.data) : ''}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
        {sorted.length === 0 && persistedTrace.length === 0 ? (
          <View style={s.empty}>
            <Ionicons
              name="checkmark-circle-outline"
              size={36}
              color={palette.lime}
            />
            <Text style={s.emptyText}>No crashes recorded.</Text>
            <Text style={s.emptyHint}>
              JS errors, React render crashes, and native NSExceptions land
              here. Persistent breadcrumbs also accumulate during runtime —
              if iOS kills the app silently (jetsam / watchdog / SIGSEGV),
              the last ~80 crumbs survive to the next launch.
            </Text>
          </View>
        ) : null}
        {sorted.map((entry, idx) => (
          <EntryCard
            key={`${entry.ts}-${idx}`}
            entry={entry}
            expanded={!!expanded[idx]}
            onToggle={() =>
              setExpanded((m) => ({ ...m, [idx]: !m[idx] }))
            }
          />
        ))}
      </ScrollView>

      <View style={s.actions}>
        <Pressable style={[s.btn, s.btnGhost]} onPress={onShare}>
          <Ionicons name="share-outline" size={16} color={palette.text} />
          <Text style={s.btnText}>Share log file</Text>
        </Pressable>
        <Pressable
          style={[s.btn, s.btnDanger]}
          onPress={onClear}
          disabled={entries.length === 0}
        >
          <Ionicons name="trash-outline" size={16} color={palette.coral} />
          <Text style={[s.btnText, { color: palette.coral }]}>Clear</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function EntryCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tsShort = new Date(entry.ts).toLocaleTimeString();
  return (
    <Pressable
      style={[
        s.card,
        { borderLeftColor: SEV_COLOR[entry.sev] ?? palette.text2 },
      ]}
      onPress={onToggle}
    >
      <View style={s.cardHeader}>
        <Text
          style={[s.sev, { color: SEV_COLOR[entry.sev] ?? palette.text2 }]}
        >
          {entry.sev.toUpperCase()}
        </Text>
        <Text style={s.source}>{entry.source}</Text>
        <Text style={s.ts}>{tsShort}</Text>
      </View>
      <Text style={s.msg} numberOfLines={expanded ? undefined : 2}>
        {entry.message}
      </Text>
      {expanded ? (
        <View style={{ gap: 8, marginTop: 6 }}>
          {entry.data ? (
            <View>
              <Text style={s.sectionLabel}>data</Text>
              <Text style={s.code} selectable>
                {JSON.stringify(entry.data, null, 2)}
              </Text>
            </View>
          ) : null}
          {entry.stack ? (
            <View>
              <Text style={s.sectionLabel}>stack</Text>
              <Text style={s.code} selectable>
                {entry.stack}
              </Text>
            </View>
          ) : null}
          {entry.breadcrumbs && entry.breadcrumbs.length > 0 ? (
            <View>
              <Text style={s.sectionLabel}>
                breadcrumbs ({entry.breadcrumbs.length})
              </Text>
              {entry.breadcrumbs.slice(-30).map((b, i) => (
                <Text key={i} style={s.crumb} selectable>
                  {new Date(b.ts).toLocaleTimeString()} [{b.source}] {b.msg}
                  {b.data ? ' ' + JSON.stringify(b.data) : ''}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },
  head: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headBtn: { padding: 6 },
  title: {
    flex: 1,
    fontFamily: font.displayHeavy,
    fontSize: 22,
    color: palette.text,
    fontWeight: '800',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 12,
  },
  emptyText: {
    fontFamily: font.bodyBold,
    fontSize: 16,
    color: palette.text,
  },
  emptyHint: {
    fontFamily: font.body,
    fontSize: 12.5,
    color: palette.text2,
    textAlign: 'center',
    lineHeight: 18,
  },
  card: {
    backgroundColor: palette.bg1,
    borderRadius: 10,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  sev: {
    fontFamily: font.monoBold,
    fontSize: 10,
    fontWeight: '700',
  },
  source: {
    flex: 1,
    fontFamily: font.mono,
    fontSize: 11,
    color: palette.text2,
  },
  ts: {
    fontFamily: font.mono,
    fontSize: 11,
    color: palette.text3,
  },
  msg: {
    fontFamily: font.body,
    fontSize: 13,
    color: palette.text,
  },
  sectionLabel: {
    fontFamily: font.monoBold,
    fontSize: 10,
    color: palette.text3,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  code: {
    fontFamily: font.mono,
    fontSize: 11,
    color: palette.text2,
    backgroundColor: palette.bg,
    padding: 8,
    borderRadius: 6,
    lineHeight: 16,
  },
  crumb: {
    fontFamily: font.mono,
    fontSize: 10,
    color: palette.text2,
    lineHeight: 14,
  },
  actions: {
    padding: 12,
    paddingBottom: 18,
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  btnGhost: {
    borderColor: 'rgba(255,255,255,0.12)',
  },
  btnDanger: {
    borderColor: `${palette.coral}66`,
  },
  btnText: {
    fontFamily: font.bodyBold,
    fontSize: 13,
    fontWeight: '700',
    color: palette.text,
  },
});
