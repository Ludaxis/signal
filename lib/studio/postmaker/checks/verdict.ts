// Pass thresholds and the premium streak.
//   Premium:    C3, C8, C11 score 5; every other applicable criterion ≥ 4; mean ≥ 4.4.
//   Standard:   hard gates 5; every other ≥ 3; mean ≥ 3.6.
//   Regenerate: any hard gate below 5, any criterion ≤ 2, or a mean below 3.6.
//   Unscored:   an applicable criterion has no score (no reviewer was available).
import type { RubricScore, Verdict } from '../types';
import { isHardGate } from './rubric';

export const PREMIUM_MEAN = 4.4;
export const STANDARD_MEAN = 3.6;
export const SKIP_PROOF_STREAK = 3;
export const MAX_REGENERATIONS = 2;

export function verdict(scores: readonly RubricScore[]): Verdict {
  const app = scores.filter((s) => s.applicable);
  if (!app.length || app.some((s) => s.score === null)) return 'unscored';
  const mean = app.reduce((a, s) => a + s.score!, 0) / app.length; // unrounded: 4.396 is not Premium
  const hard = app.filter((s) => isHardGate(s.criterion));
  const rest = app.filter((s) => !isHardGate(s.criterion));
  if (hard.some((s) => s.score! < 5) || app.some((s) => s.score! <= 2) || mean < STANDARD_MEAN) return 'regenerate';
  if (rest.every((s) => s.score! >= 4) && mean >= PREMIUM_MEAN) return 'premium';
  if (rest.every((s) => s.score! >= 3)) return 'standard';
  return 'regenerate';
}

/** One accepted proof in a template's history, oldest first. */
export interface ProofHistoryEntry {
  verdict: Verdict;
  live: boolean; // `modes.mock === 0`
  regenerations: number;
  /** A hard-gate score was overridden by a person (such a proof does not count). */
  hardGateOverride: boolean;
  templateId: string;
  variantId: string | null;
}

/**
 * consecutive Premium, live proofs on the same template and variant as the latest entry, each with no
 * hard-gate override and at most 2 regenerations, counted back from the latest. Anything else resets the count.
 */
export function premiumStreak(history: readonly ProofHistoryEntry[]): number {
  const last = history.at(-1);
  if (!last) return 0;
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.templateId !== last.templateId || h.variantId !== last.variantId) continue; // other variants do not break it
    if (h.verdict !== 'premium' || !h.live || h.hardGateOverride || h.regenerations > MAX_REGENERATIONS) break;
    n++;
  }
  return n;
}

/** "Skip proof for repeat runs" may be switched on only at a streak of 3 (it stays off by default). */
export const skipProofUnlocked = (history: readonly ProofHistoryEntry[]): boolean => premiumStreak(history) >= SKIP_PROOF_STREAK;
