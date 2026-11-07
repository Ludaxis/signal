// Product mocks for audio, deterministic and made in memory (no process, no network):
// - speech: a 220 Hz sine tone whose length is 60 ms per spoken character (fa) or 55 ms (en), with a synthetic
//   character alignment in the vendor's alignment shape, so captions and lip-sync downstream behave like a real line;
// - music: a click track at the declared BPM (accented first beat of each 4-beat bar) from the declared downbeat.
// Mock output is flagged mode 'mock' by the caller and can never become a post.
import type { Lang } from '../../types';

export const MOCK_SAMPLE_RATE = 48_000;
export const MOCK_TONE_HZ = 220;
export const MS_PER_CHAR: Record<Lang, number> = { fa: 60, en: 55 };

/** Character alignment in the ElevenLabs `with-timestamps` shape (seconds). */
export interface CharAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** A mono 16-bit PCM WAV of the given samples (-1…1). */
export function wavBytes(samples: Float32Array, sampleRate = MOCK_SAMPLE_RATE): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Duration of a WAV made by wavBytes, in ms. */
export const wavDurationMs = (wav: Buffer): number => Math.round((wav.readUInt32LE(40) / 2 / wav.readUInt32LE(24)) * 1000);

export function sineWav(ms: number, o: { hz?: number; amplitude?: number; sampleRate?: number } = {}): Buffer {
  const rate = o.sampleRate ?? MOCK_SAMPLE_RATE;
  const n = Math.max(1, Math.round((ms / 1000) * rate));
  const hz = o.hz ?? MOCK_TONE_HZ;
  const a = o.amplitude ?? 0.25;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = a * Math.sin((2 * Math.PI * hz * i) / rate);
  return wavBytes(s, rate);
}

/** Every code point of the spoken text counts as one character (the alignment covers all of them). */
export const spokenChars = (text: string): string[] => [...text];

export const mockSpeechMs = (text: string, lang: Lang): number => Math.max(1, spokenChars(text).length) * MS_PER_CHAR[lang];

export function syntheticAlignment(text: string, msPerChar: number): CharAlignment {
  const chars = spokenChars(text);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => r3((i * msPerChar) / 1000)),
    character_end_times_seconds: chars.map((_, i) => r3(((i + 1) * msPerChar) / 1000)),
  };
}

export function mockSpeech(text: string, lang: Lang): { wav: Buffer; alignment: CharAlignment; durationMs: number } {
  const durationMs = mockSpeechMs(text, lang);
  return { wav: sineWav(durationMs), alignment: syntheticAlignment(text, MS_PER_CHAR[lang]), durationMs };
}

/** The first-beat times (ms) of a click track. Exported for tests. */
export function beatTimesMs(bpm: number, ms: number, downbeatMs = 0): number[] {
  const step = 60_000 / bpm;
  const out: number[] = [];
  for (let t = downbeatMs; t < ms; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

/** A click track: a 12 ms 1 kHz burst on every beat, louder on the first beat of each 4-beat bar. */
export function clickTrackWav(o: { bpm?: number; ms: number; downbeatMs?: number; sampleRate?: number }): Buffer {
  const bpm = o.bpm && o.bpm >= 20 && o.bpm <= 300 ? o.bpm : 100;
  const rate = o.sampleRate ?? MOCK_SAMPLE_RATE;
  const n = Math.max(1, Math.round((o.ms / 1000) * rate));
  const s = new Float32Array(n);
  const burst = Math.round(0.012 * rate);
  beatTimesMs(bpm, o.ms, o.downbeatMs ?? 0).forEach((t, i) => {
    const start = Math.round((t / 1000) * rate);
    const a = i % 4 === 0 ? 0.8 : 0.4;
    for (let j = 0; j < burst && start + j < n; j++) s[start + j] = a * Math.sin((2 * Math.PI * 1000 * j) / rate) * (1 - j / burst);
  });
  return wavBytes(s, rate);
}
