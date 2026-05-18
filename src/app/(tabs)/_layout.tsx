import { NativeTabs } from 'expo-router/unstable-native-tabs';
import React from 'react';

import { palette } from '@/theme';

export default function TabLayout() {
  return (
    <NativeTabs
      backgroundColor={palette.surfaceLo}
      indicatorColor={palette.surfaceHi}
      labelStyle={{ selected: { color: palette.purple } }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'film', selected: 'film.fill' }}
          md="movie"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="inspiration">
        <NativeTabs.Trigger.Label>Inspiration</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'sparkles', selected: 'sparkles' }}
          md="auto_awesome"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
