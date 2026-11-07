// Loading a project pack: read-only. Validates `pack.json`, refuses a pack whose `requires.signal` does not
// match, hashes every file (or record) the manifest references and returns the PackLock. Signal never writes inside
// the pack; the caller stores the lock in postmaker/pack-lock.json. Every referenced path must resolve (after
// symlinks) inside the pack folder.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PostmakerError } from '../errors';
import { hashJson, sha256OfFile } from '../store/objects';
import { packDirOf } from '../store/paths';
import { writePackLock } from '../store/recipes';
import type { PackLock, PackManifest, ProjectLike, VoiceProfile } from '../types';
import { firstIssue, librarySchema, packManifestSchema, voicesSchema } from './schema';
import { parseRange, parseVersion } from './semver';
import type { z } from 'zod';

/** The pack API version this Signal implements (Post maker store VERSION 2). Packs declare `requires.signal` against it. */
export const SIGNAL_PACK_API_VERSION = '2.0.0';

export type LibraryAsset = z.infer<typeof librarySchema>[number];

export interface PackAssetFile {
  path: string; // absolute
  sha256: string | null; // null when the file is missing
}

export interface LoadedPack {
  dir: string; // real path of the pack folder
  manifest: PackManifest;
  library: LibraryAsset[];
  libraryDir: string; // asset files are relative to it
  assetFiles: Record<string, PackAssetFile>;
  voices: VoiceProfile[];
  lock: PackLock;
}

const err = (status: number, code: string, message: string) => new PostmakerError(status, code, message);

/** Resolves `rel` inside `base` (both through realpath). Missing → `pack.file-missing`; escaping → `pack.path-outside`. */
export async function insideDir(base: string, rel: string, what = 'pack'): Promise<string> {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw err(400, `${what}.path-outside`, `${rel} is outside the ${what} folder.`);
  const joined = path.join(base, rel);
  let real: string;
  try {
    real = await fs.realpath(/* turbopackIgnore: true */ joined);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw err(404, `${what}.file-missing`, `The ${what} file ${rel} is missing.`);
    throw e;
  }
  if (real !== base && !real.startsWith(base + path.sep)) throw err(400, `${what}.path-outside`, `${rel} is outside the ${what} folder.`);
  const st = await fs.stat(/* turbopackIgnore: true */ real);
  if (!st.isFile()) throw err(400, `${what}.not-a-file`, `${rel} is not a file.`);
  return real;
}

async function readJsonIn(base: string, rel: string): Promise<unknown> {
  const file = await insideDir(base, rel);
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file, 'utf8'));
  } catch {
    throw err(422, 'pack.unreadable', `The pack file ${rel} could not be read.`);
  }
}

/** Refuses a pack made for another Signal: "This pack needs Signal ‹range›". */
export function checkRequires(range: string, signalVersion = SIGNAL_PACK_API_VERSION): void {
  const test = parseRange(range);
  if (!test) throw err(422, 'pack.requires-invalid', `The pack's Signal range ${range} is not valid.`);
  const v = parseVersion(signalVersion);
  if (!v || !test(v)) throw err(409, 'pack.requires', `This pack needs Signal ${range}`);
}

