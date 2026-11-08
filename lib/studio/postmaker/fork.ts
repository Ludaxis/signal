// Fork: "Make a post" (or a variant's "Run proof", later a repeat slot) makes a new
// recipe workspace `rc-…` with `forkOf {templateId, variantId}` from a template's frozen snapshot.
// - The recipe is the snapshot's recipe version with the variant's language, length and shape (beats scaled to the
//   new length), the campaign slot when there is one, and the cap.
// - The pipeline is the snapshot's pipeline version, cut to the fork's languages; the brief enters as the `script`
//   step's `brief` setting (and the variant's voice, music and dual captions as those steps' settings), so exactly
//   the steps that depend on what changed are out of date, and a locked step stops it.
// - Each head points at the snapshot's version: a `source: 'fork'` version in the fork with the same outputs (the
//   very same objects, no copy and no new object file), its inputs re-pointed at the fork's own versions, and
//   `forkedFrom` naming the template version by hash (what `gatesInherited` compares). A version whose inputs come
//   from a step the fork does not have is left out (that step is "Not run"). Steps in `inputs.lockedNodes` start
//   locked. A snapshot version whose hash no longer matches the file is refused (409), never forked.
// Nothing runs here; the caller estimates and runs the plan. No network. Generic core: no project names.
import { PostmakerError } from './errors';
import { validatePipeline, edgesOf, topoOrder } from './graph/validate';
import { commitVersion } from './store/commit';
import { lockStep } from './store/heads';
import { createRecipe, readPipeline, readRecipe, writePipelineVersion, type RecipeDraft } from './store/recipes';
import { readVersion } from './store/versions';
import type { Lang, Pipeline, PipelineNode, ProjectLike, Recipe, RecipeBeat, RecipeSlot, StepVersion, Template, TemplateVariant } from './types';

export interface Brief {
  topic: string;
  hook?: string;
  notes?: string;
}

export interface ForkInput {
  root: string;
  project: Pick<ProjectLike, 'id' | 'timeZone'>;
  template: Template;
  variant: TemplateVariant | null;
  brief: Brief;
  slot: RecipeSlot | null;
  capUsd?: number;
  by: string;
  now: number;
}

