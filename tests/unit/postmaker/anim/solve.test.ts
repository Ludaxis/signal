// @vitest-environment node
// Solver: determinism, limit clamping as a property test, the idle lint (quality bar
// acceptance 3), gestures relative to the pose and mirrored, the view swap hidden in a head turn, viseme mouths.
import '../guard';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreLibrary } from '@/lib/studio/postmaker/anim/library/overrides';
import { holdLint, idleLint, type CharacterTrack } from '@/lib/studio/postmaker/anim/lint';
import { compileMotion } from '@/lib/studio/postmaker/anim/compile';
import { poseBlendFrames, PRESETS } from '@/lib/studio/postmaker/render/presets';
import { blinkSchedule } from '@/lib/studio/postmaker/anim/loops';
import { loadRig, type LoadedRig } from '@/lib/studio/postmaker/anim/rig/load';
import { mulberry32 } from '@/lib/studio/postmaker/anim/rng';
import { apply, POSE_BLEND_FRAMES, prepareCharacter, solveFrame, solveRange, VIEW_TURN } from '@/lib/studio/postmaker/anim/solve';
import { GESTURE_IDS, LOOP_IDS, POSE_IDS, type AnimLoopId, type CharacterLibrary, type CharacterSpec, type SolvedFrame } from '@/lib/studio/postmaker/anim/types';
import { buildRigFixture, FINAL, RIG_ID, type RigFixture } from './rig-fixture';

let fx: RigFixture;
let rig: LoadedRig;
beforeAll(async () => {
  fx = await buildRigFixture();
  rig = await loadRig(fx, fx.lib, RIG_ID, FINAL);
}, 60_000);
afterAll(() => rmSync(fx.libDir, { recursive: true, force: true }));

const TEMPO = { bpm: 100, firstDownbeatFrame: 0, beatsPerBar: 4 as const };
const spec = (o: Partial<CharacterSpec> = {}): CharacterSpec => ({ charId: RIG_ID, from: 0, to: 240, place: { x: 540, y: 1250, scale: 1 }, poses: [{ pose: 'neutral', at: 0 }], gestures: [], loops: ['breath', 'blink'], ...o });
const part = (f: SolvedFrame, name: string) => f.parts.find((p) => p.name === name)!;

describe('determinism', () => {
  const busy = () =>
    spec({
      poses: [{ pose: 'neutral', at: 0 }, { pose: 'happy', at: 40 }, { pose: 'cheer', at: 120 }],
      gestures: [{ gesture: 'wave', at: 50 }, { gesture: 'nod', at: 90, side: 'L' }, { gesture: 'clap', at: 160, count: 3 }],
      loops: ['breath', 'blink', 'sway', 'bounce-beat'],
      views: [{ view: 'three-quarter-L', at: 100 }],
    });
  it('the same seed gives byte-identical solved transforms', () => {
    const a = JSON.stringify(solveRange(rig.rig, busy(), { seed: 11, tempo: TEMPO }));
    const b = JSON.stringify(solveRange(rig.rig, busy(), { seed: 11, tempo: TEMPO }));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(100_000);
  });
  it('a different seed gives different blink times (and the frames differ only where the seeded idles act)', () => {
    const eyes = (seed: number) => solveRange(rig.rig, spec({ to: 900 }), { seed }).map((f) => f.eye);
    const closedAt = (seed: number) => eyes(seed).flatMap((e, f) => (e === 'closed' ? [f] : []));
    expect(closedAt(1).length).toBeGreaterThan(3);
    expect(closedAt(1)).not.toEqual(closedAt(2));
    expect(closedAt(1)).toEqual(closedAt(1));
    expect(blinkSchedule(1, RIG_ID, 0, 900).map((b) => b.at)).not.toEqual(blinkSchedule(2, RIG_ID, 0, 900).map((b) => b.at));
  });
  it('every number is rounded to 4 decimals', () => {
    const f = solveFrame(rig.rig, busy(), 77, { seed: 3, tempo: TEMPO });
    for (const p of f.parts) for (const v of [p.rot, p.x, p.y, p.sx, p.sy, ...p.matrix]) expect(Math.round(v * 1e4) / 1e4).toBe(v);
  });
});

