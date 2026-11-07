// @vitest-environment node
// The @render suite: real Remotion renders through the render child and Chrome Headless
// Shell. Skipped unless SIGNAL_RENDER=1 (CI never starts Chrome). It does not install the network guard because it
// starts local processes (node, Chrome, ffmpeg); it makes no network call. Run it locally:
//
//   SIGNAL_RENDER=1 SIGNAL_RENDER_BROWSER=<chrome-headless-shell> SIGNAL_RENDER_EVIDENCE=<dir> \
//     npx vitest run tests/unit/postmaker/render/render-golden.test.ts
//
// SIGNAL_RENDER_BROWSER names the program file inside the Chrome Headless Shell folder, e.g.
// .../chrome-headless-shell-mac-arm64/chrome-headless-shell; a folder is refused before the render child starts.
//
// Goldens live in tests/postmaker/golden/ and are provisional until a native reader signs. With
// SIGNAL_RENDER_UPDATE_GOLDENS=1 a missing golden is written (and the test says so) instead of compared.
//
// Faces: the English goldens (en-caption) render with the core Latin face, Instrument Sans 700 (
// a single-weight Latin subset), and were re-baselined for it on 2026-11-07; they stay provisional like every golden
// here. The Persian goldens keep the fixture pack's own Latin face ([Pack example] Inter 800, the {Brand} token in
// fa-caption), exactly as a pack Latin face wins over the core one (resolveFonts), so their bytes are unchanged.
// Covers quality (fa caption ≤ 0.5 % diff, per-character split fails), 5 (ZWJ prefixes, connecting
// form, coverage), timings (stats.json), the render log with font hashes. The
// typography goldens are stills of the slice's own timeline at the same frames with `mock: false`, so the MOCK layer
// never covers the words a native reader must judge; the MOCK check itself runs on every frame of the mock videos.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPipeline } from '@/lib/studio/postmaker/graph/build';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import { PostmakerEngine } from '@/lib/studio/postmaker/runner';
import { getBytes, getJson } from '@/lib/studio/postmaker/store/objects';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { createRecipe, writePipelineVersion } from '@/lib/studio/postmaker/store/recipes';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import { coreFonts, fontLog, resolveFonts, zwjCoverage, type FontFile } from '@/lib/studio/postmaker/render/fonts';
import { layoutTimeline } from '@/lib/studio/postmaker/render/layout';
import { makeChildRenderChain, type RenderChain } from '@/lib/studio/postmaker/render/renderer';
import type { Timeline } from '@/lib/studio/postmaker/render/timeline';
import { ZWJ, zwjPrefixes } from '@/lib/studio/postmaker/render/zwj';
import { MOCK_COLOUR, MOCK_PROBE } from '@/lib/studio/postmaker/render/mockLayer';
import { parseEbur128, ebur128Args } from '@/lib/studio/postmaker/render/loudness';
import { fontPublicFiles, timelineFonts } from '@/lib/studio/postmaker/executors/render-chain';
import { colourShare, diffRatio, rawOf, ssim, type Raw } from './image-compare';
import { SLICE_VOICE_MS, sliceParams, sliceRecipe } from './slice-fixture';

const ON = process.env.SIGNAL_RENDER === '1';
const WEB = path.resolve(__dirname, '../../../..');
const GOLDEN = path.join(WEB, 'tests/postmaker/golden');
const UPDATE = process.env.SIGNAL_RENDER_UPDATE_GOLDENS === '1';
const EVIDENCE = process.env.SIGNAL_RENDER_EVIDENCE || path.join(os.tmpdir(), 'signal-render-evidence');
const FFMPEG = process.env.SIGNAL_FFMPEG || (ffmpegStatic as unknown as string);
const MOCK_RGB = MOCK_COLOUR;
const stats: Record<string, unknown> = { startedAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, node: process.version } };
const golden: Record<string, unknown> = {};

let work = '';
let chain: RenderChain;
let fonts: FontFile[];
/** Per fixture language: fa with the fixture pack's Latin face (as a pack supplies it), en with the core faces only. */
let faceSet: Record<'fa' | 'en', FontFile[]>;
/** A Latin face for Latin runs ([Pack example]: the OFL Inter files installed with the render workspace). */
let latin: FontFile | null = null;

