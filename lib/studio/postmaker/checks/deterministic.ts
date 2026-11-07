// The deterministic part of `check`: what one language's proof is measured on (the
// `CheckSubject`), the six Proof rows ("Checks (6)": loudness, safe zones, caption-to-alignment match, AI
// label, fonts, frame count), the lints that carry frame numbers (pacing, flash, lip-sync QA, tier ceiling, language
// lint) and the caps they put on a drafted score. Nothing is assumed: an input that is not there is "not measured",
// the row fails, and the criterion it would evidence cannot reach the score that needs it.
import { t } from '@/app/studio/copy/en';
import type { AlignmentDoc, CaptionsDoc } from '../graph/adapters';
import type { CheckId, CriterionId, DeterministicCheck, Lang, Medium, PreviewStrip, RubricEvidence, RubricScoreValue, SignOff } from '../types';
import { aiLabelCheck, provenanceGaps, type AiLabelInput, type ProvenanceAsset } from './aiLabel';
import { captionCoverage } from './captionCoverage';
import { flashLint } from './flash';
import { fontsCheck, frameCountCheck, type FontUse } from './fonts';
import { lipsyncLineQa, type LipsyncLine } from './lipsyncQa';
import { loudnessCheck, type LoudnessMeasure } from './loudness';
import { pacingLint, type PacingTimeline } from './pacing';
import { safeZoneReport, type LayoutFrame, type Reserve } from './safeZoneReport';
import { c5Ceiling, type CharacterPresence } from './tierCeiling';

export const CHECK_IDS = ['loudness', 'safe-zones', 'caption-match', 'ai-label', 'fonts', 'frame-count'] as const satisfies readonly CheckId[];

/** Everything one language's proof is measured on. Absent (null) = not measured. */
export interface CheckSubject {
  lang: Lang;
  medium: Medium;
  animated?: boolean;
  fps: number;
  frames: { video: number | null; timeline: number | null; master: number | null };
  loudness: LoudnessMeasure | null;
  layout: { frames: LayoutFrame[]; reserves: Reserve[]; cutFrames: number[] } | null;
  captions: { alignment: AlignmentDoc; pages: CaptionsDoc } | null;
  aiLabel: AiLabelInput | null;
  provenance: ProvenanceAsset[] | null;
  fonts: { used: FontUse[]; allowed: { family: string; sha256: string }[] } | null;
  pacing: PacingTimeline | null;
  /** Mean relative luminance per frame (flash lint). */
  luminance: number[] | null;
  characters: { list: CharacterPresence[]; characterLed?: boolean } | null;
  lipsync: LipsyncLine[] | null;
  /** The narration-text step's language lint (error count and rule ids), from its version checks. */
  langLint: { errors: number; ruleIds: string[] } | null;
  /** Current sign-off records (storage, through `deps.signoffs`) and the current version hashes by node. */
  signoffs: SignOff[];
  hashes: Record<string, readonly string[]>;
  strip: PreviewStrip | null;
  /** Trusted context for the reviewer prompt (never instructions): the hook text, the caption, the beat list. */
  summary: { hook: string | null; caption: string | null; beats: { id: string; segment: string; from: number; to: number }[] };
}

export interface Cap {
  max: RubricScoreValue;
  reason: string;
  evidence: RubricEvidence;
}

export interface DeterministicReport {
  checks: DeterministicCheck[];
  /** Upper bounds on drafted scores (the lowest cap per criterion wins). */
  caps: Partial<Record<CriterionId, Cap>>;
  /** Evidence items every drafted score of a criterion gets (measures and reports, never a score). */
  evidence: Partial<Record<CriterionId, RubricEvidence[]>>;
  findings: { id: string; frame: number | null; text: string }[];
}

const row = (id: CheckId, ok: boolean, measured: boolean, reason: string | null, evidence: RubricEvidence[] = []): DeterministicCheck => ({ id, ok: ok && measured, measured, reason: measured ? reason : t('check.notMeasured'), evidence });

