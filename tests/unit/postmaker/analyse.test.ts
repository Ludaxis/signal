// @vitest-environment node
// analyse: (a synthetic 10 s video with 3 hard cuts, made here with ffmpeg lavfi, yields ≤ 96 frames
// including the 3 cut frames and 1 contact sheet of 1080×1920), the frame plan cap, and the recipe validator (zod
// rejects an out-of-vocabulary technique, overlapping beats and text matching the deny-list). No reference video
// enters the repository: the fixture is generated in a temp folder per run. The network guard stays on; only the
// bundled ffmpeg (and ffprobe when this machine has one) may be spawned.
import child_process from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import sharp from 'sharp';
import ffmpegStatic from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import type { Spawn } from '@/lib/studio/postmaker/connectors/base';
import { analyseReference, assertLocalSource, buildDenyList, denyHit, mockRecipeProposal, planFrames, preprocess, recipeFields, rescaleBeats, validateRecipeProposal, MAX_FRAMES, type AnalyseTools } from '@/lib/studio/postmaker/executors/analyse';
import { runnerCall } from '@/lib/studio/postmaker/executors/agent';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { addReferenceFile } from '@/lib/studio/postmaker/references';
import { analyseDeconstruct } from '@/lib/studio/postmaker/service';
import { tmp } from './guard';

// Captured before the guard is installed (beforeAll), so only these binaries can run.
const realSpawn = child_process.spawn;
const FFMPEG = ffmpegStatic as string;
const FFPROBE = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((p) => existsSync(p)) ?? null;
const allowOnly = (bins: (string | null)[]): Spawn =>
  ((bin: string, args: string[], opts: object) => {
    if (!bins.includes(bin)) throw new Error(`spawn of ${bin} is not allowed here`);
    return realSpawn(bin, args, opts);
  }) as unknown as Spawn;

const tools = (probe = false): AnalyseTools => ({ ffmpeg: FFMPEG, ffprobe: probe ? FFPROBE : null, spawn: allowOnly([FFMPEG, FFPROBE]) });

