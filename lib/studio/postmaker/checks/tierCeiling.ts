// The C5 ceiling from the pack's rig tiers (pack `rigTier`):
//   Tier A (source rig)    → 5
//   Tier B (flat renders)  → 3, or 4 when the character is on screen ≤ 20 % of the runtime
//   Tier C (reconstructed) → 4 after an on-model review, else 3
// The ceiling applies to a character-led spine; the lowest character ceiling wins. A score above it is capped.
import { t } from '@/app/studio/copy/en';
import type { RigTier, RubricScoreValue } from '../types';

export const TIER_B_SHARE = 0.2;

export interface CharacterPresence {
  id: string;
  tier: RigTier;
  onScreenFrames: number;
  onModelReviewed?: boolean;
}

export interface Ceiling {
  max: RubricScoreValue;
  limitedBy: string | null;
  text: string | null;
}

export function characterCeiling(c: CharacterPresence, totalFrames: number): RubricScoreValue {
  if (c.tier === 'A') return 5;
  if (c.tier === 'C') return c.onModelReviewed ? 4 : 3;
  const share = totalFrames > 0 ? c.onScreenFrames / totalFrames : 1;
  return share <= TIER_B_SHARE ? 4 : 3;
}

/** `characterLed` defaults to "some character is on screen". */
export function c5Ceiling(characters: readonly CharacterPresence[], totalFrames: number, o: { characterLed?: boolean } = {}): Ceiling {
  const visible = characters.filter((c) => c.onScreenFrames > 0);
  const led = o.characterLed ?? visible.length > 0;
  if (!led || !visible.length) return { max: 5, limitedBy: null, text: null };
  let best: Ceiling = { max: 5, limitedBy: null, text: null };
  for (const c of visible) {
    const m = characterCeiling(c, totalFrames);
    if (m < best.max) best = { max: m, limitedBy: c.id, text: t('check.tier.ceiling', { max: m, character: c.id, tier: c.tier }) };
  }
  return best;
}

export const clampToCeiling = (score: RubricScoreValue, ceiling: Ceiling): RubricScoreValue => (score > ceiling.max ? ceiling.max : score);
