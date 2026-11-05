// Server-only: one autopilot run for a project.
//
// A run makes the planned posts of every active campaign that has autopilot on, up to makeAheadDays ahead,
// one job at a time. Every post lands in Review like a hand-made one. Only when the owner signed trusted
// publishing, the campaign asks for it, the format earned trust, the reviewer passed the post, the account
// approval allows dispatch and nothing is paused does the run approve and schedule a post itself — through
// the same approvePackage / scheduleInSignal / dispatchPackage functions and limit checks the owner uses.
// Stop rules: an unclear (uncertain) post stops the whole run; a campaign stops at its daily budget; one
// 'daily' run per project per calendar day; missed days are skipped, never caught up; one run at a time.
// Runs are kept in memory/autopilot/runs.jsonl (written at start and at the end; last line per id wins).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { addDays, zonedInstant, zonedParts, todayInZone } from '@/lib/time';
import { getPlan, listCampaigns, makePlan, makeSlotPost, type Campaign, type CampaignPlan, type Slot } from '../campaigns';
import { ContentError, approvePackage, assertDayCapacity, currentLimits, listPackages, loadPackage, pkgPath, writeJsonReplace, type PackageView } from '../content';
import { dispatchPackage, schedulingAllowed } from '../dispatch';
import { schedulerAllowed } from '../meta';
import { notePackageChange } from '../memory/hooks';
import { newId, recordEvent } from '../memory/store';
import type { AgentRunRecord } from '../memory/types';
import { currentProject, listProjects, withProject } from '../projects';
import { metaLive, scheduleInSignal } from '../publish-meta';
import { reviewPackage } from '../team/reviewer';
import { teamAllowed } from '../team/runtime';
import type { StoredReview } from '../team/schemas';
import { autoApprovePaused, autopilotAllowed, autopilotPaused, readSettings, trustedPublishAllowed } from './settings';
import { MARK_FILE, autopilotDir, ensureAutopilotDir, formatTrust } from './trust';
import type { AutopilotMark, AutopilotRun, AutopilotSettings } from './types';
import { estimateImageCostUsd, estimateVideoCostUsd, higgsfieldAllowed } from '../higgsfield';
import type { Format } from '../generate';

export const AUTOPILOT_BY = 'signal-autopilot';
export const TRUSTED_APPROVER = 'signal-autopilot (trusted format)';
/** The daily window (Studio time zone wall clock): the first tick inside it runs, missed days are never caught up. */
export const RUN_WINDOW = { from: '08:00', to: '12:00', fromHour: 8, toHour: 12 } as const;
/** A slot must be at least this far ahead for an automatic approval (Upload-Post needs 10 minutes). */
const MIN_LEAD_MS = 15 * 60_000;
/** Codex runs on your own sign-in only when you press a button: never in an automatic run. */
const ATTENDED_ONLY: Format[] = ['codex-post'];
/** Higher than the generator's own estimate on purpose, so the budget stops before an overrun, not after. */
const HIGGSFIELD_FORMATS: Format[] = ['higgsfield-image', 'higgsfield-reel'];
export function makeCostEstimate(format: Format): number {
  if (format === 'higgsfield-image') return estimateImageCostUsd(1);
  if (format === 'higgsfield-reel') return Math.round((estimateImageCostUsd(1) + estimateVideoCostUsd(5)) * 10_000) / 10_000;
  return 0;
}
/** Reviewer and planner caps: the most one step can cost. */
const REVIEW_CAP_USD = 0.3;
const PLAN_CAP_USD = 0.8;
/** Annex: never pile up posts the owner has not looked at. Making stops while this many autopilot posts wait in Review. */
export const BACKLOG_LIMIT = 7;

const iso = (ms: number) => new Date(ms).toISOString();
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export interface RunnerDeps {
  now?: number;
  makeSlotPost?: (campaign: string, slotId: string, by: string, now: number) => Promise<{ plan: CampaignPlan; packageId: string }>;
  makePlan?: (campaign: string, by: string, deps: { now?: number }) => Promise<CampaignPlan>;
  reviewPackage?: (id: string, deps: { now?: number }) => Promise<{ review: StoredReview; run: AgentRunRecord }>;
  teamAllowed?: () => Promise<{ enabled: boolean; reason: string }>;
  approvePackage?: (id: string, by: string, now: number) => Promise<PackageView>;
  scheduleInSignal?: (id: string, when: string, by: string, now: number) => Promise<PackageView>;
  dispatchPackage?: (id: string, by: string, deps: { now?: number; scheduleFor?: string }) => Promise<PackageView>;
  schedulerAllowed?: () => Promise<{ enabled: boolean; reason: string }>;
  metaLive?: (now: number) => Promise<{ enabled: boolean; reason: string }>;
  schedulingAllowed?: () => Promise<{ enabled: boolean; reason: string }>;
}

