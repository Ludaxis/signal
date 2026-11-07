// @vitest-environment node
// Templates server:
// Fork (locked steps keep their versions, dependents out of date, a mock run reaches Proof), shared
// objects, variant save and a variant proof, streak per template + variant, skip-proof, gatesInherited,
// Repeat validation, campaign attach / detach and slot-made accepts. Network guard on; fakes and stubs only
// (stub connectors are flagged live inside these tests only); nothing schedules or runs Repeat.
import './guard';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptProof } from '@/lib/studio/postmaker/accept';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { deriveStatus } from '@/lib/studio/postmaker/graph/status';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { _setServiceDeps, engineFor, handleAction, home, recipeView, type ServiceProject } from '@/lib/studio/postmaker/service';
import { readRecipe, readRecipeIndex } from '@/lib/studio/postmaker/store/recipes';
import { readRun } from '@/lib/studio/postmaker/store/runs';
import { listTemplates, readTemplate, updateTemplate } from '@/lib/studio/postmaker/store/templates';
import { makePostFork } from '@/lib/studio/postmaker/template-actions';
import { gatesInherited } from '@/lib/studio/postmaker/template-rules';
import type { ExecutorRegistry } from '@/lib/studio/postmaker/executors/types';
import type { PostmakerAction, PostmakerMark, Run, Template, TemplateVariant } from '@/lib/studio/postmaker/types';
import { cleanRun, postsProject, withPostsProject, withVerdict } from './accept-fixtures';
import { tmp } from './guard';

withPostsProject();

const ACTOR = { email: 'owner@example.test' };
const project = (): ServiceProject => postsProject();
const act = (a: PostmakerAction) => handleAction(project(), ACTOR, a);

beforeEach(() => {
  _resetEngineState();
  _resetSchedulerState();
  useVerdict('premium');
});
afterEach(() => _setServiceDeps({}));

function useVerdict(v: 'premium' | 'standard', executors?: ExecutorRegistry) {
  _setServiceDeps({ executors: executors ?? withVerdict(v), allowed: () => true, buildOptions: () => ({}) });
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const x = e as { status: number; code: string; message: string };
    return { status: x.status, code: x.code, message: x.message };
  }
  throw new Error('expected a refusal');
}

/** A proven template from a clean English stub run (no Persian gates), accepted Premium: streak 1. */
async function provenTemplate(o: { lockedNodes?: string[] } = {}): Promise<Template> {
  const s = await cleanRun({ verdict: 'premium', langs: ['en'] });
  const r = await acceptProof({ engine: s.engine, root: tmp.root, project: postsProject(), runId: s.run.id, asDraft: false, templateName: 'Story spine', by: ACTOR.email });
  expect(r.template).toMatchObject({ status: 'proven', premiumStreak: 1 });
  if (!o.lockedNodes) return r.template;
  return updateTemplate(tmp.root, r.template.id, (t) => ({ ...t, inputs: { ...t.inputs, lockedNodes: o.lockedNodes! } }));
}

