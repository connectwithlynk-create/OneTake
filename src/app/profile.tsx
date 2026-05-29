import { useClerk, useUser } from '@clerk/expo';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, Header, MonoLabel, Screen } from '@/components/ui';
import { font, palette } from '@/theme';

export default function ProfileScreen() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    '';
  const name = user?.fullName || user?.firstName || 'Your account';
  const initial = (name[0] ?? email[0] ?? '?').toUpperCase();

  async function doSignOut() {
    if (busy) return;
    setBusy(true);
    try {
      await signOut();
      router.replace('/sign-in');
    } catch {
      setBusy(false);
    }
  }

  const rows: { ic: keyof typeof rowIcons; l: string; s?: string }[] = [
    { ic: 'bell', l: 'Notifications', s: 'On' },
    { ic: 'video', l: 'Default capture mode', s: 'Talking-head' },
    { ic: 'lock', l: 'Privacy & server delete' },
    { ic: 'chat', l: 'Send feedback' },
  ];

  return (
    <Screen scroll pad={false}>
      <Header title="Account" back />

      <View style={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 22 }}>
        <Card padding={22} style={{ alignItems: 'center', gap: 14 }}>
          {user?.imageUrl ? (
            <Image source={{ uri: user.imageUrl }} style={s.avatar} contentFit="cover" />
          ) : (
            <View style={[s.avatar, s.avatarFallback]}>
              <Text style={s.avatarText}>{initial}</Text>
            </View>
          )}
          <View style={{ alignItems: 'center' }}>
            <Text style={s.name}>{name}</Text>
            {email ? <Text style={s.email}>{email}</Text> : null}
          </View>
        </Card>
      </View>

      <View style={{ paddingHorizontal: 18, paddingBottom: 18 }}>
        <Card accent={palette.cyan} padding={18}>
          <MonoLabel color={palette.cyan}>MEMORIES · CLOUD SYNC</MonoLabel>
          <Text style={s.cardBody}>
            Saved clips back up to your account and restore on any device you
            sign in to. Ephemeral takes stay on this device only.
          </Text>
          <View style={s.syncRow}>
            <View style={[s.dot, { backgroundColor: palette.cyan }]} />
            <Text style={[s.mono, { color: palette.cyan }]}>147 clips synced</Text>
            <Text style={[s.mono, { marginLeft: 'auto', color: palette.text3 }]}>2.1 GB</Text>
          </View>
        </Card>
      </View>

      <View style={{ paddingHorizontal: 18, gap: 8 }}>
        {rows.map((r) => (
          <View key={r.l} style={s.row}>
            <View style={s.rowIcon}>
              <Text style={{ fontSize: 14 }}>{rowIcons[r.ic]}</Text>
            </View>
            <Text style={s.rowLabel}>{r.l}</Text>
            {r.s ? <Text style={s.rowSub}>{r.s}</Text> : null}
            <Text style={s.rowChev}>›</Text>
          </View>
        ))}
      </View>

      <View style={{ paddingHorizontal: 18, paddingTop: 24, gap: 10 }}>
        <Button
          label="Debug: analyze reel"
          tone="ghost"
          icon="bug"
          full
          onPress={() => router.push('/debug-analyze')}
        />
        <Button
          label="Crash log"
          tone="ghost"
          icon="warning-outline"
          full
          onPress={() => router.push('/debug-crash')}
        />
      </View>

      <View style={{ paddingHorizontal: 18, paddingVertical: 30 }}>
        <Button
          label="Sign out"
          tone="danger"
          icon="log-out-outline"
          full
          disabled={busy}
          onPress={doSignOut}
        />
      </View>
    </Screen>
  );
}

const rowIcons = {
  bell: '🔔',
  video: '🎬',
  lock: '🔒',
  chat: '💬',
} as const;

const s = StyleSheet.create({
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: palette.lime,
    backgroundColor: palette.magenta,
  },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarText: {
    color: '#fff',
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 30,
  },
  name: {
    fontFamily: font.displayHeavy,
    fontWeight: '700',
    fontSize: 20,
    color: '#fff',
  },
  email: { marginTop: 2, fontFamily: font.body, fontSize: 13, color: palette.text3 },
  cardBody: {
    fontFamily: font.body,
    fontSize: 13.5,
    color: palette.text2,
    marginTop: 8,
    lineHeight: 19,
  },
  syncRow: { marginTop: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  mono: {
    fontFamily: font.monoBold,
    fontSize: 12,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: palette.bg1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: { flex: 1, fontFamily: font.bodyBold, fontSize: 14, fontWeight: '600', color: '#fff' },
  rowSub: { fontFamily: font.body, fontSize: 12, color: palette.text3 },
  rowChev: { fontSize: 18, color: '#555', marginLeft: 4 },
});
