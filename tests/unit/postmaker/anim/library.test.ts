// The core library. Gesture frame counts and key times equal the quality bar table (table-driven);
// the 16 pose ids and 8 gesture ids are the closed vocabulary (roles); every key names a curve id or `hold`.
import { describe, expect, it } from 'vitest';
import { CORE_GESTURES, JUMP_RISE, POINT_EXTEND, swipeAt, swipeFrames, swipeLegFrames, WAVE_SWING } from '@/lib/studio/postmaker/anim/library/gestures';
import { CORE_POSES, mirrorPose } from '@/lib/studio/postmaker/anim/library/poses';
import { GESTURE_IDS, POSE_IDS, type GestureId } from '@/lib/studio/postmaker/anim/types';
import { CURVE_IDS } from '@/lib/studio/postmaker/render/curves';

const keys = (g: GestureId, part: string, prop = 'rot') => CORE_GESTURES[g].keys.filter((k) => k.part === part && k.prop === prop).sort((a, b) => a.frame - b.frame);
const frames = (g: GestureId, part: string, prop = 'rot') => keys(g, part, prop).map((k) => k.frame);
const values = (g: GestureId, part: string, prop = 'rot') => keys(g, part, prop).map((k) => +Number(k.value).toFixed(2));

/** Quality bar: gesture, frames, and the key times / values the table states. */
const TABLE: { gesture: GestureId; frames: number; check: () => void }[] = [
  {
    gesture: 'wave',
    frames: 24,
    check: () => {
      // anticipation down 3 f, then 3 swings of ±18° at the lower arm, 6 f each, then settle 3 f
      expect(frames('wave', 'arm_lower_R')).toEqual([0, 3, 9, 15, 21, 24]);
      expect(values('wave', 'arm_lower_R')).toEqual([0, 6, -WAVE_SWING, WAVE_SWING, -WAVE_SWING, 0]);
      expect(Math.sign(values('wave', 'arm_lower_R')[1]!)).toBe(-Math.sign(values('wave', 'arm_lower_R')[2]!)); // down, against the first swing
      expect(keys('wave', 'hand_R', 'state').map((k) => k.value)).toEqual(['wave']);
    },
  },
  {
    gesture: 'nod',
    frames: 12,
    check: () => {
      expect(frames('nod', 'head')).toEqual([0, 3, 7, 12]); // −6° (3 f), +4° (4 f), 0 (5 f)
      expect(values('nod', 'head')).toEqual([0, -6, 4, 0]);
    },
  },
  {
    gesture: 'shake',
    frames: 18,
    check: () => {
      const v = values('shake', 'head');
      expect(frames('shake', 'head')).toEqual([0, 3, 6, 9, 12, 15, 18]);
      expect(Math.max(...v.map(Math.abs))).toBe(8);
      const peaks = v.filter((x) => x > 0);
      expect(peaks).toHaveLength(3); // three times
      expect(peaks[0]!).toBeGreaterThan(peaks[1]!); // decaying
      expect(peaks[1]!).toBeGreaterThan(peaks[2]!);
    },
  },
  {
    gesture: 'point',
    frames: 10,
    check: () => {
      expect(frames('point', 'arm_upper_R')).toEqual([0, 3, 7, 10]); // back 3 f, extend 4 f, settle 3 f
      const v = values('point', 'arm_upper_R');
      expect(v[1]!).toBeLessThan(0); // anticipation back
      expect(v[2]!).toBeCloseTo(POINT_EXTEND * 1.08, 2); // 8 % overshoot
      expect(v[3]!).toBe(POINT_EXTEND);
      expect(keys('point', 'hand_R', 'state').map((k) => k.value)).toEqual(['point']);
      expect(CORE_GESTURES.point.holdEnd).toBe(true);
    },
  },
  {
    gesture: 'clap',
    frames: 8,
    check: () => {
      expect(CORE_GESTURES.clap.contactFrame).toBe(4); // the hands meet here (put on the beat)
      expect(frames('clap', 'arm_lower_R')).toEqual([0, 4, 8]);
      expect(frames('clap', 'arm_lower_L')).toEqual([0, 4, 8]);
    },
  },
  {
    gesture: 'jump',
    frames: 20,
    check: () => {
      // squash (3 f), rise −80 px (6 f), hang (2 f), fall (5 f), land squash (2 f), settle (2 f)
      expect(frames('jump', 'hip', 'y')).toEqual([0, 3, 9, 11, 16]);
      expect(values('jump', 'hip', 'y')).toEqual([0, 0, -JUMP_RISE, -JUMP_RISE, 0]);
      expect(frames('jump', 'hip', 'sy')).toEqual([0, 3, 9, 16, 18, 20]);
      expect(values('jump', 'hip', 'sy')[1]).toBe(0.92);
      expect(values('jump', 'hip', 'sx')[1]).toBe(1.06);
      expect(values('jump', 'hip', 'sy')[4]).toBe(0.92);
      expect(values('jump', 'hip', 'sy')[5]).toBe(1);
    },
  },
  {
    gesture: 'gasp',
    frames: 10,
    check: () => {
      expect(values('gasp', 'brow_L', 'y')[1]!).toBeLessThan(0); // brows up
      expect(keys('gasp', 'eye_L', 'state').map((k) => k.value)).toEqual(['wide']);
      expect(keys('gasp', 'mouth', 'state').map((k) => k.value)).toEqual(['shock']);
      expect(values('gasp', 'torso')).toContain(-3); // torso back 3°
    },
  },
];