// ---- runs on disk ----------------------------------------------------------------------------------
const runsFile = () => path.join(autopilotDir(), 'runs.jsonl');

async function appendRun(r: AutopilotRun): Promise<void> {
  await ensureAutopilotDir();
  await fs.appendFile(/* turbopackIgnore: true */ runsFile(), JSON.stringify(r) + '\n', { mode: 0o600 });
}

async function readRuns(): Promise<AutopilotRun[]> {
  let raw = '';
  try {
    raw = await fs.readFile(/* turbopackIgnore: true */ runsFile(), 'utf8');
  } catch {
    return [];
  }
  const byId = new Map<string, AutopilotRun>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as AutopilotRun;
      if (r && typeof r.id === 'string') byId.set(r.id, r); // last line wins
    } catch {
      /* torn line */
    }
  }
  // A run still marked running that no lock holds was cut off (Signal stopped or restarted mid-run).
  for (const [id, r] of byId) if (r.status === 'running' && !locks().has(r.project)) byId.set(id, { ...r, status: 'failed', note: r.note ?? 'Signal stopped while this run was going.' });
  return [...byId.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1));
}

/** Newest first. */
export async function listAutopilotRuns(limit = 20): Promise<AutopilotRun[]> {
  return (await readRuns()).reverse().slice(0, limit);
}
export async function runsForDay(day: string): Promise<AutopilotRun[]> {
  return (await readRuns()).filter((r) => r.day === day);
}

/** Sum of the steps' costs, for one campaign (review steps are attributed through the package → campaign map) or for all. */
export function spendOf(runs: AutopilotRun[], campaign: string | null, pkgCampaign: Map<string, string> = new Map()): number {
  let total = 0;
  for (const r of runs)
    for (const s of r.steps) {
      const cost = 'costUsd' in s && typeof s.costUsd === 'number' && Number.isFinite(s.costUsd) ? s.costUsd : 0;
      if (!cost) continue;
      const owner = s.kind === 'plan' || s.kind === 'make' ? s.campaign : s.kind === 'review' ? (pkgCampaign.get(s.package) ?? null) : null;
      if (campaign === null || owner === campaign) total += cost;
    }
  return Math.round(total * 10000) / 10000;
}

export async function spendToday(now = Date.now()): Promise<number> {
  return spendOf(await runsForDay(todayInZone(now)), null);
}

// ---- the daily window ------------------------------------------------------------------------------
export function inRunWindow(now = Date.now()): boolean {
  const h = zonedParts(now).hour;
  return h >= RUN_WINDOW.fromHour && h < RUN_WINDOW.toHour;
}
export function dailyRunDone(runs: AutopilotRun[], now = Date.now()): boolean {
  const day = todayInZone(now);
  return runs.some((r) => r.day === day && r.trigger === 'daily');
}
/** True when the daily run for the current project is due: inside the window and not run yet today. */
export async function shouldRunNow(now = Date.now()): Promise<boolean> {
  if (!inRunWindow(now)) return false;
  return !dailyRunDone(await runsForDay(todayInZone(now)), now);
}
/** When the next daily run would start: today's window if still open and not run, else tomorrow 08:00. */
export function nextRunAt(now: number, runs: AutopilotRun[]): string {
  const today = todayInZone(now);
  const start = Date.parse(zonedInstant(today, RUN_WINDOW.from));
  const end = Date.parse(zonedInstant(today, RUN_WINDOW.to));
  if (!dailyRunDone(runs, now)) {
    if (now < start) return iso(start);
    if (now < end) return iso(now);
  }
  return zonedInstant(addDays(today, 1), RUN_WINDOW.from);
}

// ---- locks (shared across bundles through globalThis) ------------------------------------------------
type G = typeof globalThis & { __signalAutopilotLocks?: Set<string>; __signalAutopilotAllRunning?: boolean };
const locks = () => ((globalThis as G).__signalAutopilotLocks ??= new Set<string>());
export const runInProgress = (project = currentProject().id) => locks().has(project);

// ---- one run ------------------------------------------------------------------------------------------
/** One run for the current project. Throws (and writes nothing) when the gate is off, autopilot is paused,
 *  today's daily run already happened (trigger 'daily') or a run is in progress. `onStarted` fires once the
 *  run record exists, so a caller can answer with the id while the run continues. */
