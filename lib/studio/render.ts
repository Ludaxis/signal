// Server-only: on-brand post rendering with sharp + the brand's font (or the Studio fallback font).
// Text is converted to vector paths with opentype.js, so output is identical on every machine.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import sharp, { type OverlayOptions } from 'sharp';

export interface TextLine { text: string; y: number; size: number; maxWidth?: number; color?: string; stroke?: number }

export interface Kit {
  font: opentype.Font;
  icon: Buffer | null;
  brandName: string;
  /** Brand colours from the project's brand kit. */
  colors?: { primary: string; background: string; text: string; accent: string };
}

/** Studio fallback font (Instrument Sans SemiBold) for projects without their own font. */
export const FALLBACK_FONT = 'node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff';

const parseFont = (b: Buffer) => opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** A kit with the Studio font and no logo. */
export async function loadKit(brandName: string): Promise<Kit> {
  const font = parseFont(await fs.readFile(/* turbopackIgnore: true */ path.join(process.cwd(), FALLBACK_FONT)));
  return { font, icon: null, brandName };
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** Centered text as an SVG path, shrunk to fit maxWidth. */
export function textSvg(kit: Kit, W: number, line: TextLine): string {
  let size = line.size;
  const maxW = line.maxWidth ?? W - 120;
  while (size > 18 && kit.font.getAdvanceWidth(line.text, size) > maxW) size -= 2;
  const w = kit.font.getAdvanceWidth(line.text, size);
  const d = kit.font.getPath(line.text, (W - w) / 2, line.y, size).toPathData(2);
  const stroke = line.stroke ?? Math.round(size / 14);
  return `<path d="${d}" fill="${line.color ?? '#ffffff'}" stroke="#0b0b0c" stroke-opacity="0.55" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke"/>`;
}

const shade = (hex: string, f: number) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f))).toString(16).padStart(2, '0')).join('')}`;
};

export function backgroundSvg(W: number, H: number, colors?: Kit['colors']): string {
  if (colors) {
    const p = colors.primary;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${shade(p, -0.6)}"/><stop offset="0.6" stop-color="${shade(p, -0.3)}"/><stop offset="1" stop-color="${p}"/></linearGradient>
    <radialGradient id="l1" cx="0.85" cy="0.1" r="0.6"><stop offset="0" stop-color="${colors.accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${colors.accent}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#l1)"/>
</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="#0e0a26"/><stop offset="0.55" stop-color="#241878"/><stop offset="1" stop-color="#3c24c0"/></linearGradient>
    <radialGradient id="l1" cx="0.85" cy="0.1" r="0.6"><stop offset="0" stop-color="#7c5cff" stop-opacity="0.55"/><stop offset="1" stop-color="#7c5cff" stop-opacity="0"/></radialGradient>
    <radialGradient id="l2" cx="0.1" cy="0.95" r="0.55"><stop offset="0" stop-color="#1fbfb8" stop-opacity="0.25"/><stop offset="1" stop-color="#1fbfb8" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#l1)"/><rect width="100%" height="100%" fill="url(#l2)"/>
</svg>`;
}

/** Instagram Reels safe area on 1080x1920: the top 268 px and bottom 420 px are covered by the app; text stays in x 60..1020. */
export const REEL_SAFE = { top: 268, bottom: 1920 - 420, left: 60, right: 1020 } as const;

export type BrandVariant = 'post' | 'reel';
export interface Box { left: number; top: number; width: number; height: number }
export interface BrandGeometry { variant: BrandVariant; pill: Box; icon: Box | null; name: Box }

/** Tall 9:16 canvases (Reels, Reel covers) get the Reel-safe brand mark; everything else keeps the post layout. */
export const brandVariantFor = (W: number, H: number): BrandVariant => (H / W >= 1.7 ? 'reel' : 'post');

const ICON = 64;
const ICON_GAP = 14;
const PILL_H = 46;
const AI_LABEL = 'AI-generated content';

/**
 * Where the brand mark goes.
 * post (1080x1350 and other non-tall canvases): AI pill bottom-left, icon + name bottom-right, 40 px inset (unchanged).
 * reel (9:16): one header row just under Instagram's top reserve: AI pill top-left inside REEL_SAFE, icon + name
 * right-aligned to REEL_SAFE.right, so nothing sits in the bottom 420 px the caption, username and action rail cover.
 */
