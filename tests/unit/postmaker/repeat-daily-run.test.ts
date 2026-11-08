// @vitest-environment node
// Repeat and skip proof through the daily run:
// A template with a Codex step is skipped with the attended wording and makes nothing; one fork per due slot,
// stopped at Proof, once in Needs you; the skip-proof rule (table and runs); the daily budget; the backlog;
// autopilot never approves a Post maker post and contentGenerators can leave Post maker out; no slot twice; nothing
// schedules or starts a timer, and the Repeat switch is off by default. Network guard on; stub connectors flagged live inside these tests only; the daily
// run is called directly (runProject), never through the scheduler.
import './guard';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvePackage, GENERATOR_NOT_ALLOWED, loadPackage, PM_OWNER_APPROVES } from '@/lib/studio/content';
import { runAll, runProject } from '@/lib/studio/autopilot/runner';
import { spendOfPipeline } from '@/lib/studio/autopilot/steps';
import type { AutopilotRun } from '@/lib/studio/autopilot/types';
import { trustedTemplateApproval } from '@/lib/studio/pipelines/runner';
import { pipelinesPayload } from '@/lib/studio/pipelines/payload';
import { acceptProof } from '@/lib/studio/postmaker/accept';
import { _resetSchedulerState } from '@/lib/studio/postmaker/graph/scheduler';
import { skipProofDecision, templateAttendance, WAIT_TEXT, type SkipProofFacts } from '@/lib/studio/postmaker/repeat';
import { claimRepeatSlot, REPEAT_ENV, REPEAT_OFF_TEXT, repeatAllowed, SLOT_TAKEN_TEXT, slotsMadeBy } from '@/lib/studio/postmaker/repeat-state';
import { _resetEngineState } from '@/lib/studio/postmaker/runner';
import { _setServiceDeps, engineFor, handleAction, home } from '@/lib/studio/postmaker/service';
import { listRecipeIds, readRecipeIndex } from '@/lib/studio/postmaker/store/recipes';
import { listRunIds, readRun } from '@/lib/studio/postmaker/store/runs';
import { readTemplate, updateTemplate } from '@/lib/studio/postmaker/store/templates';
import type { FakeConfig } from '@/lib/studio/postmaker/executors/fakes';
import type { PostmakerMark, Run, Template } from '@/lib/studio/postmaker/types';
import { runsNeedingYou } from '@/app/studio/postmaker/model';
import { TEST_PROJECT } from '../studio-helpers';
import { cleanRun, postsProject, withPostsProject, withVerdict, writePostsConfig } from './accept-fixtures';
import { tmp } from './guard';

withPostsProject();

/** Monday 2026-11-09 08:30 Berlin: the repeat slot is Tuesday 18:00 (one per week, one day ahead). */
const NOW = Date.parse('2026-11-09T08:30:00+01:00');
const SLOT_AT = '2026-11-10T17:00:00.000Z';
const ACTOR = 'owner@example.test';
/** Paid stub steps, so the sign-off gates and the budget are exercised (live stubs, never a vendor). */
const COSTS: FakeConfig = { costs: { voice: { usdHigh: 0.2, actual: 0.1 }, motion: { usdHigh: 0.1, actual: 0.05 } } };

const gate = (o: { generators?: string[]; trustedPublish?: boolean } = {}) => writePostsConfig({ autopilot: true, trustedPublish: o.trustedPublish ?? false, ...(o.generators ? { contentGenerators: o.generators } : {}) });

beforeEach(() => {
  _resetEngineState();
  _resetSchedulerState();
  gate();
  process.env.SIGNAL_FEATURE_POSTMAKER = '1';
  process.env[REPEAT_ENV] = '1';
  _setServiceDeps({ executors: withVerdict('premium', COSTS), allowed: () => true, buildOptions: () => ({}) });
});
afterEach(() => {
  _setServiceDeps({});
  delete process.env.SIGNAL_FEATURE_POSTMAKER;
  delete process.env[REPEAT_ENV];
});

