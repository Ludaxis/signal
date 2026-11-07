// Manual scoring on an Unscored proof: when no reviewer was available, the owner scores the
// 12 criteria on Proof, each score with an evidence note (`manualScores`, then `rescore`). Step versions are
// write-once and an edit of `check` would supersede the run, so the person's sheets are kept beside the run in
// runs/<runId>/manual-score.json, bound to the exact `check` version and hash they scored: a new check version makes
// the record count for nothing. Never for a run with mock steps (those accept as draft only). C8 in Persian stays
// unconfirmed (the Persian reader confirms it), so the hard gate holds even after a manual score.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { t } from '@/app/studio/copy/en';
import { manualScores, type ManualScore } from './checks/rubric';
import { rescore } from './checks/sheet';
import { PostmakerError } from './errors';
import { assertRunIsCurrent } from './accept';
import { recipeMutexKey, type PostmakerEngine } from './runner';
import { pretty, readJsonFile, writeReplace } from './store/fs';
import { withLock } from './store/mutex';
import { getJson } from './store/objects';
import { readVerdict, runVerdict } from './verdict';
import { runDir } from './store/paths';
import { readRun } from './store/runs';
import type { CheckResult, Lang, RubricSheet, StepVersion, Verdict } from './types';

export interface ManualScoreRecord {
  schema: 'signal.pm.manual-score/1';
  runId: string;
  checkVersion: number;
  checkHash: string;
  sheets: Partial<Record<Lang, RubricSheet>>;
  by: string;
  at: string;
}

export const manualScoreFile = (root: string, runId: string) => path.join(runDir(root, runId), 'manual-score.json');

/** The record of `runId` when it was made on exactly this `check` version; otherwise null. */
export async function readManualScore(root: string, runId: string, check: Pick<StepVersion, 'n' | 'hash'> | null): Promise<ManualScoreRecord | null> {
  if (!check) return null;
  const rec = await readJsonFile<ManualScoreRecord>(manualScoreFile(root, runId)).catch(() => null);
  if (!rec || rec.schema !== 'signal.pm.manual-score/1' || rec.runId !== runId) return null;
  return rec.checkVersion === check.n && rec.checkHash === check.hash ? rec : null;
}

/** The check's sheets with the person's sheets in place of the scored languages. */
export const withManual = (doc: CheckResult, rec: ManualScoreRecord | null): CheckResult => (rec ? { ...doc, sheets: doc.sheets.map((s) => rec.sheets[s.lang] ?? s) } : doc);

/** One verdict for the run: the weakest language decides (no sheets is Unscored). One rule, in verdict.ts. */
export { runVerdict };

/** The run's verdict from a manual record on the current check (null when there is none, so the reviewer's stands). */
export async function manualVerdictOf(root: string, runId: string, check: StepVersion | null): Promise<Verdict | null> {
  const rec = await readManualScore(root, runId, check);
  const ref = check?.outputs.find((o) => o.port === 'score' && o.kind === 'json');
  if (!rec || !ref) return null;
  const doc = await getJson<CheckResult>(root, ref.sha256, { verify: true }).catch(() => null);
  if (!doc || !Array.isArray(doc.sheets)) return null;
  return runVerdict(withManual(doc, rec).sheets);
}

/**
 * The run verdict Accept and the Proof read model both use: the check's score sheet (a `CheckResult` reads as its
 * weakest language), and on an Unscored check the person's manual sheets on this exact check version.
 */
export async function runVerdictOf(root: string, runId: string | null, check: StepVersion | null): Promise<Verdict> {
  const read = await readVerdict(root, check);
  if (read.verdict !== 'unscored' || !runId) return read.verdict;
  return (await manualVerdictOf(root, runId, check)) ?? read.verdict;
}

/**
 * `proof.score`: scores one language of an Unscored proof by hand. Refuses a run that is not at Proof, a run with mock
 * steps, a run superseded by later versions, a language the reviewer already scored, and a missing evidence note.
 */
export async function scoreProof(o: { engine: PostmakerEngine; root: string; runId: string; lang: Lang; scores: ManualScore[]; by: string; now?: number }): Promise<{ sheet: RubricSheet }> {
  const first = await readRun(o.root, o.runId);
  if (!first) throw new PostmakerError(404, 'not_found', 'Unknown run.');
  return withLock(recipeMutexKey(first.recipeId), async () => {
    const run = (await readRun(o.root, o.runId))!;
    const atProof = run.packageIds.length === 0 && (run.status === 'done' || (run.status === 'needs-you' && run.pausedFor === 'check'));
    if (!atProof) throw new PostmakerError(409, 'conflict', 'This run has not reached Proof.');
    const s = await o.engine.state(run.recipeId);
    assertRunIsCurrent(run, s);
    if (run.steps.some((x) => x.mode === 'mock') || Object.values(s.current).some((v) => v?.mode === 'mock')) throw new PostmakerError(409, 'mock', t('check.unscored.mock'));
    const check = s.current.check ?? null;
    const ref = check?.outputs.find((x) => x.port === 'score' && x.kind === 'json');
    if (!check || !ref) throw new PostmakerError(409, 'conflict', 'This run has not reached Proof.');
    const doc = await getJson<CheckResult>(o.root, ref.sha256, { verify: true });
    const prev = await readManualScore(o.root, run.id, check);
    const sheet = doc.sheets?.find((x) => x.lang === o.lang);
    if (!sheet) throw new PostmakerError(404, 'not_found', 'This proof has no such language.');
    if (sheet.verdict !== 'unscored') throw new PostmakerError(409, 'conflict', 'The reviewer already scored this proof.');
    const base = prev?.sheets[o.lang] ?? sheet;
    const next = rescore(base, manualScores(base, o.scores, o.by), 'manual');
    const rec: ManualScoreRecord = {
      schema: 'signal.pm.manual-score/1',
      runId: run.id,
      checkVersion: check.n,
      checkHash: check.hash,
      sheets: { ...(prev?.sheets ?? {}), [o.lang]: next },
      by: o.by,
      at: new Date(o.now ?? Date.now()).toISOString(),
    };
    await fs.mkdir(runDir(o.root, run.id), { recursive: true });
    await writeReplace(manualScoreFile(o.root, run.id), pretty(rec));
    return { sheet: next };
  });
}
