// Server-only: the steps one automatic job goes through after a post is made — review, then trusted
// auto-approval — shared by campaign slots (runner.ts) and pipelines (../pipelines/runner.ts), plus the
// cost helpers and the deps every run can inject. Every rule here is the autopilot rule; nothing is weaker
// for one caller than for the other.
import type { CampaignPlan } from '../campaigns';
import { approvePackage, assertDayCapacity, currentLimits, listPackages, loadPackage, pkgPath, writeJsonReplace, type PackageView } from '../content';
import { dispatchPackage, schedulingAllowed } from '../dispatch';
import { schedulerAllowed } from '../meta';
import { notePackageChange } from '../memory/hooks';
import type { AgentRunRecord } from '../memory/types';
import { currentProject } from '../projects';
import { repeatRunsWaiting } from '../postmaker/repeat-state';
import { postmakerRoot } from '../postmaker/store/paths';
import { metaLive, scheduleInSignal } from '../publish-meta';
import { reviewPackage } from '../team/reviewer';
import { teamAllowed } from '../team/runtime';
import type { StoredReview } from '../team/schemas';
import { estimateImageCostUsd, estimateVideoCostUsd } from '../higgsfield';
import type { Format } from '../generate';
import type { Runner } from '../claude-agent';
import { autoApprovePaused, trustedPublishAllowed } from './settings';
import { MARK_FILE, formatTrust } from './trust';
import type { AutopilotMark, AutopilotRun, RunStep } from './types';

export const AUTOPILOT_BY = 'signal-autopilot';
export const TRUSTED_APPROVER = 'signal-autopilot (trusted format)';
/** A slot must be at least this far ahead for an automatic approval (Upload-Post needs 10 minutes). */
export const MIN_LEAD_MS = 15 * 60_000;
/** Codex runs on your own sign-in only when you press a button: never in an automatic run. */
export const ATTENDED_ONLY: Format[] = ['codex-post'];
/** Higher than the generator's own estimate on purpose, so the budget stops before an overrun, not after. */
export const HIGGSFIELD_FORMATS: Format[] = ['higgsfield-image', 'higgsfield-reel'];
export function makeCostEstimate(format: Format): number {
  if (format === 'higgsfield-image') return estimateImageCostUsd(1);
  if (format === 'higgsfield-reel') return Math.round((estimateImageCostUsd(1) + estimateVideoCostUsd(5)) * 10_000) / 10_000;
  return 0;
}
/** Reviewer and planner caps: the most one step can cost. */
export const REVIEW_CAP_USD = 0.3;
export const PLAN_CAP_USD = 0.8;
/** Never pile up posts you have not looked at. Making stops while this many autopilot posts wait in Review. */
export const BACKLOG_LIMIT = 7;

export const iso = (ms: number) => new Date(ms).toISOString();
export const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

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
  /** Pipelines: the post generator, the website page finder and the Claude runner for the ideas agent. */
  generatePackage?: (opts: { format: Format; now: number; brief?: { prompt: string; headline?: string; caption?: string }; articleUrl?: string; captionLead?: string }) => Promise<{ id: string }>;
  discoverArticles?: () => Promise<string[]>;
  readArticle?: (url: string) => Promise<{ url: string; title: string; summary: string; image: string | null }>;
  agentRunner?: Runner;
}

/** Sum of the steps' costs, for one campaign (review steps are attributed through the package → campaign map) or for all.
 *  Pipeline steps (those carrying `pipeline`) belong to no campaign. */
export function spendOf(runs: AutopilotRun[], campaign: string | null, pkgCampaign: Map<string, string> = new Map()): number {
  let total = 0;
  for (const r of runs)
    for (const s of r.steps) {
      const cost = 'costUsd' in s && typeof s.costUsd === 'number' && Number.isFinite(s.costUsd) ? s.costUsd : 0;
      if (!cost) continue;
      const pipeline = 'pipeline' in s ? s.pipeline : undefined;
      const owner = pipeline ? null : s.kind === 'plan' || s.kind === 'make' ? s.campaign : s.kind === 'review' ? (pkgCampaign.get(s.package) ?? null) : null;
      if (campaign === null || owner === campaign) total += cost;
    }
  return Math.round(total * 10000) / 10000;
}
/** Sum of the steps' costs for one pipeline. */
export function spendOfPipeline(runs: AutopilotRun[], pipeline: string): number {
  let total = 0;
  for (const r of runs) for (const s of r.steps) if ('pipeline' in s && s.pipeline === pipeline && 'costUsd' in s && typeof s.costUsd === 'number' && Number.isFinite(s.costUsd)) total += s.costUsd;
  return Math.round(total * 10000) / 10000;
}

/** Autopilot-made posts you have not looked at yet (campaign, pipeline and repeat-template posts alike), plus
 *  repeat-template posts still waiting for you at Proof (they are posts nobody looked at either). */
export async function waitingInReview(): Promise<number> {
  const posts = (await listPackages()).filter((p) => p.autopilot && !p.autopilot.autoApproved && (p.status === 'ready' || p.status === 'changed')).length;
  return posts + (await repeatRunsWaiting(postmakerRoot(currentProject())).catch(() => 0));
}

