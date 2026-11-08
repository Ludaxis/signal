// @vitest-environment node
// Compose adds the creative chain to the timeline (compose-art.ts) and StorySpine's CastLayer draws it.
// The fixture pack is built in a temp folder (synthetic art); no render child, no network.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileMotion, type MotionSpec } from '@/lib/studio/postmaker/anim/compile';
import { carryCreativeArt, tempoOfGrid, timelineArtFiles, withCreativeArt } from '@/lib/studio/postmaker/executors/compose-art';
import { packWorlds } from '@/lib/studio/postmaker/executors/creative-world';
import { loadPack, type LoadedPack } from '@/lib/studio/postmaker/pack/load';
import { castAt, enterAt, flatBox, FLAT_HIP } from '@/lib/studio/postmaker/render/cast';
import type { Timeline } from '@/lib/studio/postmaker/render/timeline';
import { fixtureBuilders } from './slice-harness';
import { tmp } from './guard';

const shared: { dir: string; pack: LoadedPack | null } = { dir: '', pack: null };
beforeAll(async () => {
  shared.dir = mkdtempSync(path.join(os.tmpdir(), 'signal-compose-art-'));
  const { buildPack } = await fixtureBuilders();
  shared.pack = await loadPack((await buildPack(path.join(shared.dir, 'pack'))).dir);
}, 60_000);
afterAll(() => rmSync(shared.dir, { recursive: true, force: true }));

const scene = { id: 'b01', segment: 'story' as const, preset: 'story' as const, shot: 'medium' as const, cast: [{ charId: 'char-cutout', view: 'front' as const, anchor: { x: 540, y: 1300, h: 900 } }, { charId: 'char-elder', view: 'front' as const, anchor: { x: 760, y: 1300, h: 900 } }], camera: { x: 0, y: 0, w: 1080, h: 1920 }, ui: false, stickers: [], targetFrames: 90, techniques: [] };
const spec: MotionSpec = { beats: [{ beatId: 'b01', preset: 'story', durationFrames: 90, cast: [{ charId: 'char-cutout', poses: [{ pose: 'neutral', at: { frame: 0 } }], gestures: [], loops: ['breath', 'blink'] }, { charId: 'char-elder', poses: [{ pose: 'neutral', at: { frame: 0 } }], gestures: [], loops: ['breath'] }], camera: [], stickers: [], swipe: null, keyToken: null, cuts: [], lipsync: [] }], contractNotes: [] };
const basis = { lang: 'en' as const, beats: [scene], bodyPx: {}, grid: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 as const }, uiTargets: {} };
const motionDoc = () => ({ schema: 'signal.pm.motion/1', basis, compiled: compileMotion(spec, basis, new Map()) });
const scenesDoc = { schema: 'signal.pm.scenes/1', beats: [{ beatId: 'b01', background: 'bg-living-room-night' }] };
const base = (): Timeline => ({ schema: 'signal.pm.timeline/1', fps: 30, width: 1080, height: 1920, durationInFrames: 90, lang: 'en', layers: [], captions: [], coverFrame: 0, elements: [{ id: 'scene-b01', kind: 'scene', beatId: 'b01', segment: 'story', preset: 'story', from: 0, to: 90, background: '#223', accent: '#f80', transitionIn: 'cut' }], audio: [], aiLabel: { text: 'AI', lang: 'en' }, mock: true, fonts: [], palette: { background: '#000', backgroundDark: '#000', text: '#fff', accent: '#f80', plate: '#000', cards: [] }, segments: [], cutFrames: [], grid: { bpm: 100, bf: 18, beats: [], chantBeatsPerCard: 2 }, events: [], marks: { hookComplete: null, firstHookTokenOpaque: null } });

