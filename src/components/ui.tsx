import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { palette, radius, space, type as T } from '../theme';

// ---------- Screen ----------

export function Screen({
  children,
  scroll,
  pad = true,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  pad?: boolean;
}) {
  const inner = (
    <View style={[{ flex: 1 }, pad && { paddingHorizontal: space.xl }]}>
      {children}
    </View>
  );
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: space.xxl * 2 }}
        >
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

// ---------- Text ----------

type TextKind = keyof typeof T;
export function AppText({
  kind = 'body',
  style,
  children,
  numberOfLines,
}: {
  kind?: TextKind;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
}) {
  return (
    <Text numberOfLines={numberOfLines} style={[T[kind], style]}>
      {children}
    </Text>
  );
}

// ---------- Header ----------

export function Header({
  title,
  back,
  right,
}: {
  title: string;
  back?: boolean;
  right?: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        {back ? (
          <IconButton
            name="chevron-back"
            onPress={() => router.back()}
            tone="surface"
          />
        ) : (
          <View style={{ width: 44 }} />
        )}
        <View style={{ flex: 1 }} />
        {right ?? <View style={{ width: 44 }} />}
      </View>
      <AppText kind="hero" style={{ marginTop: space.md }}>
        {title}
      </AppText>
    </View>
  );
}

// ---------- Button ----------

type ButtonTone = 'primary' | 'accent' | 'blue' | 'danger' | 'ghost';
const TONE_BG: Record<ButtonTone, string> = {
  primary: palette.purple,
  accent: palette.yellow,
  blue: palette.blue,
  danger: palette.red,
  ghost: 'transparent',
};
const TONE_FG: Record<ButtonTone, string> = {
  primary: palette.onBright,
  accent: palette.onBright,
  blue: palette.onBright,
  danger: '#fff',
  ghost: palette.text,
};

export function Button({
  label,
  onPress,
  tone = 'primary',
  icon,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  tone?: ButtonTone;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: TONE_BG[tone],
          borderWidth: tone === 'ghost' ? 2 : 0,
          borderColor: palette.border,
          opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      {icon && <Ionicons name={icon} size={20} color={TONE_FG[tone]} />}
      <Text style={[styles.btnLabel, { color: TONE_FG[tone] }]}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  name,
  onPress,
  tone = 'surface',
  color,
}: {
  name: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  tone?: 'surface' | 'danger' | 'accent' | 'clear';
  color?: string;
}) {
  const bg =
    tone === 'surface'
      ? palette.surfaceHi
      : tone === 'danger'
      ? palette.red
      : tone === 'accent'
      ? palette.yellow
      : 'transparent';
  const fg =
    color ?? (tone === 'danger' ? '#fff' : tone === 'accent' ? palette.onBright : palette.text);
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.iconBtn,
        { backgroundColor: bg, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Ionicons name={name} size={22} color={fg} />
    </Pressable>
  );
}

// ---------- Card ----------

export function Card({
  children,
  onPress,
  accent,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  accent?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const body = (
    <View
      style={[
        styles.card,
        accent ? { borderLeftWidth: 5, borderLeftColor: accent } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.98 : 1 }] })}
    >
      {body}
    </Pressable>
  );
}

// ---------- Chip / Pill ----------

export function Chip({
  label,
  color = palette.purple,
  active,
  onPress,
}: {
  label: string;
  color?: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? color : 'transparent',
          borderColor: color,
        },
      ]}
    >
      <Text
        style={{
          color: active ? palette.onBright : color,
          fontWeight: '800',
          fontSize: 13,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Dot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

// ---------- Empty state ----------

export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={40} color={palette.purple} />
      </View>
      <AppText kind="subtitle" style={{ textAlign: 'center' }}>
        {title}
      </AppText>
      <AppText kind="dim" style={{ textAlign: 'center' }}>
        {subtitle}
      </AppText>
    </View>
  );
}

// ---------- FAB ----------

export function Fab({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.fab,
        { transform: [{ scale: pressed ? 0.95 : 1 }] },
      ]}
    >
      <Ionicons name={icon} size={22} color={palette.onBright} />
      <Text style={styles.fabLabel}>{label}</Text>
    </Pressable>
  );
}

export function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={palette.purple} size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.bg },
  header: { paddingTop: space.md, paddingBottom: space.lg },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
  },
  btnLabel: { fontSize: 16, fontWeight: '900' },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: palette.border,
  },
  chip: {
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 2,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
  },
  emptyIcon: {
    width: 88,
    height: 88,
    borderRadius: radius.pill,
    backgroundColor: palette.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  fab: {
    position: 'absolute',
    right: space.xl,
    bottom: space.xxl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: palette.yellow,
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    shadowColor: palette.yellow,
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  fabLabel: { color: palette.onBright, fontWeight: '900', fontSize: 16 },
});