/** What one job needs after its post exists. */
export interface Job {
  campaign: string | null;
  pipeline?: string;
  format: Format;
  at: string; // the slot instant
  review: boolean;
  autoPublish: 'never' | 'trusted';
}
const tag = (job: Job) => (job.pipeline ? { pipeline: job.pipeline } : {});

/** Runs the reviewer on a made post when the job asks for it and the budget allows. Returns the verdict,
 *  'budget' when the daily budget stopped it (the caller stops the owner's work), null when not reviewed. */
export async function reviewStep(run: AutopilotRun, job: Job, packageId: string, overBudget: (next: number) => boolean, budgetStop: () => void, deps: RunnerDeps, now: number): Promise<string | null | 'budget'> {
  if (!job.review) return null;
  const t = await (deps.teamAllowed ?? teamAllowed)();
  if (!t.enabled) {
    run.steps.push({ kind: 'skip', campaign: job.campaign, ...tag(job), reason: `Post ${packageId} was not reviewed: ${t.reason}` });
    return null;
  }
  if (overBudget(REVIEW_CAP_USD)) {
    budgetStop();
    return 'budget';
  }
  try {
    const r = await (deps.reviewPackage ?? ((id, d) => reviewPackage(id, d)))(packageId, { now });
    run.steps.push({ kind: 'review', package: packageId, verdict: r.review.verdict, costUsd: r.run.costUsd, ...tag(job) });
    return r.review.verdict;
  } catch (e) {
    run.steps.push({ kind: 'review', package: packageId, verdict: null, costUsd: null, error: msg(e), ...tag(job) });
    return null;
  }
}

/** Trusted auto-approval: every condition must hold, else the post stays in Review with a reason step. */
export async function maybeAutoApprove(run: AutopilotRun, job: Job, packageId: string, verdict: string | null, mark: AutopilotMark, deps: RunnerDeps, now: number): Promise<void> {
  if (job.autoPublish !== 'trusted') return;
  const skip = (reason: string) => {
    run.steps.push({ kind: 'skip', campaign: job.campaign, ...tag(job), reason: `Post ${packageId} stays in Review: ${reason}` });
  };
  // A run can take long (Reels); judge the lead time and approve with the current clock, not the run's start.
  now = deps.now ?? Date.now();
  const tp = await trustedPublishAllowed();
  if (!tp.enabled) return skip(tp.reason);
  const pause = autoApprovePaused();
  if (pause.paused) return skip(pause.reason);
  const trust = await formatTrust(job.format);
  if (!trust.trusted) return skip(`${job.format} is not a trusted format (${trust.approvedInARow} owner approvals in a row${trust.revoked ? ', trust revoked' : ''}).`);
  if (!job.review) return skip(`automatic approval needs the reviewer, and review is off for this ${job.pipeline ? 'pipeline' : 'campaign'}.`);
  if (verdict !== 'ready') return skip(verdict ? `the reviewer said "${verdict}".` : 'there is no reviewer verdict.');
  const lim = await currentLimits(now);
  if (!lim.open) return skip(lim.reason);
  if (!lim.dispatch) return skip(`automatic posting is off for ${currentProject().handle}.`);
  const at = Date.parse(job.at);
  if (!(at > now + MIN_LEAD_MS)) return skip('the slot time is past or too close.');
  const sched = await (deps.schedulerAllowed ?? schedulerAllowed)();
  const live = sched.enabled ? await (deps.metaLive ?? metaLive)(now) : { enabled: false, reason: sched.reason };
  const via: 'meta' | 'upload-post' | null = live.enabled ? 'meta' : (await (deps.schedulingAllowed ?? schedulingAllowed)()).enabled ? 'upload-post' : null;
  if (!via) return skip('no scheduling path is switched on (neither Signal’s scheduler nor Upload-Post scheduling).');
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
    run.steps.push({ kind: 'auto-approve', package: packageId, format: job.format, scheduledFor: null, via: null, error: `approval refused: ${msg(e)}`, ...tag(job) });
    return;
  }
  await notePackageChange(before, approved, AUTOPILOT_BY);
  let scheduledFor: string | null = null;
  let error: string | undefined;
  try {
    const after = via === 'meta' ? await (deps.scheduleInSignal ?? ((id, when, by, n) => scheduleInSignal(id, when, by, n)))(packageId, job.at, AUTOPILOT_BY, now) : await (deps.dispatchPackage ?? ((id, by, d) => dispatchPackage(id, by, d)))(packageId, AUTOPILOT_BY, { now, scheduleFor: job.at });
    scheduledFor = iso(at);
    await notePackageChange(approved, after, AUTOPILOT_BY);
  } catch (e) {
    error = `approved but not scheduled: ${msg(e)}`;
  }
  mark.autoApproved = { at: iso(now), trustInARow: trust.approvedInARow, scheduledFor, via: scheduledFor ? via : null };
  await writeJsonReplace(pkgPath(packageId, MARK_FILE), mark).catch(() => undefined);
  const step: RunStep = { kind: 'auto-approve', package: packageId, format: job.format, scheduledFor, via: scheduledFor ? via : null, ...(error ? { error } : {}), ...tag(job) };
  run.steps.push(step);
}
