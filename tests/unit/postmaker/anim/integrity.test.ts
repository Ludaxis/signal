// @vitest-environment node
// Pivot integrity (quality bar acceptance 2, geometric part): every limited joint of the fixture rig, in
// both views, keeps its joint disc covered at 0°, ±limit/2 and ±limit (gap ≤ 1 px), with ≥ 6 px of overdraw; a
// square-ended joint opens a wedge at a bend and fails, so the test can fail. The @render frame check is in
// render/character-golden.test.ts.
import '../guard';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRig, type LoadedRig } from '@/lib/studio/postmaker/anim/rig/load';
import { rigMasks } from '@/lib/studio/postmaker/anim/rig/coverage';
import { jointReport, jointReports, OVERDRAW_MIN_PX, testAngles, type Mask } from '@/lib/studio/postmaker/anim/rig/integrity';
import type { RigPart } from '@/lib/studio/postmaker/anim/types';
import { buildRigFixture, FINAL, RIG_ID, type RigFixture } from './rig-fixture';

let fx: RigFixture;
let loaded: LoadedRig;
let masks: Map<string, Mask[]>;
beforeAll(async () => {
  fx = await buildRigFixture();
  loaded = await loadRig(fx, fx.lib, RIG_ID, FINAL);
  masks = await rigMasks(loaded.dir, loaded.rig.parts);
}, 120_000);
afterAll(() => rmSync(fx.libDir, { recursive: true, force: true }));

/** A synthetic mask from a predicate over part px. */
function shape(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return { w, h, data };
}
const part = (o: Partial<RigPart> & Pick<RigPart, 'name' | 'pivot' | 'anchor'>): RigPart => ({ view: 'front', parent: 'p', z: 1, ...o });

describe('pivot integrity on the fixture rig', () => {
  it('test angles are 0, ±limit/2 and ±limit', () => {
    expect(testAngles([-60, 170])).toEqual([-60, -30, 0, 85, 170]);
    expect(testAngles([-15, 15])).toEqual([-15, -7.5, 0, 7.5, 15]);
  });

  for (const view of ['front', 'three-quarter-L'] as const) {
    it(`${view}: every limited joint stays closed at every test angle, with ≥ ${OVERDRAW_MIN_PX} px overdraw`, () => {
      const reports = jointReports(loaded.rig, view, (p) => masks.get(`${p.view}/${p.name}`) ?? []);
      // hip is the root (no parent): every other limited part is a joint
      expect(reports.map((r) => r.part).sort()).toEqual(
        ['arm_lower_L', 'arm_lower_R', 'arm_upper_L', 'arm_upper_R', 'foot_L', 'foot_R', 'hand_L', 'hand_R', 'head', 'leg_lower_L', 'leg_lower_R', 'leg_upper_L', 'leg_upper_R', 'neck', 'torso'].sort(),
      );
      for (const r of reports) {
        expect(r.message, `${view} ${r.part}`).toBeNull();
        expect(r.radius, `${view} ${r.part} joint disc`).toBeGreaterThanOrEqual(OVERDRAW_MIN_PX);
        expect(r.overdraw, `${view} ${r.part} overdraw`).toBeGreaterThanOrEqual(OVERDRAW_MIN_PX);
        for (const a of r.angles) expect(a.gapPx, `${view} ${r.part} at ${a.deg}°`).toBeLessThanOrEqual(1);
      }
    });
  }
});

describe('the check fails where a joint would open', () => {
  // a 60 px wide limb hanging from a 60 px wide parent, both square-ended, 8 px of overlap at the joint
  const parentMask = shape(60, 200, () => true);
  const square = shape(60, 200, () => true);
  const capsule = shape(60, 200, (x, y) => (y < 30 ? (x - 30) ** 2 + (y - 30) ** 2 <= 900 : true));
  const parent = part({ name: 'p', parent: null, pivot: [30, 30], anchor: [0, 0], size: [60, 200] });

  it('square ends: a wedge opens at a bend (gap > 1 px at the limit)', () => {
    const child = part({ name: 'c', pivot: [30, 8], anchor: [30, 192], limits: { rot: [-90, 90] }, size: [60, 200] });
    const r = jointReport({ part: parent, mask: parentMask }, { part: child, masks: [square] });
    expect(r.ok).toBe(false);
    expect(r.angles.find((a) => a.deg === 90)!.gapPx).toBeGreaterThan(1); // the wedge is wider than 1 px
    expect(r.angles.find((a) => a.deg === 0)!.gapPx).toBe(0);
    expect(r.message).toMatch(/opens a \d+ px gap at/);
  });

  it('a round end on the joint centre closes it at every angle', () => {
    const child = part({ name: 'c', pivot: [30, 30], anchor: [30, 192], limits: { rot: [-90, 90] }, size: [60, 200] });
    const r = jointReport({ part: parent, mask: parentMask }, { part: child, masks: [capsule] });
    expect(r.angles.every((a) => a.gapPx === 0)).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('too little overdraw is reported even when nothing opens', () => {
    const child = part({ name: 'c', pivot: [30, 2], anchor: [30, 198], limits: { rot: [0, 0] }, size: [60, 200] });
    const r = jointReport({ part: parent, mask: parentMask }, { part: child, masks: [square] });
    expect(r.overdraw).toBeLessThan(OVERDRAW_MIN_PX);
    expect(r.message).toMatch(/overlaps p by/);
  });
});
