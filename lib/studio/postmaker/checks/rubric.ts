// The premium quality rubric: the 12 criteria with where they apply,
// the hard gates, the reviewer's structured answer (zod, the "extended rubric output schema" of the Post maker
// `reviewer` envelope), the sheet validator (a score without evidence is rejected with 400),
// confirmation rules (C8 in Persian needs a `native-editor-fa` record) and manual scoring on an
// Unscored proof. Generic core: no project names; criteria text is the quality bar's, never a pack's.
import { z } from 'zod';
import { isNamedPerson } from '@/lib/studio/lang/fa/review';
import { PostmakerError } from '../errors';
import type { CriterionId, Lang, Medium, RubricEvidence, RubricScore, RubricScoreValue, RubricSheet, SignOff, StepKind } from '../types';

export const RUBRIC_VERSION = 'qr-1.0' as const;
export const CRITERIA_IDS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12'] as const satisfies readonly CriterionId[];
/** Hard gates: must score 5 for Premium and Standard. */
export const HARD_GATES = ['C3', 'C8', 'C11'] as const satisfies readonly CriterionId[];
export type HardGate = (typeof HARD_GATES)[number];
export const isHardGate = (c: CriterionId): c is HardGate => (HARD_GATES as readonly string[]).includes(c);

export interface CriterionSpec {
  id: CriterionId;
  name: string;
  /** "Applies": F feed, C carousel, V video. `carousel-animated` = C5's "C if animated". */
  applies: { feed: boolean; carousel: boolean | 'if-animated'; video: boolean };
  /** the default owner, and other owners chosen by an evidence topic (`<topic>:<ref>`). */
  owner: StepKind;
  owners: Partial<Record<string, StepKind>>;
  /** What a reviewer must cite (last column, shortened for the prompt). */
  evidence: string;
}

const c = (id: CriterionId, name: string, applies: CriterionSpec['applies'], owner: StepKind, owners: CriterionSpec['owners'], evidence: string): CriterionSpec => ({ id, name, applies, owner, owners, evidence });
const ALL = { feed: true, carousel: true, video: true } as const;

/** and the routing (kinds). */
export const CRITERIA: Record<CriterionId, CriterionSpec> = {
  C1: c('C1', 'Hook strength', ALL, 'script', { timing: 'motion', motion: 'motion' }, 'frames of first motion, first legible text and hook completion; the hook text; frame 0 and 60 stills'),
  C2: c('C2', 'Readability at phone size', ALL, 'compose', { words: 'script', layout: 'compose' }, 'smallest text px and frame; worst contrast ratio; shortest on-screen time'),
  C3: c('C3', 'Safe zones and crops', ALL, 'art', {}, 'the safe-zone report (zero intersections); the cover crop stills'),
  C4: c('C4', 'Typography craft', ALL, 'compose', {}, 'golden-frame diff; the font list from the render log; line-break stills'),
  C5: c('C5', 'Motion craft', { feed: false, carousel: 'if-animated', video: true }, 'motion', {}, 'frame ranges and curve ids of the 3 main moves; characters without idles; pivot check'),
  C6: c('C6', 'Pacing and rhythm', { feed: false, carousel: true, video: true }, 'motion', { downbeat: 'music', mix: 'mix', music: 'music' }, 'beat list with frames and the longest gap; cut-to-downbeat offset; end-card duration'),
  C7: c('C7', 'Brand consistency', ALL, 'art', {}, 'colour histogram against the pack palette; asset ids against the library; turnaround side-by-side'),
  C8: c('C8', 'Language correctness', ALL, 'narration-text', { pronunciation: 'voice', pron: 'voice', voice: 'voice', text: 'narration-text' }, 'linter report; the native-editor sign-off; lexicon hits; re-generated takes'),
  C9: c('C9', 'Audio craft', { feed: false, carousel: false, video: true }, 'music', { mix: 'mix', music: 'music' }, 'loudnorm print (I, TP, LRA); narration-versus-bed delta at 3 lines; SFX cues against events'),
  C10: c('C10', 'Story and message clarity', ALL, 'script', {}, 'a one-sentence throughline; speaker per line; frame where the product is first shown working'),
  C11: c('C11', 'AI disclosure, rights and provenance', ALL, 'art', { flag: 'post-copy', caption: 'post-copy' }, 'provenance manifest; label check on first and last frames; consent per voice'),
  C12: c('C12', 'Accessibility', ALL, 'post-copy', { flash: 'motion', flashes: 'motion' }, 'caption coverage %; flash count per 1 s window; alt text; SRT files'),
};

