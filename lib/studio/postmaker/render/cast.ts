// What StorySpine's cast layer draws at a frame, as pure functions so the layout is tested without the
// renderer: the live compiled characters with their art, a new character's `enter` value (`settle` track), and a flat
// (Tier B) still's box anchored at the hip with the paper-puppet breath (whole-body squash, quality bar).
// Pure module: imports only anim/ and render/ types and pure helpers.
import type { CompiledCharacter } from '../anim/compile';
import { breathAmount, breathPhase, BREATH_SCALE } from '../anim/loops';
import { evalKeys, type NumKey } from '../anim/track';
import type { Timeline, TimelineCastArt } from './timeline';

/** The hip sits this far down a flat still's height (a standing full-body render). */
export const FLAT_HIP = 0.55;

/** The `enter` track value of a character appearance at a frame (1 when it has none). */
export function enterAt(t: Pick<Timeline, 'motion'>, c: Pick<CompiledCharacter, 'charId' | 'beatId'>, frame: number): number {
  const track = t.motion?.tracks.find((x) => x.element === `char:${c.charId}:${c.beatId}` && x.prop === 'enter');
  if (!track) return 1;
  return Math.min(1, Math.max(0, evalKeys(track.keys.map((k) => ({ frame: k.frame, value: Number(k.value), curve: k.curve })) as NumKey[], frame)));
}

/** The compiled characters live at a frame, each with the art the timeline carries for it (others are skipped). */
export function castAt(t: Pick<Timeline, 'motion' | 'characters'>, frame: number): { c: CompiledCharacter; art: TimelineCastArt }[] {
  if (!t.motion || !t.characters) return [];
  const out: { c: CompiledCharacter; art: TimelineCastArt }[] = [];
  for (const c of t.motion.characters) {
    if (frame < c.from || frame >= c.to) continue;
    const art = t.characters.cast.find((a) => a.charId === c.charId);
    if (art && (art.rig || art.still)) out.push({ c, art });
  }
  return out;
}

/** A flat still's box at a frame: native size × the placement scale, centred on x, the hip on y; `sy` is the breath. */
export function flatBox(c: Pick<CompiledCharacter, 'charId' | 'place' | 'loops'>, still: { w: number; h: number }, frame: number, seed: number): { left: number; top: number; width: number; height: number; sy: number } {
  const height = still.h * (c.place.scale > 0 ? c.place.scale : 1);
  const width = still.w * (height / still.h);
  const b = c.loops.includes('breath') ? breathAmount(frame, breathPhase(seed, c.charId)) : 0;
  return { left: c.place.x - width / 2, top: c.place.y - height * FLAT_HIP, width, height, sy: 1 + BREATH_SCALE * b };
}
