// Pipelines inside the autopilot run: due slots only, budget, backlog, switches, pause, the Codex rule, trusted approval
// through the existing rules, per-pipeline Run now, and the daily tick.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPackage, type Approval } from '@/lib/studio/content';
import { listAutopilotRuns, runAll, runProject, spendOfPipeline, startRun, type RunnerDeps } from '@/lib/studio/autopilot/runner';
import { formatTrust, recordDecision } from '@/lib/studio/autopilot/trust';
import type { AutopilotMark, AutopilotRun } from '@/lib/studio/autopilot/types';
import { writeTestConfig } from './studio-helpers';
import { A, NOW, TODAY, campaignWithSlots, fakeMaker, fakeReviewer, fakeSignalSchedule, offFn, on, root, runsFile, setupAutopilotProject, teamOn, teardownAutopilotProject, writePackage, writeSettings } from './autopilot-helpers';
import { P1, P2, fakeGenerator, readPipelineState, readPkgJson, writePipeline } from './pipelines-helpers';

// Higgsfield on: the "list" and "ideas" sources need a brief format that can run unattended (Codex never can).
beforeEach(() => setupAutopilotProject({ higgsfield: true }));
afterEach(() => teardownAutopilotProject());

const config = (o: Parameters<typeof writeTestConfig>[1]) => writeTestConfig(path.join(root, 'signal.config.json'), o);
const kinds = (r: AutopilotRun) => r.steps.map((s) => s.kind);
const skips = (r: AutopilotRun) => r.steps.filter((s) => s.kind === 'skip').map((s) => (s as { reason: string }).reason);
const made = (r: AutopilotRun, p = P1) => r.steps.filter((s) => s.kind === 'make' && s.pipeline === p && s.package).map((s) => (s as { slot: string }).slot);
const lines = () => (existsSync(runsFile()) ? readFileSync(runsFile(), 'utf8').trim().split('\n') : []);
/** Mon/Wed/Fri 18:00, 5 days ahead from Thursday 2026-11-05: Fri 06 and Mon 09. */
const LIST = (n = 6) => ({ source: { kind: 'list' as const, list: Array.from({ length: n }, (_, i) => `Topic ${i + 1}`) }, make: { format: 'higgsfield-image' as const }, schedule: { makeAheadDays: 5 } });
const pages = async () => ['https://example.test/blog/a', 'https://example.test/blog/b', 'https://example.test/blog/c', 'https://example.test/blog/d'];

