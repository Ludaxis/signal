// The autopilot run: gates, horizon, budget, stop rules, once per day, the daily window and runAll.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPackage } from '@/lib/studio/content';
import { listEvents } from '@/lib/studio/memory/store';
import { inRunWindow, listAutopilotRuns, needsPlan, nextRunAt, runAll, runProject, shouldRunNow, spendOf, startRun, type RunnerDeps } from '@/lib/studio/autopilot/runner';
import { readSettings } from '@/lib/studio/autopilot/settings';
import type { AutopilotMark, AutopilotRun } from '@/lib/studio/autopilot/types';
import { writeTestConfig } from './studio-helpers';
import { A, B, NOW, TODAY, campaignWithSlots, fakeMaker, fakeReviewer, readPkgJson, readPlan, root, runsFile, setupAutopilotProject, teamOff, teamOn, teardownAutopilotProject, writePackage, writeSettings } from './autopilot-helpers';

beforeEach(() => setupAutopilotProject());
afterEach(() => teardownAutopilotProject());

const DATES = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-12'];
const kinds = (r: AutopilotRun) => r.steps.map((s) => s.kind);
const madeSlots = (r: AutopilotRun) => r.steps.filter((s) => s.kind === 'make' && s.package).map((s) => (s as { slot: string }).slot);
const lines = () => (existsSync(runsFile()) ? readFileSync(runsFile(), 'utf8').trim().split('\n') : []);

describe('gates and switches', () => {
  it('does nothing and writes nothing when the autopilot gate is off', async () => {
    writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true });
    campaignWithSlots(DATES);
    writeSettings(A, { enabled: true });
    const { make, calls } = fakeMaker();
    await expect(runProject('manual', { now: NOW, makeSlotPost: make })).rejects.toMatchObject({ status: 403 });
    await runAll({ now: NOW, makeSlotPost: make });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(root, 'memory'))).toBe(false);
    expect(readPlan(A).slots.every((s) => s.status === 'planned')).toBe(true);
  });
  it('refuses while SIGNAL_AUTOPILOT_PAUSED is set, for manual and daily runs alike', async () => {
    campaignWithSlots(DATES);
    writeSettings(A, { enabled: true });
    process.env.SIGNAL_AUTOPILOT_PAUSED = '1';
    const { make, calls } = fakeMaker();
    await expect(runProject('manual', { now: NOW, makeSlotPost: make })).rejects.toMatchObject({ status: 409, message: /paused/ });
    await runAll({ now: NOW, makeSlotPost: make });
    expect(calls).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });
  it('skips campaigns that are not active or have autopilot off', async () => {
    campaignWithSlots(DATES); // A: active but settings off (default)
    campaignWithSlots(['2026-11-06'], { id: B, name: 'Paused one', status: 'paused' });
    writeSettings(B, { enabled: true });
    const { make, calls } = fakeMaker();
    const run = await runProject('manual', { now: NOW, makeSlotPost: make });
    expect(calls).toHaveLength(0);
    expect(run).toMatchObject({ status: 'done', steps: [], note: /Nothing to do/ });
  });
});

