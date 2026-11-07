// Engine helpers for the Post maker tests: a recipe workspace with a story-spine pipeline in the temp store,
// an engine on the default registry (real narration-text, fakes elsewhere), a run helper and a test-only signer.
import { buildPipeline, type BuildOptions } from '@/lib/studio/postmaker/graph/build';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import type { FakeConfig } from '@/lib/studio/postmaker/executors/fakes';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import { PostmakerEngine, type EngineDeps } from '@/lib/studio/postmaker/runner';
import { createRecipe, writePipelineVersion } from '@/lib/studio/postmaker/store/recipes';
import type { Lang, Pipeline, Recipe, Run, SignOff } from '@/lib/studio/postmaker/types';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import { tmp } from './guard';
import { FACES, PROJECT, recipeDraft, T0 } from './recipe-fixture';

export { BEATS, FACES, PROJECT, recipeDraft, T0 } from './recipe-fixture';

/** Every line 2,500 ms by default; tests scale one line per take. */
export function scriptedVoice(table: Record<string, number> = {}) {
  const scale: Record<string, number> = {};
  const fn: NonNullable<FakeConfig['voiceMs']> = (lineId, lang) => Math.round((table[`${lineId}:${lang}`] ?? 2500) * (scale[`${lineId}:${lang}`] ?? 1));
  return { fn, scale };
}

export interface Setup {
  engine: PostmakerEngine;
  recipeId: string;
  recipe: Recipe;
  pipeline: Pipeline;
  fakes: FakeConfig;
  now: { t: number };
}

export async function setup(o: { langs?: Lang[]; build?: BuildOptions; pipeline?: (p: Omit<Pipeline, 'schema' | 'recipeId' | 'version'>) => Omit<Pipeline, 'schema' | 'recipeId' | 'version'>; fakes?: FakeConfig; deps?: Partial<EngineDeps>; id?: string } = {}): Promise<Setup> {
  const now = { t: T0 };
  const { recipe } = await createRecipe(tmp.root, PROJECT, recipeDraft(o.langs), { now: T0, id: o.id ?? 'rc-20261106-0001' });
  let built = buildPipeline(recipe, o.build ?? FACES);
  if (o.pipeline) built = o.pipeline(built);
  const pipeline = await writePipelineVersion(tmp.root, recipe.id, built, { now: T0 });
  const fakes: FakeConfig = { counters: newCounters(), ...o.fakes };
  const engine = new PostmakerEngine({
    root: tmp.root,
    project: PROJECT,
    executors: defaultExecutors({ fakes }),
    packLock: null,
    now: () => (now.t += 1000),
    ...o.deps,
  });
  return { engine, recipeId: recipe.id, recipe, pipeline, fakes, now };
}

/** Estimate, then Run with the confirmed token; resolves when the run stops. */
export async function runAll(engine: PostmakerEngine, recipeId: string, o: { capUsd?: number } = {}): Promise<Run> {
  const { estimate } = await engine.estimate(recipeId, { all: true });
  const h = await engine.run({ recipeId, scope: { all: true }, estimateToken: estimate.token, capUsd: o.capUsd });
  return h.done;
}

/** A named-person sign-off for every gated node's current version (tests of the live path only). */
export function signAll(recipeId: string): (rid: string, nodeId: string) => Promise<SignOff[]> {
  return async (rid, nodeId) => {
    if (rid !== recipeId) return [];
    const h = await readHead(tmp.root, rid, nodeId);
    if (h.current === null) return [];
    const v = await readVersion(tmp.root, rid, nodeId, h.current);
    if (!v) return [];
    const gate = nodeId.startsWith('narration-text:fa') ? 'fa-native-editor' : nodeId.startsWith('voice:fa') ? 'fa-native-listener' : null;
    if (!gate) return [];
    return [{ gate, nodeId, version: v.n, hash: v.hash, by: 'editor@example.test', name: 'Editor A', at: '2026-11-06T10:00:00.000Z', verdict: 'pass' }];
  };
}

export async function versionsOf(recipeId: string, nodeIds: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const id of nodeIds) out[id] = (await readHead(tmp.root, recipeId, id)).current;
  return out;
}
