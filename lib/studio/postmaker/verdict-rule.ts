// The run verdict rule, pure (no store, no fs) so the server read model, Accept and the Proof screen share it: one
// verdict per run, and the weakest language decides (Regenerate < Unscored < Standard < Premium; no sheets is
// Unscored). The pill words the fakes write ('Premium', ...) normalise to the same four values.
import type { Verdict } from './types';

export type { Verdict };

/** A verdict word in any case; anything else is 'unscored'. */
export const verdictWord = (x: unknown): Verdict => {
  const v = typeof x === 'string' ? x.trim().toLowerCase() : '';
  return v === 'premium' || v === 'standard' || v === 'regenerate' ? v : 'unscored';
};

const RANK: Record<Verdict, number> = { regenerate: 0, unscored: 1, standard: 2, premium: 3 };

/** One verdict for the run: the weakest language decides (no sheets is Unscored). */
export function runVerdict(sheets: readonly { verdict?: unknown }[]): Verdict {
  if (!sheets.length) return 'unscored';
  return sheets.reduce<Verdict>((w, s) => {
    const v = verdictWord(s?.verdict);
    return RANK[v] < RANK[w] ? v : w;
  }, 'premium');
}
