// QA routing: every failing criterion goes to the node kind that owns it, with the
// S-group shown in brackets in the UI. A criterion fails for routing when it is below what Premium needs: a hard gate
// below 5, any other criterion below 4. The owner is the criterion's default unless an evidence item's topic names
// another one (C8 with "pronunciation:…" evidence → `voice`; C1 with "timing:…" → `motion`).
import { KINDS } from '../graph/kinds';
import type { CheckRoute, Lang, RubricSheet, StepKind } from '../types';
import { CRITERIA, isHardGate, owningStepOf } from './rubric';

/** Charter: rubric routing groups. */
export const GROUP_OF: Record<StepKind, CheckRoute['group']> = {
  analyse: 'S1',
  script: 'S1',
  'narration-text': 'S1',
  voice: 'S2',
  art: 'S3',
  broll: 'S3',
  lipsync: 'S4',
  motion: 'S4',
  captions: 'S5',
  compose: 'S5',
  render: 'S5',
  music: 'S6',
  mix: 'S6',
  'post-copy': 'S7',
  check: 'S8',
};

export const nodeIdOf = (kind: StepKind, lang: Lang): string => (KINDS[kind].langScoped ? `${kind}:${lang}` : kind);

/** Routes of one sheet, in criterion order; unscored and not-applicable rows produce none. */
export function routesFor(sheet: Pick<RubricSheet, 'lang' | 'scores'>, o: { nodes?: readonly string[] } = {}): CheckRoute[] {
  const out: CheckRoute[] = [];
  for (const s of sheet.scores) {
    if (!s.applicable || s.score === null) continue;
    const bar = isHardGate(s.criterion) ? 5 : 4;
    if (s.score >= bar) continue;
    const kind = owningStepOf(s.criterion, s.evidence);
    let nodeId = nodeIdOf(kind, sheet.lang);
    // A route never points at a node the pipeline does not have (e.g. no lip-sync node): fall back to the default owner.
    if (o.nodes && !o.nodes.includes(nodeId)) nodeId = nodeIdOf(CRITERIA[s.criterion].owner, sheet.lang);
    const finalKind = nodeId.split(':')[0] as StepKind;
    out.push({ lang: sheet.lang, criterion: s.criterion, score: s.score, kind: finalKind, nodeId, group: GROUP_OF[finalKind], note: (s.note || CRITERIA[s.criterion].name).slice(0, 140) });
  }
  return out;
}
