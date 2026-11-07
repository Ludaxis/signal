#!/usr/bin/env node
// Builds the loadable fixture pack from the committed sources in `pack-example/` ([Pack example]).
// Only text sources are committed (SVG art, JSON records, the style guide); this script writes the
// binary files a pack needs into an output folder outside the repository, so no image, audio or font copy is ever
// committed as a plain binary:
//   - each SVG character, background, phone frame and icon → PNG (sharp, no network);
//   - the Tier A rig `char-cutout` → rig.json with its SVG parts and states (make-rig.mjs, original geometric art);
//   - the 100 BPM click-plus-chord loop → a 48 kHz mono WAV synthesised here in plain JavaScript (deterministic);
//   - the SFX library: one short 48 kHz mono WAV per cue id (pop, whoosh, tap, swipe, success, clap, hit,
//     riser, confetti, tick), synthesised here from sines, noise from a seeded generator and envelopes (deterministic);
//   - the fonts → copies of files already bundled with the web app (core Vazirmatn from public/fonts, Instrument
//     Sans from the pinned @fontsource/instrument-sans package), each with its OFL licence beside it; their sha256
//     must equal the pins in pack.json;
//   - library/library.json → every asset with its sha256, dims or durationMs and a complete licence record.
//
//   node tests/fixtures/postmaker/make-pack.mjs <out-dir>
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildRig } from './make-rig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACK_SOURCE = path.join(HERE, 'pack-example');
const WEB = path.resolve(HERE, '../../..');

/** Bundled font files the pack copies (source → path inside the pack). */
export const FONT_SOURCES = {
  vazirmatn: [
    { from: 'public/fonts/vazirmatn/Vazirmatn-Variable.woff2', to: 'library/fonts/Vazirmatn/Vazirmatn-Variable.woff2' },
    { from: 'public/fonts/vazirmatn/OFL.txt', to: 'library/fonts/Vazirmatn/OFL.txt' },
  ],
  'instrument-sans-400': [
    { from: 'node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2', to: 'library/fonts/InstrumentSans/instrument-sans-latin-400-normal.woff2' },
    { from: 'node_modules/@fontsource/instrument-sans/LICENSE', to: 'library/fonts/InstrumentSans/OFL.txt' },
  ],
  'instrument-sans-700': [
    { from: 'node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-700-normal.woff2', to: 'library/fonts/InstrumentSans/instrument-sans-latin-700-normal.woff2' },
    { from: 'node_modules/@fontsource/instrument-sans/LICENSE', to: 'library/fonts/InstrumentSans/OFL.txt' },
  ],
};

const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---- the loop ----------------------------------------------------------------------------------------------------

function wav(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const CHORDS = [
  [261.63, 329.63, 392.0], // C major
  [220.0, 261.63, 329.63], // A minor
];

/** A click on every beat (accented downbeat) over a sine chord pad, `bars` bars at `bpm`; first downbeat at 0 ms. */
export function loopWav({ bpm = 100, bars = 2, beatsPerBar = 4, sampleRate = 48000 } = {}) {
  const beatSec = 60 / bpm;
  const barSec = beatSec * beatsPerBar;
  const n = Math.round(bars * barSec * sampleRate);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const bar = Math.floor(t / barSec) % CHORDS.length;
    const inBar = t - Math.floor(t / barSec) * barSec;
    const env = Math.min(1, inBar / 0.02, (barSec - inBar) / 0.02);
    let v = 0;
    for (const f of CHORDS[bar]) v += 0.09 * Math.sin(2 * Math.PI * f * t);
    s[i] = v * env;
    const inBeat = t - Math.floor(t / beatSec) * beatSec;
    if (inBeat < 0.03) {
      const downbeat = Math.floor(t / beatSec) % beatsPerBar === 0;
      s[i] += (downbeat ? 0.55 : 0.32) * Math.exp(-inBeat * 160) * Math.sin(2 * Math.PI * (downbeat ? 1600 : 1100) * inBeat);
    }
  }
  return { bytes: wav(s, sampleRate), durationMs: Math.round((n / sampleRate) * 1000) };
}

// ---- the SFX library --------------------------------------------------------------------------------------

/** A small seeded generator (mulberry32), so the noise in the effects is the same on every build. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each cue: length (ms) and a sample function of (t seconds, length seconds, noise 0…1). Original synthesis only. */
const SFX = {
  pop: { ms: 120, f: (t) => Math.sin(2 * Math.PI * (900 - 2500 * t) * t) * Math.exp(-t * 40) },
  whoosh: { ms: 450, f: (t, L, n) => (n * 2 - 1) * Math.sin((Math.PI * t) / L) ** 2 * 0.8 },
  tap: { ms: 60, f: (t) => Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 90) },
  swipe: { ms: 260, f: (t, L, n) => ((n * 2 - 1) * 0.5 + Math.sin(2 * Math.PI * (500 + 2400 * (t / L)) * t) * 0.5) * Math.sin((Math.PI * t) / L) },
  success: { ms: 420, f: (t) => (t < 0.14 ? Math.sin(2 * Math.PI * 784 * t) : Math.sin(2 * Math.PI * 1047 * t)) * Math.exp(-((t % 0.14) * 9)) },
  clap: { ms: 140, f: (t, L, n) => (n * 2 - 1) * (Math.exp(-t * 60) + 0.6 * Math.exp(-Math.abs(t - 0.012) * 200)) },
  hit: { ms: 380, f: (t, L, n) => (Math.sin(2 * Math.PI * (110 - 60 * t) * t) * 0.8 + (n * 2 - 1) * 0.3 * Math.exp(-t * 30)) * Math.exp(-t * 9) },
  riser: { ms: 900, f: (t, L, n) => ((n * 2 - 1) * 0.4 + Math.sin(2 * Math.PI * (300 + 1200 * (t / L)) * t) * 0.6) * (t / L) },
  confetti: { ms: 500, f: (t, L, n) => (n > 0.985 ? (n - 0.985) * 60 : 0) * Math.sin(2 * Math.PI * 3000 * t) * (1 - t / L) },
  tick: { ms: 30, f: (t) => Math.sin(2 * Math.PI * 2600 * t) * Math.exp(-t * 200) },
};
export const SFX_CUE_IDS = Object.keys(SFX);

