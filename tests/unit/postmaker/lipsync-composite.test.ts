// @vitest-environment node
// Quality bar acceptance 6: vendor compositing on a mock. A mock lip-sync provider returns the plate with
// a moving mouth rectangle at 25 fps (and its own audio). The composite at 30 fps has the rectangle inside the mask,
// the master audio hash unchanged, no vendor audio, and the line's duration ±1 frame. A decoy box outside the mask
// never reaches the output. Synthetic media made by the bundled ffmpeg in a temp folder; no network.
import child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import type { Spawn } from '@/lib/studio/postmaker/connectors/base';
import { encodeWav } from '@/lib/studio/postmaker/render/pcm';
import { compositeFrame, compositeLipsync, lineFrames, maskAlpha, mouthMask, retimeIndex, MASK_FEATHER_PX } from '@/lib/studio/postmaker/render/lipsyncComposite';
import { tmp } from './guard';

const FFMPEG = ffmpegStatic as string;
const realSpawn = child_process.spawn;
const onlyFfmpeg = ((bin: string, args: string[], opts: object) => {
  if (bin !== FFMPEG) throw new Error(`spawn of ${bin} is not allowed here`);
  return realSpawn(bin, args, opts);
}) as unknown as Spawn;
const ff = (args: string[]) => child_process.spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

describe('pure parts', () => {
  it('retimes 25 → 30 fps by nearest frame and clamps to the clip', () => {
    expect(Array.from({ length: 7 }, (_, k) => retimeIndex(k, 25, 30, 100))).toEqual([0, 1, 2, 3, 3, 4, 5]);
    expect(retimeIndex(500, 25, 30, 40)).toBe(39);
    expect(lineFrames(1500)).toBe(45);
    expect(lineFrames(1510)).toBe(46);
  });

  it('the mask covers the mouth down to the jaw and feathers 16 px', () => {
    const m = mouthMask({ x: 208, y: 290, w: 96, h: 30 }, { x: 128, y: 128, w: 256, h: 220 });
    expect(m).toEqual({ cx: 256, cy: 311.5, rx: 96, ry: 36.5 });
    expect(maskAlpha(m, 256, 311)).toBe(1);
    expect(maskAlpha(m, 256 + 96 + 8, 311.5)).toBeCloseTo(0.5, 5);
    expect(maskAlpha(m, 256 + 96 + MASK_FEATHER_PX + 1, 311.5)).toBe(0);
  });

  it('compositeFrame keeps the base outside the mask and the clip inside it', () => {
    const base = { data: Buffer.alloc(64 * 64 * 3, 100), width: 64, height: 64 };
    const clip = { data: Buffer.alloc(32 * 32 * 3, 200), width: 32, height: 32 };
    const out = compositeFrame(base, clip, { x: 16, y: 16, w: 32, h: 32 }, { cx: 32, cy: 32, rx: 6, ry: 6 }, 2);
    expect(out[(32 * 64 + 32) * 3]).toBe(200);
    expect(out[(2 * 64 + 2) * 3]).toBe(100);
  });
});

