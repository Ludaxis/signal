// The synthetic Tier A rig for the anim suite: built by tests/fixtures/postmaker/make-rig.mjs into a temp character
// folder and wrapped as a one-asset pack library, so loadRig runs the real resolver path (status, licence, sha256).
// [Pack example] the character `char-cutout` is original fixture art; nothing here is core.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeLibraries, type AssetLibrary } from '@/lib/studio/postmaker/pack/resolve';
import type { LibraryAsset } from '@/lib/studio/postmaker/pack/load';
import type { CutoutRig } from '@/lib/studio/postmaker/anim/types';

export const FIXTURES = path.resolve(__dirname, '../../../fixtures/postmaker');
export const RIG_ID = 'char-cutout';

type RigBuilder = { buildRig: (dir: string) => { dir: string; rig: CutoutRig; files: string[] } };
export const rigBuilder = async () => (await import(/* @vite-ignore */ path.join(FIXTURES, 'make-rig.mjs'))) as RigBuilder;

export interface RigFixture {
  libDir: string;
  charDir: string;
  asset: LibraryAsset;
  lib: AssetLibrary;
  manifest: { rigTier: Record<string, 'A' | 'B' | 'C'> };
}

export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Builds the rig into a fresh temp library folder: library/characters/char-cutout/. */
export async function buildRigFixture(o: { tier?: 'A' | 'B' | 'C'; status?: LibraryAsset['status'] } = {}): Promise<RigFixture> {
  const libDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signal-rig-')));
  const charDir = path.join(libDir, 'characters', RIG_ID);
  (await rigBuilder()).buildRig(charDir);
  const asset = rigAsset(libDir, o.status);
  return { libDir, charDir, asset, lib: libraryOf(libDir, asset), manifest: { rigTier: { [RIG_ID]: o.tier ?? 'A' } } };
}

export function rigAsset(libDir: string, status: LibraryAsset['status'] = 'approved'): LibraryAsset {
  return {
    id: RIG_ID,
    kind: 'character',
    file: `characters/${RIG_ID}/rig.json`,
    sha256: sha(readFileSync(path.join(libDir, 'characters', RIG_ID, 'rig.json'))),
    tags: ['rigged'],
    licence: { type: 'owned', holder: 'Signal test fixtures', source: 'make-rig.mjs', author: null, acquiredAt: '2026-11-07', proof: null, allowedUses: ['organic', 'paid-ads', 'store-listing'], territories: 'worldwide', expiresAt: null, attribution: null, aiGenerated: false },
    status,
    approvedBy: 'fixture owner',
  };
}

export const libraryOf = (libDir: string, asset: LibraryAsset): AssetLibrary => mergeLibraries([{ asset, origin: 'pack', base: libDir }], []);

export const FINAL = { final: true, use: 'organic' as const, now: Date.parse('2026-11-07T00:00:00Z') };
