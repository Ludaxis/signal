// Vendor lip-sync compositing (quality bar, `vendor` mode). The vendor returns a talking plate (the head
// and shoulders, head static and centred, neutral mouth, plain background) at its own frame rate. Signal:
//   1. retimes it to 30 fps by nearest-frame mapping (25 fps: output frame k shows source frame round(k × 25 / 30));
//   2. crops it to the face box and places it where the plate's head sits on the animated frame (the plate's head
//      transform is known from the rig, so the caller passes the box);
//   3. composites it through a feathered elliptical mask over the mouth and jaw (feather 16 px, the ellipse from the
//      rig's `mouth` and `head` bounds) over the animated head;
//   4. keeps our master audio: the vendor's audio is discarded and the master file is never written (its hash holds).
// The pure parts (retime index, mask, per-frame composite) are exported for tests; `compositeLipsync` runs them over
// raw RGB frames decoded and encoded by the local ffmpeg. Nothing here calls a vendor.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Spawn } from '../connectors/base';
import { minimalEnv } from '../connectors/mock/video';
import { PostmakerError } from '../errors';
import { sha256OfFile } from '../store/objects';

export const COMPOSITE_FPS = 30;
export const MASK_FEATHER_PX = 16;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** The mouth-and-jaw ellipse in canvas px. */
export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Nearest source frame for output frame k (both rates in fps), clamped to the clip. */
export function retimeIndex(k: number, srcFps: number, dstFps: number, srcFrames: number): number {
  return Math.max(0, Math.min(srcFrames - 1, Math.round((k * srcFps) / dstFps)));
}

/** Output frames for a line: its duration at 30 fps (ceil, the layout engine's rule). */
export const lineFrames = (lineMs: number, fps = COMPOSITE_FPS) => Math.max(1, Math.ceil((lineMs * fps) / 1000));

/**
 * The mask from the rig bounds: an ellipse around the mouth that reaches down to the jaw (the head's bottom edge),
 * as wide as the mouth plus half of it each side.
 */
export function mouthMask(mouth: Rect, head: Rect): Ellipse {
  const top = mouth.y - mouth.h * 0.5;
  const bottom = Math.max(mouth.y + mouth.h, head.y + head.h);
  return { cx: mouth.x + mouth.w / 2, cy: (top + bottom) / 2, rx: mouth.w, ry: (bottom - top) / 2 };
}

/** Mask alpha at a canvas pixel: 1 inside the ellipse, falling linearly to 0 over `feather` px outside it. */
export function maskAlpha(e: Ellipse, x: number, y: number, feather = MASK_FEATHER_PX): number {
  const dx = (x - e.cx) / e.rx;
  const dy = (y - e.cy) / e.ry;
  const r = Math.hypot(dx, dy);
  if (r <= 1) return 1;
  // distance outside the edge, in px, along the ray (approximation good for feathers small next to the radii)
  const outside = (r - 1) * Math.hypot(dx * e.rx, dy * e.ry) / r;
  return outside >= feather ? 0 : 1 - outside / feather;
}

export interface RgbFrame {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * One composited frame: the base (animated head) with the clip frame (the plate, scaled to `faceBox`) blended in
 * through the mask. Pixels outside the face box or the feathered ellipse are the base's own.
 */
export function compositeFrame(base: RgbFrame, clip: RgbFrame, faceBox: Rect, mask: Ellipse, feather = MASK_FEATHER_PX): Buffer {
  const out = Buffer.from(base.data);
  const x0 = Math.max(0, Math.floor(Math.max(faceBox.x, mask.cx - mask.rx - feather)));
  const x1 = Math.min(base.width, Math.ceil(Math.min(faceBox.x + faceBox.w, mask.cx + mask.rx + feather)));
  const y0 = Math.max(0, Math.floor(Math.max(faceBox.y, mask.cy - mask.ry - feather)));
  const y1 = Math.min(base.height, Math.ceil(Math.min(faceBox.y + faceBox.h, mask.cy + mask.ry + feather)));
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const a = maskAlpha(mask, x + 0.5, y + 0.5, feather);
      if (a <= 0) continue;
      const sx = Math.min(clip.width - 1, Math.floor(((x - faceBox.x) / faceBox.w) * clip.width));
      const sy = Math.min(clip.height - 1, Math.floor(((y - faceBox.y) / faceBox.h) * clip.height));
      const o = (y * base.width + x) * 3;
      const s = (sy * clip.width + sx) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(base.data[o + c]! * (1 - a) + clip.data[s + c]! * a);
    }
  return out;
}

