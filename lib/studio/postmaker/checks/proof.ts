// The Proof projection: the verdict pill, the three hard gates, the deterministic rows, the
// 12-criteria disclosure with evidence and the routed fixes, one per language. The Proof screen shows it next to the
// accept state; this module decides nothing about Accept beyond "the verdict alone allows it" (Premium or Standard).
import { t } from '@/app/studio/copy/en';
import type { CheckResult, ProofProjection, RoutesDoc, RubricSheet } from '../types';
import { HARD_GATES, isConfirmed } from './rubric';

export function proofProjection(sheet: RubricSheet, routes: RoutesDoc | null): ProofProjection {
  const byId = new Map(sheet.scores.map((s) => [s.criterion, s]));
  return {
    lang: sheet.lang,
    verdict: sheet.verdict,
    scoredBy: sheet.scoredBy,
    unscored: sheet.verdict === 'unscored' ? { reason: sheet.unscoredReason ?? t('check.unscored.noReviewer') } : null,
    manualScoring: sheet.verdict === 'unscored',
    verdictAllowsAccept: sheet.verdict === 'premium' || sheet.verdict === 'standard',
    mean: sheet.mean,
    hardGates: HARD_GATES.map((c) => {
      const s = byId.get(c)!;
      return {
        criterion: c,
        score: s.score,
        passed: s.score === 5,
        confirmed: isConfirmed(s, sheet.lang),
        needs: isConfirmed(s, sheet.lang) ? null : c === 'C8' && sheet.lang === 'fa' ? 'native-editor-fa' : 'owner',
      };
    }),
    checks: sheet.checks.map((c) => ({ id: c.id, ok: c.ok, measured: c.measured, reason: c.ok ? null : c.reason })),
    criteria: sheet.scores.map((s) => ({ criterion: s.criterion, applicable: s.applicable, score: s.score, evidence: s.evidence, confirmedBy: s.confirmedBy, note: s.note, owningStep: s.owningStep })),
    routes: (routes?.routes ?? []).filter((r) => r.lang === sheet.lang),
  };
}

/** Every language of a check result. */
export const proofProjections = (result: CheckResult, routes: RoutesDoc | null): ProofProjection[] => result.sheets.map((s) => proofProjection(s, routes));

/** The verdict word for the pill (copy dictionary). */
export const verdictLabel = (v: ProofProjection['verdict']): string => t(`check.verdict.${v}`);
