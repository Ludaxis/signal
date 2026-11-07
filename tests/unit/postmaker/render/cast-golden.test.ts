// @vitest-environment node
// @render (agent-run evidence): one character frame per motion preset, drawn by StorySpine's cast layer (the
// compiled motion of the preset, the Tier A fixture rig, its loops, the preset's pose blend) through the real render
// child and Chrome Headless Shell. Skipped unless SIGNAL_RENDER=1; no network call (local node, Chrome). Run it locally:
//
//   SIGNAL_RENDER=1 SIGNAL_RENDER_BROWSER=<chrome-headless-shell program> SIGNAL_RENDER_EVIDENCE=<dir> \
//     npx vitest run tests/unit/postmaker/render/cast-golden.test.ts
//
// Goldens `cast-<preset>.png` live in tests/postmaker/golden/ and are provisional (creative director review; for
// any Persian frame). With SIGNAL_RENDER_UPDATE_GOLDENS=1 a missing golden is written instead of compared.
// [Pack example] the character is the original fixture art from make-rig.mjs.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileMotion, type MotionBasis, type MotionSpec } from '@/lib/studio/postmaker/anim/compile';
import { loadRig, type LoadedRig } from '@/lib/studio/postmaker/anim/rig/load';
import type { AnimLoopId } from '@/lib/studio/postmaker/anim/types';
import { restBodyPx } from '@/lib/studio/postmaker/executors/motion-world';
import { fontPublicFiles, timelineFonts } from '@/lib/studio/postmaker/executors/render-chain';
import { coreFonts } from '@/lib/studio/postmaker/render/fonts';
import { PRESETS, PRESET_IDS, presetForSegment, poseBlendFrames, type PresetId, type SegmentId } from '@/lib/studio/postmaker/render/presets';
import { makeChildRenderChain, type RenderChain } from '@/lib/studio/postmaker/render/renderer';
import type { Timeline } from '@/lib/studio/postmaker/render/timeline';
import { diffRatio, rawOf } from './image-compare';
import { buildRigFixture, FINAL, RIG_ID, type RigFixture } from '../anim/rig-fixture';

const ON = process.env.SIGNAL_RENDER === '1';
const WEB = path.resolve(__dirname, '../../../..');
const GOLDEN = path.join(WEB, 'tests/postmaker/golden');
const UPDATE = process.env.SIGNAL_RENDER_UPDATE_GOLDENS === '1';
const EVIDENCE = path.join(process.env.SIGNAL_RENDER_EVIDENCE || path.join(os.tmpdir(), 'signal-render-evidence'), 'cast');
const BODY = { left: 140, top: 340, width: 800, height: 1360 };
/** The pose each preset's character takes at frame 10 (from neutral), so the frame shows the preset's blend. */
const POSE: Record<PresetId, 'happy' | 'surprised' | 'shrug' | 'point-screen' | 'cheer' | 'hands-hips'> = { hook: 'surprised', story: 'happy', interrupt: 'shrug', 'demo-chant': 'point-screen', reveal: 'cheer', endcard: 'hands-hips' };
const SEGMENT: Record<PresetId, SegmentId> = { hook: 'hook', story: 'story', interrupt: 'interrupt', 'demo-chant': 'demo', reveal: 'reveal', endcard: 'endcard' };
const FRAME = 18; // 8 frames into the pose change: inside every preset's blend
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), browser: process.env.SIGNAL_RENDER_BROWSER ?? null };

let fx: RigFixture;
let rig: LoadedRig;
let chain: RenderChain;
let sources: Record<string, string>;
const fonts = () => coreFonts();

beforeAll(async () => {
  if (!ON) return;
  mkdirSync(EVIDENCE, { recursive: true });
  mkdirSync(GOLDEN, { recursive: true });
  fx = await buildRigFixture();
  rig = await loadRig(fx, fx.lib, RIG_ID, FINAL);
  sources = Object.fromEntries(Object.keys(rig.files).map((rel) => [rel, `data:image/${rel.endsWith('.png') ? 'png' : 'svg+xml'};base64,${readFileSync(path.join(rig.dir, rel)).toString('base64')}`]));
  chain = makeChildRenderChain({ browserExecutable: process.env.SIGNAL_RENDER_BROWSER || null, cacheDir: path.join(EVIDENCE, 'cache') });
}, 120_000);
afterAll(() => {
  if (!ON) return;
  report.endedAt = new Date().toISOString();
  writeFileSync(path.join(EVIDENCE, 'cast-report.json'), JSON.stringify(report, null, 2));
  rmSync(fx.libDir, { recursive: true, force: true });
});

