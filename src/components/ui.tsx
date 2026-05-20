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

import {
  palette,
  radius,
  space,
  statusColor,
  tagColor,
  type as T,
  verdictColor,
  font,
} from '../theme';

// ---------- Screen ----------

export function Screen({
  children,
  scroll,
  pad = true,
  edges,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  pad?: boolean;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
}) {
  const inner = (
    <View style={[{ flex: 1 }, pad && { paddingHorizontal: space.xl }]}>
      {children}
    </View>
  );
  return (
    <SafeAreaView
      style={styles.screen}
      edges={edges ?? ['top', 'left', 'right']}
    >
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

export function MonoLabel({
  children,
  color = palette.text3,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      style={[
        {
          fontFamily: font.monoBold,
          fontSize: 10,
          letterSpacing: 1.5,
          color,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// ---------- Wordmark ----------

export function Wordmark({
  size = 28,
  color = palette.text,
  accent = palette.lime,
}: {
  size?: number;
  color?: string;
  accent?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
      <Text
        style={{
          fontFamily: font.displayHeavy,
          fontSize: size,
          color,
          letterSpacing: -1.2,
          lineHeight: size,
        }}
      >
        One
      </Text>
      <Text
        style={{
          fontFamily: font.displayHeavy,
          fontSize: size,
          color: accent,
          lineHeight: size,
        }}
      >
        ·
      </Text>
      <Text
        style={{
          fontFamily: font.displayHeavy,
          fontSize: size,
          color,
          letterSpacing: -1.2,
          lineHeight: size,
        }}
      >
        Take
      </Text>
    </View>
  );
}

// ---------- Header ----------

export function Header({
  title,
  back,
  right,
  onBack,
}: {
  title?: string;
  back?: boolean;
  right?: React.ReactNode;
  onBack?: () => void;
}) {
  const router = useRouter();
  return (
    <View style={styles.header}>
      {back ? (
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            if (onBack) onBack();
            else router.back();
          }}
          style={({ pressed }) => [
            styles.backBtn,
            { opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Ionicons name="chevron-back" size={18} color={palette.text} />
        </Pressable>
      ) : (
        <View style={{ width: 36 }} />
      )}
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title ?? ''}
      </Text>
      <View style={{ minWidth: 36, alignItems: 'flex-end' }}>{right}</View>
    </View>
  );
}

// ---------- Hero (large display title) ----------

export function Hero({ title, sub }: { title: string; sub?: string }) {
  return (
    <View style={{ paddingHorizontal: space.xl, paddingTop: 8, paddingBottom: 18 }}>
      <Text
        style={{
          fontFamily: font.displayHeavy,
          fontSize: 34,
          color: palette.text,
          letterSpacing: -1,
          lineHeight: 34,
        }}
      >
        {title}
      </Text>
      {sub ? (
        <Text
          style={{
            marginTop: 6,
            fontFamily: font.body,
            fontSize: 13.5,
            color: palette.text2,
          }}
        >
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

// ---------- Button ----------

export type ButtonTone =
  | 'primary'
  | 'cyan'
  | 'gold'
  | 'magenta'
  | 'ghost'
  | 'danger'
  // legacy aliases (existing code uses these)
  | 'accent'
  | 'blue';

const ALIAS: Record<ButtonTone, Exclude<ButtonTone, 'accent' | 'blue'>> = {
  primary: 'primary',
  cyan: 'cyan',
  gold: 'gold',
  magenta: 'magenta',
  ghost: 'ghost',
  danger: 'danger',
  accent: 'gold',
  blue: 'cyan',
};

const TONE_BG: Record<Exclude<ButtonTone, 'accent' | 'blue'>, string> = {
  primary: palette.lime,
  cyan: palette.cyan,
  gold: palette.gold,
  magenta: palette.magenta,
  ghost: 'rgba(255,255,255,0.06)',
  danger: 'rgba(255,122,77,0.16)',
};
const TONE_FG: Record<Exclude<ButtonTone, 'accent' | 'blue'>, string> = {
  primary: palette.onBright,
  cyan: palette.onBright,
  gold: palette.onBright,
  magenta: '#fff',
  ghost: '#fff',
  danger: palette.coral,
};
const TONE_BORDER: Record<Exclude<ButtonTone, 'accent' | 'blue'>, string> = {
  primary: palette.lime,
  cyan: palette.cyan,
  gold: palette.gold,
  magenta: palette.magenta,
  ghost: 'rgba(255,255,255,0.16)',
  danger: 'rgba(255,122,77,0.4)',
};

export function Button({
  label,
  onPress,
  tone = 'primary',
  icon,
  iconNode,
  size = 'md',
  disabled,
  full,
  style,
}: {
  label: string;
  onPress: () => void;
  tone?: ButtonTone;
  icon?: keyof typeof Ionicons.glyphMap;
  iconNode?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  full?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = ALIAS[tone];
  const sizes = {
    sm: { padV: 9, padH: 14, fs: 13, gap: 6 },
    md: { padV: 13, padH: 18, fs: 14.5, gap: 8 },
    lg: { padV: 17, padH: 22, fs: 16, gap: 10 },
  } as const;
  const s = sizes[size];
  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: s.gap,
          paddingVertical: s.padV,
          paddingHorizontal: s.padH,
          borderRadius: radius.pill,
          backgroundColor: TONE_BG[t],
          borderWidth: 1,
          borderColor: TONE_BORDER[t],
          alignSelf: full ? 'stretch' : 'flex-start',
          opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      {iconNode}
      {icon && <Ionicons name={icon} size={s.fs + 2} color={TONE_FG[t]} />}
      <Text
        style={{
          color: TONE_FG[t],
          fontFamily: font.displayHeavy,
          fontWeight: '800',
          fontSize: s.fs,
          letterSpacing: -0.2,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ---------- IconButton ----------

type IconTone = 'surface' | 'accent' | 'clear' | 'danger' | 'cyan' | 'magenta';
export function IconButton({
  name,
  onPress,
  tone = 'surface',
  color,
  size = 38,
  iconSize,
}: {
  name: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  tone?: IconTone;
  color?: string;
  size?: number;
  iconSize?: number;
}) {
  const tones = {
    surface: { bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.10)', fg: palette.text },
    accent: { bg: `${palette.lime}22`, border: `${palette.lime}55`, fg: palette.lime },
    clear: { bg: 'transparent', border: 'transparent', fg: palette.text },
    danger: { bg: 'rgba(255,122,77,0.14)', border: 'rgba(255,122,77,0.45)', fg: palette.coral },
    cyan: { bg: `${palette.cyan}16`, border: `${palette.cyan}55`, fg: palette.cyan },
    magenta: { bg: `${palette.magenta}16`, border: `${palette.magenta}55`, fg: palette.magenta },
  } as const;
  const t = tones[tone];
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: 12,
          backgroundColor: t.bg,
          borderWidth: 1,
          borderColor: t.border,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Ionicons
        name={name}
        size={iconSize ?? Math.round(size * 0.45)}
        color={color ?? t.fg}
      />
    </Pressable>
  );
}

// ---------- Card ----------

export function Card({
  children,
  onPress,
  accent,
  padding = 16,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  accent?: string;
  padding?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const body = (
    <View
      style={[
        {
          borderRadius: 18,
          padding,
          backgroundColor: palette.bg1,
          borderWidth: 1,
          borderColor: accent ? `${accent}55` : 'rgba(255,255,255,0.06)',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.98 : 1 }] })}
    >
      {body}
    </Pressable>
  );
}

// ---------- Chip ----------

export function Chip({
  label,
  color = palette.lime,
  active,
  mono,
  onPress,
}: {
  label: string;
  color?: string;
  active?: boolean;
  mono?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        {
          paddingVertical: 7,
          paddingHorizontal: 12,
          borderRadius: radius.pill,
          backgroundColor: active ? `${color}22` : 'rgba(255,255,255,0.05)',
          borderWidth: 1,
          borderColor: active ? color : 'rgba(255,255,255,0.10)',
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: active ? color : palette.text2,
          fontFamily: mono ? font.monoBold : font.bodyBold,
          fontSize: mono ? 11 : 12.5,
          fontWeight: '700',
          letterSpacing: mono ? 1 : 0,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ---------- Verdict / Tag / Status pills ----------

type Verdict = 'perfect' | 'keep' | 'dud';
const VERDICT_LABEL: Record<Verdict, string> = {
  perfect: 'PERFECT',
  keep: 'KEEP',
  dud: 'DUD',
};
export function VerdictPill({ v }: { v: Verdict }) {
  const c = verdictColor[v];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 999,
        backgroundColor: `${c}1f`,
        borderWidth: 1,
        borderColor: `${c}66`,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c }} />
      <Text
        style={{
          color: c,
          fontFamily: font.monoBold,
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 1,
        }}
      >
        {VERDICT_LABEL[v]}
      </Text>
    </View>
  );
}

type Tag = 'talking' | 'broll';
const TAG_LABEL: Record<Tag, string> = { talking: 'TALKING', broll: 'B-ROLL' };
export function TagPill({ t }: { t: Tag }) {
  const c = tagColor[t];
  return (
    <View
      style={{
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: `${c}80`,
        backgroundColor: `${c}10`,
      }}
    >
      <Text
        style={{
          color: c,
          fontFamily: font.monoBold,
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 1,
        }}
      >
        {TAG_LABEL[t]}
      </Text>
    </View>
  );
}

type Status = 'recording' | 'processing' | 'ready';
const STATUS_LABEL: Record<Status, string> = {
  recording: 'RECORDING',
  processing: 'PROCESSING',
  ready: 'READY',
};
export function StatusPill({ s }: { s: Status }) {
  const c = statusColor[s];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingVertical: 4,
        paddingHorizontal: 9,
        borderRadius: 999,
        backgroundColor: 'rgba(0,0,0,0.55)',
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: c,
          shadowColor: c,
          shadowOpacity: 1,
          shadowRadius: 4,
        }}
      />
      <Text
        style={{
          color: '#fff',
          fontFamily: font.monoBold,
          fontSize: 9,
          fontWeight: '700',
          letterSpacing: 1.2,
        }}
      >
        {STATUS_LABEL[s]}
      </Text>
    </View>
  );
}

export function Dot({ color }: { color: string }) {
  return (
    <View
      style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }}
    />
  );
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
        <Ionicons name={icon} size={36} color={palette.lime} />
      </View>
      <Text
        style={{
          fontFamily: font.displayHeavy,
          fontSize: 20,
          color: palette.text,
          textAlign: 'center',
          letterSpacing: -0.4,
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          fontFamily: font.body,
          fontSize: 13.5,
          color: palette.text2,
          textAlign: 'center',
        }}
      >
        {subtitle}
      </Text>
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
      <Ionicons name={icon} size={18} color={palette.onBright} />
      <Text style={styles.fabLabel}>{label}</Text>
    </Pressable>
  );
}

// ---------- Loading ----------

export function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={palette.lime} size="large" />
    </View>
  );
}

// ---------- Media placeholder (striped, for non-loaded thumbs) ----------

const STRIPE_BASE: Record<string, [string, string]> = {
  default: [palette.bg2, palette.bg1],
  warm: ['#3a2030', '#2a1a20'],
  cool: ['#1a2438', '#182a30'],
  lime: ['#2a3018', '#1f2a14'],
  magenta: ['#38183a', '#2a142a'],
  violet: ['#251a3a', '#1a142a'],
  gold: ['#3a2a14', '#2a1f0d'],
};

export function MediaPlaceholder({
  variant = 'default',
  label,
  children,
  style,
}: {
  variant?: keyof typeof STRIPE_BASE;
  label?: string;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const [a, b] = STRIPE_BASE[variant];
  return (
    <View
      style={[
        {
          flex: 1,
          backgroundColor: b,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <View
        style={{
          position: 'absolute',
          inset: 0 as any,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: a,
          opacity: 0.5,
        }}
      />
      {children ?? (
        <Text
          style={{
            color: 'rgba(255,255,255,0.4)',
            fontFamily: font.mono,
            fontSize: 9.5,
            letterSpacing: 1.5,
            textTransform: 'uppercase',
          }}
        >
          {label ?? variant}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.bg },
  header: {
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: {
    flex: 1,
    fontFamily: font.displayHeavy,
    fontSize: 20,
    color: palette.text,
    letterSpacing: -0.4,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: space.xl,
  },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: `${palette.lime}22`,
    borderWidth: 1,
    borderColor: `${palette.lime}55`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    position: 'absolute',
    right: space.xl,
    bottom: space.xxl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: palette.lime,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
    shadowColor: palette.lime,
    shadowOpacity: 0.6,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  fabLabel: { color: palette.onBright, fontFamily: font.displayHeavy, fontWeight: '800', fontSize: 14.5 },
});
