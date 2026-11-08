// The 8 core gestures (quality bar table, roles): clips whose keys are offsets from the current pose, on
// the character's right side (the solver mirrors them for `side: 'L'`). Frame counts and key times follow the table:
//   wave  24 f  anticipation down 3 f; 3 swings of ±18° at the lower arm, 6 f each; settle 3 f
//   nod   12 f  head −6° (3 f), +4° (4 f), 0 (5 f)
//   shake 18 f  head ±8° three times, decaying
//   point 10 f  anticipation back 3 f; extend with 8 % overshoot 4 f; settle 3 f; hand = point
//   clap   8 f per clap; the hands meet on the contact frame (put it on the beat); an SFX cue on contact
//   jump  20 f  squash 0.92/1.06 (3 f), rise −80 px (6 f), hang (2 f), fall (5 f), land squash (2 f), settle (2 f)
//   gasp  10 f  brows up, eye = wide, mouth = shock, torso back 3°
//   swipe per path: a finger follows a Catmull-Rom path through UI targets at 600-900 px/s, easing at each target
// Every key names a curve id (or `hold` for states). Pure module.
import { easeInOutSine } from '../../render/curves';
import type { GestureDef, GestureId, GestureKey, SwipeTarget } from '../types';

const k = (frame: number, part: string, prop: GestureKey['prop'], value: number | string, curve: GestureKey['curve'] = 'whip'): GestureKey => ({ frame, part, prop, value, curve });
const state = (frame: number, part: string, value: string): GestureKey => k(frame, part, 'state', value, 'hold');

/** The point gesture's extension (degrees of the upper arm) and its 8 % overshoot. */
export const POINT_EXTEND = 75;
export const WAVE_SWING = 18;
export const WAVE_RAISE = 140;
export const JUMP_RISE = 80;

const wave: GestureDef = {
  frames: 24,
  keys: [
    k(0, 'arm_upper_R', 'rot', 0),
    k(3, 'arm_upper_R', 'rot', WAVE_RAISE, 'pop-in'),
    k(21, 'arm_upper_R', 'rot', WAVE_RAISE, 'hold'),
    k(24, 'arm_upper_R', 'rot', 0, 'whip'),
    k(0, 'arm_lower_R', 'rot', 0),
    k(3, 'arm_lower_R', 'rot', 6, 'punch'), // anticipation: down, against the first swing
    k(9, 'arm_lower_R', 'rot', -WAVE_SWING, 'whip'),
    k(15, 'arm_lower_R', 'rot', WAVE_SWING, 'whip'),
    k(21, 'arm_lower_R', 'rot', -WAVE_SWING, 'whip'),
    k(24, 'arm_lower_R', 'rot', 0, 'settle'),
    state(0, 'hand_R', 'wave'),
  ],
};

const nod: GestureDef = {
  frames: 12,
  keys: [k(0, 'head', 'rot', 0), k(3, 'head', 'rot', -6, 'punch'), k(7, 'head', 'rot', 4, 'whip'), k(12, 'head', 'rot', 0, 'settle')],
};

const SHAKE = [8, -8, 16 / 3, -16 / 3, 8 / 3];
const shake: GestureDef = {
  frames: 18,
  keys: [k(0, 'head', 'rot', 0), ...SHAKE.map((v, i) => k(3 * (i + 1), 'head', 'rot', v, 'whip')), k(18, 'head', 'rot', 0, 'settle')],
};

const point: GestureDef = {
  frames: 10,
  holdEnd: true,
  keys: [
    k(0, 'arm_upper_R', 'rot', 0),
    k(3, 'arm_upper_R', 'rot', -10, 'punch'), // anticipation back
    k(7, 'arm_upper_R', 'rot', POINT_EXTEND * 1.08, 'whip'), // extend, 8 % overshoot
    k(10, 'arm_upper_R', 'rot', POINT_EXTEND, 'settle'),
    k(0, 'arm_lower_R', 'rot', 0),
    k(7, 'arm_lower_R', 'rot', -8, 'whip'),
    k(10, 'arm_lower_R', 'rot', -6, 'settle'),
    state(3, 'hand_R', 'point'),
  ],
};

const clap: GestureDef = {
  frames: 8,
  contactFrame: 4,
  keys: [
    k(0, 'arm_upper_R', 'rot', 0),
    k(4, 'arm_upper_R', 'rot', -28, 'whip'),
    k(8, 'arm_upper_R', 'rot', 0, 'whip'),
    k(0, 'arm_upper_L', 'rot', 0),
    k(4, 'arm_upper_L', 'rot', 28, 'whip'),
    k(8, 'arm_upper_L', 'rot', 0, 'whip'),
    k(0, 'arm_lower_R', 'rot', 0),
    k(4, 'arm_lower_R', 'rot', -105, 'whip'),
    k(8, 'arm_lower_R', 'rot', 0, 'whip'),
    k(0, 'arm_lower_L', 'rot', 0),
    k(4, 'arm_lower_L', 'rot', 105, 'whip'),
    k(8, 'arm_lower_L', 'rot', 0, 'whip'),
    state(0, 'hand_R', 'open'),
    state(0, 'hand_L', 'open'),
  ],
};

