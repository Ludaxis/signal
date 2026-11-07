// @vitest-environment node
// @render (agent-run evidence): the cut-out fixture character rendered by the real render child and Chrome
// Headless Shell. Skipped unless SIGNAL_RENDER=1; it makes no network call (local node, Chrome). Run it locally:
//
//   SIGNAL_RENDER=1 SIGNAL_RENDER_BROWSER=<chrome-headless-shell program> SIGNAL_RENDER_EVIDENCE=<dir> \
//     npx vitest run tests/unit/postmaker/render/character-golden.test.ts
//
// Covers (golden frames for `neutral`, `wave` mid-swing and viseme `M`; provisional, like every golden here)
// and the frame half of quality bar acceptance 2: every limited joint posed at its limits (lo and hi, both views)
// shows no background through the joint disc (gap ≤ 1 px). With SIGNAL_RENDER_UPDATE_GOLDENS=1 a missing golden is
// written instead of compared. [Pack example] the character is the original fixture art from make-rig.mjs.
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { coreLibrary } from '@/lib/studio/postmaker/anim/library/overrides';
import { loadRig, type LoadedRig } from '@/lib/studio/postmaker/anim/rig/load';
import { rigMasks } from '@/lib/studio/postmaker/anim/rig/coverage';
import { jointReports } from '@/lib/studio/postmaker/anim/rig/integrity';
import { apply, solveFrame } from '@/lib/studio/postmaker/anim/solve';
import type { CharacterLibrary, CharacterSpec, ViewId } from '@/lib/studio/postmaker/anim/types';
import { visemeTrack } from '@/lib/studio/postmaker/anim/visemeTrack';
import { makeChildRenderChain, type RenderChain } from '@/lib/studio/postmaker/render/renderer';
import { diffRatio, rawOf, type Raw } from './image-compare';
import { libraryOf, rigAsset, rigBuilder, RIG_ID } from '../anim/rig-fixture';

const ON = process.env.SIGNAL_RENDER === '1';
const WEB = path.resolve(__dirname, '../../../..');
const GOLDEN = path.join(WEB, 'tests/postmaker/golden');
const UPDATE = process.env.SIGNAL_RENDER_UPDATE_GOLDENS === '1';
const EVIDENCE = path.join(process.env.SIGNAL_RENDER_EVIDENCE || path.join(os.tmpdir(), 'signal-render-evidence'), 'character');
const BG = '#00FF00'; // the joint check's background: no fixture colour comes near it, so any such pixel at a joint is a gap
const PAPER = '#F4EFE6'; // the goldens' background
const PLACE = { x: 540, y: 1250, scale: 1 };
const BODY = { left: 140, top: 440, width: 800, height: 1260 };
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), browser: process.env.SIGNAL_RENDER_BROWSER ?? null };

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

const spec = (o: Partial<CharacterSpec> = {}): CharacterSpec => ({ charId: RIG_ID, from: 0, to: 60, place: PLACE, poses: [{ pose: 'neutral', at: 0 }], gestures: [], loops: [], ...o });

async function still(name: string, s: CharacterSpec, frame: number, library?: CharacterLibrary, background = PAPER): Promise<string> {
  const out = path.join(EVIDENCE, `${name}.png`);
  const t0 = Date.now();
  await chain.run([{ kind: 'still', composition: 'CharacterTest', props: { rig: rig.rig, sources, spec: s, seed: 1, tempo: null, library, background, width: 1080, height: 1920 }, out, frame, imageFormat: 'png' }], { publicFiles: [], workDir: path.join(EVIDENCE, 'work') });
  report[`ms:${name}`] = Date.now() - t0;
  return out;
}

async function againstGolden(id: string, file: string, crop: typeof BODY): Promise<{ diff: number; written: boolean }> {
  const g = path.join(GOLDEN, `${id}.png`);
  if (!existsSync(g)) {
    if (!UPDATE) throw new Error(`Golden ${id}.png is missing (run once with SIGNAL_RENDER_UPDATE_GOLDENS=1, then have the creative director review it)`);
    const sharp = (await import('sharp')).default;
    await sharp(file).extract(crop).png({ compressionLevel: 9 }).toFile(g);
    report[id] = { written: true };
    return { diff: 0, written: true };
  }
  const diff = diffRatio(await rawOf(file, crop), await rawOf(g));
  report[id] = { diff };
  return { diff, written: false };
}

/** Widest run of background pixels (2k + 1) inside a disc of the frame. */
function backgroundGap(r: Raw, cx: number, cy: number, radius: number): { width: number; count: number } {
  const bg = (x: number, y: number) => {
    const i = (Math.round(y) * r.width + Math.round(x)) * 3;
    return r.data[i + 1]! > 200 && r.data[i]! < 90 && r.data[i + 2]! < 90;
  };
  let width = 0;
  let count = 0;
  const R = Math.floor(radius);
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > radius * radius || !bg(cx + dx, cy + dy)) continue;
      count++;
      let k = 0;
      while (k < 6 && [...Array(2 * k + 3)].every((_, a) => [...Array(2 * k + 3)].every((__, b) => bg(cx + dx + a - k - 1, cy + dy + b - k - 1)))) k++;
      width = Math.max(width, 2 * k + 1);
    }
  return { width, count };
}

