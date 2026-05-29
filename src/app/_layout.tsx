import { ClerkProvider, useAuth } from '@clerk/expo';
import { resourceCache } from '@clerk/expo/resource-cache';
import { tokenCache } from '@clerk/expo/token-cache';
import {
  BricolageGrotesque_700Bold,
  BricolageGrotesque_800ExtraBold,
  useFonts as useBricolage,
} from '@expo-google-fonts/bricolage-grotesque';
import {
  GeistMono_500Medium,
  GeistMono_700Bold,
  useFonts as useGeist,
} from '@expo-google-fonts/geist-mono';
import {
  Outfit_500Medium,
  Outfit_700Bold,
  useFonts as useOutfit,
} from '@expo-google-fonts/outfit';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { attachNativeErrorListener } from '../../modules/nle-player';
import { crumb, initCrashLog, recordError } from '@/lib/crash-log';
import { gcExpiredClips } from '@/lib/repo';
import { invalidate } from '@/lib/store';
import { runSync } from '@/lib/sync';
import { palette } from '@/theme';

// One-shot: install the JS-side global error handler before any other
// module imports run code. Sits at module top-level so it executes once
// per JS context, before React mounts.
initCrashLog();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: palette.bg,
    card: palette.bg,
    text: palette.text,
    primary: palette.purple,
    border: palette.border,
  },
};

const clerkKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

function Nav() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: palette.bg },
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="profile" options={{ presentation: 'modal' }} />
      <Stack.Screen name="new-project" />
      <Stack.Screen name="inspiration-add" options={{ presentation: 'modal' }} />
      <Stack.Screen name="project/[id]" />
      <Stack.Screen
        name="edit/[projectId]"
        options={{ gestureEnabled: false, fullScreenGestureEnabled: false }}
      />
      <Stack.Screen name="capture/[projectId]" />
      <Stack.Screen name="player" options={{ presentation: 'modal' }} />
      <Stack.Screen name="prompt" />
      <Stack.Screen name="preview/[projectId]" />
      <Stack.Screen name="collection/[id]" />
      <Stack.Screen name="swipe/[collectionId]" />
      <Stack.Screen
        name="debug-crash"
        options={{ presentation: 'modal', title: 'Crash log' }}
      />
    </Stack>
  );
}

/** Redirects on auth state and kicks a Memories sync once signed in. */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded) return;
    const onAuthScreen = segments[0] === 'sign-in';
    if (!isSignedIn && !onAuthScreen) router.replace('/sign-in');
    else if (isSignedIn && onAuthScreen) router.replace('/');
  }, [isLoaded, isSignedIn, segments, router]);

  useEffect(() => {
    if (isSignedIn && userId) {
      runSync(userId)
        .then((r) => {
          if (r.pulled > 0 || r.downloaded > 0) invalidate();
        })
        .catch(() => {});
    }
  }, [isSignedIn, userId]);

  return <>{children}</>;
}

export default function RootLayout() {
  // Sweep expired ephemeral takes once on launch, then refresh the UI.
  useEffect(() => {
    gcExpiredClips()
      .then((n) => {
        if (n > 0) invalidate();
      })
      .catch(() => {});
  }, []);

  // Funnel native-side errors from the NLE player (caught throws inside
  // the composition build, etc.) into the same crash-log JS errors
  // already write to. Uncaught NSExceptions are written directly by the
  // module's NSSetUncaughtExceptionHandler — see NlePlayerModule.swift.
  useEffect(() => {
    crumb('app', 'boot');
    const detach = attachNativeErrorListener((ev) => {
      recordError(
        new Error(ev.message ?? 'native error'),
        ev.source ?? 'native',
        ev.detail ? { detail: ev.detail } : undefined
      );
    });
    return () => detach();
  }, []);

  const [bricolage] = useBricolage({
    BricolageGrotesque_700Bold,
    BricolageGrotesque_800ExtraBold,
  });
  const [outfit] = useOutfit({ Outfit_500Medium, Outfit_700Bold });
  const [geist] = useGeist({ GeistMono_500Medium, GeistMono_700Bold });
  const fontsReady = bricolage && outfit && geist;

  if (!fontsReady) {
    return <View style={{ flex: 1, backgroundColor: palette.bg }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={navTheme}>
        <StatusBar style="light" />
        {clerkKey ? (
          <ClerkProvider
            publishableKey={clerkKey}
            tokenCache={tokenCache}
            __experimental_resourceCache={resourceCache}
          >
            <AuthGate>
              <Nav />
            </AuthGate>
          </ClerkProvider>
        ) : (
          // No Clerk key yet: run fully local (no sign-in, no backup).
          <Nav />
        )}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
