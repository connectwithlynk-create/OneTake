import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, radius, space } from '@/theme';

const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'film',
  clips: 'videocam',
  analysis: 'stats-chart',
  inspiration: 'sparkles',
};

/**
 * Custom JS tab bar (not the native iOS UITabBar). A prominent New button
 * sits above the bar; the bar itself is a real styled View.
 */
export default function TabBar({
  state,
  descriptors,
  navigation,
  insets,
}: BottomTabBarProps) {
  const router = useRouter();

  return (
    <View
      style={[
        styles.wrap,
        { paddingBottom: Math.max(space.md, insets.bottom) },
      ]}
    >
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
          router.push('/new-project');
        }}
        style={({ pressed }) => [
          styles.newBtn,
          { transform: [{ scale: pressed ? 0.97 : 1 }] },
        ]}
      >
        <Ionicons name="add" size={22} color={palette.onBright} />
        <Text style={styles.newLabel}>New project</Text>
      </Pressable>

      <View style={styles.bar}>
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const { options } = descriptors[route.key];
          const label =
            typeof options.title === 'string' ? options.title : route.name;
          const tint = focused ? palette.purple : palette.textFaint;

          return (
            <Pressable
              key={route.key}
              style={styles.item}
              onPress={() => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!focused && !event.defaultPrevented) {
                  Haptics.selectionAsync().catch(() => {});
                  navigation.navigate(route.name);
                }
              }}
            >
              <Ionicons name={ICONS[route.name] ?? 'ellipse'} size={23} color={tint} />
              <Text style={[styles.label, { color: tint }]}>{label}</Text>
              {focused && <View style={styles.activeDot} />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: palette.bg,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: palette.yellow,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    marginBottom: space.md,
    shadowColor: palette.yellow,
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  newLabel: { color: palette.onBright, fontWeight: '900', fontSize: 16 },
  bar: {
    flexDirection: 'row',
    backgroundColor: palette.surfaceLo,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.border,
    paddingVertical: space.sm,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: space.sm,
  },
  label: { fontSize: 11, fontWeight: '800' },
  activeDot: {
    position: 'absolute',
    bottom: 2,
    width: 16,
    height: 3,
    borderRadius: 2,
    backgroundColor: palette.purple,
  },
});