type Repeat = NonNullable<Template['repeat']>;
const REPEAT: Repeat = { enabled: true, perWeek: 1, days: [1], times: ['18:00'], makeAheadDays: 1, dailyUsd: 5, approve: 'ask' };

/**
 * A proven template from a clean stub-live proof (Persian lane signed by a named person), then set up to repeat
 * through a topic list. `lockedNodes` default: art (its chain names Codex) and the Persian narration text.
 */
async function repeatTemplate(o: { langs?: ('fa' | 'en')[]; lockedNodes?: string[]; streak?: number; skipProof?: boolean; repeat?: Partial<Repeat> } = {}): Promise<Template> {
  const langs = o.langs ?? ['fa'];
  const s = await cleanRun({ langs }); // the proof: the person signs the text, then the voice
  const r = await acceptProof({ engine: s.engine, root: tmp.root, project: postsProject(), runId: s.run.id, asDraft: false, templateName: 'Story spine', by: ACTOR });
  expect(r.template).toMatchObject({ status: 'proven', premiumStreak: 1 });
  return updateTemplate(tmp.root, r.template.id, (t) => ({
    ...t,
    inputs: { kind: 'topic-list', list: ['A rainy evening', 'The last level', 'Morning puzzle'], lockedNodes: o.lockedNodes ?? ['art', ...langs.map((l) => `narration-text:${l}`)] },
    repeat: { ...REPEAT, ...o.repeat },
    premiumStreak: o.streak ?? t.premiumStreak,
    skipProofForRepeats: o.skipProof ?? false,
  }));
}

const daily = (now = NOW, deps: Parameters<typeof runProject>[1] = {}) => runProject('manual', { now, ...deps });
const makes = (r: AutopilotRun) => r.steps.filter((s): s is Extract<AutopilotRun['steps'][number], { kind: 'make' }> => s.kind === 'make');
const skips = (r: AutopilotRun) => r.steps.filter((s) => s.kind === 'skip').map((s) => (s as { reason: string }).reason);
const packages = () => (existsSync(tmp.contentDir) ? readdirSync(tmp.contentDir).filter((n) => /^\d+$/.test(n)).sort() : []);
async function forks(): Promise<string[]> {
  const out: string[] = [];
  for (const id of await listRecipeIds(tmp.root)) if ((await readRecipeIndex(tmp.root, id))?.forkOf) out.push(id);
  return out;
}
async function repeatRuns(): Promise<Run[]> {
  const out: Run[] = [];
  for (const id of await listRunIds(tmp.root)) {
    const r = await readRun(tmp.root, id);
    if (r?.trigger === 'repeat') out.push(r);
  }
  return out;
}

describe('a template with a Codex step', () => {
  it('is skipped by the daily run with the attended wording and makes no fork and no package', async () => {
    const t = await repeatTemplate({ lockedNodes: [] }); // art runs again: its chain names Codex
    expect(await templateAttendance(tmp.root, t)).toMatchObject({ attendedOnly: true, service: 'Codex' });
    const before = packages();
    const run = await daily();
    // (note), wording: a repeat template has no Run now of its own; Codex only runs while you watch.
    expect(skips(run)).toContain('Story spine: Images come from Codex, which only runs while you watch.');
    expect(skips(run).join('\n')).not.toMatch(/Run now/);
    expect(makes(run)).toEqual([]);
    expect(await forks()).toEqual([]);
    expect(packages()).toEqual(before);
    // With art locked (a fork never runs it) the same template may repeat.
    expect((await templateAttendance(tmp.root, await updateTemplate(tmp.root, t.id, (x) => ({ ...x, inputs: { ...x.inputs, lockedNodes: ['art'] } })))).attendedOnly).toBe(false);
  });
});

