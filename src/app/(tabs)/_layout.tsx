import { Tabs } from 'expo-router';
import React from 'react';

import TabBar from '@/components/tab-bar';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: 'Projects' }} />
      <Tabs.Screen name="clips" options={{ title: 'Clips' }} />
      <Tabs.Screen name="analysis" options={{ title: 'Analysis' }} />
      <Tabs.Screen name="inspiration" options={{ title: 'Inspiration' }} />
    </Tabs>
  );
}