function latinFace(): FontFile | null {
  const file = path.resolve(WEB, '../../services/render/node_modules/@fontsource/inter/files/inter-latin-800-normal.woff2');
  if (!existsSync(file)) return null;
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  return { family: 'Inter', role: 'latin', src: 'fonts/inter/inter-latin-800-normal.woff2', sha256, weights: '800', file };
}

beforeAll(() => {
  if (!ON) return;
  work = path.join(EVIDENCE, 'work');
  mkdirSync(work, { recursive: true });
  mkdirSync(GOLDEN, { recursive: true });
  latin = latinFace();
  fonts = [...coreFonts(), ...(latin ? [latin] : [])];
  faceSet = { fa: resolveFonts(latin ? [latin] : []).fonts, en: resolveFonts().fonts };
  chain = makeChildRenderChain({ browserExecutable: process.env.SIGNAL_RENDER_BROWSER || null, cacheDir: path.join(EVIDENCE, 'cache') });
  stats.browser = process.env.SIGNAL_RENDER_BROWSER ? { source: 'SIGNAL_RENDER_BROWSER', path: process.env.SIGNAL_RENDER_BROWSER } : { source: 'remotion browser ensure (services/render/node_modules/.remotion)' };
});

afterAll(() => {
  if (!ON) return;
  stats.endedAt = new Date().toISOString();
  writeFileSync(path.join(EVIDENCE, 'stats.json'), JSON.stringify(stats, null, 2));
  writeFileSync(path.join(EVIDENCE, 'golden-report.json'), JSON.stringify(golden, null, 2));
});

// ---- fixture timelines for the goldens -----------------------------------------------------------------------------

const SAMPLE_FA = ['۵', 'تا', 'حرف', 'بهم', 'داد؛', 'گفت', 'یه', 'کلمه', 'با', 'Harfino', 'بساز.']; // quality, {Brand} = the fixture pack's Latin token
const SAMPLE_EN = ['5', 'letters', 'in', 'my', 'hand,', 'make', 'a', 'word', 'with', 'Harfino.'];

function captionTimeline(lang: 'fa' | 'en', words: string[], o: { msPerWord?: number } = {}): Timeline {
  const step = o.msPerWord ?? 100;
  return layoutTimeline({
    lang,
    beats: [{ id: 'b01', segment: 'story', techniques: [], from: 0, to: 90 }],
    pages: [
      {
        lineId: 'l01',
        beatId: 'b01',
        text: words.join(' '),
        beatOffsetMs: 0,
        durationMs: 2000,
        words: words.map((text, k) => ({ text, latin: /[A-Za-z]/.test(text) && !/[؀-ۿ]/.test(text), beatOffsetMs: k * step })),
      },
    ],
    tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 },
    brand: null,
    endcard: { tagline: '', sub: null, cta: '', iconText: '' },
    aiLabel: lang === 'fa' ? 'ساخته‌شده با هوش مصنوعی' : 'Made with AI',
    fonts: timelineFonts(faceSet[lang]),
    mock: false,
    seed: 1,
  });
}

function revealTimeline(): Timeline {
  return layoutTimeline({
    lang: 'fa',
    beats: [
      { id: 'b01', segment: 'reveal', techniques: [], from: 0, to: 90 },
      { id: 'b02', segment: 'chant', techniques: [], from: 90, to: 162 },
    ],
    pages: [],
    tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 },
    brand: { text: 'حرفینو', latin: false },
    endcard: { tagline: '', sub: null, cta: '', iconText: '' },
    aiLabel: 'ساخته‌شده با هوش مصنوعی',
    fonts: timelineFonts(faceSet.fa),
    mock: false,
    seed: 1,
  });
}

