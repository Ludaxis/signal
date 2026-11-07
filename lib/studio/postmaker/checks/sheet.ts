// One language's rubric sheet: the reviewer's drafted scores merged with the deterministic report.
// Deterministic evidence is added to every applicable row; a cap lowers a drafted score (with the cap's evidence and
// reason), so a reviewer cannot score C3 at 5 over a failed safe-zone report or C5 above the rig tier's ceiling. With no
// reviewer answer every row stays unscored: the verdict is Unscored and the rows carry the measured evidence.
import { PostmakerError } from '../errors';
import { t } from '@/app/studio/copy/en';
import type { CriterionId, ReviewerPath, RubricScore, RubricScoreValue, RubricSheet } from '../types';
import type { DeterministicReport } from './deterministic';
import { CRITERIA_IDS, RUBRIC_VERSION, applies, blankScore, meanOf, owningStepOf, validateSheet, type ReviewerAnswer } from './rubric';
import { verdict } from './verdict';

/** Refuses an answer whose applicability disagrees with the medium (a reviewer may not drop an applicable criterion). */
export function checkAnswerApplicability(answer: ReviewerAnswer, medium: RubricSheet['medium'], o: { animated?: boolean } = {}): void {
  for (const s of answer.scores) {
    if (applies(s.criterion, medium, o) && !s.applicable) throw new PostmakerError(422, 'rubric-invalid', `${s.criterion} applies to this post.`);
  }
}

export interface DraftInput {
  lang: RubricSheet['lang'];
  medium: RubricSheet['medium'];
  animated?: boolean;
  report: DeterministicReport;
  answer: ReviewerAnswer | null;
  scoredBy: ReviewerPath;
  unscoredReason: string | null;
}

export function draftSheet(d: DraftInput): RubricSheet {
  const fromAnswer = new Map((d.answer?.scores ?? []).map((s) => [s.criterion, s]));
  const scores: RubricScore[] = CRITERIA_IDS.map((id: CriterionId) => {
    const base = blankScore(id, d.medium, { animated: d.animated });
    if (!base.applicable) return base;
    const measured = d.report.evidence[id] ?? [];
    const a = fromAnswer.get(id);
    const capInfo = d.report.caps[id];
    if (!a || a.score === null) {
      const evidence = [...measured, ...(capInfo ? [capInfo.evidence] : [])];
      return { ...base, evidence: dedupe(evidence), owningStep: owningStepOf(id, evidence), note: capInfo ? capInfo.reason.slice(0, 140) : '' };
    }
    let score = a.score as RubricScoreValue;
    let note = a.note;
    const evidence = [...a.evidence, ...measured];
    if (capInfo && score > capInfo.max) {
      score = capInfo.max;
      evidence.push(capInfo.evidence);
      note = t('check.capped', { max: capInfo.max, reason: capInfo.reason });
    }
    const ev = dedupe(evidence);
    return { ...base, score, evidence: ev, draftedBy: 'qa-agent', owningStep: owningStepOf(id, ev), note: note.slice(0, 140) };
  });
  const sheet: RubricSheet = {
    lang: d.lang,
    medium: d.medium,
    scores,
    mean: meanOf(scores),
    verdict: verdict(scores),
    rubricVersion: RUBRIC_VERSION,
    scoredBy: d.scoredBy,
    unscoredReason: null,
    checks: d.report.checks,
    findings: d.report.findings,
  };
  if (sheet.verdict === 'unscored') sheet.unscoredReason = d.unscoredReason ?? t('check.unscored.noReviewer');
  validateSheet(sheet);
  return sheet;
}

/** Recomputes mean and verdict after a person changed scores (manual scoring or a confirmation). */
export function rescore(sheet: RubricSheet, scores: RubricScore[], by: ReviewerPath = sheet.scoredBy): RubricSheet {
  const out: RubricSheet = { ...sheet, scores, mean: meanOf(scores), verdict: verdict(scores), scoredBy: by };
  out.unscoredReason = out.verdict === 'unscored' ? (sheet.unscoredReason ?? t('check.unscored.noReviewer')) : null;
  validateSheet(out);
  return out;
}

function dedupe<T extends { kind: string; ref: string; value?: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.kind}|${x.ref}|${x.value ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 12);
}