describe('limits (property test)', () => {
  it('no solved frame turns a part beyond its limits.rot, for random poses, gestures, loops and wild overrides', () => {
    const lim = new Map(rig.rig.parts.map((p) => [`${p.view}/${p.name}`, p.limits?.rot]));
    const names = [...new Set(rig.rig.parts.filter((p) => p.limits?.rot).map((p) => p.name))];
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      // a library whose poses and gestures ask for far more than any joint allows
      const library: CharacterLibrary = coreLibrary();
      for (const id of POSE_IDS) {
        const parts = { ...library.poses[id].parts };
        for (const n of names) if (rnd() < 0.6) parts[n] = { ...parts[n], rot: (rnd() - 0.5) * 800 };
        library.poses[id] = { parts };
      }
      for (const id of GESTURE_IDS) {
        const g = library.gestures[id];
        library.gestures[id] = { ...g, keys: [...g.keys, ...names.filter(() => rnd() < 0.3).map((n) => ({ frame: Math.floor(rnd() * g.frames), part: n, prop: 'rot' as const, value: (rnd() - 0.5) * 600, curve: 'pop-in' as const }))] };
      }
      const s = spec({
        to: 160,
        poses: Array.from({ length: 4 }, (_, i) => ({ pose: pick(POSE_IDS), at: i * 40 })),
        gestures: Array.from({ length: 4 }, (_, i) => ({ gesture: pick(GESTURE_IDS.filter((g) => g !== 'swipe')), at: 5 + i * 35 + Math.floor(rnd() * 10), side: pick(['L', 'R'] as const) })),
        loops: LOOP_IDS.filter(() => rnd() < 0.5) as AnimLoopId[],
        views: rnd() < 0.5 ? [{ view: 'three-quarter-L', at: 70 }] : [],
      });
      for (const f of solveRange(rig.rig, s, { seed, tempo: TEMPO, library }))
        for (const p of f.parts) {
          const l = lim.get(`${f.view}/${p.name}`);
          if (!l) continue;
          expect(p.rot, `seed ${seed} frame ${f.frame} ${p.name}`).toBeGreaterThanOrEqual(l[0]);
          expect(p.rot, `seed ${seed} frame ${f.frame} ${p.name}`).toBeLessThanOrEqual(l[1]);
        }
    }
  });
});

describe('the idle lint (quality bar acceptance 3)', () => {
  const tracks = (): CharacterTrack[] => [
    { charId: 'char-a', from: 0, to: 200, loops: ['breath', 'blink', 'sway'] },
    { charId: 'char-b', from: 100, to: 150, loops: [] }, // 50 frames: exempt
    { charId: 'char-c', from: 0, to: 40, loops: ['breath', 'blink'] },
    { charId: 'char-c', from: 300, to: 340, loops: ['breath', 'blink'] }, // 80 frames in all
  ];
  it('passes when every character visible > 60 frames has breath and blink', () => expect(idleLint(tracks())).toEqual([]));
  it.each(['breath', 'blink'] as const)('removing %s fails with the character id', (loop) => {
    const t = tracks().map((x) => (x.charId === 'char-c' && x.from === 300 ? { ...x, loops: x.loops.filter((l) => l !== loop) } : x));
    const v = idleLint(t);
    expect(v).toEqual([{ rule: 'c5.idle-missing', charId: 'char-c', loop, frame: 300, message: expect.stringContaining('char-c') }]);
  });
  it('a character just over 60 frames counts; exactly 60 does not', () => {
    expect(idleLint([{ charId: 'char-d', from: 0, to: 60, loops: [] }])).toEqual([]);
    expect(idleLint([{ charId: 'char-d', from: 0, to: 61, loops: [] }]).map((v) => v.loop)).toEqual(['breath', 'blink']);
  });
  it('a flat (tier B) character needs breath but not blink; another character still needs both', () => {
    const t = [
      { charId: 'char-f', from: 0, to: 90, loops: ['breath'] as const },
      { charId: 'char-g', from: 0, to: 90, loops: ['breath'] as const },
    ].map((x) => ({ ...x, loops: [...x.loops] }));
    expect(idleLint(t, { flat: ['char-f'] }).map((v) => [v.charId, v.loop])).toEqual([['char-g', 'blink']]);
    expect(idleLint([{ charId: 'char-f', from: 0, to: 90, loops: [] }], { flat: ['char-f'] }).map((v) => v.loop)).toEqual(['breath']);
  });
});

