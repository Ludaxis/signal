// @vitest-environment node
// The slice run on this computer: the same service path as the CI slice
// test, with real Remotion renders through the render child and Chrome Headless Shell, the real ffmpeg mix and
// loudness, and the pack's own Latin face. Skipped unless SIGNAL_SLICE=1. Run it in a hermetic environment
// (temporary secrets, data and config files; no vendor key; every connector off).
// It writes the output folder (SIGNAL_SLICE_OUT): the two renders, loudness.json, frame grabs, stats.json, the
// run record and report.md, marked as an automated run when no person runs it.
// The network guard blocks fetch and every socket in this process (its log is written and must be empty); child
// processes (the render child, Chrome, ffmpeg) are local and allowed here.
import child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Spawn } from '@/lib/studio/postmaker/connectors/base';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import { resolveFonts, type FontFile } from '@/lib/studio/postmaker/render/fonts';
import { ebur128Args, parseEbur128 } from '@/lib/studio/postmaker/render/loudness';
import { MOCK_COLOUR, MOCK_PROBE } from '@/lib/studio/postmaker/render/mockLayer';
import { makeChildRenderChain } from '@/lib/studio/postmaker/render/renderer';
import type { Timeline } from '@/lib/studio/postmaker/render/timeline';
import { _setServiceDeps, engineFor, handleAction, rootOf } from '@/lib/studio/postmaker/service';
import { getBytes, getJson } from '@/lib/studio/postmaker/store/objects';
import { readEvents } from '@/lib/studio/postmaker/store/runs';
import type { Lang, Run, StepVersion } from '@/lib/studio/postmaker/types';
import { installNetworkGuard, networkGuardLog, removeNetworkGuard } from '../../../setup/network-guard';
import { colourShare, rawOf, type Raw } from './image-compare';
import { fixtureBuilders, SLICE_NODES, sliceExecutors, sliceFixture, sliceProject, sliceVoice, templateDeconstruct, uploadReference, waitForRun } from '../slice-harness';
import { reportMarkdown, type SliceReport } from './slice-report';

const ON = process.env.SIGNAL_SLICE === '1';
const OUT = process.env.SIGNAL_SLICE_OUT || path.join(os.tmpdir(), 'signal-slice-evidence');
const WORK = process.env.SIGNAL_SLICE_WORK || path.join(os.tmpdir(), 'signal-slice-work');
const FFMPEG = process.env.SIGNAL_FFMPEG || (ffmpegStatic as unknown as string);
const LANGS = (process.env.SIGNAL_SLICE_LANGS || 'fa,en').split(',').filter((l): l is Lang => l === 'fa' || l === 'en');
const realSpawn = child_process.spawn;
const ffmpegOnly = ((bin: string, args: string[], opts: object) => {
  if (bin !== FFMPEG) throw new Error(`spawn of ${bin} is not allowed here`);
  return realSpawn(bin, args, opts);
}) as unknown as Spawn;

