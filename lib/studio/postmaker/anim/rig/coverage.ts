// Coverage masks of rig part files (PNG or SVG) for the pivot-integrity check: each file decoded at its own size
// with sharp, alpha ≥ 50 % counted as covered. Node only (not imported by the render bundle).
import path from 'node:path';
import sharp from 'sharp';
import type { RigPart } from '../types';
import type { Mask } from './integrity';

export async function maskOf(file: string): Promise<Mask> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels + 3]! >= 128 ? 1 : 0;
  return { w: info.width, h: info.height, data: out };
}

/** The files of a part: its own file first, then every state file (deduplicated, relative to the character folder). */
export const partFiles = (p: RigPart): string[] => [...new Set([...(p.file ? [p.file] : []), ...Object.values(p.states ?? {})])];

/** Masks for every drawn part of a rig, keyed by `view/name`. */
export async function rigMasks(dir: string, parts: readonly RigPart[]): Promise<Map<string, Mask[]>> {
  const cache = new Map<string, Mask>();
  const out = new Map<string, Mask[]>();
  for (const p of parts) {
    const list: Mask[] = [];
    for (const rel of partFiles(p)) {
      if (!cache.has(rel)) cache.set(rel, await maskOf(path.join(dir, rel)));
      list.push(cache.get(rel)!);
    }
    out.set(`${p.view}/${p.name}`, list);
  }
  return out;
}