describe('due slots', () => {
  it('makes only upcoming slots inside make-ahead that have no post yet, in time order, and skips days taken elsewhere', async () => {
    writePipeline(P1, { steps: { ...LIST(), review: { enabled: false } } });
    // Friday already has a hand-planned post from elsewhere
    writePackage('03', { caption: 'mine' });
    writeFileSync(path.join(root, 'posts', '03', 'plan.json'), JSON.stringify({ planned_for: '2026-11-06T10:00:00.000Z', planned_by: 'owner', planned_at: '2026-11-04T10:00:00.000Z' }));
    const gen = fakeGenerator();
    const run = await runProject('manual', { now: NOW, generatePackage: gen.generate });
    expect(kinds(run)).toEqual(['skip', 'make']);
    expect(skips(run)).toEqual(['2026-11-06 already has a post from elsewhere; this slot is left out.']);
    expect(made(run)).toEqual(['2026-11-09-18:00']);
    expect(gen.calls).toHaveLength(1);
    // a second run the same day: the Monday slot is filled, Friday still taken → nothing is made
    const run2 = await runProject('manual', { now: NOW + 1000, generatePackage: gen.generate });
    expect(kinds(run2)).toEqual(['skip']);
    expect(gen.calls).toHaveLength(1);
    // a discarded post of this pipeline still counts as "has a post" (no automatic retry of what you said no to)
    writeFileSync(path.join(root, 'posts', '10', 'discarded.json'), JSON.stringify({ discarded_by: 'owner', discarded_at: new Date(NOW).toISOString() }));
    const run3 = await runProject('manual', { now: NOW + 2000, generatePackage: gen.generate });
    expect(made(run3)).toEqual([]);
  });
  it('two pipelines share one run; each has its own slots, state and spend; off and archived ones are left alone', async () => {
    writePipeline(P1, { name: 'One', steps: { ...LIST(), review: { enabled: false } } });
    writePipeline(P2, { name: 'Two', steps: { ...LIST(), schedule: { days: [1, 3], makeAheadDays: 5 }, review: { enabled: false } } });
    writePipeline('pl-20261103-cccc', { enabled: false, steps: LIST() });
    writePipeline('pl-20261104-dddd', { archived: true, steps: LIST() });
    const gen = fakeGenerator();
    const run = await runProject('manual', { now: NOW, generatePackage: gen.generate });
    expect(made(run, P1)).toEqual(['2026-11-06-18:00', '2026-11-09-18:00']);
    expect(made(run, P2)).toEqual(['2026-11-05-18:00', '2026-11-10-18:00']); // Thursday's slot is still ahead at 08:30
    expect(run.steps.every((s) => 'pipeline' in s && [P1, P2].includes(s.pipeline!))).toBe(true);
    expect(readPipelineState(P1)?.listNext).toBe(2);
    expect(readPipelineState(P2)?.listNext).toBe(2);
    expect(readPipelineState('pl-20261103-cccc')).toBeNull();
    expect(readPipelineState('pl-20261104-dddd')).toBeNull();
    // Run now on the archived one does nothing either
    await expect(runProject('manual', { now: NOW + 1000, generatePackage: gen.generate }, undefined, { pipeline: 'pl-20261104-dddd' })).resolves.toMatchObject({ status: 'failed', note: 'Unknown pipeline.' });
    expect(gen.calls).toHaveLength(4);
  });
  it('a schedule time change never makes a second post for a day this pipeline already made one for', async () => {
    writePipeline(P1, { steps: { ...LIST(), schedule: { days: [0], makeAheadDays: 5 }, review: { enabled: false } } });
    const gen = fakeGenerator();
    let run = await runProject('manual', { now: NOW, generatePackage: gen.generate });
    expect(made(run)).toEqual(['2026-11-09-18:00']);
    // Monday 18:00 → 19:00: the post made for 18:00 covers Monday
    writePipeline(P1, { steps: { ...LIST(), schedule: { days: [0], times: ['19:00'], makeAheadDays: 5 }, review: { enabled: false } } });
    run = await runProject('manual', { now: NOW + 1000, generatePackage: gen.generate });
    expect(run.steps).toEqual([]);
    expect(gen.calls).toHaveLength(1);
    expect(readPipelineState(P1)?.lastResult).toBe('Up to date: every upcoming slot has a post.');
    // a discarded post still covers its day (no automatic retry of what you said no to)
    writeFileSync(path.join(root, 'posts', '10', 'discarded.json'), JSON.stringify({ discarded_by: 'owner', discarded_at: new Date(NOW).toISOString() }));
    run = await runProject('manual', { now: NOW + 2000, generatePackage: gen.generate });
    expect(gen.calls).toHaveLength(1);
    // two times on Monday with room for two posts a day: the moved post covers one slot, the other is made
    config({ memoryTeam: true, autopilot: true, higgsfield: true, maxPerDay: 2 });
    writePipeline(P1, { steps: { ...LIST(), schedule: { days: [0], times: ['12:00', '19:00'], makeAheadDays: 5 }, review: { enabled: false } } });
    run = await runProject('manual', { now: NOW + 3000, generatePackage: gen.generate });
    expect(made(run)).toEqual(['2026-11-09-19:00']);
    expect(gen.calls).toHaveLength(2);
  });
  it('never makes more posts for a day than the account’s per-day limit leaves room for', async () => {
    writePipeline(P1, { steps: { ...LIST(), schedule: { days: [0], times: ['12:00', '18:00'], makeAheadDays: 5 }, review: { enabled: false } } });
    const gen = fakeGenerator();
    let run = await runProject('manual', { now: NOW, generatePackage: gen.generate });
    expect(made(run)).toEqual(['2026-11-09-12:00']);
    expect(skips(run)).toEqual(['2026-11-09 would pass the limit of 1 post per day for @signal.demo; this slot is left out.']);
    // with room for two, the second slot is made on the next run
    config({ memoryTeam: true, autopilot: true, higgsfield: true, maxPerDay: 2 });
    run = await runProject('manual', { now: NOW + 1000, generatePackage: gen.generate });
    expect(made(run)).toEqual(['2026-11-09-18:00']);
    expect(gen.calls).toHaveLength(2);
    // no room at all while the account's posting period is not active
    config({ memoryTeam: true, autopilot: true, higgsfield: true, expires: '2026-11-04T00:00:00Z' });
    writePipeline(P2, { steps: { ...LIST(), schedule: { days: [4], makeAheadDays: 5 }, review: { enabled: false } } });
    run = await runProject('manual', { now: NOW + 2000, generatePackage: gen.generate });
    expect(skips(run)).toEqual([expect.stringMatching(/expired|ended/)]);
    expect(gen.calls).toHaveLength(2);
  });
  it('campaign autopilot and pipelines run in the same run, campaigns first, with separate budgets', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, review: false });
    writePipeline(P1, { steps: { ...LIST(), schedule: { days: [0], makeAheadDays: 5 }, review: { enabled: false } } });
    const gen = fakeGenerator({ from: 20 });
    const run = await runProject('manual', { now: NOW, makeSlotPost: fakeMaker().make, generatePackage: gen.generate });
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0]).toMatchObject({ kind: 'make', campaign: A, slot: '2026-11-06-website-card' });
    expect(run.steps[1]).toMatchObject({ kind: 'make', campaign: null, pipeline: P1, slot: '2026-11-09-18:00' });
    expect(run.steps[1]).not.toHaveProperty('error');
  });
});