export async function runProject(trigger: AutopilotRun['trigger'], deps: RunnerDeps = {}, onStarted?: (run: AutopilotRun) => void): Promise<AutopilotRun> {
  const now = deps.now ?? Date.now();
  const project = currentProject();
  const gate = await autopilotAllowed();
  if (!gate.enabled) throw new ContentError(403, gate.reason);
  const pause = autopilotPaused();
  if (pause.paused) throw new ContentError(409, pause.reason);
  const day = todayInZone(now);
  const todays = await runsForDay(day);
  if (trigger === 'daily' && todays.some((r) => r.trigger === 'daily')) throw new ContentError(409, `Autopilot already ran today (${day}).`);
  if (locks().has(project.id)) throw new ContentError(409, 'An autopilot run is already in progress for this project.');
  locks().add(project.id);
  const run: AutopilotRun = { id: newId('ap', now), project: project.id, day, trigger, startedAt: iso(now), endedAt: null, status: 'running', steps: [], costUsd: 0, note: null };
  try {
    await appendRun(run);
    onStarted?.(run);
    await execute(run, todays, deps, now);
    if (run.status === 'running') run.status = 'done';
  } catch (e) {
    run.status = 'failed';
    run.note = msg(e);
  } finally {
    run.endedAt = iso(Math.max(now, Date.now()));
    run.costUsd = spendOf([run], null);
    await appendRun(run).catch(() => undefined);
    locks().delete(project.id);
  }
  return run;
}

/** Starts a run and resolves with its id as soon as the run record exists; the run continues in the background.
 *  Rejects when the run is refused before it starts. */
export function startRun(trigger: AutopilotRun['trigger'], deps: RunnerDeps = {}): Promise<{ id: string; done: Promise<AutopilotRun> }> {
  return new Promise((resolve, reject) => {
    let started = false;
    const done = runProject(trigger, deps, (r) => {
      started = true;
      resolve({ id: r.id, done });
    });
    done.catch((e) => {
      if (!started) reject(e);
    });
  });
}

const planned = (s: Slot) => s.status === 'planned';

/** The plan runs out inside the horizon and the campaign has days left to plan. */
export function needsPlan(c: Pick<Campaign, 'endDate'>, plan: CampaignPlan, today: string, horizon: string): boolean {
  if (c.endDate && c.endDate <= horizon) return false;
  const last = plan.slots.filter((s) => s.status !== 'skipped' && s.date > today).map((s) => s.date).sort().at(-1) ?? null;
  return !last || last <= horizon;
}

