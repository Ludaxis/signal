// @vitest-environment node
// @render (agent-run evidence): a mock MotionSpec for two beats of the synthetic Tier A fixture character,
// compiled and drawn by the real render child and Chrome Headless Shell through CharacterTest composition.
// Skipped unless SIGNAL_RENDER=1; it makes no network call (local node, Chrome, ffmpeg). Run it locally:
//
//   SIGNAL_RENDER=1 SIGNAL_RENDER_BROWSER=<chrome-headless-shell program> SIGNAL_RENDER_EVIDENCE=<dir> \
//     npx vitest run tests/unit/postmaker/render/motion-render.test.ts
//
// Writes the stills of the hook (every 6th frame), a contact sheet and a 5 fps preview MP4 with ffmpeg when it is on
// the PATH, and motion-report.json (the spec, the compiled character and what each still shows). The checks are
// geometric on solved frames (the gasp's brows and the point's arm move at the compiled frames); the images are for a
// person to look at. [Pack example] the character is the original fixture art from make-rig.mjs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileMotion } from '@/lib/studio/postmaker/anim/compile';
import { c5Lint } from '@/lib/studio/postmaker/anim/lint';
import { loadRig, type LoadedRig } from '@/lib/studio/postmaker/anim/rig/load';
import { solveFrame } from '@/lib/studio/postmaker/anim/solve';
import type { TempoMap } from '@/lib/studio/postmaker/anim/types';
import { fakeAlignment } from '@/lib/studio/postmaker/executors/fakes';
import { mockMotionSpec, motionContext, validateMotionSpec } from '@/lib/studio/postmaker/executors/motion';
import { motionRigCaps } from '@/lib/studio/postmaker/executors/motion-world';
import type { ExecInput } from '@/lib/studio/postmaker/executors/types';
import { makeChildRenderChain, type RenderChain } from '@/lib/studio/postmaker/render/renderer';
import type { Recipe } from '@/lib/studio/postmaker/types';
import { libraryOf, rigAsset, rigBuilder, RIG_ID } from '../anim/rig-fixture';

const ON = process.env.SIGNAL_RENDER === '1';
const EVIDENCE = path.join(process.env.SIGNAL_RENDER_EVIDENCE || path.join(os.tmpdir(), 'signal-render-evidence'), 'motion');
const PAPER = '#F4EFE6';
const TEMPO: TempoMap = { bpm: 100, firstDownbeatFrame: 0, beatsPerBar: 4 };

let rig: LoadedRig;
let chain: RenderChain;
let sources: Record<string, string>;

beforeAll(async () => {
  if (!ON) return;
  mkdirSync(EVIDENCE, { recursive: true });
  const libDir = path.join(EVIDENCE, 'library');
  (await rigBuilder()).buildRig(path.join(libDir, 'characters', RIG_ID));
  rig = await loadRig({ manifest: { rigTier: { [RIG_ID]: 'A' } } }, libraryOf(libDir, rigAsset(libDir)), RIG_ID, { final: true, use: 'organic' });
  sources = Object.fromEntries(Object.keys(rig.files).map((rel) => [rel, `data:image/svg+xml;base64,${readFileSync(path.join(rig.dir, rel)).toString('base64')}`]));
  chain = makeChildRenderChain({ browserExecutable: process.env.SIGNAL_RENDER_BROWSER || null, cacheDir: path.join(EVIDENCE, 'cache') });
}, 120_000);

const beat = (id: string, start: number, end: number, segment: string) => ({ id, start, end, segment, name: '', purpose: '', visual: '', techniques: [], onScreenText: {}, audio: '', motion: '' });

function inputs(): ExecInput {
  const recipe = { id: 'rc-20261107-abcd', version: 1, shape: '9:16', beats: [beat('b01', 0, 6, 'hook'), beat('b02', 6, 10.4, 'story')], tempo: { bpm: 100, downbeatMs: 0 }, languages: ['en'] } as unknown as Recipe;
  const place = { charId: RIG_ID, view: 'front', anchor: { x: 540, y: 1250, h: 1260 } };
  const scenes = { beats: [{ beatId: 'b01', preset: 'hook', shot: 'wide', cast: [{ ...place, pose: 'look-phone' }], ui: null, stickers: [], camera: { x: 0, y: 0, w: 1080, h: 1920 } }, { beatId: 'b02', preset: 'story', shot: 'medium', cast: [{ ...place, pose: 'neutral' }], ui: null, stickers: [], camera: { x: 0, y: 0, w: 1080, h: 1920 } }] };
  const alignment = fakeAlignment('en', [{ id: 'l01', beatId: 'b01', display: 'Grandma has the loudest house tonight' }, { id: 'l02', beatId: 'b02', display: 'Come here and sit with me' }], (l) => (l.id === 'l01' ? 2400 : 2600));
  return { recipe, lang: 'en', params: {}, byPort: { scenes, alignment, beatGrid: { bpm: 100, downbeatMs: 0 } } } as unknown as ExecInput;
}