describe('acceptance 6: vendor compositing on a mock', () => {
  it('a 25 fps mock clip with a moving mouth box composites at 30 fps: box inside the mask, master unchanged, duration ±1 frame', async () => {
    const dir = tmp.dir;
    // our master: 1.5 s of a 220 Hz tone (the line's audio); the mock vendor clip carries a different tone, discarded
    const n = 48_000 * 1.5;
    const ch = Float32Array.from({ length: n }, (_, k) => 0.2 * Math.sin((2 * Math.PI * 220 * k) / 48_000));
    const master = path.join(dir, 'master.wav');
    writeFileSync(master, encodeWav({ sampleRate: 48_000, channels: [ch, ch] }));
    const before = sha(master);
    // the base: the animated head's frame (a plain grey still, 512 × 512)
    const base = path.join(dir, 'base.png');
    expect(ff(['-f', 'lavfi', '-i', 'color=c=0x808080:s=512x512:d=0.04', '-frames:v', '1', base]).status).toBe(0);
    // the mock provider: the plate (256 × 256, blue) at 25 fps for 1.6 s, a red mouth box moving sideways, a green
    // decoy box at the top left (outside any mouth mask) and its own audio track
    const clip = path.join(dir, 'clip.mp4');
    const fc = "[0][1]overlay=x='100+20*sin(t*6)':y=170:eval=frame,drawbox=x=10:y=10:w=30:h=30:color=lime:t=fill[v]";
    expect(ff(['-f', 'lavfi', '-i', 'color=c=0x3060A0:s=256x256:r=25:d=1.6', '-f', 'lavfi', '-i', 'color=c=red:s=40x16:r=25:d=1.6', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.6', '-filter_complex', fc, '-map', '[v]', '-map', '2:a', '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]).status).toBe(0);
    const faceBox = { x: 128, y: 128, w: 256, h: 256 };
    const mask = mouthMask({ x: 208, y: 290, w: 96, h: 30 }, { x: 128, y: 128, w: 256, h: 220 });
    const out = path.join(dir, 'composite.mp4');
    const r = await compositeLipsync({ clip, clipFps: 25, base, width: 512, height: 512, faceBox, mask, lineMs: 1500, master, out, ffmpeg: { bin: FFMPEG, spawn: onlyFfmpeg } });
    expect(r).toMatchObject({ frames: 45, fps: 30, vendorAudio: 'discarded', master: { unchanged: true } });
    expect(r.map.slice(0, 6)).toEqual([0, 1, 2, 3, 3, 4]);
    expect(sha(master)).toBe(before);

    // the encoded composite: 30 fps, 45 ± 1 frames, no audio stream
    const info = child_process.spawnSync(FFMPEG, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr;
    expect(info).toMatch(/30 fps/);
    expect(info).not.toMatch(/Audio:/);
    const raw = child_process.spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 * 1024 * 1024 }).stdout;
    const size = 512 * 512 * 3;
    const frames = Math.floor(raw.length / size);
    expect(Math.abs(frames - 45)).toBeLessThanOrEqual(1);

    // every red pixel lies inside the feathered mask; the box moves; the decoy never shows
    const xs: number[] = [];
    let outside = 0;
    let decoy = 0;
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      let count = 0;
      for (let y = 0; y < 512; y++)
        for (let x = 0; x < 512; x++) {
          const o = f * size + (y * 512 + x) * 3;
          const [R, G, B] = [raw[o]!, raw[o + 1]!, raw[o + 2]!];
          if (R > 170 && G < 90 && B < 90) {
            count++;
            sum += x;
            if (maskAlpha(mask, x + 0.5, y + 0.5) <= 0) outside++;
          }
          if (G > 170 && R < 90 && B < 90) decoy++;
        }
      if (count > 50) xs.push(sum / count);
    }
    expect(outside).toBe(0);
    expect(decoy).toBe(0);
    expect(xs.length).toBeGreaterThan(40);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(20);
  }, 60_000);
});

describe('the plate (quality bar)', () => {
  it('centres the fixture rig head in a 1024 plate and maps it back over an animated head', async () => {
    const { buildRigFixture, FINAL, RIG_ID } = await import('./anim/rig-fixture');
    const { loadRig } = await import('@/lib/studio/postmaker/anim/rig/load');
    const { faceBoxFor, partBox, plateFor, PLATE_SIZE } = await import('@/lib/studio/postmaker/render/lipsyncPlate');
    const { solveFrame } = await import('@/lib/studio/postmaker/anim/solve');
    const fx = await buildRigFixture();
    const rig = (await loadRig(fx, fx.lib, RIG_ID, FINAL)).rig;
    const plate = plateFor(rig);
    expect(plate.size).toBe(PLATE_SIZE);
    expect(plate.head.x + plate.head.w / 2).toBeCloseTo(512, 0);
    expect(plate.head.h).toBeCloseTo(PLATE_SIZE * 0.42, 0);
    expect(plate.spec.loops).toEqual([]);
    expect(plate.mouth.y).toBeGreaterThan(plate.head.y);
    // an animated frame at another place and scale: the plate head lands exactly on the animated head
    const f = solveFrame(rig, { ...plate.spec, place: { x: 400, y: 1300, scale: 0.8 } }, 0, { seed: 1 });
    const head = partBox(rig, f, 'head')!;
    const box = faceBoxFor(plate, head);
    const k = box.w / PLATE_SIZE;
    expect(box.x + plate.head.x * k).toBeCloseTo(head.x, 6);
    expect(box.y + (plate.head.y + plate.head.h) * k).toBeCloseTo(head.y + head.h, 6);
    const m = mouthMask(partBox(rig, f, 'mouth')!, head);
    expect(m.cx).toBeGreaterThan(head.x);
    expect(m.cx).toBeLessThan(head.x + head.w);
    rmSync(fx.libDir, { recursive: true, force: true });
  }, 60_000);
});
