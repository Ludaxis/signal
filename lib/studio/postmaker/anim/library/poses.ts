// The 16 core poses (quality bar, roles): static key sets on the parts of a `cutout-rig/1` character,
// as offsets from the rest drawing (arms hanging, face neutral). Sign convention (screen, y down, CSS rotation):
// a positive `rot` on the character's right arm (`_R`, the viewer's left) raises it outwards; the left arm mirrors
// it with a negative `rot`. Elbows bend inwards with the opposite sign. States set the eye, mouth and hand sprites.
// The solver clamps every rotation to the rig's limits, so a pose never breaks a joint. Packs may override the keys
// of an id per character (pose overrides); they never add ids. Pure module.
import type { PartKeys, PoseDef, PoseId } from '../types';

const eyes = (state: string): Record<string, PartKeys> => ({ eye_L: { state }, eye_R: { state } });
const hands = (state: string): Record<string, PartKeys> => ({ hand_L: { state }, hand_R: { state } });
const brows = (y: number, rot = 0): Record<string, PartKeys> => ({ brow_L: { y, rot: -rot }, brow_R: { y, rot } });
/** Both arms outwards by `up` degrees and the elbows by `bend` (inwards when positive). */
const arms = (up: number, bend = 0): Record<string, PartKeys> => ({
  arm_upper_R: { rot: up },
  arm_upper_L: { rot: -up },
  arm_lower_R: { rot: -bend },
  arm_lower_L: { rot: bend },
});
const merge = (...sets: Record<string, PartKeys>[]): Record<string, PartKeys> => {
  const out: Record<string, PartKeys> = {};
  for (const s of sets) for (const [k, v] of Object.entries(s)) out[k] = { ...out[k], ...v };
  return out;
};

const holdPhone = merge({ arm_upper_L: { rot: -18 }, arm_lower_L: { rot: 100 }, hand_L: { state: 'hold', rot: -10 } });

export const CORE_POSES: Record<PoseId, PoseDef> = {
  neutral: { parts: merge(eyes('open'), hands('open'), { mouth: { state: 'X' } }) },
  happy: { parts: merge(eyes('open'), hands('open'), brows(-6), arms(10, 8), { mouth: { state: 'smile' }, head: { rot: -3 } }) },
  laugh: { parts: merge(eyes('happy'), hands('fist'), brows(-8), arms(22, 30), { mouth: { state: 'grin' }, head: { rot: -5 }, torso: { rot: -2 } }) },
  surprised: { parts: merge(eyes('wide'), hands('open'), brows(-14), arms(25, 20), { mouth: { state: 'O' } }) },
  shocked: { parts: merge(eyes('wide'), hands('open'), brows(-18), arms(55, 95), { mouth: { state: 'shock' }, torso: { rot: -3 }, head: { y: -4 } }) },
  sulk: { parts: merge(eyes('half'), hands('fist'), brows(4, 10), arms(-4, 10), { mouth: { state: 'frown' }, head: { rot: 6 } }) },
  bored: { parts: merge(eyes('half'), hands('open'), brows(2), { mouth: { state: 'X' }, head: { rot: -8 }, torso: { rot: 2 } }) },
  'point-screen': { parts: merge(eyes('open'), brows(-4), { mouth: { state: 'smile' }, arm_upper_R: { rot: 80 }, arm_lower_R: { rot: -12 }, hand_R: { state: 'point' }, hand_L: { state: 'open' } }) },
  'hold-phone': { parts: merge(eyes('open'), { mouth: { state: 'X' }, hand_R: { state: 'open' } }, holdPhone) },
  'look-phone': { parts: merge(eyes('half'), { mouth: { state: 'X' }, hand_R: { state: 'open' }, head: { rot: 8 }, pupil_L: { y: 4 }, pupil_R: { y: 4 } }, holdPhone) },
  cheer: { parts: merge(eyes('happy'), hands('fist'), brows(-10), arms(160, 15), { mouth: { state: 'grin' }, head: { y: -4 } }) },
  shrug: { parts: merge(eyes('open'), hands('open'), brows(-10, 8), arms(30, 105), { mouth: { state: 'frown' }, head: { rot: 4 }, arm_upper_R: { y: -8 }, arm_upper_L: { y: -8 } }) },
  facepalm: { parts: merge(eyes('closed'), hands('open'), { mouth: { state: 'frown' }, head: { rot: 7 }, arm_upper_R: { rot: -35 }, arm_lower_R: { rot: -145 } }) },
  'hands-hips': { parts: merge(eyes('open'), hands('fist'), arms(38, 80), { mouth: { state: 'smile' } }) },
  'dance-A': {
    parts: merge(eyes('happy'), hands('fist'), { mouth: { state: 'grin' }, arm_upper_R: { rot: 130 }, arm_lower_R: { rot: -40 }, arm_upper_L: { rot: -28 }, arm_lower_L: { rot: 60 }, hip: { rot: 4 }, head: { rot: -4 }, leg_upper_R: { rot: 10 } }),
  },
  'dance-B': {
    parts: merge(eyes('happy'), hands('fist'), { mouth: { state: 'grin' }, arm_upper_L: { rot: -130 }, arm_lower_L: { rot: 40 }, arm_upper_R: { rot: 28 }, arm_lower_R: { rot: -60 }, hip: { rot: -4 }, head: { rot: 4 }, leg_upper_L: { rot: -10 } }),
  },
};

/** The pose mirrored left ↔ right (rotations and x offsets negated): the second bar of a dance loop. */
export function mirrorPose(p: PoseDef): PoseDef {
  const parts: Record<string, PartKeys> = {};
  for (const [name, k] of Object.entries(p.parts)) {
    const m = name.endsWith('_L') ? `${name.slice(0, -2)}_R` : name.endsWith('_R') ? `${name.slice(0, -2)}_L` : name;
    parts[m] = { ...k, ...(k.rot !== undefined ? { rot: -k.rot } : {}), ...(k.x !== undefined ? { x: -k.x } : {}) };
  }
  return { parts };
}
