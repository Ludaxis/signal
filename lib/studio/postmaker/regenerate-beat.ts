// Regenerate beat (Recipe "Regenerate beat", `recipe.regenerate-beat`): the reference is read
// again by the deconstructor (`analyse`; mock until Claude agents and vision are live, $0) with the person's note,
// and only the named beat takes the new reading's content. Its id, segment and timing stay (the neighbours' timing is
// kept); every other beat is pinned: copied from the current recipe byte for byte (RG-03 style). The result
// is the recipe's next version; the steps that read the beats (`script`) and everything after them become out of
// date ("The recipe changed", graph/status.ts). A reading that changes nothing writes no version.
import { PostmakerError } from './errors';
import type { Lang, RecipeBeat } from './types';

/** What a regenerated beat takes from the new reading; id, segment, start and end stay as they are. */
export const BEAT_CONTENT_KEYS = ['name', 'purpose', 'visual', 'techniques', 'onScreenText', 'audio', 'motion'] as const;

/**
 * The recipe's beats with `beatId` taking the content of the same beat in `fresh` (onScreenText limited to the
 * recipe's languages); every other beat is the very object it was. 404 for an unknown beat; 409 when the new reading
 * has no beat with that id.
 */
export function mergeBeat(beats: RecipeBeat[], fresh: Pick<RecipeBeat, 'id' | (typeof BEAT_CONTENT_KEYS)[number]>[], beatId: string, languages: Lang[]): RecipeBeat[] {
  const at = beats.findIndex((b) => b.id === beatId);
  if (at < 0) throw new PostmakerError(404, 'not_found', 'Unknown beat.');
  const next = fresh.find((b) => b.id === beatId);
  if (!next) throw new PostmakerError(409, 'beat-missing', 'A new reading has no beat at this place. Edit it instead.');
  const old = beats[at]!;
  const merged: RecipeBeat = {
    ...old,
    name: next.name,
    purpose: next.purpose,
    visual: next.visual,
    techniques: [...next.techniques],
    onScreenText: Object.fromEntries(languages.map((l) => [l, next.onScreenText[l] ?? ''])),
    audio: next.audio,
    motion: next.motion,
  };
  return beats.map((b, i) => (i === at ? merged : b));
}