async function untilAtProof(runId: string): Promise<Run> {
  for (let i = 0; i < 400; i++) {
    const r = await readRun(tmp.root, runId);
    if (r && r.status === 'needs-you' && r.pausedFor === 'check') return r;
    if (r && (r.status === 'failed' || r.status === 'stopped' || (r.status === 'needs-you' && r.pausedFor !== 'check'))) throw new Error(`run stopped: ${r.status}/${r.pausedFor}`);
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('the run did not reach Proof');
}

/** Make a post through the service, wait at Proof; returns the run id and the fork's recipe id. */
async function makePost(templateId: string, extra: Partial<Extract<PostmakerAction, { action: 'template.make-post' }>> = {}): Promise<{ runId: string; recipeId: string; run: Run }> {
  const a = await act({ action: 'template.make-post', templateId, brief: { topic: 'A rainy evening' }, ...extra });
  expect(a.status).toBe(202);
  const { runId, recipeId } = a.body as { runId: string; recipeId: string };
  return { runId, recipeId, run: await untilAtProof(runId) };
}

const acceptClean = (runId: string) => act({ action: 'proof.accept', runId, asDraft: false, templateName: 'Ignored for a fork' });

function objectCount(): number {
  const dir = path.join(tmp.root, 'objects', 'sha256');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((n, d) => n + (statSync(path.join(dir, d)).isDirectory() ? readdirSync(path.join(dir, d)).length : 0), 0);
}

describe('Make a post forks the template', () => {
  it('locked steps keep the template versions, the brief marks exactly the dependent steps out of date, and no object is copied', async () => {
    const t = await provenTemplate({ lockedNodes: ['art', 'music'] });
    const before = objectCount();
    const fork = await makePostFork({ root: tmp.root, project: project(), templateId: t.id, brief: { topic: 'A rainy evening', hook: 'Wait for it' }, by: ACTOR.email, now: Date.parse('2026-11-07T09:00:00Z') });
    expect(objectCount()).toBe(before); // Heads point at the same objects
    expect(await readRecipeIndex(tmp.root, fork.recipe.id)).toMatchObject({ forkOf: { templateId: t.id, variantId: null } });
    expect(fork.locked).toEqual(['art', 'music']);
    expect(fork.pipeline.nodes.find((n) => n.id === 'script')!.params).toMatchObject({ brief: { topic: 'A rainy evening', hook: 'Wait for it' } });
    const { engine } = await engineFor(project());
    const s = await engine.state(fork.recipe.id);
    const st = deriveStatus(s);
    for (const id of ['art', 'music']) {
      const v = s.current[id]!;
      expect(v.source).toBe('fork');
      expect(v.forkedFrom).toEqual({ recipeId: t.recipeId, nodeId: id, n: t.snapshot.heads[id]!.version, hash: t.snapshot.heads[id]!.hash });
      expect(st[id]).toMatchObject({ status: 'done', outOfDate: false });
      const src = (await engine.state(t.recipeId)).current[id]!;
      expect(v.outputs.map((o) => o.sha256)).toEqual(src.outputs.map((o) => o.sha256));
    }
    expect(st.script).toMatchObject({ outOfDate: true, reasons: ['Settings changed'] });
    // Every step below the script is out of date; nothing that does not depend on it is.
    const stale = Object.values(st).filter((x) => x.outOfDate).map((x) => x.nodeId).sort();
    expect(stale).toEqual(fork.pipeline.nodes.map((n) => n.id).filter((id) => id !== 'art' && id !== 'music').sort());
    // The run re-makes exactly the stale steps; the locked ones keep their template versions.
    const { estimate } = await engine.estimate(fork.recipe.id, { all: true });
    expect(estimate.nodes.map((n) => n.nodeId).sort()).toEqual(stale);
    const run = await (await engine.run({ recipeId: fork.recipe.id, scope: { all: true }, estimateToken: estimate.token })).done;
    expect(run).toMatchObject({ status: 'done', templateId: t.id, variantId: null });
    const after = await engine.state(fork.recipe.id);
    expect(after.current.art!.forkedFrom?.hash).toBe(t.snapshot.heads.art!.hash);
    expect(after.current.script!.source).toBe('run');
  });

  it('through the API: 202 with the run id, the mock run reaches Proof and Home lists the template with its variants', async () => {
    _setServiceDeps({ executors: withVerdict('premium'), buildOptions: () => ({}) }); // nothing live: mock steps
    const t = await provenTemplate();
    const { run, recipeId } = await makePost(t.id);
    expect(run).toMatchObject({ recipeId, templateId: t.id, trigger: 'make-a-post', status: 'needs-you', pausedFor: 'check' });
    expect(run.steps.some((s) => s.mode === 'mock')).toBe(true);
    // A mock proof never becomes a post: a clean accept is refused, the template is unchanged.
    expect((await refusal(acceptClean(run.id))).status).toBe(409);
    const h = await home(project());
    expect(h.templates).toEqual([expect.objectContaining({ id: t.id, status: 'proven', premiumStreak: 1, skipProofAllowed: false, variants: [], repeat: null })]);
    const view = await recipeView(project(), recipeId);
    expect(view.forkOf).toEqual({ templateId: t.id, variantId: null });
    expect(view.template).toMatchObject({ id: t.id, name: 'Story spine' });
  });

  it('refuses a retired template, an unknown variant, an unknown template and a missing topic', async () => {
    const t = await provenTemplate();
    expect(await refusal(act({ action: 'template.make-post', templateId: t.id, variantId: 'var-0000', brief: { topic: 'x' } }))).toMatchObject({ status: 404, message: 'Unknown variant.' });
    expect(await refusal(act({ action: 'template.make-post', templateId: 'tpl-20261107-ffff', brief: { topic: 'x' } }))).toMatchObject({ status: 404 });
    expect(await refusal(act({ action: 'template.make-post', templateId: t.id, brief: { topic: '   ' } }))).toMatchObject({ status: 400 });
    await act({ action: 'template.retire', templateId: t.id });
    expect(await refusal(act({ action: 'template.make-post', templateId: t.id, brief: { topic: 'x' } }))).toMatchObject({ status: 409, message: 'This template is retired.' });
  });
});

describe('variants', () => {
  it('refuses an undeclared parameter and what the template cannot make; a new variant is Draft', async () => {
    const t = await provenTemplate();
    const save = (variant: unknown) => act({ action: 'template.variant.save', templateId: t.id, variant } as PostmakerAction);
    expect(await refusal(save({ label: 'Short', params: { lengthSec: 15 } }))).toMatchObject({ status: 400, message: 'This template makes 30-90 s videos.' });
    expect(await refusal(save({ label: 'Square', params: { shape: '1:1' } }))).toMatchObject({ status: 400, message: 'This template makes 9:16 videos only.' });
    expect(await refusal(save({ label: 'Persian', params: { lang: 'fa' } }))).toMatchObject({ status: 400, message: 'This template is not made in Persian.' });
    expect(await refusal(save({ label: 'Nothing', params: {} }))).toMatchObject({ status: 400, message: 'A variant changes at least one setting.' });
    expect(await refusal(save({ label: 'Fps', params: { fps: 60 } }))).toMatchObject({ status: 400, message: 'A variant can change only the language, length, shape, hook, voice, music and dual captions.' });
    const r = await save({ label: 'Long', params: { lengthSec: 60, hook: 'Guess what' } });
    const v = (r.body as { variant: TemplateVariant }).variant;
    expect(v).toMatchObject({ label: 'Long', params: { lengthSec: 60, hook: 'Guess what' }, status: 'draft', provenRunId: null, premiumStreak: 0, skipProofForRepeats: false });
    expect(v.id).toMatch(/^var-[0-9a-f]{4}$/);
    // A new label alone keeps the variant; new parameters make it a new thing to prove.
    await updateTemplate(tmp.root, t.id, (x) => ({ ...x, variants: x.variants.map((y) => ({ ...y, status: 'proven' as const, premiumStreak: 2 })) }));
    let again = (await save({ id: v.id, label: 'Long one', params: { lengthSec: 60, hook: 'Guess what' } })).body as { variant: TemplateVariant };
    expect(again.variant).toMatchObject({ label: 'Long one', status: 'proven', premiumStreak: 2 });
    again = (await save({ id: v.id, label: 'Long one', params: { lengthSec: 45 } })).body as { variant: TemplateVariant };
    expect(again.variant).toMatchObject({ status: 'draft', premiumStreak: 0, params: { lengthSec: 45 } });
    expect(await refusal(save({ id: 'var-0000', label: 'x', params: { lengthSec: 40 } }))).toMatchObject({ status: 404 });
  });

  it('a variant proof accepted clean Premium marks only that variant Proven; the template-level streak is unaffected', { timeout: 30_000 }, async () => {
    const t = await provenTemplate();
    const a = ((await act({ action: 'template.variant.save', templateId: t.id, variant: { label: 'Long', params: { lengthSec: 60 } } })).body as { variant: TemplateVariant }).variant;
    const b = ((await act({ action: 'template.variant.save', templateId: t.id, variant: { label: 'Other hook', params: { hook: 'Look' } } })).body as { variant: TemplateVariant }).variant;
    const { run, recipeId } = await makePost(t.id, { variantId: a.id });
    expect(run).toMatchObject({ variantId: a.id, templateId: t.id });
    expect((await readRecipe(tmp.root, recipeId))!.lengthSec).toBe(60);
    const r = await acceptClean(run.id);
    expect(r.body).toMatchObject({ verdict: 'premium', packageIds: ['02'] });
    const mark = JSON.parse(readFileSync(path.join(tmp.contentDir, '02', 'postmaker.json'), 'utf8')) as PostmakerMark;
    expect(mark).toMatchObject({ templateId: t.id, variantId: a.id, template: { name: 'Story spine' } });
    const after = (await readTemplate(tmp.root, t.id))!;
    expect(after.variants.find((v) => v.id === a.id)).toMatchObject({ status: 'proven', provenRunId: run.id, premiumStreak: 1 });
    expect(after.variants.find((v) => v.id === a.id)!.gateHashes).toEqual(expect.objectContaining({ 'narration-text:en': expect.any(String), 'voice:en': expect.any(String) }));
    expect(after.variants.find((v) => v.id === b.id)).toMatchObject({ status: 'draft', premiumStreak: 0 });
    expect(after).toMatchObject({ status: 'proven', premiumStreak: 1, provenRunId: t.provenRunId, name: 'Story spine', snapshot: t.snapshot });
  });
});

describe('streak and skip-proof per template + variant', () => {
  it('three Premium live proofs unlock skip-proof for that variant only; a Standard accept turns it off and resets the streak; retire clears it', { timeout: 60_000 }, async () => {
    const t = await provenTemplate();
    const v = ((await act({ action: 'template.variant.save', templateId: t.id, variant: { label: 'Long', params: { lengthSec: 60 } } })).body as { variant: TemplateVariant }).variant;
    const skip = (variantId: string | null, on: boolean) => act({ action: 'template.skip-proof.set', templateId: t.id, variantId, on });
    expect(await refusal(skip(null, true))).toMatchObject({ status: 409, message: 'Skip proof unlocks after 3 Premium proofs in a row.' });
    for (let i = 0; i < 2; i++) await acceptClean((await makePost(t.id)).runId);
    expect((await readTemplate(tmp.root, t.id))!).toMatchObject({ premiumStreak: 3 });
    expect((await readTemplate(tmp.root, t.id))!.variants[0]).toMatchObject({ premiumStreak: 0 });
    expect((await skip(null, true)).body).toMatchObject({ template: { skipProofForRepeats: true, skipProofAllowed: true } });
    expect(await refusal(skip(v.id, true))).toMatchObject({ status: 409 }); // the variant has its own streak (0)
    // A variant's Standard accept leaves the default variant's streak and skip-proof alone.
    useVerdict('standard');
    await acceptClean((await makePost(t.id, { variantId: v.id })).runId);
    expect((await readTemplate(tmp.root, t.id))!).toMatchObject({ premiumStreak: 3, skipProofForRepeats: true });
    // A Standard accept of the default variant resets its streak and turns skip-proof off.
    await acceptClean((await makePost(t.id)).runId);
    const reset = (await readTemplate(tmp.root, t.id))!;
    expect(reset).toMatchObject({ premiumStreak: 0, skipProofForRepeats: false, status: 'proven' });
    // Retire turns skip-proof off everywhere (and Repeat).
    await updateTemplate(tmp.root, t.id, (x) => ({ ...x, premiumStreak: 3, skipProofForRepeats: true, variants: x.variants.map((y) => ({ ...y, premiumStreak: 3, skipProofForRepeats: true })), repeat: { enabled: true, perWeek: 3, days: [1], times: ['18:00'], makeAheadDays: 2, dailyUsd: 3, approve: 'ask' } }));
    const gone = ((await act({ action: 'template.retire', templateId: t.id })).body as { template: { status: string; skipProofForRepeats: boolean; variants: { skipProofForRepeats: boolean }[]; repeat: { enabled: boolean } } }).template;
    expect(gone).toMatchObject({ status: 'retired', skipProofForRepeats: false, variants: [{ skipProofForRepeats: false }], repeat: { enabled: false } });
    expect(await refusal(skip(null, true))).toMatchObject({ status: 409, message: 'This template is retired.' });
  });

  it('a mock proof, more than 2 regenerations or a manual score never adds to the streak', async () => {
    // Pure rule; the accept path above exercises it end to end.
    const { nextPremiumStreak } = await import('@/lib/studio/postmaker/template-rules');
    expect(nextPremiumStreak(2, { verdict: 'premium', live: true, regenerations: 2 })).toBe(3);
    expect(nextPremiumStreak(2, { verdict: 'premium', live: false, regenerations: 0 })).toBe(0);
    expect(nextPremiumStreak(2, { verdict: 'premium', live: true, regenerations: 3 })).toBe(0);
    expect(nextPremiumStreak(2, { verdict: 'premium', live: true, regenerations: 0, override: true })).toBe(0);
    expect(nextPremiumStreak(2, { verdict: 'standard', live: true, regenerations: 0 })).toBe(0);
  });
});

describe('gates inherited on a real fork', () => {
  it('true while narration text and voice are the template versions (locked); false once they are made again', { timeout: 30_000 }, async () => {
    const t = await provenTemplate({ lockedNodes: ['narration-text:en', 'voice:en'] });
    const { engine } = await engineFor(project());
    const kept = await makePost(t.id);
    const s1 = await engine.state(kept.recipeId);
    expect(gatesInherited(t, null, { current: s1.current, languages: ['en'] })).toBe(true);
    await updateTemplate(tmp.root, t.id, (x) => ({ ...x, inputs: { ...x.inputs, lockedNodes: [] } }));
    const remade = await makePost(t.id);
    const s2 = await engine.state(remade.recipeId);
    expect(s2.current['narration-text:en']!.source).toBe('run');
    expect(gatesInherited(t, null, { current: s2.current, languages: ['en'] })).toBe(false);
  });
});

describe('Repeat settings', () => {
  const ok = { perWeek: 3, days: [4, 0, 2], times: ['18:00', '09:30'], makeAheadDays: 3, dailyUsd: 3, approve: 'ask' as const };
  it('each range is checked with a plain reason; stored settings are off unless turned on, and on needs a Proven template', async () => {
    const t = await provenTemplate();
    const set = (repeat: Record<string, unknown>) => act({ action: 'template.repeat.set', templateId: t.id, repeat } as PostmakerAction);
    const table: [Record<string, unknown>, string][] = [
      [{ perWeek: 0 }, 'Posts a week must be 1 to 14.'],
      [{ perWeek: 15 }, 'Posts a week must be 1 to 14.'],
      [{ days: [] }, 'Choose at least one day of the week.'],
      [{ days: [1, 1] }, 'Each day can be chosen once.'],
      [{ times: [] }, 'Choose 1 to 4 times, as 24-hour HH:MM.'],
      [{ times: ['24:00'] }, 'Choose 1 to 4 times, as 24-hour HH:MM.'],
      [{ times: ['7:00'] }, 'Choose 1 to 4 times, as 24-hour HH:MM.'],
      [{ times: ['08:00', '09:00', '10:00', '11:00', '12:00'] }, 'Choose 1 to 4 times, as 24-hour HH:MM.'],
      [{ times: ['08:00', '08:00'] }, 'Each time can be chosen once.'],
      [{ makeAheadDays: 0 }, 'Make ahead must be 1 to 7 days.'],
      [{ makeAheadDays: 8 }, 'Make ahead must be 1 to 7 days.'],
      [{ dailyUsd: 0.49 }, 'The daily budget must be $0.50 to $20.'],
      [{ dailyUsd: 20.01 }, 'The daily budget must be $0.50 to $20.'],
      [{ dailyUsd: 2.555 }, 'The daily budget is in whole cents.'],
    ];
    for (const [patch, message] of table) expect(await refusal(set({ ...ok, ...patch })), JSON.stringify(patch)).toMatchObject({ status: 400, message });
    for (const patch of [{ perWeek: 1 }, { perWeek: 14 }, { makeAheadDays: 1 }, { makeAheadDays: 7 }, { dailyUsd: 0.5 }, { dailyUsd: 20 }, { dailyUsd: 0.57 }, { dailyUsd: 1.1 }, { dailyUsd: 19.99 }, { times: ['00:00', '23:59'] }]) expect((await set({ ...ok, ...patch })).status).toBe(200);
    const stored = ((await set(ok)).body as { template: { repeat: unknown } }).template.repeat;
    expect(stored).toEqual({ enabled: false, perWeek: 3, days: [0, 2, 4], times: ['09:30', '18:00'], makeAheadDays: 3, dailyUsd: 3, approve: 'ask' });
    expect((await readTemplate(tmp.root, t.id))!.repeat!.enabled).toBe(false);
    expect(((await set({ ...ok, enabled: true })).body as { template: { repeat: { enabled: boolean } } }).template.repeat.enabled).toBe(true);
    await updateTemplate(tmp.root, t.id, (x) => ({ ...x, status: 'draft' }));
    expect(await refusal(set({ ...ok, enabled: true }))).toMatchObject({ status: 409, message: 'Prove this template before it repeats.' });
  });
});

const CAMPAIGN = 'c-20261107-ab12';
function writeCampaign(slots: Record<string, unknown>[] = []) {
  const dir = path.join(path.dirname(tmp.contentDir), 'campaigns', CAMPAIGN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ id: CAMPAIGN, name: 'Winter test', goal: 'awareness', brief: '', formats: ['reel'], startDate: '2026-11-01', endDate: null, perWeek: 3, priority: 1, status: 'active', createdAt: '2026-11-01T00:00:00Z', createdBy: 'owner', strategy: null, proposal: null }));
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ madeAt: null, meta: null, slots }));
  return dir;
}
const slot = (id: string, o: Record<string, unknown> = {}) => ({ id, date: '2026-11-20', time: '18:00', at: '2026-11-20T17:00:00.000Z', format: 'reel', pillar: 'Evenings', hook: 'Wait for it', angle: 'A quiet evening at home', captionLead: 'Here is the evening.', prompt: '', headline: '', articleUrl: null, packageId: null, status: 'planned', ...o });

