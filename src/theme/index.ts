/**
 * OneTake theme. Playful, mostly dark, bright accents.
 * Palette intentionally limited to purple (brand), yellow (punch / best),
 * blue (secondary), red (destructive / dud). See PRD section 8 color motif
 * (remapped to the playful palette).
 */
import { Platform } from 'react-native';

export const palette = {
  // dark base
  bg: '#0E0B1A',
  surface: '#1A1430',
  surfaceHi: '#241B45',
  surfaceLo: '#15102A',
  border: '#322651',

  // bright accents
  purple: '#A06CFF',
  purpleDeep: '#7C4DFF',
  yellow: '#FFD23F',
  blue: '#3DA5FF',
  red: '#FF4D6D',

  // text
  text: '#F4F1FF',
  textDim: '#A79FC4',
  textFaint: '#6E6690',

  // on-accent text (for buttons on bright fills)
  onBright: '#1A0B2E',
} as const;

/** Verdict -> color. perfect = yellow (best), keep = blue, dud = red. */
export const verdictColor = {
  perfect: palette.yellow,
  keep: palette.blue,
  dud: palette.red,
} as const;

export const tagColor = {
  talking: palette.purple,
  broll: palette.blue,
} as const;

export const radius = {
  sm: 10,
  md: 16,
  lg: 22,
  xl: 30,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 36,
} as const;

export const font = Platform.select({
  ios: { display: 'ui-rounded', body: 'system-ui', mono: 'ui-monospace' },
  default: { display: 'sans-serif', body: 'sans-serif', mono: 'monospace' },
})!;

export const type = {
  hero: { fontSize: 34, fontWeight: '900' as const, color: palette.text },
  title: { fontSize: 24, fontWeight: '800' as const, color: palette.text },
  subtitle: { fontSize: 18, fontWeight: '800' as const, color: palette.text },
  body: { fontSize: 15, fontWeight: '500' as const, color: palette.text },
  dim: { fontSize: 14, fontWeight: '500' as const, color: palette.textDim },
  caption: { fontSize: 12, fontWeight: '700' as const, color: palette.textFaint },
} as const;
