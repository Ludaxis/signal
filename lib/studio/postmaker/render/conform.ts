// Music conform (quality S6 "Regenerate (past)", pack): a track declares its grid (BPM, first
// downbeat, beats per bar); there is no beat detection in v1. The track is time-stretched to the script's tempo
// contract by at most ±4 % (else it is rejected with the reason), then offset so a downbeat of its declared grid meets
// the first chant cut. The chant cuts sit on the contract grid (render/layout.ts), and the conformed grid has the
// contract's period, so every chant cut then sits on a beat onset of the conformed track.
//
// - `planConform` is the pure plan (stretch, trim, loop, length) or a refusal with a code and a plain reason.
// - `conformFfmpegArgs` is the ffmpeg pass (atempo keeps the pitch; aloop repeats whole bars from the first downbeat,
//   so the grid continues across the loop; apad + atrim give the exact length; 48 kHz stereo 16-bit PCM).
// - `conformAudio` runs it, then measures the bed (ebur128) and sets it to the bed reference level of the mix
//   (−18 LUFS, true peak ≤ −1 dBTP) with one static gain. The mix then ducks and rides it to the quality-bar targets
//   (render/mixPlan.ts) and the master gets the two-pass loudnorm (render/loudness.ts).
// - Without ffmpeg (CI), a 16-bit or float WAV is conformed in JavaScript by resampling (the pitch follows the tempo,
//   at most ±4 %); the record says so.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Spawn } from '../connectors/base';
import { PostmakerError } from '../errors';
import { measure, run } from './loudness';
import { MIX_TARGETS } from './mixPlan';
import { decodeWav, durationMsOf, encodeWav, MIX_RATE, resampleLinear, toStereo, type Pcm } from './pcm';

/** The largest time stretch a conform may apply (quality: ±4 %). */
export const STRETCH_MAX_PCT = 4;

export interface ContractGrid {
  bpm: number;
  downbeatMs: number;
}

export interface DeclaredGrid {
  bpm: number;
  firstDownbeatMs: number;
  beatsPerBar: 3 | 4;
  loopable: boolean;
  /** The track's length in ms (null when unknown: the conform then assumes it is long enough). */
  durationMs: number | null;
}

export interface ConformPlan {
  ok: true;
  contractBpm: number;
  trackBpm: number;
  /** atempo factor: contract ÷ track (below 1 slows the track down). */
  tempoRatio: number;
  /** |track − contract| ÷ contract, in % (2 decimals). */
  stretchPct: number;
  /** Where a downbeat of the conformed track lands (the first chant cut, or the contract's first downbeat). */
  anchorMs: number;
  /** Ms cut from the start of the stretched material. */
  trimMs: number;
  /** Whole bars from the first downbeat, repeated to length (source ms); null = played once. */
  loop: { startMs: number; lengthMs: number } | null;
  /** Output length (ms). */
  lengthMs: number;
  /** Ms of real music in the output before any silence pad. */
  musicMs: number;
}

export type ConformRefusal = { ok: false; code: 'music.tempo-out-of-range' | 'music.grid-missing' | 'music.too-short' | 'music.length-unknown'; reason: string };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmtBpm = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** |track − contract| ÷ contract in % (the rule the ±4 % limit reads). */
export const stretchPctOf = (trackBpm: number, contractBpm: number) => (Math.abs(trackBpm - contractBpm) / contractBpm) * 100;

/** The tempo check alone: null when the track can be conformed, else the refusal (quality acceptance 7). */
export function tempoRefusal(trackBpm: number, contractBpm: number): ConformRefusal | null {
  const pct = stretchPctOf(trackBpm, contractBpm);
  if (pct <= STRETCH_MAX_PCT + 1e-9) return null;
  return { ok: false, code: 'music.tempo-out-of-range', reason: `Tempo outside ±${STRETCH_MAX_PCT} %: the track is ${fmtBpm(trackBpm)} BPM; this video needs ${fmtBpm(contractBpm)} ± ${STRETCH_MAX_PCT} % (${pct.toFixed(1)} %).` };
}

/**
 * The first chant cut (ms) the layout will make, estimated from the script's beat targets: the first beat onset of the
 * contract grid at or after the chant segment's start (render/layout.ts cuts the first card there, 2 frames early at
 * most). Null when the script has no chant.
 */
