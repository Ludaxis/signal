// The core loops (quality bar, roles). Each loop is additive on top of the pose and gestures:
//   breath      72 f    torso scaleY 1.000 → 1.015, head translateY −3 px, sine; phase seeded per character
//   blink       2-5 s   seeded intervals; eye half → closed → half → open, 1 f each (4 f); a double blink 10 % of the time
//   sway        90 f    hip ±1.5°, the head counter-rotates ∓0.8° two frames behind
//   bounce-beat 1 beat  hip −12 px on the off-beat, squash 0.97/1.03 on the beat, arms on the half-beats (tempo map)
//   dance-A/B   2 bars  alternating dance poses on every beat (the second bar mirrored), bounce-beat on top
//   crowd       1 beat  bounce-beat with a seeded ±2-frame phase per extra, so a crowd never moves in lockstep
// Beat keys sit exactly on the tempo map's beat frames; off-beat keys on the rounded half-beat. Pure module.
import { intIn, streamFor } from './rng';
import { beatsIn, halfBeatFrame, isDownbeat } from './tempo';
import type { NumKey } from './track';
import type { PoseId, TempoMap } from './types';

export const BREATH_PERIOD = 72;
export const BREATH_SCALE = 0.015;
export const BREATH_HEAD_PX = 3;
export const SWAY_PERIOD = 90;
export const SWAY_HIP_DEG = 1.5;
export const SWAY_HEAD_DEG = 0.8;
export const SWAY_HEAD_LAG = 2;
export const BLINK_MIN = 60;
export const BLINK_MAX = 150;
export const BLINK_DOUBLE_SHARE = 0.1;
/** The second blink of a double blink starts this many frames after the first (4 blink frames + 1 open frame). */
export const BLINK_DOUBLE_GAP = 5;
export const BLINK_SEQUENCE = ['half', 'closed', 'half', 'open'] as const;
export const BOUNCE_PX = 12;
export const BOUNCE_SQUASH = { sx: 1.03, sy: 0.97 } as const;
export const BOUNCE_ARM_DEG = 6;
export const CROWD_MAX_OFFSET = 2;

// ---- breath and sway (periodic) --------------------------------------------------------------------------------------

export const breathPhase = (seed: number, charId: string) => intIn(streamFor(seed, charId, 'breath'), 0, BREATH_PERIOD - 1);

/** 0 → 1 → 0 over the period (sine), at frame f with the character's phase. */
export const breathAmount = (f: number, phase: number) => (1 - Math.cos((2 * Math.PI * (f + phase)) / BREATH_PERIOD)) / 2;

export const swayAt = (f: number) => ({
  hipRot: SWAY_HIP_DEG * Math.sin((2 * Math.PI * f) / SWAY_PERIOD),
  headRot: -SWAY_HEAD_DEG * Math.sin((2 * Math.PI * (f - SWAY_HEAD_LAG)) / SWAY_PERIOD),
});

// ---- blink (seeded) --------------------------------------------------------------------------------------------------

export interface Blink {
  at: number;
  double: boolean;
}

/** Blink start frames in [from, to): intervals drawn from 60-150 frames; 10 % are double blinks. */
export function blinkSchedule(seed: number, charId: string, from: number, to: number): Blink[] {
  const rnd = streamFor(seed, charId, 'blink');
  const out: Blink[] = [];
  let f = from + intIn(rnd, BLINK_MIN / 2, BLINK_MAX);
  while (f + BLINK_SEQUENCE.length <= to) {
    const double = rnd() < BLINK_DOUBLE_SHARE;
    out.push({ at: f, double });
    if (double && f + BLINK_DOUBLE_GAP + BLINK_SEQUENCE.length <= to) out.push({ at: f + BLINK_DOUBLE_GAP, double: true });
    f += intIn(rnd, BLINK_MIN, BLINK_MAX);
  }
  return out;
}

/** The eye state a blink forces at frame f, or null when no blink covers it. */
export function blinkEyeAt(blinks: readonly Blink[], f: number): (typeof BLINK_SEQUENCE)[number] | null {
  for (const b of blinks) {
    const k = f - b.at;
    if (k >= 0 && k < BLINK_SEQUENCE.length) return BLINK_SEQUENCE[k]!;
  }
  return null;
}

// ---- beat loops ------------------------------------------------------------------------------------------------------

export interface BeatTracks {
  hipY: NumKey[];
  hipSx: NumKey[];
  hipSy: NumKey[];
  armR: NumKey[];
  armL: NumKey[];
}

/**
 * bounce-beat keys for [from, to): on every beat frame the hip is down (0) and squashed; on the half-beat it is up
 * (−12 px) and unsquashed; the arms lift outwards on the half-beats. `offset` shifts the whole grid (crowd).
 */
export function bounceTracks(tempo: TempoMap, from: number, to: number, offset = 0): BeatTracks {
  const t: BeatTracks = { hipY: [], hipSx: [], hipSy: [], armR: [], armL: [] };
  for (const { k, frame } of beatsIn(tempo, from - offset - 60, to - offset + 60)) {
    const b = frame + offset;
    const h = halfBeatFrame(tempo, k) + offset;
    t.hipY.push({ frame: b, value: 0, curve: 'whip' }, { frame: h, value: -BOUNCE_PX, curve: 'slide-in' });
    t.hipSx.push({ frame: b, value: BOUNCE_SQUASH.sx, curve: 'punch' }, { frame: h, value: 1, curve: 'whip' });
    t.hipSy.push({ frame: b, value: BOUNCE_SQUASH.sy, curve: 'punch' }, { frame: h, value: 1, curve: 'whip' });
    t.armR.push({ frame: b, value: 0, curve: 'whip' }, { frame: h, value: BOUNCE_ARM_DEG, curve: 'whip' });
    t.armL.push({ frame: b, value: 0, curve: 'whip' }, { frame: h, value: -BOUNCE_ARM_DEG, curve: 'whip' });
  }
  return t;
}

export interface DanceKey {
  frame: number;
  pose: Extract<PoseId, 'dance-A' | 'dance-B'>;
  mirrored: boolean;
}

/**
 * dance-A / dance-B: a pose key on every beat in [from, to). The routine is 2 bars long and restarts on a bar's
 * downbeat: bar 1 alternates the two dance poses, bar 2 alternates them mirrored. dance-B starts on the other pose.
 */
export function danceKeys(tempo: TempoMap, which: 'dance-A' | 'dance-B', from: number, to: number): DanceKey[] {
  const out: DanceKey[] = [];
  const beats = beatsIn(tempo, from, to);
  const first = beats.find((b) => isDownbeat(tempo, b.k))?.k ?? beats[0]?.k ?? 0;
  for (const { k, frame } of beats) {
    const i = (((k - first) % (2 * tempo.beatsPerBar)) + 2 * tempo.beatsPerBar) % (2 * tempo.beatsPerBar);
    const a = (i % 2 === 0) === (which === 'dance-A');
    out.push({ frame, pose: a ? 'dance-A' : 'dance-B', mirrored: i >= tempo.beatsPerBar });
  }
  return out;
}

/** A crowd extra's phase offset in frames, in [−2, 2], seeded by the run seed, the character and its crowd index. */
export const crowdOffset = (seed: number, charId: string, crowdIndex = 0) => intIn(streamFor(seed, charId, `crowd:${crowdIndex}`), -CROWD_MAX_OFFSET, CROWD_MAX_OFFSET);
