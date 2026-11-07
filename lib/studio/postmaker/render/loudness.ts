// Loudness with ffmpeg (quality): two-pass `loudnorm` to −14 LUFS integrated and
// true peak ≤ −1.0 dBTP (loudnorm aims at −2.0 dBTP: the AAC encode of the final MP4 adds up to about 0.5 dB) (pass 1 measures, pass 2 applies the measured values with linear=true), and the `ebur128`
// measurement written to loudness.json. ffmpeg is used for loudness and transcode only.
import type { Spawn } from '../connectors/base';
import { loudnormArgs, parseLoudnorm, type Loudness } from '../connectors/local';
import { minimalEnv } from '../connectors/mock/video';
import { PostmakerError } from '../errors';
import { MIX_TARGETS } from './mixPlan';

export interface Ebur128 {
  integratedLufs: number;
  truePeakDbtp: number;
  lraLu: number;
}

export interface LoudnessReport {
  schema: 'signal.pm.loudness/1';
  target: { integratedLufs: number; truePeakDbtp: number; toleranceLu: number };
  pass1: Loudness;
  master: Ebur128;
  video?: Ebur128;
  ok: boolean;
  tool: 'ffmpeg loudnorm (two-pass, linear) + ebur128';
}

export function run(spawn: Spawn, bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let err = '';
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: minimalEnv() as NodeJS.ProcessEnv, signal });
    const timer = setTimeout(() => p.kill('SIGKILL'), 300_000);
    p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-40_000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new PostmakerError(500, 'ffmpeg', `ffmpeg failed. ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new PostmakerError(500, 'ffmpeg', `ffmpeg exited with ${code}. ${err.trim().split('\n').pop() ?? ''}`.trim()));
    });
  });
}

/** Pass 2 arguments: apply the pass-1 measurement linearly, resample to 48 kHz stereo 16-bit. */
export const loudnormApplyArgs = (input: string, out: string, m: Loudness, t = { i: MIX_TARGETS.masterLufs, tp: MIX_TARGETS.loudnormTpDbtp, lra: 11 }) => [
  '-hide_banner',
  '-nostats',
  '-y',
  '-i',
  input,
  '-af',
  `loudnorm=I=${t.i}:TP=${t.tp}:LRA=${t.lra}:measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true:print_format=json`,
  '-ar',
  '48000',
  '-ac',
  '2',
  '-c:a',
  'pcm_s16le',
  out,
];

export const ebur128Args = (file: string) => ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'];

/** Reads the ebur128 Summary block (integrated I, LRA, true peak). */
export function parseEbur128(stderr: string): Ebur128 {
  const at = stderr.lastIndexOf('Summary:');
  const s = at >= 0 ? stderr.slice(at) : stderr;
  const num = (re: RegExp) => {
    const m = re.exec(s);
    const v = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(v)) throw new PostmakerError(502, 'ffmpeg', 'ffmpeg did not report loudness.');
    return v;
  };
  return { integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), lraLu: num(/LRA:\s+(-?[\d.]+) LU/), truePeakDbtp: num(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/) };
}

export async function measure(spawn: Spawn, bin: string, file: string, signal?: AbortSignal): Promise<Ebur128> {
  return parseEbur128(await run(spawn, bin, ebur128Args(file), signal));
}

/** loudnorm pass 1 (measure) and pass 2 (apply) from `input` to `out`, then the ebur128 report of `out`. */
export async function normalise(spawn: Spawn, bin: string, input: string, out: string, signal?: AbortSignal): Promise<LoudnessReport> {
  const pass1 = parseLoudnorm(await run(spawn, bin, loudnormArgs(input, { i: MIX_TARGETS.masterLufs, tp: MIX_TARGETS.loudnormTpDbtp }), signal));
  await run(spawn, bin, loudnormApplyArgs(input, out, pass1), signal);
  const master = await measure(spawn, bin, out, signal);
  return {
    schema: 'signal.pm.loudness/1',
    target: { integratedLufs: MIX_TARGETS.masterLufs, truePeakDbtp: MIX_TARGETS.truePeakDbtp, toleranceLu: MIX_TARGETS.masterToleranceLu },
    pass1,
    master,
    ok: withinTarget(master),
    tool: 'ffmpeg loudnorm (two-pass, linear) + ebur128',
  };
}

export const withinTarget = (m: Ebur128) => Math.abs(m.integratedLufs - MIX_TARGETS.masterLufs) <= MIX_TARGETS.masterToleranceLu && m.truePeakDbtp <= MIX_TARGETS.truePeakDbtp;