describe('campaigns', () => {
  it('attach and detach round-trip; an unknown campaign is 404; make-it refuses an unknown campaign', async () => {
    writeCampaign();
    const t = await provenTemplate();
    const attach = () => act({ action: 'template.campaign.attach', templateId: t.id, campaignId: CAMPAIGN });
    expect(((await attach()).body as { template: Template }).template.campaignIds).toEqual([CAMPAIGN]);
    expect(((await attach()).body as { template: Template }).template.campaignIds).toEqual([CAMPAIGN]);
    expect((await readTemplate(tmp.root, t.id))!.campaignIds).toEqual([CAMPAIGN]);
    expect(((await act({ action: 'template.campaign.detach', templateId: t.id, campaignId: CAMPAIGN })).body as { template: Template }).template.campaignIds).toEqual([]);
    expect((await refusal(act({ action: 'template.campaign.attach', templateId: t.id, campaignId: 'c-20261107-zz99' }))).status).toBe(404);
    expect((await refusal(act({ action: 'make-it', referenceId: 'ref-20261107-0a0a', options: { languages: ['en'], lengthSec: 30, shape: '9:16', campaignId: 'c-20261107-zz99' } }))).status).toBe(404);
  });

  it('a post made for a slot prefills the brief, writes campaign.json with that slot id and marks the slot made', { timeout: 30_000 }, async () => {
    const dir = writeCampaign([slot('s-01'), slot('s-02', { status: 'made', packageId: '07' }), slot('s-03', { templateId: 'tpl-20261107-ffff' })]);
    const t = await provenTemplate();
    expect(await refusal(act({ action: 'template.make-post', templateId: t.id, campaignSlot: { campaignId: CAMPAIGN, slotId: 's-02' } }))).toMatchObject({ status: 409, message: 'This slot already has a post.' });
    expect(await refusal(act({ action: 'template.make-post', templateId: t.id, campaignSlot: { campaignId: CAMPAIGN, slotId: 's-03' } }))).toMatchObject({ status: 409, message: 'This slot uses another template.' });
    expect(await refusal(act({ action: 'template.make-post', templateId: t.id, campaignSlot: { campaignId: CAMPAIGN, slotId: 's-09' } }))).toMatchObject({ status: 404 });
    const { run, recipeId } = await makePost(t.id, { brief: undefined, campaignSlot: { campaignId: CAMPAIGN, slotId: 's-01' } });
    expect(run.trigger).toBe('campaign-slot');
    const recipe = (await readRecipe(tmp.root, recipeId))!;
    expect(recipe).toMatchObject({ campaignId: CAMPAIGN, slot: { campaignId: CAMPAIGN, slotId: 's-01', at: '2026-11-20T17:00:00.000Z', name: 'Winter test' } });
    const { engine } = await engineFor(project());
    expect((await engine.state(recipeId)).pipeline.nodes.find((n) => n.id === 'script')!.params.brief).toEqual({ topic: 'A quiet evening at home', hook: 'Wait for it', notes: 'Here is the evening.' });
    const r = (await acceptClean(run.id)).body as { packageIds: string[] };
    expect(r.packageIds).toEqual(['02']);
    expect(JSON.parse(readFileSync(path.join(tmp.contentDir, '02', 'campaign.json'), 'utf8'))).toMatchObject({ campaign: CAMPAIGN, campaign_name: 'Winter test', slot: 's-01' });
    expect(JSON.parse(readFileSync(path.join(tmp.contentDir, '02', 'postmaker.json'), 'utf8'))).toMatchObject({ slotAt: '2026-11-20T17:00:00.000Z', templateId: t.id });
    const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8')) as { slots: { id: string; status: string; packageId: string | null }[] };
    expect(plan.slots.find((x) => x.id === 's-01')).toMatchObject({ status: 'made', packageId: '02' });
    // The slot cannot be made a second time.
    expect(await refusal(act({ action: 'template.make-post', templateId: t.id, campaignSlot: { campaignId: CAMPAIGN, slotId: 's-01' } }))).toMatchObject({ status: 409 });
  });
});

