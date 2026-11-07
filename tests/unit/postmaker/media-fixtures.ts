// Synthetic media for the reference-upload tests: an MP4/MOV made of real ISO-BMFF boxes (ftyp, a small mdat,
// moov with mvhd and video/audio traks) and minimal PNG/JPEG/WebP headers. No real footage, nothing third-party.
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
};
const full = (type: string, version: number, ...parts: Buffer[]) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);
const zeros = (n: number) => Buffer.alloc(n);

function mvhd(timescale: number, duration: number) {
  return full('mvhd', 0, u32(0), u32(0), u32(timescale), u32(duration), zeros(80));
}
function tkhd(width: number, height: number) {
  return full('tkhd', 0, zeros(72), u32(width * 65536), u32(height * 65536));
}
function mdhd(timescale: number, duration: number) {
  return full('mdhd', 0, u32(0), u32(0), u32(timescale), u32(duration), zeros(4));
}
const hdlr = (handler: string) => full('hdlr', 0, u32(0), Buffer.from(handler, 'latin1'), zeros(12), Buffer.from('h\0'));
const stsd = (format: string) => full('stsd', 0, u32(1), u32(16), Buffer.from(format, 'latin1'), zeros(8));
const stts = (samples: number, delta: number) => full('stts', 0, u32(1), u32(samples), u32(delta));

function trak(kind: 'vide' | 'soun', o: { width: number; height: number; fps: number; seconds: number }) {
  const ts = kind === 'vide' ? o.fps * 1000 : 48_000;
  const samples = kind === 'vide' ? Math.round(o.fps * o.seconds) : Math.round((48_000 * o.seconds) / 1024);
  const delta = kind === 'vide' ? 1000 : 1024;
  return box('trak', tkhd(kind === 'vide' ? o.width : 0, kind === 'vide' ? o.height : 0), box('mdia', mdhd(ts, samples * delta), hdlr(kind), box('minf', box('stbl', stsd(kind === 'vide' ? 'avc1' : 'mp4a'), stts(samples, delta)))));
}

/** An MP4 (or MOV with `brand: 'qt  '`) whose moov says `seconds` long at width×height and `fps`; moov at the end. */
export function mp4(o: { seconds?: number; width?: number; height?: number; fps?: number; audio?: boolean; brand?: string; padBytes?: number } = {}): Buffer {
  const p = { seconds: o.seconds ?? 12, width: o.width ?? 1080, height: o.height ?? 1920, fps: o.fps ?? 30 };
  const ftyp = box('ftyp', Buffer.from(o.brand ?? 'isom', 'latin1'), u32(512), Buffer.from(o.brand ?? 'isom', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(o.padBytes ?? 256, 7));
  const moov = box('moov', mvhd(1000, Math.round(p.seconds * 1000)), trak('vide', p), ...(o.audio === false ? [] : [trak('soun', p)]));
  return Buffer.concat([ftyp, mdat, moov]);
}

export function png(width = 64, height = 32): Buffer {
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), ihdr, u32(0), u32(0), Buffer.from('IEND'), u32(0)]);
}

export function jpeg(width = 40, height = 30): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), zeros(9)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

export function webp(width = 50, height = 20): Buffer {
  const vp8x = Buffer.concat([Buffer.from('VP8X', 'latin1'), Buffer.from([10, 0, 0, 0]), zeros(4)]);
  const dims = Buffer.alloc(6);
  dims.writeUIntLE(width - 1, 0, 3);
  dims.writeUIntLE(height - 1, 3, 3);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x, dims]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, body]);
}

/** A synthetic 16-bit mono WAV of `ms` milliseconds of silence at 48 kHz. */
export function wav(ms = 500, rate = 48_000): Buffer {
  const data = Buffer.alloc(Math.round((rate * ms) / 1000) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
