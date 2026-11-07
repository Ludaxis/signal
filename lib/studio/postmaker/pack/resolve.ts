// The asset resolver: merges the pack library with the project's approved assets
// (postmaker/assets/library.json, files relative to postmaker/assets/), refuses an id present in both, and applies the
// licence and status rules. Each refusal has its own error code:
//   asset.missing, asset.retired, asset.draft-in-final, asset.allowed-uses-missing, asset.use-not-allowed,
//   asset.licence-expired, asset.consent-missing, asset.file-missing, asset.sha256-mismatch, asset.duplicate-id.
import { promises as fs } from 'node:fs';
import { PostmakerError } from '../errors';
import { sha256OfFile } from '../store/objects';
import { projectAssetsDir, projectLibraryFile } from '../store/paths';
import type { AssetUse } from '../types';
import { insideDir, type LibraryAsset, type LoadedPack } from './load';
import { firstIssue, librarySchema } from './schema';

export type AssetOrigin = 'pack' | 'project';

export interface LibraryEntry {
  asset: LibraryAsset;
  origin: AssetOrigin;
  base: string; // folder the asset's `file` is relative to
}

export type AssetLibrary = Map<string, LibraryEntry>;

const err = (code: string, message: string, status = 409) => new PostmakerError(status, code, message);

/** The project's own approved/generated assets; an empty list when the file does not exist yet. */
export async function loadProjectAssets(root: string): Promise<LibraryEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(/* turbopackIgnore: true */ projectLibraryFile(root), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw err('assets.unreadable', 'Project assets could not be read.', 422);
  }
  const parsed = librarySchema.safeParse(raw);
  if (!parsed.success) throw err('assets.invalid', `Project assets are not valid (${firstIssue(parsed.error)}).`, 422);
  const base = await fs.realpath(/* turbopackIgnore: true */ projectAssetsDir(root));
  return parsed.data.map((asset) => ({ asset, origin: 'project' as const, base }));
}

export const packEntries = (pack: LoadedPack | null): LibraryEntry[] => (pack ? pack.library.map((asset) => ({ asset, origin: 'pack' as const, base: pack.libraryDir })) : []);

/** Merges both libraries. An id in both (or twice in one) is an error naming the id. */
export function mergeLibraries(pack: LibraryEntry[], project: LibraryEntry[]): AssetLibrary {
  const lib: AssetLibrary = new Map();
  for (const e of [...pack, ...project]) {
    const prev = lib.get(e.asset.id);
    if (prev) {
      throw err(
        'asset.duplicate-id',
        prev.origin !== e.origin ? `Asset id \`${e.asset.id}\` exists in the pack and in project assets` : `Asset id \`${e.asset.id}\` appears twice in the ${e.origin === 'pack' ? 'pack' : 'project assets'}`,
      );
    }
    lib.set(e.asset.id, e);
  }
  return lib;
}

export interface ResolveOptions {
  /** A final render (or an Accept) applies every licence rule; drafts may use `draft` assets. */
  final: boolean;
  use: AssetUse;
  now?: number;
}

export interface ResolvedAsset {
  asset: LibraryAsset;
  origin: AssetOrigin;
  path: string; // absolute, checked inside its library folder
  sha256: string;
}

/** Resolves one asset id or throws with the rule's code. The file is re-hashed every time (checked at render). */
export async function resolveAsset(lib: AssetLibrary, id: string, o: ResolveOptions): Promise<ResolvedAsset> {
  const e = lib.get(id);
  if (!e) throw err('asset.missing', `Asset ${id} is not in the library.`, 404);
  const a = e.asset;
  if (a.status === 'retired') throw err('asset.retired', `Asset ${id} is retired.`);
  if (o.final) {
    if (a.status !== 'approved') throw err('asset.draft-in-final', `Asset ${id} is a draft. Approve it before the final render.`);
    const uses = a.licence.allowedUses;
    if (!uses || uses.length === 0) throw err('asset.allowed-uses-missing', `Asset ${id} has no allowed uses in its licence.`);
    if (!uses.includes(o.use)) throw err('asset.use-not-allowed', `Asset ${id} is not licensed for ${o.use}.`);
    if (a.licence.expiresAt && Date.parse(a.licence.expiresAt) <= (o.now ?? Date.now())) throw err('asset.licence-expired', `The licence of asset ${id} has expired.`);
    if (a.kind === 'voice' && !a.licence.consentRef) throw err('asset.consent-missing', `Asset ${id} needs a consent record.`);
  }
  let file: string;
  try {
    file = await insideDir(e.base, a.file, e.origin === 'pack' ? 'pack' : 'assets');
  } catch (x) {
    const code = (x as PostmakerError).code ?? '';
    if (code.endsWith('.file-missing')) throw err('asset.file-missing', `The file of asset ${id} is missing.`, 404);
    throw x;
  }
  const sha = await sha256OfFile(file);
  if (sha !== a.sha256) throw err('asset.sha256-mismatch', `The file of asset ${id} does not match its recorded hash.`);
  return { asset: a, origin: e.origin, path: file, sha256: sha };
}