export async function loadPack(dir: string, o: { signalVersion?: string; now?: number } = {}): Promise<LoadedPack> {
  let base: string;
  try {
    base = await fs.realpath(/* turbopackIgnore: true */ path.resolve(dir));
  } catch {
    throw err(404, 'pack.missing', 'The pack folder is missing.');
  }
  const raw = await readJsonIn(base, 'pack.json');
  const parsed = packManifestSchema.safeParse(raw);
  if (!parsed.success) throw err(422, 'pack.invalid', `pack.json is not valid (${firstIssue(parsed.error)}).`);
  const manifest = parsed.data as PackManifest;
  checkRequires(manifest.requires.signal, o.signalVersion);

  const entries: Record<string, string> = { manifest: hashJson(raw) };
  const fileEntry = async (ref: string, rel: string) => {
    entries[ref] = await sha256OfFile(await insideDir(base, rel));
  };

  if (manifest.brand) await fileEntry('brand', manifest.brand);
  for (const [lang, rel] of Object.entries(manifest.lexicon)) if (rel) await fileEntry(`lexicon:${lang}`, rel);
  for (const [lang, rel] of Object.entries(manifest.style)) if (rel) await fileEntry(`style:${lang}`, rel);
  if (manifest.glossary) await fileEntry('glossary', manifest.glossary);
  for (const rel of manifest.templates) await fileEntry(`template:${path.basename(rel, '.json')}`, rel);

  for (const f of manifest.fonts) {
    const sha = await sha256OfFile(await insideDir(base, f.file));
    if (sha !== f.sha256) throw err(409, 'pack.font-sha256-mismatch', `The font ${f.family} does not match its pinned hash.`);
    await insideDir(base, f.licence); // the licence file must sit beside the font
    if (entries[`font:${f.family}`] && entries[`font:${f.family}`] !== sha) entries[`font:${f.family}`] = hashJson([entries[`font:${f.family}`], sha]);
    else entries[`font:${f.family}`] = sha;
  }

  const voicesParsed = voicesSchema.safeParse(await readJsonIn(base, manifest.voices));
  if (!voicesParsed.success) throw err(422, 'pack.invalid', `${manifest.voices} is not valid (${firstIssue(voicesParsed.error)}).`);
  const voices = voicesParsed.data as VoiceProfile[];
  for (const v of voices) {
    if (entries[`voice:${v.id}`]) throw err(422, 'pack.duplicate-voice', `Voice id ${v.id} appears twice.`);
    entries[`voice:${v.id}`] = hashJson(v);
  }

  const libParsed = librarySchema.safeParse(await readJsonIn(base, manifest.library));
  if (!libParsed.success) throw err(422, 'pack.invalid', `${manifest.library} is not valid (${firstIssue(libParsed.error)}).`);
  const libraryDir = path.dirname(await insideDir(base, manifest.library));
  const assetFiles: Record<string, PackAssetFile> = {};
  for (const a of libParsed.data) {
    if (assetFiles[a.id]) throw err(409, 'asset.duplicate-id', `Asset id \`${a.id}\` appears twice in the pack.`);
    let file: string;
    let sha: string | null = null;
    try {
      file = await insideDir(libraryDir, a.file);
      sha = await sha256OfFile(file);
    } catch (e) {
      if ((e as PostmakerError).code !== 'pack.file-missing') throw e;
      file = path.join(libraryDir, a.file);
    }
    assetFiles[a.id] = { path: file, sha256: sha };
    entries[`asset:${a.id}`] = hashJson({ record: a, file: sha });
  }

  const sorted = Object.keys(entries).sort();
  const lock: PackLock = {
    schema: 'signal.pm.pack-lock/1',
    packId: manifest.id,
    version: manifest.version,
    readAt: new Date(o.now ?? Date.now()).toISOString(),
    entries: Object.fromEntries(sorted.map((k) => [k, entries[k]!])),
    root: hashJson(sorted.map((k) => [k, entries[k]!])),
  };
  return { dir: base, manifest, library: libParsed.data, libraryDir, assetFiles, voices, lock };
}

/**
 * The project's pack, or null when it has none (a project without a pack works: built-in templates only).
 * Records the lock in `<postmaker root>/pack-lock.json`.
 */
export async function loadProjectPack(project: Pick<ProjectLike, 'contentDir' | 'pack'>, root: string, o: { signalVersion?: string; now?: number } = {}): Promise<LoadedPack | null> {
  const dir = packDirOf(project);
  try {
    await fs.access(/* turbopackIgnore: true */ path.join(dir, 'pack.json'));
  } catch {
    if (project.pack?.dir) throw err(404, 'pack.missing', 'The pack folder is missing.');
    return null;
  }
  const pack = await loadPack(dir, o);
  await writePackLock(root, pack.lock);
  return pack;
}

/** Refs whose hash differs between two locks (added and removed refs included), sorted. */
export function changedRefs(a: PackLock | null, b: PackLock | null): string[] {
  const ea = a?.entries ?? {};
  const eb = b?.entries ?? {};
  return [...new Set([...Object.keys(ea), ...Object.keys(eb)])].filter((k) => ea[k] !== eb[k]).sort();
}

/** The out-of-date reason shown for a changed pack ref (`packReason`). */
export function packRefReason(ref: string): string {
  const kind = ref.split(':')[0];
  switch (kind) {
    case 'lexicon':
      return 'Lexicon changed';
    case 'voice':
      return 'Voice changed';
    case 'asset':
      return 'Asset changed';
    case 'font':
      return 'Font changed';
    case 'style':
      return 'Style guide changed';
    case 'glossary':
      return 'Glossary changed';
    case 'template':
      return 'Template changed';
    case 'brand':
      return 'Brand changed';
    default:
      return 'Pack changed';
  }
}