describe('one fork per due slot, at Proof, once in Needs you, never twice', () => {
  it('makes one fork for the one due slot, stops at Proof (skip proof off by default) and lists it once in Needs you', { timeout: 30_000 }, async () => {
    const t = await repeatTemplate();
    const before = packages();
    const run = await daily();
    const m = makes(run);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ pipeline: t.id, slot: '2026-11-10-18:00', package: null, waiting: WAIT_TEXT.off });
    expect(packages()).toEqual(before);
    const [fork] = await forks();
    expect(m[0]!.recipe).toBe(fork);
    const [r] = await repeatRuns();
    expect(r).toMatchObject({ recipeId: fork, templateId: t.id, status: 'needs-you', pausedFor: 'check', attended: false, by: 'signal-autopilot' });
    const needs = runsNeedingYou((await home(postsProject())).runs);
    expect(needs.map((x) => x.recipeId)).toEqual([fork]);
    expect((await slotsMadeBy(tmp.root, [t.id])).get(SLOT_AT)).toMatchObject({ recipeId: fork, runId: r!.id, packageIds: [] });
    // Calendar / Pipelines payload: the slot is listed and counts as started (waiting at Proof).
    const payload = await pipelinesPayload(NOW);
    expect(payload.repeats).toEqual([expect.objectContaining({ templateId: t.id, enabled: true, waiting: [SLOT_AT], nextAt: null })]);
    expect(payload.repeats[0]!.next.map((s) => s.at)).toEqual([SLOT_AT]);

    //the same day again makes nothing new (no fork, no package); Needs you still shows it once.
    const again = await daily(NOW + 60_000);
    expect(makes(again)).toEqual([]);
    expect(await forks()).toEqual([fork]);
    expect(runsNeedingYou((await home(postsProject())).runs)).toHaveLength(1);
  });
});

