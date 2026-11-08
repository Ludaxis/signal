// The templates server:
// the store side of every template action. service.ts dispatches here and starts the run for Make a post.
// - make-post: a fork of the template (fork.ts) with the brief, optionally made for a planned campaign slot (the
//   slot prefills the brief; a slot already made, skipped or naming another template is refused).
// - variant.save, repeat.set, skip-proof.set, campaign.attach / detach, duplicate, retire: validated changes of the
//   template file (template-rules.ts holds the rules). Repeat is stored only: nothing here schedules or runs it.
// Nothing here deletes a file. Generic core: no project names.
import { getCampaign, getPlan } from '../campaigns';
import { PostmakerError } from './errors';
import { checkLegacyRepeatInput, notLegacy } from './migrate/legacy';
import { forkTemplate, type Brief, type ForkResult } from './fork';
import { newTemplateId, newVariantId } from './store/paths';
import { readRecipe } from './store/recipes';
import { readRun } from './store/runs';
import { createTemplate, listTemplates, readTemplate, updateTemplate } from './store/templates';
import { readVersion } from './store/versions';
import { checkRepeat, CORE_TEMPLATE_LIMITS, duplicateOf, retired, saveVariant, setSkipProof, templateSummary, type TemplateLimits } from './template-rules';
import type { Lang, ProjectLike, RecipeIndex, RecipeSlot, RepeatInput, Run, Shape, Template, TemplateSummary, TemplateVariant, VariantDraft } from './types';

export async function templateOr404(root: string, id: string): Promise<Template> {
  const t = await readTemplate(root, id);
  if (!t) throw new PostmakerError(404, 'not_found', 'Unknown template.');
  return t;
}

const notRetired = (t: Template) => {
  if (t.status === 'retired') throw new PostmakerError(409, 'conflict', 'This template is retired.');
};

/** What this template can make. The core builder's limits until a pack template is linked to it. */
export const templateLimits = (_t: Template, override?: TemplateLimits): TemplateLimits => override ?? CORE_TEMPLATE_LIMITS;

/** The languages a variant may choose: the ones the template's proof was made in. */
async function templateLanguages(root: string, t: Template) {
  const r = await readRecipe(root, t.recipeId, t.snapshot.recipeVersion).catch(() => null);
  if (!r) throw new PostmakerError(409, 'conflict', 'The proof this template was made from is missing.');
  return r.languages;
}

// ---- make-post ---------------------------------------------------------------------------------------------------

