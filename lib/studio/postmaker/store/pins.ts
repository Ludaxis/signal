// Pins: postmaker/pins.json lists every object an approved package depends on, with who pinned it.
// Nothing deletes objects yet; a future clean-up (a gated data-deletion action) must skip pinned objects.
import { PostmakerError } from '../errors';
import type { Pins } from '../types';
import { checkSchema, pretty, readJsonFile, writeReplace } from './fs';
import { withLock } from './mutex';
import { pinsFile, SHA_RE } from './paths';

const empty = (): Pins => ({ schema: 'signal.pm.pins/1', objects: {}, updatedAt: new Date(0).toISOString() });

export async function readPins(root: string): Promise<Pins> {
  const p = await readJsonFile<Pins>(pinsFile(root));
  if (!p) return empty();
  checkSchema(p, 'pins', 1);
  return p;
}

/** Adds `by` (e.g. 'package:12') as a pinner of every object in `shas`. Idempotent. */
export async function addPins(root: string, shas: string[], by: string, now = Date.now()): Promise<Pins> {
  if (!/^[a-z][a-z-]*:[A-Za-z0-9._-]{1,64}$/.test(by)) throw new PostmakerError(400, 'validation', 'A pin needs an owner like package:12.');
  for (const s of shas) if (!SHA_RE.test(s)) throw new PostmakerError(400, 'validation', 'Only saved files can be pinned.');
  return withLock(`pm-pins:${pinsFile(root)}`, async () => {
    const p = await readPins(root);
    for (const s of shas) {
      const owners = new Set(p.objects[s] ?? []);
      owners.add(by);
      p.objects[s] = [...owners].sort();
    }
    p.updatedAt = new Date(now).toISOString();
    await writeReplace(pinsFile(root), pretty(p));
    return p;
  });
}

export async function isPinned(root: string, sha: string): Promise<boolean> {
  return (await readPins(root)).objects[sha]?.length ? true : false;
}
