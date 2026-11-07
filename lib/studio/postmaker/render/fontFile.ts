// Bundled-font reading for the width test and the font coverage check (server side, no browser).
// The core faces ship as WOFF2, which opentype.js cannot open, so this module reads the WOFF2 table directory,
// decompresses the Brotli stream with node:zlib and rebuilds a plain SFNT without outlines (glyf/loca are emptied:
// the width test needs cmap, GSUB shaping and advances only). Variable faces are measured at the requested weight
// by applying the HVAR advance deltas (wght axis, avar respected). Kerning is the default instance's (GPOS deltas
// are not applied; the renderer's DOM measurement in the @render suite stays authoritative for final frames).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import opentype from 'opentype.js';

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

export type Tables = Map<string, Buffer>;

function base128(b: Buffer, o: { p: number }): number {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const byte = b[o.p++]!;
    v = v * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return v;
  }
  throw new Error('Bad UIntBase128');
}

/** Tables of a WOFF2 (or plain TTF/OTF) file. Transformed glyf/loca/hmtx are dropped (not needed here). */
export function readTables(bytes: Buffer): Tables {
  const sig = bytes.subarray(0, 4).toString('latin1');
  const out: Tables = new Map();
  if (sig !== 'wOF2') {
    const n = bytes.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const at = 12 + 16 * i;
      out.set(bytes.subarray(at, at + 4).toString('latin1'), bytes.subarray(bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 8) + bytes.readUInt32BE(at + 12)));
    }
    return out;
  }
  const numTables = bytes.readUInt16BE(12);
  const compressed = bytes.readUInt32BE(20);
  const o = { p: 48 };
  const dir: { tag: string; len: number; transformed: boolean }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = bytes[o.p++]!;
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = bytes.subarray(o.p, o.p + 4).toString('latin1');
      o.p += 4;
    }
    const version = flags >> 6;
    const orig = base128(bytes, o);
    const isGlyfLoca = tag === 'glyf' || tag === 'loca';
    const transformed = isGlyfLoca ? version === 0 : version !== 0;
    const len = transformed ? base128(bytes, o) : orig;
    dir.push({ tag: tag!, len, transformed });
  }
  const data = brotliDecompressSync(bytes.subarray(o.p, o.p + compressed));
  let at = 0;
  for (const t of dir) {
    if (!t.transformed) out.set(t.tag, data.subarray(at, at + t.len));
    at += t.len;
  }
  return out;
}

// ---- cmap ------------------------------------------------------------------------------------------------------

/** Every code point the font maps to a glyph (formats 4 and 12). */
export function cmapOf(tables: Tables): Map<number, number> {
  const cmap = tables.get('cmap');
  const map = new Map<number, number>();
  if (!cmap) return map;
  const n = cmap.readUInt16BE(2);
  const subs: number[] = [];
  for (let i = 0; i < n; i++) subs.push(cmap.readUInt32BE(4 + 8 * i + 4));
  for (const off of subs) {
    const fmt = cmap.readUInt16BE(off);
    if (fmt === 12) {
      const groups = cmap.readUInt32BE(off + 12);
      for (let g = 0; g < groups; g++) {
        const b = off + 16 + 12 * g;
        const s = cmap.readUInt32BE(b);
        const e = cmap.readUInt32BE(b + 4);
        const gid = cmap.readUInt32BE(b + 8);
        for (let c = s; c <= e; c++) if (!map.has(c)) map.set(c, gid + c - s);
      }
    } else if (fmt === 4) {
      const segX2 = cmap.readUInt16BE(off + 6);
      const ends = off + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = cmap.readUInt16BE(ends + 2 * s);
        const start = cmap.readUInt16BE(starts + 2 * s);
        const delta = cmap.readInt16BE(deltas + 2 * s);
        const ro = cmap.readUInt16BE(ranges + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid: number;
          if (ro === 0) gid = (c + delta) & 0xffff;
          else {
            const gi = cmap.readUInt16BE(ranges + 2 * s + ro + 2 * (c - start));
            gid = gi === 0 ? 0 : (gi + delta) & 0xffff;
          }
          if (gid && !map.has(c)) map.set(c, gid);
        }
      }
    }
  }
  return map;
}

// ---- variable advances (HVAR) ------------------------------------------------------------------------------------

const f2dot14 = (b: Buffer, at: number) => b.readInt16BE(at) / 16384;
const fixed = (b: Buffer, at: number) => b.readInt32BE(at) / 65536;

interface Axis {
  tag: string;
  min: number;
  def: number;
  max: number;
}