async function execute(run: AutopilotRun, todays: AutopilotRun[], deps: RunnerDeps, now: number): Promise<void> {
  const all = await listPackages();
  const unclear = all.find((p) => p.status === 'uncertain');
  if (unclear) {
    run.steps.push({ kind: 'skip', campaign: null, reason: `Post ${unclear.id} has an unclear result. Nothing is made until it is resolved.` });
    run.status = 'stopped';
    run.note = `Stopped: post ${unclear.id} has an unclear result.`;
    return;
  }
  const pkgCampaign = new Map<string, string>(all.filter((p) => p.campaign).map((p) => [p.id, p.campaign!.id]));
  const spent = (campaign: string) => spendOf([...todays, run], campaign, pkgCampaign);
  const today = run.day;
  const mp = deps.makePlan ?? ((id, by, d) => makePlan(id, by, d));
  const msp = deps.makeSlotPost ?? ((id, slot, by, n) => makeSlotPost(id, slot, by, n));
  const rp = deps.reviewPackage ?? ((id, d) => reviewPackage(id, d));
  const team = deps.teamAllowed ?? teamAllowed;

  for (const c of await listCampaigns()) {
    if (c.status !== 'active') continue;
    const s = await readSettings(c.id);
    if (!s.enabled) continue;
    const horizon = addDays(today, s.makeAheadDays);
    const overBudget = (next = 0) => spent(c.id) + next > s.dailyBudgetUsd || spent(c.id) >= s.dailyBudgetUsd;
    const budgetStop = () => run.steps.push({ kind: 'skip', campaign: c.id, reason: `Daily budget of $${s.dailyBudgetUsd.toFixed(2)} reached: $${spent(c.id).toFixed(2)} spent today, and the next step could go over it.` });
    let plan = await getPlan(c.id);

    // (a) extend the plan when it runs out inside the horizon
    if (s.autoPlan && needsPlan(c, plan, today, horizon)) {
      if (overBudget(PLAN_CAP_USD)) {
        budgetStop();
        continue;
      }
      try {
        plan = await mp(c.id, AUTOPILOT_BY, { now });
        run.steps.push({ kind: 'plan', campaign: c.id, slots: plan.slots.filter(planned).length, costUsd: plan.meta?.costUsd ?? null });
        await recordEvent({ type: 'plan.made', by: 'agent:planner', campaign: c.id, refs: { run: run.id }, data: { slots: plan.slots.filter(planned).length, requestedBy: AUTOPILOT_BY } });
      } catch (e) {
        run.steps.push({ kind: 'skip', campaign: c.id, reason: `Planning failed: ${msg(e)}` });
      }
    }

    // (b) make the planned slots inside the horizon, oldest first, one at a time
    const due = plan.slots
      .filter((sl) => planned(sl) && sl.date >= today && sl.date <= horizon && Date.parse(sl.at) > now && (!s.formats || s.formats.includes(sl.format)))
      .sort((a, b) => a.at.localeCompare(b.at));
    const hf = due.some((sl) => HIGGSFIELD_FORMATS.includes(sl.format)) ? await higgsfieldAllowed() : { enabled: true, reason: '' };
    for (const sl of due) {
      if (ATTENDED_ONLY.includes(sl.format)) {
        run.steps.push({ kind: 'skip', campaign: c.id, reason: `Slot ${sl.id} (${sl.format}) uses Codex, which runs only when you press Make.` });
        continue;
      }
      if (HIGGSFIELD_FORMATS.includes(sl.format) && !hf.enabled) {
        run.steps.push({ kind: 'skip', campaign: c.id, reason: `Slot ${sl.id} (${sl.format}): ${hf.reason}` });
        continue;
      }
      const waiting = (await listPackages()).filter((p) => p.autopilot && !p.autopilot.autoApproved && (p.status === 'ready' || p.status === 'changed')).length;
      if (waiting >= BACKLOG_LIMIT) {
        run.steps.push({ kind: 'skip', campaign: c.id, reason: `${waiting} autopilot posts are waiting for you in Review. Making pauses until you go through them.` });
        run.note = run.note ?? `Paused making: ${waiting} posts wait in Review.`;
        break;
      }
      const estimate = makeCostEstimate(sl.format);
      // A post is only useful with its review, so make only when both fit in today's budget.
      if (overBudget(estimate + (s.review ? REVIEW_CAP_USD : 0))) {
        budgetStop();
        break;
      }
      let packageId: string;
      const mark: AutopilotMark = { run: run.id, campaign: c.id, slot: sl.id, madeAt: iso(now), autoApproved: null };
      try {
        packageId = (await msp(c.id, sl.id, AUTOPILOT_BY, now)).packageId;
        pkgCampaign.set(packageId, c.id);
        await writeJsonReplace(pkgPath(packageId, MARK_FILE), mark);
        const made = await loadPackage(packageId).catch(() => null);
        const cost = made?.source?.higgsfield?.estimatedCostUsd ?? (estimate || null);
        run.steps.push({ kind: 'make', campaign: c.id, slot: sl.id, package: packageId, format: sl.format, costUsd: cost });
        await recordEvent({ type: 'post.made', by: AUTOPILOT_BY, campaign: c.id, refs: { package: packageId, slot: sl.id, run: run.id }, data: { format: sl.format, pillar: sl.pillar, hook: sl.hook.slice(0, 200), date: sl.date, autopilot: true } });
      } catch (e) {
        // A failed Higgsfield make may still have been charged in part (image done, video failed): count the estimate.
        run.steps.push({ kind: 'make', campaign: c.id, slot: sl.id, package: null, format: sl.format, costUsd: estimate || null, error: msg(e) });
        continue; // one failed slot never stops the others
      }

      // (c) review
      let verdict: string | null = null;
      if (s.review) {
        const t = await team();
        if (!t.enabled) run.steps.push({ kind: 'skip', campaign: c.id, reason: `Post ${packageId} was not reviewed: ${t.reason}` });
        else if (overBudget(REVIEW_CAP_USD)) {
          budgetStop();
          break;
        } else {
          try {
            const r = await rp(packageId, { now });
            verdict = r.review.verdict;
            run.steps.push({ kind: 'review', package: packageId, verdict, costUsd: r.run.costUsd });
          } catch (e) {
            run.steps.push({ kind: 'review', package: packageId, verdict: null, costUsd: null, error: msg(e) });
          }
        }
      }

      // (d) trusted auto-approval
      if (s.autoPublish === 'trusted') await maybeAutoApprove(run, c, s, sl, packageId, verdict, mark, deps, now);
    }
  }
  if (!run.steps.length) run.note = 'Nothing to do: no planned slot inside the horizon of a campaign with autopilot on.';
}