/** 4 shots of 2.5 s (hard cuts at 2.5, 5.0 and 7.5 s), 360×640 at 30 fps, a tone with a 1 s gap from 4 to 5 s. */
async function fixture(dir: string): Promise<string> {
  const out = path.join(dir, 'synthetic-reference.mp4');
  const colours = ['black', 'white', '0x202020', 'yellow'];
  const args = ['-v', 'error', '-y', ...colours.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:s=360x640:r=30:d=2.5`]), '-f', 'lavfi', '-i', 'sine=f=440:d=10:sample_rate=48000', '-filter_complex', "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];[4:a]volume=enable='between(t,4,5)':volume=0[a]", '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out];
  await new Promise<void>((resolve, reject) => {
    const p = realSpawn(FFMPEG, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
  });
  return out;
}

describe('pre-processing a synthetic 10 s reference with 3 hard cuts', () => {
  it('finds the 3 cuts, keeps ≤ 96 frames including the 3 cut frames, makes 1 sheet of 1080×1920 and reads the audio', async () => {
    const src = await fixture(tmp.dir);
    const work = path.join(tmp.dir, 'work');
    const pre = await preprocess(src, work, { tools: tools() });
    expect(pre.probe).toMatchObject({ durationMs: 10_000, width: 360, height: 640, fps: 30, hasAudio: true, codec: 'h264' });
    expect(pre.cuts).toEqual([2.5, 5, 7.5]);
    expect(pre.frames.length).toBeLessThanOrEqual(96);
    const cutFrames = pre.frames.filter((f) => f.cut).map((f) => f.t);
    expect(cutFrames).toEqual([2.567, 5.067, 7.567]); // cut + 2 frames at 30 fps
    expect(pre.frames.filter((f) => !f.cut).map((f) => f.t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const f of pre.frames) expect(await sharp(f.file).metadata(), f.file).toMatchObject({ width: 270, height: 480, format: 'jpeg' });
    expect(pre.sheets).toHaveLength(1);
    expect(await sharp(pre.sheets[0]!.file).metadata()).toMatchObject({ width: 1080, height: 1920, format: 'jpeg' });
    expect(pre.silences).toHaveLength(1);
    expect(pre.silences[0]![0]).toBeCloseTo(4, 0);
    expect(pre.silences[0]![1]).toBeCloseTo(5, 0);
    expect(pre.loudnessLufs).toBeLessThan(-5);
    expect(await sharp(pre.wav!).metadata().catch(() => null)).toBeNull(); // a WAV, not an image
    expect(pre.timeline).toContain('cuts: 2.50, 5.00, 7.50');
    expect(pre.timeline).toContain('sheet-1.jpg: 0.00, 1.00, 2.00, 2.57');
  }, 60_000);

  it.skipIf(!FFPROBE)('ffprobe, when this machine has one, reads the same probe', async () => {
    const src = await fixture(tmp.dir);
    const pre = await preprocess(src, path.join(tmp.dir, 'w2'), { tools: tools(true) });
    expect(pre.probe).toMatchObject({ durationMs: 10_000, width: 360, height: 640, fps: 30, hasAudio: true, codec: 'h264' });
  }, 60_000);

  it('mock mode: a validated recipe from the cuts alone, rescaled to the requested length; sheets stored as objects', async () => {
    const src = await fixture(tmp.dir);
    const r = await analyseReference({ src, workDir: path.join(tmp.dir, 'w3'), languages: ['fa', 'en'], lengthSec: 30, shape: '9:16', mode: 'mock', call: null, tools: tools(), root: tmp.root });
    // The 10 s reference asked for at 30 s: every boundary × 3; the evidence stays in reference time.
    expect(r.proposal.beats.map((b) => [b.id, b.start, b.end, b.segment])).toEqual([
      ['b01', 0, 7.5, 'hook'],
      ['b02', 7.5, 15, 'story'],
      ['b03', 15, 22.5, 'story'],
      ['b04', 22.5, 30, 'endcard'],
    ]);
    expect(r.evidence.cuts).toEqual([2.5, 5, 7.5]);
    const same = await analyseReference({ src, workDir: path.join(tmp.dir, 'w3b'), languages: ['en'], lengthSec: 10, shape: '9:16', mode: 'mock', call: null, tools: tools() });
    expect(same.proposal.beats.map((b) => [b.start, b.end])).toEqual([[0, 2.5], [2.5, 5], [5, 7.5], [7.5, 10]]);
    expect(r.evidence.sheets).toHaveLength(1);
    expect(r.evidence.sheets[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(recipeFields(r).tempo).toBeNull();
  }, 60_000);

  it('live mode with a fake Runner: the deconstructor gets the sheets and the timeline as vision files, its answer is validated', async () => {
    const src = await fixture(tmp.dir);
    const seen: { prompt: string; files: string[]; agent?: string; kind?: string }[] = [];
    const answer = { ...(mockRecipeProposal(10, [2.5, 5, 7.5], ['en']) as object), detectedText: ['Big Brand Quest is here'] };
    const runner = async (prompt: string, o: { agent?: string; kind?: string; vision?: { files: { name: string }[] } }) => {
      seen.push({ prompt, files: (o.vision?.files ?? []).map((f) => f.name), agent: o.agent, kind: o.kind });
      return { text: '```json\n' + JSON.stringify(answer) + '\n```', seconds: 1, cli: 'fake', costUsd: 0.5, model: 'fake-opus' };
    };
    const r = await analyseReference({ src, workDir: path.join(tmp.dir, 'w4'), languages: ['en'], lengthSec: 30, shape: '9:16', mode: 'live', call: runnerCall(runner as never), tools: tools(), templateBpm: 110 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ files: ['sheet-1.jpg', 'timeline.txt'], agent: 'deconstructor', kind: 'analyse' });
    expect(r.detectedText).toEqual(['Big Brand Quest is here']);
    expect(r.proposal).not.toHaveProperty('detectedText');
    expect(r.proposal.tempo).toEqual({ bpm: 110, downbeatMs: 0 }); // from the template, never detected
    expect(r).toMatchObject({ costUsd: 0.5, model: 'fake-opus' });
  }, 60_000);
});

describe('Analyse through the service on the 10 s fixture asked for 30 s', () => {
  it('the recipe beat times are the reference cuts × 3 within ±1 frame; the evidence stays in reference time', async () => {
    const src = await fixture(tmp.dir);
    const ref = await addReferenceFile(tmp.root, { timeZone: 'Europe/Berlin' }, Readable.toWeb(createReadStream(src)) as ReadableStream<Uint8Array>, { by: 'owner@example.test', rights: 'own' });
    const project = { id: 'example-project', handle: '@example', contentDir: path.join(tmp.dir, 'posts'), timeZone: 'Europe/Berlin' };
    const draft = await analyseDeconstruct({ root: tmp.root, live: false, call: null, tools: tools() })({ reference: ref, options: { languages: ['en'], lengthSec: 30, shape: '9:16' }, project });
    expect(draft.lengthSec).toBe(30);
    const want = [0, 2.5, 5, 7.5, 10].map((x) => x * 3);
    const got = [draft.beats[0]!.start, ...draft.beats.map((b) => b.end)];
    expect(got).toHaveLength(want.length);
    got.forEach((t, i) => expect(Math.abs(t - want[i]!) * 30, `boundary ${i}`).toBeLessThanOrEqual(1));
    expect(draft.beats.at(-1)!.end).toBe(30);
    expect(draft.evidence.cuts).toEqual([2.5, 5, 7.5]);
  }, 60_000);
});

describe('rescaleBeats', () => {
  const beats = [
    { id: 'b01', start: 0, end: 2.5 },
    { id: 'b02', start: 2.5, end: 5.2 },
    { id: 'b03', start: 5.3, end: 7.5 }, // a small gap the validator allows is closed
    { id: 'b04', start: 7.5, end: 10.02 },
  ];
  it('scales every boundary proportionally, contiguous, ms-rounded, ending exactly at the requested length', () => {
    const out = rescaleBeats(beats, 10.02, 15);
    expect(out.map((b) => b.id)).toEqual(['b01', 'b02', 'b03', 'b04']);
    expect(out[0]!.start).toBe(0);
    expect(out.at(-1)!.end).toBe(15);
    for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBe(out[i - 1]!.end);
    expect(out[1]!.end).toBeCloseTo((5.2 * 15) / 10.02, 3);
    expect(out.every((b) => Number.isInteger(Math.round(b.end * 1000)) && b.end > b.start)).toBe(true);
    // shrinking works the same way
    expect(rescaleBeats(beats, 10.02, 5).map((b) => b.end)).toEqual([1.248, 2.595, 3.743, 5]);
  });
  it('keeps pinned beats (ids and order); a pinned id that is missing is refused', () => {
    const out = rescaleBeats(beats, 10.02, 20, ['b03', 'b01']);
    expect(out.map((b) => b.id)).toEqual(['b01', 'b02', 'b03', 'b04']);
    expect(out.findIndex((b) => b.id === 'b03')).toBeGreaterThan(out.findIndex((b) => b.id === 'b01'));
    expect(() => rescaleBeats(beats, 10.02, 20, ['b09'])).toThrow(/pinned beat is missing/);
  });
  it('the same length (within 50 ms) leaves the times alone; a zero length is refused', () => {
    expect(rescaleBeats(beats, 10.02, 10)).toEqual(beats);
    expect(() => rescaleBeats(beats, 10, 0)).toThrow();
  });
  it('never collapses a beat: each lasts at least 1 ms after rounding', () => {
    const tiny = [{ id: 'b01', start: 0, end: 0.0004 }, { id: 'b02', start: 0.0004, end: 0.0008 }, { id: 'b03', start: 0.0008, end: 10 }];
    const out = rescaleBeats(tiny, 10, 15);
    expect(out.every((b) => b.end > b.start)).toBe(true);
    expect(out.at(-1)!.end).toBe(15);
  });
});

describe('frame plan cap', () => {
  it('over 96 frames drops evenly spaced 1 fps frames first and never a cut frame', () => {
    const cuts = Array.from({ length: 40 }, (_, i) => 3.3 + i * 7);
    const plan = planFrames(290, cuts, 30);
    expect(plan.length).toBe(MAX_FRAMES);
    expect(plan.filter((f) => f.cut)).toHaveLength(40);
    expect(plan.map((f) => f.t)).toEqual([...plan.map((f) => f.t)].sort((a, b) => a - b));
  });
  it('only cuts beyond the cap are thinned', () => {
    const plan = planFrames(290, Array.from({ length: 120 }, (_, i) => 1.1 + i * 2.4), 30);
    expect(plan).toHaveLength(96);
    expect(plan.every((f) => f.cut)).toBe(true);
  });
});

const ctx = { durationSec: 10, languages: ['en' as const], cuts: [2.5, 5, 7.5], deny: buildDenyList(['Big Brand Quest is here', 'tap tap tap to win'], ['free gems']), packAssetIds: ['icon-app'], templateBpm: null };
const good = () => JSON.parse(JSON.stringify(mockRecipeProposal(10, [2.5, 5, 7.5], ['en']))) as { beats: Record<string, unknown>[]; assets: unknown[] };
const rejects = (raw: unknown, re: RegExp) => {
  try {
    validateRecipeProposal(raw, ctx);
  } catch (e) {
    expect(isPostmakerError(e, 'invalid-answer'), String(e)).toBe(true);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error('expected a rejection');
};

describe('recipe validation (zod, closed vocabulary, deny-list)', () => {
  it('accepts the mock and snaps a boundary within 0.25 s to the cut', () => {
    const g = good();
    g.beats[0]!.end = 2.4;
    g.beats[1]!.start = 2.4;
    const v = validateRecipeProposal(g, ctx);
    expect(v.beats[0]!.end).toBe(2.5);
    expect(v.beats[1]!.start).toBe(2.5);
  });
  it('rejects an out-of-vocabulary technique and segment, extra keys and bad palettes', () => {
    const g = good();
    g.beats[1]!.techniques = ['dialogue', 'hypnotic-spiral'];
    rejects(g, /techniques/);
    const h = good();
    h.beats[1]!.segment = 'montage';
    rejects(h, /segment/);
    const k = good();
    (k.beats[0] as Record<string, unknown>).run = 'rm -rf /';
    rejects(k, /run|Unrecognized/i);
  });
  it('rejects overlapping, unordered or gapped beats and a recipe that does not cover the reference', () => {
    const o = good();
    o.beats[1]!.start = 1.5;
    rejects(o, /overlap/);
    const u = good();
    u.beats[2]!.id = 'b07';
    rejects(u, /numbered in order/);
    const gap = good();
    gap.beats[2]!.start = 6.2;
    rejects(gap, /without gaps/);
    const short = good();
    short.beats[3]!.end = 8.5;
    rejects(short, /end of the reference/);
  });
  it('rejects on-screen text matching the deny-list (reference text, its names, claims.denied) and text in another language', () => {
    for (const text of ['Big Brand Quest is here!', 'big brand quest is HERE', 'Play Brand now', 'Get free gems', 'tap tap tap to win today']) {
      const g = good();
      g.beats[0]!.onScreenText = { en: text };
      rejects(g, /copies the reference or a denied claim/);
    }
    const ok = good();
    ok.beats[0]!.onScreenText = { en: 'Grandma has a question for you' };
    expect(() => validateRecipeProposal(ok, ctx)).not.toThrow();
    const fa = good();
    fa.beats[0]!.onScreenText = { fa: 'سلام' };
    rejects(fa, /recipe's languages/);
  });
  it('a "have" asset must be a pack asset', () => {
    const g = good();
    g.assets = [{ id: 'gameplay-clip', label: 'Clip', kind: 'video', state: 'have', source: null }];
    rejects(g, /pack asset/);
    g.assets = [{ id: 'icon-app', label: 'Icon', kind: 'image', state: 'have', source: null }];
    expect(() => validateRecipeProposal(g, ctx)).not.toThrow();
  });
  it('denyHit compares Persian through the normaliser (Arabic yeh and kaf variants match)', () => {
    const deny = buildDenyList(['بازی کن']);
    expect(denyHit('بازي كن', deny)).toBe('بازی کن');
    expect(denyHit('یه چیز دیگه', deny)).toBeNull();
  });
});

describe('mock recipe at the 24-beat limit (one-click offline)', () => {
  // Cuts every 0.9 s from 0.9 s, so all of them pass the 0.5 s edge margin of a reference that ends just after the last.
  for (const interior of [22, 23, 24, 30]) {
    it(`${interior} interior cuts: the mock covers the whole reference and passes validation`, () => {
      const cuts = Array.from({ length: interior }, (_, i) => Math.round((i + 1) * 0.9 * 1000) / 1000);
      const durationSec = Math.round((cuts.at(-1)! + 1) * 1000) / 1000;
      const raw = mockRecipeProposal(durationSec, cuts, ['en']) as { beats: { start: number; end: number }[] };
      expect(raw.beats.length).toBe(Math.min(interior + 1, 24));
      expect(raw.beats.at(-1)!.end).toBe(durationSec);
      const v = validateRecipeProposal(raw, { durationSec, languages: ['en'], cuts, deny: buildDenyList([]), packAssetIds: [], templateBpm: null });
      expect(v.beats.at(-1)!.end).toBe(durationSec);
    });
  }
});

describe('the reference is a local file (ffmpeg and ffprobe open URLs)', () => {
  it('refuses scheme-prefixed and relative sources before any process starts', async () => {
    const spawned: string[] = [];
    const t: AnalyseTools = { ffmpeg: FFMPEG, ffprobe: FFPROBE, spawn: ((bin: string) => { spawned.push(bin); throw new Error('no spawn here'); }) as unknown as Spawn };
    for (const src of ['https://example.invalid/clip.mp4', 'file:///tmp/clip.mp4', 'pipe:0', 'concat:/a.mp4|/b.mp4', 'rtmp://example.invalid/live', 'clip.mp4', '../clip.mp4', '']) {
      expect(() => assertLocalSource(src), src).toThrow(/a file on this computer/);
      await expect(preprocess(src, '/nonexistent-work-dir', { tools: t })).rejects.toThrow(/a file on this computer/);
    }
    expect(spawned).toEqual([]);
    expect(() => assertLocalSource('/home/someone/Movies/reference clip.mp4')).not.toThrow();
  });
});
