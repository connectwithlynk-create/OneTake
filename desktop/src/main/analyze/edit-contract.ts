import type { EditingBrief } from './brief';
import type { ShotPlan, SuggestedEdit } from './synthesize';

export type EditContractSeverity = 'warning' | 'error';

export interface EditContractRule {
  id: string;
  label: string;
  requirement: string;
  rationale?: string;
}

export interface EditContractSection {
  role: string;
  start_ms: number;
  end_ms: number;
  shot_count: number;
  layout_pattern: string;
  shot_type_pattern: string;
  caption_pattern: string;
  overlay_pattern: string;
  motion_pattern: string;
  sfx_pattern: string;
}

export interface EditShotContract {
  shot_idx: number;
  start_ms: number;
  end_ms: number;
  structure_role: string;
  script_trigger: string;
  l1_media: string;
  l2_visual_overlay: string;
  l3_captions: string;
  layout: {
    fit: ShotPlan['placement']['fit'];
    position: ShotPlan['placement']['position'];
    aspect: ShotPlan['placement']['aspect'];
    scale: number;
  };
  motion: string;
  sfx: string | null;
  source_category: string;
  source_method: ShotPlan['asset']['method'];
  source_instruction: string;
  requirements: string[];
}

export interface EditContract {
  version: 1;
  summary: string;
  source: {
    structure_confidence: SuggestedEdit['structure_confidence'];
    brief_ai_generated?: boolean;
  };
  global_rules: EditContractRule[];
  sections: EditContractSection[];
  shots: EditShotContract[];
}

export interface EditContractIssue {
  severity: EditContractSeverity;
  rule_id: string;
  shot_idx?: number;
  message: string;
  expected?: string;
  actual?: string;
}

export interface EditContractValidation {
  ok: boolean;
  score: number;
  passed: number;
  total: number;
  issues: EditContractIssue[];
  checked_at: number;
}

function clip(value: string | null | undefined, max = 180): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function labelClipType(value: ShotPlan['clip_type']): string {
  return value.replace(/_/g, ' ');
}

function labelFit(value: ShotPlan['placement']['fit']): string {
  switch (value) {
    case 'fill':
      return 'full-frame';
    case 'contain':
      return 'actual-size contained media';
    case 'pip':
      return 'picture-in-picture';
    case 'split_top':
      return 'top media split';
    case 'split_bottom':
      return 'bottom media split';
    case 'split_left':
      return 'left media split';
    case 'split_right':
      return 'right media split';
    default:
      return value.replace(/_/g, ' ');
  }
}

function assetInstruction(shot: ShotPlan): string {
  const asset = shot.asset;
  if (asset.web_capture) return asset.web_capture.focus || asset.web_capture.url || '';
  if (asset.library_search) return asset.library_search.query;
  if (asset.stock_search) return asset.stock_search.query;
  if (asset.generate_image) return asset.generate_image.prompt;
  if (asset.manual) return asset.manual.instruction;
  return shot.broll_description;
}

function l1MediaRule(shot: ShotPlan): string {
  const base = labelClipType(shot.clip_type);
  const desc = clip(shot.broll_description, 140);
  return desc ? `${base}: ${desc}` : base;
}

function l2OverlayRule(shot: ShotPlan): string {
  const fit = labelFit(shot.placement.fit);
  const pos = shot.placement.position.replace(/_/g, ' ');
  const instruction = clip(assetInstruction(shot), 150);
  const trigger = clip(shot.spoken_during, 90);
  const source = instruction || clip(shot.broll_description, 150);
  const timing = trigger ? ` when "${trigger}" is said` : ' during this silent beat';
  if (shot.placement.fit === 'fill') {
    return `Use the planned full-frame visual${timing}: ${source || 'match the shot topic'}.`;
  }
  return `Use a ${fit} visual at ${pos}${timing}: ${source || 'match the shot topic'}.`;
}

function l3CaptionRule(plan: SuggestedEdit, shot: ShotPlan): string {
  const spec = plan.subtitle_spec;
  if (!spec?.enabled) return 'No generated spoken-word captions.';
  const position = shot.subtitle_position ?? spec.position;
  const style = [
    spec.preset_label || spec.preset_id,
    position,
    spec.chunking,
    spec.text_treatment,
  ]
    .filter(Boolean)
    .join(', ');
  return `Spoken-word captions only; ignore text embedded inside screenshots/cards. Style: ${style}.`;
}

