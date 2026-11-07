// `mix:<lang>` executor (quality): writes mixPlan.json (per-stem volume automation with
// the ducking targets), renders the audio-only master with Remotion (`AudioMaster`, codec wav), runs ffmpeg two-pass
// loudnorm to −14 LUFS / −1.0 dBTP and writes loudness.json (ebur128 measurement). Media inputs that are not WAV
// (the fake voice and music executors write text placeholders) are synthesised locally: a tone of the line's length
// for each voice line and a click track at the declared BPM for the music, so a mock run still has real audio.
// The narration-versus-bed delta (quality automated check, ≥ 8 dB) is measured at 3 sampled lines: ffmpeg
// ebur128 over the line's middle 3 s of the voice stem and of the music stem, each at its planned gain; without
// ffmpeg (or on the fake renderer) the planned delta is reported instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clickTrackWav, sineWav } from '../connectors/mock/audio';
import { loudnormArgs, parseLoudnorm } from '../connectors/local';
import type { MixPlanDoc } from '../graph/adapters';
import { normalise, parseEbur128, run, type LoudnessReport } from '../render/loudness';
import { dbAt, lineWindow, MIX_TARGETS, planMix, plannedNarrationDelta, sampleVoice, type MixPlan, type NarrationDelta } from '../render/mixPlan';
import { isFullTimeline, type Timeline } from '../render/timeline';
import type { ArtifactRef, StepCheck } from '../types';
import { lineIdOf, mediaRefs, spawnOf, renderChainDeps, workDirOf, type RenderChainDeps } from './render-chain';
import type { ExecInput, Executor } from './types';

