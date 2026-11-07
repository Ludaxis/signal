// Product mocks for video, made locally with the bundled ffmpeg:
// - lip-sync: the still image held for the audio length with a pulsing mouth box (sync / hedra mock);
// - b-roll: a slow Ken-Burns pan over the input image (higgsfield-video mock).
// The argument lists are pure (tested exactly); running them needs `spawn` from InvokeCtx.deps or the real one.
// The "Mock" watermark is drawn by the render step on every frame, not here.
import { PostmakerError } from '../../errors';
import type { Spawn } from '../base';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const secs = (ms: number) => (Math.max(100, ms) / 1000).toFixed(3);

/** Still + pulsing mouth box (on 120 ms, off 120 ms), H.264, no audio track (the mix adds the voice). */
export function mouthBoxArgs(o: { image: string; durationMs: number; out: string; w: number; h: number; box: Box; fps?: number }): string[] {
  const w = even(o.w);
  const h = even(o.h);
  const b = o.box;
  const vf = [`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`, `drawbox=x=${Math.round(b.x)}:y=${Math.round(b.y)}:w=${Math.round(b.w)}:h=${Math.round(b.h)}:color=black@0.6:t=fill:enable='lt(mod(t,0.24),0.12)'`, 'format=yuv420p'].join(',');
  return ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', String(o.fps ?? 30), '-i', o.image, '-t', secs(o.durationMs), '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', o.out];
}

/** Ken-Burns: zoom from 1.0 to about 1.12 towards the centre over the clip. */
export function kenBurnsArgs(o: { image: string; durationMs: number; out: string; w: number; h: number; fps?: number }): string[] {
  const w = even(o.w);
  const h = even(o.h);
  const fps = o.fps ?? 30;
  const frames = Math.max(1, Math.round((Math.max(100, o.durationMs) / 1000) * fps));
  const step = (0.12 / frames).toFixed(6);
  const vf = [`scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase`, `crop=${w * 2}:${h * 2}`, `zoompan=z='min(zoom+${step},1.12)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`, 'format=yuv420p'].join(',');
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', o.image, '-vf', vf, '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', o.out];
}

/** PATH only: ffmpeg needs no credential, so no saved key can reach it. */
export const minimalEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? '' });

/** Runs ffmpeg with an allow-listed empty environment; rejects with the last stderr line. */
export function runFfmpeg(spawn: Spawn, bin: string, args: string[], o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let err = '';
    let p: ReturnType<Spawn>;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: minimalEnv() as NodeJS.ProcessEnv, signal: o.signal });
    } catch (e) {
      reject(new PostmakerError(500, 'ffmpeg', `ffmpeg could not start. ${(e as Error).message}`));
      return;
    }
    const timer = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs ?? 120_000);
    p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new PostmakerError(500, 'ffmpeg', `ffmpeg failed. ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new PostmakerError(500, 'ffmpeg', `ffmpeg exited with ${code}. ${err.trim().split('\n').pop() ?? ''}`.trim()));
    });
  });
}