describe('skip proof', () => {
  const base: SkipProofFacts = { skipProof: true, streak: 3, retired: false, allLive: true, gatesInherited: true, verdict: 'premium' };
  it.each<[string, Partial<SkipProofFacts>, string | null]>([
    ['all four conditions hold', {}, null],
    ['streak 2', { streak: 2 }, WAIT_TEXT.streak],
    ['skip proof off', { skipProof: false }, WAIT_TEXT.off],
    ['a mock step', { allLive: false }, WAIT_TEXT.mock],
    ['voice or narration changed', { gatesInherited: false }, WAIT_TEXT.gates],
    ['a Standard check', { verdict: 'standard' }, WAIT_TEXT.verdict],
    ['retired', { retired: true }, WAIT_TEXT.retired],
  ])('table: %s', (_name, patch, wait) => {
    const d = skipProofDecision({ ...base, ...patch });
    expect(d).toEqual(wait === null ? { accept: true } : { accept: false, reason: wait });
  });

  it('streak 2 waits at Proof; an accept that tries to inherit is refused', { timeout: 30_000 }, async () => {
    await repeatTemplate({ streak: 2, skipProof: true });
    const run = await daily();
    expect(makes(run)[0]).toMatchObject({ package: null, waiting: WAIT_TEXT.streak });
    const [r] = await repeatRuns();
    const { engine } = await engineFor(postsProject(), { attended: false });
    await expect(acceptProof({ engine, root: tmp.root, project: postsProject(), runId: r!.id, asDraft: false, templateName: 'x', by: 'signal-autopilot', inheritGates: true })).rejects.toMatchObject({ status: 409 });
    expect(packages()).toEqual(['01']);
  });

  it('streak 3, skip proof on, all live and the signed narration and voice unchanged: a ready package with the inherited sign-offs; never twice', { timeout: 30_000 }, async () => {
    const t = await repeatTemplate({ streak: 3, skipProof: true });
    const run = await daily();
    const m = makes(run)[0]!;
    expect(m).toMatchObject({ pipeline: t.id, package: '02' });
    expect(m.waiting).toBeUndefined();
    const pkg = await loadPackage('02');
    expect(pkg.status).toBe('ready');
    expect(pkg.pipeline).toMatchObject({ id: t.id, slotAt: SLOT_AT });
    expect(pkg.autopilot).toMatchObject({ run: run.id, pipeline: t.id, autoApproved: null });
    const mark = JSON.parse(readFileSync(path.join(tmp.contentDir, '02', 'postmaker.json'), 'utf8')) as PostmakerMark;
    expect(mark).toMatchObject({ templateId: t.id, acceptedBy: 'signal-autopilot', modes: { mock: 0 } });
    // The gates came from the template's named sign-offs, recorded as the template version's own records.
    expect(mark.inherited?.map((x) => x.nodeId).sort()).toEqual(['narration-text:fa', 'voice:fa']);
    expect(mark.inherited!.every((x) => x.fromRecipeId === t.recipeId && x.fromHash === t.snapshot.heads[x.nodeId]!.hash)).toBe(true);
    expect(mark.signoffs.map((x) => [x.nodeId, x.hash, x.name])).toEqual(expect.arrayContaining([['narration-text:fa', t.snapshot.heads['narration-text:fa']!.hash, 'Editor A']]));
    // An automatic accept is not a proof: the streak and skip proof stay as they were.
    expect(await readTemplate(tmp.root, t.id)).toMatchObject({ premiumStreak: 3, skipProofForRepeats: true });
    // No sign-off was written for the fork's own versions.
    const fork = (await forks())[0]!;
    expect(existsSync(path.join(tmp.root, 'recipes', fork, 'signoffs.jsonl'))).toBe(false);
    //the same day again makes no second package for the slot.
    const again = await daily(NOW + 60_000);
    expect(makes(again)).toEqual([]);
    expect(packages()).toEqual(['01', '02']);
  });

  it('a variant whose voice changed waits again (its new voice has no named sign-off)', { timeout: 30_000 }, async () => {
    const t = await repeatTemplate({ repeat: { enabled: false } });
    // A proven variant whose proof kept the template's narration text and voice, unlocked for skip proof...
    const snap = (id: string) => t.snapshot.heads[id]!.hash;
    const v = { id: 'var-00aa', label: 'Calm voice', params: { voice: 'calm-narrator' }, status: 'proven' as const, provenRunId: t.provenRunId, premiumStreak: 3, skipProofForRepeats: true, gateHashes: { 'narration-text:fa': snap('narration-text:fa'), 'voice:fa': snap('voice:fa') } };
    await updateTemplate(tmp.root, t.id, (x) => ({ ...x, variants: [v] }));
    // ...made by a pipeline whose make step names the template and variant (PipelineMake.fromTemplate).
    mkdirSync(path.join(tmp.dir, 'pipelines'), { recursive: true });
    const pl = 'pl-20261101-aaaa';
    writeFileSync(
      path.join(tmp.dir, 'pipelines', `${pl}.json`),
      JSON.stringify({ id: pl, name: 'Calm repeat', enabled: true, archived: false, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', steps: { source: { kind: 'list', list: ['A rainy evening'], campaign: null }, make: { format: 'website-card', template: '', captionStyle: '', fromTemplate: { id: t.id, variant: v.id } }, review: { enabled: false }, approve: { mode: 'ask' }, schedule: { perWeek: 1, days: [1], times: ['18:00'], makeAheadDays: 1 }, budget: { dailyUsd: 5 } } }),
    );
    const run = await daily();
    const m = makes(run).find((s) => s.pipeline === pl)!;
    expect(m.package).toBeNull();
    expect(m.waiting).toMatch(/sign-off|changed since the template was signed/);
    expect(packages()).toEqual(['01']);
    const [r] = await repeatRuns();
    expect(r).toMatchObject({ variantId: v.id, status: 'needs-you' });
    expect((await slotsMadeBy(tmp.root, [pl])).get(SLOT_AT)).toMatchObject({ recipeId: r!.recipeId });
  });
});

describe('the daily budget', () => {
  it('a template estimate over what is left today skips with the existing wording and spends nothing', { timeout: 30_000 }, async () => {
    _setServiceDeps({ executors: withVerdict('premium', { costs: { voice: { usdHigh: 1, actual: 0.5 }, motion: { usdHigh: 0.1 } } }), allowed: () => true, buildOptions: () => ({}) });
    const t = await repeatTemplate({ repeat: { dailyUsd: 0.5 } });
    const run = await daily();
    expect(skips(run)).toContain('Daily budget of $0.50 reached: $0.00 spent today, and the next step could go over it.');
    expect(makes(run)).toEqual([]);
    expect(await forks()).toEqual([]);
    expect(spendOfPipeline([run], t.id)).toBe(0);
  });
  it('a post that fits spends at most the daily budget', { timeout: 30_000 }, async () => {
    const t = await repeatTemplate({ repeat: { dailyUsd: 0.5 } });
    const run = await daily();
    expect(makes(run)).toHaveLength(1);
    const [r] = await repeatRuns();
    expect(r!.capUsd).toBeLessThanOrEqual(0.5);
    expect(spendOfPipeline([run], t.id)).toBeLessThanOrEqual(0.5);
    expect(r!.spentUsd).toBeLessThanOrEqual(0.5);
  });
});

/** An autopilot post waiting in Review (valid package, autopilot mark, not approved). */
function waitingPost(id: string): void {
  const dir = path.join(tmp.contentDir, id);
  mkdirSync(dir, { recursive: true });
  const slide = Buffer.from(`slide-${id}`);
  const caption = `Post ${id}\n\nVisuals made with AI.`;
  const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
  writeFileSync(path.join(dir, 'slide-1.png'), slide);
  writeFileSync(path.join(dir, 'caption.txt'), caption);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ id, title: `Post ${id}`, format: 'image', destination: TEST_PROJECT.handle, files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(slide) }, { name: 'caption.txt', role: 'caption', sha256: sha(caption) }], source: { generator: 'signal-template-v1', format: 'website-card', category: 'x', items: [], distractors: [], levels: [], seed: id } }));
  writeFileSync(path.join(dir, 'autopilot.json'), JSON.stringify({ run: 'ap_earlier', campaign: null, slot: `s-${id}`, madeAt: '2026-11-08T08:00:00.000Z', autoApproved: null }));
}

