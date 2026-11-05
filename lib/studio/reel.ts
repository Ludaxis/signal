// Server-only: Reel media checks and normalisation (1080x1920, 30 fps, H.264 + AAC) through the
// bundled ffmpeg (ffmpeg-static), used by the Higgsfield Reel generator.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const W = 1080;
const H = 1920;
const FPS = 30;

export interface MediaInfo { width: number; height: number; videoCodec: string | null; audioCodec: string | null; durationSec: number | null; container: string | null }

function runFfmpeg(args: string[]): Promise<{ code: number | null; err: string }> {
  const bin = ffmpegPath;
  if (!bin) throw new Error('ffmpeg is not available on this machine.');
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-8000)));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, err }));
  });
}

/** Reads stream info with the bundled ffmpeg (no ffprobe is shipped): size, codecs and duration. */
export async function probeMedia(file: string): Promise<MediaInfo> {
  const { err } = await runFfmpeg(['-hide_banner', '-i', file]); // exits 1 ("no output"), stream info is on stderr
  const v = err.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Video: (\w+)[^\n]*?(\d{2,5})x(\d{2,5})/);
  const a = err.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio: (\w+)/);
  const d = err.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const c = err.match(/Input #0, ([\w,]+), from/);
  if (!v) throw new Error(`Not a video file: ${err.replace(/\s+/g, ' ').slice(-200)}`);
  return {
    width: Number(v[2]),
    height: Number(v[3]),
    videoCodec: v[1] ?? null,
    audioCodec: a?.[1] ?? null,
    durationSec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    container: c?.[1] ?? null,
  };
}

/** Instagram Reel constraints Signal targets: 1080x1920 (9:16), H.264 high/yuv420p, AAC audio, mp4 with faststart. */
export const REEL_SPEC = { width: W, height: H, fps: FPS, videoCodec: 'h264', audioCodec: 'aac' } as const;

/**
 * Re-encodes any video into a Reel-compatible mp4: scaled to fit 1080x1920 and padded (never cropped),
 * H.264 + AAC (the source audio is kept when there is one, else a silent track), faststart.
 */
export async function normaliseReel(input: Buffer): Promise<{ video: Buffer; info: MediaInfo; source: MediaInfo }> {
  const tmpDir = await fs.mkdtemp(path.join(/* turbopackIgnore: true */ os.tmpdir(), 'signal-reel-in-'));
  try {
    const inFile = path.join(tmpDir, 'in.mp4');
    const outFile = path.join(tmpDir, 'out.mp4');
    await fs.writeFile(/* turbopackIgnore: true */ inFile, input);
    const source = await probeMedia(inFile);
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p`;
    const args = [
      '-y', '-i', inFile,
      ...(source.audioCodec ? [] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']),
      '-map', '0:v:0', '-map', source.audioCodec ? '0:a:0' : '1:a', '-shortest',
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      '-movflags', '+faststart', outFile,
    ];
    const r = await runFfmpeg(args);
    if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}: ${r.err.replace(/\s+/g, ' ').slice(-300)}`);
    const video = await fs.readFile(/* turbopackIgnore: true */ outFile);
    const info = await probeMedia(outFile);
    return { video, info, source };
  } finally {
    await fs.rm(/* turbopackIgnore: true */ tmpDir, { recursive: true, force: true }); // our own temp dir only
  }
}