describe('template.duplicate', () => {
  it('makes a new Draft beside the original: streaks 0, skip-proof and Repeat off, unproven variants, same snapshot', async () => {
    const t = await provenTemplate();
    await act({ action: 'template.variant.save', templateId: t.id, variant: { label: 'Long', params: { lengthSec: 60 } } });
    await updateTemplate(tmp.root, t.id, (x) => ({ ...x, premiumStreak: 4, skipProofForRepeats: true, variants: x.variants.map((v) => ({ ...v, status: 'proven' as const, premiumStreak: 3, skipProofForRepeats: true })), repeat: { enabled: true, perWeek: 3, days: [1], times: ['18:00'], makeAheadDays: 2, dailyUsd: 3, approve: 'ask' } }));
    const d = ((await act({ action: 'template.duplicate', templateId: t.id })).body as { template: { id: string } }).template;
    const copy = (await readTemplate(tmp.root, d.id))!;
    expect(copy.id).not.toBe(t.id);
    expect(copy).toMatchObject({ name: 'Story spine copy', status: 'draft', provenRunId: null, premiumStreak: 0, skipProofForRepeats: false, revision: 1, recipeId: t.recipeId, snapshot: t.snapshot, repeat: { enabled: false } });
    expect(copy.variants).toEqual([expect.objectContaining({ status: 'draft', premiumStreak: 0, skipProofForRepeats: false, provenRunId: null })]);
    expect((await listTemplates(tmp.root)).length).toBe(2);
    expect((await readTemplate(tmp.root, t.id))!.status).toBe('proven');
    expect(await refusal(act({ action: 'template.duplicate', templateId: 'tpl-20261107-ffff' }))).toMatchObject({ status: 404 });
  });
});
