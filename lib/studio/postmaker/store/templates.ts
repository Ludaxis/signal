// Templates: templates/<templateId>.json. A template's snapshot points at step versions by hash; it never
// copies objects. `revision` is the store's own counter: 1 on create, +1 on every update, whatever the caller
// passes; a file from before the counter reads as revision 1. A variant from before the per-variant streak
// reads as streak 0 with skip-proof off (the revision is unchanged by reading); Repeat settings are validated on write.
import { PostmakerError } from '../errors';
import { checkLegacy, checkLegacyRepeat } from '../migrate/legacy';
import { checkRepeat, withVariantDefaults } from '../template-rules';
import type { Template } from '../types';
import { checkSchema, listDir, pretty, readJsonFile, writeOnce, writeReplace } from './fs';
import { withLock } from './mutex';
import { assertTemplateId, SHA_RE, templateFile, TEMPLATE_ID_RE, VARIANT_ID_RE } from './paths';
import path from 'node:path';

function validTemplate(t: Template): void {
  checkSchema(t, 'template', 1);
  assertTemplateId(t.id);
  if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 80) throw new PostmakerError(400, 'validation', 'Give the template a name (up to 80 characters).');
  for (const [nodeId, h] of Object.entries(t.snapshot.heads)) {
    if (!SHA_RE.test(h.hash) || !Number.isInteger(h.version) || h.version < 1) throw new PostmakerError(400, 'validation', `The snapshot of ${nodeId} is not valid.`);
  }
  const ids = new Set<string>();
  for (const v of t.variants) {
    if (!VARIANT_ID_RE.test(v.id) || ids.has(v.id)) throw new PostmakerError(400, 'validation', 'Variant ids must be unique.');
    ids.add(v.id);
    if (!Number.isInteger(v.premiumStreak) || v.premiumStreak < 0) throw new PostmakerError(400, 'validation', 'A variant streak must be a whole number ≥ 0.');
    if (typeof v.skipProofForRepeats !== 'boolean') throw new PostmakerError(400, 'validation', 'A variant skip-proof setting is on or off.');
  }
  // A moved pipeline keeps its own ranges (a budget under $0.50 stays as it was).
  if (t.legacy) checkLegacy(t.legacy);
  if (t.repeat !== null) {
    if (t.legacy) checkLegacyRepeat(t.repeat);
    else checkRepeat(t.repeat);
  }
  if (!Array.isArray(t.campaignIds) || new Set(t.campaignIds).size !== t.campaignIds.length || !t.campaignIds.every((c) => /^c-\d{8}-[0-9a-z]{4}$/.test(c))) {
    throw new PostmakerError(400, 'validation', 'Campaign ids must be unique campaign ids.');
  }
  if (!Number.isInteger(t.premiumStreak) || t.premiumStreak < 0) throw new PostmakerError(400, 'validation', 'premiumStreak must be a whole number ≥ 0.');
  if (!Number.isInteger(t.revision) || t.revision < 1) throw new PostmakerError(400, 'validation', 'revision must be a whole number ≥ 1.');
}

/** Migration: a template written before the revision counter reads as revision 1. */
const withRevision = (t: Template): Template => withVariantDefaults(Number.isInteger((t as Partial<Template>).revision) ? t : { ...t, revision: 1 });

export async function createTemplate(root: string, t: Omit<Template, 'revision'> & { revision?: number }): Promise<Template> {
  const next: Template = withVariantDefaults({ ...t, revision: 1 });
  validTemplate(next);
  await writeOnce(templateFile(root, next.id), pretty(next));
  return next;
}

export async function readTemplate(root: string, id: string): Promise<Template | null> {
  const t = await readJsonFile<Template>(templateFile(root, id));
  if (!t) return null;
  checkSchema(t, 'template', 1);
  if (t.id !== id) throw new PostmakerError(409, 'version-changed', 'The template file does not match its name.');
  return withRevision(t);
}

export function updateTemplate(root: string, id: string, change: (t: Template) => Template): Promise<Template> {
  return withLock(`pm-template:${templateFile(root, id)}`, async () => {
    const t = await readTemplate(root, id);
    if (!t) throw new PostmakerError(404, 'not_found', 'Unknown template.');
    const next: Template = withVariantDefaults({ ...change(t), revision: t.revision + 1 });
    if (next.id !== id) throw new PostmakerError(400, 'validation', 'A template cannot change its id.');
    validTemplate(next);
    await writeReplace(templateFile(root, id), pretty(next));
    return next;
  });
}

export async function listTemplates(root: string): Promise<Template[]> {
  const out: Template[] = [];
  for (const f of (await listDir(path.join(root, 'templates'))).sort()) {
    const id = f.replace(/\.json$/, '');
    if (!f.endsWith('.json') || !TEMPLATE_ID_RE.test(id)) continue;
    const t = await readTemplate(root, id);
    if (t) out.push(t);
  }
  return out;
}
