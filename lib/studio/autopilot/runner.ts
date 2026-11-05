// Server-only: one autopilot run for a project.
//
// A run makes the planned posts of every active campaign that has autopilot on, up to makeAheadDays ahead,
// one job at a time. Every post lands in Review like a hand-made one. Only when the owner signed trusted
// publishing, the campaign asks for it, the format earned trust, the reviewer passed the post, the account
// approval allows dispatch and nothing is paused does the run approve and schedule a post itself — through
// the same approvePackage / scheduleInSignal / dispatchPackage functions and limit checks the owner uses.
// Stop rules: an unclear (uncertain) post stops the whole run; a campaign stops at its daily budget; one
// 'daily' run per project per calendar day; missed days are skipped, never caught up; one run at a time.
// Pipelines (../pipelines) run inside the same run after the campaigns, under the same rules and lock.
// Runs are kept in memory/autopilot/runs.jsonl (written at start and at the end; last line per id wins).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { addDays, zonedInstant, zonedParts, todayInZone } from '@/lib/time';
import { getPlan, listCampaigns, makePlan, makeSlotPost, type Campaign, type CampaignPlan, type Slot } from '../campaigns';
import { ContentError, listPackages, loadPackage, pkgPath, writeJsonReplace } from '../content';
import { newId, recordEvent } from '../memory/store';
import { currentProject, listProjects, withProject } from '../projects';
import { autopilotAllowed, autopilotPaused, readSettings } from './settings';
import { MARK_FILE, autopilotDir, ensureAutopilotDir } from './trust';
import type { AutopilotMark, AutopilotRun } from './types';
import { higgsfieldAllowed } from '../higgsfield';
import { ATTENDED_ONLY, AUTOPILOT_BY, BACKLOG_LIMIT, HIGGSFIELD_FORMATS, PLAN_CAP_USD, REVIEW_CAP_USD, iso, makeCostEstimate, maybeAutoApprove, msg, reviewStep, spendOf, waitingInReview, type RunnerDeps } from './steps';
import { listPipelines } from '../pipelines/store';
import { runPipelines } from '../pipelines/runner';

// The job steps (review, trusted approval), cost helpers and deps live in ./steps.ts and are shared with pipelines.
export { AUTOPILOT_BY, BACKLOG_LIMIT, TRUSTED_APPROVER, makeCostEstimate, spendOf, spendOfPipeline, type RunnerDeps } from './steps';
/** The daily window (Studio time zone wall clock): the first tick inside it runs, missed days are never caught up. */
export const RUN_WINDOW = { from: '08:00', to: '12:00', fromHour: 8, toHour: 12 } as const;

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
 *  run record exists, so a caller can answer with the id while the run continues.
 *  `scope.pipeline` limits a manual run to one pipeline (its Run now button): campaigns are left alone. */
export async function runProject(trigger: AutopilotRun['trigger'], deps: RunnerDeps = {}, onStarted?: (run: AutopilotRun) => void, scope: { pipeline?: string } = {}): Promise<AutopilotRun> {
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
  const run: AutopilotRun = { id: newId('ap', now), project: project.id, day, trigger, ...(scope.pipeline ? { pipeline: scope.pipeline } : {}), startedAt: iso(now), endedAt: null, status: 'running', steps: [], costUsd: 0, note: null };
  try {
    await appendRun(run);
    onStarted?.(run);
    await execute(run, todays, deps, now, scope);
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
export function startRun(trigger: AutopilotRun['trigger'], deps: RunnerDeps = {}, scope: { pipeline?: string } = {}): Promise<{ id: string; done: Promise<AutopilotRun> }> {
  return new Promise((resolve, reject) => {
    let started = false;
    const done = runProject(trigger, deps, (r) => {
      started = true;
      resolve({ id: r.id, done });
    }, scope);
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

async function execute(run: AutopilotRun, todays: AutopilotRun[], deps: RunnerDeps, now: number, scope: { pipeline?: string }): Promise<void> {
  const all = await listPackages();
  const unclear = all.find((p) => p.status === 'uncertain');
  if (unclear) {
    run.steps.push({ kind: 'skip', campaign: null, reason: `Post ${unclear.id} has an unclear result. Nothing is made until it is resolved.` });
    run.status = 'stopped';
    run.note = `Stopped: post ${unclear.id} has an unclear result.`;
    return;
  }
  if (!scope.pipeline) await executeCampaigns(run, todays, all.filter((p) => p.campaign).map((p) => [p.id, p.campaign!.id] as const), deps, now);
  // Pipelines share the run, its rules and the run-wide lock; a scoped run does only its one pipeline.
  await runPipelines(run, todays, deps, now, scope);
  if (!run.steps.length) run.note = scope.pipeline ? 'Nothing to do: every upcoming slot of this pipeline has a post already.' : 'Nothing to do: no planned slot inside the horizon of a campaign with autopilot on, and no pipeline slot to make.';
}

async function executeCampaigns(run: AutopilotRun, todays: AutopilotRun[], owners: (readonly [string, string])[], deps: RunnerDeps, now: number): Promise<void> {
  const pkgCampaign = new Map<string, string>(owners);
  const spent = (campaign: string) => spendOf([...todays, run], campaign, pkgCampaign);
  const today = run.day;
  const mp = deps.makePlan ?? ((id, by, d) => makePlan(id, by, d));
  const msp = deps.makeSlotPost ?? ((id, slot, by, n) => makeSlotPost(id, slot, by, n));

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
      const waiting = await waitingInReview();
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

      // (c) review, (d) trusted auto-approval: the shared job steps
      const job = { campaign: c.id, format: sl.format, at: sl.at, review: s.review, autoPublish: s.autoPublish };
      const verdict = await reviewStep(run, job, packageId, overBudget, budgetStop, deps, now);
      if (verdict === 'budget') break;
      await maybeAutoApprove(run, job, packageId, verdict, mark, deps, now);
    }
  }
}

// ---- every project (the instrumentation tick) ---------------------------------------------------------
async function anythingOn(): Promise<boolean> {
  for (const c of await listCampaigns()) if (c.status === 'active' && (await readSettings(c.id)).enabled) return true;
  return (await listPipelines()).some((p) => p.enabled);
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
        if (!(await shouldRunNow(now)) || !(await anythingOn())) return;
        await runProject('daily', deps);
      }).catch(() => undefined);
  } finally {
    g.__signalAutopilotAllRunning = false;
  }
}
