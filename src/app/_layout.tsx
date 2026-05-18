import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { gcExpiredClips } from '@/lib/repo';
import { invalidate } from '@/lib/store';
import { palette } from '@/theme';

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

export default function RootLayout() {
  // Sweep expired ephemeral takes once on launch, then refresh the UI.
  useEffect(() => {
    gcExpiredClips()
      .then((n) => {
        if (n > 0) invalidate();
      })
      .catch(() => {});
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={navTheme}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: palette.bg },
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="new-project" />
          <Stack.Screen
            name="inspiration-add"
            options={{ presentation: 'modal' }}
          />
          <Stack.Screen name="project/[id]" />
          <Stack.Screen name="edit/[projectId]" />
          <Stack.Screen name="capture/[projectId]" />
          <Stack.Screen name="prompt" />
          <Stack.Screen name="preview/[projectId]" />
          <Stack.Screen name="collection/[id]" />
          <Stack.Screen name="swipe/[collectionId]" />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