export function brandGeometry(kit: Kit, W: number, H: number, variant: BrandVariant = brandVariantFor(W, H)): BrandGeometry {
  const k = kit.icon ? ICON : 0;
  const nw = kit.font.getAdvanceWidth(kit.brandName, 36);
  const lw = kit.font.getAdvanceWidth(AI_LABEL, 24);
  const nameW = Math.ceil(nw) + 4;
  const pillW = Math.ceil(lw) + 40;
  if (variant === 'reel') {
    const top = REEL_SAFE.top;
    const x = REEL_SAFE.right - nameW - (k ? k + ICON_GAP : 0);
    return {
      variant,
      pill: { left: REEL_SAFE.left, top: top + Math.round((ICON - PILL_H) / 2), width: pillW, height: PILL_H },
      icon: k ? { left: x, top, width: ICON, height: ICON } : null,
      name: { left: x + (k ? k + ICON_GAP : 0), top: top + 12, width: nameW, height: PILL_H },
    };
  }
  const x = W - 40 - nw - (k ? k + ICON_GAP : 0);
  const y = H - 40 - ICON;
  return {
    variant,
    pill: { left: 40, top: H - 40 - PILL_H, width: pillW, height: PILL_H },
    icon: k ? { left: Math.round(x), top: y, width: ICON, height: ICON } : null,
    name: { left: Math.round(x + (k ? k + ICON_GAP : 0)), top: y + 12, width: nameW, height: PILL_H },
  };
}

/** Brand mark (logo + name) and the "AI-generated content" label, placed by brandGeometry for the canvas shape. */
export async function brandLayers(kit: Kit, W: number, H: number, variant: BrandVariant = brandVariantFor(W, H)): Promise<OverlayOptions[]> {
  const g = brandGeometry(kit, W, H, variant);
  const icon = kit.icon
    ? await sharp(kit.icon)
        .resize(ICON, ICON)
        .composite([{ input: Buffer.from(`<svg width="64" height="64"><rect width="64" height="64" rx="16" fill="#fff"/></svg>`), blend: 'dest-in' }])
        .png()
        .toBuffer()
    : null;
  const nameD = kit.font.getPath(kit.brandName, 0, 34, 36).toPathData(2);
  const labelD = kit.font.getPath(AI_LABEL, 20, 32, 24).toPathData(2);
  return [
    ...(icon && g.icon ? [{ input: icon, left: g.icon.left, top: g.icon.top }] : []),
    { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${g.name.width}" height="46"><path d="${nameD}" fill="#ffffff"/></svg>`), left: g.name.left, top: g.name.top },
    {
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${g.pill.width}" height="46"><rect width="100%" height="46" rx="23" fill="#0a0628" fill-opacity="0.78"/><path d="${labelD}" fill="#ebebff"/></svg>`),
      left: g.pill.left,
      top: g.pill.top,
    },
  ];
}

export function textLayer(kit: Kit, W: number, H: number, lines: TextLine[], extra = ''): OverlayOptions {
  return { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${extra}${lines.map((l) => textSvg(kit, W, l)).join('')}</svg>`), left: 0, top: 0 };
}

/** Text and brand overlay on top of an existing image (e.g. a Codex illustration). */
export async function renderOverlay(kit: Kit, base: Buffer, W: number, H: number, lines: TextLine[], opts: { darken?: number; topShade?: boolean } = {}): Promise<Buffer> {
  let img = sharp(base).resize(W, H, { fit: 'cover' });
  if (opts.darken) img = img.modulate({ brightness: 1 - opts.darken, saturation: 1 - opts.darken * 0.6 });
  const shade = opts.topShade
    ? `<defs><linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0e0a26" stop-opacity="0.75"/><stop offset="0.42" stop-color="#0e0a26" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#sh)"/>`
    : '';
  const layers: OverlayOptions[] = [textLayer(kit, W, H, lines, shade), ...(await brandLayers(kit, W, H))];
  return img.composite(layers).png({ compressionLevel: 9 }).toBuffer();
}



/** Splits text into lines that fit maxWidth at the given size (at most maxLines, last line ellipsised). */
export function wrap(kit: Kit, text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (kit.font.getAdvanceWidth(t, size) <= maxWidth || !cur) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1]!;
    while (last.length > 1 && kit.font.getAdvanceWidth(`${last}…`, size) > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.replace(/[\s,.;:]+$/, '')}…`;
    return kept;
  }
  return lines;
}

/** Brand kit for a project: its own font file and logo when imported, else the Studio font. */
export async function loadBrandKit(brandDirPath: string, brand: { name: string; fontFile: string | null; logo: string | null; colors: NonNullable<Kit['colors']> } | null, fallbackName: string): Promise<Kit> {
  const kit = await loadKit(brand?.name || fallbackName);
  if (brand?.fontFile) {
    try {
      kit.font = parseFont(await fs.readFile(/* turbopackIgnore: true */ path.join(brandDirPath, brand.fontFile)));
    } catch {
      /* keep the Studio font */
    }
  }
  if (brand?.logo) {
    try {
      kit.icon = await fs.readFile(/* turbopackIgnore: true */ path.join(brandDirPath, brand.logo));
    } catch {
      /* no logo */
    }
  }
  if (brand) kit.colors = brand.colors;
  return kit;
}

export { esc };

