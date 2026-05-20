/**
 * OneTake theme — dark-arcade aesthetic.
 * Deep navy base with lime (primary/energy), magenta (talking/hype),
 * cyan (keep/links), gold (rewards/ready), violet (b-roll), coral (dud).
 */
import { Platform } from 'react-native';

export const palette = {
  // Base — deep navy arcade dark
  bg: '#08080F',
  bg0: '#08080F',
  bg1: '#11111B',
  bg2: '#1A1A28',
  bg3: '#232336',
  surface: '#11111B',
  surfaceHi: '#1A1A28',
  surfaceLo: '#08080F',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.16)',

  // Accents
  lime: '#C7F73C',
  magenta: '#FF3F8B',
  cyan: '#4EE2EC',
  gold: '#FFCC2F',
  violet: '#9B6BFF',
  coral: '#FF7A4D',

  // Legacy aliases — old code referred to verdict colors by these names.
  // Map them so the new palette is applied where the *intent* is right:
  // - purple/yellow used to mean "primary/perfect" (the brightest) → lime
  // - blue used to mean "keep" → cyan
  // - red used to mean "dud/destructive" → coral
  purple: '#C7F73C',
  purpleDeep: '#A4D928',
  yellow: '#C7F73C',
  blue: '#4EE2EC',
  red: '#FF7A4D',

  // Text
  text: '#FFFFFF',
  text1: '#FFFFFF',
  text2: 'rgba(255,255,255,0.7)',
  text3: 'rgba(255,255,255,0.45)',
  text4: 'rgba(255,255,255,0.25)',
  textDim: 'rgba(255,255,255,0.7)',
  textFaint: 'rgba(255,255,255,0.45)',

  // On-accent (dark text on bright fills)
  onBright: '#08080F',
} as const;

/** Verdict -> color. perfect = lime, keep = cyan, dud = coral. */
export const verdictColor = {
  perfect: palette.lime,
  keep: palette.cyan,
  dud: palette.coral,
} as const;

/** Tag -> color. talking = magenta, broll = violet. */
export const tagColor = {
  talking: palette.magenta,
  broll: palette.violet,
} as const;

/** Status -> color. recording = lime, processing = cyan, ready = gold. */
export const statusColor = {
  recording: palette.lime,
  processing: palette.cyan,
  ready: palette.gold,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 18,
  xl: 22,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  xxl: 32,
} as const;

export const font = Platform.select({
  ios: {
    display: 'BricolageGrotesque_700Bold',
    displayHeavy: 'BricolageGrotesque_800ExtraBold',
    body: 'Outfit_500Medium',
    bodyBold: 'Outfit_700Bold',
    mono: 'GeistMono_500Medium',
    monoBold: 'GeistMono_700Bold',
  },
  default: {
    display: 'BricolageGrotesque_700Bold',
    displayHeavy: 'BricolageGrotesque_800ExtraBold',
    body: 'Outfit_500Medium',
    bodyBold: 'Outfit_700Bold',
    mono: 'GeistMono_500Medium',
    monoBold: 'GeistMono_700Bold',
  },
})!;

export const type = {
  hero: {
    fontFamily: font.displayHeavy,
    fontSize: 34,
    fontWeight: '800' as const,
    color: palette.text,
    letterSpacing: -1,
  },
  title: {
    fontFamily: font.displayHeavy,
    fontSize: 24,
    fontWeight: '800' as const,
    color: palette.text,
    letterSpacing: -0.6,
  },
  subtitle: {
    fontFamily: font.display,
    fontSize: 18,
    fontWeight: '700' as const,
    color: palette.text,
    letterSpacing: -0.3,
  },
  body: {
    fontFamily: font.body,
    fontSize: 14.5,
    fontWeight: '500' as const,
    color: palette.text,
  },
  dim: {
    fontFamily: font.body,
    fontSize: 13.5,
    fontWeight: '500' as const,
    color: palette.text2,
  },
  caption: {
    fontFamily: font.mono,
    fontSize: 10,
    fontWeight: '700' as const,
    color: palette.text3,
    letterSpacing: 1.5,
  },
  mono: {
    fontFamily: font.mono,
    fontSize: 11,
    fontWeight: '500' as const,
    color: palette.text2,
    letterSpacing: 0.5,
  },
} as const;