export function firstChantCutMs(beats: readonly { segment: string; targetMs: number }[], contract: ContractGrid): number | null {
  let at = 0;
  for (const b of beats) {
    if (b.segment === 'chant') {
      const beat = 60_000 / contract.bpm;
      const k = Math.max(0, Math.ceil((at - 2000 / 30 - contract.downbeatMs) / beat));
      return r3(contract.downbeatMs + k * beat);
    }
    at += b.targetMs;
  }
  return null;
}

/**
 * The pure conform plan. `anchorMs` must sit on the contract grid (a chant cut or the contract's first downbeat);
 * `lengthMs` is the output length; `minMusicMs` the shortest stretch of real music a track played once must give.
 */
export function planConform(contract: ContractGrid, track: Partial<DeclaredGrid> | null | undefined, o: { anchorMs: number; lengthMs: number; minMusicMs?: number }): ConformPlan | ConformRefusal {
  if (!track || typeof track.bpm !== 'number' || !(track.bpm > 0) || typeof track.firstDownbeatMs !== 'number' || !(track.firstDownbeatMs >= 0))
    return { ok: false, code: 'music.grid-missing', reason: 'The track has no declared BPM and first downbeat. Type them in, or pick another track.' };
  const tempo = tempoRefusal(track.bpm, contract.bpm);
  if (tempo) return tempo;
  const beatsPerBar = track.beatsPerBar === 3 ? 3 : 4;
  const ratio = contract.bpm / track.bpm;
  const fd = track.firstDownbeatMs / ratio; // the first downbeat after the stretch
  const bar = (60_000 / contract.bpm) * beatsPerBar; // one bar after the stretch
  const k = Math.max(0, Math.ceil((o.anchorMs - fd) / bar - 1e-9));
  const trimMs = r3(fd + k * bar - o.anchorMs);
  const srcBar = (60_000 / track.bpm) * beatsPerBar;
  const dur = track.durationMs ?? null;
  const stretched = dur === null ? Infinity : dur / ratio;
  const left = stretched - trimMs; // real music after the trim, when played once
  const base = { ok: true as const, contractBpm: contract.bpm, trackBpm: track.bpm, tempoRatio: ratio, stretchPct: r2(stretchPctOf(track.bpm, contract.bpm)), anchorMs: r3(o.anchorMs), trimMs, lengthMs: Math.round(o.lengthMs) };
  if (left >= o.lengthMs) return { ...base, loop: null, musicMs: Math.round(o.lengthMs) };
  if (track.loopable && dur !== null) {
    const bars = Math.floor((dur - track.firstDownbeatMs) / srcBar + 1e-6);
    if (bars >= 1) return { ...base, loop: { startMs: r3(track.firstDownbeatMs), lengthMs: r3(bars * srcBar) }, musicMs: Math.round(o.lengthMs) };
  }
  const need = o.minMusicMs ?? o.lengthMs;
  if (left >= need) return { ...base, loop: null, musicMs: Math.max(0, Math.floor(left)) };
  return { ok: false, code: 'music.too-short', reason: `The track is ${(Math.max(0, left) / 1000).toFixed(1)} s from its first beat; this video needs ${(need / 1000).toFixed(1)} s and the track cannot loop.` };
}

/** Beat onsets (ms) of the conformed track's declared grid within [0, lengthMs). */
export function conformedOnsetsMs(plan: ConformPlan, track: Pick<DeclaredGrid, 'firstDownbeatMs'>): number[] {
  const beat = 60_000 / plan.contractBpm;
  const first = track.firstDownbeatMs / plan.tempoRatio - plan.trimMs;
  const start = first - Math.floor(first / beat) * beat; // earliest onset ≥ 0 (pickup beats before the downbeat count)
  const out: number[] = [];
  for (let t = start; t < Math.min(plan.lengthMs, plan.musicMs + 1); t += beat) out.push(r3(t));
  return out;
}

/** Chant cuts (frames) that sit more than `tol` frames from every onset of the conformed grid. */
export function offGridCuts(cuts: readonly number[], onsetsMs: readonly number[], fps = 30, tol = 2): { frame: number; offFrames: number }[] {
  const onsets = onsetsMs.map((ms) => (ms * fps) / 1000);
  const out: { frame: number; offFrames: number }[] = [];
  for (const f of cuts) {
    const off = onsets.reduce((m, o) => Math.min(m, Math.abs(o - f)), Infinity);
    if (off > tol) out.push({ frame: f, offFrames: r2(off) });
  }
  return out;
}