describe('making', () => {
  it('makes planned slots inside the horizon only, oldest first, marks them and records post.made', async () => {
    campaignWithSlots(DATES);
    writeSettings(A, { enabled: true, makeAheadDays: 3, review: false });
    const { make, calls } = fakeMaker();
    const run = await runProject('manual', { now: NOW, makeSlotPost: make });
    expect(run).toMatchObject({ project: 'demo', day: TODAY, trigger: 'manual', status: 'done', costUsd: 0 });
    // 11-04 is past, 11-09 and 11-12 are beyond today+3; 11-05 (18:00) is still ahead.
    expect(madeSlots(run)).toEqual(['2026-11-05-website-card', '2026-11-06-website-card', '2026-11-07-website-card', '2026-11-08-website-card']);
    expect(calls.every((c) => c.by === 'signal-autopilot')).toBe(true);
    const plan = readPlan(A);
    expect(plan.slots.filter((s) => s.status === 'made').map((s) => s.date)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    const first = run.steps[0] as { package: string; format: string };
    expect(first.format).toBe('website-card');
    const mark = readPkgJson<AutopilotMark>(first.package, 'autopilot.json');
    expect(mark).toMatchObject({ run: run.id, campaign: A, slot: '2026-11-05-website-card', madeAt: new Date(NOW).toISOString(), autoApproved: null });
    expect((await loadPackage(first.package)).status).toBe('ready'); // stops in Review
    const ev = await listEvents({ types: ['post.made'] });
    expect(ev).toHaveLength(4);
    expect(ev[0]).toMatchObject({ by: 'signal-autopilot', campaign: A, refs: { package: first.package, slot: '2026-11-05-website-card', run: run.id }, data: { autopilot: true, format: 'website-card' } });
    // The run is on disk twice (start and end); the last line wins.
    expect(lines()).toHaveLength(2);
    expect(JSON.parse(lines()[0]!)).toMatchObject({ id: run.id, status: 'running', steps: [] });
    const listed = await listAutopilotRuns();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: run.id, status: 'done', endedAt: expect.any(String) });
    expect(listed[0]!.steps).toHaveLength(4);
  });
  it('honours the formats filter and makeAheadDays', async () => {
    setupAutopilotProject({ higgsfield: true }); // the paid image format needs its switch and keys
    campaignWithSlots(['2026-11-06', '2026-11-07'], { format: 'website-card' });
    const plan = readPlan(A);
    plan.slots[1] = { ...plan.slots[1]!, id: '2026-11-07-higgsfield-image', format: 'higgsfield-image' };
    writeFileSync(path.join(root, 'campaigns', A, 'plan.json'), JSON.stringify(plan));
    writeSettings(A, { enabled: true, makeAheadDays: 1, formats: ['higgsfield-image'], review: false });
    const { make } = fakeMaker();
    let run = await runProject('manual', { now: NOW, makeSlotPost: make });
    expect(madeSlots(run)).toEqual([]); // 11-07 is beyond today+1
    writeSettings(A, { enabled: true, makeAheadDays: 2, formats: ['higgsfield-image'], review: false });
    run = await runProject('manual', { now: NOW, makeSlotPost: make });
    expect(madeSlots(run)).toEqual(['2026-11-07-higgsfield-image']); // the website-card slot on 11-06 is not in the filter
  });
  it('an error in one slot does not stop the others', async () => {
    campaignWithSlots(DATES);
    writeSettings(A, { enabled: true, review: false });
    const { make } = fakeMaker({ fail: (s) => s === '2026-11-06-website-card' });
    const run = await runProject('manual', { now: NOW, makeSlotPost: make });
    expect(run.status).toBe('done');
    expect(madeSlots(run)).toEqual(['2026-11-05-website-card', '2026-11-07-website-card', '2026-11-08-website-card']);
    const failed = run.steps.find((s) => s.kind === 'make' && !s.package);
    expect(failed).toMatchObject({ slot: '2026-11-06-website-card', error: /Could not make/ });
    expect(readPlan(A).slots.find((s) => s.id === '2026-11-06-website-card')!.status).toBe('planned');
  });
  it('stops the whole run while any post has an unclear result', async () => {
    campaignWithSlots(DATES);
    writeSettings(A, { enabled: true, review: false });
    writePackage('01', { caption: 'sent earlier' });
    writeFileSync(path.join(root, 'posts', '01', 'dispatch.json'), JSON.stringify({ request_id: 'r', idempotency_key: 'r', claimed_at: '2026-11-04T10:00:00Z', claimed_by: 'owner', provider: 'upload-post', hashes: {} }));
    writeFileSync(path.join(root, 'posts', '01', 'outcome.json'), JSON.stringify({ state: 'uncertain', at: '2026-11-04T10:01:00Z' }));
    const { make, calls } = fakeMaker();
    const run = await runProject('manual', { now: NOW, makeSlotPost: make });
    expect(calls).toHaveLength(0);
    expect(run).toMatchObject({ status: 'stopped', note: /unclear result/ });
    expect(run.steps).toEqual([{ kind: 'skip', campaign: null, reason: expect.stringMatching(/Post 01 has an unclear result/) }]);
  });
});