async function stills(name: string, t: Timeline, frames: number[], extra: Record<string, unknown> = {}): Promise<string[]> {
  const dir = path.join(work, name);
  const tasks = frames.map((frame) => ({ kind: 'still' as const, composition: 'StorySpine' as const, props: { timeline: t, master: null, ...extra }, out: path.join(dir, `${name}-${frame}.png`), frame, imageFormat: 'png' as const }));
  const s = Date.now();
  await chain.run(tasks, { publicFiles: fontPublicFiles(fonts), workDir: dir });
  (stats.stills as Record<string, number>) = { ...((stats.stills as Record<string, number>) ?? {}), [name]: Date.now() - s };
  return tasks.map((x) => x.out);
}

/** Compare a crop with its golden (writes the golden when missing and updating). */
async function againstGolden(id: string, file: string, crop: { left: number; top: number; width: number; height: number }): Promise<{ diff: number; ssim: number; written: boolean; raw: Raw }> {
  const g = path.join(GOLDEN, `${id}.png`);
  const raw = await rawOf(file, crop);
  if (!existsSync(g)) {
    if (!UPDATE) throw new Error(`Golden ${id}.png is missing (run with SIGNAL_RENDER_UPDATE_GOLDENS=1 once, then have a native reader review it)`);
    const sharp = (await import('sharp')).default;
    await sharp(file).extract(crop).png({ compressionLevel: 9 }).toFile(g);
    golden[id] = { written: true, file: path.relative(WEB, g) };
    return { diff: 0, ssim: 1, written: true, raw };
  }
  const ref = await rawOf(g);
  const r = { diff: diffRatio(raw, ref), ssim: ssim(raw, ref), written: false, raw };
  golden[id] = { diff: r.diff, ssim: r.ssim, file: path.relative(WEB, g) };
  copyFileSync(file, path.join(EVIDENCE, `${id}.render.png`));
  return r;
}

const CAPTION_BAND = { left: 40, top: 330, width: 1000, height: 500 };