/** Is a criterion applicable to a medium (C5, C9 N/A for feed; C9 N/A for carousel)? */
export function applies(criterion: CriterionId, medium: Medium, o: { animated?: boolean } = {}): boolean {
  const a = CRITERIA[criterion].applies[medium];
  return a === 'if-animated' ? o.animated === true : a;
}

export const applicableCriteria = (medium: Medium, o: { animated?: boolean } = {}): CriterionId[] => CRITERIA_IDS.filter((id) => applies(id, medium, o));

/** `<topic>:<rest>` → topic (routing hint carried by the evidence ref). */
export const topicOf = (ref: string): string => (ref.includes(':') ? ref.slice(0, ref.indexOf(':')).trim().toLowerCase() : '');

/** The node kind that owns a criterion for this score: the first evidence item whose topic names another owner wins. */
export function owningStepOf(criterion: CriterionId, evidence: readonly RubricEvidence[]): StepKind {
  const spec = CRITERIA[criterion];
  for (const e of evidence) {
    const o = spec.owners[topicOf(e.ref)];
    if (o) return o;
  }
  return spec.owner;
}

// ---- the reviewer's answer (SDK and CLI share it) ----------------------------------------------------------------

const short = (max: number) => z.string().trim().max(max);
export const evidenceSchema = z.object({
  kind: z.enum(['frame', 'measure', 'report', 'signoff', 'text']),
  ref: short(160).min(1).describe('What is cited. Prefix a routing topic when it applies, e.g. "pronunciation:l03", "timing:first-motion", "words:b01", "downbeat:b05", "flag:meta", "flash:f120"'),
  value: short(200).optional(),
});

export const answerScoreSchema = z.object({
  criterion: z.enum(CRITERIA_IDS),
  applicable: z.boolean(),
  score: z.number().int().min(1).max(5).nullable().describe('1-5; null only when not applicable'),
  evidence: z.array(evidenceSchema).max(8).describe('At least one item for every applicable score'),
  note: short(140),
});

/** The Post maker reviewer's structured answer: 12 scores with evidence, a throughline and a summary. */
export const reviewerAnswerSchema = z
  .object({
    scores: z.array(answerScoreSchema).min(12).max(12),
    throughline: short(200).describe('C10: one sentence, tension then payoff through the product'),
    summary: short(500).describe('Two or three sentences for the owner'),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.scores.forEach((s, i) => {
      if (seen.has(s.criterion)) ctx.addIssue({ code: 'custom', path: ['scores', i, 'criterion'], message: `${s.criterion} appears twice` });
      seen.add(s.criterion);
      if (s.applicable && s.score === null) ctx.addIssue({ code: 'custom', path: ['scores', i, 'score'], message: `${s.criterion} is applicable but has no score` });
      if (s.applicable && s.evidence.length === 0) ctx.addIssue({ code: 'custom', path: ['scores', i, 'evidence'], message: `${s.criterion} has a score but no evidence` });
    });
  });
export type ReviewerAnswer = z.infer<typeof reviewerAnswerSchema>;

// ---- sheets ------------------------------------------------------------------------------------------------------