describe('budget, backlog, switches, pause', () => {
  it('checks the daily budget before each step and stops at it; manual runs share the day; spend is per pipeline', async () => {
    writePipeline(P1, { steps: { ...LIST(), schedule: { days: [0, 1, 2, 3, 4, 5, 6], perWeek: 14, makeAheadDays: 5 }, review: { enabled: true }, budget: { dailyUsd: 1 } } });
    const gen = fakeGenerator();
    const { review } = fakeReviewer({ costUsd: 0.4 });
    let run = await runProject('manual', { now: NOW, generatePackage: gen.generate, reviewPackage: review, teamAllowed: teamOn });
    // image estimate 0.0032 + review 0.40 twice = 0.8064; the third image plus its review cap (0.30) would pass 1.00
    expect(kinds(run)).toEqual(['make', 'review', 'make', 'review', 'skip']);
    expect(skips(run)).toEqual([expect.stringMatching(/Daily budget of \$1\.00 reached: \$0\.81 spent today/)]);
    expect(run.costUsd).toBe(0.8064);
    expect(spendOfPipeline([run], P1)).toBe(0.8064);
    run = await runProject('manual', { now: NOW + 60_000, generatePackage: gen.generate, reviewPackage: review, teamAllowed: teamOn });
    expect(kinds(run)).toEqual(['skip']);
    expect(gen.calls).toHaveLength(2);
    // the review steps carry the pipeline id, so the Autopilot "spend per campaign" never sees them
    expect(run.steps[0]).toMatchObject({ pipeline: P1 });
  });
  it('pauses making while 7 autopilot posts wait in Review', async () => {
    writePipeline(P1, { steps: { ...LIST(), review: { enabled: false } } });
    for (let i = 0; i < 7; i++) {
      const id = String(50 + i);
      writePackage(id, { caption: 'x', format: 'carousel' });
      writeFileSync(path.join(root, 'posts', id, 'autopilot.json'), JSON.stringify({ run: 'ap_x', campaign: null, pipeline: P2, slot: 's', madeAt: NOW, autoApproved: null }));
    }
    const gen = fakeGenerator();
    const run = await runProject('manual', { now: NOW, generatePackage: gen.generate });
    expect(gen.calls).toHaveLength(0);
    expect(skips(run)).toEqual([expect.stringMatching(/7 autopilot posts are waiting for you in Review/)]);
    expect(run.note).toMatch(/Paused making/);
  });
  it('does nothing when the autopilot switch is off or autopilot is paused (daily and Run now alike)', async () => {
    writePipeline(P1, { steps: LIST() });
    const gen = fakeGenerator();
    config({ memoryTeam: true, higgsfield: true });
    await expect(runProject('manual', { now: NOW, generatePackage: gen.generate }, undefined, { pipeline: P1 })).rejects.toMatchObject({ status: 403 });
    await runAll({ now: NOW, generatePackage: gen.generate });
    config({ memoryTeam: true, autopilot: true, higgsfield: true });
    process.env.SIGNAL_AUTOPILOT_PAUSED = '1';
    await expect(runProject('manual', { now: NOW, generatePackage: gen.generate }, undefined, { pipeline: P1 })).rejects.toMatchObject({ status: 409, message: /paused/ });
    await runAll({ now: NOW, generatePackage: gen.generate });
    expect(gen.calls).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });
  it('Higgsfield formats wait for their switch without spending; the unclear-post stop applies to pipelines too', async () => {
    config({ memoryTeam: true, autopilot: true });
    writePipeline(P1, { steps: { ...LIST(), review: { enabled: false } } });
    const gen = fakeGenerator();
    let run = await runProject('manual', { now: NOW, generatePackage: gen.generate });
    expect(gen.calls).toHaveLength(0);
    expect(skips(run)).toEqual([expect.stringMatching(/higgsfield/)]);
    expect(run.costUsd).toBe(0);
    config({ memoryTeam: true, autopilot: true, higgsfield: true });
    writePackage('01', { caption: 'sent earlier' });
    writeFileSync(path.join(root, 'posts', '01', 'dispatch.json'), JSON.stringify({ request_id: 'r', idempotency_key: 'r', claimed_at: '2026-11-04T10:00:00Z', claimed_by: 'owner', provider: 'upload-post', hashes: {} }));
    writeFileSync(path.join(root, 'posts', '01', 'outcome.json'), JSON.stringify({ state: 'uncertain', at: '2026-11-04T10:01:00Z' }));
    run = await runProject('manual', { now: NOW, generatePackage: gen.generate }, undefined, { pipeline: P1 });
    expect(run).toMatchObject({ status: 'stopped', note: /unclear result/ });
    expect(gen.calls).toHaveLength(0);
  });
});

