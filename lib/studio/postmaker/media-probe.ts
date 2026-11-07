// Reference uploads: the file type comes from its first bytes (magic bytes), never from the
// name or the Content-Type header, and the probe reads the container itself, in this process, with no child process
// and no network: MP4/MOV boxes (mvhd duration, video track size, frame rate, codec, audio track), PNG IHDR, JPEG SOF
// and WebP VP8/VP8L/VP8X headers. A file that does not parse is refused.
import { promises as fs } from 'node:fs';
import { PostmakerError } from './errors';
import type { Reference } from './types';

export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_MAX_MS = 300_000;
/** The moov box is read into memory; real ones are a few MB at most. */
const MOOV_MAX_BYTES = 64 * 1024 * 1024;

export type Sniffed =
  | { kind: 'video'; ext: 'mp4' | 'mov'; mime: 'video/mp4' | 'video/quicktime' }
  | { kind: 'image'; ext: 'png' | 'jpg' | 'webp'; mime: 'image/png' | 'image/jpeg' | 'image/webp' };

const ascii = (b: Uint8Array, at: number, n: number) => Buffer.from(b.subarray(at, at + n)).toString('latin1');
const QT_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** The type of a file from its first 16 bytes, or null when it is none of the accepted types. */
export function sniff(head: Uint8Array): Sniffed | null {
  if (head.length >= 8 && head[0] === 0x89 && ascii(head, 1, 3) === 'PNG' && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return { kind: 'image', ext: 'png', mime: 'image/png' };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', ext: 'jpg', mime: 'image/jpeg' };
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return { kind: 'image', ext: 'webp', mime: 'image/webp' };
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') return ascii(head, 8, 4) === 'qt  ' ? { kind: 'video', ext: 'mov', mime: 'video/quicktime' } : { kind: 'video', ext: 'mp4', mime: 'video/mp4' };
  if (head.length >= 8 && QT_ATOMS.has(ascii(head, 4, 4))) return { kind: 'video', ext: 'mov', mime: 'video/quicktime' };
  return null;
}

export const unreadable = () => new PostmakerError(400, 'validation', 'This file could not be read. Use an MP4 or MOV video, or a PNG, JPG or WebP image.');

// ---- MP4 / MOV ---------------------------------------------------------------------------------------------------

interface Box {
  type: string;
  start: number; // payload start (absolute in its buffer or file)
  end: number;
}

/** Child boxes inside buf[from, to). */
function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (buf: Buffer, b: Box, type: string) => boxes(buf, b.start, b.end).find((x) => x.type === type) ?? null;

/** Locates the top-level `moov` box by walking box headers in the file (mdat is skipped, never read). */
async function readMoov(file: string): Promise<Buffer> {
  const fh = await fs.open(/* turbopackIgnore: true */ file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    let at = 0;
    for (let n = 0; n < 10_000 && at + 8 <= size; n++) {
      await fh.read(head, 0, 16, at);
      let box = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (box === 1) {
        box = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (box === 0) box = size - at;
      if (box < header || at + box > size) break;
      if (type === 'moov') {
        if (box - header > MOOV_MAX_BYTES) throw unreadable();
        const buf = Buffer.alloc(box - header);
        await fh.read(buf, 0, buf.length, at + header);
        return buf;
      }
      at += box;
    }
  } finally {
    await fh.close();
  }
  throw unreadable();
}

/** Duration, size, frame rate, codec and audio of an MP4/MOV, from its `moov` box. */
export function parseMoov(moov: Buffer): NonNullable<Reference['probe']> {
  const top: Box = { type: 'moov', start: 0, end: moov.length };
  const mvhd = child(moov, top, 'mvhd');
  if (!mvhd) throw unreadable();
  const v1 = moov[mvhd.start] === 1;
  const timescale = moov.readUInt32BE(mvhd.start + (v1 ? 20 : 12));
  const duration = v1 ? Number(moov.readBigUInt64BE(mvhd.start + 24)) : moov.readUInt32BE(mvhd.start + 16);
  if (!timescale) throw unreadable();
  let width = 0;
  let height = 0;
  let fps = 0;
  let codec = '';
  let hasAudio = false;
  for (const trak of boxes(moov, 0, moov.length).filter((b) => b.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!mdia || !hdlr) continue;
    const handler = moov.toString('latin1', hdlr.start + 8, hdlr.start + 12);
    if (handler === 'soun') hasAudio = true;
    if (handler !== 'vide' || width) continue;
    const tkhd = child(moov, trak, 'tkhd');
    if (tkhd && tkhd.end - tkhd.start >= 8) {
      width = Math.round(moov.readUInt32BE(tkhd.end - 8) / 65536);
      height = Math.round(moov.readUInt32BE(tkhd.end - 4) / 65536);
    }
    const mdhd = child(moov, mdia, 'mdhd');
    const stbl = (() => {
      const minf = child(moov, mdia, 'minf');
      return minf ? child(moov, minf, 'stbl') : null;
    })();
    if (stbl) {
      const stsd = child(moov, stbl, 'stsd');
      if (stsd && stsd.end - stsd.start >= 16) codec = moov.toString('latin1', stsd.start + 12, stsd.start + 16).replace(/[^\x20-\x7e]/g, '').trim();
      const stts = child(moov, stbl, 'stts');
      if (mdhd && stts) {
        const m1 = moov[mdhd.start] === 1;
        const ts = moov.readUInt32BE(mdhd.start + (m1 ? 20 : 12));
        const dur = m1 ? Number(moov.readBigUInt64BE(mdhd.start + 24)) : moov.readUInt32BE(mdhd.start + 16);
        const entries = moov.readUInt32BE(stts.start + 4);
        let samples = 0;
        for (let i = 0; i < entries && stts.start + 8 + i * 8 + 8 <= stts.end; i++) samples += moov.readUInt32BE(stts.start + 8 + i * 8);
        if (ts && dur) fps = Math.round((samples / (dur / ts)) * 100) / 100;
      }
    }
  }
  if (!width || !height) throw unreadable();
  return { durationMs: Math.round((duration / timescale) * 1000), width, height, fps, hasAudio, codec: codec || 'unknown' };
}

// ---- images ------------------------------------------------------------------------------------------------------

export function imageSize(buf: Buffer, ext: 'png' | 'jpg' | 'webp'): { width: number; height: number } {
  if (ext === 'png') {
    if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') throw unreadable();
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (ext === 'webp') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buf.length >= 30) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    throw unreadable();
  }
  // JPEG: walk the markers to the first SOFn (not DHT C4, JPG C8, DAC CC).
  let at = 2;
  while (at + 9 < buf.length) {
    if (buf[at] !== 0xff) throw unreadable();
    const marker = buf[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const len = buf.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
    at += 2 + len;
  }
  throw unreadable();
}

/** Probes a stored upload; refuses a video over 5 minutes and anything that does not parse. */
export async function probeFile(file: string, s: Sniffed): Promise<NonNullable<Reference['probe']>> {
  if (s.kind === 'video') {
    const p = parseMoov(await readMoov(file));
    if (p.durationMs <= 0) throw unreadable();
    if (p.durationMs > VIDEO_MAX_MS) throw new PostmakerError(400, 'validation', 'Videos can be up to 5 minutes long.');
    return p;
  }
  const fh = await fs.open(/* turbopackIgnore: true */ file, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(size, 1024 * 1024));
    await fh.read(buf, 0, buf.length, 0);
    const { width, height } = imageSize(buf, s.ext);
    if (!width || !height) throw unreadable();
    return { durationMs: 0, width, height, fps: 0, hasAudio: false, codec: s.ext };
  } finally {
    await fh.close();
  }
}