export const meanOf = (scores: readonly RubricScore[]): number | null => {
  const xs = scores.filter((s) => s.applicable && s.score !== null).map((s) => s.score!);
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
};

/** An empty score row (applicability from the medium; owner by default). */
export function blankScore(criterion: CriterionId, medium: Medium, o: { animated?: boolean } = {}): RubricScore {
  return { criterion, applicable: applies(criterion, medium, o), score: null, evidence: [], draftedBy: null, confirmedBy: null, confirmedRole: null, owningStep: CRITERIA[criterion].owner, note: '' };
}

/**
 * a sheet is refused (400) when an applicable score has no evidence, a score is out of range, a
 * criterion is missing or doubled, or a not-applicable row carries a score.
 */
export function validateSheet(sheet: Pick<RubricSheet, 'scores' | 'medium'>): void {
  const seen = new Set<string>();
  for (const s of sheet.scores) {
    if (!(CRITERIA_IDS as readonly string[]).includes(s.criterion)) throw new PostmakerError(400, 'rubric-invalid', `Unknown criterion ${s.criterion}.`);
    if (seen.has(s.criterion)) throw new PostmakerError(400, 'rubric-invalid', `${s.criterion} appears twice.`);
    seen.add(s.criterion);
    if (!s.applicable) {
      if (s.score !== null) throw new PostmakerError(400, 'rubric-invalid', `${s.criterion} does not apply and cannot have a score.`);
      continue;
    }
    if (s.score === null) continue; // not scored yet (Unscored)
    if (!Number.isInteger(s.score) || s.score < 1 || s.score > 5) throw new PostmakerError(400, 'rubric-invalid', `${s.criterion} must score 1 to 5.`);
    if (!s.evidence.length || s.evidence.some((e) => !e.ref.trim())) throw new PostmakerError(400, 'evidence-missing', `${s.criterion} has a score but no evidence.`);
    if (s.note.length > 140) throw new PostmakerError(400, 'rubric-invalid', `${s.criterion} note is longer than 140 characters.`);
  }
  if (seen.size !== CRITERIA_IDS.length) throw new PostmakerError(400, 'rubric-invalid', 'Every criterion needs a row.');
}

// ---- confirmation (the owner confirms or overrides; C8 in fa needs the named Persian reader) ------------

export interface ScoreConfirmation {
  criterion: CriterionId;
  /** A person id; agents and placeholders are refused. */
  by: string;
  role: 'owner' | 'native-editor-fa' | 'qa-agent';
  /** Override the drafted score (the owner may; the evidence note is then required). */
  score?: RubricScoreValue;
  evidence?: RubricEvidence[];
  note?: string;
}

/**
 * Applies one confirmation to a sheet (returns a new sheet). Refused (403) when the confirmer is not a named person,
 * when the QA agent tries to confirm anything, or when C8 of a Persian sheet is confirmed by anyone but a
 * `native-editor-fa` who also holds a current, passing `fa-native-editor` sign-off (stores those; they arrive
 * as `signoffs`, already filtered to the current version hashes by the caller or checked here against `hashes`).
 */
