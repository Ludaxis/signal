// The faces a render uses: the pack's files, or the core-bundled Vazirmatn (text), Estedad (display) and Instrument
// Sans (latin) pinned in public/fonts/fonts.lock.json when the pack has none. Latin runs never use the Persian font's
// Latin glyphs: the pack's Latin face, else the core one; only when neither exists does the render warn and use the
// text face. Every face is verified against its sha256 before it is used, and the render log lists each family with
// its hash. Server side only.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadFont, type LoadedFont } from './fontFile';
import type { TimelineFont } from './timeline';

/** The app folder (the Next.js cwd; SIGNAL_APP_DIR overrides it, as the desktop app does). */
export const appDir = () => process.env.SIGNAL_APP_DIR || path.resolve(/* turbopackIgnore: true */ process.cwd());
/** The optional Remotion render workspace: SIGNAL_RENDER_SERVICE_DIR, default <app>/render. */
export const renderServiceDir = () => process.env.SIGNAL_RENDER_SERVICE_DIR || path.join(appDir(), 'render');

export interface FontFile extends TimelineFont {
  /** Absolute path on disk (copied into the render bundle's public dir as `src`). */
  file: string;
}

interface LockFile {
  fonts: { family: string; role: string; files: { path: string; sha256: string; weights?: string }[] }[];
}

const ROLES = ['text', 'display', 'latin'] as const;

/** The core faces from fonts.lock.json (text, display and latin), with their pinned hashes. */
export function coreFonts(dir = appDir()): FontFile[] {
  const fontsDir = path.join(dir, 'public/fonts');
  const lock = JSON.parse(readFileSync(path.join(fontsDir, 'fonts.lock.json'), 'utf8')) as LockFile;
  return lock.fonts.map((f) => {
    const file = f.files.find((x) => x.path.endsWith('.woff2'))!;
    const role = (ROLES as readonly string[]).includes(f.role) ? (f.role as FontFile['role']) : 'text';
    return { family: f.family, role, src: `fonts/${file.path}`, sha256: file.sha256, weights: file.weights ?? '400', file: path.join(fontsDir, file.path) };
  });
}

export const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

export class FontHashError extends Error {}

/** Refuses a face whose bytes do not match its pinned hash (a swapped or truncated file never renders). */
export function verifyFonts(fonts: FontFile[]): void {
  for (const f of fonts) {
    if (!existsSync(f.file)) throw new FontHashError(`Font file missing: ${f.family}`);
    const got = sha256File(f.file);
    if (got !== f.sha256) throw new FontHashError(`Font ${f.family} does not match its pinned sha256`);
  }
}

/** The faces for a render: the pack's when given (per role), else the core faces; plus the pack's Latin face. */
export function resolveFonts(pack: FontFile[] = [], dir = appDir()): { fonts: FontFile[]; warnings: string[] } {
  const core = coreFonts(dir);
  const pick = (role: FontFile['role']) => pack.find((f) => f.role === role) ?? core.find((f) => f.role === role);
  const fonts = ROLES.map(pick).filter((f): f is FontFile => Boolean(f));
  const warnings = fonts.some((f) => f.role === 'latin') ? [] : ['No Latin face: Latin runs use the text face.'];
  return { fonts, warnings };
}

/** Render-log lines: one per family with its file hash. */
export const fontLog = (fonts: Pick<TimelineFont, 'family' | 'role' | 'sha256'>[]) => fonts.map((f) => `font ${f.family} (${f.role}) sha256 ${f.sha256}`);

const loaded = new Map<string, LoadedFont>();
/** A face loaded for measurement (cached per file and hash). */
export function measuringFont(f: Pick<FontFile, 'file' | 'family' | 'sha256'>): LoadedFont {
  const key = `${f.file}#${f.sha256}`;
  let font = loaded.get(key);
  if (!font) {
    font = loadFont(f.file, f.family);
    loaded.set(key, font);
  }
  return font;
}

/** The font coverage gate for the ZWJ reveal (quality): the display face must contain a ZWJ glyph. */
export function zwjCoverage(f: Pick<FontFile, 'file' | 'family' | 'sha256'>): { family: string; zwj: boolean; zwnj: boolean } {
  const font = measuringFont(f);
  return { family: f.family, zwj: font.has(0x200d), zwnj: font.has(0x200c) };
}