describe('gestures: quality bar table', () => {
  it('has exactly the 8 core gesture ids', () => expect(Object.keys(CORE_GESTURES).sort()).toEqual([...GESTURE_IDS].sort()));
  it.each(TABLE)('$gesture: $frames frames and the table key times', ({ gesture, frames: n, check }) => {
    expect(CORE_GESTURES[gesture].frames).toBe(n);
    for (const k of CORE_GESTURES[gesture].keys) expect(k.frame, `${gesture} ${k.part}.${k.prop}`).toBeLessThanOrEqual(n);
    check();
  });
  it('every key names a curve id or hold; states only hold', () => {
    for (const [id, g] of Object.entries(CORE_GESTURES))
      for (const k of g.keys) {
        expect([...CURVE_IDS, 'hold'], `${id} ${k.part}`).toContain(k.curve);
        if (k.prop === 'state') expect(k.curve).toBe('hold');
      }
  });
  it('swipe: the finger follows the targets at 600-900 px/s, easing at each target', () => {
    const t = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 300, y: 0 }, { id: 'c', x: 300, y: 450 }];
    expect(swipeLegFrames(t, 750)).toEqual([12, 18]);
    expect(swipeLegFrames(t, 2000)).toEqual([10, 15]); // clamped to 900 px/s
    expect(swipeLegFrames(t, 100)).toEqual([15, 23]); // clamped to 600 px/s
    expect(swipeFrames(t, 750)).toBe(30);
    expect(swipeAt(t, 0, 750)).toEqual({ x: 0, y: 0 });
    expect(swipeAt(t, 12, 750)).toEqual({ x: 300, y: 0 });
    expect(swipeAt(t, 30, 750)).toEqual({ x: 300, y: 450 });
    // ease in and out: the first frame of a leg moves less than the middle frame
    const step = (f: number) => swipeAt(t, f + 1, 750).x - swipeAt(t, f, 750).x;
    expect(step(0)).toBeLessThan(step(5));
  });
});

describe('poses (roles)', () => {
  it('has exactly the 16 core pose ids', () => expect(Object.keys(CORE_POSES).sort()).toEqual([...POSE_IDS].sort()));
  it('cheer raises both arms; dance-B mirrors dance-A; mirrorPose swaps sides and negates rotation', () => {
    expect(CORE_POSES.cheer.parts.arm_upper_R!.rot).toBeGreaterThan(90);
    expect(CORE_POSES.cheer.parts.arm_upper_L!.rot).toBeLessThan(-90);
    expect(mirrorPose(CORE_POSES['dance-A']).parts.arm_upper_L).toEqual({ rot: -130 });
    expect(mirrorPose(CORE_POSES['dance-A']).parts.leg_upper_L).toEqual({ rot: -10 });
    expect(CORE_POSES['point-screen'].parts.hand_R!.state).toBe('point');
  });
});
