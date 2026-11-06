// Trusted auto-publishing: every condition must hold, approvals never feed trust, the owner can pull.
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvePackage, loadPackage, type Approval } from '@/lib/studio/content';
import { listEvents } from '@/lib/studio/memory/store';
import { runProject, type RunnerDeps } from '@/lib/studio/autopilot/runner';
import { pullPackage } from '@/lib/studio/autopilot/pull';
import { formatTrust, readTrust, recordDecision, setTrust } from '@/lib/studio/autopilot/trust';
import type { AutopilotMark, AutopilotRun } from '@/lib/studio/autopilot/types';
import { writeTestConfig } from './studio-helpers';
import { A, NOW, campaignWithSlots, fakeMaker, fakeReviewer, fakeSignalSchedule, markPackage, offFn, on, pkgFile, readPkgJson, root, setupAutopilotProject, teamOn, teardownAutopilotProject, writePackage, writeSettings } from './autopilot-helpers';

beforeEach(() => setupAutopilotProject({ trustedPublish: true, dispatch: true }));
afterEach(() => teardownAutopilotProject());

async function earnTrust(format: 'higgsfield-reel' | 'website-card' = 'website-card', n = 5) {
  for (let i = 0; i < n; i++) await recordDecision(format, 'approved', 'owner', NOW - 1000 + i);
}
function ready(extra: Partial<RunnerDeps> = {}): RunnerDeps & { signal: ReturnType<typeof fakeSignalSchedule>; maker: ReturnType<typeof fakeMaker> } {
  const signal = fakeSignalSchedule();
  const maker = fakeMaker();
  return { now: NOW, makeSlotPost: maker.make, reviewPackage: fakeReviewer({ costUsd: 0.05 }).review, teamAllowed: teamOn, schedulerAllowed: on, metaLive: on, scheduleInSignal: signal.schedule, schedulingAllowed: offFn, signal, maker, ...extra };
}
const approveSteps = (r: AutopilotRun) => r.steps.filter((s) => s.kind === 'auto-approve');
const stays = (r: AutopilotRun) => r.steps.filter((s) => s.kind === 'skip').map((s) => (s as { reason: string }).reason);