const isWav = (b: Buffer | null | undefined): b is Buffer => Boolean(b && b.length > 44 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE');

async function bytesOf(d: RenderChainDeps, ref: ArtifactRef | undefined): Promise<Buffer | null> {
  if (!ref || !d.readObject) return null;
  return d.readObject(ref.sha256).catch(() => null);
}

export interface MixFiles {
  voice: { id: string; lineId: string; file: string; from: number; frames: number }[];
  music: string | null;
}

/** Writes the stems to `dir` (stored WAVs, or synthesised stand-ins) and returns their files and frames. */
export async function stageStems(d: RenderChainDeps, i: Pick<ExecInput, 'inputs'>, t: Pick<Timeline, 'audio' | 'durationInFrames' | 'grid'>, dir: string): Promise<{ files: MixFiles; synthesised: string[] }> {
  const synthesised: string[] = [];
  const refs = mediaRefs(i.inputs, 'audio');
  const voice: MixFiles['voice'] = [];
  for (const clip of t.audio.filter((a) => a.kind === 'voice' && a.frames > 0)) {
    const ref = refs.find((r) => lineIdOf(r.name) === clip.lineId);
    let wav = await bytesOf(d, ref);
    if (!isWav(wav)) {
      wav = sineWav(Math.round((clip.frames * 1000) / 30), { amplitude: 0.3, hz: 196 });
      synthesised.push(`voice ${clip.lineId}`);
    }
    const file = path.join(dir, `voice-${clip.lineId}.wav`);
    writeFileSync(file, wav);
    voice.push({ id: clip.id, lineId: clip.lineId!, file, from: clip.from, frames: clip.frames });
  }
  let music: Buffer | null = await bytesOf(d, mediaRefs(i.inputs, 'track')[0]);
  if (!isWav(music)) {
    music = clickTrackWav({ bpm: t.grid.bpm, ms: Math.round((t.durationInFrames * 1000) / 30) });
    synthesised.push('music (click track)');
  }
  const musicFile = path.join(dir, 'music.wav');
  writeFileSync(musicFile, music);
  return { files: { voice, music: musicFile }, synthesised };
}

async function lufsOf(d: RenderChainDeps, file: string): Promise<number | null> {
  if (!d.ffmpeg) return null;
  try {
    const v = parseLoudnorm(await run(await spawnOf(d), d.ffmpeg.bin, loudnormArgs(file))).inputI;
    return Number.isFinite(v) && v > -70 ? v : null;
  } catch {
    return null;
  }
}

export interface MixResult {
  plan: MixPlan;
  master: Buffer;
  loudness: LoudnessReport | null;
  rawMasterMs: number;
  synthesised: string[];
  narration: { measured: boolean; lines: NarrationDelta[] };
}

/** ebur128 over a window of a stem at a gain (the same summary `parseEbur128` reads). */
export const windowEbur128Args = (file: string, atSec: number, sec: number, gainDb: number) => [
  '-hide_banner',
  '-nostats',
  '-ss',
  atSec.toFixed(3),
  '-t',
  sec.toFixed(3),
  '-i',
  file,
  '-filter_complex',
  `volume=${gainDb.toFixed(2)}dB,ebur128=peak=true`,
  '-f',
  'null',
  '-',
];

/** ebur128 integrated loudness of `file` from `atSec` for `sec`, at `gainDb` (−70 for silence). */
async function windowLufs(d: RenderChainDeps, file: string, atSec: number, sec: number, gainDb: number, signal?: AbortSignal): Promise<number> {
  if (gainDb <= -90) return -70;
  const v = parseEbur128(await run(await spawnOf(d), d.ffmpeg!.bin, windowEbur128Args(file, atSec, sec, gainDb), signal)).integratedLufs;
  return Number.isFinite(v) ? Math.max(-70, v) : -70;
}

/** The narration-versus-bed delta at 3 sampled lines: measured with ffmpeg when it can, else planned. */
export async function narrationDeltas(d: RenderChainDeps, plan: MixPlan, files: MixFiles, measured: { voice: Map<string, number | null>; music: number | null }, signal?: AbortSignal): Promise<MixResult['narration']> {
  const sampled = sampleVoice(plan);
  const planned = () => sampled.map((c) => plannedNarrationDelta(plan, c, { voice: measured.voice.get(c.id) ?? null, music: measured.music }));
  if (!d.ffmpeg || d.chain.id === 'fake' || !files.music) return { measured: false, lines: planned() };
  try {
    const lines: NarrationDelta[] = [];
    for (const c of sampled) {
      const w = lineWindow(c);
      const mid = w.from + Math.floor(w.frames / 2);
      const file = files.voice.find((v) => v.id === c.id)!.file;
      const voiceLufs = await windowLufs(d, file, (w.from - c.from) / 30, w.frames / 30, c.gainDb, signal);
      const bedLufs = await windowLufs(d, files.music, w.from / 30, w.frames / 30, plan.music ? dbAt(plan.music.curve, mid) : -90, signal);
      const deltaDb = Math.round((voiceLufs - bedLufs) * 10) / 10;
      lines.push({ lineId: c.lineId ?? c.id, frame: mid, voiceLufs, bedLufs, deltaDb, ok: deltaDb >= MIX_TARGETS.narrationOverBedDb });
    }
    return { measured: true, lines };
  } catch {
    return { measured: false, lines: planned() };
  }
}

/** The whole mix: stems → plan → AudioMaster render → two-pass loudnorm → loudness report. */
export async function mixTimeline(d: RenderChainDeps, i: Pick<ExecInput, 'inputs' | 'signal'>, t: Timeline, dir: string, tag: string): Promise<MixResult> {
  const { files, synthesised } = await stageStems(d, i, t, dir);
  const pub = (f: string) => `jobs/${tag}/${path.basename(f)}`;
  const voice = await Promise.all(files.voice.map(async (v) => ({ id: v.id, lineId: v.lineId, src: pub(v.file), from: v.from, frames: v.frames, measuredLufs: await lufsOf(d, v.file) })));
  const musicLufs = files.music ? await lufsOf(d, files.music) : null;
  const plan = planMix({
    durationFrames: t.durationInFrames,
    segments: t.segments,
    voice,
    music: files.music ? { src: pub(files.music), measuredLufs: musicLufs } : null,
  });
  const raw = path.join(dir, 'master.raw.wav');
  const s = Date.now();
  await d.chain.run([{ kind: 'media', composition: 'AudioMaster', props: { plan }, out: raw, codec: 'wav' }], {
    publicFiles: [...files.voice.map((v) => ({ from: v.file, to: pub(v.file) })), ...(files.music ? [{ from: files.music, to: pub(files.music) }] : [])],
    workDir: dir,
    signal: i.signal,
  });
  const rawMasterMs = Date.now() - s;
  const out = path.join(dir, 'master.wav');
  let loudness: LoudnessReport | null = null;
  if (d.ffmpeg && d.chain.id !== 'fake') loudness = await normalise(await spawnOf(d), d.ffmpeg.bin, raw, out, i.signal);
  const master = readFileSync(existsSync(out) && loudness ? out : raw);
  const narration = await narrationDeltas(d, plan, files, { voice: new Map(voice.map((v) => [v.id, v.measuredLufs])), music: musicLufs }, i.signal);
  return { plan, master, loudness, rawMasterMs, synthesised, narration };
}

export function mixExecutor(dIn: Partial<RenderChainDeps> = {}): Executor {
  const d = renderChainDeps(dIn);
  return {
    kind: 'mix',
    implVersion: 'mix@3',
    deterministic: true,
    estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 30, basis: 'On this computer', verified: true }),
    async run(i) {
      const lang = i.lang!;
      const t = i.byPort.timeline as Timeline | MixPlanDoc;
      if (!isFullTimeline(t)) throw new Error('mix needs a composed timeline (compose:<lang> first)');
      const dir = workDirOf(d, i);
      const r = await mixTimeline(d, i, t, dir, `${i.runId}-${i.node.id}`.replace(/[^a-z0-9-]/gi, '-'));
      const checks: StepCheck[] = [];
      // integration: a mock or stand-in master (a click track has no bed, so a music-only mock mix cannot reach
      // -14 LUFS under the true-peak ceiling) is still measured and shown, but does not stop the run: mock output only
      // accepts as draft and never posts. A live mix without stand-ins keeps the loudness gate.
      const standIn = i.mode === 'mock' || r.synthesised.length > 0;
      if (r.loudness) checks.push({ id: `mix:${lang}:loudness`, ok: r.loudness.ok, required: !standIn, text: `Master ${r.loudness.master.integratedLufs.toFixed(1)} LUFS, true peak ${r.loudness.master.truePeakDbtp.toFixed(1)} dBTP${standIn && !r.loudness.ok ? ' (mock audio)' : ''}`, evidence: 'loudness.json' });
      else checks.push({ id: `mix:${lang}:loudness`, ok: false, required: false, text: `Loudness not measured (${d.chain.id} renderer)` });
      const n = r.narration;
      if (n.lines.length) {
        const worst = n.lines.reduce((a, b) => (b.deltaDb < a.deltaDb ? b : a));
        checks.push({
          id: `mix:${lang}:narration-bed`,
          ok: n.lines.every((x) => x.ok),
          required: true,
          text: `Narration over the music bed: lowest ${worst.deltaDb.toFixed(1)} dB at ${n.lines.length} ${n.measured ? 'measured' : 'planned'} lines (needs ${MIX_TARGETS.narrationOverBedDb} dB)`,
          evidence: n.lines.map((x) => `${x.lineId} @${x.frame}: ${x.deltaDb.toFixed(1)} dB`).join('; '),
        });
      }
      if (r.synthesised.length) checks.push({ id: `mix:${lang}:synthesised`, ok: true, required: false, text: `Stand-in audio for: ${r.synthesised.join(', ')}` });
      return {
        outputs: [
          { port: 'mixPlan', name: `mix.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: r.plan },
          { port: 'master', name: `master.${lang}.wav`, kind: 'audio', mime: 'audio/wav', lang, data: null, bytes: r.master, meta: { frames: t.durationInFrames, sampleRate: 48_000, ...(r.loudness ? { lufs: r.loudness.master.integratedLufs } : {}) } },
          ...(r.loudness ? [{ port: 'loudness', name: `loudness.${lang}.json`, kind: 'json' as const, mime: 'application/json', lang, data: r.loudness }] : []),
        ],
        provides: { totalFrames: t.durationInFrames },
        checks,
        status: checks.some((c) => c.required && !c.ok) ? 'needs-you' : 'ok',
        costUsd: 0,
        model: null,
      };
    },
  };
}
