// Plain PCM WAV reading and writing for the sound steps: the SFX stem is mixed here in JavaScript, and the
// music conform has a JavaScript path for 16-bit WAV when ffmpeg is not available. Reads 16-bit PCM and 32-bit float
// WAV (WAVE_FORMAT_PCM, WAVE_FORMAT_IEEE_FLOAT, WAVE_FORMAT_EXTENSIBLE), skipping any other chunk; writes 16-bit PCM.
// Anything else (MP3, AAC, OGG, FLAC, 24-bit) goes through ffmpeg first. Pure module, no process, no network.

export interface Pcm {
  sampleRate: number;
  /** One Float32Array per channel, samples in −1…1. */
  channels: Float32Array[];
}

export const MIX_RATE = 48_000;

const tag = (b: Buffer, at: number) => b.subarray(at, at + 4).toString('latin1');

export const isWavBytes = (b: Buffer | null | undefined): b is Buffer => Boolean(b && b.length > 44 && tag(b, 0) === 'RIFF' && tag(b, 8) === 'WAVE');

/** Decodes a PCM16 or float32 WAV; null when the bytes are not one of those. */
export function decodeWav(b: Buffer): Pcm | null {
  if (!isWavBytes(b)) return null;
  let at = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (at + 8 <= b.length) {
    const id = tag(b, at);
    const size = b.readUInt32LE(at + 4);
    const body = b.subarray(at + 8, Math.min(b.length, at + 8 + size));
    if (id === 'fmt ' && body.length >= 16) {
      let format = body.readUInt16LE(0);
      if (format === 0xfffe && body.length >= 26) format = body.readUInt16LE(24); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { format, channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.channels < 1 || fmt.channels > 8 || fmt.rate < 8000 || fmt.rate > 192_000) return null;
  const pcm16 = fmt.format === 1 && fmt.bits === 16;
  const f32 = fmt.format === 3 && fmt.bits === 32;
  if (!pcm16 && !f32) return null;
  const width = pcm16 ? 2 : 4;
  const frames = Math.floor(data.length / (width * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * width;
      channels[c]![i] = pcm16 ? data.readInt16LE(o) / 32768 : data.readFloatLE(o);
    }
  return { sampleRate: fmt.rate, channels };
}

/** A 16-bit PCM WAV of the channels (clipped to −1…1). */
export function encodeWav(p: Pcm): Buffer {
  const n = p.channels[0]?.length ?? 0;
  const ch = p.channels.length;
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, p.channels[c]![i]!)) * 32767), (i * ch + c) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(p.sampleRate, 24);
  h.writeUInt32LE(p.sampleRate * ch * 2, 28);
  h.writeUInt16LE(ch * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export const durationMsOf = (p: Pcm) => ((p.channels[0]?.length ?? 0) / p.sampleRate) * 1000;

/** Linear-interpolation resampling of one channel by `factor` output samples per input sample. */
export function resampleLinear(x: Float32Array, factor: number): Float32Array {
  const n = Math.max(0, Math.round(x.length * factor));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / factor;
    const k = Math.floor(t);
    const a = x[k] ?? 0;
    const b = x[k + 1] ?? a;
    out[i] = a + (b - a) * (t - k);
  }
  return out;
}

/** The same audio as stereo at `rate` (mono is duplicated; more than two channels keep the first two). */
export function toStereo(p: Pcm, rate = MIX_RATE): Pcm {
  const src = p.channels.length === 1 ? [p.channels[0]!, p.channels[0]!] : p.channels.slice(0, 2);
  const channels = p.sampleRate === rate ? src.map((c) => new Float32Array(c)) : src.map((c) => resampleLinear(c, rate / p.sampleRate));
  return { sampleRate: rate, channels };
}

/** The sample peak in dBFS (−Infinity for silence). */
export function peakDbfs(p: Pick<Pcm, 'channels'>): number {
  let m = 0;
  for (const c of p.channels) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]!));
  return m === 0 ? -Infinity : 20 * Math.log10(m);
}

export const dbToLinear = (db: number) => 10 ** (db / 20);