/** One cue as a mono WAV, normalised to a −3 dBFS peak (the mix sets its own level). */
export function sfxWav(cue, { sampleRate = 48000 } = {}) {
  const def = SFX[cue];
  if (!def) throw new Error(`Unknown SFX cue ${cue}`);
  const n = Math.round((def.ms / 1000) * sampleRate);
  const L = def.ms / 1000;
  const r = rng(SFX_CUE_IDS.indexOf(cue) + 101);
  const s = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const fade = Math.min(1, (n - i) / (0.004 * sampleRate)); // 4 ms fade-out, no click at the end
    s[i] = def.f(t, L, r()) * fade;
    peak = Math.max(peak, Math.abs(s[i]));
  }
  const g = peak > 0 ? 0.708 / peak : 0;
  for (let i = 0; i < n; i++) s[i] *= g;
  return { bytes: wav(s, sampleRate), durationMs: Math.round((n / sampleRate) * 1000) };
}

// ---- the build ---------------------------------------------------------------------------------------------------

function copyText(src, dst) {
  for (const name of readdirSync(src)) {
    const a = path.join(src, name);
    const b = path.join(dst, name);
    if (statSync(a).isDirectory()) {
      mkdirSync(b, { recursive: true });
      copyText(a, b);
    } else if (name !== 'library.src.json') copyFileSync(a, b);
  }
}

/**
 * Builds the pack into `out` (emptied first) and returns `{ dir, library }`. `webDir` is the app folder the
 * bundled fonts are read from.
 */
export async function buildPack(out, { webDir = WEB } = {}) {
  if (!out) throw new Error('buildPack needs an output folder');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyText(PACK_SOURCE, out);
  const src = JSON.parse(readFileSync(path.join(PACK_SOURCE, 'library/library.src.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(PACK_SOURCE, 'pack.json'), 'utf8'));
  const lib = path.join(out, 'library');

  for (const set of Object.values(FONT_SOURCES))
    for (const f of set) {
      const from = path.join(webDir, f.from);
      if (!existsSync(from)) throw new Error(`Bundled font file missing: ${f.from}`);
      mkdirSync(path.dirname(path.join(out, f.to)), { recursive: true });
      copyFileSync(from, path.join(out, f.to));
    }
  for (const f of manifest.fonts) {
    const got = sha(readFileSync(path.join(out, f.file)));
    if (got !== f.sha256) throw new Error(`Font ${f.file} does not match its pin in pack.json (${got}).`);
  }

  const library = [];
  for (const a of src.assets) {
    const file = path.join(lib, a.file);
    mkdirSync(path.dirname(file), { recursive: true });
    let dims;
    let durationMs;
    if (a.build.rig) {
      buildRig(path.dirname(file)); // the Tier A rig: rig.json plus its SVG parts, states and turnaround
    } else if (a.build.svg) {
      const svg = readFileSync(path.join(PACK_SOURCE, 'library', a.build.svg));
      await sharp(svg).png({ compressionLevel: 9 }).toFile(file);
      const m = await sharp(file).metadata();
      dims = { w: m.width, h: m.height };
    } else if (a.build.loop) {
      const l = loopWav(a.build.loop);
      writeFileSync(file, l.bytes);
      durationMs = l.durationMs;
    } else if (a.build.sfx) {
      const l = sfxWav(a.build.sfx);
      writeFileSync(file, l.bytes);
      durationMs = l.durationMs;
    } else if (a.build.font) {
      if (!existsSync(file)) throw new Error(`Font asset ${a.id} was not copied.`);
    }
    const bytes = readFileSync(file);
    const licence = {
      ...src.licence,
      source: a.build.rig ? 'generated by make-rig.mjs (original geometric SVG parts in the Signal test fixtures)' : a.build.svg ? `library/${a.build.svg} (original SVG in the Signal test fixtures)` : a.build.loop || a.build.sfx ? 'synthesised by make-pack.mjs' : `bundled font copied from ${FONT_SOURCES[a.build.font][0].from}`,
      ...(a.licenceRecord ? { proof: `library/${a.licenceRecord}` } : {}),
      ...(a.licence ?? {}),
    };
    library.push({
      id: a.id,
      kind: a.kind,
      file: a.file,
      sha256: sha(bytes),
      ...(dims ? { dims } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      tags: a.tags,
      ...(a.palette ? { palette: a.palette } : {}),
      ...(a.music ? { music: a.music } : {}),
      licence,
      status: 'approved',
      approvedBy: 'fixture owner',
    });
  }
  writeFileSync(path.join(lib, 'library.json'), `${JSON.stringify(library, null, 2)}\n`);
  return { dir: out, library };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('Usage: node make-pack.mjs <out-dir>');
    process.exit(2);
  }
  buildPack(path.resolve(out))
    .then((r) => console.log(`${r.dir} (${r.library.length} assets)`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
