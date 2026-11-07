// The sound steps' view of a project pack: the music policy, the music tracks and the `sfx` library of the pack
// merged with the project's own assets (uploads are project assets tagged `owner-upload`), each with its file
// resolved inside its library folder, the template's music cue per segment and the names a music prompt may never
// carry. The registry uses these when the default chain is wired; nothing here calls a vendor.
import { insideDir, type LibraryAsset, type LoadedPack } from '../pack/load';
import type { Asset } from '../types';
import { loadProjectAssets, mergeLibraries, packEntries, type LibraryEntry } from '../pack/resolve';
import { loadPackTemplates } from '../pack/template';
import { packNames } from './art-assets';
import type { MusicCue, MusicTrack, MusicWorld } from './music';
import type { SfxAsset } from './sfx';

async function filesOf(entries: LibraryEntry[], kind: 'music' | 'sfx'): Promise<{ entry: LibraryEntry; file: string }[]> {
  const out: { entry: LibraryEntry; file: string }[] = [];
  for (const e of entries) {
    if (e.asset.kind !== kind || e.asset.status === 'retired') continue;
    const file = await insideDir(e.base, e.asset.file, e.origin === 'pack' ? 'pack' : 'assets').catch(() => null);
    if (file) out.push({ entry: e, file }); // a missing file is the resolver's error at render time; here it is simply not offered
  }
  return out;
}

/** The library record as the sound steps read it (a missing `allowedUses` reads as none, so the licence is incomplete). */
const asAsset = (a: LibraryAsset): Asset => ({ ...a, licence: { ...a.licence, allowedUses: a.licence.allowedUses ?? [] } });

async function entriesOf(root: string, pack: LoadedPack): Promise<LibraryEntry[]> {
  return [...mergeLibraries(packEntries(pack), await loadProjectAssets(root)).values()];
}

export async function musicWorldFor(root: string, pack: LoadedPack): Promise<MusicWorld> {
  const tracks: MusicTrack[] = (await filesOf(await entriesOf(root, pack), 'music')).map(({ entry, file }) => ({ asset: asAsset(entry.asset), origin: entry.origin, file }));
  let cues: Partial<Record<string, MusicCue>> = {};
  try {
    const t = (await loadPackTemplates(pack)).find((x) => x.builder === 'story-spine@1');
    if (t) cues = Object.fromEntries(t.segments.map((s) => [s.id, s.music]));
  } catch {
    cues = {}; // a template problem shows on the pack screen; the core cues apply
  }
  return { policy: { sources: [...pack.manifest.musicPolicy.sources] }, tracks, cues, names: await packNames(pack) };
}

export async function sfxLibraryFor(root: string, pack: LoadedPack): Promise<SfxAsset[]> {
  return (await filesOf(await entriesOf(root, pack), 'sfx')).map(({ entry, file }) => ({ asset: asAsset(entry.asset), file }));
}