const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** The planned slot a post is made for, and the brief it prefills (the person's own fields win). */
export async function slotFor(templateId: string, ask: { campaignId: string; slotId: string }, brief: Partial<Brief> | undefined): Promise<{ slot: RecipeSlot; brief: Brief }> {
  const campaign = await getCampaign(ask.campaignId);
  const s = (await getPlan(ask.campaignId)).slots.find((x) => x.id === ask.slotId);
  if (!s) throw new PostmakerError(404, 'not_found', 'Unknown slot.');
  if (s.status !== 'planned') throw new PostmakerError(409, 'conflict', 'This slot already has a post.');
  if (s.templateId && s.templateId !== templateId) throw new PostmakerError(409, 'conflict', 'This slot uses another template.');
  const topic = brief?.topic?.trim() || clip(s.angle || s.hook || s.pillar || s.captionLead || '', 200);
  if (!topic) throw new PostmakerError(400, 'validation', 'Give the post a topic.');
  const hook = brief?.hook?.trim() || clip(s.hook ?? '', 200);
  const notes = brief?.notes?.trim() || clip(s.captionLead ?? '', 2000);
  return {
    slot: { campaignId: campaign.id, slotId: s.id, at: s.at ?? null, name: clip(campaign.name ?? '', 80) || null },
    brief: { topic, ...(hook ? { hook } : {}), ...(notes ? { notes } : {}) },
  };
}

/** `template.make-post`: the fork, ready to run (the caller estimates and starts it). */
export async function makePostFork(o: {
  root: string;
  project: Pick<ProjectLike, 'id' | 'timeZone'>;
  templateId: string;
  variantId?: string;
  brief?: Brief;
  campaignSlot?: { campaignId: string; slotId: string };
  capUsd?: number;
  by: string;
  now: number;
}): Promise<ForkResult & { template: Template; variant: TemplateVariant | null; slot: RecipeSlot | null }> {
  const template = await templateOr404(o.root, o.templateId);
  notRetired(template);
  notLegacy(template);
  const variant = o.variantId ? (template.variants.find((v) => v.id === o.variantId) ?? null) : null;
  if (o.variantId && !variant) throw new PostmakerError(404, 'not_found', 'Unknown variant.');
  let brief: Brief;
  let slot: RecipeSlot | null = null;
  if (o.campaignSlot) ({ slot, brief } = await slotFor(template.id, o.campaignSlot, o.brief));
  else {
    if (!o.brief?.topic?.trim()) throw new PostmakerError(400, 'validation', 'Give the post a topic.');
    brief = { topic: o.brief.topic.trim(), ...(o.brief.hook?.trim() ? { hook: o.brief.hook.trim() } : {}), ...(o.brief.notes?.trim() ? { notes: o.brief.notes.trim() } : {}) };
  }
  const fork = await forkTemplate({ root: o.root, project: o.project, template, variant, brief, slot, capUsd: o.capUsd, by: o.by, now: o.now });
  return { ...fork, template, variant, slot };
}

// ---- template changes --------------------------------------------------------------------------------------------

export async function saveVariantAction(root: string, templateId: string, draft: VariantDraft, limits?: TemplateLimits): Promise<{ template: Template; variant: TemplateVariant }> {
  const t = await templateOr404(root, templateId);
  notRetired(t);
  notLegacy(t);
  const languages = await templateLanguages(root, t);
  let variant!: TemplateVariant;
  const template = await updateTemplate(root, templateId, (cur) => {
    const r = saveVariant(cur, draft, { limits: templateLimits(cur, limits), languages, newId: newVariantId });
    variant = r.variant;
    return r.template;
  });
  return { template, variant };
}

export const REPEAT_NEEDS_PROVEN = 'Prove this template before it repeats.';

/** `template.repeat.set`: validated and stored, off unless asked; on only for a Proven template. Runs nothing. */
export async function setRepeatAction(root: string, templateId: string, input: RepeatInput): Promise<Template> {
  const t = await templateOr404(root, templateId);
  // A moved pipeline keeps the pipeline ranges (a budget under $0.50 stays allowed).
  const repeat = t.legacy ? checkLegacyRepeatInput(input) : checkRepeat(input);
  notRetired(t);
  if (repeat.enabled && t.status !== 'proven') throw new PostmakerError(409, 'conflict', REPEAT_NEEDS_PROVEN);
  return updateTemplate(root, templateId, (cur) => ({ ...cur, repeat }));
}

export async function setSkipProofAction(root: string, templateId: string, variantId: string | null, on: boolean): Promise<Template> {
  await templateOr404(root, templateId);
  return updateTemplate(root, templateId, (cur) => setSkipProof(cur, variantId, on));
}

export async function retireAction(root: string, templateId: string): Promise<Template> {
  await templateOr404(root, templateId);
  return updateTemplate(root, templateId, retired);
}

export const MAX_CAMPAIGNS = 20;

/** Attach: the campaign must exist; attaching twice changes nothing. Detach: removing an absent id changes nothing. */
export async function campaignAction(root: string, templateId: string, campaignId: string, attach: boolean): Promise<Template> {
  const t = await templateOr404(root, templateId);
  if (attach) {
    notRetired(t);
    await getCampaign(campaignId); // 404 for an unknown campaign
    if (t.campaignIds.includes(campaignId)) return t;
    if (t.campaignIds.length >= MAX_CAMPAIGNS) throw new PostmakerError(409, 'conflict', `A template is on at most ${MAX_CAMPAIGNS} campaigns.`);
    return updateTemplate(root, templateId, (cur) => ({ ...cur, campaignIds: cur.campaignIds.includes(campaignId) ? cur.campaignIds : [...cur.campaignIds, campaignId] }));
  }
  if (!t.campaignIds.includes(campaignId)) return t;
  return updateTemplate(root, templateId, (cur) => ({ ...cur, campaignIds: cur.campaignIds.filter((c) => c !== campaignId) }));
}

/** `template.duplicate`: a new Draft beside the original, pointing at the same snapshot (no copied files). */
export async function duplicateAction(root: string, project: Pick<ProjectLike, 'timeZone'>, templateId: string, name: string | undefined, now: number): Promise<Template> {
  const t = await templateOr404(root, templateId);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await createTemplate(root, duplicateOf(t, { id: newTemplateId(project, now), name }));
    } catch (e) {
      if (!(e instanceof PostmakerError && e.code === 'exists')) throw e;
    }
  }
  throw new PostmakerError(409, 'conflict', 'Could not find a free template id. Try again.');
}