export interface ForkResult {
  recipe: Recipe;
  pipeline: Pipeline;
  /** Steps whose head points at the template's version. */
  forked: string[];
  /** Steps that start locked (`inputs.lockedNodes`). */
  locked: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The recipe beats scaled from `from` to `to` seconds (same order and ids; the last beat ends at `to`). */
export function scaleBeats(beats: RecipeBeat[], from: number, to: number): RecipeBeat[] {
  if (from === to || from <= 0) return beats.map((b) => ({ ...b }));
  const f = to / from;
  return beats.map((b, i) => ({ ...b, start: r2(b.start * f), end: i === beats.length - 1 ? to : r2(b.end * f) }));
}

/** The fork's recipe draft: the snapshot's recipe with the variant's language, length and shape. */
export function forkRecipeDraft(source: Recipe, o: { projectId: string; variant: TemplateVariant | null; slot: RecipeSlot | null; capUsd?: number }): RecipeDraft {
  const { schema: _s, id: _i, version: _v, ...rest } = source;
  void _s;
  void _i;
  void _v;
  const p = o.variant?.params ?? {};
  const languages: Lang[] = p.lang ? [p.lang] : [...source.languages];
  const lengthSec = p.lengthSec ?? source.lengthSec;
  const beats = scaleBeats(source.beats, source.lengthSec, lengthSec).map((b) => ({ ...b, onScreenText: Object.fromEntries(languages.map((l) => [l, b.onScreenText[l] ?? ''])) }));
  return {
    ...rest,
    projectId: o.projectId,
    campaignId: o.slot?.campaignId ?? null,
    languages,
    lengthSec,
    shape: p.shape ?? source.shape,
    beats,
    capUsd: o.capUsd ?? source.capUsd,
    stopAfterRecipe: false,
    slot: o.slot,
  };
}

/**
 * The fork's pipeline: the snapshot's nodes for the fork's languages (inputs and rules from a dropped lane removed),
 * with the brief on `script` and the variant's settings on the steps they belong to.
 */
export function forkPipelineDraft(source: Pick<Pipeline, 'nodes' | 'builtFrom'>, o: { languages: Lang[]; brief: Brief; variant: TemplateVariant | null }): Omit<Pipeline, 'schema' | 'recipeId' | 'version'> {
  const keep = source.nodes.filter((n) => n.lang === null || o.languages.includes(n.lang));
  const ids = new Set(keep.map((n) => n.id));
  const v = o.variant?.params ?? {};
  const brief = { topic: o.brief.topic, ...(o.brief.hook ?? v.hook ? { hook: o.brief.hook ?? v.hook } : {}), ...(o.brief.notes ? { notes: o.brief.notes } : {}) };
  const nodes: PipelineNode[] = keep.map((n) => {
    const params: Record<string, unknown> = { ...n.params };
    if (n.kind === 'script') params.brief = brief;
    if (n.kind === 'voice' && v.voice !== undefined) params.voice = v.voice;
    if (n.kind === 'music' && v.music !== undefined) params.music = v.music;
    if (n.kind === 'captions' && v.dualCaptions !== undefined) params.dualCaptions = v.dualCaptions;
    return { ...n, params, inputs: n.inputs.filter((i) => ids.has(i.from)), expects: n.expects.filter((e) => ids.has(e.from)) };
  });
  return { builtFrom: source.builtFrom, nodes, edges: edgesOf(nodes) };
}

/** Makes the fork (recipe, pipeline, heads at the snapshot's versions). Throws 409 when the snapshot is gone or changed. */
export async function forkTemplate(o: ForkInput): Promise<ForkResult> {
  const t = o.template;
  if (t.status === 'retired') throw new PostmakerError(409, 'conflict', 'This template is retired.');
  const source = await readRecipe(o.root, t.recipeId, t.snapshot.recipeVersion);
  const sourcePipeline = await readPipeline(o.root, t.recipeId, t.snapshot.pipelineVersion);
  if (!source || !sourcePipeline) throw new PostmakerError(409, 'conflict', 'The proof this template was made from is missing.');
  // Read and check every snapshot version first: nothing is written for a template whose history changed.
  const sourceVersions = new Map<string, StepVersion>();
  for (const [nodeId, h] of Object.entries(t.snapshot.heads)) {
    const v = await readVersion(o.root, t.recipeId, nodeId, h.version).catch(() => null);
    if (!v || v.hash !== h.hash) throw new PostmakerError(409, 'conflict', `The saved ${nodeId} of this template has changed. Accept a new proof first.`);
    sourceVersions.set(nodeId, v);
  }
  const draft = forkRecipeDraft(source, { projectId: o.project.id, variant: o.variant, slot: o.slot, capUsd: o.capUsd });
  const built = forkPipelineDraft(sourcePipeline, { languages: draft.languages, brief: o.brief, variant: o.variant });
  validatePipeline(built);
  const { recipe } = await createRecipe(o.root, o.project, draft, { now: o.now, forkOf: { templateId: t.id, variantId: o.variant?.id ?? null } });
  const pipeline = await writePipelineVersion(o.root, recipe.id, built, { now: o.now });

  const forkHash = new Map<string, string>();
  const forked: string[] = [];
  const iso = new Date(o.now).toISOString();
  for (const nodeId of topoOrder(pipeline.nodes).order) {
    const src = sourceVersions.get(nodeId);
    if (!src || src.status === 'candidate') continue;
    if (!src.inputs.every((i) => forkHash.has(i.nodeId))) continue; // made from a step this fork does not have
    const { schema: _s, n: _n, hash: _h, createdAt: _c, ...rest } = src;
    void _s;
    void _n;
    void _h;
    void _c;
    const { version } = await commitVersion(
      o.root,
      {
        ...rest,
        recipeId: recipe.id,
        createdAt: iso,
        source: 'fork',
        runId: null,
        inputs: src.inputs.map((i) => ({ ...i, version: 1, hash: forkHash.get(i.nodeId)! })),
        signoffs: [],
        forkedFrom: { recipeId: src.recipeId, nodeId, n: src.n, hash: src.hash },
      },
      { now: o.now },
    );
    forkHash.set(nodeId, version.hash);
    forked.push(nodeId);
  }
  const locked: string[] = [];
  for (const nodeId of t.inputs.lockedNodes) {
    if (!pipeline.nodes.some((n) => n.id === nodeId)) continue;
    await lockStep(o.root, recipe.id, nodeId, o.by, o.now);
    locked.push(nodeId);
  }
  return { recipe, pipeline, forked, locked };
}
