// What the agent steps read from the project pack: the claims policy (`pack.json`
// `claims`) for the script and post-copy claims lint, and the template tempo (
// `tempo`) for the script's tempo contract. Generic core: nothing here names a project or a pack.
//
// Rules:
// - A pack that declares claims always gives its claims: when the full pack does not load (a broken asset, a missing
//   file), the `claims` object is still read from pack.json on its own, so a broken pack never relaxes the lint to
//   "no policy". Only a pack.json that cannot be read or has no valid `claims` gives null (the strict default:
//   every reserved claim key is denied).
// - The tempo is the first template in the manifest's `templates` order whose builder is `story-spine@1` and whose
//   `tempo` is valid (90 ≤ low ≤ high ≤ 128, 2 or 4 chant beats per card). Until a recipe names its pack template,
//   the first one is the project's default; with none, the script keeps its built-in default.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PackClaimsPolicy } from '../executors/claims';
import type { TemplateTempo } from '../executors/script';
import type { ProjectLike } from '../types';
import { packDirOf } from '../store/paths';
import { insideDir, loadProjectPack, type LoadedPack } from './load';
import { packManifestSchema } from './schema';

export interface PackPolicy {
  claims: PackClaimsPolicy | null;
  tempo: TemplateTempo | null;
  /** The pack template the tempo came from (its id), or null. */
  tempoFrom: string | null;
}

export const NO_PACK_POLICY: PackPolicy = { claims: null, tempo: null, tempoFrom: null };

const tempoSchema = z
  .object({ bpmRange: z.tuple([z.number().min(90).max(128), z.number().min(90).max(128)]), chantBeatsPerCard: z.union([z.literal(2), z.literal(4)]) })
  .refine((t) => t.bpmRange[0] <= t.bpmRange[1]);
const templateSchema = z.object({ id: z.string(), builder: z.string(), tempo: tempoSchema });
const claimsOnly = z.object({ claims: packManifestSchema.shape.claims });

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file, 'utf8'));
  } catch {
    return null;
  }
}

/** The template tempo of a loaded pack (see the rules above). */
export async function packTempo(pack: Pick<LoadedPack, 'dir' | 'manifest'>): Promise<{ tempo: TemplateTempo | null; from: string | null }> {
  for (const rel of pack.manifest.templates) {
    let file: string;
    try {
      file = await insideDir(pack.dir, rel);
    } catch {
      continue;
    }
    const t = templateSchema.safeParse(await readJson(file));
    if (t.success && t.data.builder === 'story-spine@1') return { tempo: { bpmRange: [t.data.tempo.bpmRange[0], t.data.tempo.bpmRange[1]], chantBeatsPerCard: t.data.tempo.chantBeatsPerCard }, from: t.data.id };
  }
  return { tempo: null, from: null };
}

/** The claims policy and tempo of a project's pack; NO_PACK_POLICY when the project has no pack. */
export async function packPolicy(project: Pick<ProjectLike, 'contentDir' | 'pack'>, root: string): Promise<PackPolicy> {
  let pack: LoadedPack | null;
  try {
    pack = await loadProjectPack(project, root);
  } catch {
    // The pack does not load: its claims still apply (read from pack.json alone); no tempo.
    const raw = claimsOnly.safeParse(await readJson(path.join(packDirOf(project), 'pack.json')));
    return { claims: raw.success ? { allowed: [...raw.data.claims.allowed], denied: [...raw.data.claims.denied] } : null, tempo: null, tempoFrom: null };
  }
  if (!pack) return NO_PACK_POLICY;
  const { tempo, from } = await packTempo(pack);
  return { claims: { allowed: [...pack.manifest.claims.allowed], denied: [...pack.manifest.claims.denied] }, tempo, tempoFrom: from };
}