describe('review and budget', () => {
  it('reviews every made post when review is on and the team is approved; counts the cost', async () => {
    campaignWithSlots(['2026-11-06', '2026-11-07']);
    writeSettings(A, { enabled: true, review: true });
    const { make } = fakeMaker();
    const { review, calls } = fakeReviewer({ costUsd: 0.07, verdict: (id) => (id === '10' ? 'ready' : 'revise') });
    const run = await runProject('manual', { now: NOW, makeSlotPost: make, reviewPackage: review, teamAllowed: teamOn });
    expect(calls).toEqual(['10', '11']);
    expect(kinds(run)).toEqual(['make', 'review', 'make', 'review']);
    expect(run.steps[1]).toMatchObject({ kind: 'review', package: '10', verdict: 'ready', costUsd: 0.07 });
    expect(run.steps[3]).toMatchObject({ kind: 'review', package: '11', verdict: 'revise' });
    expect(run.costUsd).toBe(0.14);
    expect((await loadPackage('10')).status).toBe('ready'); // a review never approves
    expect(readPkgJson<{ verdict: string }>('10', 'review.json')?.verdict).toBe('ready');
  });
  it('notes when the team is switched off and goes on making; a reviewer error is a step, not a stop', async () => {
    campaignWithSlots(['2026-11-06', '2026-11-07']);
    writeSettings(A, { enabled: true, review: true });
    const { make } = fakeMaker();
    let run = await runProject('manual', { now: NOW, makeSlotPost: make, teamAllowed: teamOff });
    expect(kinds(run)).toEqual(['make', 'skip', 'make', 'skip']);
    expect(run.steps[1]).toMatchObject({ kind: 'skip', campaign: A, reason: /not reviewed/ });
    campaignWithSlots(['2026-11-10', '2026-11-11'], { id: B, name: 'B' });
    writeSettings(B, { enabled: true, review: true, makeAheadDays: 7 });
    run = await runProject('manual', { now: NOW, makeSlotPost: fakeMaker({ from: 20 }).make, reviewPackage: fakeReviewer({ fail: true }).review, teamAllowed: teamOn });
    expect(run.steps.filter((s) => s.kind === 'review')).toHaveLength(2);
    expect(run.steps[1]).toMatchObject({ kind: 'review', verdict: null, error: /Reviewer unavailable/ });
    expect(run.status).toBe('done');
  });
  it('stops a campaign at its daily budget, counting earlier runs of the same day (manual runs share it)', async () => {
    campaignWithSlots(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    writeSettings(A, { enabled: true, review: true, dailyBudgetUsd: 1 });
    const { make } = fakeMaker();
    const { review } = fakeReviewer({ costUsd: 0.4 });
    let run = await runProject('manual', { now: NOW, makeSlotPost: make, reviewPackage: review, teamAllowed: teamOn });
    // Budget is checked before spending: make+review (0.40), make+review (0.80); the next post plus its review (cap 0.30) would pass 1.00 → stopped.
    expect(kinds(run)).toEqual(['make', 'review', 'make', 'review', 'skip']);
    expect(run.steps.at(-1)).toMatchObject({ kind: 'skip', campaign: A, reason: /Daily budget of \$1\.00 reached: \$0\.80 spent today/ });
    expect(run.costUsd).toBe(0.8);
    // A second run the same day starts over budget: nothing is made.
    run = await runProject('manual', { now: NOW + 60_000, makeSlotPost: make, reviewPackage: review, teamAllowed: teamOn });
    expect(kinds(run)).toEqual(['skip']);
    expect(readPlan(A).slots.filter((s) => s.status === 'planned')).toHaveLength(2);
    // Another campaign has its own budget.
    campaignWithSlots(['2026-11-06'], { id: B, name: 'B' });
    writeSettings(B, { enabled: true, review: true, dailyBudgetUsd: 1 });
    run = await runProject('manual', { now: NOW + 120_000, makeSlotPost: fakeMaker({ from: 30 }).make, reviewPackage: review, teamAllowed: teamOn });
    expect(kinds(run)).toEqual(['skip', 'make', 'review']);
    expect((run.steps[1] as { campaign: string }).campaign).toBe(B);
  });
  it('spendOf attributes review costs through the package → campaign map', () => {
    const runs = [{ id: 'ap_1', steps: [{ kind: 'plan', campaign: A, slots: 3, costUsd: 0.5 }, { kind: 'make', campaign: B, slot: 's', package: '10', format: 'website-card', costUsd: 0.2 }, { kind: 'review', package: '10', verdict: 'ready', costUsd: 0.1 }, { kind: 'review', package: '99', verdict: null, costUsd: 0.3 }] }] as unknown as AutopilotRun[];
    expect(spendOf(runs, null)).toBe(1.1);
    expect(spendOf(runs, A, new Map([['10', B]]))).toBe(0.5);
    expect(spendOf(runs, B, new Map([['10', B]]))).toBeCloseTo(0.3);
  });
});

describe('planning', () => {
  it('extends the plan only when autoPlan is on and the plan runs out inside the horizon', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, autoPlan: true, review: false, dailyBudgetUsd: 3 });
    const { make } = fakeMaker();
    const planCalls: string[] = [];
    const makePlan = async (id: string) => {
      planCalls.push(id);
      const plan = readPlan(id);
      const next = { ...plan, meta: { agent: 'content-planner', cli: 'test', seconds: 1, at: new Date(NOW).toISOString(), costUsd: 0.4 }, slots: [...plan.slots, { ...plan.slots[0]!, id: '2026-11-10-website-card', date: '2026-11-10', at: '2026-11-10T17:00:00.000Z', hook: 'later' }] };
      writeFileSync(path.join(root, 'campaigns', id, 'plan.json'), JSON.stringify(next));
      return next;
    };
    const run = await runProject('manual', { now: NOW, makeSlotPost: make, makePlan });
    expect(planCalls).toEqual([A]);
    expect(kinds(run)).toEqual(['plan', 'make']);
    expect(run.steps[0]).toMatchObject({ kind: 'plan', campaign: A, slots: 2, costUsd: 0.4 });
    expect(run.costUsd).toBe(0.4);
    expect((await listEvents({ types: ['plan.made'] }))[0]).toMatchObject({ by: 'agent:planner', campaign: A, refs: { run: run.id } });
    // Now the plan reaches 11-10, beyond today+3: no planning on the next run.
    const run2 = await runProject('manual', { now: NOW + 1000, makeSlotPost: make, makePlan });
    expect(planCalls).toEqual([A]);
    expect(kinds(run2)).toEqual([]);
  });
  it('needsPlan: not past the campaign end, and not while the plan reaches past the horizon', () => {
    const plan = (dates: string[]) => ({ madeAt: null, meta: null, slots: dates.map((d) => ({ date: d, status: 'planned' as const })) }) as never;
    expect(needsPlan({ endDate: null }, plan([]), TODAY, '2026-11-08')).toBe(true);
    expect(needsPlan({ endDate: null }, plan(['2026-11-08']), TODAY, '2026-11-08')).toBe(true);
    expect(needsPlan({ endDate: null }, plan(['2026-11-09']), TODAY, '2026-11-08')).toBe(false);
    expect(needsPlan({ endDate: '2026-11-08' }, plan([]), TODAY, '2026-11-08')).toBe(false);
    expect(needsPlan({ endDate: null }, plan(['2026-11-04']), TODAY, '2026-11-08')).toBe(true); // past slots do not count
  });
  it('a planning failure is noted and making goes on with the slots that exist', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, autoPlan: true, review: false });
    const run = await runProject('manual', { now: NOW, makeSlotPost: fakeMaker().make, makePlan: async () => { throw new Error('No free days in the next two weeks.'); } });
    expect(kinds(run)).toEqual(['skip', 'make']);
    expect(run.steps[0]).toMatchObject({ reason: /Planning failed: No free days/ });
    expect(run.costUsd).toBe(0);
  });
  it('counts what a failed plan cost (known cost, else the run cap on the API key) against the budget', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, autoPlan: true, review: false, dailyBudgetUsd: 3 });
    const billed = Object.assign(new Error('The plan broke Signal\'s content rules.'), { costUsd: 0.09 });
    const run = await runProject('manual', { now: NOW, makeSlotPost: fakeMaker().make, makePlan: async () => { throw billed; } });
    expect(kinds(run)).toEqual(['plan', 'skip', 'make']);
    expect(run.steps[0]).toMatchObject({ kind: 'plan', campaign: A, slots: 0, costUsd: 0.09 });
    expect(run.costUsd).toBe(0.09);

    campaignWithSlots(['2026-11-07']);
    const capped = Object.assign(new Error('Claude Code did not finish (timed out)'), { costUpperBoundUsd: 0.5 });
    const run2 = await runProject('manual', { now: NOW + 1000, makeSlotPost: fakeMaker().make, makePlan: async () => { throw capped; } });
    expect(run2.steps[0]).toMatchObject({ kind: 'plan', costUsd: 0.5 });
    expect(run2.costUsd).toBe(0.5);
  });
});