export function confirmScore(sheet: RubricSheet, c: ScoreConfirmation, o: { signoffs?: readonly SignOff[]; hashes?: Record<string, readonly string[]> } = {}): RubricSheet {
  if (c.role === 'qa-agent') throw new PostmakerError(403, 'confirm-forbidden', 'The check agent drafts scores; a person confirms them.');
  const role = c.role;
  if (!isNamedPerson(c.by)) throw new PostmakerError(403, 'confirm-forbidden', 'Only a named person can confirm a score.');
  if (c.criterion === 'C8' && sheet.lang === 'fa') {
    if (c.role !== 'native-editor-fa') throw new PostmakerError(403, 'needs-native-editor', 'Persian language needs the named Persian reader.');
    if (!hasNativeEditorSignoff(c.by, o.signoffs ?? [], o.hashes)) throw new PostmakerError(403, 'needs-native-editor', 'Persian language needs the Persian reader’s sign-off first.');
  }
  const scores = sheet.scores.map((s) => {
    if (s.criterion !== c.criterion) return s;
    if (!s.applicable) throw new PostmakerError(400, 'rubric-invalid', `${s.criterion} does not apply.`);
    const evidence = c.score !== undefined && c.score !== s.score ? [...s.evidence, ...(c.evidence ?? [])] : s.evidence;
    const next: RubricScore = { ...s, score: c.score ?? s.score, evidence, confirmedBy: c.by, confirmedRole: role, note: (c.note ?? s.note).slice(0, 140) };
    if (c.score !== undefined && c.score !== s.score && !(c.evidence ?? []).length) throw new PostmakerError(400, 'evidence-missing', `Changing ${s.criterion} needs an evidence note.`);
    return next;
  });
  const out = { ...sheet, scores, mean: meanOf(scores) };
  validateSheet(out);
  return out;
}

/**
 * A passing, named (never `mock`) text-gate sign-off by this person. With `hashes` (node id → the current version's
 * valid hashes: version hash and outputs hash, as graph/status.ts accepts), it must be bound to one of them.
 */
export function hasNativeEditorSignoff(by: string, signoffs: readonly SignOff[], hashes?: Record<string, readonly string[]>): boolean {
  return signoffs.some((s) => s.gate === 'fa-native-editor' && s.verdict === 'pass' && s.by === by && isNamedPerson(s.by) && isNamedPerson(s.name) && (!hashes || !hashes[s.nodeId] || hashes[s.nodeId]!.includes(s.hash)));
}

/** Is this score confirmed by the right person (C8 fa: the Persian reader; others: the owner or the Persian reader)? */
export function isConfirmed(s: RubricScore, lang: Lang): boolean {
  if (!s.confirmedBy || !isNamedPerson(s.confirmedBy)) return false;
  if (s.criterion === 'C8' && lang === 'fa') return s.confirmedRole === 'native-editor-fa';
  return s.confirmedRole === 'owner' || s.confirmedRole === 'native-editor-fa';
}

// ---- manual scoring on an Unscored proof ----------------------------------------------------------------------

export interface ManualScore {
  criterion: CriterionId;
  score: RubricScoreValue;
  /** The evidence note the owner writes (required). */
  note: string;
}

/**
 * The owner scores the criteria themselves (Unscored proof): each score needs an evidence note, drafted by
 * `owner`. It does not confirm C8 in Persian (that stays with the Persian reader). Returns the rescored rows; the
 * caller recomputes the verdict.
 */
export function manualScores(sheet: RubricSheet, input: readonly ManualScore[], by: string): RubricScore[] {
  if (!isNamedPerson(by)) throw new PostmakerError(403, 'confirm-forbidden', 'Only a named person can score.');
  const byId = new Map(input.map((m) => [m.criterion, m]));
  const scores = sheet.scores.map((s) => {
    const m = byId.get(s.criterion);
    if (!m) return s;
    if (!s.applicable) throw new PostmakerError(400, 'rubric-invalid', `${s.criterion} does not apply.`);
    const note = m.note.trim();
    if (!note) throw new PostmakerError(400, 'evidence-missing', `${s.criterion} needs an evidence note.`);
    const evidence: RubricEvidence[] = [...s.evidence, { kind: 'text', ref: `manual:${s.criterion}`, value: note.slice(0, 200) }];
    const c8fa = s.criterion === 'C8' && sheet.lang === 'fa';
    return { ...s, score: m.score, evidence, draftedBy: 'owner' as const, confirmedBy: c8fa ? null : by, confirmedRole: c8fa ? null : ('owner' as const), owningStep: owningStepOf(s.criterion, evidence), note: note.slice(0, 140) };
  });
  validateSheet({ medium: sheet.medium, scores });
  return scores;
}
