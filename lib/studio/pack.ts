// Server-only: a project's read-only pack (outside the repository). Signal only reads it.
//   <pack>/pack.json     the Post maker manifest, `signal.pack/1` (docs/postmaker-packs.md)
//   <pack>/formats.json  labels and store / closing lines for the formats (formats.ts loadPackFormats)
// Paths inside the pack are relative to the pack folder and may not leave it.
//
// The image templates read two things from the manifest (packAssets):
//   display font  the first `fonts[]` entry whose `scripts` include 'latin' and whose file is ttf, otf or woff
//                 (the image renderer cannot read woff2), checked against its pinned `sha256`;
//   icon          the one approved `ui` asset tagged `app-icon` in the manifest's `library` (file relative to the
//                 library folder), checked against its `sha256`.
// An older shape (`"fonts": { "display": … }` and `"icon": "<path>"`) cannot pass the manifest schema and is not
// read; `packAssetsShape` reports it as 'removed'. To migrate, move the font into `fonts[]` and the icon into
// `library/library.json` as an approved `ui` asset tagged `app-icon`.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Project } from './projects';

/** The pack folder of a project, or null when it has none. */
export function packDir(p: Pick<Project, 'pack'>): string | null {
  const d = p.pack?.dir;
  return typeof d === 'string' && path.isAbsolute(d) ? d : null;
}

/** A file inside `dir`, or null when the path is missing or would leave the folder. */
export function packFile(dir: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(dir, rel);
  return abs.startsWith(path.resolve(dir) + path.sep) ? abs : null;
}

export interface PackAssets {
  /** Display font file (ttf/otf/woff). */
  font: string | null;
  /** Licence line for the font, as the pack records it (manifest form: the family and its licence file). */
  fontLicence: string | null;
  /** Square icon (png). */
  icon: string | null;
}

const NONE: PackAssets = { font: null, fontLicence: null, icon: null };
const IMAGE_FONT = /\.(ttf|otf|woff)$/i;
const SHA = /^[0-9a-f]{64}$/;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

async function isFile(f: string | null): Promise<string | null> {
  return f && (await fs.stat(/* turbopackIgnore: true */ f).then((s) => s.isFile()).catch(() => false)) ? f : null;
}

/** The file when it exists inside its folder and matches its pinned sha256; null otherwise (never half-trusted). */
async function pinned(dir: string, rel: unknown, sha: unknown): Promise<string | null> {
  if (typeof sha !== 'string' || !SHA.test(sha)) return null;
  const f = await isFile(packFile(dir, rel));
  if (!f) return null;
  const real = await fs.realpath(/* turbopackIgnore: true */ f).catch(() => null);
  const base = await fs.realpath(/* turbopackIgnore: true */ dir).catch(() => null);
  if (!real || !base || !real.startsWith(base + path.sep)) return null; // a symlink may not lead out of the pack
  const bytes = await fs.readFile(/* turbopackIgnore: true */ real).catch(() => null);
  return bytes && createHash('sha256').update(bytes).digest('hex') === sha ? f : null;
}

/** Manifest form: the display font is the first Latin face the image renderer can read. */
async function manifestFont(dir: string, fonts: unknown[]): Promise<Pick<PackAssets, 'font' | 'fontLicence'>> {
  for (const v of fonts) {
    const f = obj(v);
    if (!f || !Array.isArray(f.scripts) || !f.scripts.includes('latin') || typeof f.file !== 'string' || !IMAGE_FONT.test(f.file)) continue;
    const file = await pinned(dir, f.file, f.sha256);
    if (!file) return { font: null, fontLicence: null }; // the first Latin face is the display face; a bad one is not skipped silently
    const family = typeof f.family === 'string' && f.family.trim() ? f.family.trim().slice(0, 80) : path.basename(file);
    const licence = typeof f.licence === 'string' && (await isFile(packFile(dir, f.licence))) ? f.licence : null;
    return { font: file, fontLicence: (licence ? `${family}, licence file ${licence}` : family).slice(0, 120) };
  }
  return { font: null, fontLicence: null };
}

/** Manifest form: the icon is the one approved `ui` asset tagged `app-icon` in the pack library. */
async function manifestIcon(dir: string, library: unknown): Promise<string | null> {
  const libFile = await isFile(packFile(dir, library));
  if (!libFile) return null;
  let list: unknown;
  try {
    list = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ libFile, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const icons = list.map(obj).filter((a): a is Record<string, unknown> => Boolean(a && a.kind === 'ui' && a.status === 'approved' && Array.isArray(a.tags) && a.tags.includes('app-icon')));
  if (icons.length !== 1) return null; // the guide asks for exactly one; two would be a guess
  const file = await pinned(path.dirname(libFile), icons[0]!.file, icons[0]!.sha256);
  return file && /\.png$/i.test(file) ? file : null;
}

async function readManifest(p: Pick<Project, 'pack'>): Promise<{ dir: string; j: Record<string, unknown> } | null> {
  const dir = packDir(p);
  if (!dir) return null;
  let j: Record<string, unknown> | null;
  try {
    j = obj(JSON.parse(await fs.readFile(/* turbopackIgnore: true */ path.join(dir, 'pack.json'), 'utf8')));
  } catch {
    return null;
  }
  if (!j || (j.schema !== undefined && j.schema !== 'signal.pack/1')) return null;
  return { dir, j };
}

/** Fonts and icon the pack declares (each null when not declared, unreadable, unpinned or outside the pack). */
export async function packAssets(p: Pick<Project, 'pack'>): Promise<PackAssets> {
  const m = await readManifest(p);
  if (!m) return NONE;
  // Only the manifest form; the older `fonts.display` / `icon` shape gives nothing (see the header).
  const font = Array.isArray(m.j.fonts) ? await manifestFont(m.dir, m.j.fonts) : { font: null, fontLicence: null };
  return { ...font, icon: await manifestIcon(m.dir, m.j.library) };
}

/**
 * Which pack.json shape a project has: 'manifest', 'removed' (the older `fonts.display` / `icon` keys, not read;
 * the pack needs the migration in the header) or 'none'.
 */
export async function packAssetsShape(p: Pick<Project, 'pack'>): Promise<'manifest' | 'removed' | 'none'> {
  const m = await readManifest(p);
  if (!m) return 'none';
  if (Array.isArray(m.j.fonts)) return 'manifest';
  return obj(m.j.fonts) || typeof m.j.icon === 'string' ? 'removed' : 'none';
}