describe('auto-approve', () => {
  it('approves and schedules in Signal when every condition holds, and the approval never counts toward trust', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, review: true, autoPublish: 'trusted' });
    await earnTrust();
    const deps = ready();
    const run = await runProject('manual', deps);
    expect(run.steps.map((s) => s.kind)).toEqual(['make', 'review', 'auto-approve']);
    expect(approveSteps(run)[0]).toEqual({ kind: 'auto-approve', package: '10', format: 'website-card', scheduledFor: '2026-11-06T17:00:00.000Z', via: 'meta' });
    expect(deps.signal.calls).toEqual([{ id: '10', when: '2026-11-06T17:00:00.000Z', by: 'signal-autopilot' }]);
    const pkg = await loadPackage('10');
    expect(pkg.status).toBe('scheduled');
    expect(pkg.scheduled).toMatchObject({ provider: 'signal', scheduled_for: '2026-11-06T17:00:00.000Z' });
    expect(readPkgJson<Approval>('10', 'approval.json')).toMatchObject({ approved_by: 'signal-autopilot (trusted format)', approved_at: new Date(NOW).toISOString() });
    expect(readPkgJson<AutopilotMark>('10', 'autopilot.json')!.autoApproved).toEqual({ at: new Date(NOW).toISOString(), trustInARow: 5, scheduledFor: '2026-11-06T17:00:00.000Z', via: 'meta' });
    expect(await formatTrust('website-card')).toMatchObject({ approvedInARow: 5, approvedTotal: 5 }); // unchanged
    const types = (await listEvents({ types: ['post.approved', 'post.scheduled'] })).map((e) => [e.type, e.by]);
    expect(types).toEqual([['post.approved', 'signal-autopilot'], ['post.scheduled', 'signal-autopilot']]);
  });
  it('falls back to Upload-Post scheduling when Signal’s scheduler is not available', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, review: true, autoPublish: 'trusted' });
    await earnTrust();
    const calls: unknown[] = [];
    const dispatchPackage: RunnerDeps['dispatchPackage'] = async (id, by, d) => {
      calls.push({ id, by, d });
      writeFileSync(pkgFile(id, 'scheduled.json'), JSON.stringify({ job_id: 'job-1', scheduled_for: d.scheduleFor, provider: 'upload-post' }));
      writeFileSync(pkgFile(id, 'dispatch.json'), JSON.stringify({ request_id: 'r', idempotency_key: 'r', claimed_at: new Date(NOW).toISOString(), claimed_by: by, provider: 'upload-post', hashes: {} }));
      writeFileSync(pkgFile(id, 'outcome.json'), JSON.stringify({ state: 'scheduled', at: new Date(NOW).toISOString() }));
      return loadPackage(id);
    };
    const run = await runProject('manual', ready({ schedulerAllowed: offFn, schedulingAllowed: on, dispatchPackage }));
    expect(calls).toEqual([{ id: '10', by: 'signal-autopilot', d: { now: NOW, scheduleFor: '2026-11-06T17:00:00.000Z' } }]);
    expect(approveSteps(run)[0]).toMatchObject({ via: 'upload-post', scheduledFor: '2026-11-06T17:00:00.000Z' });
    expect((await loadPackage('10')).status).toBe('scheduled');
  });
  it('leaves the post approved but unscheduled when scheduling fails, and says so', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, review: true, autoPublish: 'trusted' });
    await earnTrust();
    const run = await runProject('manual', ready({ scheduleInSignal: fakeSignalSchedule({ fail: true }).schedule }));
    expect(approveSteps(run)[0]).toMatchObject({ scheduledFor: null, via: null, error: /approved but not scheduled: Instagram did not answer/ });
    expect((await loadPackage('10')).status).toBe('approved');
    expect(readPkgJson<AutopilotMark>('10', 'autopilot.json')!.autoApproved).toMatchObject({ scheduledFor: null, via: null });
  });

  const cases: [string, () => Promise<Partial<RunnerDeps> | void>, RegExp][] = [
    ['the trusted-publish switch is off', async () => void writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, autopilot: true, dispatch: true }), /trustedPublish/],
    ['the campaign says never', async () => void writeSettings(A, { enabled: true, review: true, autoPublish: 'never' }), /^$/],
    ['the format has not earned trust', async () => { await recordDecision('website-card', 'rejected', 'owner'); }, /not a trusted format \(0 owner approvals/],
    ['the owner revoked trust', async () => { await setTrust('website-card', false); }, /trust revoked/],
    ['the reviewer did not pass the post', async () => ({ reviewPackage: fakeReviewer({ verdict: () => 'revise' }).review }), /the reviewer said "revise"/],
    ['the reviewer failed', async () => ({ reviewPackage: fakeReviewer({ fail: true }).review }), /no reviewer verdict/],
    ['review is off for the campaign', async () => void writeSettings(A, { enabled: true, review: false, autoPublish: 'trusted' }), /needs the reviewer/],
    ['the team is switched off', async () => ({ teamAllowed: async () => ({ enabled: false, reason: 'no team' }) }), /no reviewer verdict/],
    ['the account settings have posting off', async () => void writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, autopilot: true, trustedPublish: true, dispatch: false }), /automatic posting is off/],
    ['the account posting period ended', async () => void writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, autopilot: true, trustedPublish: true, dispatch: true, expires: '2026-11-05T00:00:00+01:00' }), /has ended/],
    ['publishing is paused', async () => void (process.env.SIGNAL_PUBLISH_PAUSED = '1'), /Publishing is paused/],
    ['no scheduling path is approved', async () => ({ schedulerAllowed: offFn, schedulingAllowed: offFn }), /no scheduling path/],
    ['the slot is too close', async () => ({ now: Date.parse('2026-11-06T16:50:00Z') }), /past or too close/],
  ];
  for (const [name, prepare, reason] of cases)
    it(`stays in Review when ${name}`, async () => {
      campaignWithSlots(['2026-11-06']);
      writeSettings(A, { enabled: true, review: true, autoPublish: 'trusted' });
      await earnTrust();
      const extra = (await prepare()) ?? {};
      const deps = ready(extra);
      const run = await runProject('manual', deps);
      expect(approveSteps(run)).toHaveLength(0);
      expect(deps.signal.calls).toHaveLength(0);
      if (reason.source !== '^$') expect(stays(run).some((r) => reason.test(r))).toBe(true);
      else expect(stays(run)).toEqual([]);
      expect(run.steps.some((s) => s.kind === 'make' && s.package === '10')).toBe(true);
      expect((await loadPackage('10')).status).toBe('ready');
      expect(existsSync(pkgFile('10', 'approval.json'))).toBe(false);
      expect(readPkgJson<AutopilotMark>('10', 'autopilot.json')!.autoApproved).toBeNull();
    });

  it('respects the day capacity and the account limits before approving', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, review: true, autoPublish: 'trusted' });
    await earnTrust();
    // Another post already goes out on 11-06 (scheduled in Signal).
    writePackage('01', { caption: 'already there' });
    writeFileSync(pkgFile('01', 'approval.json'), JSON.stringify({ approved_by: 'owner', approved_at: '2026-11-04T10:00:00Z', hashes: JSON.parse(await import('node:fs').then((f) => f.promises.readFile(pkgFile('01', 'package.json'), 'utf8'))).files.reduce((o: Record<string, string>, f: { name: string; sha256: string }) => ({ ...o, [f.name]: f.sha256 }), {}) }));
    writeFileSync(pkgFile('01', 'scheduled.json'), JSON.stringify({ job_id: '', scheduled_for: '2026-11-06T10:00:00.000Z', provider: 'signal' }));
    expect((await loadPackage('01')).status).toBe('scheduled');
    const deps = ready();
    const run = await runProject('manual', deps);
    expect(approveSteps(run)).toHaveLength(0);
    expect(stays(run).some((r) => /already a post on 2026-11-06/.test(r))).toBe(true);
    expect((await loadPackage('10')).status).toBe('ready');
    // An unlabelled posted package blocks every approval (assertCanApprove through approvePackage).
    writeFileSync(pkgFile('01', 'posted.json'), JSON.stringify({ url: 'https://www.instagram.com/p/abcdef12/', posted_at: '2026-11-04T18:00:00Z', ai_label_confirmed: false, recorded_by: 'owner', via: 'meta' }));
    campaignWithSlots(['2026-11-07']);
    const run2 = await runProject('manual', ready({ makeSlotPost: fakeMaker({ from: 20 }).make }));
    expect(approveSteps(run2)[0]).toMatchObject({ package: '20', scheduledFor: null, error: /approval refused: Check that post 01 shows Instagram's AI label/ });
    expect((await loadPackage('20')).status).toBe('ready');
  });
});

