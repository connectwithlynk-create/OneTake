import { useClerk, useUser } from '@clerk/expo';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';

import { AppText, Button, Card, Header, Screen } from '@/components/ui';
import { palette, radius, space } from '@/theme';

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
      // The auth gate redirects to /sign-in once signed out.
      router.replace('/sign-in');
    } catch {
      setBusy(false);
    }
  }

  return (
    <Screen scroll>
      <Header title="Account" back />

      <Card>
        <View style={{ alignItems: 'center', gap: space.md }}>
          {user?.imageUrl ? (
            <Image source={{ uri: user.imageUrl }} style={styles.avatar} contentFit="cover" />
          ) : (
            <View style={[styles.avatar, styles.fallback]}>
              <AppText kind="hero" style={{ color: palette.purple }}>
                {initial}
              </AppText>
            </View>
          )}
          <View style={{ alignItems: 'center' }}>
            <AppText kind="subtitle">{name}</AppText>
            {email ? (
              <AppText kind="dim" style={{ marginTop: space.xs }}>
                {email}
              </AppText>
            ) : null}
          </View>
        </View>
      </Card>

      <View style={{ height: space.xl }} />

      <Card accent={palette.purple}>
        <AppText kind="caption">MEMORIES</AppText>
        <AppText kind="dim" style={{ marginTop: space.sm }}>
          Saved clips back up to your account and restore on any device you
          sign in to. Ephemeral takes stay on this device only.
        </AppText>
      </Card>

      <View style={{ height: space.xl }} />

      <Button
        label="Sign out"
        tone="danger"
        icon="log-out"
        disabled={busy}
        onPress={doSignOut}
      />
    </Screen>
  );
}

const styles = {
  avatar: {
    width: 84,
    height: 84,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: palette.purple,
    backgroundColor: palette.surfaceHi,
  },
  fallback: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
};