/** A one-beat timeline: the preset's scene, the fixture character with breath, blink and the preset's own loops. */
export function presetTimeline(p: PresetId): Timeline {
  const segment = SEGMENT[p];
  const loops = [...new Set<AnimLoopId>(['breath', 'blink', ...(PRESETS[p].loops.filter((l) => l === 'sway' || l === 'bounce-beat') as AnimLoopId[])])];
  const basis: MotionBasis = { lang: 'en', bodyPx: { [RIG_ID]: restBodyPx(rig.rig) ?? 1000 }, grid: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 }, uiTargets: {}, beats: [{ id: 'b01', segment, preset: p, shot: 'medium', cast: [{ charId: RIG_ID, view: 'front', anchor: { x: 540, y: 1180, h: 1100 } }], camera: { x: 0, y: 0, w: 1080, h: 1920 }, ui: false, stickers: [], targetFrames: 90, techniques: [] }] };
  const spec: MotionSpec = { beats: [{ beatId: 'b01', preset: p, durationFrames: 90, cast: [{ charId: RIG_ID, poses: [{ pose: 'neutral', at: { frame: 0 } }, { pose: POSE[p], at: { frame: 10 } }], gestures: [], loops }], camera: [], stickers: [], swipe: null, keyToken: null, cuts: [], lipsync: [] }], contractNotes: [] };
  const motion = compileMotion(spec, basis, new Map());
  expect(presetForSegment(segment)).toBe(p);
  expect(motion.characters[0]!.blendFrames).toBe(poseBlendFrames(p));
  return {
    schema: 'signal.pm.timeline/1', fps: 30, width: 1080, height: 1920, durationInFrames: 90, lang: 'en',
    layers: [{ beatId: 'b01', from: 0, to: 90 }], captions: [], coverFrame: 0,
    elements: [{ id: 'scene-b01', kind: 'scene', beatId: 'b01', segment, preset: p, from: 0, to: 90, background: '#F4EFE6', accent: '#F2A541', transitionIn: 'cut', image: undefined }],
    audio: [], aiLabel: { text: 'Made with AI', lang: 'en' }, mock: false, fonts: timelineFonts(fonts()),
    palette: { background: '#F4EFE6', backgroundDark: '#16161D', text: '#16161D', accent: '#F2A541', plate: '#FFFFFF', cards: ['#F2A541'] },
    segments: [{ beatId: 'b01', segment, preset: p, from: 0, to: 90 }], cutFrames: [], grid: { bpm: 100, bf: 18, beats: [0, 18, 36, 54, 72], chantBeatsPerCard: 2 }, events: [], marks: { hookComplete: null, firstHookTokenOpaque: null },
    motion,
    characters: { seed: 1, tempo: { bpm: 100, firstDownbeatFrame: 0, beatsPerBar: 4 }, cast: [{ charId: RIG_ID, tier: 'A', rig: rig.rig, library: rig.library, sources }] },
  };
}

describe.runIf(ON)('@render one character frame per motion preset (provisional goldens)', () => {
  for (const p of PRESET_IDS)
    it(`@render cast-${p}: the character drawn by StorySpine at frame ${FRAME} matches its golden`, async () => {
      const out = path.join(EVIDENCE, `cast-${p}.png`);
      const t0 = Date.now();
      await chain.run([{ kind: 'still', composition: 'StorySpine', props: { timeline: presetTimeline(p), master: null }, out, frame: FRAME, imageFormat: 'png' }], { publicFiles: fontPublicFiles(fonts()), workDir: path.join(EVIDENCE, 'work') });
      const g = path.join(GOLDEN, `cast-${p}.png`);
      const raw = await rawOf(out, BODY);
      // the character is on the frame: the body crop is not the plain background
      const paper = raw.data.reduce((n, _v, i) => (i % 3 === 0 && Math.abs(raw.data[i]! - 0xf4) < 6 && Math.abs(raw.data[i + 1]! - 0xef) < 6 && Math.abs(raw.data[i + 2]! - 0xe6) < 6 ? n + 1 : n), 0) / (raw.width * raw.height);
      expect(paper).toBeLessThan(0.97);
      if (!existsSync(g)) {
        if (!UPDATE) throw new Error(`Golden cast-${p}.png is missing (run once with SIGNAL_RENDER_UPDATE_GOLDENS=1, then have the creative director review it)`);
        const sharp = (await import('sharp')).default;
        await sharp(out).extract(BODY).png({ compressionLevel: 9 }).toFile(g);
        report[p] = { written: true, ms: Date.now() - t0, paperShare: paper };
        return;
      }
      const diff = diffRatio(raw, await rawOf(g));
      report[p] = { diff, ms: Date.now() - t0, paperShare: paper };
      copyFileSync(g, path.join(EVIDENCE, `cast-${p}.golden.png`));
      expect(diff).toBeLessThanOrEqual(0.005);
    }, 300_000);
});