// ---- read models -------------------------------------------------------------------------------------------------

/** The template a recipe belongs to: the one it was forked from, else the newest one that proved it (not retired first). */
export async function templateOfRecipe(root: string, recipeId: string, forkOf: RecipeIndex['forkOf']): Promise<TemplateSummary | null> {
  if (forkOf) {
    const t = await readTemplate(root, forkOf.templateId).catch(() => null);
    return t ? templateSummary(t) : null;
  }
  const mine = (await listTemplates(root).catch(() => [] as Template[])).filter((t) => t.recipeId === recipeId);
  const pick = mine.filter((t) => t.status !== 'retired').at(-1) ?? mine.at(-1) ?? null;
  return pick ? templateSummary(pick) : null;
}

/**
 * What a template card and the Proven screen show beside the summary ("‹n› steps · ~$ · ~min", the
 * cover, the last run): the step count of the frozen snapshot, the spend and time of the run that made the template
 * (its proof, else the newest run of its source recipe), the source recipe's languages, length and shape (the
 * default variant), and the newest run made from it. Read-only; a missing run or recipe leaves its fields null.
 */
export interface TemplateCard {
  steps: number;
  /** Actual spend of the proof run (null without one). */
  usd: number | null;
  /** Elapsed seconds of the proof run (null without a finished one). */
  seconds: number | null;
  lastRunAt: string | null;
  languages: Lang[];
  lengthSec: number | null;
  shape: Shape | null;
  /** The proof run's first rendered cover, served through the media route of `recipeId`. */
  cover: { recipeId: string; sha256: string } | null;
}

/** The first rendered cover image of a run (render's `cover` port), or null. */
export async function runCover(root: string, r: Pick<Run, 'recipeId' | 'steps'>): Promise<{ recipeId: string; sha256: string } | null> {
  for (const st of r.steps) {
    if (!st.nodeId.startsWith('render') || st.version === null) continue;
    const v = await readVersion(root, r.recipeId, st.nodeId, st.version).catch(() => null);
    const ref = v?.outputs.find((o) => o.port === 'cover' && o.kind === 'image');
    if (ref) return { recipeId: r.recipeId, sha256: ref.sha256 };
  }
  return null;
}

/** `runs` are the newest runs, newest first (Home reads 20); the proof run is read by id when it is older. */
export async function templateCard(root: string, t: Template, runs: readonly Run[]): Promise<TemplateCard> {
  const mine = runs.filter((r) => r.templateId === t.id || r.recipeId === t.recipeId);
  const proof = (t.provenRunId ? (runs.find((r) => r.id === t.provenRunId) ?? (await readRun(root, t.provenRunId).catch(() => null))) : null) ?? runs.find((r) => r.recipeId === t.recipeId && (r.status === 'done' || r.status === 'needs-you')) ?? null;
  const recipe = await readRecipe(root, t.recipeId, t.snapshot.recipeVersion).catch(() => null);
  const secs = proof?.finishedAt ? Math.max(0, (Date.parse(proof.finishedAt) - Date.parse(proof.startedAt)) / 1000) : null;
  return {
    steps: Object.keys(t.snapshot.heads).length,
    usd: proof ? proof.spentUsd : null,
    seconds: secs !== null && Number.isFinite(secs) ? Math.round(secs) : null,
    lastRunAt: mine[0]?.startedAt ?? null,
    languages: recipe?.languages ?? [],
    lengthSec: recipe?.lengthSec ?? null,
    shape: recipe?.shape ?? null,
    cover: proof ? await runCover(root, proof) : null,
  };
}