describe.runIf(ON)('@render cut-out character (provisional goldens)', () => {
  it('@render goldens: neutral, wave mid-swing (frame 15: +18° on the forearm), viseme M', async () => {
    const neutral = await still('cutout-neutral', spec(), 0);
    expect((await againstGolden('cutout-neutral', neutral, BODY)).diff).toBeLessThanOrEqual(0.005);

    const wave = spec({ gestures: [{ gesture: 'wave', at: 0 }] });
    expect(solveFrame(rig.rig, wave, 15, { seed: 1 }).parts.find((p) => p.name === 'arm_lower_R')!.rot).toBe(18);
    const waveFile = await still('cutout-wave', wave, 15);
    expect((await againstGolden('cutout-wave', waveFile, BODY)).diff).toBeLessThanOrEqual(0.005);

    const align = JSON.parse(readFileSync(path.join(WEB, 'lib/studio/lang/fa/__fixtures__/mock-alignments.json'), 'utf8')).items.find((i: { text: string }) => i.text === 'بیا پیش ما');
    const track = visemeTrack([{ lineId: 'l01', lang: 'fa', text: align.text, alignment: align, startFrame: 4 }], 0, 60);
    const m = track.mOnsets[0]!.frame;
    const talk = spec({ mouth: { from: 0, frames: track.frames } });
    expect(solveFrame(rig.rig, talk, m, { seed: 1 }).mouth).toBe('M');
    const mFile = await still('cutout-viseme-M', talk, m);
    const face = { left: 340, top: 540, width: 400, height: 380 };
    expect((await againstGolden('cutout-viseme-M', mFile, face)).diff).toBeLessThanOrEqual(0.005);
    // the M mouth differs from the rest mouth on the same face
    const rest = await still('cutout-viseme-X', spec({ mouth: { from: 0, frames: ['X'] } }), 0);
    const d = diffRatio(await rawOf(mFile, face), await rawOf(rest, face));
    report['viseme-M-vs-X'] = d;
    expect(d).toBeGreaterThan(0.001);
  }, 600_000);

  for (const view of ['front', 'three-quarter-L'] as ViewId[])
    it(`@render pivot integrity (${view}): every limited joint at its limits shows no background through the joint`, async () => {
      const masks = await rigMasks(rig.dir, rig.rig.parts);
      const joints = jointReports(rig.rig, view, (p) => masks.get(`${p.view}/${p.name}`) ?? []);
      const out: Record<string, unknown> = {};
      for (const end of [0, 1] as const) {
        // a test pose: every limited part at one end of its limits (the solver's clamp keeps it exact)
        const library = coreLibrary();
        const parts: Record<string, { rot: number }> = {};
        for (const p of rig.rig.parts) if (p.view === view && p.limits?.rot) parts[p.name] = { rot: p.limits.rot[end] };
        library.poses.neutral = { parts: { ...library.poses.neutral.parts, ...parts } };
        const s = spec({ view });
        const solved = solveFrame(rig.rig, s, 0, { seed: 1, library });
        const name = `cutout-limits-${view}-${end ? 'hi' : 'lo'}`;
        const raw = await rawOf(await still(name, s, 0, library, BG));
        for (const j of joints) {
          const parent = solved.parts.find((p) => p.name === j.parent)!;
          const child = rig.rig.parts.find((p) => p.view === view && p.name === j.part)!;
          const [cx, cy] = apply(parent.matrix, child.anchor[0], child.anchor[1]);
          const scale = Math.hypot(parent.matrix[0], parent.matrix[1]);
          const g = backgroundGap(raw, cx, cy, Math.max(0, (j.radius - 1) * scale));
          out[`${end ? 'hi' : 'lo'}:${j.part}`] = { at: [Math.round(cx), Math.round(cy)], radius: j.radius, ...g };
          expect(g.width, `${name} ${j.part}`).toBeLessThanOrEqual(1);
        }
      }
      report[`pivot:${view}`] = out;
      writeFileSync(path.join(EVIDENCE, 'character-report.json'), JSON.stringify(report, null, 2));
    }, 600_000);

  it('@render the frame check fails on a broken joint (the forearm hung 90 px down: a 22 px opening below the elbow)', async () => {
    const broken = structuredClone(rig.rig);
    const fore = broken.parts.find((p) => p.view === 'front' && p.name === 'arm_lower_R')!;
    fore.anchor = [fore.anchor[0], fore.anchor[1] + 90];
    const s = spec();
    const library = coreLibrary(); // the arm held out sideways, so the opening is over the background, not the shirt
    library.poses.neutral = { parts: { ...library.poses.neutral.parts, arm_upper_R: { rot: 90 } } };
    const solved = solveFrame(broken, s, 0, { seed: 1, library });
    const out = path.join(EVIDENCE, 'cutout-broken-elbow.png');
    await chain.run([{ kind: 'still', composition: 'CharacterTest', props: { rig: broken, sources, spec: s, seed: 1, tempo: null, library, background: BG, width: 1080, height: 1920 }, out, frame: 0, imageFormat: 'png' }], { publicFiles: [], workDir: path.join(EVIDENCE, 'work') });
    const upper = solved.parts.find((p) => p.name === 'arm_upper_R')!;
    const [cx, cy] = apply(upper.matrix, 36, 221); // inside the opening: the upper arm ends at 210, the forearm starts at 232
    const g = backgroundGap(await rawOf(out), cx, cy, 10);
    report['broken-elbow'] = g;
    expect(g.width).toBeGreaterThan(1);
  }, 600_000);

  it('@render writes the report and copies the goldens into the output folder', () => {
    for (const id of ['cutout-neutral', 'cutout-wave', 'cutout-viseme-M']) if (existsSync(path.join(GOLDEN, `${id}.png`))) copyFileSync(path.join(GOLDEN, `${id}.png`), path.join(EVIDENCE, `${id}.golden.png`));
    report.endedAt = new Date().toISOString();
    writeFileSync(path.join(EVIDENCE, 'character-report.json'), JSON.stringify(report, null, 2));
  });
});
