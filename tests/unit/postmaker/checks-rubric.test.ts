// @vitest-environment node
// The rubric as data and as rules: the streak as the pure function premiumStreak, routing, the reviewer answer schema (no score without evidence), C8 in
// Persian confirmed only by a `native-editor-fa` holding a current sign-off, manual scoring on an Unscored proof.
import { describe, expect, it } from 'vitest';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { CRITERIA_IDS, HARD_GATES, applicableCriteria, applies, blankScore, confirmScore, manualScores, reviewerAnswerSchema, validateSheet } from '@/lib/studio/postmaker/checks/rubric';
import { routesFor } from '@/lib/studio/postmaker/checks/routes';
import { rescore } from '@/lib/studio/postmaker/checks/sheet';
import { premiumStreak, skipProofUnlocked, verdict, type ProofHistoryEntry } from '@/lib/studio/postmaker/checks/verdict';
import { proofProjection } from '@/lib/studio/postmaker/checks/proof';
import type { CriterionId, Lang, Medium, RubricScore, RubricScoreValue, RubricSheet, SignOff } from '@/lib/studio/postmaker/types';

/** A drafted sheet: every applicable criterion at `base`, with overrides; each score cites one measure. */
function sheet(o: { medium?: Medium; lang?: Lang; base?: RubricScoreValue | null; set?: Partial<Record<CriterionId, RubricScoreValue>>; evidence?: Partial<Record<CriterionId, RubricScore['evidence']>> } = {}): RubricSheet {
  const medium = o.medium ?? 'video';
  const scores = CRITERIA_IDS.map((id) => {
    const b = blankScore(id, medium);
    if (!b.applicable) return b;
    const score = o.set?.[id] ?? (o.base === undefined ? 5 : o.base);
    if (score === null) return b;
    return { ...b, score, evidence: o.evidence?.[id] ?? [{ kind: 'measure' as const, ref: `fixture:${id}` }], draftedBy: 'qa-agent' as const };
  });
  return rescore({ lang: o.lang ?? 'en', medium, scores, mean: null, verdict: 'unscored', rubricVersion: 'qr-1.0', scoredBy: 'agent-sdk', unscoredReason: null, checks: [], findings: [] }, scores);
}