describe('the backlog limit', () => {
  it('with 7 posts waiting in Review the run makes nothing', { timeout: 30_000 }, async () => {
    await repeatTemplate();
    for (let i = 10; i < 17; i++) waitingPost(String(i));
    const run = await daily();
    expect(skips(run)).toContain('7 autopilot posts are waiting for you in Review. Making pauses until you go through them.');
    expect(makes(run)).toEqual([]);
    expect(await forks()).toEqual([]);
  });
  it('repeat posts waiting at Proof count toward it', { timeout: 30_000 }, async () => {
    await repeatTemplate();
    for (let i = 10; i < 16; i++) waitingPost(String(i));
    await daily(); // the 7th: one repeat post waits at Proof
    const { waitingInReview } = await import('@/lib/studio/autopilot/steps');
    expect(await waitingInReview()).toBe(7);
  });
});

describe('trusted approval and the generator rule', () => {
  it('when contentGenerators leaves Post maker out, skip proof cannot make the post: it waits at Proof and the run says why', { timeout: 30_000 }, async () => {
    await repeatTemplate({ streak: 3, skipProof: true, repeat: { approve: 'trusted' } });
    gate({ generators: ['signal-template-v1', 'codex-cli-image'], trustedPublish: true });
    const run = await daily();
    expect(makes(run)[0]).toMatchObject({ package: null, waiting: GENERATOR_NOT_ALLOWED });
    expect(packages()).toEqual(['01']);
  });
  it('autopilot never approves a Post maker post (trusted mode included) and records why; you still can', { timeout: 30_000 }, async () => {
    await repeatTemplate({ streak: 3, skipProof: true });
    const made = await daily();
    expect(makes(made)[0]).toMatchObject({ package: '02' });
    gate({ trustedPublish: true });
    const approve = vi.fn();
    const run: AutopilotRun = { id: 'ap_test', project: TEST_PROJECT.id, day: '2026-11-09', trigger: 'manual', startedAt: new Date(NOW).toISOString(), endedAt: null, status: 'running', steps: [], costUsd: 0, note: null };
    await trustedTemplateApproval(run, { owner: 'tpl-x', slot: { id: '2026-11-10-18:00', at: SLOT_AT }, packageIds: ['02'], verdict: 'premium' }, { now: NOW, approvePackage: approve }, NOW);
    expect(approve).not.toHaveBeenCalled();
    expect(skips(run)).toEqual([`Post 02 stays in Review: ${PM_OWNER_APPROVES}`]);
    expect((await loadPackage('02')).approval).toBeFalsy();
    // With contentGenerators leaving Post maker out, even you cannot approve it.
    gate({ generators: ['signal-template-v1'] });
    await expect(approvePackage('02', ACTOR, NOW)).rejects.toMatchObject({ status: 409, message: GENERATOR_NOT_ALLOWED });
  });
});