describe('Codex and Run now', () => {
  it('never makes Codex posts in the daily run or the project-wide Run now; only in the pipeline’s own Run now', async () => {
    writePipeline(P1, { steps: { ...LIST(), make: { format: 'codex-post', template: 'Draw {topic}' }, review: { enabled: false } } });
    const gen = fakeGenerator();
    let run = await runProject('daily', { now: NOW, generatePackage: gen.generate });
    expect(gen.calls).toHaveLength(0);
    expect(skips(run)).toEqual([expect.stringMatching(/Codex, which runs only when you press Run now on this pipeline/)]);
    expect(readPipelineState(P1)?.lastResult).toMatch(/Codex posts are made only when you press Run now/);
    run = await runProject('manual', { now: NOW + 1000, generatePackage: gen.generate });
    expect(gen.calls).toHaveLength(0);
    run = await runProject('manual', { now: NOW + 2000, generatePackage: gen.generate }, undefined, { pipeline: P1 });
    expect(run.pipeline).toBe(P1);
    expect(made(run)).toEqual(['2026-11-06-18:00', '2026-11-09-18:00']);
    expect(gen.calls[0]).toMatchObject({ format: 'codex-post', brief: { prompt: 'Draw Topic 1' } });
  });
  it('Run now on one pipeline runs that pipeline only (even when it is off), under the project lock, and answers with the run id', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, review: false });
    writePipeline(P1, { enabled: false, steps: { ...LIST(), review: { enabled: false } } });
    writePipeline(P2, { steps: { ...LIST(), schedule: { days: [1], makeAheadDays: 5 }, review: { enabled: false } } });
    const maker = fakeMaker();
    const gen = fakeGenerator({ from: 20 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow: NonNullable<RunnerDeps['generatePackage']> = async (o) => {
      await gate;
      return gen.generate(o);
    };
    const { id, done } = await startRun('manual', { now: NOW, makeSlotPost: maker.make, generatePackage: slow }, { pipeline: P1 });
    expect(id).toMatch(/^ap_/);
    expect(JSON.parse(lines()[0]!)).toMatchObject({ id, status: 'running', pipeline: P1, trigger: 'manual' });
    await expect(runProject('manual', { now: NOW })).rejects.toMatchObject({ status: 409, message: /in progress/ });
    release();
    const run = await done;
    expect(run.status).toBe('done');
    expect(maker.calls).toHaveLength(0); // campaigns untouched
    expect(made(run, P1)).toEqual(['2026-11-06-18:00', '2026-11-09-18:00']);
    expect(made(run, P2)).toEqual([]);
    expect(run.note).toBeNull();
    await expect(runProject('manual', { now: NOW }, undefined, { pipeline: 'pl-20261105-zzzz' })).resolves.toMatchObject({ status: 'failed', note: 'Unknown pipeline.' });
  });
});

