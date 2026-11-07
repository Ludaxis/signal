// The creative chain's view of the project pack: one loader per run for the art, motion, music and SFX steps
// and for compose (the rigs and files StorySpine draws). Everything comes from the pack and the project's own assets;
// nothing here calls a vendor. Tier A and C rigs load through loader (resolver status, licence, sha256,
// validateRig, pack overrides); a rig that does not load is simply not castable. Generic core: ids come from the pack.
import type { LoadedRig } from '../anim/rig/load';
import { loadRig } from '../anim/rig/load';
import { POSE_IDS } from '../anim/types';
import { insideDir, type LoadedPack } from '../pack/load';
import { loadProjectAssets, mergeLibraries, packEntries, type AssetLibrary } from '../pack/resolve';
import { uiTargetsFor } from '../pack/ui-targets';
import type { ExecInput } from './types';
import type { RigCaps, ScenesDoc } from './art';
import type { RigLoader } from './art-assets';
import type { View } from './art';
import { motionWorldFor } from './motion-world';
import type { MotionWorld } from './motion';
import type { MusicWorld } from './music';
import type { SfxAsset } from './sfx';
import { musicWorldFor, sfxLibraryFor } from './sound-world';

/** A character as compose hands it to StorySpine: the rig (A, C) or the flat still (B), with every file it draws. */
export interface CharacterArt {
  charId: string;
  tier: 'A' | 'B' | 'C';
  /** Tier A and C. */
  rig?: LoadedRig;
  /** Tier B: the flat still (absolute path) and its size. */
  still?: { file: string; w: number | null; h: number | null };
}

export interface PackWorlds {
  library(): Promise<AssetLibrary | null>;
  /** Art: rig capabilities of a Tier A or C character (null when it does not load). */
  artRig: RigLoader;
  motion(i: ExecInput): Promise<MotionWorld | null>;
  music(i: ExecInput): Promise<MusicWorld | null>;
  sfx(i: ExecInput): Promise<SfxAsset[] | null>;
  /** Compose: the art of every character and the background files the scenes name. */
  art(ids: { characters: string[]; files: string[] }, i: Pick<ExecInput, 'params'>): Promise<{ characters: CharacterArt[]; files: Record<string, string> }>;
}

const resolveOpts = (i?: Pick<ExecInput, 'params'>) => ({ final: i?.params.final === true, use: (i?.params.use === 'paid-ads' || i?.params.use === 'store-listing' ? i.params.use : 'organic') as 'organic' | 'paid-ads' | 'store-listing' });

/** The phone frame the scenes put on screen (first insert beat), if any. */
const phoneFrameOf = (scenes: unknown): string | null => {
  const d = scenes as Partial<ScenesDoc> | null;
  return d?.beats?.find((b) => b.ui?.phoneFrame)?.ui?.phoneFrame ?? null;
};

export function packWorlds(root: string, loadPack: () => Promise<LoadedPack | null>): PackWorlds {
  const both = async (): Promise<{ pack: LoadedPack; lib: AssetLibrary } | null> => {
    const pack = await loadPack();
    if (!pack) return null;
    return { pack, lib: mergeLibraries(packEntries(pack), await loadProjectAssets(root)) };
  };
  const rigOf = async (pack: LoadedPack, lib: AssetLibrary, charId: string, i?: Pick<ExecInput, 'params'>): Promise<LoadedRig | null> => {
    const tier = pack.manifest.rigTier[charId];
    if (tier !== 'A' && tier !== 'C') return null;
    try {
      return await loadRig(pack, lib, charId, resolveOpts(i));
    } catch {
      return null; // not castable: art and motion name the character when a plan uses it
    }
  };
  return {
    library: async () => (await both())?.lib ?? null,
    artRig: async (charId) => {
      const w = await both();
      const r = w ? await rigOf(w.pack, w.lib, charId) : null;
      if (!r) return null;
      const caps: RigCaps = { views: [...r.rig.views] as View[], poses: [...POSE_IDS] };
      return caps;
    },
    motion: async (i) => {
      const w = await both();
      if (!w) return null;
      const uiTargets = await uiTargetsFor(w.lib.values(), phoneFrameOf(i.byPort.scenes));
      return motionWorldFor(w.pack, w.lib, { ...resolveOpts(i), ...(uiTargets ? { uiTargets } : {}) });
    },
    music: async () => {
      const pack = await loadPack();
      return pack ? musicWorldFor(root, pack) : null;
    },
    sfx: async () => {
      const pack = await loadPack();
      return pack ? sfxLibraryFor(root, pack) : null;
    },
    art: async (ids, i) => {
      const w = await both();
      const out: { characters: CharacterArt[]; files: Record<string, string> } = { characters: [], files: {} };
      if (!w) return out;
      for (const charId of [...new Set(ids.characters)].sort()) {
        const tier = w.pack.manifest.rigTier[charId];
        const e = w.lib.get(charId);
        if (!tier || !e) continue;
        if (tier === 'B') {
          const file = await insideDir(e.base, e.asset.file, e.origin === 'pack' ? 'pack' : 'assets').catch(() => null);
          if (file) out.characters.push({ charId, tier, still: { file, w: e.asset.dims?.w ?? null, h: e.asset.dims?.h ?? null } });
          continue;
        }
        const rig = await rigOf(w.pack, w.lib, charId, i);
        if (rig) out.characters.push({ charId, tier, rig });
      }
      for (const id of [...new Set(ids.files)].sort()) {
        const e = w.lib.get(id);
        if (!e || e.asset.status === 'retired') continue;
        const file = await insideDir(e.base, e.asset.file, e.origin === 'pack' ? 'pack' : 'assets').catch(() => null);
        if (file) out.files[id] = file;
      }
      return out;
    },
  };
}