describe('off by default; nothing schedules or starts a timer', () => {
  it('with the Repeat switch off the run makes nothing and says why once; the daily tick does not start a run for it', { timeout: 30_000 }, async () => {
    delete process.env[REPEAT_ENV];
    expect(await repeatAllowed()).toEqual({ enabled: false, reason: REPEAT_OFF_TEXT });
    await repeatTemplate();
    const run = await daily();
    expect(skips(run)).toEqual([`A template repeats, but nothing is made: ${REPEAT_OFF_TEXT}`]);
    expect(await forks()).toEqual([]);
    // The tick (called directly; nothing registers it) finds nothing on: no run at all.
    await runAll({ now: NOW + 3_600_000 });
    expect(await repeatRuns()).toEqual([]);
  });

  it('a full repeat run starts no interval, no scheduler and no scheduler timer', { timeout: 30_000 }, async () => {
    await repeatTemplate({ streak: 3, skipProof: true });
    const interval = vi.spyOn(globalThis, 'setInterval');
    const g = globalThis as typeof globalThis & { __signalAutopilotScheduler?: unknown; __signalScheduler?: unknown };
    try {
      const run = await daily();
      expect(makes(run)[0]).toMatchObject({ package: '02' });
      expect(interval).not.toHaveBeenCalled();
      expect(g.__signalAutopilotScheduler).toBeUndefined();
      expect(g.__signalScheduler).toBeUndefined();
    } finally {
      interval.mockRestore();
    }
  });

  it('the changed daily-run code paths contain no timer, interval or scheduler start', () => {
    const files = ['lib/studio/postmaker/repeat.ts', 'lib/studio/postmaker/repeat-state.ts', 'lib/studio/pipelines/runner.ts', 'lib/studio/pipelines/payload.ts', 'lib/studio/autopilot/steps.ts'];
    for (const f of files) {
      const src = readFileSync(path.join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/\bset(Timeout|Interval|Immediate)\s*\(|instrumentation|\brunAll\s*\(/);
    }
  });
});

/** A pipeline whose make step names a Post maker template (PipelineMake.fromTemplate), set up to make one slot. */
function templatePipeline(templateId: string, variant: string | null = null, pl = 'pl-20261101-aaaa'): string {
  mkdirSync(path.join(tmp.dir, 'pipelines'), { recursive: true });
  writeFileSync(
    path.join(tmp.dir, 'pipelines', `${pl}.json`),
    JSON.stringify({ id: pl, name: 'Calm repeat', enabled: true, archived: false, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', steps: { source: { kind: 'list', list: ['A rainy evening'], campaign: null }, make: { format: 'website-card', template: '', captionStyle: '', fromTemplate: { id: templateId, variant } }, review: { enabled: false }, approve: { mode: 'ask' }, schedule: { perWeek: 1, days: [1], times: ['18:00'], makeAheadDays: 1 }, budget: { dailyUsd: 5 } } }),
  );
  return pl;
}

describe('Run now on a pipeline that names a template is attended', () => {
  it('the daily run refuses a template whose art runs Codex; Run now on its pipeline makes it with the attended engine', { timeout: 30_000 }, async () => {
    const t = await repeatTemplate({ lockedNodes: ['narration-text:fa'], repeat: { enabled: false } }); // art runs again: Codex
    const pl = templatePipeline(t.id);
    const refused = await daily();
    expect(skips(refused)).toContain('Story spine uses Codex, which runs only when you press Run now.');
    expect(makes(refused)).toEqual([]);
    expect(await forks()).toEqual([]);

    const pressed = await runProject('manual', { now: NOW + 60_000 }, undefined, { pipeline: pl });
    expect(skips(pressed)).not.toContain('Story spine uses Codex, which runs only when you press Run now.');
    const m = makes(pressed);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ pipeline: pl, package: null });
    const [r] = await repeatRuns();
    expect(r).toMatchObject({ recipeId: m[0]!.recipe, templateId: t.id, attended: true, by: 'signal-autopilot' });
  });
});

describe('review fixes', () => {
  it('a pipeline that names a template makes nothing while the Repeat switch is off', { timeout: 30_000 }, async () => {
    const t = await repeatTemplate({ streak: 3, skipProof: true, repeat: { enabled: false } });
    const pl = templatePipeline(t.id);
    delete process.env[REPEAT_ENV];
    const run = await daily();
    expect(skips(run)).toContain(`Calm repeat makes posts from a template, but nothing is made: ${REPEAT_OFF_TEXT}`);
    expect(makes(run)).toEqual([]);
    expect(await forks()).toEqual([]);
    expect(packages()).toEqual(['01']);
    expect((await slotsMadeBy(tmp.root, [pl])).size).toBe(0);
  });

  it('a pipeline that names a template makes nothing while Post maker is off (even with Repeat on)', { timeout: 30_000 }, async () => {
    const t = await repeatTemplate({ streak: 3, skipProof: true, repeat: { enabled: false } });
    templatePipeline(t.id);
    process.env.SIGNAL_FEATURE_POSTMAKER = '0';
    const run = await daily();
    expect(skips(run)).toContain('Calm repeat makes posts from a template, but nothing is made: Post maker is off.');
    expect(makes(run)).toEqual([]);
    expect(await forks()).toEqual([]);
    expect(packages()).toEqual(['01']);
  });

  it('a run that fails releases its slot: the next daily run makes it again and the payload does not show it waiting', { timeout: 30_000 }, async () => {
    const t = await repeatTemplate();
    _setServiceDeps({ executors: withVerdict('premium', { ...COSTS, fail: { 'motion:fa': 'The motion service did not answer.' } }), allowed: () => true, buildOptions: () => ({}) });
    const run = await daily();
    const m = makes(run);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ package: null });
    expect(m[0]!.error).toBeTruthy();
    const [first] = await forks();
    expect((await slotsMadeBy(tmp.root, [t.id])).has(SLOT_AT)).toBe(false);
    const payload = await pipelinesPayload(NOW);
    expect(payload.repeats[0]).toMatchObject({ templateId: t.id, waiting: [], nextAt: SLOT_AT });
    // The next run (the motion service answers now) makes the slot with a new fork; the ledger keeps the failed fork's id.
    _setServiceDeps({ executors: withVerdict('premium', COSTS), allowed: () => true, buildOptions: () => ({}) });
    const again = await daily(NOW + 60_000);
    expect(makes(again)).toHaveLength(1);
    expect(makes(again)[0]).toMatchObject({ package: null, waiting: WAIT_TEXT.off });
    const all = await forks();
    expect(all).toHaveLength(2);
    const second = all.find((x) => x !== first)!;
    expect((await slotsMadeBy(tmp.root, [t.id])).get(SLOT_AT)).toMatchObject({ recipeId: second, earlier: [first] });
    // ...and a third run the same day makes nothing (the slot is held again).
    expect(makes(await daily(NOW + 120_000))).toEqual([]);
  });

  it('a refused slot claim never makes a fork', async () => {
    const t = await repeatTemplate({ repeat: { enabled: false } });
    const slot = { slotAt: SLOT_AT, slotId: '2026-11-10-18:00', runId: null, packageIds: [], autopilotRun: 'ap_a', at: new Date(NOW).toISOString() };
    await claimRepeatSlot(tmp.root, t.id, slot, async () => ({ recipeId: 'rcp-first', value: null }));
    const start = vi.fn(async () => ({ recipeId: 'rcp-second', value: null }));
    await expect(claimRepeatSlot(tmp.root, t.id, { ...slot, autopilotRun: 'ap_b' }, start)).rejects.toMatchObject({ status: 409, message: SLOT_TAKEN_TEXT });
    expect(start).not.toHaveBeenCalled();
    // A fork that fails claims nothing.
    const other = { ...slot, slotAt: '2026-11-17T17:00:00.000Z' };
    await expect(claimRepeatSlot(tmp.root, t.id, other, async () => Promise.reject(new Error('no fork')))).rejects.toThrow('no fork');
    expect((await slotsMadeBy(tmp.root, [t.id])).has(other.slotAt)).toBe(false);
  });

  it('a skip-proof accept is refused inside the lock when the check is not Premium', { timeout: 30_000 }, async () => {
    await repeatTemplate({ streak: 3, skipProof: true });
    _setServiceDeps({ executors: withVerdict('standard', COSTS), allowed: () => true, buildOptions: () => ({}) });
    const run = await daily();
    expect(makes(run)[0]).toMatchObject({ package: null, waiting: WAIT_TEXT.verdict });
    const [r] = await repeatRuns();
    const { engine } = await engineFor(postsProject(), { attended: false });
    await expect(acceptProof({ engine, root: tmp.root, project: postsProject(), runId: r!.id, asDraft: false, templateName: 'x', by: 'signal-autopilot', inheritGates: true })).rejects.toMatchObject({ status: 409, message: 'The check did not rate it Premium.' });
    expect(packages()).toEqual(['01']);
  });
});

