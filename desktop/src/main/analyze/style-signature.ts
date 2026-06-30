import type { SfxContext } from './sfx-context';
import type {
  CaptionStyleProfile,
  ClipType,
  FrameRegion,
  ReelShot,
} from './types';

export interface ClipnosisPatternCount {
  label: string;
  count: number;
  pct: number;
  example_shots: number[];
}

export interface ClipnosisScriptVisualRule {
  trigger_keywords: string[];
  visual_response: string;
  layer: 'L1' | 'L2' | 'L3';
  shot_idxs: number[];
  examples: string[];
}

export interface ClipnosisStyleSignature {
  version: 1;
  engine: 'clipnosis-signature-v1';
  summary: string;
  confidence: number;
  shot_count: number;
  duration_ms: number;
  rhythm: {
    median_shot_ms: number;
    cuts_per_sec: number;
    tempo: 'staccato' | 'fast' | 'medium' | 'slow';
    duration_sequence: string[];
  };
  grammar: {
    structure_sequence: string[];
    layout_sequence: string[];
    layer_sequence: string[];
    rhythm_sequence: string[];
  };
  layers: {
    l1_media: ClipnosisPatternCount[];
    l2_visuals: ClipnosisPatternCount[];
    l3_text: ClipnosisPatternCount[];
  };
  script_visual_rules: ClipnosisScriptVisualRule[];
  caption_system: {
    present: boolean;
    description: string;
  };
  motion_system: {
    moving_pct: number | null;
    dominant: string | null;
    sequence: string[];
  };
  sound_system: {
    sfx_per_min: number;
    cut_hit_pct: number;
    description: string;
  };
  reproduction_rules: string[];
}

const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'are',
  'because',
  'been',
  'but',
  'can',
  'could',
  'did',
  'does',
  'for',
  'from',
  'get',
  'had',
  'has',
  'have',
  'here',
  'how',
  'into',
  'just',
  'like',
  'more',
  'now',
  'out',
  'over',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

function pct(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) / 100 : 0;
}

function clip(text: string | null | undefined, max = 92): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function tokenWords(text: string, max = 4): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim().replace(/^[-']+|[-']+$/g, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .slice(0, max);
}

function clipTypeLabel(type: ClipType): string {
  switch (type) {
    case 'talking_head':
      return 'speaker talking head';
    case 'broll_talking_head':
      return 'b-roll talking head';
    case 'talking_head_unknown':
      return 'uncertain talking head';
    case 'broll_visual':
      return 'visual b-roll';
    default:
      return type.replace(/_/g, ' ');
  }
}

function regionLabel(region: FrameRegion | null | undefined): string {
  return region ? region.replace(/_/g, ' ') : 'full frame';
}

function rhythmBucket(durationMs: number): string {
  if (durationMs <= 850) return 'snap';
  if (durationMs <= 1600) return 'quick';
  if (durationMs <= 2800) return 'medium';
  return 'hold';
}

function tempoFromMedian(ms: number): ClipnosisStyleSignature['rhythm']['tempo'] {
  if (ms <= 900) return 'staccato';
  if (ms <= 1600) return 'fast';
  if (ms <= 2800) return 'medium';
  return 'slow';
}

function layoutKind(shot: ReelShot): string {
  const visual = `${shot.visual_caption ?? ''}`.toLowerCase();
  if (/\btop\b/.test(visual) && /\b(media|image|video|panel|screenshot|half)\b/.test(visual)) {
    return 'top media';
  }
  if (/\bbottom\b/.test(visual) && /\b(media|image|video|panel|screenshot|half)\b/.test(visual)) {
    return 'bottom media';
  }
  if (/\b(split|two panel|two-panel|side by side|side-by-side|pip|picture in picture|picture-in-picture)\b/.test(visual)) {
    return 'split/PiP';
  }
  if (shot.overlays.some((o) => o.kind === 'pip_video')) return 'PiP overlay';
  if (/\b(screenshot|screen grab|tweet|post|article|document|chart|graph|slide|card)\b/.test(visual)) {
    return 'screenshot/card';
  }
  if (shot.clip_type === 'talking_head' || shot.clip_type === 'talking_head_unknown') {
    return `talking head ${regionLabel(shot.face_region)}`;
  }
  return 'full-frame b-roll';
}

function l1Kind(shot: ReelShot): string {
  if (shot.clip_type === 'talking_head' || shot.clip_type === 'talking_head_unknown') {
    return `talking head ${regionLabel(shot.face_region)}`;
  }
  if (shot.clip_type === 'broll_talking_head') {
    return `b-roll person ${regionLabel(shot.face_region)}`;
  }
  return clipTypeLabel(shot.clip_type);
}