describe.runIf(ON)('@render golden frames (provisional until a native reader signs)', () => {
  it('@render fa-caption: matches within 0.5 % pixel diff; the per-character split variant fails the diff', async () => {
    const t = captionTimeline('fa', SAMPLE_FA);
    const landed = Math.max(...t.elements.flatMap((e) => (e.kind === 'caption' ? e.lines.flat().map((x) => x.enter + 9) : [])));
    const [file] = await stills('fa-caption', t, [landed]);
    const r = await againstGolden('fa-caption', file!, CAPTION_BAND);
    expect(r.diff).toBeLessThanOrEqual(0.005);
    const [split] = await stills('fa-caption-split', t, [landed], { splitChars: true });
    const s = diffRatio(await rawOf(split!, CAPTION_BAND), await rawOf(path.join(GOLDEN, 'fa-caption.png')));
    golden['fa-caption-split'] = { diff: s, mustFail: true };
    copyFileSync(split!, path.join(EVIDENCE, 'fa-caption-split.render.png'));
    expect(s).toBeGreaterThan(0.005);
  }, 300_000);

  it('@render en-caption matches its golden', async () => {
    const t = captionTimeline('en', SAMPLE_EN);
    const landed = Math.max(...t.elements.flatMap((e) => (e.kind === 'caption' ? e.lines.flat().map((x) => x.enter + 9) : [])));
    const [file] = await stills('en-caption', t, [landed]);
    expect((await againstGolden('en-caption', file!, CAPTION_BAND)).diff).toBeLessThanOrEqual(0.005);
  }, 300_000);

  it('@render RTL entry order: the first Persian token appears at the right of the line', async () => {
    const t = captionTimeline('fa', SAMPLE_FA.slice(0, 4), { msPerWord: 500 });
    const toks = t.elements.flatMap((e) => (e.kind === 'caption' ? e.lines.flat() : []));
    expect(toks[1]!.enter).toBeGreaterThan(toks[0]!.enter + 9);
    const [file] = await stills('fa-order', t, [toks[0]!.enter + 9]); // token 0 has landed; token 1 is not on screen yet
    const r = await rawOf(file!, CAPTION_BAND);
    // columns where dark text pixels sit
    let minX = Infinity;
    let maxX = -Infinity;
    for (let y = 0; y < r.height; y++)
      for (let x = 0; x < r.width; x++) {
        const o = (y * r.width + x) * 3;
        if (r.data[o]! < 80 && r.data[o + 1]! < 80 && r.data[o + 2]! < 80) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    golden['fa-order'] = { firstTokenInk: [minX + CAPTION_BAND.left, maxX + CAPTION_BAND.left] };
    expect(minX + CAPTION_BAND.left).toBeGreaterThan(540); // ink only in the right half: token 0 is rightmost
  }, 300_000);

  it('@render fa-zwj-reveal: 6 prefix frames; steps ending in a dual-joining letter keep the connecting form; ZWJ covered', async () => {
    const t = revealTimeline();
    const reveal = t.elements.find((e) => e.kind === 'reveal')!;
    expect(reveal.kind === 'reveal' && reveal.steps).toHaveLength(6);
    const frames = reveal.kind === 'reveal' ? reveal.steps.map((s) => s.at + 4) : [];
    const files = await stills('fa-zwj-reveal', t, frames);
    const crop = { left: 140, top: 760, width: 800, height: 400 };
    // the 6 crops stacked are the golden
    const sharp = (await import('sharp')).default;
    const strip = path.join(work, 'fa-zwj-reveal-strip.png');
    await sharp({ create: { width: crop.width, height: crop.height * 6, channels: 3, background: '#000' } })
      .composite(await Promise.all(files.map(async (f, k) => ({ input: await sharp(f).extract(crop).png().toBuffer(), top: k * crop.height, left: 0 }))))
      .png()
      .toFile(strip);
    const r = await againstGolden('fa-zwj-reveal', strip, { left: 0, top: 0, width: crop.width, height: crop.height * 6 });
    expect(r.diff).toBeLessThanOrEqual(0.005);
    // connecting form: each prefix with ZWJ differs from the same prefix without it when its last letter joins left
    const plain = zwjPrefixes('حرفینو').map((p) => p.replace(ZWJ, ''));
    const noZwj = { ...t, elements: t.elements.map((e) => (e.kind === 'reveal' ? { ...e, steps: e.steps.map((s, k) => ({ ...s, text: plain[k]! })) } : e)) };
    const bare = await stills('fa-zwj-reveal-bare', noZwj, frames);
    const differs = await Promise.all(files.slice(0, 5).map(async (f, k) => diffRatio(await rawOf(f, crop), await rawOf(bare[k]!, crop), 48)));
    golden['fa-zwj-connecting'] = { stepDiffVsNoZwj: differs, rightJoiningOnly: ['step 2 (ر)'] };
    for (const k of [0, 2, 3, 4]) expect(differs[k], `step ${k + 1}`).toBeGreaterThan(0.0005);
    // ZWJ coverage is a Persian-face gate (quality); the core Latin face is a Latin subset without U+200D.
    for (const f of coreFonts().filter((x) => x.role !== 'latin')) expect(zwjCoverage(f).zwj, f.family).toBe(true);
  }, 300_000);

  it('@render chant-card matches its golden', async () => {
    const t = revealTimeline();
    const card = t.elements.find((e) => e.kind === 'card')!;
    const [file] = await stills('chant-card', t, [card.from + 12]);
    expect((await againstGolden('chant-card', file!, { left: 0, top: 560, width: 1080, height: 800 })).diff).toBeLessThanOrEqual(0.005);
  }, 300_000);
});

// ---- the slice: two 30 s mock renders through the engine ------------------------------

function ffmpeg(args: string[]): string {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.stderr;
}

function probe(file: string) {
  const err = ffmpeg(['-hide_banner', '-i', file]);
  const v = /Video: (\w+)[^,]*, (\w+)[^,]*,[^\n]*?(\d+)x(\d+)[^\n]*?([\d.]+) fps/.exec(err);
  const a = /Audio: (\w+)[^,]*, (\d+) Hz/.exec(err);
  const frames = [...ffmpeg(['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']).matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1];
  return { codec: v?.[1], pixelFormat: v?.[2], width: Number(v?.[3]), height: Number(v?.[4]), fps: Number(v?.[5]), audioCodec: a?.[1], sampleRate: Number(a?.[2]), frames: Number(frames) };
}

/** Every frame at 1/5 scale as raw RGB. */
function framesOf(file: string): Raw[] {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=216:384', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 * 1024 * 1024 });
  const size = 216 * 384 * 3;
  const out: Raw[] = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) out.push({ data: r.stdout.subarray(o, o + size), width: 216, height: 384 });
  return out;
}

