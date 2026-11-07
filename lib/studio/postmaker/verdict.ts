// The check verdict as Accept reads it. The `check` node writes its score
// sheet as the JSON output on port `score` (`score.json`). This module only reads it: the
// `RubricSheet.verdict` ('premium' | 'standard' | 'regenerate'), the capitalised pill words ('Premium', 'Standard',
// 'Regenerate', 'Unscored') the fakes write, and a manual score on an Unscored proof (`manual: true` with the
// owner's verdict). The real check writes a `CheckResult` with one sheet per language and no top-level
// verdict: then the run's verdict is the weakest language's (the rule the Proof screen shows, so screen and server read
// the same thing). Anything else, or no sheet at all, is 'unscored'. Accept never computes a verdict itself.
import { getJson } from './store/objects';
import type { StepVersion } from './types';
import { runVerdict, verdictWord as word, type Verdict } from './verdict-rule';

export type { Verdict };

export interface VerdictRead {
  verdict: Verdict;
  /** The owner scored an Unscored proof by hand. */
  manual: boolean;
  /** sha256 of the score sheet object the verdict came from (null without one). */
  sheet: string | null;
}

/** One verdict for the run (the rule lives in verdict-rule.ts, shared with the Proof screen). */
export { runVerdict };

/** Normalises a score sheet's verdict: a top-level `verdict` field, else the weakest of its per-language `sheets`. */
export function verdictOf(sheet: unknown): { verdict: Verdict; manual: boolean } {
  if (!sheet || typeof sheet !== 'object') return { verdict: 'unscored', manual: false };
  const s = sheet as { verdict?: unknown; manual?: unknown; sheets?: unknown };
  if ((s.verdict === undefined || s.verdict === null) && Array.isArray(s.sheets)) return { verdict: runVerdict(s.sheets as { verdict?: unknown }[]), manual: false };
  const verdict = word(s.verdict);
  return { verdict, manual: s.manual === true && verdict !== 'unscored' };
}

/** The verdict of a `check` version (its `score` port). */
export async function readVerdict(root: string, check: StepVersion | null): Promise<VerdictRead> {
  const ref = check?.outputs.find((o) => o.port === 'score' && o.kind === 'json') ?? null;
  if (!ref) return { verdict: 'unscored', manual: false, sheet: null };
  let sheet: unknown = null;
  try {
    sheet = await getJson(root, ref.sha256, { verify: true });
  } catch {
    return { verdict: 'unscored', manual: false, sheet: null };
  }
  return { ...verdictOf(sheet), sheet: ref.sha256 };
}

/** What a clean Accept needs from the verdict: Premium or Standard, by the reviewer or a manual score. */
export function acceptableVerdict(v: Verdict): v is 'premium' | 'standard' {
  return v === 'premium' || v === 'standard';
}