function axesOf(tables: Tables): Axis[] {
  const fvar = tables.get('fvar');
  if (!fvar) return [];
  const off = fvar.readUInt16BE(4);
  const count = fvar.readUInt16BE(8);
  const size = fvar.readUInt16BE(10);
  return Array.from({ length: count }, (_, i) => {
    const at = off + i * size;
    return { tag: fvar.subarray(at, at + 4).toString('latin1'), min: fixed(fvar, at + 4), def: fixed(fvar, at + 8), max: fixed(fvar, at + 12) };
  });
}

function normalise(tables: Tables, axes: Axis[], user: Record<string, number>): number[] {
  const coords = axes.map((a) => {
    const v = Math.min(a.max, Math.max(a.min, user[a.tag] ?? a.def));
    if (v < a.def) return (v - a.def) / (a.def - a.min);
    if (v > a.def) return (v - a.def) / (a.max - a.def);
    return 0;
  });
  const avar = tables.get('avar');
  if (!avar) return coords;
  let at = 8;
  return coords.map((c) => {
    const n = avar.readUInt16BE(at);
    const maps = Array.from({ length: n }, (_, k) => [f2dot14(avar, at + 2 + 4 * k), f2dot14(avar, at + 4 + 4 * k)] as [number, number]);
    at += 2 + 4 * n;
    for (let k = 1; k < maps.length; k++) {
      const [x0, y0] = maps[k - 1]!;
      const [x1, y1] = maps[k]!;
      if (c <= x1) return x1 === x0 ? y0 : y0 + ((c - x0) * (y1 - y0)) / (x1 - x0);
    }
    return c;
  });
}

/** Advance-width deltas (font units) for every glyph at the given normalised coordinates. */
function hvarDeltas(tables: Tables, coords: number[], numGlyphs: number): Float64Array {
  const out = new Float64Array(numGlyphs);
  const hvar = tables.get('HVAR');
  if (!hvar || coords.every((c) => c === 0)) return out;
  const store = hvar.readUInt32BE(4);
  const mapOff = hvar.readUInt32BE(8);
  const regionsOff = store + hvar.readUInt32BE(store + 2);
  const axisCount = hvar.readUInt16BE(regionsOff);
  const regionCount = hvar.readUInt16BE(regionsOff + 2);
  const scalars = Array.from({ length: regionCount }, (_, r) => {
    let s = 1;
    for (let a = 0; a < axisCount; a++) {
      const at = regionsOff + 4 + (r * axisCount + a) * 6;
      const start = f2dot14(hvar, at);
      const peak = f2dot14(hvar, at + 2);
      const end = f2dot14(hvar, at + 4);
      const c = coords[a] ?? 0;
      if (start > peak || peak > end || (start < 0 && end > 0 && peak !== 0) || peak === 0) continue;
      if (c < start || c > end) return 0;
      if (c === peak) continue;
      s *= c < peak ? (c - start) / (peak - start) : (end - c) / (end - peak);
    }
    return s;
  });
  const dataCount = hvar.readUInt16BE(store + 6);
  const datas = Array.from({ length: dataCount }, (_, d) => {
    const at = store + hvar.readUInt32BE(store + 8 + 4 * d);
    const itemCount = hvar.readUInt16BE(at);
    const wordRaw = hvar.readUInt16BE(at + 2);
    const longWords = Boolean(wordRaw & 0x8000);
    const wordCount = wordRaw & 0x7fff;
    const ri = hvar.readUInt16BE(at + 4);
    const regions = Array.from({ length: ri }, (_, k) => hvar.readUInt16BE(at + 6 + 2 * k));
    const wide = longWords ? 4 : 2;
    const narrow = longWords ? 2 : 1;
    const rowSize = wordCount * wide + (ri - wordCount) * narrow;
    const rows = at + 6 + 2 * ri;
    return (item: number) => {
      if (item >= itemCount) return 0;
      let p = rows + item * rowSize;
      let sum = 0;
      for (let k = 0; k < ri; k++) {
        const isWide = k < wordCount;
        const v = isWide ? (longWords ? hvar.readInt32BE(p) : hvar.readInt16BE(p)) : longWords ? hvar.readInt16BE(p) : hvar.readInt8(p);
        p += isWide ? wide : narrow;
        sum += v * (scalars[regions[k]!] ?? 0);
      }
      return sum;
    };
  });
  let entry: (g: number) => [number, number] = (g) => [0, g];
  if (mapOff) {
    const fmt = hvar[mapOff]!;
    const ef = hvar[mapOff + 1]!;
    const count = fmt === 0 ? hvar.readUInt16BE(mapOff + 2) : hvar.readUInt32BE(mapOff + 2);
    const base = mapOff + (fmt === 0 ? 4 : 6);
    const size = ((ef & 0x30) >> 4) + 1;
    const innerBits = (ef & 0x0f) + 1;
    entry = (g) => {
      const i = Math.min(g, count - 1);
      let v = 0;
      for (let k = 0; k < size; k++) v = v * 256 + hvar[base + i * size + k]!;
      return [v >> innerBits, v & ((1 << innerBits) - 1)];
    };
  }
  for (let g = 0; g < numGlyphs; g++) {
    const [outer, inner] = entry(g);
    out[g] = datas[outer]?.(inner) ?? 0;
  }
  return out;
}

