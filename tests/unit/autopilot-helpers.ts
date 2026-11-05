// Fixtures for the autopilot tests: a temp project with campaigns and plans, fake makers and reviewers.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { writeTestConfig } from './studio-helpers';
import { root, setupMemoryProject, teardownMemoryProject, writeCampaign, writePackage, slot, strategy, A, B } from './memory-helpers';
import type { CampaignPlan, Slot } from '@/lib/studio/campaigns';
import type { RunnerDeps } from '@/lib/studio/autopilot/runner';
import type { AgentRunRecord } from '@/lib/studio/memory/types';
import type { StoredReview } from '@/lib/studio/team/schemas';
import type { AutopilotSettings } from '@/lib/studio/autopilot/types';

export { root, writeCampaign, writePackage, slot, strategy, A, B };
/** Wednesday 2026-11-05 08:30 Amsterdam (CET): inside the daily window. */
export const NOW = Date.parse('2026-11-05T08:30:00+01:00');
export const TODAY = '2026-11-05';

export type GateOpts = Parameters<typeof writeTestConfig>[1];
/** Memory + autopilot on. Pass { higgsfield: true } to switch the paid formats on (fake keys are set then). */
export function setupAutopilotProject(gate: GateOpts = {}): string {
  setupMemoryProject();
  writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true, autopilot: true, ...gate });
  if (gate.higgsfield) {
    process.env.HF_API_KEY_ID = 'hfid_test';
    process.env.HF_API_KEY_SECRET = 'hfsecret_test_0000';
  }
  return root;
}
export function teardownAutopilotProject(): void {
  delete process.env.SIGNAL_AUTOPILOT_PAUSED;
  delete process.env.SIGNAL_PUBLISH_PAUSED;
  delete process.env.HF_API_KEY_ID;
  delete process.env.HF_API_KEY_SECRET;
  teardownMemoryProject();
}

export const planFile = (campaign: string) => path.join(root, 'campaigns', campaign, 'plan.json');
export const readPlan = (campaign: string) => JSON.parse(readFileSync(planFile(campaign), 'utf8')) as CampaignPlan;
export const pkgFile = (id: string, name: string) => path.join(root, 'posts', id, name);
export const readPkgJson = <T>(id: string, name: string): T | null => (existsSync(pkgFile(id, name)) ? (JSON.parse(readFileSync(pkgFile(id, name), 'utf8')) as T) : null);
export const runsFile = () => path.join(root, 'memory', 'autopilot', 'runs.jsonl');
export const trustFile = () => path.join(root, 'memory', 'autopilot', 'trust.json');

export function writeSettings(campaign: string, s: Partial<AutopilotSettings>): void {
  writeFileSync(path.join(root, 'campaigns', campaign, 'autopilot.json'), JSON.stringify({ campaign, enabled: true, makeAheadDays: 3, autoPlan: false, review: false, autoPublish: 'never', formats: null, dailyBudgetUsd: 3, updatedAt: '2026-11-04T10:00:00.000Z', updatedBy: 'owner', ...s }));
}

/** Campaign A, active with a strategy, planned slots on the given dates (18:00 Amsterdam = 17:00Z). */
export function campaignWithSlots(dates: string[], o: { id?: string; name?: string; format?: Slot['format']; status?: 'active' | 'paused' | 'draft' } = {}): string {
  const id = o.id ?? A;
  writeCampaign({ id, name: o.name ?? 'Grow saves', goal: 'engagement', status: o.status ?? 'active', strategy: strategy([{ name: 'Guess the link', weight: 100 }]) }, dates.map((d, i) => slot(id, d, 'Guess the link', `Hook ${i + 1} for ${d}`, o.format ?? 'website-card')));
  return id;
}