function ffmpegRun(spawn: Spawn, bin: string, args: string[], o: { input?: Buffer; signal?: AbortSignal } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: minimalEnv() as NodeJS.ProcessEnv, signal: o.signal });
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout?.on('data', (d: Buffer) => chunks.push(d));
    p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    p.on('error', (e) => reject(new PostmakerError(500, 'ffmpeg', `ffmpeg failed. ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new PostmakerError(500, 'ffmpeg', `ffmpeg exited with ${code}. ${err.trim().split('\n').pop() ?? ''}`))));
    if (o.input) p.stdin?.end(o.input);
    else p.stdin?.end();
  });
}

/** Every frame of a video as raw RGB at its own rate (no resampling: the retime is ours). */
async function decodeFrames(spawn: Spawn, bin: string, file: string, w: number, h: number, signal?: AbortSignal): Promise<RgbFrame[]> {
  const raw = await ffmpegRun(spawn, bin, ['-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-vf', `scale=${w}:${h}`, '-vsync', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { signal });
  const size = w * h * 3;
  const out: RgbFrame[] = [];
  for (let o = 0; o + size <= raw.length; o += size) out.push({ data: raw.subarray(o, o + size), width: w, height: h });
  return out;
}

export interface CompositeInput {
  /** The vendor's returned clip (any rate; its audio is discarded). */
  clip: string;
  clipFps: number;
  /** The animated frame the mouth goes onto: a still (image file) or a video at 30 fps, at `width` × `height`. */
  base: string;
  width: number;
  height: number;
  /** Where the plate's head lands on the base (from the rig's head transform). */
  faceBox: Rect;
  mask: Ellipse;
  lineMs: number;
  /** Our master audio (never written; its hash is checked before and after). */
  master: string;
  out: string;
  ffmpeg: { bin: string; spawn?: Spawn };
  signal?: AbortSignal;
}

export interface CompositeResult {
  file: string;
  frames: number;
  fps: number;
  /** For each output frame, the source clip frame it shows. */
  map: number[];
  master: { sha256: string; unchanged: boolean };
  vendorAudio: 'discarded';
}

/** Retimes, crops, masks and encodes one line (H.264, 30 fps, no audio track: the mix carries our master). */
export async function compositeLipsync(i: CompositeInput): Promise<CompositeResult> {
  const spawn = i.ffmpeg.spawn ?? (await import('node:child_process')).spawn;
  const before = await sha256OfFile(i.master);
  const clip = await decodeFrames(spawn, i.ffmpeg.bin, i.clip, Math.round(i.faceBox.w), Math.round(i.faceBox.h), i.signal);
  if (!clip.length) throw new PostmakerError(502, 'upstream', 'The lip-sync clip has no frames.');
  const base = await decodeFrames(spawn, i.ffmpeg.bin, i.base, i.width, i.height, i.signal);
  if (!base.length) throw new PostmakerError(500, 'ffmpeg', 'The base frame could not be read.');
  const n = lineFrames(i.lineMs);
  const map = Array.from({ length: n }, (_, k) => retimeIndex(k, i.clipFps, COMPOSITE_FPS, clip.length));
  const frames = map.map((s, k) => compositeFrame(base[Math.min(k, base.length - 1)]!, clip[s]!, i.faceBox, i.mask));
  await fs.mkdir(path.dirname(i.out), { recursive: true });
  await ffmpegRun(spawn, i.ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${i.width}x${i.height}`, '-r', String(COMPOSITE_FPS), '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', i.out], { input: Buffer.concat(frames), signal: i.signal });
  const after = await sha256OfFile(i.master);
  if (after !== before) throw new PostmakerError(500, 'master_changed', 'The master audio changed during compositing.');
  return { file: i.out, frames: n, fps: COMPOSITE_FPS, map, master: { sha256: after, unchanged: true }, vendorAudio: 'discarded' };
}