describe('solving', () => {
  it('breath scales the torso 1.000 → 1.015 and lifts the head; blink closes the eyes for one frame and hides the pupils', () => {
    const frames = solveRange(rig.rig, spec({ to: 300 }), { seed: 5 });
    const sy = frames.map((f) => part(f, 'torso').sy);
    expect(Math.min(...sy)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sy)).toBeCloseTo(1.015, 3);
    const closed = frames.find((f) => f.eye === 'closed')!;
    expect(part(closed, 'pupil_R').file).toBeNull();
    expect(part(closed, 'eye_R').file).toMatch(/eye_R-closed\.svg$/);
    expect(part(closed, 'lid_R').state).toBe('closed');
    expect(part(frames[closed.frame - 1]!, 'lid_R').state).toBe('half');
  });

  it('a gesture adds to the pose and returns; side L mirrors it; point holds its end until the next pose key', () => {
    const p = prepareCharacter(rig.rig, spec({ loops: [], gestures: [{ gesture: 'wave', at: 10 }, { gesture: 'wave', at: 60, side: 'L' }, { gesture: 'point', at: 100 }], poses: [{ pose: 'neutral', at: 0 }, { pose: 'happy', at: 140 }] }), { seed: 1 });
    expect(part(p.at(25), 'arm_lower_R').rot).toBeCloseTo(18, 4); // frame 15 of the wave: +18°
    expect(part(p.at(25), 'hand_R').state).toBe('wave');
    expect(part(p.at(34), 'arm_lower_R').rot).toBe(0);
    expect(part(p.at(34), 'hand_R').state).toBe('open');
    expect(part(p.at(75), 'arm_lower_L').rot).toBeCloseTo(-18, 4); // mirrored
    expect(part(p.at(75), 'arm_lower_R').rot).toBe(0);
    expect(part(p.at(130), 'arm_upper_R').rot).toBe(75); // point held
    expect(part(p.at(130), 'hand_R').state).toBe('point');
    expect(part(p.at(170), 'hand_R').state).toBe('open'); // released by the next pose
  });

  it('clap: an SFX cue on every contact frame', () => {
    const frames = solveRange(rig.rig, spec({ loops: [], gestures: [{ gesture: 'clap', at: 14, count: 3 }] }), { seed: 1 }, 0, 60);
    expect(frames.flatMap((f) => (f.cues.includes('clap') ? [f.frame] : []))).toEqual([18, 26, 34]);
  });

  it('the view swap is hidden in a 2-frame head turn ending on the swap frame', () => {
    const p = prepareCharacter(rig.rig, spec({ loops: [], views: [{ view: 'three-quarter-L', at: 50 }] }), { seed: 1 });
    expect(p.at(48).view).toBe('front');
    expect(part(p.at(48), 'head').rot).toBe(0);
    expect(p.at(49).view).toBe('front');
    expect(part(p.at(49), 'head').rot).toBe(VIEW_TURN.deg / 2);
    expect(p.at(50).view).toBe('three-quarter-L');
    expect(part(p.at(50), 'head')).toMatchObject({ rot: VIEW_TURN.deg, sx: VIEW_TURN.squash });
    expect(part(p.at(51), 'head')).toMatchObject({ rot: 0, sx: 1 });
  });

  it('world matrices nest: the hand follows the elbow; the hip sits at the placement', () => {
    const f = solveFrame(rig.rig, spec({ loops: [], poses: [{ pose: 'cheer', at: 0 }] }), 0, { seed: 1 });
    const hip = rig.rig.parts.find((p) => p.name === 'hip' && p.view === 'front')!;
    expect(apply(part(f, 'hip').matrix, hip.pivot[0], hip.pivot[1]).map((v) => Math.round(v))).toEqual([540, 1250]);
    const wrist = apply(part(f, 'hand_R').matrix, 48, 18);
    const elbowEnd = apply(part(f, 'arm_lower_R').matrix, 32, 168);
    expect(wrist[0]).toBeCloseTo(elbowEnd[0], 1); // matrices are rounded to 4 decimals
    expect(wrist[1]).toBeCloseTo(elbowEnd[1], 1);
    expect(wrist[1]).toBeLessThan(900); // cheer: the hand is above the shoulder
  });

  it('a viseme track drives the mouth while it runs; outside it the pose mouth shows', () => {
    const p = prepareCharacter(rig.rig, spec({ loops: [], poses: [{ pose: 'happy', at: 0 }], mouth: { from: 20, frames: ['M', 'M', 'A', 'E', 'X'] } }), { seed: 1 });
    expect(p.at(19).mouth).toBe('smile');
    expect(p.at(20).mouth).toBe('M');
    expect(part(p.at(20), 'mouth').file).toMatch(/mouth-M\.svg$/);
    expect(p.at(22).mouth).toBe('A');
    expect(p.at(25).mouth).toBe('smile');
  });

  it('a beat loop without a tempo map is refused', () => {
    expect(() => prepareCharacter(rig.rig, spec({ loops: ['bounce-beat'] }), { seed: 1 })).toThrow(/tempo map/);
  });
});