describe.runIf(ON)('@render slice (two 30 s mock renders)', () => {
  it('@render: renders fa and en, 900 frames, loudness, goldens, MOCK and AI label', async () => {
    const root = path.join(EVIDENCE, 'store');
    const now = { t: Date.parse('2026-11-06T10:00:00.000Z') };
    const { recipe } = await createRecipe(root, { id: 'example-project', timeZone: 'Asia/Tehran' }, sliceRecipe(), { now: now.t, id: 'rc-20261106-0901' });
    const built = buildPipeline(recipe, { faces: [] });
    await writePipelineVersion(root, recipe.id, { ...built, nodes: sliceParams(built.nodes) }, { now: now.t });
    const fakes = { counters: newCounters(), voiceMs: (lineId: string) => SLICE_VOICE_MS[lineId] };
    const engine = new PostmakerEngine({
      root,
      project: { id: 'example-project', timeZone: 'Asia/Tehran' } as never,
      executors: defaultExecutors({ fakes, render: { chain, ffmpeg: { bin: FFMPEG }, readObject: (sha) => getBytes(root, sha), fonts: () => fonts, workDir: (r, n) => path.join(work, 'slice', n.replace(/:/g, '-')) } }),
      packLock: null,
      now: () => (now.t += 1000),
    });
    const t0 = Date.now();
    const { estimate } = await engine.estimate(recipe.id, { all: true });
    const run = await (await engine.run({ recipeId: recipe.id, scope: { all: true }, estimateToken: estimate.token })).done;
    const wallMs = Date.now() - t0;
    stats.slice = { wallMs, runStatus: run.status, steps: run.steps.map((s) => ({ nodeId: s.nodeId, status: s.status, mode: s.mode, seconds: s.seconds })) };
    expect(run.status).toBe('done');

    const out: Record<string, unknown> = {};
    for (const lang of ['fa', 'en'] as const) {
      const v = async (nodeId: string) => (await readVersion(root, recipe.id, nodeId, (await readHead(root, recipe.id, nodeId)).current!))!;
      const rv = await v(`render:${lang}`);
      const video = path.join(EVIDENCE, `video.${lang}.mp4`);
      writeFileSync(video, await getBytes(root, rv.outputs.find((o) => o.port === 'video')!.sha256));
      writeFileSync(path.join(EVIDENCE, `cover.${lang}.png`), await getBytes(root, rv.outputs.find((o) => o.port === 'cover')!.sha256));
      const log = await getJson<{ fonts: string[]; timings: unknown; frames: unknown }>(root, rv.outputs.find((o) => o.port === 'log')!.sha256);
      writeFileSync(path.join(EVIDENCE, `render-log.${lang}.json`), JSON.stringify(log, null, 2));
      const mv = await v(`mix:${lang}`);
      const loud = mv.outputs.find((o) => o.port === 'loudness');
      const masterLoudness = loud ? await getJson(root, loud.sha256) : null;
      const videoLoudness = parseEbur128(ffmpeg(ebur128Args(video)));
      writeFileSync(path.join(EVIDENCE, `loudness.${lang}.json`), JSON.stringify({ master: masterLoudness, video: videoLoudness, measuredWith: 'ffmpeg ebur128=peak=true' }, null, 2));
      const cv = await v(`compose:${lang}`);
      const timeline = await getJson<Timeline>(root, cv.outputs.find((o) => o.port === 'timeline')!.sha256);
      writeFileSync(path.join(EVIDENCE, `timeline.${lang}.json`), JSON.stringify(timeline, null, 2));
      writeFileSync(path.join(EVIDENCE, `checks.${lang}.json`), JSON.stringify({ compose: cv.checks, mix: mv.checks, render: rv.checks }, null, 2));

      //
      const p = probe(video);
      out[lang] = { probe: p, loudness: videoLoudness, renderTimings: log.timings };
      expect(p).toMatchObject({ codec: 'h264', pixelFormat: 'yuv420p', width: 1080, height: 1920, audioCodec: 'aac', sampleRate: 48000 });
      expect(p.fps).toBe(30);
      expect(Math.abs(p.frames - 900)).toBeLessThanOrEqual(1);
      expect(Math.abs(videoLoudness.integratedLufs - -14)).toBeLessThanOrEqual(1);
      expect(videoLoudness.truePeakDbtp).toBeLessThanOrEqual(-1.0);
      for (const f of fonts) expect(log.fonts).toContain(fontLog([f])[0]);

      // MOCK on every frame (probe region), AI label on the first and last frames
      const all = framesOf(video);
      expect(all.length).toBeGreaterThanOrEqual(899);
      // MOCK_PROBE (the solid band in the bottom reserve, clear of its letters) at 1/5 scale, rows fully inside it
      const probeBox = { x: MOCK_PROBE.x / 5, y: Math.ceil(MOCK_PROBE.y / 5), width: MOCK_PROBE.width / 5, height: Math.floor(MOCK_PROBE.height / 5) - 1 };
      // tolerance 30: tight enough that a full-frame card in a near colour (#E4572E) never passes for the band
      const shares = all.map((fr) => colourShare(fr, probeBox, MOCK_RGB, 30));
      const minShare = Math.min(...shares);
      (out[lang] as Record<string, unknown>).mockShareMin = minShare;
      expect(minShare).toBeGreaterThan(0.9);
      const label = { x: 22, y: 56, width: 20, height: 6 }; // AI pill near (108, 280) at 1/5 scale
      for (const k of [0, all.length - 1]) expect(colourShare(all[k]!, label, { r: 22, g: 22, b: 29 }, 40), `AI label frame ${k}`).toBeGreaterThan(0.3);
      for (const k of [0, Math.floor(all.length / 2), all.length - 1]) {
        const fr = path.join(EVIDENCE, `frame-${lang}-${k}.png`);
        spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${k})`, '-vframes', '1', fr]);
      }

      // (fa): golden frames at the hook word-pop, a chant card and the reveal (SSIM ≥ 0.98). Taken as stills of
      // this timeline at the same frames with `mock: false` (the typography under review, not the MOCK layer); the
      // video's own frame at each point is kept as evidence next to it.
      if (lang === 'fa') {
        const hook = timeline.elements.find((e) => e.kind === 'caption')!;
        const card = timeline.elements.find((e) => e.kind === 'card')!;
        const reveal = timeline.elements.find((e) => e.kind === 'reveal')!;
        const at: Record<string, [number, { left: number; top: number; width: number; height: number }]> = {
          'sl03-hook': [hook.from + 12, CAPTION_BAND],
          'sl03-chant': [card.from + 12, { left: 0, top: 560, width: 1080, height: 800 }],
          'sl03-reveal': [reveal.kind === 'reveal' ? reveal.punchAt + 8 : reveal.from + 40, { left: 140, top: 760, width: 800, height: 400 }],
        };
        const clean: Timeline = { ...timeline, mock: false };
        for (const [id, [frame, crop]] of Object.entries(at)) {
          const fr = path.join(EVIDENCE, `${id}-video-frame-${frame}.png`);
          spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${frame})`, '-vframes', '1', fr]);
          const [still] = await stills(id, clean, [frame]);
          const full = await rawOf(still!);
          expect(colourShare(full, MOCK_PROBE, MOCK_RGB, 30), `${id} still has no MOCK layer`).toBeLessThan(0.05);
          const r = await againstGolden(id, still!, crop);
          golden[id] = { ...(golden[id] as object), frame, source: 'non-mock still of the slice timeline' };
          expect(r.ssim, id).toBeGreaterThanOrEqual(0.98);
        }
      }
    }
    stats.renders = out;
  }, 1_800_000);
});
