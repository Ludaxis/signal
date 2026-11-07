// `mix:<lang>` executor (quality): writes mixPlan.json (per-stem volume automation with
// the ducking targets), renders the audio-only master with Remotion (`AudioMaster`, codec wav), runs ffmpeg two-pass
// loudnorm to −14 LUFS / −1.0 dBTP and writes loudness.json (ebur128 measurement). Media inputs that are not WAV
// (the fake voice and music executors write text placeholders) are synthesised locally: a tone of the line's length
// for each voice line and a click track at the declared BPM for the music, so a mock run still has real audio.
// The narration-versus-bed delta (quality automated check, ≥ 8 dB) is measured at 3 sampled lines: ffmpeg
// ebur128 over the line's middle 3 s of the voice stem and of the music stem, each at its planned gain; without
// ffmpeg (or on the fake renderer) the planned delta is reported instead.
// With `sfx` deps the mix also carries the SFX stem (executors/sfx.ts: cues from the script requests the music
// document carries and the timeline's gesture and sticker events, resolved to pack `sfx` assets by tag, a missing
// asset dropped with a warning, stem peaks ≤ −6 dBFS) and writes it as `sfx.<lang>.wav`. When the music step is the
// Executor, the mix also checks the licence record, every chant cut against the conformed grid (±2 frames) and
// that no lip-sync vendor audio reaches the master (quality automated checks).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { clickTrackWav, sineWav } from '../connectors/mock/audio';
import { loudnormArgs, parseLoudnorm } from '../connectors/local';
import type { MixPlanDoc } from '../graph/adapters';
import { normalise, parseEbur128, run, type LoudnessReport } from '../render/loudness';
import { dbAt, lineWindow, MIX_TARGETS, planMix, plannedNarrationDelta, sampleVoice, type MixPlan, type NarrationDelta } from '../render/mixPlan';
import { isFullTimeline, type Timeline } from '../render/timeline';
import { offGridCuts } from '../render/conform';
import type { Pcm } from '../render/pcm';
import type { ArtifactRef, StepCheck } from '../types';
import { isMusicDoc, type MusicDoc } from './music';
import { lineIdOf, mediaRefs, spawnOf, renderChainDeps, workDirOf, type RenderChainDeps } from './render-chain';
import { buildSfxStem, decodeSfx, resolveCues, sfxCueList, type SfxDeps } from './sfx';
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
export async function mixTimeline(d: RenderChainDeps, i: Pick<ExecInput, 'inputs' | 'signal'>, t: Timeline, dir: string, tag: string, extra: { sfx?: { file: string; peakDbfs: number } | null } = {}): Promise<MixResult> {
  const { files, synthesised } = await stageStems(d, i, t, dir);
  const sfx = extra.sfx ?? null;
  const pub = (f: string) => `jobs/${tag}/${path.basename(f)}`;
  const voice = await Promise.all(files.voice.map(async (v) => ({ id: v.id, lineId: v.lineId, src: pub(v.file), from: v.from, frames: v.frames, measuredLufs: await lufsOf(d, v.file) })));
  const musicLufs = files.music ? await lufsOf(d, files.music) : null;
  const plan = planMix({
    durationFrames: t.durationInFrames,
    segments: t.segments,
    voice,
    music: files.music ? { src: pub(files.music), measuredLufs: musicLufs } : null,
    sfx: sfx ? [{ id: 'sfx-stem', src: pub(sfx.file), from: 0, frames: t.durationInFrames, peakDbfs: Number.isFinite(sfx.peakDbfs) ? sfx.peakDbfs : null }] : [],
  });
  const raw = path.join(dir, 'master.raw.wav');
  const s = Date.now();
  await d.chain.run([{ kind: 'media', composition: 'AudioMaster', props: { plan }, out: raw, codec: 'wav' }], {
    publicFiles: [...files.voice.map((v) => ({ from: v.file, to: pub(v.file) })), ...(files.music ? [{ from: files.music, to: pub(files.music) }] : []), ...(sfx ? [{ from: sfx.file, to: pub(sfx.file) }] : [])],
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

/** The music document behind the `track` input (read from the music version's `beatGrid` output), or null. */
export async function musicDocOf(d: RenderChainDeps, i: Pick<ExecInput, 'inputs'>): Promise<MusicDoc | null> {
  const u = i.inputs.find((x) => x.port === 'track');
  const ref = u?.version.outputs.find((o) => o.port === 'beatGrid' && o.kind === 'json');
  if (!ref || !d.readObject) return null;
  try {
    const doc = JSON.parse((await d.readObject(ref.sha256)).toString('utf8')) as unknown;
    return isMusicDoc(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** Chant card cuts of a composed timeline (frames). */
export const chantCuts = (t: Pick<Timeline, 'elements' | 'segments'>): number[] => {
  const chant = t.segments.filter((s) => s.segment === 'chant');
  return t.elements.filter((e) => e.kind === 'card' && chant.some((s) => e.from >= s.from - 2 && e.from < s.to)).map((e) => e.from);
};

/** The conformed grid's beat onsets (ms) from the music document. */
export const musicOnsetsMs = (m: Pick<MusicDoc, 'grid'>): number[] => {
  const out: number[] = [];
  for (let t = m.grid.firstOnsetMs; t < m.grid.lengthMs + 1; t += m.grid.beatMs) out.push(t);
  return out;
};

/** Quality checks that read the music document: licence, chant cuts on the conformed grid, no vendor audio. */
export function musicChecks(lang: string, t: Pick<Timeline, 'elements' | 'segments'>, m: MusicDoc | null, inputs: Pick<ExecInput, 'inputs'>['inputs']): StepCheck[] {
  const out: StepCheck[] = [];
  // Lip-sync vendor clips carry the vendor's audio: the mix takes the voice stems only (quality).
  const vendor = inputs.filter((u) => u.nodeId.startsWith('lipsync'));
  out.push({ id: `mix:${lang}:vendor-audio`, ok: vendor.length === 0, required: true, text: vendor.length ? 'Lip-sync vendor audio reached the mix.' : 'No lip-sync vendor audio in the mix.' });
  if (!m) return out;
  // A real track (library or upload) is checked in every mode; a mock lineage only shows it (mock never posts).
  if (m.track.assetId) out.push({ id: `mix:${lang}:licence`, ok: m.track.licenceComplete, required: !m.mock, text: m.track.licenceComplete ? 'Music licence record complete.' : 'The music licence record is incomplete.' });
  const cuts = chantCuts(t);
  if (cuts.length && m.source !== 'none') {
    const off = offGridCuts(cuts, musicOnsetsMs(m));
    out.push({
      id: `mix:${lang}:downbeats`,
      ok: off.length === 0,
      required: true,
      text: off.length ? `${off.length} chant ${off.length === 1 ? 'cut is' : 'cuts are'} off the music's beat (first at frame ${off[0]!.frame}, ${off[0]!.offFrames} frames)` : `All ${cuts.length} chant cuts sit on the music's beat (±2 frames)`,
      evidence: cuts.join(', '),
    });
  }
  return out;
}

export function mixExecutor(dIn: Partial<RenderChainDeps> = {}, o: { sfx?: SfxDeps } = {}): Executor {
  const d = renderChainDeps(dIn);
  return {
    kind: 'mix',
    implVersion: o.sfx ? 'mix@4' : 'mix@3',
    deterministic: !o.sfx?.call,
    estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 30, basis: 'On this computer', verified: true }),
    async run(i) {
      const lang = i.lang!;
      const t = i.byPort.timeline as Timeline | MixPlanDoc;
      if (!isFullTimeline(t)) throw new Error('mix needs a composed timeline (compose:<lang> first)');
      const dir = workDirOf(d, i);
      const music = await musicDocOf(d, i);
      const checks: StepCheck[] = [];
      let costUsd: number | null = 0;
      let model: string | null = null;
      let stem: { file: string; peakDbfs: number; bytes: Buffer; cues: number } | null = null;
      if (o.sfx) {
        const library = await o.sfx.library(i);
        if (library) {
          const available = [...new Set(library.flatMap((s) => (s.asset.kind === 'sfx' ? s.asset.tags : [])))];
          const cl = await sfxCueList(i, t, music?.sfxRequests ?? [], o.sfx.call, available);
          costUsd = cl.costUsd;
          model = cl.model;
          if (cl.note) checks.push(cl.note);
          const { placed, dropped } = resolveCues(cl.list, library, { final: i.params.final === true, use: i.params.use === 'paid-ads' || i.params.use === 'store-listing' ? i.params.use : 'organic' });
          const audio = new Map<string, Pcm>();
          for (const id of new Set(placed.map((p) => p.assetId))) {
            const a = library.find((s) => s.asset.id === id)!;
            const bytes = await readFile(a.file).catch(() => null);
            const pcm = bytes ? await decodeSfx(bytes, a.file, { ffmpeg: d.ffmpeg, workDir: dir, signal: i.signal }) : null;
            if (pcm) audio.set(id, pcm);
          }
          const unread = placed.filter((p) => !audio.has(p.assetId));
          const built = buildSfxStem(placed.filter((p) => audio.has(p.assetId)), audio, t.durationInFrames);
          const file = path.join(dir, 'sfx.wav');
          writeFileSync(file, built.wav);
          stem = { file, peakDbfs: built.peakDbfs, bytes: built.wav, cues: built.clips.length };
          const ceiling = MIX_TARGETS.sfxPeakDbfs;
          checks.push({
            id: `mix:${lang}:sfx`,
            ok: !Number.isFinite(built.peakDbfs) || built.peakDbfs <= ceiling + 1e-6,
            required: true,
            text: built.clips.length ? `SFX: ${built.clips.length} cues, stem peak ${built.peakDbfs.toFixed(1)} dBFS (at most ${ceiling})` : 'No SFX cues in this version.',
            evidence: built.clips.map((c) => `${c.cue}@${c.frame}`).join(', ') || undefined,
          });
          const lost = [...dropped.map((x) => `${x.cue}@${x.frame}`), ...unread.map((x) => `${x.cue}@${x.frame}`)];
          if (lost.length) {
            const text = `Dropped ${lost.length} SFX ${lost.length === 1 ? 'cue' : 'cues'} with no sound in the library: ${[...new Set([...dropped, ...unread].map((x) => x.cue))].join(', ')}`;
            checks.push({ id: `mix:${lang}:sfx-dropped`, ok: false, required: false, text, evidence: lost.join(', ') });
            o.sfx.onWarning?.(text, i);
          }
        }
      }
      const r = await mixTimeline(d, i, t, dir, `${i.runId}-${i.node.id}`.replace(/[^a-z0-9-]/gi, '-'), { sfx: stem });
      // Integration: a mock or stand-in master (a click track has no bed, so a music-only mock mix cannot reach
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
      if (o.sfx || music) checks.push(...musicChecks(lang, t, music, i.inputs));
      if (r.synthesised.length) checks.push({ id: `mix:${lang}:synthesised`, ok: true, required: false, text: `Stand-in audio for: ${r.synthesised.join(', ')}` });
      return {
        outputs: [
          { port: 'mixPlan', name: `mix.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: r.plan },
          { port: 'master', name: `master.${lang}.wav`, kind: 'audio', mime: 'audio/wav', lang, data: null, bytes: r.master, meta: { frames: t.durationInFrames, sampleRate: 48_000, ...(r.loudness ? { lufs: r.loudness.master.integratedLufs } : {}) } },
          ...(r.loudness ? [{ port: 'loudness', name: `loudness.${lang}.json`, kind: 'json' as const, mime: 'application/json', lang, data: r.loudness }] : []),
          ...(stem ? [{ port: 'sfx', name: `sfx.${lang}.wav`, kind: 'audio' as const, mime: 'audio/wav', lang, data: null, bytes: stem.bytes, meta: { frames: t.durationInFrames, sampleRate: 48_000 } }] : []),
        ],
        provides: { totalFrames: t.durationInFrames },
        checks,
        status: checks.some((c) => c.required && !c.ok) ? 'needs-you' : 'ok',
        costUsd,
        model,
      };
    },
  };
}