const code = (fn: () => unknown): { status: number; code: string } => {
  try {
    fn();
  } catch (e) {
    if (isPostmakerError(e)) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error('expected a PostmakerError');
};

describe('criteria', () => {
  it('exports 12 criteria with applies per medium; C5 and C9 are N/A for feed, C9 for carousel', () => {
    expect(CRITERIA_IDS).toHaveLength(12);
    expect(HARD_GATES).toEqual(['C3', 'C8', 'C11']);
    expect(applies('C5', 'feed')).toBe(false);
    expect(applies('C9', 'feed')).toBe(false);
    expect(applies('C9', 'carousel')).toBe(false);
    expect(applies('C5', 'carousel')).toBe(false);
    expect(applies('C5', 'carousel', { animated: true })).toBe(true);
    expect(applicableCriteria('video')).toHaveLength(12);
    expect(applicableCriteria('feed')).toEqual(['C1', 'C2', 'C3', 'C4', 'C7', 'C8', 'C10', 'C11', 'C12']);
    expect(applicableCriteria('carousel')).toEqual(['C1', 'C2', 'C3', 'C4', 'C6', 'C7', 'C8', 'C10', 'C11', 'C12']);
  });
});

describe('verdict', () => {
  it('all 5s except C8 = 4 → regenerate (a hard gate below 5)', () => {
    expect(verdict(sheet({ set: { C8: 4 } }).scores)).toBe('regenerate');
  });
  it('all 5s except C1 = 4 and C6 = 4 → premium (mean 4.83)', () => {
    const s = sheet({ set: { C1: 4, C6: 4 } });
    expect(s.mean).toBe(4.83);
    expect(s.verdict).toBe('premium');
  });
  it('hard gates at 5, the others at 3 and 4, mean 3.7 → standard', () => {
    // carousel: 10 applicable criteria; 3 hard gates at 5, six at 3 and one at 4 → 37 / 10 = 3.7
    const s = sheet({ medium: 'carousel', base: 3, set: { C3: 5, C8: 5, C11: 5, C1: 4 } });
    expect(s.scores.filter((x) => x.applicable)).toHaveLength(10);
    expect(s.mean).toBe(3.7);
    expect(s.verdict).toBe('standard');
  });
  it('a criterion at 2 or a mean below 3.6 → regenerate; any missing score → unscored', () => {
    expect(verdict(sheet({ set: { C2: 2 } }).scores)).toBe('regenerate');
    expect(verdict(sheet({ base: 3, set: { C3: 5, C8: 5, C11: 5 } }).scores)).toBe('regenerate'); // (15 + 27) / 12 = 3.5 < 3.6
    expect(verdict(sheet({ base: null }).scores)).toBe('unscored');
  });
  it('Premium needs the mean at 4.4: every other criterion at 4 or more but a mean of 4.33 is Standard', () => {
    const s = sheet({ base: 4, set: { C3: 5, C8: 5, C11: 5, C1: 5 } }); // (20 + 32) / 12 = 4.33
    expect(s.verdict).toBe('standard');
  });
});

describe('sheet validation', () => {
  it('an applicable score with an empty evidence array is rejected with 400', () => {
    const s = sheet();
    const bad = { ...s, scores: s.scores.map((x) => (x.criterion === 'C2' ? { ...x, evidence: [] } : x)) };
    expect(code(() => validateSheet(bad))).toEqual({ status: 400, code: 'evidence-missing' });
  });
  it('a not-applicable row with a score, a missing row and a doubled row are rejected', () => {
    const f = sheet({ medium: 'feed' });
    expect(code(() => validateSheet({ ...f, scores: f.scores.map((x) => (x.criterion === 'C9' ? { ...x, score: 4 as const } : x)) })).status).toBe(400);
    expect(code(() => validateSheet({ ...f, scores: f.scores.slice(1) })).status).toBe(400);
    expect(code(() => validateSheet({ ...f, scores: [...f.scores, f.scores[0]!] })).status).toBe(400);
  });
  it('the reviewer answer schema rejects an applicable score with empty evidence', () => {
    const scores = CRITERIA_IDS.map((c) => ({ criterion: c, applicable: true, score: 5, evidence: [{ kind: 'frame', ref: 'frame:0' }], note: '' }));
    expect(reviewerAnswerSchema.safeParse({ scores, throughline: 'x', summary: 'y' }).success).toBe(true);
    const bad = scores.map((s) => (s.criterion === 'C7' ? { ...s, evidence: [] } : s));
    const r = reviewerAnswerSchema.safeParse({ scores: bad, throughline: 'x', summary: 'y' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain('C7 has a score but no evidence');
    expect(reviewerAnswerSchema.safeParse({ scores: scores.slice(0, 11), throughline: 'x', summary: 'y' }).success).toBe(false);
  });
});

describe('confirmation', () => {
  const editor: SignOff = { gate: 'fa-native-editor', nodeId: 'narration-text:fa', version: 3, hash: 'h3', by: 'editor@example.test', name: 'Editor A', at: '2026-11-06T10:00:00.000Z', verdict: 'pass' };
  it('C8 of a Persian sheet cannot be confirmed by the QA agent or the owner account alone', () => {
    const s = sheet({ lang: 'fa' });
    expect(code(() => confirmScore(s, { criterion: 'C8', by: 'qa-agent', role: 'qa-agent' }))).toEqual({ status: 403, code: 'confirm-forbidden' });
    expect(code(() => confirmScore(s, { criterion: 'C8', by: 'reviewer', role: 'owner' }))).toEqual({ status: 403, code: 'confirm-forbidden' });
    expect(code(() => confirmScore(s, { criterion: 'C8', by: 'owner@example.test', role: 'owner' }, { signoffs: [editor] }))).toEqual({ status: 403, code: 'needs-native-editor' });
  });
  it('needs a native-editor-fa record backed by a passing, named, current text-gate sign-off of that person', () => {
    const s = sheet({ lang: 'fa' });
    expect(code(() => confirmScore(s, { criterion: 'C8', by: 'editor@example.test', role: 'native-editor-fa' }))).toEqual({ status: 403, code: 'needs-native-editor' });
    expect(code(() => confirmScore(s, { criterion: 'C8', by: 'editor@example.test', role: 'native-editor-fa' }, { signoffs: [{ ...editor, by: 'mock', name: 'mock' }] })).code).toBe('needs-native-editor');
    expect(code(() => confirmScore(s, { criterion: 'C8', by: 'editor@example.test', role: 'native-editor-fa' }, { signoffs: [editor], hashes: { 'narration-text:fa': ['h4'] } })).code).toBe('needs-native-editor');
    const ok = confirmScore(s, { criterion: 'C8', by: 'editor@example.test', role: 'native-editor-fa' }, { signoffs: [editor], hashes: { 'narration-text:fa': ['h3'] } });
    expect(ok.scores.find((x) => x.criterion === 'C8')).toMatchObject({ confirmedBy: 'editor@example.test', confirmedRole: 'native-editor-fa' });
    expect(proofProjection(ok, null).hardGates.find((g) => g.criterion === 'C8')).toMatchObject({ passed: true, confirmed: true, needs: null });
    expect(proofProjection(s, null).hardGates.find((g) => g.criterion === 'C8')).toMatchObject({ passed: true, confirmed: false, needs: 'native-editor-fa' });
  });
  it('the owner confirms English C8 and may override a score only with evidence', () => {
    const s = sheet({ lang: 'en' });
    expect(confirmScore(s, { criterion: 'C8', by: 'owner@example.test', role: 'owner' }).scores.find((x) => x.criterion === 'C8')!.confirmedRole).toBe('owner');
    expect(code(() => confirmScore(s, { criterion: 'C2', by: 'owner@example.test', role: 'owner', score: 3 })).code).toBe('evidence-missing');
    const o = confirmScore(s, { criterion: 'C2', by: 'owner@example.test', role: 'owner', score: 3, evidence: [{ kind: 'text', ref: 'manual:C2', value: 'Bubble text is 44 px.' }] });
    expect(o.scores.find((x) => x.criterion === 'C2')!.score).toBe(3);
  });
});

describe('manual scoring on an Unscored proof', () => {
  it('every score needs an evidence note; C8 in Persian stays unconfirmed', () => {
    const s = sheet({ lang: 'fa', base: null });
    expect(s.verdict).toBe('unscored');
    expect(proofProjection(s, null)).toMatchObject({ verdict: 'unscored', manualScoring: true, verdictAllowsAccept: false });
    expect(code(() => manualScores(s, [{ criterion: 'C1', score: 4, note: '  ' }], 'owner@example.test')).code).toBe('evidence-missing');
    const all = CRITERIA_IDS.map((c) => ({ criterion: c, score: 5 as const, note: `Checked ${c} on the player.` }));
    const scores = manualScores(s, all, 'owner@example.test');
    const r = rescore(s, scores, 'manual');
    expect(r.verdict).toBe('premium');
    expect(r.scores.find((x) => x.criterion === 'C8')).toMatchObject({ draftedBy: 'owner', confirmedBy: null });
    expect(r.scores.find((x) => x.criterion === 'C1')).toMatchObject({ draftedBy: 'owner', confirmedBy: 'owner@example.test', confirmedRole: 'owner' });
    expect(code(() => manualScores(s, all, 'mock')).status).toBe(403);
  });
});

describe('routing', () => {
  it('C9 = 2 routes to music; C8 = 3 on a pronunciation evidence item routes to voice', () => {
    const s = sheet({ lang: 'fa', set: { C9: 2, C8: 3 }, evidence: { C8: [{ kind: 'text', ref: 'pronunciation:l03', value: 'ezafe read as -e' }] } });
    const r = routesFor(s);
    expect(r.find((x) => x.criterion === 'C9')).toMatchObject({ kind: 'music', nodeId: 'music', group: 'S6' });
    expect(r.find((x) => x.criterion === 'C8')).toMatchObject({ kind: 'voice', nodeId: 'voice:fa', group: 'S2' });
  });
  it('C8 = 3 on text evidence routes to narration-text; scores at the bar route nowhere', () => {
    const s = sheet({ lang: 'fa', set: { C8: 3, C1: 4 } });
    expect(routesFor(s)).toEqual([expect.objectContaining({ criterion: 'C8', kind: 'narration-text', nodeId: 'narration-text:fa', group: 'S1' })]);
  });
  it('topics pick the other owners: C1 timing → motion, C6 downbeat → music, C11 flag → post-copy, C12 flash → motion', () => {
    const s = sheet({
      lang: 'en',
      set: { C1: 3, C6: 3, C11: 3, C12: 2 },
      evidence: { C1: [{ kind: 'measure', ref: 'timing:first-motion' }], C6: [{ kind: 'measure', ref: 'downbeat:b05' }], C11: [{ kind: 'report', ref: 'flag:meta' }], C12: [{ kind: 'measure', ref: 'flash:f120' }] },
    });
    expect(routesFor(s).map((x) => [x.criterion, x.nodeId])).toEqual([
      ['C1', 'motion:en'],
      ['C6', 'music'],
      ['C11', 'post-copy:en'],
      ['C12', 'motion:en'],
    ]);
  });
});

describe('premium streak (as a pure function)', () => {
  const p = (o: Partial<ProofHistoryEntry> = {}): ProofHistoryEntry => ({ verdict: 'premium', live: true, regenerations: 0, hardGateOverride: false, templateId: 'tpl-1', variantId: null, ...o });
  it('three consecutive Premium live proofs unlock skip-proof; a Standard between them resets the count', () => {
    expect(premiumStreak([p(), p(), p()])).toBe(3);
    expect(skipProofUnlocked([p(), p(), p()])).toBe(true);
    expect(premiumStreak([p(), p({ verdict: 'standard' }), p(), p()])).toBe(2);
    expect(skipProofUnlocked([p(), p({ verdict: 'standard' }), p(), p()])).toBe(false);
    expect(premiumStreak([])).toBe(0);
  });
  it('mock proofs, more than 2 regenerations or a hard-gate override break it; other variants do not', () => {
    expect(premiumStreak([p(), p(), p({ live: false })])).toBe(0);
    expect(premiumStreak([p(), p({ regenerations: 3 }), p()])).toBe(1);
    expect(premiumStreak([p(), p({ regenerations: 2 }), p()])).toBe(3);
    expect(premiumStreak([p(), p({ hardGateOverride: true }), p()])).toBe(1);
    expect(premiumStreak([p(), p({ variantId: 'v2', verdict: 'standard' }), p(), p()])).toBe(3);
  });
});
