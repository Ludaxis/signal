// @vitest-environment node
// The ffmpeg-made mocks run for real with the bundled ffmpeg (local only; no network, no vendor): the lip-sync mock
// (still + pulsing mouth box) and the b-roll mock (Ken-Burns pan) produce MP4 files of the asked length, and the
// ffmpeg connector measures the loudness of the mock voice. This file deliberately does not install the network
// guard, because it starts the local ffmpeg binary.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFfmpeg } from '@/lib/studio/postmaker/connectors/local';
import { higgsfieldVideo } from '@/lib/studio/postmaker/connectors/higgsfield';
import { sync } from '@/lib/studio/postmaker/connectors/lipsync';
import { mockSpeech } from '@/lib/studio/postmaker/connectors/mock/audio';
import { ctxOf } from './fakes';

let dir = '';
let still = '';
beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'signal-pm-mockrender-'));
  still = path.join(dir, 'still.png');
  await sharp({ create: { width: 216, height: 384, channels: 3, background: { r: 200, g: 180, b: 160 } } }).png().toFile(still);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const durationOf = (file: string) => {
  const r = spawnSync(ffmpegPath!, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};

describe.runIf(Boolean(ffmpegPath))('ffmpeg-made mocks (real local ffmpeg)', () => {
  it('lip-sync mock: an MP4 of the audio length', async () => {
    const r = await sync.mock({ imageFile: still, audioFile: '/unused.wav', durationMs: 1200, width: 216, height: 384 }, ctxOf({ workDir: path.join(dir, 'w1') }));
    expect(r).toMatchObject({ mime: 'video/mp4', mode: 'mock', durationMs: 1200 });
    expect(r.video.subarray(4, 8).toString('ascii')).toBe('ftyp');
    const f = path.join(dir, 'lipsync.mp4');
    writeFileSync(f, r.video);
    expect(durationOf(f)).toBeCloseTo(1.2, 1);
  }, 60_000);

  it('b-roll mock: a Ken-Burns pan of the requested length', async () => {
    const r = await higgsfieldVideo.mock({ prompt: 'pan', imageFile: still, durationSec: 2, width: 216, height: 384 }, ctxOf({ workDir: path.join(dir, 'w2') }));
    expect(r.mode).toBe('mock');
    const f = path.join(dir, 'broll.mp4');
    writeFileSync(f, r.video);
    expect(durationOf(f)).toBeCloseTo(2, 1);
  }, 60_000);

  it('ffmpeg connector measures the mock voice loudness', async () => {
    const wav = path.join(dir, 'voice.wav');
    writeFileSync(wav, mockSpeech('سلام دنیا، این یک آزمایش است', 'fa').wav);
    const r = await makeFfmpeg().invoke({ file: wav }, ctxOf());
    expect(r.loudness.inputI).toBeLessThan(0);
    expect(r.loudness.inputTp).toBeLessThan(0);
    expect(readFileSync(wav).subarray(0, 4).toString()).toBe('RIFF');
  }, 60_000);
});
