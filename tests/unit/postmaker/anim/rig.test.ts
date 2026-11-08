// @vitest-environment node
// Rig: schema, validateRig (quality bar acceptance 1) and loadRig through the pack resolver (tier, status,
// sha256, part files, sizes, per-character overrides).
import '../guard';
import { rmSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRig, type LoadedRig } from '@/lib/studio/postmaker/anim/rig/load';
import { validateRig } from '@/lib/studio/postmaker/anim/rig/validate';
import { checkPerformable, coreLibrary, mergeOverrides } from '@/lib/studio/postmaker/anim/library/overrides';
import { MOUTH_STATES, REQUIRED_PARTS, type CutoutRig } from '@/lib/studio/postmaker/anim/types';
import { buildRigFixture, FINAL, libraryOf, rigAsset, RIG_ID, type RigFixture } from './rig-fixture';

let fx: RigFixture;
let loaded: LoadedRig;
beforeAll(async () => {
  fx = await buildRigFixture();
  loaded = await loadRig(fx, fx.lib, RIG_ID, FINAL);
}, 60_000);
afterAll(() => rmSync(fx.libDir, { recursive: true, force: true }));

const clone = (): CutoutRig => structuredClone(loaded.rig);
const codes = (r: CutoutRig) => validateRig(r).issues.map((i) => `${i.code} ${i.view ?? ''} ${i.part ?? ''}`.trim());
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
};