/** A fake makeSlotPost: writes a valid package for the slot and marks it made in plan.json. */
export function fakeMaker(o: { fail?: (slotId: string) => boolean; from?: number } = {}): { make: NonNullable<RunnerDeps['makeSlotPost']>; calls: { campaign: string; slot: string; by: string }[] } {
  let n = o.from ?? 10;
  const calls: { campaign: string; slot: string; by: string }[] = [];
  const make: NonNullable<RunnerDeps['makeSlotPost']> = async (campaign, slotId, by) => {
    calls.push({ campaign, slot: slotId, by });
    if (o.fail?.(slotId)) throw new Error(`Could not make ${slotId}.`);
    const plan = readPlan(campaign);
    const s = plan.slots.find((x) => x.id === slotId);
    if (!s || s.status !== 'planned') throw new Error('This slot already has a post.');
    const id = String(n++).padStart(2, '0');
    writePackage(id, { caption: `${s.hook}\n\nVisuals made with AI.`, format: s.format === 'higgsfield-reel' ? 'reel' : 'carousel', campaign: { id: campaign, slot: slotId } });
    const next: CampaignPlan = { ...plan, slots: plan.slots.map((x) => (x.id === slotId ? { ...x, packageId: id, status: 'made' as const } : x)) };
    writeFileSync(planFile(campaign), JSON.stringify(next));
    return { plan: next, packageId: id };
  };
  return { make, calls };
}

/** A fake reviewer: writes review.json with the verdict and reports a cost. */
export function fakeReviewer(o: { verdict?: (id: string) => StoredReview['verdict']; costUsd?: number; fail?: boolean } = {}): { review: NonNullable<RunnerDeps['reviewPackage']>; calls: string[] } {
  const calls: string[] = [];
  const review: NonNullable<RunnerDeps['reviewPackage']> = async (id) => {
    calls.push(id);
    if (o.fail) throw new Error('Reviewer unavailable.');
    const verdict = o.verdict?.(id) ?? 'ready';
    const run = { id: `run_${id}`, role: 'reviewer', project: 'demo', campaign: null, startedAt: new Date(NOW).toISOString(), endedAt: new Date(NOW).toISOString(), status: 'done', model: 'test', costUsd: o.costUsd ?? 0.05, turns: 1, summary: null, error: null } as unknown as AgentRunRecord;
    const stored = { packageId: id, verdict, briefMatch: 4, answerUnambiguous: 0.9, brandRules: [], visualQuality: 4, aiLabel: { pass: true, note: '' }, fixes: [], summary: 'ok', reviewedAt: run.endedAt, by: 'agent:reviewer', run: run.id, model: 'test', costUsd: run.costUsd, hashes: {} } as unknown as StoredReview;
    writeFileSync(pkgFile(id, 'review.json'), JSON.stringify(stored));
    return { review: stored, run };
  };
  return { review, calls };
}

export const teamOn = async () => ({ enabled: true, reason: '' });
export const teamOff = async () => ({ enabled: false, reason: 'The agent team is switched off.' });
export const on = async () => ({ enabled: true, reason: '' });
export const offFn = async () => ({ enabled: false, reason: 'off' });

/** A fake Signal schedule: writes scheduled.json like scheduleInSignal does (provider 'signal'). */
export function fakeSignalSchedule(o: { fail?: boolean } = {}): { schedule: NonNullable<RunnerDeps['scheduleInSignal']>; calls: { id: string; when: string; by: string }[] } {
  const calls: { id: string; when: string; by: string }[] = [];
  const schedule: NonNullable<RunnerDeps['scheduleInSignal']> = async (id, when, by, now) => {
    calls.push({ id, when, by });
    if (o.fail) throw new Error('Instagram did not answer.');
    writeFileSync(pkgFile(id, 'scheduled.json'), JSON.stringify({ job_id: '', scheduled_for: new Date(when).toISOString(), provider: 'signal', scheduled_by: by, scheduled_at: new Date(now).toISOString() }));
    const { loadPackage } = await import('@/lib/studio/content');
    return loadPackage(id);
  };
  return { schedule, calls };
}

/** A package that autopilot made (and maybe approved) earlier, for trust and pull tests. */
export function markPackage(id: string, o: { autoApproved?: boolean; campaign?: string; slot?: string } = {}): void {
  writeFileSync(pkgFile(id, 'autopilot.json'), JSON.stringify({ run: 'ap_test', campaign: o.campaign ?? A, slot: o.slot ?? '2026-11-06-website-card', madeAt: '2026-11-05T07:30:00.000Z', autoApproved: o.autoApproved ? { at: '2026-11-05T07:31:00.000Z', trustInARow: 5, scheduledFor: '2026-11-06T17:00:00.000Z', via: 'meta' } : null }));
}