function l2Kind(shot: ReelShot): string {
  if (shot.overlays.length > 0) {
    const first = shot.overlays[0];
    return `${first.kind.replace(/_/g, ' ')} ${regionLabel(first.region)}`;
  }
  const visual = `${shot.visual_caption ?? ''}`.toLowerCase();
  if (/\b(overlaid|overlay|floating|foreground|insert|sticker|badge|callout)\b/.test(visual)) {
    return 'inferred foreground media';
  }
  if (/\b(screenshot|screen grab|tweet|post|article|document|chart|graph|slide|card|poster|flyer|invitation)\b/.test(visual)) {
    return 'inferred screenshot/card';
  }
  if (/\b(split|pip|picture in picture|picture-in-picture)\b/.test(visual)) {
    return 'inferred split/PiP media';
  }
  return 'none';
}

function l3Kind(shot: ReelShot): string {
  const caption = shot.text_moments.find((t) => t.role === 'subtitle');
  if (caption) return `subtitle ${regionLabel(caption.region)}`;
  const title = shot.text_moments.find((t) => t.role === 'title');
  if (title) return `title ${regionLabel(title.region)}`;
  const overlay = shot.text_moments.find((t) => t.role !== 'image_text');
  if (overlay) return `text ${regionLabel(overlay.region)}`;
  const imageText = shot.text_moments.find((t) => t.role === 'image_text');
  if (imageText) return 'in-image text ignored';
  return 'none';
}

function structureToken(shot: ReelShot): string {
  const speech = shot.spoken_window ? 'spoken' : 'silent';
  return `${rhythmBucket(shot.end_ms - shot.start_ms)} ${l1Kind(shot)} ${speech}`;
}

function countPatterns(values: string[], max = 6): ClipnosisPatternCount[] {
  const counts = new Map<string, { count: number; shots: number[] }>();
  values.forEach((label, idx) => {
    const current = counts.get(label) ?? { count: 0, shots: [] };
    current.count++;
    current.shots.push(idx);
    counts.set(label, current);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, max)
    .map(([label, item]) => ({
      label,
      count: item.count,
      pct: pct(item.count, values.length),
      example_shots: item.shots.slice(0, 4),
    }));
}

function runLength(values: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = i;
    const label = values[i];
    while (i + 1 < values.length && values[i + 1] === label) i++;
    const end = i;
    out.push(start === end ? `${start + 1}:${label}` : `${start + 1}-${end + 1}:${label}`);
  }
  return out;
}

function scriptVisualRules(shots: ReelShot[]): ClipnosisScriptVisualRule[] {
  const grouped = new Map<string, ClipnosisScriptVisualRule>();
  shots.forEach((shot, idx) => {
    const l2 = l2Kind(shot);
    const layout = layoutKind(shot);
    const hasVisualResponse =
      l2 !== 'none' ||
      /screenshot|card|split|PiP|top media|bottom media/i.test(layout);
    if (!hasVisualResponse) return;
    const trigger = tokenWords(shot.spoken_window || shot.ocr_text || '', 4);
    const key = `${l2}|${trigger.join(' ') || idx}`;
    const current =
      grouped.get(key) ??
      {
        trigger_keywords: trigger,
        visual_response: l2 !== 'none' ? l2 : layout,
        layer: 'L2' as const,
        shot_idxs: [],
        examples: [],
      };
    current.shot_idxs.push(idx);
    const example = clip(shot.spoken_window || shot.visual_caption || shot.ocr_text, 110);
    if (example) current.examples.push(example);
    grouped.set(key, current);
  });
  return [...grouped.values()]
    .sort((a, b) => b.shot_idxs.length - a.shot_idxs.length)
    .slice(0, 8);
}

function captionDescription(captionStyle: CaptionStyleProfile | null): string {
  if (!captionStyle?.present) return 'No reproducible spoken-caption system detected.';
  const parts = [
    captionStyle.preset_label || captionStyle.style_label || 'custom captions',
    captionStyle.position,
    captionStyle.chunking,
    captionStyle.casing,
    captionStyle.text_treatment,
    captionStyle.animation,
  ].filter(Boolean);
  return parts.join(' / ');
}

function soundDescription(sfxContext: SfxContext | null, sfxPerMin: number, cutHitPct: number): string {
  if (sfxContext?.pattern_summary) return sfxContext.pattern_summary;
  if (sfxPerMin <= 1) return 'Sparse or no SFX system.';
  if (cutHitPct >= 0.45) return 'Cut-synced impact hits are part of the style.';
  return 'SFX are present but not primarily cut-synced.';
}