describe.runIf(ON)('@render compiled MotionSpec on the Tier A fixture character (evidence)', () => {
  it('@render the hook and the story beat: idles, the gasp on the key token, the point on the story line', async () => {
    const world = { rigs: { [RIG_ID]: motionRigCaps(rig) } };
    const ctx = motionContext(inputs(), world);
    const spec = validateMotionSpec(mockMotionSpec(ctx, { seed: 1 }), ctx);
    const compiled = compileMotion(spec, ctx.basis, ctx.lines);
    expect(c5Lint(compiled.characters)).toEqual([]);
    const [hook, story] = compiled.characters as [(typeof compiled.characters)[number], (typeof compiled.characters)[number]];
    expect(hook.gestures[0]!.gesture).toBe('gasp');
    expect(story.gestures[0]!.gesture).toBe('point');

    // geometry on solved frames: the brows rise during the gasp; the arm extends for the point
    const brow = (s: typeof hook, f: number) => solveFrame(rig.rig, s, f, { seed: 1, tempo: TEMPO, library: rig.library }).parts.find((p) => p.name === 'brow_L')!.y;
    const g = hook.gestures[0]!.at;
    expect(brow(hook, g + 5)).toBeLessThan(brow(hook, g - 1));
    const arm = (f: number) => solveFrame(rig.rig, story, f, { seed: 1, tempo: TEMPO, library: rig.library }).parts.find((p) => p.name === 'arm_upper_R')!.rot;
    const p = story.gestures[0]!.at;
    expect(Math.abs(arm(p + 9) - arm(p - 1))).toBeGreaterThan(40);

    const frames = [...new Set([...Array.from({ length: Math.ceil((hook.to - hook.from) / 6) }, (_, k) => hook.from + 6 * k), g + 3, g + 8])].sort((a, b) => a - b);
    const storyFrames = [p - 1, p + 4, p + 9];
    const t0 = Date.now();
    const tasks = [
      ...frames.map((f) => ({ kind: 'still' as const, composition: 'CharacterTest' as const, props: { rig: rig.rig, sources, spec: hook, seed: 1, tempo: TEMPO, library: rig.library, background: PAPER, width: 1080, height: 1920 }, out: path.join(EVIDENCE, `hook-${String(f).padStart(4, '0')}.png`), frame: f, scale: 0.5, imageFormat: 'png' as const })),
      ...storyFrames.map((f) => ({ kind: 'still' as const, composition: 'CharacterTest' as const, props: { rig: rig.rig, sources, spec: story, seed: 1, tempo: TEMPO, library: rig.library, background: PAPER, width: 1080, height: 1920 }, out: path.join(EVIDENCE, `story-${String(f).padStart(4, '0')}.png`), frame: f, scale: 0.5, imageFormat: 'png' as const })),
    ];
    await chain.run(tasks, { publicFiles: [], workDir: path.join(EVIDENCE, 'work') });
    const ms = Date.now() - t0;

    const report: Record<string, unknown> = { at: new Date().toISOString(), browser: process.env.SIGNAL_RENDER_BROWSER ?? null, renderMs: ms, stills: tasks.map((x) => path.basename(x.out)), spec, compiled: { totalFrames: compiled.totalFrames, beats: compiled.beats, cuts: compiled.cuts, characters: compiled.characters, tracks: compiled.tracks, keyTokens: compiled.keyTokens }, gaspAt: g, pointAt: p };
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '5', '-pattern_type', 'glob', '-i', path.join(EVIDENCE, 'hook-*.png'), '-vf', 'tile=8x4', '-frames:v', '1', path.join(EVIDENCE, 'hook-sheet.png')]);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '5', '-pattern_type', 'glob', '-i', path.join(EVIDENCE, 'hook-*.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(EVIDENCE, 'hook-preview.mp4')]);
      report.ffmpeg = ['hook-sheet.png', 'hook-preview.mp4'];
    } catch (e) {
      report.ffmpeg = `not made: ${(e as Error).message.split('\n')[0]}`;
    }
    writeFileSync(path.join(EVIDENCE, 'motion-report.json'), JSON.stringify(report, null, 2));
  }, 600_000);
});
