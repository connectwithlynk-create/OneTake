/**
 * Bottom-panel components for the editor. Each panel is a slim view
 * over the editor's data — props in, callbacks out — so the main
 * [projectId].tsx file doesn't grow another thousand lines.
 *
 * Panels include:
 *  AdjustPanel       — color sliders (brightness/contrast/saturation/…)
 *  FiltersPanel      — preset chips
 *  GreenScreenPanel  — chroma color + threshold
 *  VoiceFxPanel      — pitch / character preset
 *  CutoutPanel       — AI subject isolation toggle
 *  RestylePanel      — AI style transfer preset
 *  KeyframesPanel    — add / clear / list keyframes on the selected overlay
 *  TransitionsPanel  — set the transition at the boundary nearest the playhead
 *  BeatsPanel        — tap to drop a marker at the current ms; clear all
 *  VoiceoverPanel    — record-narration controls
 *  AudioLibraryPanel — pick an audio file from device storage
 *  CutSilencesPanel  — run + report
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  EFFECT_DEFAULTS,
  FILTER_PRESETS,
} from '@/lib/effects';
import type {
  ClipEffects,
  OverlayKeyframe,
  TransitionKind,
} from '@/lib/types';
import { font, palette } from '@/theme';

const TRANSITION_KINDS: TransitionKind[] = [
  'none',
  'crossfade',
  'fade-black',
  'swipe-left',
  'swipe-right',
  'zoom',
  'glitch',
];

const VOICE_FX_OPTIONS: { id: NonNullable<ClipEffects['voiceFx']>; label: string }[] = [
  { id: 'none', label: 'Original' },
  { id: 'helium', label: 'Helium' },
  { id: 'deep', label: 'Deep' },
  { id: 'robot', label: 'Robot' },
  { id: 'alien', label: 'Alien' },
];

const RESTYLE_OPTIONS = [
  { id: 'cartoon', label: 'Cartoon' },
  { id: 'painterly', label: 'Painterly' },
  { id: 'anime', label: 'Anime' },
  { id: 'comic', label: 'Comic' },
  { id: 'neon', label: 'Neon' },
];

const CHROMA_COLORS = [
  '#00FF00', // green
  '#0000FF', // blue
  '#FF0000', // red
  '#FFFF00', // yellow
  '#FF00FF', // magenta
  '#00FFFF', // cyan
];

// =============================================================
// Shared chrome
// =============================================================

export function PanelShell({
  title,
  icon,
  onClose,
  children,
  right,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  onClose: () => void;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <View style={s.panel}>
      <View style={s.head}>
        <Ionicons name={icon} size={16} color={palette.text} />
        <Text style={s.title}>{title}</Text>
        {right}
        <Pressable onPress={onClose} hitSlop={6}>
          <Ionicons name="close" size={18} color={palette.textFaint} />
        </Pressable>
      </View>
      {children}
    </View>
  );
}

function HorizontalChips<T extends string>({
  options,
  selected,
  onPick,
}: {
  options: { id: T; label: string }[];
  selected: T;
  onPick: (id: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 4 }}>
        {options.map((o) => {
          const active = o.id === selected;
          return (
            <Pressable
              key={o.id}
              onPress={() => onPick(o.id)}
              style={[s.chip, active && s.chipActive]}
            >
              <Text style={[s.chipText, active && s.chipTextActive]}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 0.05,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const cur = Math.max(min, Math.min(max, value));
  // Minimal slider: tap +/− chips on either side. Real drag-slider with
  // pageX tracking already exists for Volume; reuse later if needed.
  return (
    <View style={s.sliderRow}>
      <Text style={s.sliderLabel}>{label}</Text>
      <Pressable
        style={s.sliderStep}
        onPress={() => onChange(Math.max(min, cur - step))}
      >
        <Text style={s.sliderStepText}>−</Text>
      </Pressable>
      <View style={s.sliderTrack}>
        <View
          style={[
            s.sliderFill,
            {
              width: `${((cur - min) / (max - min)) * 100}%`,
              backgroundColor: palette.lime,
            },
          ]}
        />
      </View>
      <Pressable
        style={s.sliderStep}
        onPress={() => onChange(Math.min(max, cur + step))}
      >
        <Text style={s.sliderStepText}>＋</Text>
      </Pressable>
      <Text style={s.sliderValue}>
        {cur.toFixed(Math.abs(cur) < 1 ? 2 : 1)}
      </Text>
    </View>
  );
}

// =============================================================
// Adjust panel — color sliders
// =============================================================

export function AdjustPanel({
  effects,
  onChange,
  onClose,
}: {
  effects: ClipEffects;
  onChange: (patch: Partial<ClipEffects>) => void;
  onClose: () => void;
}) {
  const e = effects;
  return (
    <PanelShell title="Adjust" icon="options-outline" onClose={onClose}>
      <ScrollView style={{ maxHeight: 220 }}>
        <SliderRow
          label="Brightness"
          value={e.brightness ?? EFFECT_DEFAULTS.brightness}
          min={-1}
          max={1}
          onChange={(v) => onChange({ brightness: v })}
        />
        <SliderRow
          label="Contrast"
          value={e.contrast ?? EFFECT_DEFAULTS.contrast}
          min={0}
          max={2}
          onChange={(v) => onChange({ contrast: v })}
        />
        <SliderRow
          label="Saturation"
          value={e.saturation ?? EFFECT_DEFAULTS.saturation}
          min={0}
          max={2}
          onChange={(v) => onChange({ saturation: v })}
        />
        <SliderRow
          label="Sharpness"
          value={e.sharpness ?? EFFECT_DEFAULTS.sharpness}
          min={0}
          max={1}
          onChange={(v) => onChange({ sharpness: v })}
        />
        <SliderRow
          label="Warmth"
          value={e.warmth ?? EFFECT_DEFAULTS.warmth}
          min={-1}
          max={1}
          onChange={(v) => onChange({ warmth: v })}
        />
        <SliderRow
          label="Shadows"
          value={e.shadows ?? EFFECT_DEFAULTS.shadows}
          min={-1}
          max={1}
          onChange={(v) => onChange({ shadows: v })}
        />
        <SliderRow
          label="Highlights"
          value={e.highlights ?? EFFECT_DEFAULTS.highlights}
          min={-1}
          max={1}
          onChange={(v) => onChange({ highlights: v })}
        />
      </ScrollView>
      <Pressable
        style={s.resetBtn}
        onPress={() =>
          onChange({
            brightness: 0,
            contrast: 1,
            saturation: 1,
            sharpness: 0,
            warmth: 0,
            shadows: 0,
            highlights: 0,
            filterPreset: 'none',
          })
        }
      >
        <Text style={s.resetBtnText}>Reset</Text>
      </Pressable>
    </PanelShell>
  );
}

// =============================================================
// Filters panel — presets
// =============================================================

export function FiltersPanel({
  effects,
  onPick,
  onClose,
}: {
  effects: ClipEffects;
  onPick: (presetId: string) => void;
  onClose: () => void;
}) {
  const active = effects.filterPreset ?? 'none';
  return (
    <PanelShell title="Filters" icon="color-palette-outline" onClose={onClose}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 4 }}>
          {Object.entries(FILTER_PRESETS).map(([id, p]) => {
            const sel = id === active;
            return (
              <Pressable
                key={id}
                onPress={() => onPick(id)}
                style={[s.filterCard, sel && s.filterCardActive]}
              >
                <View style={[s.filterThumb, { backgroundColor: thumbFor(id) }]} />
                <Text style={[s.filterLabel, sel && s.filterLabelActive]}>
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </PanelShell>
  );
}

function thumbFor(id: string): string {
  // Cheap visual hash for the filter swatch.
  switch (id) {
    case 'noir':
      return '#222';
    case 'bw':
      return '#888';
    case 'vintage':
      return '#9c7a4a';
    case 'film':
      return '#7a6e58';
    case 'vivid':
      return '#d04f63';
    case 'cool':
      return '#3a6f97';
    case 'warm':
      return '#c97a3a';
    case 'fade':
      return '#a59b8e';
    case 'punch':
      return '#7a3a4f';
    default:
      return '#3a3a4a';
  }
}

// =============================================================
// Green Screen panel
// =============================================================

export function GreenScreenPanel({
  effects,
  onChange,
  onClose,
}: {
  effects: ClipEffects;
  onChange: (patch: Partial<ClipEffects>) => void;
  onClose: () => void;
}) {
  const enabled = !!effects.chromaEnabled;
  return (
    <PanelShell
      title="Green Screen"
      icon="aperture-outline"
      onClose={onClose}
      right={
        <Pressable
          onPress={() => onChange({ chromaEnabled: !enabled })}
          style={[s.onOff, enabled && s.onOffActive]}
        >
          <Text style={[s.onOffText, enabled && s.onOffTextActive]}>
            {enabled ? 'ON' : 'OFF'}
          </Text>
        </Pressable>
      }
    >
      <Text style={s.hint}>Pick the key color, adjust threshold.</Text>
      <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 4 }}>
        {CHROMA_COLORS.map((c) => {
          const sel = (effects.chromaColor ?? '#00FF00').toUpperCase() === c;
          return (
            <Pressable
              key={c}
              onPress={() => onChange({ chromaColor: c })}
              style={[
                s.colorSwatch,
                { backgroundColor: c },
                sel && s.colorSwatchActive,
              ]}
            />
          );
        })}
      </View>
      <SliderRow
        label="Threshold"
        value={effects.chromaThreshold ?? 0.3}
        min={0}
        max={1}
        onChange={(v) => onChange({ chromaThreshold: v })}
      />
    </PanelShell>
  );
}

// =============================================================
// Voice FX panel
// =============================================================

export function VoiceFxPanel({
  effects,
  onChange,
  onClose,
}: {
  effects: ClipEffects;
  onChange: (patch: Partial<ClipEffects>) => void;
  onClose: () => void;
}) {
  return (
    <PanelShell title="Voice FX" icon="mic-outline" onClose={onClose}>
      <Text style={s.hint}>Applies a pitch / character preset to this clip&apos;s audio.</Text>
      <HorizontalChips
        options={VOICE_FX_OPTIONS}
        selected={effects.voiceFx ?? 'none'}
        onPick={(id) => onChange({ voiceFx: id })}
      />
    </PanelShell>
  );
}

// =============================================================
// Voice Enhance — toggle
// =============================================================

export function VoiceEnhancePanel({
  effects,
  onChange,
  onClose,
}: {
  effects: ClipEffects;
  onChange: (patch: Partial<ClipEffects>) => void;
  onClose: () => void;
}) {
  const on = !!effects.voiceEnhance;
  return (
    <PanelShell
      title="Voice Enhance"
      icon="megaphone-outline"
      onClose={onClose}
    >
      <Text style={s.hint}>
        Boosts vocal clarity and cuts low-frequency rumble. Lands on each
        clip with this enabled.
      </Text>
      <Pressable
        onPress={() => onChange({ voiceEnhance: !on })}
        style={[s.bigToggle, on && s.bigToggleActive]}
      >
        <Text style={[s.bigToggleText, on && s.bigToggleTextActive]}>
          {on ? 'Enhance ON' : 'Enhance OFF'}
        </Text>
      </Pressable>
    </PanelShell>
  );
}

// =============================================================
// Cutout — toggle
// =============================================================

export function CutoutPanel({
  effects,
  onChange,
  onClose,
}: {
  effects: ClipEffects;
  onChange: (patch: Partial<ClipEffects>) => void;
  onClose: () => void;
}) {
  const on = !!effects.cutoutEnabled;
  return (
    <PanelShell title="Cutout" icon="layers-outline" onClose={onClose}>
      <Text style={s.hint}>
        Isolates the subject so you can drop a background underneath.
        Uses on-device person segmentation; runs at preview time.
      </Text>
      <Pressable
        onPress={() => onChange({ cutoutEnabled: !on })}
        style={[s.bigToggle, on && s.bigToggleActive]}
      >
        <Text style={[s.bigToggleText, on && s.bigToggleTextActive]}>
          {on ? 'Cutout ON' : 'Cutout OFF'}
        </Text>
      </Pressable>
    </PanelShell>
  );
}

// =============================================================
// Restyle — pick a style id
// =============================================================

export function RestylePanel({
  effects,
  onChange,
  onClose,
}: {
  effects: ClipEffects;
  onChange: (patch: Partial<ClipEffects>) => void;
  onClose: () => void;
}) {
  return (
    <PanelShell title="Restyle" icon="sparkles-outline" onClose={onClose}>
      <Text style={s.hint}>
        Stylized look applied to the whole clip. Picks bake into the
        composition on export.
      </Text>
      <HorizontalChips
        options={[{ id: '', label: 'Original' }, ...RESTYLE_OPTIONS]}
        selected={effects.restyleId ?? ''}
        onPick={(id) => onChange({ restyleId: id || undefined })}
      />
    </PanelShell>
  );
}

// =============================================================
// Keyframes — list / add / clear on the selected overlay
// =============================================================

export function KeyframesPanel({
  keyframes,
  currentMs,
  baseXY,
  onAdd,
  onClear,
  onDelete,
  onClose,
}: {
  keyframes: OverlayKeyframe[];
  currentMs: number;
  baseXY: { x: number; y: number; scale: number };
  onAdd: (kf: OverlayKeyframe) => void;
  onClear: () => void;
  onDelete: (idx: number) => void;
  onClose: () => void;
}) {
  return (
    <PanelShell title="Keyframes" icon="locate-outline" onClose={onClose}>
      <Text style={s.hint}>
        Anchors the overlay&apos;s position / scale at the playhead. The
        renderer linearly interpolates between adjacent keyframes.
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 6 }}>
        <Pressable
          style={s.actionBtn}
          onPress={() =>
            onAdd({
              tMs: currentMs,
              x: baseXY.x,
              y: baseXY.y,
              scale: baseXY.scale,
            })
          }
        >
          <Ionicons name="add" size={14} color={palette.lime} />
          <Text style={s.actionBtnText}>Add at playhead</Text>
        </Pressable>
        {keyframes.length > 0 ? (
          <Pressable style={s.actionBtnGhost} onPress={onClear}>
            <Text style={s.actionBtnGhostText}>Clear all</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView style={{ maxHeight: 100 }}>
        {keyframes
          .slice()
          .sort((a, b) => a.tMs - b.tMs)
          .map((kf, i) => (
            <View key={`${kf.tMs}-${i}`} style={s.kfRow}>
              <Text style={s.kfTime}>
                {String(Math.floor(kf.tMs / 1000))}.
                {String(Math.floor(kf.tMs / 100) % 10)}s
              </Text>
              <Text style={s.kfMeta}>
                x{(kf.x ?? baseXY.x).toFixed(2)} y{(kf.y ?? baseXY.y).toFixed(2)}
                {kf.scale !== undefined ? ` s${kf.scale.toFixed(2)}` : ''}
              </Text>
              <Pressable onPress={() => onDelete(i)}>
                <Ionicons name="close" size={14} color={palette.textFaint} />
              </Pressable>
            </View>
          ))}
      </ScrollView>
    </PanelShell>
  );
}

// =============================================================
// Transitions — pick the kind at the nearest boundary
// =============================================================

export function TransitionsPanel({
  boundaryIndex,
  current,
  onPick,
  onDurationChange,
  onClose,
}: {
  boundaryIndex: number;
  current: { kind: TransitionKind; durationMs: number };
  onPick: (kind: TransitionKind) => void;
  onDurationChange: (ms: number) => void;
  onClose: () => void;
}) {
  return (
    <PanelShell
      title={`Transition · cut ${boundaryIndex + 1}`}
      icon="swap-vertical-outline"
      onClose={onClose}
    >
      <HorizontalChips
        options={TRANSITION_KINDS.map((k) => ({ id: k, label: prettyTransition(k) }))}
        selected={current.kind}
        onPick={onPick}
      />
      <SliderRow
        label="Duration (ms)"
        value={current.durationMs}
        min={100}
        max={1500}
        step={50}
        onChange={onDurationChange}
      />
    </PanelShell>
  );
}

function prettyTransition(k: TransitionKind): string {
  switch (k) {
    case 'none':
      return 'Hard cut';
    case 'crossfade':
      return 'Crossfade';
    case 'fade-black':
      return 'Fade to black';
    case 'swipe-left':
      return 'Swipe ←';
    case 'swipe-right':
      return 'Swipe →';
    case 'zoom':
      return 'Zoom';
    case 'glitch':
      return 'Glitch';
  }
}

// =============================================================
// Beats — tap to drop a marker at the playhead
// =============================================================

export function BeatsPanel({
  beats,
  currentMs,
  onAdd,
  onClear,
  onClose,
}: {
  beats: number[];
  currentMs: number;
  onAdd: (ms: number) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <PanelShell
      title={`Beats · ${beats.length}`}
      icon="pulse-outline"
      onClose={onClose}
    >
      <Text style={s.hint}>
        Tap to drop a marker at the playhead. Manually for now —
        auto-detection from the audio track is the next pass.
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable style={s.actionBtn} onPress={() => onAdd(currentMs)}>
          <Ionicons name="add" size={14} color={palette.lime} />
          <Text style={s.actionBtnText}>Drop at playhead</Text>
        </Pressable>
        {beats.length > 0 ? (
          <Pressable style={s.actionBtnGhost} onPress={onClear}>
            <Text style={s.actionBtnGhostText}>Clear all</Text>
          </Pressable>
        ) : null}
      </View>
    </PanelShell>
  );
}

// =============================================================
// Voiceover — record state
// =============================================================

export function VoiceoverPanel({
  isRecording,
  elapsedMs,
  onStart,
  onStop,
  onClose,
}: {
  isRecording: boolean;
  elapsedMs: number;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  return (
    <PanelShell title="Voiceover" icon="mic-outline" onClose={onClose}>
      <Text style={s.hint}>
        Records narration over the timeline starting at the playhead.
        Saves as a media overlay (audio-only).
      </Text>
      <Pressable
        style={[s.bigBtn, isRecording && s.bigBtnRec]}
        onPress={isRecording ? onStop : onStart}
      >
        <Ionicons
          name={isRecording ? 'stop' : 'mic'}
          size={18}
          color={isRecording ? '#fff' : palette.onBright}
        />
        <Text
          style={[
            s.bigBtnText,
            isRecording ? { color: '#fff' } : { color: palette.onBright },
          ]}
        >
          {isRecording
            ? `Stop · ${String(Math.floor(elapsedMs / 1000))}s`
            : 'Record'}
        </Text>
      </Pressable>
    </PanelShell>
  );
}

// =============================================================
// Audio library — minimal picker shell
// =============================================================

export function AudioPanel({
  onPick,
  onClose,
}: {
  onPick: () => void;
  onClose: () => void;
}) {
  return (
    <PanelShell title="Audio" icon="musical-notes-outline" onClose={onClose}>
      <Text style={s.hint}>
        Browse a music or SFX file from your device. Drops in at the
        playhead as a media overlay (audio-only).
      </Text>
      <Pressable style={s.bigBtn} onPress={onPick}>
        <Ionicons name="folder-open" size={16} color={palette.onBright} />
        <Text style={[s.bigBtnText, { color: palette.onBright }]}>
          Pick audio file
        </Text>
      </Pressable>
    </PanelShell>
  );
}

// =============================================================
// Cut silences — run + report
// =============================================================

export function CutSilencesPanel({
  isRunning,
  lastResult,
  onRun,
  onClose,
}: {
  isRunning: boolean;
  lastResult: { removedMs: number; trimmedClips: number } | null;
  onRun: () => void;
  onClose: () => void;
}) {
  return (
    <PanelShell
      title="Cut Silences"
      icon="contract-outline"
      onClose={onClose}
    >
      <Text style={s.hint}>
        Scans each clip&apos;s transcript and tightens head / tail silences.
        Only touches gaps &gt; 500ms.
      </Text>
      {lastResult ? (
        <Text style={s.result}>
          Removed {Math.round(lastResult.removedMs / 100) / 10}s across{' '}
          {lastResult.trimmedClips} clip
          {lastResult.trimmedClips === 1 ? '' : 's'}.
        </Text>
      ) : null}
      <Pressable
        style={s.bigBtn}
        disabled={isRunning}
        onPress={onRun}
      >
        <Ionicons
          name={isRunning ? 'hourglass' : 'cut'}
          size={16}
          color={palette.onBright}
        />
        <Text style={[s.bigBtnText, { color: palette.onBright }]}>
          {isRunning ? 'Working…' : 'Tighten'}
        </Text>
      </Pressable>
    </PanelShell>
  );
}

// =============================================================
// Styles
// =============================================================

const s = StyleSheet.create({
  panel: {
    backgroundColor: palette.bg1,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    flex: 1,
    color: palette.text,
    fontFamily: font.displayHeavy,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  hint: {
    color: palette.text3,
    fontFamily: font.body,
    fontSize: 11,
    lineHeight: 16,
  },
  result: {
    color: palette.lime,
    fontFamily: font.bodyBold,
    fontSize: 12,
  },

  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  chipActive: {
    backgroundColor: `${palette.lime}22`,
    borderColor: palette.lime,
  },
  chipText: {
    fontFamily: font.bodyBold,
    fontSize: 12,
    color: palette.text2,
  },
  chipTextActive: { color: palette.lime },

  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  sliderLabel: {
    width: 84,
    color: palette.text,
    fontFamily: font.body,
    fontSize: 12,
  },
  sliderStep: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sliderStepText: { color: palette.text, fontFamily: font.bodyBold, fontSize: 16 },
  sliderTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  sliderFill: {
    height: '100%',
    borderRadius: 3,
  },
  sliderValue: {
    width: 44,
    textAlign: 'right',
    color: palette.text2,
    fontFamily: font.mono,
    fontSize: 11,
  },

  resetBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    marginTop: 6,
  },
  resetBtnText: {
    color: palette.text2,
    fontFamily: font.bodyBold,
    fontSize: 11,
  },

  filterCard: {
    alignItems: 'center',
    gap: 6,
    padding: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  filterCardActive: {
    borderColor: palette.lime,
    backgroundColor: `${palette.lime}10`,
  },
  filterThumb: { width: 44, height: 44, borderRadius: 10 },
  filterLabel: {
    color: palette.text2,
    fontFamily: font.body,
    fontSize: 11,
  },
  filterLabelActive: { color: palette.lime },

  colorSwatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  colorSwatchActive: {
    borderColor: palette.lime,
    borderWidth: 2,
  },

  onOff: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  onOffActive: {
    backgroundColor: `${palette.lime}22`,
    borderColor: palette.lime,
  },
  onOffText: {
    fontFamily: font.monoBold,
    fontSize: 10,
    color: palette.text2,
    letterSpacing: 1,
  },
  onOffTextActive: { color: palette.lime },

  bigToggle: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
  },
  bigToggleActive: {
    backgroundColor: `${palette.lime}22`,
    borderColor: palette.lime,
  },
  bigToggleText: {
    color: palette.text,
    fontFamily: font.bodyBold,
    fontSize: 13,
  },
  bigToggleTextActive: { color: palette.lime },

  bigBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: palette.lime,
    borderWidth: 1,
    borderColor: palette.lime,
  },
  bigBtnRec: {
    backgroundColor: palette.coral,
    borderColor: palette.coral,
  },
  bigBtnText: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: -0.2,
  },

  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: `${palette.lime}14`,
    borderWidth: 1,
    borderColor: `${palette.lime}66`,
  },
  actionBtnText: {
    color: palette.lime,
    fontFamily: font.bodyBold,
    fontSize: 12,
  },
  actionBtnGhost: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  actionBtnGhostText: {
    color: palette.text2,
    fontFamily: font.bodyBold,
    fontSize: 12,
  },

  kfRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  kfTime: {
    width: 56,
    color: palette.lime,
    fontFamily: font.monoBold,
    fontSize: 11,
  },
  kfMeta: {
    flex: 1,
    color: palette.text2,
    fontFamily: font.mono,
    fontSize: 11,
  },
});