// ---- SFNT rebuild for opentype.js --------------------------------------------------------------------------------

function sfntOf(tables: Tables): ArrayBuffer {
  const head = tables.get('head')!;
  const numGlyphs = tables.get('maxp')!.readUInt16BE(4);
  const longLoca = head.readInt16BE(50) === 1;
  const t = new Map(tables);
  t.set('glyf', Buffer.alloc(4));
  t.set('loca', Buffer.alloc((numGlyphs + 1) * (longLoca ? 4 : 2)));
  if (!t.has('hmtx')) throw new Error('Font has a transformed hmtx table');
  const tags = [...t.keys()].sort();
  let size = 12 + 16 * tags.length;
  const offsets: number[] = [];
  for (const tag of tags) {
    offsets.push(size);
    size += (t.get(tag)!.length + 3) & ~3;
  }
  const out = Buffer.alloc(size);
  out.writeUInt32BE(0x00010000, 0);
  out.writeUInt16BE(tags.length, 4);
  tags.forEach((tag, i) => {
    const b = t.get(tag)!;
    const at = 12 + 16 * i;
    out.write(tag, at, 4, 'latin1');
    out.writeUInt32BE(offsets[i]!, at + 8);
    out.writeUInt32BE(b.length, at + 12);
    b.copy(out, offsets[i]!);
  });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

export interface LoadedFont {
  family: string;
  file: string;
  sha256: string;
  unitsPerEm: number;
  /** Code point → glyph id. */
  cmap: Map<number, number>;
  axes: Axis[];
  has(codePoint: number): boolean;
  /** Width in px of `text` at `sizePx` and the given weight (default instance when the font has no wght axis). */
  measure(text: string, sizePx: number, weight?: number): number;
}

export function loadFont(file: string, family: string): LoadedFont {
  const bytes = readFileSync(file);
  const tables = readTables(bytes);
  const cmap = cmapOf(tables);
  const axes = axesOf(tables);
  const font = opentype.parse(sfntOf(tables));
  // opentype.js 1.3.4 lacks some GSUB lookup formats (for example chained contexts in a face's `rlig`): such a face
  // is shaped with init/medi/fina only (the joining forms that set widths), which the probe below detects.
  try {
    font.stringToGlyphs('لا ببب');
  } catch {
    (font as unknown as { defaultRenderOptions: unknown }).defaultRenderOptions = {
      kerning: true,
      features: [
        { script: 'arab', tags: ['init', 'medi', 'fina'] },
        { script: 'latn', tags: ['liga'] },
      ],
    };
  }
  const numGlyphs = tables.get('maxp')!.readUInt16BE(4);
  const hmtx = tables.get('hmtx')!;
  const numH = tables.get('hhea')!.readUInt16BE(34);
  const advance = (g: number) => hmtx.readUInt16BE(4 * Math.min(g, numH - 1));
  const cache = new Map<number, Float64Array>();
  const deltasAt = (weight: number) => {
    let d = cache.get(weight);
    if (!d) {
      d = hvarDeltas(tables, normalise(tables, axes, { wght: weight }), numGlyphs);
      cache.set(weight, d);
    }
    return d;
  };
  const upm = font.unitsPerEm;
  return {
    family,
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    unitsPerEm: upm,
    cmap,
    axes,
    has: (cp) => cmap.has(cp),
    measure(text, sizePx, weight) {
      const glyphs = font.stringToGlyphs(text);
      const w = weight ?? axes.find((a) => a.tag === 'wght')?.def ?? 400;
      const d = deltasAt(w);
      let units = 0;
      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i]!.index;
        units += advance(g) + (d[g] ?? 0);
        if (i + 1 < glyphs.length) units += font.getKerningValue(glyphs[i]!, glyphs[i + 1]!);
      }
      return (units * sizePx) / upm;
    },
  };
}
