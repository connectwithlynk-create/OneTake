import { useUser } from '@clerk/expo';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { font, palette, radius, space } from '@/theme';

const CLERK_ON = !!process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

function ProfileButton() {
  const { user } = useUser();
  const router = useRouter();
  const uri = user?.imageUrl;
  const initial = (
    user?.firstName?.[0] ??
    user?.primaryEmailAddress?.emailAddress?.[0] ??
    user?.emailAddresses?.[0]?.emailAddress?.[0] ??
    '?'
  ).toUpperCase();

  return (
    <Pressable
      style={styles.profile}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        router.push('/profile');
      }}
    >
      {uri ? (
        <Image source={{ uri }} style={styles.avatar} contentFit="cover" />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
      )}
    </Pressable>
  );
}

const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  camera: 'camera',
  index: 'grid',
  clips: 'videocam',
  analysis: 'stats-chart',
  inspiration: 'sparkles',
};

const LABELS: Record<string, string> = {
  camera: 'Camera',
  index: 'Projects',
  clips: 'Clips',
  analysis: 'Analysis',
  inspiration: 'Inspiration',
};

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
        <Ionicons name="add" size={16} color={palette.onBright} />
        <Text style={styles.newLabel}>New project</Text>
      </Pressable>

      <View style={styles.bar}>
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const { options } = descriptors[route.key];
          const label = LABELS[route.name] ?? (typeof options.title === 'string' ? options.title : route.name);
          const tint = focused ? palette.lime : palette.text3;

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
              <Ionicons
                name={ICONS[route.name] ?? 'ellipse'}
                size={22}
                color={tint}
              />
              <Text style={[styles.label, { color: tint }]}>{label}</Text>
              {focused && <View style={styles.activeDot} />}
            </Pressable>
          );
        })}

        {CLERK_ON && <ProfileButton />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 14,
    paddingTop: 8,
    backgroundColor: palette.bg0,
  },
  newBtn: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: palette.lime,
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: palette.lime,
    shadowColor: palette.lime,
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  newLabel: {
    color: palette.onBright,
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: -0.2,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: palette.bg1,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    padding: 6,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 6,
    position: 'relative',
  },
  label: {
    fontSize: 9.5,
    fontWeight: '700',
    fontFamily: font.bodyBold,
    letterSpacing: 0.2,
  },
  profile: {
    width: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    borderColor: palette.lime,
    backgroundColor: palette.magenta,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarText: {
    color: '#fff',
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 12,
  },
  activeDot: {
    position: 'absolute',
    bottom: -2,
    width: 16,
    height: 2,
    borderRadius: 2,
    backgroundColor: palette.lime,
  },
});