describe('once a day, locks and the window', () => {
  it('allows one daily run per Amsterdam day; manual runs are still allowed and share the day', async () => {
    campaignWithSlots(['2026-11-06', '2026-11-07']);
    writeSettings(A, { enabled: true, review: false });
    const { make } = fakeMaker();
    const d1 = await runProject('daily', { now: NOW, makeSlotPost: make });
    expect(d1.trigger).toBe('daily');
    await expect(runProject('daily', { now: NOW + 3_600_000, makeSlotPost: make })).rejects.toMatchObject({ status: 409, message: /already ran today/ });
    const m = await runProject('manual', { now: NOW + 3_600_000, makeSlotPost: make });
    expect(m.trigger).toBe('manual');
    const next = await runProject('daily', { now: NOW + 86_400_000, makeSlotPost: make });
    expect(next.day).toBe('2026-11-06');
    expect((await listAutopilotRuns()).map((r) => r.id)).toEqual([next.id, m.id, d1.id]); // newest first
  });
  it('refuses a second run while one is in progress; startRun answers with the id at once', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, review: false });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fakeMaker().make;
    const slow: NonNullable<RunnerDeps['makeSlotPost']> = async (campaign, slotId, by, now) => {
      await gate;
      return inner(campaign, slotId, by, now);
    };
    const { id, done } = await startRun('manual', { now: NOW, makeSlotPost: slow });
    expect(id).toMatch(/^ap_/);
    expect(JSON.parse(lines()[0]!)).toMatchObject({ id, status: 'running' });
    await expect(runProject('manual', { now: NOW })).rejects.toMatchObject({ status: 409, message: /in progress/ });
    release();
    const run = await done;
    expect(run).toMatchObject({ id, status: 'done' });
    expect(madeSlots(run)).toEqual(['2026-11-06-website-card']);
    // A refused start rejects instead of resolving an id.
    process.env.SIGNAL_AUTOPILOT_PAUSED = '1';
    await expect(startRun('manual', { now: NOW })).rejects.toMatchObject({ status: 409 });
  });
  it('shouldRunNow: inside 08:00–12:00 Amsterdam and not yet run today; missed days are not caught up', async () => {
    expect(inRunWindow(Date.parse('2026-11-05T07:59:00+01:00'))).toBe(false);
    expect(inRunWindow(Date.parse('2026-11-05T08:00:00+01:00'))).toBe(true);
    expect(inRunWindow(Date.parse('2026-11-05T11:59:00+01:00'))).toBe(true);
    expect(inRunWindow(Date.parse('2026-11-05T12:00:00+01:00'))).toBe(false);
    expect(await shouldRunNow(NOW)).toBe(true);
    expect(await shouldRunNow(Date.parse('2026-11-05T13:00:00+01:00'))).toBe(false);
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, review: false });
    await runProject('daily', { now: NOW, makeSlotPost: fakeMaker().make });
    expect(await shouldRunNow(NOW + 60_000)).toBe(false);
    expect(await shouldRunNow(NOW + 86_400_000)).toBe(true);
    // Yesterday never ran; nothing from yesterday is made up for.
    expect(await shouldRunNow(Date.parse('2026-11-04T09:00:00+01:00'))).toBe(true); // (a clock set back would run that day, not catch up today)
    const runs = await listAutopilotRuns();
    expect(nextRunAt(NOW + 60_000, runs)).toBe('2026-11-06T07:00:00.000Z'); // tomorrow 08:00 CET
    expect(nextRunAt(Date.parse('2026-11-06T06:00:00+01:00'), runs)).toBe('2026-11-06T07:00:00.000Z');
    expect(nextRunAt(Date.parse('2026-11-06T09:00:00+01:00'), runs)).toBe('2026-11-06T08:00:00.000Z'); // now: due on the next tick
    expect(nextRunAt(Date.parse('2026-11-06T15:00:00+01:00'), runs)).toBe('2026-11-07T07:00:00.000Z');
  });
  it('runAll runs the daily run for each project when due and a campaign is on, and skips overlapping calls', async () => {
    campaignWithSlots(['2026-11-06']);
    const { make, calls } = fakeMaker();
    await runAll({ now: NOW, makeSlotPost: make }); // no campaign on: no run, no file
    expect(lines()).toHaveLength(0);
    writeSettings(A, { enabled: true, review: false });
    await runAll({ now: Date.parse('2026-11-05T07:00:00+01:00'), makeSlotPost: make }); // outside the window
    expect(calls).toHaveLength(0);
    await Promise.all([runAll({ now: NOW, makeSlotPost: make }), runAll({ now: NOW, makeSlotPost: make })]);
    expect(calls).toHaveLength(1);
    const runs = await listAutopilotRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'daily', day: TODAY, status: 'done' });
    await runAll({ now: NOW + 60_000, makeSlotPost: make });
    expect(await listAutopilotRuns()).toHaveLength(1);
    expect((await readSettings(A)).enabled).toBe(true);
  });
});