describe('review and trusted approval', () => {
  beforeEach(() => config({ memoryTeam: true, autopilot: true, trustedPublish: true, dispatch: true, higgsfield: true }));
  const ready = (extra: Partial<RunnerDeps> = {}) => {
    const signal = fakeSignalSchedule();
    return { deps: { now: NOW, generatePackage: fakeGenerator().generate, reviewPackage: fakeReviewer({ costUsd: 0.05 }).review, teamAllowed: teamOn, schedulerAllowed: on, metaLive: on, scheduleInSignal: signal.schedule, schedulingAllowed: offFn, ...extra } as RunnerDeps, signal };
  };
  it('reviews each post, and with "trusted" approves and schedules only a trusted format through the existing rules', async () => {
    writePipeline(P1, { steps: { ...LIST(), schedule: { days: [0], makeAheadDays: 5 }, approve: { mode: 'trusted' } } });
    for (let i = 0; i < 5; i++) await recordDecision('higgsfield-image', 'approved', 'owner', NOW - 1000 + i);
    const { deps, signal } = ready();
    const run = await runProject('manual', deps);
    expect(kinds(run)).toEqual(['make', 'review', 'auto-approve']);
    expect(run.steps[1]).toMatchObject({ kind: 'review', package: '10', verdict: 'ready', costUsd: 0.05, pipeline: P1 });
    expect(run.steps[2]).toEqual({ kind: 'auto-approve', package: '10', format: 'higgsfield-image', scheduledFor: '2026-11-09T17:00:00.000Z', via: 'meta', pipeline: P1 });
    expect(signal.calls).toEqual([{ id: '10', when: '2026-11-09T17:00:00.000Z', by: 'signal-autopilot' }]);
    expect((await loadPackage('10')).status).toBe('scheduled');
    expect(readPkgJson<Approval>('10', 'approval.json')?.approved_by).toBe('signal-autopilot (trusted format)');
    expect(readPkgJson<AutopilotMark>('10', 'autopilot.json')!.autoApproved).toMatchObject({ trustInARow: 5, scheduledFor: '2026-11-09T17:00:00.000Z', via: 'meta' });
    expect(await formatTrust('higgsfield-image')).toMatchObject({ approvedInARow: 5 }); // Signal's approval never counts
  });
  it('stays in Review when the format is not trusted, review is off, the reviewer says no, or the switch is off', async () => {
    writePipeline(P1, { steps: { ...LIST(), schedule: { days: [0], makeAheadDays: 5 }, approve: { mode: 'trusted' } } });
    let run = await runProject('manual', ready().deps);
    expect(kinds(run)).toEqual(['make', 'review', 'skip']);
    expect(skips(run)).toEqual([expect.stringMatching(/stays in Review: higgsfield-image is not a trusted format \(0 owner approvals/)]);
    expect((await loadPackage('10')).status).toBe('ready');
    for (let i = 0; i < 5; i++) await recordDecision('higgsfield-image', 'approved', 'owner', NOW - 1000 + i);
    // P2: Wednesday 11-11, the reviewer says no
    writePipeline(P2, { steps: { ...LIST(), schedule: { days: [2], makeAheadDays: 7 }, approve: { mode: 'trusted' } } });
    run = await runProject('manual', ready({ now: NOW + 1, reviewPackage: fakeReviewer({ verdict: () => 'revise' }).review, generatePackage: fakeGenerator({ from: 20 }).generate }).deps);
    expect(skips(run)).toEqual([expect.stringMatching(/Post 20 stays in Review: the reviewer said "revise"/)]);
    expect((await loadPackage('20')).status).toBe('ready');
    // P3: Friday 11-06, review off → no automatic approval even for a trusted format
    writePipeline('pl-20261103-cccc', { steps: { ...LIST(), schedule: { days: [4], makeAheadDays: 5 }, approve: { mode: 'trusted' }, review: { enabled: false } } });
    run = await runProject('manual', ready({ now: NOW + 2, generatePackage: fakeGenerator({ from: 30 }).generate }).deps);
    expect(skips(run)).toEqual([expect.stringMatching(/Post 30 stays in Review: automatic approval needs the reviewer, and review is off for this pipeline/)]);
    // the trusted-publish switch off: checked first, nothing approved
    config({ memoryTeam: true, autopilot: true, dispatch: true, higgsfield: true });
    writePipeline('pl-20261104-dddd', { steps: { ...LIST(), schedule: { days: [1], makeAheadDays: 7 }, approve: { mode: 'trusted' } } });
    run = await runProject('manual', ready({ now: NOW + 3, generatePackage: fakeGenerator({ from: 40 }).generate }).deps);
    expect(skips(run)).toEqual([expect.stringMatching(/Post 40 stays in Review: Turn on "trustedPublish"/)]);
    expect(run.steps.filter((s) => s.kind === 'auto-approve')).toHaveLength(0);
  });
  it('notes a switched-off team instead of reviewing, and a reviewer failure is a step', async () => {
    writePipeline(P1, { steps: { ...LIST(), schedule: { days: [0], makeAheadDays: 5 } } });
    let run = await runProject('manual', { now: NOW, generatePackage: fakeGenerator().generate, teamAllowed: async () => ({ enabled: false, reason: 'no team' }) });
    expect(kinds(run)).toEqual(['make', 'skip']);
    expect(skips(run)).toEqual(['Post 10 was not reviewed: no team']);
    writePipeline(P2, { steps: { ...LIST(), schedule: { days: [2], makeAheadDays: 7 } } });
    run = await runProject('manual', { now: NOW, generatePackage: fakeGenerator({ from: 20 }).generate, teamAllowed: teamOn, reviewPackage: fakeReviewer({ fail: true }).review });
    expect(run.steps.find((s) => s.kind === 'review')).toMatchObject({ verdict: null, error: /Reviewer unavailable/, pipeline: P2 });
    expect(run.status).toBe('done');
  });
});

describe('the daily tick', () => {
  it('runAll runs the daily run when only a pipeline is on, once per day, inside the window', async () => {
    writePipeline(P1, { steps: { ...LIST(), review: { enabled: false } } });
    const gen = fakeGenerator();
    await runAll({ now: Date.parse('2026-11-05T07:00:00+01:00'), generatePackage: gen.generate }); // before the window
    expect(gen.calls).toHaveLength(0);
    await runAll({ now: NOW, generatePackage: gen.generate });
    expect(gen.calls).toHaveLength(2);
    const [run] = await listAutopilotRuns();
    expect(run).toMatchObject({ trigger: 'daily', day: TODAY, status: 'done' });
    expect(run!.pipeline).toBeUndefined();
    await runAll({ now: NOW + 60_000, generatePackage: gen.generate });
    expect(await listAutopilotRuns()).toHaveLength(1);
    // nothing on at all: no run, no file
    writePipeline(P1, { enabled: false, steps: LIST() });
    await runAll({ now: NOW + 86_400_000, generatePackage: gen.generate });
    expect(await listAutopilotRuns()).toHaveLength(1);
  });
  it('website default pipeline works end to end with a fake page list', async () => {
    writePipeline(P1, { steps: { schedule: { makeAheadDays: 5 }, review: { enabled: false } } });
    const gen = fakeGenerator();
    await runAll({ now: NOW, generatePackage: gen.generate, discoverArticles: pages });
    expect(gen.calls.map((c) => c.articleUrl)).toEqual(['https://example.test/blog/a', 'https://example.test/blog/b']);
  });
});