function shotRequirements(plan: SuggestedEdit, shot: ShotPlan): string[] {
  const reqs = [
    `L1 media: ${l1MediaRule(shot)}`,
    `L2 visual: ${l2OverlayRule(shot)}`,
    `L3 captions: ${l3CaptionRule(plan, shot)}`,
    `Layout: ${labelFit(shot.placement.fit)} at ${shot.placement.position.replace(/_/g, ' ')}`,
    `Source: ${shot.source_type || shot.asset.method} via ${shot.asset.method}`,
  ];
  if (shot.scene_animation && shot.scene_animation !== 'none') {
    reqs.push(`Motion: ${shot.scene_animation.replace(/_/g, ' ')}`);
  }
  if (shot.sfx_cue) reqs.push(`SFX: ${shot.sfx_cue}`);
  return reqs;
}

function briefRules(brief: EditingBrief | null | undefined): EditContractRule[] {
  if (!brief) return [];
  const rules: EditContractRule[] = [];
  let i = 0;
  for (const section of brief.sections.slice(0, 6)) {
    for (const directive of section.directives.slice(0, 2)) {
      const text = clip(directive, 220);
      if (!text) continue;
      rules.push({
        id: `brief_${i++}`,
        label: section.title,
        requirement: text,
        rationale: section.tag,
      });
    }
  }
  return rules;
}

export function buildEditContract(
  plan: SuggestedEdit,
  brief?: EditingBrief | null,
): EditContract {
  const sourcePatterns = plan.content_source_patterns.filter(Boolean);
  const globalRules: EditContractRule[] = [
    {
      id: 'shot_count',
      label: 'Shot count',
      requirement: `Keep exactly ${plan.shots.length} shots unless the user explicitly edits timing.`,
    },
    {
      id: 'structure_sequence',
      label: 'Structure',
      requirement: `Preserve the role sequence: ${plan.shots
        .map((s) => s.structure_role || 'unspecified')
        .join(' -> ')}.`,
    },
    {
      id: 'script_triggers',
      label: 'Script triggers',
      requirement:
        'Place each planned visual on the same spoken beat listed in the shot contract.',
    },
    {
      id: 'layer_split',
      label: 'Layers',
      requirement:
        'Treat L1 as base media, L2 as visual/card/screenshot/PiP media, and L3 as spoken-word captions only.',
    },
  ];

  if (plan.subtitle_spec?.enabled) {
    globalRules.push({
      id: 'caption_style',
      label: 'Caption style',
      requirement: `Use ${plan.subtitle_spec.preset_label || plan.subtitle_spec.preset_id} captions at ${plan.subtitle_spec.position}, ${plan.subtitle_spec.chunking}, ${plan.subtitle_spec.text_treatment}.`,
    });
  }
  if (sourcePatterns.length > 0) {
    globalRules.push({
      id: 'source_categories',
      label: 'Source categories',
      requirement: `Pull content from these categories where relevant: ${sourcePatterns.join('; ')}.`,
    });
  }

  const sections: EditContractSection[] = plan.structure_sections.map((section) => ({
    role: section.role,
    start_ms: section.target_start_ms,
    end_ms: section.target_end_ms,
    shot_count: section.shot_count,
    layout_pattern: section.visual_signature.placement_pattern,
    shot_type_pattern: section.visual_signature.shot_type_pattern,
    caption_pattern: section.visual_signature.text_overlay_pattern,
    overlay_pattern: section.visual_signature.scene_elements.join('; ') || 'none',
    motion_pattern: section.visual_signature.motion_pattern,
    sfx_pattern: section.visual_signature.sfx_pattern,
  }));

  const shots: EditShotContract[] = plan.shots.map((shot) => ({
    shot_idx: shot.shot_idx,
    start_ms: shot.start_ms,
    end_ms: shot.end_ms,
    structure_role: shot.structure_role,
    script_trigger: clip(shot.spoken_during, 220),
    l1_media: l1MediaRule(shot),
    l2_visual_overlay: l2OverlayRule(shot),
    l3_captions: l3CaptionRule(plan, shot),
    layout: {
      fit: shot.placement.fit,
      position: shot.placement.position,
      aspect: shot.placement.aspect,
      scale: shot.placement.scale,
    },
    motion: shot.scene_animation,
    sfx: shot.sfx_cue,
    source_category: shot.source_type || shot.asset.method,
    source_method: shot.asset.method,
    source_instruction: clip(assetInstruction(shot), 220),
    requirements: shotRequirements(plan, shot),
  }));

  const summary =
    plan.structure_sections[0]?.target_fill ||
    plan.style_summary.split('\n')[0]?.trim() ||
    `${plan.shots.length}-shot edit contract`;

  return {
    version: 1,
    summary: clip(summary, 220),
    source: {
      structure_confidence: plan.structure_confidence,
      brief_ai_generated: brief?.ai_generated,
    },
    global_rules: [...globalRules, ...briefRules(brief)],
    sections,
    shots,
  };
}