describe('the fixture rig (Tier A, original SVG parts)', () => {
  it('loads through the pack resolver and passes validateRig', () => {
    expect(loaded.tier).toBe('A');
    expect(loaded.rig.views).toEqual(['front', 'three-quarter-L']);
    expect(validateRig(loaded.rig)).toEqual({ ok: true, issues: [] });
    for (const view of loaded.rig.views) {
      const names = loaded.rig.parts.filter((p) => p.view === view).map((p) => p.name);
      for (const n of REQUIRED_PARTS) expect(names, `${view} ${n}`).toContain(n);
    }
    const mouth = loaded.rig.parts.find((p) => p.name === 'mouth')!;
    expect(Object.keys(mouth.states!).sort()).toEqual([...MOUTH_STATES].sort());
  });

  it('fills every drawn part size from its file and hashes every file (parts, states, turnaround)', () => {
    for (const p of loaded.rig.parts) if (p.file || p.states) expect(p.size, `${p.view} ${p.name}`).toBeDefined();
    expect(loaded.files['turnaround.svg']).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(loaded.files).length).toBeGreaterThan(100);
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('validateRig rejects (quality bar acceptance 1)', () => {
  it('a missing face part, naming the part and view', () => {
    const r = clone();
    r.parts = r.parts.filter((p) => !(p.name === 'eye_L' && p.view === 'front'));
    r.parts = r.parts.filter((p) => !(p.parent === 'eye_L' && p.view === 'front'));
    expect(codes(r)).toContain('rig.face-part-missing front eye_L');
  });
  it.each(['X', 'A', 'E', 'O', 'U', 'M', 'F', 'L'])('a missing viseme %s', (v) => {
    const r = clone();
    const mouth = r.parts.find((p) => p.name === 'mouth' && p.view === 'three-quarter-L')!;
    delete mouth.states![v];
    expect(codes(r)).toEqual([`rig.viseme-missing three-quarter-L mouth`]);
  });
  it('a missing expression mouth, eye state or hand shape (state-missing)', () => {
    const r = clone();
    delete r.parts.find((p) => p.name === 'mouth' && p.view === 'front')!.states!.grin;
    delete r.parts.find((p) => p.name === 'hand_R' && p.view === 'front')!.states!.peace;
    delete r.parts.find((p) => p.name === 'eye_L' && p.view === 'front')!.states!.wide;
    expect(codes(r).sort()).toEqual(['rig.state-missing front eye_L', 'rig.state-missing front hand_R', 'rig.state-missing front mouth']);
  });
  it('a pivot outside its part bounds', () => {
    const r = clone();
    const elbow = r.parts.find((p) => p.name === 'arm_lower_R' && p.view === 'front')!;
    elbow.pivot = [elbow.size![0] + 3, 32];
    expect(codes(r)).toEqual(['rig.pivot-outside front arm_lower_R']);
  });
  it('an anchor outside the parent, a missing view, a second root, a cycle, unordered limits', () => {
    const r = clone();
    r.parts.find((p) => p.name === 'hand_L' && p.view === 'front')!.anchor = [500, 10];
    expect(codes(r)).toEqual(['rig.anchor-outside front hand_L']);
    expect(codes({ ...clone(), views: ['front'], parts: clone().parts.filter((p) => p.view === 'front') })).toEqual(['rig.view-missing three-quarter-L']);
    const two = clone();
    two.parts.find((p) => p.name === 'torso' && p.view === 'front')!.parent = null;
    expect(codes(two)).toContain('rig.root front torso');
    const cyc = clone();
    cyc.parts.find((p) => p.name === 'neck' && p.view === 'front')!.parent = 'head';
    expect(codes(cyc).some((c) => c.startsWith('rig.cycle front'))).toBe(true);
    const lim = clone();
    lim.parts.find((p) => p.name === 'head' && p.view === 'front')!.limits = { rot: [5, 15] };
    expect(codes(lim)).toEqual(['rig.limits front head']);
  });
});

describe('loadRig refuses', () => {
  it('a flat (Tier B) character, a character with no tier, and an asset that is not a rig', async () => {
    expect(await code(loadRig({ manifest: { rigTier: { [RIG_ID]: 'B' } } } as never, fx.lib, RIG_ID, FINAL))).toBe('rig.flat');
    expect(await code(loadRig({ manifest: { rigTier: {} } } as never, fx.lib, RIG_ID, FINAL))).toBe('rig.tier-missing');
    const notRig = { ...rigAsset(fx.libDir), file: `characters/${RIG_ID}/turnaround.svg` };
    notRig.sha256 = (await import('./rig-fixture')).sha(readFileSync(path.join(fx.charDir, 'turnaround.svg')));
    expect(await code(loadRig(fx as never, libraryOf(fx.libDir, notRig), RIG_ID, FINAL))).toBe('rig.not-a-rig');
  });
  it('through the resolver: a draft in a final render, a sha256 mismatch', async () => {
    expect(await code(loadRig(fx as never, libraryOf(fx.libDir, rigAsset(fx.libDir, 'draft')), RIG_ID, FINAL))).toBe('asset.draft-in-final');
    expect((await loadRig(fx as never, libraryOf(fx.libDir, rigAsset(fx.libDir, 'draft')), RIG_ID, { ...FINAL, final: false })).tier).toBe('A');
    expect(await code(loadRig(fx as never, libraryOf(fx.libDir, { ...rigAsset(fx.libDir), sha256: '0'.repeat(64) }), RIG_ID, FINAL))).toBe('asset.sha256-mismatch');
  });
  it('a missing part file, a rig that fails validation, a declared size that does not match', async () => {
    const f = await buildRigFixture();
    try {
      unlinkSync(path.join(f.charDir, 'parts/front/nose.svg'));
      expect(await code(loadRig(f as never, f.lib, RIG_ID, FINAL))).toBe('rig.file-missing');
      const rigFile = path.join(f.charDir, 'rig.json');
      const rig = JSON.parse(readFileSync(rigFile, 'utf8')) as CutoutRig;
      const write = (r: CutoutRig) => {
        writeFileSync(rigFile, JSON.stringify(r));
        return libraryOf(f.libDir, rigAsset(f.libDir));
      };
      const noNose = { ...rig, parts: rig.parts.filter((p) => p.name !== 'nose') };
      expect(await code(loadRig(f as never, write(noNose), RIG_ID, FINAL))).toBe('rig.face-part-missing');
      const sized = structuredClone(noNose);
      sized.parts.find((p) => p.name === 'head')!.size = [10, 10];
      expect(await code(loadRig(f as never, write(sized), RIG_ID, FINAL))).toBe('rig.part-size-mismatch');
    } finally {
      rmSync(f.libDir, { recursive: true, force: true });
    }
  });
});

describe('per-character overrides (pack guide)', () => {
  it('merge the keys of core ids: a pose per part, a gesture as a clip', () => {
    const m = mergeOverrides(loaded.rig, { schema: 'signal.cutout-poses/1', poses: { cheer: { parts: { arm_upper_R: { rot: 150 } } } } }, { schema: 'signal.cutout-gestures/1', gestures: { nod: { frames: 14, keys: [{ frame: 0, part: 'head', prop: 'rot', value: 0, curve: 'whip' }, { frame: 14, part: 'head', prop: 'rot', value: 0, curve: 'settle' }] } } });
    expect(m.issues).toEqual([]);
    expect(m.library.poses.cheer.parts.arm_upper_R).toEqual({ rot: 150 });
    expect(m.library.poses.cheer.parts.arm_upper_L).toEqual(coreLibrary().poses.cheer.parts.arm_upper_L);
    expect(m.library.gestures.nod.frames).toBe(14);
  });
  it('refuse a new id, an unknown part or state, a key outside limits, naming character, id and part', () => {
    const m = mergeOverrides(
      loaded.rig,
      { schema: 'signal.cutout-poses/1', poses: { moonwalk: { parts: {} }, happy: { parts: { tail: { rot: 3 }, mouth: { state: 'kiss' }, head: { rot: 40 } } } } },
      { schema: 'signal.cutout-gestures/1', gestures: { wave: { frames: 24, keys: [{ frame: 3, part: 'arm_lower_R', prop: 'rot', value: -170, curve: 'whip' }] } } },
    );
    expect(m.issues.map((i) => [i.code, i.charId, i.id, i.part])).toEqual([
      ['override.unknown-id', RIG_ID, 'moonwalk', null],
      ['override.unknown-part', RIG_ID, 'happy', 'tail'],
      ['override.unknown-state', RIG_ID, 'happy', 'mouth'],
      ['override.outside-limits', RIG_ID, 'happy', 'head'],
      ['override.outside-limits', RIG_ID, 'wave', 'arm_lower_R'],
    ]);
    expect(m.issues[3]!.message).toContain(RIG_ID);
  });
  it('a pose the rig cannot perform (a hand shape it lacks) is named', () => {
    const r = clone();
    for (const p of r.parts) if (p.name.startsWith('hand_')) delete p.states!.point;
    const issues = checkPerformable(r, coreLibrary());
    expect(issues.map((i) => `${i.id} ${i.part}`)).toEqual(expect.arrayContaining(['point-screen hand_R', 'point hand_R', 'point hand_L', 'swipe hand_R']));
    expect(checkPerformable(loaded.rig, coreLibrary())).toEqual([]);
  });
  it('loadRig reads poses.json / gestures.json beside the rig and refuses a bad one', async () => {
    const f = await buildRigFixture();
    try {
      writeFileSync(path.join(f.charDir, 'poses.json'), JSON.stringify({ schema: 'signal.cutout-poses/1', poses: { shrug: { parts: { head: { rot: 9 } } } } }));
      expect((await loadRig(f as never, f.lib, RIG_ID, FINAL)).library.poses.shrug.parts.head).toEqual({ rot: 9 });
      writeFileSync(path.join(f.charDir, 'gestures.json'), JSON.stringify({ schema: 'signal.cutout-gestures/1', gestures: { dab: { frames: 4, keys: [] } } }));
      expect(await code(loadRig(f as never, f.lib, RIG_ID, FINAL))).toBe('override.unknown-id');
    } finally {
      rmSync(f.libDir, { recursive: true, force: true });
    }
  });
});