// ---- ffmpeg ------------------------------------------------------------------------------------------------------

const s6 = (ms: number) => (ms / 1000).toFixed(6);

/** The ffmpeg conform pass: stretch, loop whole bars, trim, pad to the exact length, 48 kHz stereo 16-bit PCM. */
export function conformFfmpegArgs(input: string, out: string, plan: ConformPlan): string[] {
  const base = `aresample=${MIX_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
  const tail = `atempo=${plan.tempoRatio.toFixed(6)},atrim=start=${s6(plan.trimMs)},asetpts=PTS-STARTPTS,apad,atrim=duration=${s6(plan.lengthMs)}`;
  let graph: string;
  if (plan.loop) {
    const a = plan.loop.startMs;
    const b = plan.loop.startMs + plan.loop.lengthMs;
    const size = Math.round((plan.loop.lengthMs / 1000) * MIX_RATE);
    const body = `atrim=start=${s6(a)}:end=${s6(b)},asetpts=PTS-STARTPTS,aloop=loop=-1:size=${size}`;
    graph =
      a >= 0.5
        ? `[0:a]${base},asplit=2[a0][a1];[a0]atrim=end=${s6(a)},asetpts=PTS-STARTPTS[intro];[a1]${body}[body];[intro][body]concat=n=2:v=0:a=1,${tail}[out]`
        : `[0:a]${base},${body},${tail}[out]`;
  } else graph = `[0:a]${base},${tail}[out]`;
  return ['-hide_banner', '-nostats', '-y', '-i', input, '-filter_complex', graph, '-map', '[out]', '-ar', String(MIX_RATE), '-ac', '2', '-c:a', 'pcm_s16le', out];
}

/** A static gain pass (the bed reference level), 48 kHz stereo 16-bit PCM. */
export const gainArgs = (input: string, out: string, gainDb: number) => ['-hide_banner', '-nostats', '-y', '-i', input, '-af', `volume=${gainDb.toFixed(2)}dB`, '-ar', String(MIX_RATE), '-ac', '2', '-c:a', 'pcm_s16le', out];

/** The gain that sets a bed to the reference level without pushing its true peak over the ceiling. */
export function bedGainDb(m: { integratedLufs: number; truePeakDbtp: number }, ref = MIX_TARGETS.bedLufs, ceiling = MIX_TARGETS.truePeakDbtp): number {
  if (!Number.isFinite(m.integratedLufs) || m.integratedLufs <= -70) return 0;
  const g = ref - m.integratedLufs;
  const room = Number.isFinite(m.truePeakDbtp) ? ceiling - m.truePeakDbtp : g;
  return r2(Math.min(g, room));
}

// ---- JavaScript path (no ffmpeg) ---------------------------------------------------------------------------------

/** The conform of a decoded track in JavaScript: loop, resample (pitch follows, ≤ ±4 %), trim, pad. */
export function conformPcm(p: Pcm, plan: ConformPlan): Pcm {
  const src = toStereo(p, MIX_RATE);
  const outLen = Math.round((plan.lengthMs / 1000) * MIX_RATE);
  const trim = Math.round((plan.trimMs / 1000) * MIX_RATE);
  const factor = 1 / plan.tempoRatio; // output samples per input sample
  // Enough source material for trim + length after the stretch.
  const needSrc = Math.ceil((trim + outLen) / factor) + 2;
  const channels = src.channels.map((c) => {
    let material = c;
    if (plan.loop) {
      const a = Math.round((plan.loop.startMs / 1000) * MIX_RATE);
      const len = Math.max(1, Math.round((plan.loop.lengthMs / 1000) * MIX_RATE));
      material = new Float32Array(Math.max(needSrc, a + len));
      for (let i = 0; i < material.length; i++) material[i] = i < a ? (c[i] ?? 0) : (c[a + ((i - a) % len)] ?? 0);
    }
    const stretched = factor === 1 ? material : resampleLinear(material, factor);
    const out = new Float32Array(outLen);
    out.set(stretched.subarray(trim, trim + outLen));
    return out;
  });
  return { sampleRate: MIX_RATE, channels };
}

export interface ConformedAudio {
  wav: Buffer;
  method: 'ffmpeg' | 'resample';
  /** The bed after the reference gain (null when not measured). */
  lufs: number | null;
  truePeakDbtp: number | null;
  gainDb: number;
}

/** Conforms a track's bytes per `plan`: ffmpeg when given (then measured and set to the bed level), else JavaScript. */
export async function conformAudio(o: { bytes: Buffer; ext: string; plan: ConformPlan; ffmpeg: { bin: string; spawn?: Spawn } | null; workDir: string; signal?: AbortSignal }): Promise<ConformedAudio> {
  if (!o.ffmpeg) {
    const p = decodeWav(o.bytes);
    if (!p) throw new PostmakerError(503, 'not_installed', 'ffmpeg is needed to read this track.');
    return { wav: encodeWav(conformPcm(p, o.plan)), method: 'resample', lufs: null, truePeakDbtp: null, gainDb: 0 };
  }
  const spawn = o.ffmpeg.spawn ?? (await import('node:child_process')).spawn;
  await fs.mkdir(o.workDir, { recursive: true });
  const input = path.join(o.workDir, `music-source${safeExt(o.ext)}`);
  const stretched = path.join(o.workDir, 'music-conformed.raw.wav');
  const out = path.join(o.workDir, 'music-conformed.wav');
  await fs.writeFile(input, o.bytes);
  await run(spawn, o.ffmpeg.bin, conformFfmpegArgs(input, stretched, o.plan), o.signal);
  const before = await measure(spawn, o.ffmpeg.bin, stretched, o.signal);
  const gainDb = bedGainDb(before);
  await run(spawn, o.ffmpeg.bin, gainArgs(stretched, out, gainDb), o.signal);
  const after = await measure(spawn, o.ffmpeg.bin, out, o.signal);
  return { wav: await fs.readFile(out), method: 'ffmpeg', lufs: Number.isFinite(after.integratedLufs) ? after.integratedLufs : null, truePeakDbtp: Number.isFinite(after.truePeakDbtp) ? after.truePeakDbtp : null, gainDb };
}

const safeExt = (ext: string) => (/^\.[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : '.bin');

/** ffmpeg arguments that decode a track's audio in full to 48 kHz stereo 16-bit PCM (to measure its length). */
export const decodeArgs = (input: string, out: string) => ['-hide_banner', '-nostats', '-y', '-i', input, '-map', '0:a:0', '-ar', String(MIX_RATE), '-ac', '2', '-c:a', 'pcm_s16le', out];

/**
 * A track's real length (ms): a WAV is read in JavaScript; any other format (MP3, M4A, OGG, FLAC: the likely upload) is
 * decoded once in full by ffmpeg, so the length does not rest on a container header. Null when it cannot be measured
 * (no ffmpeg, or ffmpeg cannot read it); the caller refuses the track then (`music.length-unknown`) rather than plan
 * it as endless and pad it with silence.
 */
export async function measureTrackMs(o: { bytes: Buffer; ext: string; ffmpeg: { bin: string; spawn?: Spawn } | null; workDir: string; signal?: AbortSignal }): Promise<number | null> {
  const wav = decodeWav(o.bytes);
  if (wav) return durationMsOf(wav);
  if (!o.ffmpeg) return null;
  const spawn = o.ffmpeg.spawn ?? (await import('node:child_process')).spawn;
  await fs.mkdir(o.workDir, { recursive: true });
  const input = path.join(o.workDir, `music-probe${safeExt(o.ext)}`);
  const out = path.join(o.workDir, 'music-probe.wav');
  await fs.writeFile(input, o.bytes);
  try {
    await run(spawn, o.ffmpeg.bin, decodeArgs(input, out), o.signal);
    const p = decodeWav(await fs.readFile(out));
    return p ? durationMsOf(p) : null;
  } catch (e) {
    if (o.signal?.aborted) throw e;
    return null;
  } finally {
    await fs.rm(out, { force: true }).catch(() => undefined);
  }
}

/** The refusal for a track whose length cannot be measured. */
export const lengthUnknown = (): ConformRefusal => ({ ok: false, code: 'music.length-unknown', reason: 'The track’s length could not be measured, so it cannot be fitted to this video. Use a WAV, MP3, M4A, OGG or FLAC file that plays.' });

/** A silent 48 kHz stereo WAV of `ms` (the `none` source). */
export const silentWav = (ms: number) => encodeWav({ sampleRate: MIX_RATE, channels: [new Float32Array(Math.round((ms / 1000) * MIX_RATE)), new Float32Array(Math.round((ms / 1000) * MIX_RATE))] });
