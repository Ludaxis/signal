// Recipe workspaces: recipes/<id>/recipe.json (the mutable index), recipe/v<n>.json and pipeline/v<n>.json
// (write-once versions). Also opens the store (postmaker/VERSION) and keeps the last pack lock.
import { PostmakerError } from '../errors';
import type { PackLock, Pipeline, ProjectLike, Recipe, RecipeIndex } from '../types';
import { checkSchema, ensureDir, listDir, pretty, readJsonFile, readText, writeOnce, writeReplace } from './fs';
import { withLock } from './mutex';
import {
  assertRecipeId,
  newRecipeId,
  packLockFile,
  pipelineVersionFile,
  recipeIndexFile,
  recipeVersionFile,
  RECIPE_ID_RE,
  STORE_VERSION,
  versionFile,
} from './paths';
import path from 'node:path';

/** Creates the store folder (0700) and its VERSION file; refuses a store made by a newer Signal. */
export async function openStore(root: string): Promise<void> {
  await ensureDir(root);
  const text = await readText(versionFile(root));
  if (text === null) {
    await writeOnce(versionFile(root), `${STORE_VERSION}\n`).catch((e) => {
      if ((e as PostmakerError).code !== 'exists') throw e;
    });
    return;
  }
  const v = Number(text.trim());
  if (!Number.isInteger(v)) throw new PostmakerError(422, 'unreadable', 'The Post maker folder could not be read.');
  if (v > STORE_VERSION) throw new PostmakerError(409, 'schema-newer', 'Made by a newer Signal');
}

const recipeLock = (root: string, id: string) => `pm-recipe:${path.join(root, 'recipes', id)}`;

export type RecipeDraft = Omit<Recipe, 'schema' | 'id' | 'version'>;

export async function createRecipe(
  root: string,
  project: Pick<ProjectLike, 'id' | 'timeZone'>,
  draft: RecipeDraft,
  o: { now?: number; forkOf?: RecipeIndex['forkOf']; id?: string } = {},
): Promise<{ index: RecipeIndex; recipe: Recipe }> {
  const now = o.now ?? Date.now();
  const id = assertRecipeId(o.id ?? newRecipeId(project, now));
  if (draft.projectId !== project.id) throw new PostmakerError(400, 'validation', 'The recipe belongs to another project.');
  await openStore(root);
  return withLock(recipeLock(root, id), async () => {
    const recipe: Recipe = { schema: 'signal.pm.recipe/1', ...draft, id, version: 1 };
    await writeOnce(recipeVersionFile(root, id, 1), pretty(recipe));
    const at = new Date(now).toISOString();
    const index: RecipeIndex = { schema: 'signal.pm.recipe-index/1', id, projectId: project.id, current: 1, pipeline: null, forkOf: o.forkOf ?? null, createdAt: at, updatedAt: at };
    await writeOnce(recipeIndexFile(root, id), pretty(index));
    return { index, recipe };
  });
}

export async function readRecipeIndex(root: string, id: string): Promise<RecipeIndex | null> {
  const index = await readJsonFile<RecipeIndex>(recipeIndexFile(root, id));
  if (!index) return null;
  checkSchema(index, 'recipe-index', 1);
  if (index.id !== id) throw new PostmakerError(409, 'version-changed', 'recipe.json does not match its folder.');
  return index;
}

/** A recipe version; the current one when `n` is omitted. */
export async function readRecipe(root: string, id: string, n?: number): Promise<Recipe | null> {
  const want = n ?? (await readRecipeIndex(root, id))?.current;
  if (!want) return null;
  const r = await readJsonFile<Recipe>(recipeVersionFile(root, id, want));
  if (!r) return null;
  checkSchema(r, 'recipe', 1);
  if (r.id !== id || r.version !== want) throw new PostmakerError(409, 'version-changed', `Recipe version ${want} does not match its file.`);
  return r;
}

/** Writes recipe version current+1. `baseVersion` gives optimistic concurrency (409 "Changed since you opened it"). */
export function writeRecipeVersion(root: string, id: string, draft: RecipeDraft, o: { baseVersion?: number; now?: number } = {}): Promise<Recipe> {
  return withLock(recipeLock(root, id), async () => {
    const index = await readRecipeIndex(root, id);
    if (!index) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
    if (o.baseVersion !== undefined && o.baseVersion !== index.current) throw new PostmakerError(409, 'conflict', 'Changed since you opened it');
    if (draft.projectId !== index.projectId) throw new PostmakerError(400, 'validation', 'The recipe belongs to another project.');
    const n = index.current + 1;
    const recipe: Recipe = { schema: 'signal.pm.recipe/1', ...draft, id, version: n };
    await writeOnce(recipeVersionFile(root, id, n), pretty(recipe));
    await writeReplace(recipeIndexFile(root, id), pretty({ ...index, current: n, updatedAt: new Date(o.now ?? Date.now()).toISOString() }));
    return recipe;
  });
}

export function writePipelineVersion(root: string, id: string, draft: Omit<Pipeline, 'schema' | 'recipeId' | 'version'>, o: { baseVersion?: number | null; now?: number } = {}): Promise<Pipeline> {
  return withLock(recipeLock(root, id), async () => {
    const index = await readRecipeIndex(root, id);
    if (!index) throw new PostmakerError(404, 'not_found', 'Unknown recipe.');
    if (o.baseVersion !== undefined && o.baseVersion !== index.pipeline) throw new PostmakerError(409, 'conflict', 'Changed since you opened it');
    const n = (index.pipeline ?? 0) + 1;
    const p: Pipeline = { schema: 'signal.pm.pipeline/1', ...draft, recipeId: id, version: n };
    await writeOnce(pipelineVersionFile(root, id, n), pretty(p));
    await writeReplace(recipeIndexFile(root, id), pretty({ ...index, pipeline: n, updatedAt: new Date(o.now ?? Date.now()).toISOString() }));
    return p;
  });
}

export async function readPipeline(root: string, id: string, n?: number): Promise<Pipeline | null> {
  const want = n ?? (await readRecipeIndex(root, id))?.pipeline;
  if (!want) return null;
  const p = await readJsonFile<Pipeline>(pipelineVersionFile(root, id, want));
  if (!p) return null;
  checkSchema(p, 'pipeline', 1);
  if (p.recipeId !== id || p.version !== want) throw new PostmakerError(409, 'version-changed', `Pipeline version ${want} does not match its file.`);
  return p;
}

export async function listRecipeIds(root: string): Promise<string[]> {
  return (await listDir(path.join(root, 'recipes'))).filter((f) => RECIPE_ID_RE.test(f)).sort();
}

// ---- pack lock (the last PackLock read) -----------------------------------------------------------------

export async function writePackLock(root: string, lock: PackLock): Promise<void> {
  await openStore(root);
  await writeReplace(packLockFile(root), pretty(lock));
}

export async function readPackLock(root: string): Promise<PackLock | null> {
  const lock = await readJsonFile<PackLock>(packLockFile(root));
  if (!lock) return null;
  checkSchema(lock, 'pack-lock', 1);
  return lock;
}