async function maybeAutoApprove(run: AutopilotRun, c: Campaign, s: AutopilotSettings, sl: Slot, packageId: string, verdict: string | null, mark: AutopilotMark, deps: RunnerDeps, now: number): Promise<void> {
  const skip = (reason: string) => {
    run.steps.push({ kind: 'skip', campaign: c.id, reason: `Post ${packageId} stays in Review: ${reason}` });
  };
  // A run can take long (Reels); judge the lead time and approve with the current clock, not the run's start.
  now = deps.now ?? Date.now();
  const tp = await trustedPublishAllowed();
  if (!tp.enabled) return skip(tp.reason);
  const pause = autoApprovePaused();
  if (pause.paused) return skip(pause.reason);
  const trust = await formatTrust(sl.format);
  if (!trust.trusted) return skip(`${sl.format} is not a trusted format (${trust.approvedInARow} owner approvals in a row${trust.revoked ? ', trust revoked' : ''}).`);
  if (!s.review) return skip('automatic approval needs the reviewer, and review is off for this campaign.');
  if (verdict !== 'ready') return skip(verdict ? `the reviewer said "${verdict}".` : 'there is no reviewer verdict.');
  const lim = await currentLimits(now);
  if (!lim.open) return skip(lim.reason);
  if (!lim.dispatch) return skip(`automatic posting is off for ${currentProject().handle}.`);
  const at = Date.parse(sl.at);
  if (!(at > now + MIN_LEAD_MS)) return skip('the slot time is past or too close.');
  const sched = await (deps.schedulerAllowed ?? schedulerAllowed)();
  const live = sched.enabled ? await (deps.metaLive ?? metaLive)(now) : { enabled: false, reason: sched.reason };
  const via: 'meta' | 'upload-post' | null = live.enabled ? 'meta' : (await (deps.schedulingAllowed ?? schedulingAllowed)()).enabled ? 'upload-post' : null;
  if (!via) return skip('no scheduling path is approved (neither Signal’s scheduler nor Upload-Post scheduling).');
  try {
    assertDayCapacity(await listPackages(), at, lim, packageId);
  } catch (e) {
    return skip(msg(e));
  }

  const before = await loadPackage(packageId);
  let approved: PackageView;
  try {
    approved = await (deps.approvePackage ?? ((id, by, n) => approvePackage(id, by, n)))(packageId, TRUSTED_APPROVER, now);
  } catch (e) {
    run.steps.push({ kind: 'auto-approve', package: packageId, format: sl.format, scheduledFor: null, via: null, error: `approval refused: ${msg(e)}` });
    return;
  }
  await notePackageChange(before, approved, AUTOPILOT_BY);
  let scheduledFor: string | null = null;
  let error: string | undefined;
  try {
    const after = via === 'meta' ? await (deps.scheduleInSignal ?? ((id, when, by, n) => scheduleInSignal(id, when, by, n)))(packageId, sl.at, AUTOPILOT_BY, now) : await (deps.dispatchPackage ?? ((id, by, d) => dispatchPackage(id, by, d)))(packageId, AUTOPILOT_BY, { now, scheduleFor: sl.at });
    scheduledFor = iso(at);
    await notePackageChange(approved, after, AUTOPILOT_BY);
  } catch (e) {
    error = `approved but not scheduled: ${msg(e)}`;
  }
  mark.autoApproved = { at: iso(now), trustInARow: trust.approvedInARow, scheduledFor, via: scheduledFor ? via : null };
  await writeJsonReplace(pkgPath(packageId, MARK_FILE), mark).catch(() => undefined);
  run.steps.push({ kind: 'auto-approve', package: packageId, format: sl.format, scheduledFor, via: scheduledFor ? via : null, ...(error ? { error } : {}) });
}

// ---- every project (the instrumentation tick) ---------------------------------------------------------
async function anyCampaignOn(): Promise<boolean> {
  for (const c of await listCampaigns()) if (c.status === 'active' && (await readSettings(c.id)).enabled) return true;
  return false;
}

/** One pass over every project: runs the daily run where it is due. Safe to call every minute; overlapping calls are skipped. */
export async function runAll(deps: RunnerDeps = {}): Promise<void> {
  const g = globalThis as G;
  if (g.__signalAutopilotAllRunning) return;
  g.__signalAutopilotAllRunning = true;
  try {
    if (!(await autopilotAllowed()).enabled) return;
    if (autopilotPaused().paused) return;
    const now = deps.now ?? Date.now();
    for (const p of await listProjects())
      await withProject(p, async () => {
        if (!(await shouldRunNow(now)) || !(await anyCampaignOn())) return;
        await runProject('daily', deps);
      }).catch(() => undefined);
  } finally {
    g.__signalAutopilotAllRunning = false;
  }
}