export function buildClipnosisStyleSignature(input: {
  shots: ReelShot[];
  durationMs: number;
  medianShotMs: number;
  cutsPerSec: number;
  captionStyle: CaptionStyleProfile | null;
  sfxContext: SfxContext | null;
  sfxPerMin: number;
  cutsWithSfxPct: number;
}): ClipnosisStyleSignature | null {
  const { shots } = input;
  if (shots.length === 0) return null;

  const l1 = shots.map(l1Kind);
  const l2 = shots.map(l2Kind);
  const l3 = shots.map(l3Kind);
  const layouts = shots.map(layoutKind);
  const rhythm = shots.map((shot) => rhythmBucket(shot.end_ms - shot.start_ms));
  const structure = shots.map(structureToken);
  const motionSequence = shots.map((shot) => shot.detected_motion?.kind ?? 'unknown');
  const movingCount = shots.filter(
    (shot) => shot.detected_motion && shot.detected_motion.kind !== 'none',
  ).length;
  const motionMeasured = shots.some((shot) => shot.detected_motion);
  const movingPct = motionMeasured ? pct(movingCount, shots.length) : null;
  const dominantMotion = motionMeasured
    ? countPatterns(motionSequence, 1)[0]?.label ?? null
    : null;
  const scriptRules = scriptVisualRules(shots);
  const l2Counts = countPatterns(l2);
  const topL1 = countPatterns(l1, 1)[0]?.label ?? 'mixed media';
  const topLayout = countPatterns(layouts, 1)[0]?.label ?? 'mixed layout';
  const tempo = tempoFromMedian(input.medianShotMs);
  const captionText = captionDescription(input.captionStyle);
  const soundText = soundDescription(
    input.sfxContext,
    input.sfxPerMin,
    input.cutsWithSfxPct,
  );
  const l2Rule =
    l2Counts.find((item) => item.label !== 'none') ??
    l2Counts[0] ??
    null;

  const confidenceSignals = [
    shots.length >= 4,
    shots.some((shot) => shot.visual_caption),
    shots.some((shot) => shot.spoken_window),
    shots.some((shot) => shot.text_moments.length > 0),
    motionMeasured,
    input.captionStyle !== null,
    input.sfxContext !== null || shots.some((shot) => shot.sfx_count > 0),
  ];
  const confidence =
    Math.round(
      (confidenceSignals.filter(Boolean).length / confidenceSignals.length) * 100,
    ) / 100;

  const reproductionRules = [
    `Use a ${tempo} rhythm with ${shots.length} shots and median shot length around ${(input.medianShotMs / 1000).toFixed(1)}s.`,
    `Preserve the layout grammar: ${runLength(layouts).slice(0, 5).join(' -> ')}.`,
    `Keep Layer 1 centered on ${topL1}; primary layout is ${topLayout}.`,
    l2Rule && l2Rule.label !== 'none'
      ? `Use Layer 2 ${l2Rule.label} on similar script beats (${Math.round(l2Rule.pct * 100)}% of shots).`
      : 'Keep Layer 2 mostly empty unless the script beat needs a sourced card/screenshot.',
    `Caption system: ${captionText}`,
    `Sound system: ${soundText}`,
  ];
  if (scriptRules.length > 0) {
    reproductionRules.push(
      `Script-to-visual rule: when ${scriptRules[0].trigger_keywords.join(', ') || 'the key claim'} appears, show ${scriptRules[0].visual_response}.`,
    );
  }

  return {
    version: 1,
    engine: 'clipnosis-signature-v1',
    summary: `${tempo} ${shots.length}-shot edit; ${topLayout}; L1 ${topL1}; ${l2Rule && l2Rule.label !== 'none' ? `L2 ${l2Rule.label}` : 'minimal L2'}; ${captionText}.`,
    confidence,
    shot_count: shots.length,
    duration_ms: input.durationMs,
    rhythm: {
      median_shot_ms: input.medianShotMs,
      cuts_per_sec: input.cutsPerSec,
      tempo,
      duration_sequence: rhythm,
    },
    grammar: {
      structure_sequence: runLength(structure),
      layout_sequence: runLength(layouts),
      layer_sequence: shots.map((_shot, idx) => `${idx + 1}:L1=${l1[idx]};L2=${l2[idx]};L3=${l3[idx]}`),
      rhythm_sequence: runLength(rhythm),
    },
    layers: {
      l1_media: countPatterns(l1),
      l2_visuals: l2Counts,
      l3_text: countPatterns(l3),
    },
    script_visual_rules: scriptRules,
    caption_system: {
      present: input.captionStyle?.present === true,
      description: captionText,
    },
    motion_system: {
      moving_pct: movingPct,
      dominant: dominantMotion,
      sequence: motionSequence,
    },
    sound_system: {
      sfx_per_min: input.sfxPerMin,
      cut_hit_pct: input.cutsWithSfxPct,
      description: soundText,
    },
    reproduction_rules: reproductionRules,
  };
}