export function runDeterministic(s: CheckSubject): DeterministicReport {
  const caps: DeterministicReport['caps'] = {};
  const evidence: DeterministicReport['evidence'] = {};
  const findings: DeterministicReport['findings'] = [];
  const cap = (c: CriterionId, max: RubricScoreValue, reason: string, ev: RubricEvidence) => {
    if (!caps[c] || caps[c]!.max > max) caps[c] = { max, reason, evidence: ev };
  };
  const cite = (c: CriterionId, ev: RubricEvidence) => (evidence[c] ??= []).push(ev);
  const checks: DeterministicCheck[] = [];

  // Loudness → C9
  if (s.loudness) {
    const r = loudnessCheck(s.loudness);
    const ev: RubricEvidence = { kind: 'measure', ref: 'loudness:master', value: `I ${s.loudness.i} LUFS, TP ${s.loudness.tp ?? '?'} dBTP, LRA ${s.loudness.lra ?? '?'}` };
    cite('C9', ev);
    if (!r.ok) cap('C9', 1, r.reasons[0]!, ev);
    checks.push(row('loudness', r.ok, true, r.reasons[0] ?? null, [ev]));
  } else {
    if (s.medium === 'video') cap('C9', 4, t('check.notMeasured'), { kind: 'report', ref: 'check:loudness', value: 'not measured' });
    checks.push(row('loudness', false, false, null));
  }

  // Safe zones → C3 (hard gate: unmeasured cannot be 5)
  if (s.layout && s.layout.frames.length && s.layout.reserves.length) {
    const r = safeZoneReport(s.layout.frames, s.layout.reserves, { totalFrames: s.frames.video ?? undefined, cutFrames: s.layout.cutFrames });
    const ev: RubricEvidence = { kind: 'report', ref: 'check:safe-zones', value: `${r.intersections.length} intersections on ${r.sampled.length} frames` };
    cite('C3', ev);
    const reason = r.ok ? null : t('check.safeZones.hit', { count: r.intersections.length, frame: r.intersections[0]?.frame ?? 0 });
    if (!r.ok) {
      cap('C3', 1, reason!, ev);
      for (const x of r.intersections.slice(0, 5)) findings.push({ id: 'safe-zones', frame: x.frame, text: `${x.layerId} in ${x.reserveId}` });
    } else if (r.decoration.length) cap('C3', 3, t('check.safeZones.hit', { count: r.decoration.length, frame: r.decoration[0]!.frame }), ev);
    checks.push(row('safe-zones', r.ok, true, reason, [ev]));
  } else {
    cap('C3', 4, t('check.notMeasured'), { kind: 'report', ref: 'check:safe-zones', value: 'not measured' });
    checks.push(row('safe-zones', false, false, null));
  }

  // Caption-to-alignment match and coverage → C12
  if (s.captions) {
    const r = captionCoverage(s.captions.alignment, s.captions.pages, s.fps);
    const ev: RubricEvidence = { kind: 'measure', ref: 'captions:coverage', value: `${r.pct} % (${r.captioned}/${r.spoken} words)` };
    cite('C12', ev);
    const reason = r.mismatch ? t('check.captions.mismatch', { line: r.mismatch.lineId }) : r.ok ? null : t('check.captions.coverage', { pct: r.pct });
    if (!r.ok) cap('C12', 3, reason!, ev);
    checks.push(row('caption-match', r.ok, true, reason, [ev]));
  } else {
    if (s.medium === 'video') cap('C12', 4, t('check.notMeasured'), { kind: 'report', ref: 'check:caption-match', value: 'not measured' });
    checks.push(row('caption-match', false, false, null));
  }

  // AI label, flag and provenance → C11 (hard gate)
  const gaps = s.provenance ? provenanceGaps(s.provenance) : null;
  if (gaps && gaps.length) {
    const ev: RubricEvidence = { kind: 'report', ref: 'provenance:licences', value: gaps.slice(0, 6).join(', ') };
    cite('C11', ev);
    cap('C11', 3, t('check.aiLabel.licence', { count: gaps.length }), ev);
  } else if (gaps) cite('C11', { kind: 'report', ref: 'provenance:licences', value: 'complete' });
  if (s.aiLabel) {
    const r = aiLabelCheck(s.aiLabel);
    const ev: RubricEvidence = { kind: 'report', ref: 'check:ai-label', value: r.ok ? 'present on first and last frames' : r.reasons[0]! };
    cite('C11', ev);
    if (!r.ok) {
      // Only the post's AI flag is wrong: a record is incomplete (C11 = 3) and the fix is the caption step's.
      const onlyFlag = r.reasons.length === 1 && r.reasons[0] === t('check.aiLabel.flag');
      cap('C11', onlyFlag ? 3 : 1, r.reasons[0]!, onlyFlag ? { ...ev, ref: 'flag:meta' } : ev);
    }
    checks.push(row('ai-label', r.ok, true, r.reasons[0] ?? null, [ev]));
  } else {
    cap('C11', 4, t('check.notMeasured'), { kind: 'report', ref: 'check:ai-label', value: 'not measured' });
    checks.push(row('ai-label', false, false, null));
  }
  if (!s.provenance) cap('C11', 4, t('check.notMeasured'), { kind: 'report', ref: 'provenance:licences', value: 'not measured' });

  // Fonts → C4
  if (s.fonts) {
    const r = fontsCheck(s.fonts.used, s.fonts.allowed);
    const ev: RubricEvidence = { kind: 'report', ref: 'render:fonts', value: r.families.join(', ') || 'none' };
    cite('C4', ev);
    if (!r.ok) cap('C4', 1, r.reasons[0]!, ev);
    checks.push(row('fonts', r.ok, true, r.reasons[0] ?? null, [ev]));
  } else {
    cap('C4', 4, t('check.notMeasured'), { kind: 'report', ref: 'check:fonts', value: 'not measured' });
    checks.push(row('fonts', false, false, null));
  }

  // Frame count (render validation)
  const fc = frameCountCheck(s.frames);
  checks.push(row('frame-count', fc.ok, fc.measured, fc.reason, fc.measured ? [{ kind: 'measure', ref: 'render:frames', value: `${s.frames.video} / ${s.frames.timeline}` }] : []));

  // Lints with frame numbers
  if (s.pacing) {
    const r = pacingLint(s.pacing);
    const ev: RubricEvidence = { kind: 'measure', ref: 'timing:beats', value: `longest gap ${r.longestGap.frames} frames from ${r.longestGap.from}${r.maxChantOffset !== null ? `; chant offset ≤ ${r.maxChantOffset}` : ''}${r.endCardFrames !== null ? `; end card ${r.endCardFrames}` : ''}` };
    cite('C6', ev);
    for (const v of r.violations) findings.push({ id: `pacing.${v.id}`, frame: v.frame, text: v.text });
    const hook = r.violations.find((v) => v.id === 'hook');
    if (hook) cap('C1', 3, hook.text, { kind: 'measure', ref: 'hook:complete', value: `frame ${hook.frame}` });
    const offBeat = r.violations.find((v) => v.id === 'chant-off-beat');
    const other = r.violations.find((v) => v.id !== 'hook' && v.id !== 'hook-unknown');
    if (offBeat) cap('C6', 3, offBeat.text, { kind: 'measure', ref: 'downbeat:chant', value: `frame ${offBeat.frame}` });
    else if (other) cap('C6', 3, other.text, ev);
  } else if (s.medium !== 'feed') cap('C6', 4, t('check.notMeasured'), { kind: 'report', ref: 'timing:beats', value: 'not measured' });

  if (s.luminance) {
    const r = flashLint(s.luminance, s.fps);
    const ev: RubricEvidence = { kind: 'measure', ref: 'flash:luminance', value: `max ${r.worst.count} per 1 s at frame ${r.worst.frame}` };
    cite('C12', ev);
    if (!r.ok) {
      cap('C12', 1, r.text!, ev);
      findings.push({ id: 'flash', frame: r.worst.frame, text: r.text! });
    }
  } else if (s.medium === 'video') cap('C12', 4, t('check.notMeasured'), { kind: 'report', ref: 'flash:luminance', value: 'not measured' });

  if (s.characters && s.frames.video) {
    const c = c5Ceiling(s.characters.list, s.frames.video, { characterLed: s.characters.characterLed });
    if (c.max < 5) cap('C5', c.max, c.text!, { kind: 'report', ref: `rig:${c.limitedBy}`, value: `ceiling ${c.max}` });
  }

  if (s.lipsync) {
    for (const l of s.lipsync) {
      const r = lipsyncLineQa(l);
      if (!r.ok) {
        for (const why of r.reasons) findings.push({ id: 'lipsync', frame: null, text: why });
        cap('C5', 3, r.reasons[0]!, { kind: 'measure', ref: `lipsync:${l.lineId}`, value: `lag ${r.lag}, coverage ${r.coverage}` });
      }
    }
  }

  if (s.langLint) {
    const ev: RubricEvidence = { kind: 'report', ref: `text:lint-${s.lang}`, value: s.langLint.errors ? s.langLint.ruleIds.slice(0, 6).join(', ') : 'zero errors' };
    cite('C8', ev);
    if (s.langLint.errors > 0) {
      const why = t('check.lang.lint', { count: s.langLint.errors });
      cap('C8', 1, why, ev);
      findings.push({ id: 'lang.lint', frame: null, text: why });
    }
  } else cap('C8', 4, t('check.notMeasured'), { kind: 'report', ref: `text:lint-${s.lang}`, value: 'not measured' });

  return { checks, caps, evidence, findings };
}