const t = (since: number) => Date.now() - since;
/** Output files name no folder of this machine: the work folder, the output folder and the home folder are replaced. */
const scrub = (text: string) => [[WORK, '<work>'], [OUT, '<evidence>'], [os.homedir(), '~']].reduce((s, [from, to]) => (from ? s.split(from!).join(to!) : s), text);
const writeEvidence = (file: string, data: unknown) => writeFileSync(path.join(OUT, file), scrub(typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const report: SliceReport = {
  marking: process.env.SIGNAL_SLICE_MARKING || 'automated run, not checked by a person',
  date: new Date().toISOString(),
  command: process.env.SIGNAL_SLICE_COMMAND || 'SIGNAL_SLICE=1 npx vitest run tests/unit/postmaker/render/slice-run.test.ts',
  host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null, memoryGb: Math.round(os.totalmem() / 2 ** 30), node: process.version },
  browser: process.env.SIGNAL_RENDER_BROWSER ? path.basename(path.dirname(path.dirname(process.env.SIGNAL_RENDER_BROWSER))) + '/' + path.basename(process.env.SIGNAL_RENDER_BROWSER) : null,
  langs: LANGS,
  timings: {},
  run: null,
  renders: {},
  frames: [],
  networkGuard: [],
  results: {},
  notes: [],
};

function ffmpeg(args: string[]): string {
  return child_process.spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stderr;
}

function probe(file: string) {
  const err = ffmpeg(['-hide_banner', '-i', file]);
  const v = /Video: (\w+)[^,]*, (\w+)[^,]*,[^\n]*?(\d+)x(\d+)[^\n]*?([\d.]+) fps/.exec(err);
  const a = /Audio: (\w+)[^,]*, (\d+) Hz/.exec(err);
  const frames = [...ffmpeg(['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']).matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1];
  return { codec: v?.[1] ?? null, pixelFormat: v?.[2] ?? null, width: Number(v?.[3]), height: Number(v?.[4]), fps: Number(v?.[5]), audioCodec: a?.[1] ?? null, sampleRate: Number(a?.[2]), frames: Number(frames) };
}

function framesOf(file: string): Raw[] {
  const r = child_process.spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=216:384', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1024 * 1024 * 1024 });
  const size = 216 * 384 * 3;
  const out: Raw[] = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) out.push({ data: r.stdout.subarray(o, o + size), width: 216, height: 384 });
  return out;
}