describe('review findings (integration)', () => {
  it('never runs Codex formats automatically', async () => {
    campaignWithSlots(['2026-11-05', '2026-11-06'], { format: 'codex-post' });
    writeSettings(A, { enabled: true });
    const { make, calls } = fakeMaker();
    const run = await runProject('manual', { now: NOW, makeSlotPost: make });
    expect(calls).toHaveLength(0);
    expect(run.steps.every((s) => s.kind === 'skip' && /Codex/.test(s.reason))).toBe(true);
  });
  it('skips Higgsfield formats while Higgsfield is switched off, without spending', async () => {
    campaignWithSlots(['2026-11-05'], { format: 'higgsfield-reel' });
    writeSettings(A, { enabled: true });
    const { make, calls } = fakeMaker();
    const run = await runProject('manual', { now: NOW, makeSlotPost: make });
    expect(calls).toHaveLength(0);
    expect(run.steps[0]).toMatchObject({ kind: 'skip', reason: /higgsfield/i });
    expect(run.costUsd).toBe(0);
  });
  it('pauses making while too many autopilot posts wait in Review', async () => {
    const dates = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
    campaignWithSlots(dates);
    writeSettings(A, { enabled: true, makeAheadDays: 7 });
    for (let i = 0; i < 7; i++) {
      const id = String(50 + i);
      writePackage(id, { caption: 'x\n\nVisuals made with AI.', format: 'carousel' });
      writeFileSync(path.join(root, 'posts', id, 'autopilot.json'), JSON.stringify({ run: 'ap_x', campaign: A, slot: 's', madeAt: NOW, autoApproved: null }));
    }
    const { make, calls } = fakeMaker();
    const run = await runProject('manual', { now: NOW, makeSlotPost: make });
    expect(calls).toHaveLength(0);
    expect(run.steps[0]).toMatchObject({ kind: 'skip', reason: /waiting for you in Review/ });
  });
  it('shows a run cut off by a restart as failed', async () => {
    mkdirSync(path.dirname(runsFile()), { recursive: true });
    writeFileSync(runsFile(), JSON.stringify({ id: 'ap_dead', project: 'demo', day: TODAY, trigger: 'manual', startedAt: new Date(NOW).toISOString(), endedAt: null, status: 'running', steps: [], costUsd: 0, note: null }) + '\n');
    const [r] = await listAutopilotRuns();
    expect(r).toMatchObject({ id: 'ap_dead', status: 'failed', note: /stopped/ });
  });
});