const jump: GestureDef = {
  frames: 20,
  keys: [
    k(0, 'hip', 'y', 0),
    k(3, 'hip', 'y', 0, 'hold'),
    k(9, 'hip', 'y', -JUMP_RISE, 'slide-in'), // rise
    k(11, 'hip', 'y', -JUMP_RISE, 'hold'), // hang
    k(16, 'hip', 'y', 0, 'out-fast'), // fall (accelerating)
    k(0, 'hip', 'sx', 1),
    k(3, 'hip', 'sx', 1.06, 'punch'),
    k(9, 'hip', 'sx', 0.97, 'whip'),
    k(16, 'hip', 'sx', 1, 'whip'),
    k(18, 'hip', 'sx', 1.06, 'punch'),
    k(20, 'hip', 'sx', 1, 'settle'),
    k(0, 'hip', 'sy', 1),
    k(3, 'hip', 'sy', 0.92, 'punch'),
    k(9, 'hip', 'sy', 1.04, 'whip'),
    k(16, 'hip', 'sy', 1, 'whip'),
    k(18, 'hip', 'sy', 0.92, 'punch'),
    k(20, 'hip', 'sy', 1, 'settle'),
    k(0, 'arm_upper_R', 'rot', 0),
    k(9, 'arm_upper_R', 'rot', 35, 'whip'),
    k(18, 'arm_upper_R', 'rot', 0, 'settle'),
    k(0, 'arm_upper_L', 'rot', 0),
    k(9, 'arm_upper_L', 'rot', -35, 'whip'),
    k(18, 'arm_upper_L', 'rot', 0, 'settle'),
  ],
};

const gasp: GestureDef = {
  frames: 10,
  holdEnd: true,
  keys: [
    k(0, 'brow_L', 'y', 0),
    k(3, 'brow_L', 'y', -14, 'pop-in'),
    k(0, 'brow_R', 'y', 0),
    k(3, 'brow_R', 'y', -14, 'pop-in'),
    k(0, 'torso', 'rot', 0),
    k(3, 'torso', 'rot', -3, 'punch'),
    k(10, 'torso', 'rot', -3, 'hold'),
    state(1, 'eye_L', 'wide'),
    state(1, 'eye_R', 'wide'),
    state(1, 'mouth', 'shock'),
  ],
};

/** `swipe` has no fixed length: swipeFrames() measures it from the path. Its keys only set the pointing hand. */
const swipe: GestureDef = { frames: 1, keys: [state(0, 'hand_R', 'point')] };

export const CORE_GESTURES: Record<GestureId, GestureDef> = { wave, nod, shake, point, clap, jump, gasp, swipe };

// ---- swipe path ------------------------------------------------------------------------------------------------------

export const SWIPE_SPEED = { min: 600, max: 900, default: 750 } as const;

const catmullRom = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

/** Frames each leg of the path takes at `speed` px/s (straight-line length, at least 4 frames per leg). */
export function swipeLegFrames(targets: readonly SwipeTarget[], speedPxPerSec: number = SWIPE_SPEED.default, fps = 30): number[] {
  const speed = Math.min(SWIPE_SPEED.max, Math.max(SWIPE_SPEED.min, speedPxPerSec));
  const out: number[] = [];
  for (let i = 1; i < targets.length; i++) {
    const d = Math.hypot(targets[i]!.x - targets[i - 1]!.x, targets[i]!.y - targets[i - 1]!.y);
    out.push(Math.max(4, Math.round((d / speed) * fps)));
  }
  return out;
}

export const swipeFrames = (targets: readonly SwipeTarget[], speed?: number) => swipeLegFrames(targets, speed).reduce((a, b) => a + b, 0);

/** The finger at `f` frames into the swipe: a Catmull-Rom path through the targets, easing in and out at each one. */
export function swipeAt(targets: readonly SwipeTarget[], f: number, speed?: number): { x: number; y: number } {
  if (targets.length === 0) return { x: 0, y: 0 };
  if (targets.length === 1 || f <= 0) return { x: targets[0]!.x, y: targets[0]!.y };
  const legs = swipeLegFrames(targets, speed);
  let i = 0;
  let start = 0;
  while (i < legs.length && f >= start + legs[i]!) start += legs[i++]!;
  if (i >= legs.length) return { x: targets.at(-1)!.x, y: targets.at(-1)!.y };
  const t = easeInOutSine((f - start) / legs[i]!);
  const P = (j: number) => targets[Math.max(0, Math.min(targets.length - 1, j))]!;
  return { x: catmullRom(P(i - 1).x, P(i).x, P(i + 1).x, P(i + 2).x, t), y: catmullRom(P(i - 1).y, P(i).y, P(i + 1).y, P(i + 2).y, t) };
}