function normalize(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function checkEqual(
  issues: EditContractIssue[],
  ruleId: string,
  expected: string,
  actual: string,
  message: string,
  shotIdx?: number,
): boolean {
  if (normalize(expected) === normalize(actual)) return true;
  issues.push({
    severity: 'warning',
    rule_id: ruleId,
    shot_idx: shotIdx,
    message,
    expected,
    actual,
  });
  return false;
}

export function validateEditContract(
  plan: SuggestedEdit,
  contract: EditContract,
): EditContractValidation {
  const issues: EditContractIssue[] = [];
  let total = 0;
  let passed = 0;

  const check = (ok: boolean): void => {
    total++;
    if (ok) passed++;
  };

  check(plan.shots.length === contract.shots.length);
  if (plan.shots.length !== contract.shots.length) {
    issues.push({
      severity: 'error',
      rule_id: 'shot_count',
      message: 'Shot count drifted from the contract.',
      expected: String(contract.shots.length),
      actual: String(plan.shots.length),
    });
  }

  const expectedDuration = contract.shots[contract.shots.length - 1]?.end_ms ?? 0;
  if (expectedDuration > 0) {
    const delta = Math.abs(plan.total_duration_ms - expectedDuration);
    check(delta <= 1200);
    if (delta > 1200) {
      issues.push({
        severity: 'warning',
        rule_id: 'duration',
        message: 'Total duration drifted by more than 1.2s.',
        expected: `${expectedDuration}ms`,
        actual: `${plan.total_duration_ms}ms`,
      });
    }
  }

  const shotsByIdx = new Map(plan.shots.map((shot) => [shot.shot_idx, shot]));
  for (const expected of contract.shots) {
    const shot = shotsByIdx.get(expected.shot_idx);
    check(!!shot);
    if (!shot) {
      issues.push({
        severity: 'error',
        rule_id: 'shot_present',
        shot_idx: expected.shot_idx,
        message: 'Contract shot is missing from the plan.',
      });
      continue;
    }
    check(
      checkEqual(
        issues,
        'structure_role',
        expected.structure_role,
        shot.structure_role,
        'Shot structure role no longer matches the contract.',
        shot.shot_idx,
      ),
    );
    check(
      checkEqual(
        issues,
        'clip_type',
        expected.l1_media.split(':')[0] ?? '',
        labelClipType(shot.clip_type),
        'L1 media type drifted from the contract.',
        shot.shot_idx,
      ),
    );
    check(
      checkEqual(
        issues,
        'layout_fit',
        expected.layout.fit,
        shot.placement.fit,
        'Shot layout fit no longer matches the contract.',
        shot.shot_idx,
      ),
    );
    check(
      checkEqual(
        issues,
        'layout_position',
        expected.layout.position,
        shot.placement.position,
        'Shot layout position no longer matches the contract.',
        shot.shot_idx,
      ),
    );
    check(
      checkEqual(
        issues,
        'source_method',
        expected.source_method,
        shot.asset.method,
        'Source acquisition method changed from the contract.',
        shot.shot_idx,
      ),
    );
    if (expected.motion && expected.motion !== 'none') {
      check(
        checkEqual(
          issues,
          'motion',
          expected.motion,
          shot.scene_animation,
          'Motion preset changed from the contract.',
          shot.shot_idx,
        ),
      );
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ok: errorCount === 0,
    score: total > 0 ? Math.round((passed / total) * 100) : 100,
    passed,
    total,
    issues,
    checked_at: Date.now(),
  };
}

export function ensureEditContract(
  plan: SuggestedEdit,
  brief?: EditingBrief | null,
): SuggestedEdit {
  const contract = plan.edit_contract ?? buildEditContract(plan, brief ?? null);
  return {
    ...plan,
    edit_contract: contract,
    contract_validation: validateEditContract(plan, contract),
  };
}
