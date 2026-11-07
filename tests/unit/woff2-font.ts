// Test helper: load a bundled WOFF2 face (public/fonts) as an opentype.js Font for measuring advance widths.
// opentype.js 1.3.4 reads TTF/OTF/WOFF but not WOFF2, so this unpacks the WOFF2 table stream with Node's Brotli and
// rebuilds an SFNT. Every table is copied as stored except glyf/loca: WOFF2 stores them transformed, and outlines are
// not needed for widths, so they are replaced by an empty glyf and an all-zero loca. Advance widths (hmtx), shaping
// (GSUB) and kerning (GPOS) come from the real font; a variable font measures at its default instance.
// Local files only: no network.
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import opentype from 'opentype.js';

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

interface Woff2Table {
  tag: string;
  origLength: number;
  transformLength: number | null;
}

/** An SFNT (TrueType) buffer with the tables of a WOFF2 file; glyf/loca are emptied (widths only). */
export function woff2ToSfntForMetrics(woff2: Buffer): Buffer {
  if (woff2.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  const flavor = woff2.readUInt32BE(4);
  const numTables = woff2.readUInt16BE(12);
  const totalCompressed = woff2.readUInt32BE(20);
  let o = 48;
  const base128 = (): number => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = woff2[o++]!;
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('bad UIntBase128');
  };
  const tables: Woff2Table[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = woff2[o++]!;
    let tag: string;
    if ((flags & 0x3f) === 63) {
      tag = woff2.toString('latin1', o, o + 4);
      o += 4;
    } else tag = KNOWN_TAGS[flags & 0x3f]!;
    const tv = (flags >> 6) & 3;
    const origLength = base128();
    const glyfOrLoca = tag === 'glyf' || tag === 'loca';
    const transformed = glyfOrLoca ? tv === 0 : tv !== 0;
    tables.push({ tag, origLength, transformLength: transformed ? base128() : null });
  }
  if (tables.some((t) => t.transformLength !== null && t.tag !== 'glyf' && t.tag !== 'loca')) throw new Error('transformed hmtx is not supported');
  const stream = brotliDecompressSync(woff2.subarray(o, o + totalCompressed));

  const data = new Map<string, Buffer>();
  let p = 0;
  for (const t of tables) {
    const len = t.transformLength ?? t.origLength;
    data.set(t.tag, stream.subarray(p, p + len));
    p += len;
  }
  const head = Buffer.from(data.get('head')!);
  const maxp = data.get('maxp')!;
  const numGlyphs = maxp.readUInt16BE(4);
  head.writeUInt32BE(0, 8); // checkSumAdjustment: not verified by opentype.js
  head.writeInt16BE(0, 50); // indexToLocFormat: short offsets
  data.set('head', head);
  if (data.has('glyf')) {
    data.set('glyf', Buffer.alloc(0));
    data.set('loca', Buffer.alloc((numGlyphs + 1) * 2)); // every glyph empty
  }

  const tags = [...data.keys()].sort();
  const dirLen = 12 + 16 * tags.length;
  const pad4 = (n: number) => (n + 3) & ~3;
  let size = dirLen;
  for (const t of tags) size += pad4(data.get(t)!.length);
  const out = Buffer.alloc(size);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(tags.length, 4);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= tags.length) {
    pow *= 2;
    log++;
  }
  out.writeUInt16BE(pow * 16, 6);
  out.writeUInt16BE(log, 8);
  out.writeUInt16BE(tags.length * 16 - pow * 16, 10);
  let off = dirLen;
  tags.forEach((t, i) => {
    const d = data.get(t)!;
    const e = 12 + 16 * i;
    out.write(t, e, 4, 'latin1');
    out.writeUInt32BE(0, e + 4); // checksum: not verified by opentype.js
    out.writeUInt32BE(off, e + 8);
    out.writeUInt32BE(d.length, e + 12);
    d.copy(out, off);
    off += pad4(d.length);
  });
  return out;
}

/** opentype.js Font of a bundled WOFF2 face, for advance-width measuring in tests. */
export function loadWoff2ForMetrics(file: string): opentype.Font {
  const sfnt = woff2ToSfntForMetrics(readFileSync(file));
  return opentype.parse(sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength));
}