describe('a planned campaign slot is reserved at fork time', () => {
  const CAMPAIGN = 'c-20261107-ab12';
  it('a second Make a post on the same slot is refused while the first is on its way; a draft accept frees it', { timeout: 30_000 }, async () => {
    const dir = path.join(path.dirname(tmp.contentDir), 'campaigns', CAMPAIGN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ id: CAMPAIGN, name: 'Winter test', goal: 'awareness', brief: '', formats: ['reel'], startDate: '2026-11-01', endDate: null, perWeek: 3, priority: 1, status: 'active', createdAt: '2026-11-01T00:00:00Z', createdBy: 'owner', strategy: null, proposal: null }));
    writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ madeAt: null, meta: null, slots: [{ id: 's-01', date: '2026-11-20', time: '18:00', at: '2026-11-20T17:00:00.000Z', format: 'reel', pillar: 'Evenings', hook: 'Wait for it', angle: 'A quiet evening', captionLead: 'Here is the evening.', prompt: '', headline: '', articleUrl: null, packageId: null, status: 'planned' }] }));
    const t = await repeatTemplate({ langs: ['en'], repeat: { enabled: false } });
    _setServiceDeps({ executors: withVerdict('premium'), buildOptions: () => ({}) }); // mock steps: reaches Proof, never a post
    const act = (a: Parameters<typeof handleAction>[2]) => handleAction(postsProject(), { email: ACTOR }, a);
    const make = () => act({ action: 'template.make-post', templateId: t.id, campaignSlot: { campaignId: CAMPAIGN, slotId: 's-01' } });
    const first = (await make()).body as { runId: string };
    for (let i = 0; i < 400; i++) {
      const r = await readRun(tmp.root, first.runId);
      if (r && r.status !== 'running' && r.status !== 'queued' && r.pausedFor === 'check') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    await expect(make()).rejects.toMatchObject({ status: 409, message: SLOT_TAKEN_TEXT });
    await act({ action: 'proof.accept', runId: first.runId, asDraft: true, templateName: 'Story spine' });
    expect((await make()).status).toBe(202);
  });
});
