#!/usr/bin/env node
// Makes the synthetic slice reference `ref-9x16-10s.mp4`10 s, 1080×1920,
// 30 fps, four shots of ffmpeg's `testsrc2` pattern with hard cuts at 2.5, 5.0 and 7.5 s (each shot recoloured so the
// scene detector sees a cut), and a 440 Hz tone with a 0.5 s gap. No reference footage enters the repository
// the file is generated on demand and is never committed.
//
//   node tests/fixtures/postmaker/make-ref.mjs [out.mp4] [--ffmpeg <bin>]
//
// Uses the bundled ffmpeg (ffmpeg-static) unless --ffmpeg or SIGNAL_FFMPEG names another binary. No network.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REF_NAME = 'ref-9x16-10s.mp4';
export const REF = { width: 1080, height: 1920, fps: 30, seconds: 10, cuts: [2.5, 5, 7.5] };

const SHOTS = ['null', 'negate', 'hue=h=150:s=2', 'negate,hue=h=260:s=2,eq=brightness=-0.15'];

/** The ffmpeg arguments for the reference (exported for tests). */
export function refArgs(out) {
  const shot = REF.seconds / SHOTS.length;
  const inputs = SHOTS.flatMap(() => ['-f', 'lavfi', '-i', `testsrc2=s=${REF.width}x${REF.height}:r=${REF.fps}:d=${shot}`]);
  const chains = SHOTS.map((f, i) => `[${i}:v]${f},setsar=1[v${i}]`).join(';');
  const concat = `${SHOTS.map((_, i) => `[v${i}]`).join('')}concat=n=${SHOTS.length}:v=1:a=0,format=yuv420p[v]`;
  const tone = `[${SHOTS.length}:a]volume=0.25,volume=enable='between(t,4.25,4.75)':volume=0[a]`;
  return [
    '-hide_banner', '-v', 'error', '-y',
    ...inputs,
    '-f', 'lavfi', '-i', `sine=f=440:d=${REF.seconds}:sample_rate=48000`,
    '-filter_complex', `${chains};${concat};${tone}`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(REF.fps),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-t', String(REF.seconds), '-movflags', '+faststart', '-fflags', '+bitexact',
    out,
  ];
}

export function defaultFfmpeg() {
  if (process.env.SIGNAL_FFMPEG) return process.env.SIGNAL_FFMPEG;
  const require = createRequire(import.meta.url);
  return require('ffmpeg-static');
}

/** Writes the reference to `out`; resolves with its path. `spawn` lets a test pass an allow-listed spawn. */
export function makeRef({ out, ffmpeg = defaultFfmpeg(), spawn = nodeSpawn } = {}) {
  if (!out) throw new Error('makeRef needs an output path');
  mkdirSync(path.dirname(out), { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, refArgs(out), { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--ffmpeg');
  const ffmpeg = i >= 0 ? args.splice(i, 2)[1] : undefined;
  const out = path.resolve(args[0] ?? path.join(process.cwd(), REF_NAME));
  makeRef({ out, ...(ffmpeg ? { ffmpeg } : {}) })
    .then((f) => console.log(f))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