describe('the pose blend comes from the preset table', () => {
  it('poseBlendFrames reads the pose-change row (S7); presets without one use the story row', () => {
    const s7 = PRESETS.story.rows.find((r) => r.id === 'S7')!;
    expect(poseBlendFrames('story')).toBe(s7.frames);
    for (const p of ['hook', 'interrupt', 'demo-chant', 'reveal', 'endcard'] as const) expect(poseBlendFrames(p)).toBe(s7.frames);
    expect(POSE_BLEND_FRAMES).toBe(s7.frames);
  });

  it('the solver blends over spec.blendFrames: done at that frame, not before', () => {
    const s = spec({ poses: [{ pose: 'neutral', at: 0 }, { pose: 'cheer', at: 40 }], loops: [], blendFrames: 6 });
    const end = part(solveFrame(rig.rig, s, 46, { seed: 1 }), 'arm_upper_R').rot;
    expect(part(solveFrame(rig.rig, s, 60, { seed: 1 }), 'arm_upper_R').rot).toBe(end);
    expect(part(solveFrame(rig.rig, s, 43, { seed: 1 }), 'arm_upper_R').rot).not.toBe(end);
    const long = { ...s, blendFrames: 20 };
    expect(part(solveFrame(rig.rig, long, 46, { seed: 1 }), 'arm_upper_R').rot).not.toBe(end);
  });

  it('the hold lint measures a pose change over the same blend', () => {
    const t = { charId: 'c', from: 0, to: 200, poses: [{ pose: 'neutral' as const, at: 0 }, { pose: 'happy' as const, at: 40 }], gestures: [{ gesture: 'wave' as const, at: 40 + POSE_BLEND_FRAMES + 8 }] };
    expect(holdLint([t])).toEqual([]);
    expect(holdLint([{ ...t, blendFrames: POSE_BLEND_FRAMES + 2 }]).map((v) => v.gap)).toEqual([6]);
  });

  it('compiled characters carry their beat preset blend', () => {
    const basis = { lang: 'en' as const, bodyPx: {}, grid: null, uiTargets: {}, beats: [{ id: 'b01', segment: 'story' as const, preset: 'story' as const, shot: 'medium' as const, cast: [{ charId: RIG_ID, view: 'front' as const, anchor: { x: 540, y: 1500, h: 1000 } }], camera: { x: 0, y: 0, w: 1080, h: 1920 }, ui: false, stickers: [], targetFrames: 90, techniques: [] }] };
    const out = compileMotion({ beats: [{ beatId: 'b01', preset: 'story', durationFrames: 90, cast: [{ charId: RIG_ID, poses: [{ pose: 'neutral', at: { frame: 0 } }], gestures: [], loops: ['breath', 'blink'] }], camera: [], stickers: [], swipe: null, keyToken: null, cuts: [], lipsync: [] }], contractNotes: [] }, basis, new Map());
    expect(out.characters[0]!.blendFrames).toBe(poseBlendFrames('story'));
  });
});