describe('pull', () => {
  it('cancels the Signal schedule, discards the post and counts a rejection', async () => {
    campaignWithSlots(['2026-11-06']);
    writeSettings(A, { enabled: true, review: true, autoPublish: 'trusted' });
    await earnTrust();
    await runProject('manual', ready());
    expect((await loadPackage('10')).status).toBe('scheduled');
    const r = await pullPackage('10', 'owner', { now: NOW + 60_000 });
    expect(r.package.status).toBe('discarded');
    expect(r.trust).toMatchObject({ format: 'website-card', approvedInARow: 0, rejectedTotal: 1, trusted: false });
    expect(existsSync(pkgFile('10', 'scheduled.json'))).toBe(false);
    expect(readPkgJson<{ discarded_by: string }>('10', 'discarded.json')).toMatchObject({ discarded_by: 'owner' });
    expect((await readTrust()).formats[0]!.trusted).toBe(false);
    expect((await listEvents({ types: ['post.rejected', 'post.discarded'] }))[0]).toMatchObject({ type: 'post.rejected', by: 'owner', refs: { package: '10' } });
  });
  it('cancels an Upload-Post schedule through the injected cancel and pulls an approved-unscheduled post too', async () => {
    writePackage('05', { caption: 'auto', campaign: { id: A, slot: '2026-11-06-website-card' } });
    markPackage('05', { autoApproved: true });
    await approvePackage('05', 'signal-autopilot (trusted format)', NOW);
    const r = await pullPackage('05', 'owner', { now: NOW });
    expect(r.package.status).toBe('discarded');
    expect(r.trust).toMatchObject({ rejectedTotal: 1 });
    // Scheduled on Upload-Post: the provider cancel runs first (injected here; the real one calls Upload-Post).
    writePackage('08', { caption: 'auto 2', campaign: { id: A, slot: '2026-11-07-website-card' } });
    markPackage('08', { autoApproved: true, slot: '2026-11-07-website-card' });
    await approvePackage('08', 'signal-autopilot (trusted format)', NOW);
    writeFileSync(pkgFile('08', 'dispatch.json'), JSON.stringify({ request_id: 'r', idempotency_key: 'r', claimed_at: new Date(NOW).toISOString(), claimed_by: 'signal-autopilot', provider: 'upload-post', hashes: {} }));
    writeFileSync(pkgFile('08', 'scheduled.json'), JSON.stringify({ job_id: 'job-8', scheduled_for: '2026-11-07T17:00:00.000Z', provider: 'upload-post' }));
    writeFileSync(pkgFile('08', 'outcome.json'), JSON.stringify({ state: 'scheduled', at: new Date(NOW).toISOString() }));
    expect((await loadPackage('08')).status).toBe('scheduled');
    const cancelled: string[] = [];
    const cancelSchedule: NonNullable<Parameters<typeof pullPackage>[2]>['cancelSchedule'] = async (id) => {
      cancelled.push(id);
      for (const f of ['dispatch.json', 'scheduled.json', 'outcome.json']) renameSync(pkgFile(id, f), pkgFile(id, `${f}.released`));
      return loadPackage(id);
    };
    const r2 = await pullPackage('08', 'owner', { now: NOW, cancelSchedule, cancelSignalSchedule: async () => { throw new Error('wrong path'); } });
    expect(cancelled).toEqual(['08']);
    expect(r2.package.status).toBe('discarded');
    expect(r2.trust).toMatchObject({ rejectedTotal: 2, approvedInARow: 0 });
  });
  it('refuses packages autopilot did not approve, and posts that already went out', async () => {
    writePackage('06', { caption: 'by hand' });
    await expect(pullPackage('06', 'owner')).rejects.toMatchObject({ status: 409, message: /not approved by autopilot/ });
    writePackage('07', { caption: 'gone', postedAt: '2026-11-04T17:00:00Z' });
    markPackage('07', { autoApproved: true });
    await expect(pullPackage('07', 'owner')).rejects.toMatchObject({ status: 409, message: /is posted/ });
    await expect(pullPackage('zz', 'owner')).rejects.toMatchObject({ status: 404 });
    expect((await readTrust()).formats).toEqual([]);
  });
});