function grab(video: string, frame: number, out: string): string {
  child_process.spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${frame})`, '-vframes', '1', out]);
  return out;
}

/** The pack's Latin face (Instrument Sans 700) as a render font, so Latin runs use the pack's own OFL face. */
function packLatin(packDir: string): FontFile {
  const file = path.join(packDir, 'library/fonts/InstrumentSans/instrument-sans-latin-700-normal.woff2');
  return { family: 'Instrument Sans', role: 'latin', src: 'fonts/pack/instrument-sans-latin-700-normal.woff2', sha256: sha(readFileSync(file)), weights: '700', file };
}

beforeAll(() => {
  if (!ON) return;
  installNetworkGuard({ processes: false });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(WORK, { recursive: true });
});

afterAll(() => {
  if (!ON) return;
  report.networkGuard = [...networkGuardLog()];
  removeNetworkGuard();
  report.timings.endedAt = new Date().toISOString();
  writeEvidence('network-guard.json', { blocked: report.networkGuard, note: 'fetch, http, https, net and tls are blocked in the test process; local child processes (render child, Chrome Headless Shell, ffmpeg) are allowed' });
  writeEvidence('stats.json', { marking: report.marking, date: report.date, host: report.host, browser: report.browser, timings: report.timings, steps: report.run?.steps ?? [], renders: Object.fromEntries(Object.entries(report.renders).map(([k, v]) => [k, { renderTimings: v.renderTimings, bytes: v.bytes }])) });
  writeEvidence('report.md', reportMarkdown(report));
});

describe.runIf(ON)('@render the slice on this computer', () => {
  it('@render make-it to Proof with two real 30 s renders (frames)', async () => {
    const t0 = Date.now();
    const { buildPack, makeRef } = await fixtureBuilders();
    const packDir = (await buildPack(path.join(WORK, 'pack'))).dir;
    report.timings.packMs = t(t0);
    const t1 = Date.now();
    const refFile = process.env.SIGNAL_SLICE_REF && existsSync(process.env.SIGNAL_SLICE_REF) ? process.env.SIGNAL_SLICE_REF : await makeRef({ out: path.join(WORK, 'ref-9x16-10s.mp4'), ffmpeg: FFMPEG, spawn: ffmpegOnly });
    report.timings.referenceMs = t(t1);

    const project = sliceProject(path.join(WORK, 'project'), packDir);
    const root = rootOf(project);
    const fixture = sliceFixture();
    const voice = sliceVoice(fixture);
    // The pack's Latin face takes the core one's place (resolveFonts): one face per role in the render log.
    const fonts = resolveFonts([packLatin(packDir)]).fonts;
    const chain = makeChildRenderChain({ browserExecutable: process.env.SIGNAL_RENDER_BROWSER || null, cacheDir: path.join(WORK, 'cache') });
    _setServiceDeps({
      executors: sliceExecutors({ root, render: chain, fakes: { counters: newCounters(), voiceMs: voice.fn }, renderDeps: { ffmpeg: { bin: FFMPEG }, fonts: () => fonts, workDir: (r, n) => path.join(WORK, 'render', r, n.replace(/:/g, '-')) } }),
      deconstruct: templateDeconstruct({ root, tools: { ffmpeg: FFMPEG, ffprobe: null, spawn: ffmpegOnly }, workDir: path.join(WORK, 'analyse'), fixture }),
    });
    const ref = await uploadReference(root, project, refFile);
    const t2 = Date.now();
    const started = await handleAction(project, { email: 'slice@example.test' }, { action: 'make-it', referenceId: ref.id, options: { languages: LANGS, lengthSec: 30, shape: '9:16' } });
    const { runId, recipeId } = started.body as { runId: string; recipeId: string };
    const run: Run = await waitForRun(root, runId, { timeoutMs: 30 * 60_000 });
    report.timings.makeItToProofMs = t(t2);
    report.timings.totalMs = t(t0);
    _setServiceDeps({});
    report.run = { id: run.id, status: run.status, pausedFor: run.pausedFor, spentUsd: run.spentUsd, steps: run.steps.map((s) => ({ nodeId: s.nodeId, status: s.status, mode: s.mode, seconds: s.seconds })) };
    writeEvidence('run.json', report.run);
    writeEvidence('events.json', (await readEvents(root, run.id)).events);
    expect(run.status, `${run.status}/${run.pausedFor}`).toBe('needs-you');
    expect(run.pausedFor).toBe('check');
    expect(run.steps.map((s) => s.nodeId).sort()).toEqual(SLICE_NODES.filter((n) => !n.includes(':') || LANGS.some((l) => n.endsWith(`:${l}`))).sort());
    expect(run.steps.every((s) => s.status === 'done' && s.mode === 'mock')).toBe(true);
    expect(run.spentUsd).toBe(0);

    const { engine } = await engineFor(project);
    const state = await engine.state(recipeId);
    const current = (id: string) => state.current[id] as StepVersion;
    const loudness: Record<string, unknown> = {};
    mkdirSync(path.join(OUT, 'frames'), { recursive: true });
    for (const lang of LANGS) {
      const rv = current(`render:${lang}`);
      const video = path.join(OUT, `video.${lang}.mp4`);
      const bytes = await getBytes(root, rv.outputs.find((o) => o.port === 'video')!.sha256);
      writeFileSync(video, bytes);
      writeFileSync(path.join(OUT, `cover.${lang}.png`), await getBytes(root, rv.outputs.find((o) => o.port === 'cover')!.sha256));
      const log = await getJson<{ fonts: string[]; timings: Record<string, number> }>(root, rv.outputs.find((o) => o.port === 'log')!.sha256);
      writeEvidence(`render-log.${lang}.json`, log);
      const timeline = await getJson<Timeline>(root, current(`compose:${lang}`).outputs.find((o) => o.port === 'timeline')!.sha256);
      writeEvidence(`timeline.${lang}.json`, timeline);
      const mv = current(`mix:${lang}`);
      const loud = mv.outputs.find((o) => o.port === 'loudness');
      const video128 = parseEbur128(ffmpeg(ebur128Args(video)));
      loudness[lang] = { master: loud ? await getJson(root, loud.sha256) : null, video: video128 };
      const p = probe(video);

      // MOCK on every frame (the solid band in the bottom reserve), the AI label on the first and last frames.
      const all = framesOf(video);
      const box = { x: MOCK_PROBE.x / 5, y: Math.ceil(MOCK_PROBE.y / 5), width: MOCK_PROBE.width / 5, height: Math.floor(MOCK_PROBE.height / 5) - 1 };
      const mockShareMin = Math.min(...all.map((fr) => colourShare(fr, box, MOCK_COLOUR, 30)));
      const label = { x: 22, y: 56, width: 20, height: 6 };
      const aiLabel = [0, all.length - 1].map((k) => colourShare(all[k]!, label, { r: 22, g: 22, b: 29 }, 40));

      // Frame grabs: first, middle, last, and the three points (hook word-pop, a chant card, the reveal).
      const hook = timeline.elements.find((e) => e.kind === 'caption');
      const card = timeline.elements.find((e) => e.kind === 'card');
      const reveal = timeline.elements.find((e) => e.kind === 'reveal');
      const points: [string, number][] = [
        ['first', 0],
        ['middle', Math.floor(p.frames / 2)],
        ['last', p.frames - 1],
        ...(hook ? [['sl03-hook', hook.from + 12] as [string, number]] : []),
        ...(card ? [['sl03-chant', card.from + 12] as [string, number]] : []),
        ...(reveal ? [['sl03-reveal', reveal.kind === 'reveal' ? reveal.punchAt + 8 : reveal.from + 40] as [string, number]] : []),
      ];
      for (const [name, frame] of points) {
        const file = grab(video, frame, path.join(OUT, 'frames', `${lang}-${name}-${frame}.png`));
        const raw = await rawOf(file);
        report.frames.push({ lang, name, frame, file: path.relative(OUT, file), sha256: sha(readFileSync(file)), width: raw.width, height: raw.height });
      }
      report.renders[lang] = { probe: p, loudness: video128, mockShareMin, aiLabel, renderTimings: log.timings, bytes: bytes.length, sha256: sha(bytes), fonts: log.fonts };
    }
    writeEvidence('loudness.json', { measuredWith: 'ffmpeg ebur128=peak=true on the final video; master = the mix step loudness record', ...loudness });

    // The checks, recorded before they are asserted so a failure still leaves the output.
    for (const lang of LANGS) {
      const r = report.renders[lang]!;
      report.results[`${lang}`] = r.probe.codec === 'h264' && r.probe.pixelFormat === 'yuv420p' && r.probe.width === 1080 && r.probe.height === 1920 && r.probe.fps === 30 && Math.abs(r.probe.frames - 900) <= 1 && r.probe.audioCodec === 'aac' && r.probe.sampleRate === 48000 && Math.abs(r.loudness.integratedLufs + 14) <= 1 && r.loudness.truePeakDbtp <= -1.0;
      report.results[`${lang}`] = r.mockShareMin > 0.9 && r.aiLabel.every((x) => x > 0.3);
    }
    report.results[''] = (report.timings.makeItToProofMs as number) <= 8 * 60_000;
    for (const lang of LANGS) {
      const r = report.renders[lang]!;
      expect(r.probe).toMatchObject({ codec: 'h264', pixelFormat: 'yuv420p', width: 1080, height: 1920, audioCodec: 'aac', sampleRate: 48000 });
      expect(r.probe.fps).toBe(30);
      expect(Math.abs(r.probe.frames - 900)).toBeLessThanOrEqual(1);
      expect(Math.abs(r.loudness.integratedLufs + 14)).toBeLessThanOrEqual(1);
      expect(r.loudness.truePeakDbtp).toBeLessThanOrEqual(-1.0);
      expect(r.mockShareMin).toBeGreaterThan(0.9);
      for (const x of r.aiLabel) expect(x).toBeGreaterThan(0.3);
    }
    expect(networkGuardLog()).toEqual([]);
  }, 40 * 60_000);
});
