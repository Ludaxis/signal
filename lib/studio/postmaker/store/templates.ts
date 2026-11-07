// Templates: templates/<templateId>.json. A template's snapshot points at step versions by hash; it never
// copies objects. `revision` is the store's own counter: 1 on create, +1 on every update, whatever the caller
// passes; a file from before the counter reads as revision 1.
import { PostmakerError } from '../errors';
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
  }
  if (!Number.isInteger(t.premiumStreak) || t.premiumStreak < 0) throw new PostmakerError(400, 'validation', 'premiumStreak must be a whole number ≥ 0.');
  if (!Number.isInteger(t.revision) || t.revision < 1) throw new PostmakerError(400, 'validation', 'revision must be a whole number ≥ 1.');
}

/** Migration: a template written before the revision counter reads as revision 1. */
const withRevision = (t: Template): Template => (Number.isInteger((t as Partial<Template>).revision) ? t : { ...t, revision: 1 });

export async function createTemplate(root: string, t: Omit<Template, 'revision'> & { revision?: number }): Promise<Template> {
  const next: Template = { ...t, revision: 1 };
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
    const next: Template = { ...change(t), revision: t.revision + 1 };
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
