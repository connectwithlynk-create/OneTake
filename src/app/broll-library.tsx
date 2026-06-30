import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Button, EmptyState, Header, Loading, Screen } from '@/components/ui';
import { useGoogleDrive } from '@/hooks/use-google-drive';
import {
  crawlCloudMediaLibrary,
  ensureCloudMediaLibrary,
  uploadMediaToCloudLibrary,
} from '@/lib/media-crawler';
import {
  listMediaLibraryRoots,
  searchMediaSegments,
  type MediaSegmentSearchResult,
} from '@/lib/media-library';
import { invalidate, useData } from '@/lib/store';
import type { MediaLibraryRoot } from '@/lib/types';
import { fmtDuration, relativeAge } from '@/lib/time';
import { font, palette } from '@/theme';

export default function BrollLibraryScreen() {
  const drive = useGoogleDrive();
  const { data: roots, loading } = useData(listMediaLibraryRoots);
  const [root, setRoot] = useState<MediaLibraryRoot | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [results, setResults] = useState<MediaSegmentSearchResult[]>([]);

  const activeRoot = root ?? roots?.find((r) => r.provider === 'google_drive') ?? null;
  const configured = drive.configured;

  const runSearch = useCallback(async (q: string) => {
    const rows = await searchMediaSegments(q, { kind: 'video', limit: 60 });
    setResults(rows);
  }, []);

  useEffect(() => {
    void runSearch(query);
  }, [query, runSearch]);

  async function connect() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const provider = drive.provider ?? (await drive.connect());
      if (!provider) return;
      const ensured = await ensureCloudMediaLibrary(provider);
      setRoot(ensured.root);
      setMessage(`Connected ${ensured.folder.name}.`);
      invalidate();
      await crawl(provider, ensured.root);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function crawl(providerArg = drive.provider, rootArg = activeRoot) {
    if (!providerArg || !rootArg) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await crawlCloudMediaLibrary(providerArg, rootArg);
      setRoot(res.root);
      setMessage(`Indexed ${res.indexed} media file${res.indexed === 1 ? '' : 's'}.`);
      invalidate();
      await runSearch(query);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function importMedia() {
    if (!drive.provider || !activeRoot || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos', 'images'],
        allowsMultipleSelection: true,
        quality: 1,
      });
      if (picked.canceled) return;
      for (const asset of picked.assets) {
        await uploadMediaToCloudLibrary(drive.provider, activeRoot, {
          uri: asset.uri,
          name: asset.fileName ?? `onetake-${Date.now()}`,
          mimeType:
            asset.mimeType ??
            (asset.type === 'image' ? 'image/jpeg' : 'video/mp4'),
        });
      }
      setMessage(`Imported ${picked.assets.length} file${picked.assets.length === 1 ? '' : 's'}.`);
      invalidate();
      await runSearch(query);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  const statusText = useMemo(() => {
    if (!configured) return 'Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID to connect Google Drive.';
    if (!drive.provider) return 'Connect Google Drive to create your OneTake Library folder.';
    if (!activeRoot) return 'Drive connected. Create or find your OneTake Library folder.';
    return `${activeRoot.provider_root_name} · ${activeRoot.status}`;
  }, [activeRoot, configured, drive.provider]);

  return (
    <Screen pad={false}>
      <Header title="B-roll Library" back />

      <View style={s.connectPanel}>
        <View style={{ flex: 1 }}>
          <Text style={s.panelTitle}>Google Drive</Text>
          <Text style={s.panelSub}>{statusText}</Text>
          {drive.error ? <Text style={s.error}>{drive.error}</Text> : null}
          {message ? <Text style={s.message}>{message}</Text> : null}
        </View>
        <Button
          label={drive.provider || activeRoot ? 'Sync' : 'Connect'}
          icon={drive.provider || activeRoot ? 'sync' : 'logo-google'}
          tone="cyan"
          disabled={!configured || busy}
          onPress={() => {
            if (drive.provider && activeRoot) void crawl();
            else void connect();
          }}
        />
      </View>

      <View style={s.actions}>
        <Button
          label="Import"
          icon="cloud-upload-outline"
          tone="primary"
          disabled={!drive.provider || !activeRoot || busy}
          onPress={importMedia}
        />
        <View style={s.searchBox}>
          <Ionicons name="search" size={16} color={palette.text3} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search b-roll"
            placeholderTextColor={palette.text3}
            style={s.searchInput}
            autoCapitalize="none"
          />
        </View>
      </View>

      {busy || loading ? (
        <Loading />
      ) : results.length === 0 ? (
        <EmptyState
          icon="film-outline"
          title="No b-roll indexed"
          subtitle="Connect Drive, import media, or sync the OneTake Library folder."
        />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 120, gap: 10 }}
          renderItem={({ item }) => <SegmentRow item={item} />}
        />
      )}
    </Screen>
  );
}

function SegmentRow({ item }: { item: MediaSegmentSearchResult }) {
  return (
    <Pressable
      style={s.row}
      onPress={() => {
        Alert.alert(
          item.asset_name,
          `${item.provider}\n${item.provider_file_id}\n${fmtDuration(item.start_ms)} - ${fmtDuration(item.end_ms)}`
        );
      }}
    >
      <View style={s.thumb}>
        <Ionicons name="film" size={22} color={palette.violet} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {item.description || item.asset_name}
        </Text>
        <Text style={s.rowMeta} numberOfLines={1}>
          {item.asset_name} · {fmtDuration(item.end_ms - item.start_ms)}
        </Text>
        <Text style={s.rowMeta} numberOfLines={1}>
          {relativeAge(item.updated_at)} ago · Drive
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={palette.text3} />
    </Pressable>
  );
}

function showError(e: unknown) {
  const msg = (e as { message?: string })?.message ?? 'Something went wrong.';
  Alert.alert('B-roll library', msg);
}

const s = StyleSheet.create({
  connectPanel: {
    marginHorizontal: 18,
    marginTop: 8,
    marginBottom: 14,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.bg1,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  panelTitle: {
    fontFamily: font.displayHeavy,
    fontSize: 18,
    color: palette.text,
  },
  panelSub: {
    marginTop: 4,
    fontFamily: font.body,
    fontSize: 12.5,
    color: palette.text2,
  },
  error: {
    marginTop: 6,
    fontFamily: font.monoBold,
    fontSize: 10,
    color: palette.coral,
  },
  message: {
    marginTop: 6,
    fontFamily: font.monoBold,
    fontSize: 10,
    color: palette.lime,
  },
  actions: {
    paddingHorizontal: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  searchBox: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.bg1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontFamily: font.body,
    color: palette.text,
    fontSize: 14,
    padding: 0,
  },
  row: {
    minHeight: 76,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.bg1,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  thumb: {
    width: 52,
    height: 56,
    borderRadius: 10,
    backgroundColor: `${palette.violet}18`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: {
    fontFamily: font.bodyBold,
    fontSize: 14,
    color: palette.text,
  },
  rowMeta: {
    marginTop: 3,
    fontFamily: font.body,
    fontSize: 11.5,
    color: palette.text3,
  },
});
