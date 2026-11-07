// Loading a character rig through the pack (quality bar; pack guide): the character asset is resolved
// by the pack resolver (status, licence, sha256 of rig.json), its tier must be A or C (B is a flat render with no
// rig), the rig file is parsed and every part, state and turnaround file is found inside the character folder,
// hashed and measured (part sizes come from the files; a declared size must match). The rig must pass validateRig;
// the character's optional poses.json / gestures.json are merged over the core library and must be performable.
// Every refusal is a PostmakerError with its own code. Signal never writes inside the pack.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PostmakerError } from '../../errors';
import { insideDir, type LoadedPack } from '../../pack/load';
import { resolveAsset, type AssetLibrary, type ResolveOptions } from '../../pack/resolve';
import { firstIssue } from '../../pack/schema';
import { hashJson, sha256OfFile } from '../../store/objects';
import type { RigTier } from '../../types';
import { checkPerformable, mergeOverrides } from '../library/overrides';
import type { CharacterLibrary, CutoutRig } from '../types';
import { partFiles } from './coverage';
import { cutoutRigSchema } from './schema';
import { validateRig } from './validate';

export interface LoadedRig {
  charId: string;
  tier: RigTier;
  /** Real path of the character folder. */
  dir: string;
  rig: CutoutRig;
  rigSha256: string;
  /** Every file the rig references (parts, states, turnaround), relative → sha256. */
  files: Record<string, string>;
  library: CharacterLibrary;
  /** One hash over the rig, its files and its overrides (what a step version records). */
  hash: string;
}

const err = (code: string, message: string, status = 422) => new PostmakerError(status, code, message);

async function readOptionalJson(dir: string, rel: string): Promise<unknown | null> {
  let file: string;
  try {
    file = await insideDir(dir, rel, 'rig');
  } catch (e) {
    if ((e as PostmakerError).code === 'rig.file-missing') return null;
    throw e;
  }
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file, 'utf8'));
  } catch {
    throw err('rig.unreadable', `${rel} could not be read.`);
  }
}

export async function loadRig(pack: { manifest: Pick<LoadedPack['manifest'], 'rigTier'> }, lib: AssetLibrary, charId: string, o: ResolveOptions): Promise<LoadedRig> {
  const tier = pack.manifest.rigTier[charId];
  if (!tier) throw err('rig.tier-missing', `${charId} has no rig tier in the pack.`);
  if (tier === 'B') throw err('rig.flat', `${charId} is a flat character (tier B) and has no rig.`, 409);
  const resolved = await resolveAsset(lib, charId, o);
  if (resolved.asset.kind !== 'character' || path.basename(resolved.asset.file) !== 'rig.json') throw err('rig.not-a-rig', `Asset ${charId} is not a character rig.`);
  const dir = path.dirname(resolved.path);

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ resolved.path, 'utf8'));
  } catch {
    throw err('rig.unreadable', `The rig of ${charId} could not be read.`);
  }
  const parsed = cutoutRigSchema.safeParse(raw);
  if (!parsed.success) throw err('rig.invalid', `The rig of ${charId} is not valid (${firstIssue(parsed.error)}).`);
  const rig = parsed.data as CutoutRig;
  if (rig.id !== charId) throw err('rig.id-mismatch', `The rig of ${charId} names itself ${rig.id}.`);

  const files: Record<string, string> = {};
  const sizes = new Map<string, [number, number]>();
  const fileOf = async (rel: string) => {
    if (files[rel]) return;
    const real = await insideDir(dir, rel, 'rig');
    files[rel] = await sha256OfFile(real);
    const m = await sharp(real).metadata();
    if (m.width && m.height) sizes.set(rel, [m.width, m.height]);
  };
  await fileOf(rig.turnaround);
  for (const p of rig.parts) {
    const list = partFiles(p);
    for (const rel of list) await fileOf(rel);
    if (!list.length) continue;
    const first = sizes.get(list[0]!);
    for (const rel of list.slice(1)) {
      const s = sizes.get(rel);
      if (!first || !s || s[0] !== first[0] || s[1] !== first[1]) throw err('rig.state-size', `${charId}: ${p.view} ${p.name} state ${rel} is not the size of the part.`);
    }
    if (p.size && first && (p.size[0] !== first[0] || p.size[1] !== first[1])) throw err('rig.part-size-mismatch', `${charId}: ${p.view} ${p.name} is ${first.join('×')}, not ${p.size.join('×')}.`);
    if (first) p.size = first;
  }

  const v = validateRig(rig);
  if (!v.ok) throw err(v.issues[0]!.code, v.issues[0]!.message);

  const poses = await readOptionalJson(dir, 'poses.json');
  const gestures = await readOptionalJson(dir, 'gestures.json');
  const merged = mergeOverrides(rig, poses, gestures);
  const issues = [...merged.issues, ...checkPerformable(rig, merged.library)];
  if (issues.length) throw err(issues[0]!.code, issues[0]!.message);

  return { charId, tier, dir, rig, rigSha256: resolved.sha256, files, library: merged.library, hash: hashJson({ rig: resolved.sha256, files, poses, gestures }) };
}