describe('compose adds the creative chain to the timeline', () => {
  it('attaches the compiled motion, the rig (Tier A), the still (Tier B), the background and the files by hash', async () => {
    const worlds = packWorlds(tmp.root, async () => shared.pack);
    const { timeline, publicFiles } = await withCreativeArt(base(), { motion: motionDoc(), scenes: scenesDoc, seed: 3, art: worlds.art, params: {} });
    expect(timeline.motion?.characters.map((c) => c.charId)).toEqual(['char-cutout', 'char-elder']);
    expect(timeline.characters).toMatchObject({ seed: 3, tempo: { bpm: 100, firstDownbeatFrame: 0, beatsPerBar: 4 } });
    expect(timeline.characters!.cast.map((c) => c.tier)).toEqual(['A', 'B']);
    const scene = timeline.elements[0]!;
    expect(scene.kind === 'scene' && scene.image).toMatch(/^art\/[0-9a-f]{64}\.png$/);
    expect(publicFiles.length).toBe(new Set(timeline.art!.map((f) => f.src)).size);
    expect(publicFiles.every((p) => path.isAbsolute(p.from) && p.to.startsWith('art/'))).toBe(true);
    // the render resolves the same files again through the pack
    expect((await timelineArtFiles(timeline, worlds.art, {})).map((p) => p.to).sort()).toEqual(publicFiles.map((p) => p.to).sort());
  });

  it('a file whose bytes changed since compose is refused at render (files_changed)', async () => {
    const worlds = packWorlds(tmp.root, async () => shared.pack);
    const { timeline } = await withCreativeArt(base(), { motion: motionDoc(), scenes: scenesDoc, seed: 3, art: worlds.art, params: {} });
    const bad = { ...timeline, art: timeline.art!.map((f, k) => (k === 0 ? { ...f, sha256: '0'.repeat(64) } : f)) };
    await expect(timelineArtFiles(bad, worlds.art, {})).rejects.toMatchObject({ code: 'files_changed' });
    await expect(timelineArtFiles(timeline, undefined, {})).rejects.toMatchObject({ code: 'files_changed' });
  });

  it('the scene plan AI flag reaches the timeline, with or without the pack art', async () => {
    expect((await withCreativeArt(base(), { motion: null, scenes: scenesDoc, seed: 1, params: {} })).timeline.aiAssets).toBe(false);
    expect((await withCreativeArt(base(), { motion: null, scenes: { ...scenesDoc, aiGenerated: true }, seed: 1, params: {} })).timeline.aiAssets).toBe(true);
  });

  it('without a pack, or a motion of another length, the timeline is unchanged', async () => {
    expect((await withCreativeArt(base(), { motion: motionDoc(), scenes: scenesDoc, seed: 1, params: {} })).timeline.characters).toBeUndefined();
    const t = { ...base(), durationInFrames: 120 };
    expect((await withCreativeArt(t, { motion: motionDoc(), scenes: null, seed: 1, params: {} })).timeline.motion).toBeUndefined();
  });

  it('compose.rebuild carries the art over and takes the newly compiled motion', async () => {
    const worlds = packWorlds(tmp.root, async () => shared.pack);
    const { timeline } = await withCreativeArt(base(), { motion: motionDoc(), scenes: scenesDoc, seed: 3, art: worlds.art, params: {} });
    const next = carryCreativeArt(timeline, base(), motionDoc());
    expect(next.characters).toEqual(timeline.characters);
    expect(next.art).toEqual(timeline.art);
    expect(next.motion).toEqual(timeline.motion);
    expect(next.elements[0]).toMatchObject({ image: (timeline.elements[0] as { image: string }).image });
    expect(tempoOfGrid(null)).toBeNull();
  });

  it('the cast layer plan: live characters with their art, the enter track, the flat still at the hip with breath', async () => {
    const worlds = packWorlds(tmp.root, async () => shared.pack);
    const { timeline } = await withCreativeArt(base(), { motion: motionDoc(), scenes: scenesDoc, seed: 3, art: worlds.art, params: {} });
    expect(castAt(timeline, 10).map((x) => [x.c.charId, x.art.tier])).toEqual([['char-cutout', 'A'], ['char-elder', 'B']]);
    expect(castAt(timeline, 95)).toEqual([]);
    expect(castAt({ ...timeline, characters: { ...timeline.characters!, cast: [] } }, 10)).toEqual([]);
    const elder = castAt(timeline, 10)[1]!;
    const still = elder.art.still!;
    const b = flatBox(elder.c, still, 10, 3);
    expect(b.top + b.height * FLAT_HIP).toBeCloseTo(elder.c.place.y, 6);
    expect(b.left + b.width / 2).toBeCloseTo(elder.c.place.x, 6);
    const breaths = Array.from({ length: 72 }, (_, f) => flatBox(elder.c, still, f, 3).sy);
    expect(Math.max(...breaths)).toBeGreaterThan(1.01);
    expect(Math.min(...breaths)).toBeLessThan(1.005);
    expect(flatBox({ ...elder.c, loops: [] }, still, 10, 3).sy).toBe(1);
    expect(enterAt(timeline, { charId: 'char-cutout', beatId: 'b01' }, 5)).toBe(1);
    const entering = { ...timeline, motion: { ...timeline.motion!, tracks: [{ element: 'char:char-elder:b01', prop: 'enter', keys: [{ frame: 0, value: 0, curve: 'settle' as const }, { frame: 16, value: 1, curve: 'settle' as const }] }] } };
    expect(enterAt(entering, { charId: 'char-elder', beatId: 'b01' }, 0)).toBe(0);
    expect(enterAt(entering, { charId: 'char-elder', beatId: 'b01' }, 16)).toBe(1);
  });
});
